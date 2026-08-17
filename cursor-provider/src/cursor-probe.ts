import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import { strictAcpNdJsonStream } from './acp-stream.js'
import {
  cursorSeatbeltProfile,
  isCursorLaunchVerified,
  resolveCursorLaunch,
} from './cursor-runtime.js'
import type { CursorWireModel } from './types.js'

export interface CursorProbeResult {
  readonly authenticated: boolean
  readonly models: readonly CursorWireModel[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseModels(session: unknown): CursorWireModel[] {
  if (!isRecord(session)) return []
  const rows = Array.isArray(session.models) ? session.models : []
  const models: CursorWireModel[] = []
  for (const row of rows) {
    if (!isRecord(row) || typeof row.modelId !== 'string' || typeof row.name !== 'string') continue
    models.push({
      modelId: row.modelId,
      name: row.name,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
    })
  }
  if (models.length > 0) return models
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  const modelOption = options.find(option => isRecord(option) && option.id === 'model')
  if (!isRecord(modelOption) || !Array.isArray(modelOption.options)) return []
  for (const row of modelOption.options) {
    if (!isRecord(row) || typeof row.value !== 'string') continue
    models.push({ modelId: row.value, name: typeof row.name === 'string' ? row.name : row.value })
  }
  return models
}

async function isolatedHome(root: string, hostHome: string): Promise<string> {
  const home = join(root, 'home')
  await mkdir(join(home, 'Library'), { recursive: true, mode: 0o700 })
  if (process.platform === 'darwin') await symlink(join(hostHome, 'Library/Keychains'), join(home, 'Library/Keychains'))
  return home
}

/** Discover the live Cursor model catalog without exposing account fields. */
export async function probeCursorCatalog(
  command: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
  hostHome = homedir(),
  maxLineBytes = 4 * 1024 * 1024,
): Promise<CursorProbeResult> {
  const launch = await resolveCursorLaunch(command, headers)
  if (!isCursorLaunchVerified(launch)) {
    throw new Error(`INCOMPATIBLE_CURSOR_ACP: Cursor ${launch.version ?? 'unknown'} has not passed the required bypass canaries`)
  }
  if (process.platform !== 'darwin') {
    throw new Error('SANDBOX_UNAVAILABLE: Cursor catalog probe requires macOS Seatbelt')
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-catalog-'))
  let home: string
  try {
    home = await isolatedHome(root, hostHome)
    const profilePath = join(root, 'cursor-probe.sb')
    const [confinedRoot, confinedHome] = await Promise.all([realpath(root), realpath(home)])
    await writeFile(profilePath, cursorSeatbeltProfile(launch.installRoot, confinedRoot, hostHome, confinedHome), { mode: 0o600 })
  } catch (error: unknown) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const profilePath = join(root, 'cursor-probe.sb')
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, launch.command, ...launch.args], {
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      HOME: home,
      TMPDIR: root,
      NODE_COMPILE_CACHE: join(home, 'Library/Caches/cursor-compile-cache'),
      CURSOR_INVOKED_AS: 'cursor-agent',
      CURSOR_AGENT_DISABLE_DEBUG_LOG: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // EPIPE is returned to strict stream writers; consume the duplicate EventEmitter notification.
  child.stdin.on('error', () => {})
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-32 * 1024) })
  const client: acp.Client = {
    async requestPermission() { return { outcome: { outcome: 'cancelled' } } },
    async sessionUpdate() {},
  }
  const connection = new acp.ClientSideConnection(
    () => client,
    strictAcpNdJsonStream(child.stdin, child.stdout, maxLineBytes),
  )
  let probeTimedOut = false
  let sessionId: string | undefined
  let closeSessionSupported = false
  const abort = (): void => { child.kill('SIGTERM') }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => {
    probeTimedOut = true
    child.kill('SIGTERM')
  }, 30_000)
  try {
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-cursor-catalog-probe', version: '0.1.0' },
    })
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`INCOMPATIBLE_CURSOR_ACP: Cursor returned protocol ${String(initialized.protocolVersion)}`)
    }
    closeSessionSupported = initialized.agentCapabilities?.sessionCapabilities?.close !== undefined
      && initialized.agentCapabilities.sessionCapabilities.close !== null
    const session = await connection.newSession({ cwd: root, mcpServers: [] })
    sessionId = session.sessionId
    const models = parseModels(session)
    if (models.length === 0) throw new Error('CURSOR_CATALOG_EMPTY: Cursor ACP returned no models')
    return { authenticated: true, models }
  } catch (error: unknown) {
    if (probeTimedOut) throw new Error('CURSOR_TIMEOUT: Cursor ACP catalog probe timed out')
    const evidence = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.toLowerCase()
    if (/auth|login|sign[ -]?in|credential/u.test(evidence)) return { authenticated: false, models: [] }
    throw new Error(/protocol|version/u.test(evidence)
      ? 'INCOMPATIBLE_CURSOR_ACP: Cursor ACP catalog protocol failed'
      : 'CURSOR_TRANSPORT: Cursor ACP catalog probe failed')
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
    if (sessionId !== undefined && closeSessionSupported) await connection.closeSession({ sessionId }).catch(() => {})
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await new Promise<void>(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit()
      else child.once('close', () => resolveExit())
    })
    clearTimeout(kill)
    await rm(root, { recursive: true, force: true })
  }
}
