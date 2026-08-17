import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  LlmError,
  isAgentLoopRequest,
  resolveRetryPolicy,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { parseCursorControl } from './control-event.js'
import { ModelProviderMailbox, writeModelProviderInput } from './model-provider-protocol.js'
import {
  CURSOR_ACP_PROVIDER,
  MODEL_PROVIDER_PROTOCOL,
  type CursorAdapterConfig,
  type CursorRuntimeModel,
  type ModelProviderOutput,
} from './types.js'

interface ActiveBridge {
  readonly key: string
  readonly requestId: string
  readonly model: CursorRuntimeModel
  readonly process: SubprocessHandle
  readonly mailbox: ModelProviderMailbox
  readonly abort: AbortController
  readonly privateRoot: string
  readonly graceMs: number
  pendingTool?: string
  forwardedText: string
  disposed: boolean
  cancelling?: Promise<void>
}

function publicModel(model: CursorRuntimeModel): LlmModelInfo {
  const { wireModelId: _wire, contextWindow: _context, configPath: _config, ...info } = model
  return info
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'reasoning': return `[reasoning]\n${block.text}`
    case 'image': return `[image attachment ${block.attachment.attachmentId}]`
    case 'tool-call': return `[tool call ${block.name} id=${block.id}]\n${block.arguments}`
    case 'tool-result': return `[tool result id=${block.toolCallId}${block.isError === true ? ' error' : ''}]\n${renderBlocks(block.content)}`
    default: return `[unsupported content block ${String((block as { type?: unknown }).type)}]`
  }
}

function renderBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.map(renderBlock).join('\n')
}

/** Serialize the complete DSH context; it is also the restart recovery record. */
export function renderCursorTask(options: GenerateOptions, toolsAllowed: boolean): string {
  const sections = [
    'Complete this model step inside DeepSeek Harness.',
    toolsAllowed
      ? 'Use only the supplied DSH Action Space. Every tool call is scheduled, approved, executed, and recorded by DeepSeek Harness.'
      : 'This is a text-only call. Do not invoke any built-in or MCP tool.',
  ]
  if (options.system !== undefined && options.system.length > 0) sections.push(`SYSTEM\n${options.system}`)
  sections.push('CONVERSATION')
  for (const message of options.messages) {
    sections.push(`${message.role.toUpperCase()} id=${message.id}\n${renderBlocks(message.content)}`)
  }
  return sections.join('\n\n')
}

function matchingToolResult(messages: readonly Message[], callId: string): ToolResultBlock | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex]!
      if (block.type === 'tool-result' && block.toolCallId === callId) return block
    }
  }
  return undefined
}

function bridgeKey(options: GenerateOptions): string | undefined {
  if (options.sessionId === undefined || !isAgentLoopRequest(options)) return undefined
  return `${options.sessionId}:conversation`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const TRANSIENT_CATALOG_ERROR = /^CURSOR_(TRANSPORT|TIMEOUT):/u

/**
 * A catalog error a last-good snapshot can ride out. Auth, compatibility,
 * cache, and sandbox failures stay fatal regardless of cached state.
 */
function isTransientCatalogError(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_CATALOG_ERROR.test(error.message)
}

function runtimeLlmError(message: string): LlmError {
  const code = /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1]
  return new LlmError(message, code ?? 'PROVIDER')
}

const NO_RETRY = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'cursor-acp.retry')

