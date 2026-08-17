import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { basename, dirname, join, resolve } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import { strictAcpNdJsonStream } from './acp-stream.js'
import { encodeCursorControl, escapeCursorControlText } from './control-event.js'
import { GenericToolBroker } from './generic-tool-broker.js'
import { HttpMcpBridge, type McpToolDefinition } from './http-mcp-bridge.js'
import type { GenericRunStart, GenericToolResult } from './types.js'

export interface CursorRuntimeOptions {
  readonly cursorCommand: string
  readonly wireModel: string
  readonly headers: Readonly<Record<string, string>>
  readonly maxMcpBodyBytes: number
  readonly maxProtocolLineBytes: number
  readonly promptTimeoutMs: number
  readonly graceMs: number
  readonly hostHome?: string
  readonly requireSandbox: boolean
}

export interface CursorLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly installRoot: string
  readonly version?: string
  readonly hashes: {
    readonly launcher: string
    readonly node: string
    readonly index: string
  }
}

/** Cursor artifacts that passed the package's real Read/Write/Shell/WebFetch bypass canaries. */
export const VERIFIED_CURSOR_ARTIFACTS = {
  '2026.08.11-e8db854': {
    launcher: 'eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831',
    node: '336b5b3ebc5deb86df842102b20b6e4761605b7a667823e68dda7761b91a161b',
    index: '6aceb24b7c7ecddb1993946ebb18a7dd4d025842e6efda955eb0c13255b1e5f0',
  },
} as const
export const VERIFIED_CURSOR_VERSIONS = Object.keys(VERIFIED_CURSOR_ARTIFACTS)

export function isCursorVersionVerified(version: string | undefined): boolean {
  return version !== undefined && Object.hasOwn(VERIFIED_CURSOR_ARTIFACTS, version)
}

export function isCursorLaunchVerified(launch: CursorLaunch): boolean {
  if (!isCursorVersionVerified(launch.version)) return false
  const expected = VERIFIED_CURSOR_ARTIFACTS[launch.version as keyof typeof VERIFIED_CURSOR_ARTIFACTS]
  return launch.hashes.launcher === expected.launcher
    && launch.hashes.node === expected.node
    && launch.hashes.index === expected.index
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonLine(output: Writable, value: unknown): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    output.write(`${JSON.stringify(value)}\n`, error => error === null || error === undefined ? resolveWrite() : reject(error))
  })
}

/** Build the supported Cursor global-header arguments followed by ACP mode. */
export function buildCursorAcpArguments(
  indexPath: string,
  headers: Readonly<Record<string, string>>,
): string[] {
  return [
    '--use-system-ca',
    indexPath,
    ...Object.entries(headers).flatMap(([name, value]) => ['--header', `${name}: ${value}`]),
    '--sandbox', 'enabled',
    'acp',
  ]
}

/** Resolve only the official Cursor shell launcher shape into its bundled Node entry. */
export async function resolveCursorLaunch(
  command: string,
  headers: Readonly<Record<string, string>>,
): Promise<CursorLaunch> {
  const launcher = await realpath(command)
  const source = await readFile(launcher, 'utf8')
  if (!source.startsWith('#!/usr/bin/env bash') || !source.includes('SCRIPT_DIR/index.js')) {
    throw new Error('CURSOR_LAUNCHER_UNSUPPORTED: cursor command is not the official Cursor Agent launcher')
  }
  const installRoot = dirname(launcher)
  const versionName = basename(installRoot)
  const version = /^20\d{2}\.\d{2}\.\d{2}-[a-z0-9]+$/iu.test(versionName) ? versionName : undefined
  const node = join(installRoot, 'node')
  const indexPath = join(installRoot, 'index.js')
  await Promise.all([lstat(node), lstat(indexPath)])
  const [launcherHash, nodeHash, indexHash] = await Promise.all([
    sha256(launcher),
    sha256(node),
    sha256(indexPath),
  ])
  return {
    command: node,
    args: buildCursorAcpArguments(indexPath, headers),
    installRoot,
    ...(version === undefined ? {} : { version }),
    hashes: { launcher: launcherHash, node: nodeHash, index: indexHash },
  }
}

function seatbeltQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Build the macOS profile that protects the real home while preserving Cursor login. */
export function cursorSeatbeltProfile(
  installRoot: string,
  privateRoot: string,
  hostHome: string,
  privateHome = privateRoot,
  allowedLoopbackPort?: number,
): string {
  const keychains = join(hostHome, 'Library/Keychains')
  const readableRoots = [
    installRoot,
    privateRoot,
    privateHome,
    keychains,
    '/Applications',
    '/System',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/private/etc',
    '/private/var/db',
    '/private/var/run',
    '/dev',
  ]
  const readableAncestors = new Set<string>(['/', join(hostHome, '.CFUserTextEncoding')])
  for (const root of [installRoot, privateRoot, privateHome, keychains]) {
    let parent = dirname(root)
    while (parent !== '/') {
      readableAncestors.add(parent)
      parent = dirname(parent)
    }
  }
  const readExceptions = [
    ...[...readableAncestors].map(path => `(require-not (literal ${seatbeltQuote(path)}))`),
    ...readableRoots.map(path => `(require-not (subpath ${seatbeltQuote(path)}))`),
  ].join(' ')
  const writableRoots = [privateRoot, privateHome, join(installRoot, '.running'), '/private/tmp/.cursor']
  const writeExceptions = [
    ...writableRoots.map(path => `(require-not (subpath ${seatbeltQuote(path)}))`),
    '(require-not (literal "/dev/null"))',
    '(require-not (literal "/dev/dtracehelper"))',
  ].join(' ')
  return [
    '(version 1)',
    '(allow default)',
    // No blanket (deny process-fork): Cursor authenticates by spawning its
    // Keychain helper, and posix_spawn needs fork. Containment stays on the
    // exec allowlist below — forking alone cannot run anything outside it.
    '(deny process-exec)',
    `(allow process-exec (literal ${seatbeltQuote(join(installRoot, 'node'))}))`,
    // Keychain CLI: Cursor invokes `/usr/bin/security` to read its subscription
    // credential, and `/usr/bin/git` to initialize repository state. Both are
    // host binaries outside the workspace; admitting them keeps login working
    // while every canary (Read/Write/Shell/WebFetch) still passes.
    '(allow process-exec (literal "/usr/bin/security"))',
    '(allow process-exec (literal "/usr/bin/git"))',
    `(deny file-read-data (require-all ${readExceptions}))`,
    `(deny file-write* (require-all ${writeExceptions}))`,
    `(allow file-read* (subpath ${seatbeltQuote(privateRoot)}))`,
    `(allow file-write* (subpath ${seatbeltQuote(privateRoot)}))`,
    `(allow file-read* (subpath ${seatbeltQuote(privateHome)}))`,
    `(allow file-write* (subpath ${seatbeltQuote(privateHome)}))`,
  ].join('\n')
}

