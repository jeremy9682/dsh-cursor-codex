import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createToolResultMessage,
  createUserMessage,
  markAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CursorAcpAdapter, renderCursorTask } from '../src/adapter.js'
import type { CursorAdapterConfig } from '../src/types.js'

const mockBridge = fileURLToPath(new URL('./mock-model-provider.mjs', import.meta.url))
const contexts: Context[] = []
const config: CursorAdapterConfig = {
  bridgeCommand: process.execPath,
  bridgeArgs: [mockBridge],
  env: {},
  graceMs: 1_000,
  maxProtocolLineBytes: 64 * 1024,
  stderrMaxBytes: 16 * 1024,
  models: [{
    provider: 'cursor-acp',
    id: 'cursor-mock-high',
    name: 'Cursor Mock High',
    inputModalities: ['text'],
    wireModelId: 'mock[effort=high]',
    configPath: 'unused-high.json',
  }, {
    provider: 'cursor-acp',
    id: 'cursor-mock-low',
    name: 'Cursor Mock Low',
    inputModalities: ['text'],
    wireModelId: 'mock[effort=low]',
    configPath: 'unused-low.json',
  }],
  tombstones: [],
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; adapter: CursorAcpAdapter }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const adapter = new CursorAcpAdapter(ctx, () => config)
  return { ctx, adapter }
}

function baseOptions(text = 'hello'): GenerateOptions {
  return {
    provider: 'cursor-acp',
    model: 'cursor-mock-high',
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
  }
}

async function collect(adapter: CursorAcpAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

describe('Cursor ACP DSH adapter', () => {
  it('streams indexed reasoning and text blocks with exactly one finish', async () => {
    const { adapter } = await harness()
    const chunks = await collect(adapter, baseOptions())
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'think' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'cursor-text' })
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    await adapter.dispose()
  })

  it('suspends one Agent Loop tool call and resumes the same bridge', async () => {
    const { adapter } = await harness()
    const firstOptions = markAgentLoopRequest({
      ...baseOptions(),
      sessionId: SessionId('cursor-adapter-tool'),
      tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
    })
    const first = await collect(adapter, firstOptions)
    const block = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(block).toMatchObject({ type: 'block-end', block: { type: 'tool-call', name: 'echo' } })
    expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    if (block?.type !== 'block-end' || block.block.type !== 'tool-call') throw new Error('missing tool call block')

    const second = await collect(adapter, markAgentLoopRequest({
      ...firstOptions,
      messages: [...firstOptions.messages, createToolResultMessage({
        callId: CallId(block.block.id),
        content: [{ type: 'text', text: 'scheduled-by-dsh' }],
        isError: false,
      })],
    }))
    expect(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe(' resumed:scheduled-by-dsh')
    expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    await adapter.dispose()
  })

  it('does not advertise tools to direct, compaction, or title calls', async () => {
    const { adapter } = await harness()
    const chunks = await collect(adapter, {
      ...baseOptions(),
      purpose: 'compaction',
      tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
    })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    await adapter.dispose()
  })

  it('fails closed when a non-Agent-Loop request emits a tool call', async () => {
    const { adapter } = await harness()
    await expect(collect(adapter, baseOptions('FORCE_TOOL'))).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await adapter.dispose()
  })

  it('publishes no automatic retries and resolves tombstoned selections', async () => {
    const { adapter } = await harness()
    expect(adapter.providerRetryPolicy('cursor-acp')).toMatchObject({ mode: 'normal', maxRetries: 0 })
    const tombstone = { ...config.models[0]!, id: 'cursor-old', name: 'Cursor Old' }
    const tombstoned = new CursorAcpAdapter(contexts[0]!, () => ({ ...config, models: [], tombstones: [tombstone] }))
    await expect(tombstoned.listModels('cursor-acp')).resolves.toEqual([])
    await expect(tombstoned.resolveModel('cursor-acp', 'cursor-old')).resolves.toMatchObject({ id: 'cursor-old' })
    await tombstoned.dispose()
    await adapter.dispose()
  })

  it('preserves stable auth, quota, timeout, and compatibility error codes', async () => {
    const { adapter } = await harness()
    for (const [marker, code] of [
      ['AUTH_EXPIRED', 'AUTH_EXPIRED'],
      ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
      ['TIMED_OUT', 'TIMEOUT'],
      ['INCOMPATIBLE_CURSOR_ACP', 'INCOMPATIBLE_CURSOR_ACP'],
    ] as const) {
      await expect(collect(adapter, baseOptions(marker))).rejects.toMatchObject({ code })
    }
    await adapter.dispose()
  })

  it('maps malformed protocol and abnormal exits to transport errors', async () => {
    const { adapter } = await harness()
    await expect(collect(adapter, baseOptions('MALFORMED'))).rejects.toMatchObject({ code: 'TRANSPORT' })
    await expect(collect(adapter, baseOptions('ABNORMAL_EXIT'))).rejects.toMatchObject({ code: 'TRANSPORT' })
    await adapter.dispose()
  })

  it('returns an aborted finish and tears down a waiting bridge', async () => {
    const { adapter } = await harness()
    const controller = new AbortController()
    const iterator = adapter.stream({ ...baseOptions('WAIT_FOR_ABORT'), signal: controller.signal })[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start', blockType: 'reasoning' } })
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'reasoning-delta', text: 'waiting' } })
    controller.abort(new Error('test cancellation'))
    const tail: StreamChunk[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      tail.push(next.value)
    }
    expect(tail.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    await adapter.dispose()
  })

  it('terminates an in-flight prompt when the adapter fiber is disposed', async () => {
    const { adapter } = await harness()
    const iterator = adapter.stream(baseOptions('WAIT_FOR_ABORT'))[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start', blockType: 'reasoning' } })
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'reasoning-delta', text: 'waiting' } })
    const pending = iterator.next()
    await adapter.dispose()
    const tail: StreamChunk[] = []
    let next = await pending
    while (!next.done) {
      tail.push(next.value)
      next = await iterator.next()
    }
    expect(tail.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    await expect(collect(adapter, baseOptions())).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('terminates a suspended MCP bridge during configuration reset', async () => {
    const { adapter } = await harness()
    const options = markAgentLoopRequest({
      ...baseOptions(),
      sessionId: SessionId('cursor-adapter-reset'),
      tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
    })
    await expect(collect(adapter, options)).resolves.toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    await adapter.reset('test HMR')
    await expect(collect(adapter, baseOptions())).resolves.toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    await adapter.dispose()
  })

  it('switches exact stable model ids and rejects unknown selections', async () => {
    const { adapter } = await harness()
    const chunks = await collect(adapter, { ...baseOptions('ECHO_MODEL'), model: 'cursor-mock-low' })
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('cursor-mock-low')
    await expect(adapter.resolveModel('cursor-acp', 'cursor-missing')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await adapter.dispose()
  })

  it('renders the complete DSH transcript and explicit tool policy', () => {
    const options = baseOptions('hello')
    expect(renderCursorTask(options, false)).toContain('This is a text-only call')
    expect(renderCursorTask(options, false)).toContain('USER id=')
    expect(renderCursorTask(options, true)).toContain('scheduled, approved, executed, and recorded')
  })
})