/** Native DSH adapter backed by Agent Virtualization's model-provider bridge. */
export class CursorAcpAdapter extends LlmAdapter {
  private readonly active = new Map<string, ActiveBridge>()
  private readonly live = new Set<ActiveBridge>()
  private disposing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: () => CursorAdapterConfig,
    private readonly refresh?: (force: boolean, signal?: AbortSignal, requireSuccess?: boolean) => Promise<void>,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor ACP' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return NO_RETRY
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.refresh?.(false)
    return this.config().models.map(publicModel)
  }

  override async resolveModel(_provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    let model: CursorRuntimeModel
    try {
      model = this.resolveConfiguredModel(modelId)
    } catch (error: unknown) {
      await this.refresh?.(true, signal, true)
      model = this.resolveConfiguredModel(modelId)
    }
    return {
      ...publicModel(model),
      ...(model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.disposing) throw new LlmError('Cursor ACP adapter is disposing', 'TRANSPORT')
    if (options.provider !== CURSOR_ACP_PROVIDER) throw new LlmError(`unexpected provider ${JSON.stringify(options.provider)}`, 'PROVIDER')
    await this.refreshCatalogForRun(options)
    let config = this.config()
    let model = this.resolveConfiguredModel(options.model, config)
    if (!config.models.some(candidate => candidate.id === model.id)) {
      await this.refresh?.(true, options.signal, true)
      this.assertRunLive(options)
      config = this.config()
      model = this.resolveConfiguredModel(options.model, config)
      if (!config.models.some(candidate => candidate.id === model.id)) {
        throw new LlmError(`Cursor no longer offers model ${JSON.stringify(options.model)}`, 'UNKNOWN_MODEL')
      }
    }
    const agentLoop = isAgentLoopRequest(options)
    const key = bridgeKey(options)
    let bridge = key === undefined ? undefined : this.active.get(key)

    if (bridge !== undefined) {
      if (bridge.model.id !== model.id) {
        await this.closeBridge(bridge, 'model changed while a Cursor tool call was pending')
        throw new LlmError('cannot change Cursor model during a pending tool call', 'PROVIDER')
      }
      if (bridge.pendingTool === undefined) throw new LlmError('Cursor ACP bridge is already active', 'PROVIDER')
      const result = matchingToolResult(options.messages, bridge.pendingTool)
      if (result === undefined) {
        await this.closeBridge(bridge, 'missing durable DSH tool result')
        throw new LlmError(`missing DSH tool result for call ${JSON.stringify(bridge.pendingTool)}`, 'PROVIDER')
      }
      try {
        await writeModelProviderInput(bridge.process.stdin!, {
          protocol: MODEL_PROVIDER_PROTOCOL,
          type: 'tool.result',
          requestId: bridge.requestId,
          callId: bridge.pendingTool,
          success: result.isError !== true,
          content: renderBlocks(result.content),
        })
      } catch (error: unknown) {
        await this.closeBridge(bridge, `failed to resume Cursor: ${errorMessage(error)}`, false)
        throw new LlmError('failed to resume Cursor ACP after DSH tool result', 'TRANSPORT')
      }
      delete bridge.pendingTool
    } else {
      bridge = await this.startBridge(options, model, key, config)
      try {
        await writeModelProviderInput(bridge.process.stdin!, {
          protocol: MODEL_PROVIDER_PROTOCOL,
          type: 'model.run',
          requestId: bridge.requestId,
          task: renderCursorTask(options, agentLoop),
          workspace: bridge.privateRoot,
          tools: agentLoop
            ? (options.tools ?? []).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.parameters,
              }))
            : [],
          metadata: {
            provider: options.provider,
            model: options.model,
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          },
        })
      } catch (error: unknown) {
        await this.closeBridge(bridge, `failed to start Cursor: ${errorMessage(error)}`, false)
        throw new LlmError('failed to start Cursor ACP model-provider bridge', 'TRANSPORT')
      }
    }

    let blockIndex = 0
    let terminalStop: 'stop' | 'max-tokens' = 'stop'
    let open: { readonly kind: 'text' | 'reasoning'; readonly index: number; text: string } | undefined
    const closeOpen = (): StreamChunk[] => {
      if (open === undefined) return []
      const current = open
      open = undefined
      return [{
        type: 'block-end',
        index: current.index,
        block: current.kind === 'text'
          ? { type: 'text', text: current.text }
          : { type: 'reasoning', text: current.text },
      }]
    }
    const delta = (kind: 'text' | 'reasoning', text: string): StreamChunk[] => {
      const chunks: StreamChunk[] = []
      if (open?.kind !== kind) {
        chunks.push(...closeOpen())
        open = { kind, index: blockIndex++, text: '' }
        chunks.push({ type: 'block-start', index: open.index, blockType: kind })
      }
      open.text += text
      chunks.push(kind === 'text'
        ? { type: 'text-delta', index: open.index, text }
        : { type: 'reasoning-delta', index: open.index, text })
      return chunks
    }

    try {
      while (true) {
        const output = await bridge.mailbox.next(options.signal)
        this.assertOutputOwner(bridge, output)
        if (output.type === 'model.event') {
          if (output.event.type === 'message.delta' && output.event.message !== undefined) {
            const control = parseCursorControl(output.event.message)
            if (control !== undefined) {
              if ('stopReason' in control) terminalStop = 'max-tokens'
              else {
                for (const chunk of closeOpen()) yield chunk
                yield { type: 'usage', usage: control.usage }
              }
            } else {
              bridge.forwardedText += output.event.message
              for (const chunk of delta('text', output.event.message)) yield chunk
            }
          } else if (output.event.type === 'reasoning.delta' && output.event.message !== undefined) {
            for (const chunk of delta('reasoning', output.event.message)) yield chunk
          }
          continue
        }
        if (output.type === 'tool.call') {
          for (const chunk of closeOpen()) yield chunk
          if (!agentLoop || key === undefined) throw new LlmError('Cursor tool calls require a DSH Agent Loop request', 'POLICY_DENIED')
          if (!(options.tools ?? []).some(tool => tool.name === output.name)) {
            throw new LlmError(`Cursor requested unavailable DSH tool ${JSON.stringify(output.name)}`, 'POLICY_DENIED')
          }
          const index = blockIndex++
          const id = CallId(output.callId)
          const argumentsJson = JSON.stringify(output.arguments)
          if (argumentsJson === undefined) throw new LlmError('Cursor returned non-JSON tool arguments', 'TRANSPORT')
          bridge.pendingTool = output.callId
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: output.name, argumentsDelta: argumentsJson }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: output.name, arguments: argumentsJson } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (output.type === 'model.error') throw runtimeLlmError(output.error)
        if (output.type === 'model.result') {
          if (output.result.status === 'cancelled') {
            for (const chunk of closeOpen()) yield chunk
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: output.result.error ?? 'Cursor request cancelled', code: 'ABORTED' } } }
            await this.closeBridge(bridge, 'cancelled', false)
            return
          }
          if (output.result.status !== 'completed') {
            if (output.result.status === 'timed_out') {
              throw new LlmError(output.result.error ?? 'Cursor prompt timed out', 'TIMEOUT')
            }
            throw runtimeLlmError(output.result.error ?? `Cursor ended with status ${output.result.status}`)
          }
          if (open === undefined && output.result.output.length > 0) {
            const residual = output.result.output.startsWith(bridge.forwardedText)
              ? output.result.output.slice(bridge.forwardedText.length)
              : output.result.output
            if (residual.length > 0) {
              bridge.forwardedText += residual
              for (const chunk of delta('text', residual)) yield chunk
            }
          }
          for (const chunk of closeOpen()) yield chunk
          yield { type: 'finish', reason: { kind: terminalStop } }
          await this.closeBridge(bridge, 'completed', false)
          return
        }
      }
    } catch (error: unknown) {
      const aborted = options.signal?.aborted === true
      const policyDenied = error instanceof LlmError && error.code === 'POLICY_DENIED'
      await this.closeBridge(bridge, `model request failed: ${errorMessage(error)}`, aborted || policyDenied)
      if (aborted) {
        for (const chunk of closeOpen()) yield chunk
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Cursor request aborted', code: 'ABORTED' } } }
        return
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Cursor ACP transport failed: ${errorMessage(error)}`, 'TRANSPORT')
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true
    await Promise.all([...this.live].map(bridge => this.closeBridge(bridge, 'adapter disposed')))
  }

  async reset(reason = 'Cursor ACP configuration changed'): Promise<void> {
    await Promise.all([...this.live].map(bridge => this.closeBridge(bridge, reason)))
  }

  async disposeSession(sessionId: string): Promise<void> {
    const prefix = `${sessionId}:`
    await Promise.all([...this.active.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, bridge]) => this.closeBridge(bridge, 'DSH session disposed')))
  }

  /**
   * Forced pre-run catalog refresh. A transient transport or timeout failure
   * falls back to the last-good catalog only when it still offers the exact
   * requested stable model; every other failure, an aborted caller, a disposed
   * adapter, and any model outside the current catalog stay fatal. A refresh
   * that resolves after disposal or caller abort is equally fatal — a stale
   * stream must never reach config resolution or start a bridge.
   */
  private async refreshCatalogForRun(options: GenerateOptions): Promise<void> {
    try {
      await this.refresh?.(true, options.signal, true)
    } catch (error: unknown) {
      if (this.disposing || options.signal?.aborted === true || !isTransientCatalogError(error)) throw error
      const config = this.config()
      let model: CursorRuntimeModel
      try {
        model = this.resolveConfiguredModel(options.model, config)
      } catch {
        throw error
      }
      if (!config.models.some(candidate => candidate.id === model.id)) throw error
    }
    this.assertRunLive(options)
  }

  /** Fail a run that outlived its adapter or caller, before any bridge side effect. */
  private assertRunLive(options: GenerateOptions): void {
    if (this.disposing) throw new LlmError('Cursor ACP adapter is disposing', 'TRANSPORT')
    if (options.signal?.aborted === true) throw new LlmError('Cursor request aborted', 'ABORTED')
  }

  private resolveConfiguredModel(modelId: string, config = this.config()): CursorRuntimeModel {
    const model = [...config.models, ...config.tombstones].find(candidate => candidate.id === modelId)
    if (model === undefined) throw new LlmError(`unknown Cursor ACP model ${JSON.stringify(modelId)}`, 'UNKNOWN_MODEL')
    return model
  }

  private async startBridge(
    options: GenerateOptions,
    model: CursorRuntimeModel,
    key: string | undefined,
    config: CursorAdapterConfig,
  ): Promise<ActiveBridge> {
    const privateRoot = await mkdtemp(join(tmpdir(), 'dsh-cursor-provider-'))
    const abort = new AbortController()
    const process = this.ctx.subprocess.spawn({
      argv: [config.bridgeCommand, ...config.bridgeArgs, 'model', '--config', model.configPath],
      cwd: privateRoot,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: config.stderrMaxBytes },
      },
      graceMs: config.graceMs,
      signal: abort.signal,
      env: { ...config.env },
    })
    if (process.stdin === undefined || process.stdout === undefined) {
      process.terminate()
      await process.waitForExit()
      await rm(privateRoot, { recursive: true, force: true })
      throw new LlmError('Agent Virtualization bridge did not expose piped stdio', 'TRANSPORT')
    }
    // writeModelProviderInput receives EPIPE through its callback; consume the duplicate event.
    process.stdin.on('error', () => {})
    const bridge: ActiveBridge = {
      key: key ?? `one-shot:${randomUUID()}`,
      requestId: randomUUID(),
      model,
      process,
      mailbox: new ModelProviderMailbox(process.stdout, config.maxProtocolLineBytes),
      abort,
      privateRoot,
      graceMs: config.graceMs,
      forwardedText: '',
      disposed: false,
    }
    this.live.add(bridge)
    if (key !== undefined) this.active.set(key, bridge)
    void process.waitForExit().then(async () => {
      if (bridge.disposed) return
      bridge.disposed = true
      this.live.delete(bridge)
      if (this.active.get(bridge.key) === bridge) this.active.delete(bridge.key)
      bridge.mailbox.close(new Error('Agent Virtualization bridge exited'))
      await rm(bridge.privateRoot, { recursive: true, force: true }).catch(() => {})
    })
    return bridge
  }

  private assertOutputOwner(bridge: ActiveBridge, output: ModelProviderOutput): void {
    if (output.requestId !== undefined && output.requestId !== bridge.requestId) {
      throw new LlmError('Agent Virtualization returned another requestId', 'TRANSPORT')
    }
  }

  private async closeBridge(bridge: ActiveBridge, reason: string, graceful = true): Promise<void> {
    if (bridge.cancelling !== undefined) return bridge.cancelling
    if (bridge.disposed) return
    const closing = (async () => {
      bridge.disposed = true
      this.live.delete(bridge)
      if (this.active.get(bridge.key) === bridge) this.active.delete(bridge.key)
      let exited = false
      if (graceful && bridge.process.stdin !== undefined) {
        await writeModelProviderInput(bridge.process.stdin, {
          protocol: MODEL_PROVIDER_PROTOCOL,
          type: 'model.cancel',
          requestId: bridge.requestId,
          reason,
        }).catch(() => {})
        exited = await new Promise<boolean>(resolveExit => {
          const timer = setTimeout(() => resolveExit(false), bridge.graceMs)
          void bridge.process.waitForExit().then(() => {
            clearTimeout(timer)
            resolveExit(true)
          })
        })
      }
      if (!bridge.abort.signal.aborted) bridge.abort.abort(new Error(reason))
      bridge.mailbox.close(new Error(reason))
      if (!exited) {
        bridge.process.terminate()
        await bridge.process.waitForExit()
      }
      await rm(bridge.privateRoot, { recursive: true, force: true })
    })()
    bridge.cancelling = closing
    return closing
  }
}