async function ensureKeychainLink(privateHome: string, hostHome: string): Promise<void> {
  const library = join(privateHome, 'Library')
  const target = join(library, 'Keychains')
  await mkdir(library, { recursive: true, mode: 0o700 })
  try {
    await symlink(join(hostHome, 'Library/Keychains'), target)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function spawnCursor(
  launch: CursorLaunch,
  options: CursorRuntimeOptions,
  privateRoot: string,
): Promise<ChildProcessWithoutNullStreams> {
  const privateHome = process.env.HOME
  if (privateHome === undefined || options.hostHome === undefined) {
    throw new Error('SANDBOX_UNAVAILABLE: Cursor runtime requires an isolated HOME')
  }
  const resolvedHome = resolve(privateHome)
  const resolvedHostHome = resolve(options.hostHome)
  if (resolvedHome === resolvedHostHome || resolvedHome.startsWith(`${resolvedHostHome}/`)) {
    throw new Error('SANDBOX_UNAVAILABLE: Cursor runtime requires an isolated HOME')
  }
  let command = launch.command
  let args = [...launch.args]
  if (options.requireSandbox) {
    if (!isCursorLaunchVerified(launch)) {
      throw new Error(`INCOMPATIBLE_CURSOR_ACP: Cursor ${launch.version ?? 'unknown'} artifacts have not passed the required bypass canaries`)
    }
    if (process.platform !== 'darwin' || options.hostHome === undefined) {
      throw new Error('SANDBOX_UNAVAILABLE: enforced Cursor ACP currently requires macOS and a host keychain path')
    }
    await ensureKeychainLink(privateHome, options.hostHome)
    const [confinedRoot, confinedHome] = await Promise.all([realpath(privateRoot), realpath(privateHome)])
    const profilePath = join(privateRoot, 'cursor.sb')
    await writeFile(profilePath, cursorSeatbeltProfile(launch.installRoot, confinedRoot, options.hostHome, confinedHome), { mode: 0o600 })
    command = '/usr/bin/sandbox-exec'
    args = ['-f', profilePath, launch.command, ...launch.args]
  }
  return spawn(command, args, {
    cwd: privateRoot,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      HOME: privateHome,
      TMPDIR: join(privateRoot, 'tmp'),
      NODE_COMPILE_CACHE: join(privateHome, 'Library/Caches/cursor-compile-cache'),
      CURSOR_INVOKED_AS: 'cursor-agent',
      CURSOR_AGENT_DISABLE_DEBUG_LOG: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function permissionChoice(params: acp.RequestPermissionRequest, allow: boolean): acp.RequestPermissionResponse {
  if (!allow) return { outcome: { outcome: 'cancelled' } }
  const option = params.options.find(candidate => candidate.kind === 'allow_once')
  return option === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: option.optionId } }
}

export function expectedMcpPermission(
  toolCall: acp.ToolCallUpdate,
  serverName: string,
  tools: ReadonlySet<string>,
): boolean {
  if (toolCall.locations !== undefined && toolCall.locations !== null && toolCall.locations.length > 0) return false
  if (toolCall.kind !== undefined && toolCall.kind !== null
    && toolCall.kind !== 'execute' && toolCall.kind !== 'other') return false
  if (typeof toolCall.title !== 'string') return false
  return [...tools].some(name => toolCall.title === `${serverName}: ${name}`
    || toolCall.title === `${serverName}-${name}: ${name}`)
}

function classifyFailure(error: unknown, stderr: string): Error {
  const message = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.toLowerCase()
  if (/unauth|login|sign[ -]?in|credential/u.test(message)) return new Error('CURSOR_AUTH_REQUIRED: Cursor login is required or expired')
  if (/quota|rate.?limit|usage.?limit|insufficient/u.test(message)) return new Error('CURSOR_QUOTA: Cursor quota is exhausted')
  if (/unknown model|model.+not.+found|invalid model/u.test(message)) return new Error('UNKNOWN_MODEL: Cursor no longer offers the selected model')
  if (/protocol|incompatible|unsupported version/u.test(message)) return new Error('INCOMPATIBLE_CURSOR_ACP: Cursor ACP protocol is incompatible')
  return new Error('CURSOR_TRANSPORT: Cursor ACP process failed')
}

function disjointUsage(update: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | undefined {
  if (!isRecord(update) || !isRecord(update._meta) || !isRecord(update._meta.tokenUsage)) return undefined
  const usage = update._meta.tokenUsage
  if (usage.disjoint !== true && usage.scope !== 'model-call') return undefined
  if (!Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
    || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0) return undefined
  const optional = (key: string): number | undefined => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0 ? Number(usage[key]) : undefined
  return {
    inputTokens: Number(usage.inputTokens),
    outputTokens: Number(usage.outputTokens),
    ...(optional('cacheReadTokens') === undefined ? {} : { cacheReadTokens: optional('cacheReadTokens')! }),
    ...(optional('cacheWriteTokens') === undefined ? {} : { cacheWriteTokens: optional('cacheWriteTokens')! }),
    ...(optional('reasoningTokens') === undefined ? {} : { reasoningTokens: optional('reasoningTokens')! }),
  }
}

function stopStatus(reason: string): 'completed' | 'failed' | 'cancelled' | 'timed_out' {
  if (reason === 'end_turn') return 'completed'
  if (reason === 'cancelled') return 'cancelled'
  if (reason === 'max_tokens') return 'completed'
  return 'failed'
}

/** Run one Agent Virtualization generic-JSONL request through native Cursor ACP. */
export async function runCursorGenericRuntime(
  start: GenericRunStart,
  options: CursorRuntimeOptions,
  streams: { readonly input?: Readable; readonly output?: Writable } = {},
): Promise<void> {
  const input = streams.input ?? process.stdin
  const output = streams.output ?? process.stdout
  let sendChain = Promise.resolve()
  const send = (value: unknown): Promise<void> => {
    sendChain = sendChain.then(() => jsonLine(output, value))
    return sendChain
  }
  const broker = new GenericToolBroker(send)
  const bridge = new HttpMcpBridge(start.capabilities as readonly McpToolDefinition[], broker, options.maxMcpBodyBytes)
  const privateRoot = process.env.HOME === undefined ? process.cwd() : dirname(process.env.HOME)
  await mkdir(join(privateRoot, 'tmp'), { recursive: true, mode: 0o700 })
  await bridge.start()
  const launch = await resolveCursorLaunch(options.cursorCommand, options.headers)
  const child = await spawnCursor(launch, options, privateRoot)
  // EPIPE is returned to strict stream writers; consume the duplicate EventEmitter notification.
  child.stdin.on('error', () => {})
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
  })
  const toolNames = new Set(start.capabilities.map(tool => tool.name))
  const authorizedToolCalls = new Set<string>()
  let connection: acp.ClientSideConnection
  let sessionId: string | undefined
  let closeSessionSupported = false
  let policyViolation: Error | undefined
  let turnFinished = false
  let text = ''
  type CancellationKind = 'explicit' | 'timeout' | 'input' | 'policy' | 'failure'
  let cancellation: { readonly kind: CancellationKind; readonly reason: Error; readonly sent: Promise<void> } | undefined
  let resolveCancellationStarted!: () => void
  const cancellationStarted = new Promise<void>(resolveStarted => { resolveCancellationStarted = resolveStarted })
  const beginCancellation = (kind: CancellationKind, reason: Error): Promise<void> => {
    if (cancellation !== undefined) return cancellation.sent
    broker.close(reason)
    const sent = sessionId === undefined
      ? Promise.resolve()
      : connection.cancel({ sessionId }).catch(() => {})
    cancellation = { kind, reason, sent }
    resolveCancellationStarted()
    return sent
  }
  const currentCancellation = (): typeof cancellation => cancellation
  const client: acp.Client = {
    async requestPermission(params) {
      if (cancellation !== undefined) return permissionChoice(params, false)
      const allowed = expectedMcpPermission(params.toolCall, bridge.serverName, toolNames)
      if (allowed) authorizedToolCalls.add(params.toolCall.toolCallId)
      return permissionChoice(params, allowed && cancellation === undefined)
    },
    async sessionUpdate(params) {
      const update = params.update
      if (policyViolation !== undefined || cancellation !== undefined) return
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        const safeText = escapeCursorControlText(update.content.text)
        text += safeText
        await send({ type: 'message.delta', text: safeText })
        return
      }
      if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
        await send({ type: 'reasoning.delta', text: update.content.text })
        return
      }
      if (update.sessionUpdate === 'usage_update') {
        const usage = disjointUsage(update)
        if (usage !== undefined) await send({ type: 'message.delta', text: encodeCursorControl({ usage }) })
        return
      }
      if (update.sessionUpdate === 'tool_call') {
        // Cursor presents its configured MCP call as the generic title "MCP: tool"
        // before the separately validated permission request and HTTP tools/call.
        // The notification is observational only; it never executes a DSH tool.
        const expected = authorizedToolCalls.has(update.toolCallId)
          || (update.title === 'MCP: tool' && toolNames.size > 0)
        if (!expected) {
          policyViolation = new Error(`POLICY_DENIED: Cursor attempted built-in tool ${String(update.title ?? 'unknown')}`)
          await beginCancellation('policy', policyViolation)
        }
      }
    },
  }
  connection = new acp.ClientSideConnection(
    () => client,
    strictAcpNdJsonStream(child.stdin, child.stdout, options.maxProtocolLineBytes),
  )
  const lines = createInterface({ input, crlfDelay: Infinity })
  let timeout: NodeJS.Timeout | undefined
  const inputLoop = (async () => {
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue
        const message: unknown = JSON.parse(line)
        if (!isRecord(message)) throw new Error('invalid generic runtime input')
        if (message.type === 'tool.result') broker.resolve(message as unknown as GenericToolResult)
        else if (message.type === 'run.cancel') {
          await beginCancellation('explicit', new Error('CURSOR_CANCELLED: Cursor request cancelled'))
        } else throw new Error(`unexpected generic runtime input ${String(message.type)}`)
      }
      if (!turnFinished) await beginCancellation('input', new Error('CURSOR_TRANSPORT: generic runtime input closed'))
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!turnFinished) await beginCancellation('input', failure)
    }
  })()

  try {
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-cursor-acp-runtime', version: '0.1.0' },
    })
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`INCOMPATIBLE_CURSOR_ACP: Cursor returned protocol ${String(initialized.protocolVersion)}`)
    }
    closeSessionSupported = initialized.agentCapabilities?.sessionCapabilities?.close !== undefined
      && initialized.agentCapabilities.sessionCapabilities.close !== null
    const session = await connection.newSession({
      cwd: privateRoot,
      mcpServers: [{
        type: 'http',
        name: bridge.serverName,
        url: bridge.endpoint,
        headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }],
      }],
    })
    sessionId = session.sessionId
    await connection.setSessionMode({ sessionId, modeId: 'ask' })
    await connection.setSessionConfigOption({ sessionId, configId: 'model', value: options.wireModel })
    timeout = setTimeout(() => {
      void beginCancellation('timeout', new Error('CURSOR_TIMEOUT: Cursor prompt timed out'))
    }, options.promptTimeoutMs)
    const prompt = [start.instructions, start.task].filter(value => value !== undefined && value.trim().length > 0).join('\n\n')
    if (cancellation !== undefined) throw cancellation.reason
    const promptResult = connection.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] })
    const cancellationDrain = cancellationStarted.then(async () => {
      await cancellation!.sent
      let drainTimer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          promptResult,
          new Promise<never>((_, reject) => {
            drainTimer = setTimeout(() => reject(cancellation!.reason), options.graceMs)
          }),
        ])
      } finally {
        if (drainTimer !== undefined) clearTimeout(drainTimer)
      }
    })
    const result = await Promise.race([promptResult, cancellationDrain])
    turnFinished = true
    if (policyViolation !== undefined) throw policyViolation
    const cancelled = currentCancellation()
    if (cancelled !== undefined) throw cancelled.reason
    if (result.stopReason === 'max_tokens') await send({ type: 'message.delta', text: encodeCursorControl({ stopReason: 'max_tokens' }) })
    const status = stopStatus(result.stopReason)
    await send({
      type: 'result',
      status,
      output: text,
      ...(status === 'failed' ? { error: `CURSOR_STOP: ${result.stopReason}` } : {}),
    })
  } catch (error: unknown) {
    turnFinished = true
    const normalized = error instanceof Error && /^(POLICY_DENIED|CURSOR_)/u.test(error.message)
      ? error
      : classifyFailure(error, stderr)
    if (sessionId !== undefined && cancellation === undefined) await beginCancellation('failure', normalized)
    await send({
      type: 'result',
      status: cancellation?.kind === 'explicit' ? 'cancelled' : cancellation?.kind === 'timeout' ? 'timed_out' : 'failed',
      output: text,
      error: normalized.message,
    })
  } finally {
    turnFinished = true
    if (timeout !== undefined) clearTimeout(timeout)
    if (cancellation !== undefined) await cancellation.sent
    else if (sessionId !== undefined && closeSessionSupported) await connection.closeSession({ sessionId }).catch(() => {})
    lines.close()
    await inputLoop
    broker.close(new Error('Cursor runtime closed'))
    await bridge.close().catch(() => {})
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, options.graceMs)
    await new Promise<void>(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit()
      else child.once('close', () => resolveExit())
    })
    clearTimeout(kill)
    await sendChain
  }
}
