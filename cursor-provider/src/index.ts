/** Native Cursor subscription models through ACP and the DSH tool scheduler. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { executableOnPathSync } from 'agent-virtualization'
import { CursorAcpAdapter } from './adapter.js'
import { CursorCatalogStore } from './catalog-store.js'
import { isCursorLaunchVerified, resolveCursorLaunch } from './cursor-runtime.js'
import {
  CURSOR_ACP_PROVIDER,
  DEFAULT_CURSOR_MODEL,
  type CursorProviderConfig,
  type ResolvedCursorProviderConfig,
} from './types.js'

export { CursorAcpAdapter, renderCursorTask } from './adapter.js'
export { CursorCatalogStore } from './catalog-store.js'
export { normalizeCursorCatalog, parseCursorWireModel } from './model-catalog.js'
export type * from './types.js'

export const name = 'llm-cursor-acp'
export const inject = ['llm', 'subprocess']
export const PROVIDER = CURSOR_ACP_PROVIDER
export const SETTINGS_NAMESPACE = settingsNamespace('llm-cursor-acp')
const RPC_CHANNEL = '/cursor-acp'
export const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1_000
export const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1_000
export const DEFAULT_GRACE_MS = 5_000
export const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_MCP_BODY_BYTES = 1024 * 1024
export const DEFAULT_STDERR_MAX_BYTES = 64 * 1024
const siblingRuntimeBin = fileURLToPath(new URL('./runtime-bin.js', import.meta.url))
export const DEFAULT_RUNTIME_BIN = existsSync(siblingRuntimeBin)
  ? siblingRuntimeBin
  : fileURLToPath(new URL('../dist/runtime-bin.js', import.meta.url))
export const DEFAULT_BRIDGE_CLI = fileURLToPath(new URL('./cli/bin.js', import.meta.resolve('agent-virtualization')))

export const Config: z<CursorProviderConfig> = z.object({
  command: z.string().description('Absolute Cursor Agent CLI path; defaults to cursor-agent on PATH.'),
  defaultModel: z.string().default(DEFAULT_CURSOR_MODEL).description('Stable Cursor model id suggested as the default selection.'),
  catalogTtlMs: z.number().step(1).min(1).default(DEFAULT_CATALOG_TTL_MS).description('Live Cursor model catalog refresh interval in milliseconds.'),
  promptTimeoutMs: z.number().step(1).min(1).default(DEFAULT_PROMPT_TIMEOUT_MS).description('Maximum time for one Cursor ACP prompt in milliseconds.'),
  graceMs: z.number().step(1).min(1).default(DEFAULT_GRACE_MS).description('Process-tree SIGTERM grace period in milliseconds.'),
  maxProtocolLineBytes: z.number().step(1).min(1).default(DEFAULT_MAX_PROTOCOL_LINE_BYTES).description('Maximum Agent Virtualization protocol line size.'),
  maxMcpBodyBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MCP_BODY_BYTES).description('Maximum private MCP JSON-RPC request body size.'),
  stderrMaxBytes: z.number().step(1).min(1).default(DEFAULT_STDERR_MAX_BYTES).description('Maximum retained Cursor bridge stderr bytes.'),
})

export function resolveConfig(config: CursorProviderConfig): ResolvedCursorProviderConfig {
  const command = config.command?.trim() || executableOnPathSync('cursor-agent')
  if (command === undefined) throw new Error('llm-cursor-acp: cursor-agent is not installed or command is not configured')
  const values = {
    command,
    defaultModel: config.defaultModel?.trim() || DEFAULT_CURSOR_MODEL,
    catalogTtlMs: config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS,
    promptTimeoutMs: config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    maxProtocolLineBytes: config.maxProtocolLineBytes ?? DEFAULT_MAX_PROTOCOL_LINE_BYTES,
    maxMcpBodyBytes: config.maxMcpBodyBytes ?? DEFAULT_MAX_MCP_BODY_BYTES,
    stderrMaxBytes: config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'command' || key === 'defaultModel') continue
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`llm-cursor-acp: ${key} must be a positive safe integer`)
  }
  return values
}

function configFingerprint(config: ResolvedCursorProviderConfig): string {
  return [
    config.command,
    config.defaultModel,
    config.catalogTtlMs,
    config.promptTimeoutMs,
    config.graceMs,
    config.maxProtocolLineBytes,
    config.maxMcpBodyBytes,
    config.stderrMaxBytes,
  ].join('\u0000')
}

export function providerCacheRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'llm-cursor-acp')
}

export function createCatalogStore(config: ResolvedCursorProviderConfig): CursorCatalogStore {
  return new CursorCatalogStore({
    cacheRoot: providerCacheRoot(),
    runtimeBin: DEFAULT_RUNTIME_BIN,
    bridgeCommand: process.execPath,
    bridgeArgs: [DEFAULT_BRIDGE_CLI],
    hostHome: homedir(),
    headers: attributionHeaders(),
    config,
  })
}

/** Register Cursor ACP as a native configurable DSH model provider. */
export async function apply(ctx: Context, config: CursorProviderConfig): Promise<void> {
  let current = (): CursorProviderConfig => config
  let lastRaw: CursorProviderConfig | undefined
  let lastGood: ResolvedCursorProviderConfig | undefined
  const options = (): ResolvedCursorProviderConfig => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    const resolved = resolveConfig(raw)
    lastRaw = raw
    lastGood = resolved
    return resolved
  }
  let activeConfig: ResolvedCursorProviderConfig
  let store: CursorCatalogStore
  let adapter: CursorAcpAdapter | undefined
  let ready = false
  let reconfigure = Promise.resolve()
  const lifecycle = new AbortController()
  const operationSignal = (signal?: AbortSignal): AbortSignal => signal === undefined
    ? lifecycle.signal
    : AbortSignal.any([signal, lifecycle.signal])
  ctx.effect(() => async () => {
    ready = false
    lifecycle.abort(new Error('Cursor ACP plugin disposed'))
    await adapter?.dispose()
    await reconfigure.catch(() => {})
  }, 'llm-cursor-acp: terminate catalog probes and Cursor ACP bridges')
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    validate: value => { resolveConfig(value) },
    setSource: source => { current = source },
    onChange: () => {
      const currentAdapter = adapter
      if (!ready || currentAdapter === undefined) return
      reconfigure = reconfigure.then(async () => {
        const next = options()
        if (configFingerprint(next) === configFingerprint(activeConfig)) return
        const replacement = createCatalogStore(next)
        await replacement.load()
        await replacement.refresh(true, lifecycle.signal).catch(() => {})
        lifecycle.signal.throwIfAborted()
        await currentAdapter.reset()
        store = replacement
        activeConfig = next
      })
      void reconfigure.catch(() => {})
    },
  })

  activeConfig = options()
  store = createCatalogStore(activeConfig)
  await store.load()
  await store.refresh(false, lifecycle.signal).catch(() => {})
  lifecycle.signal.throwIfAborted()
  const registeredAdapter = new CursorAcpAdapter(
    ctx,
    () => store.adapterConfig(),
    (force, signal, requireSuccess) => store.refresh(force, operationSignal(signal), requireSuccess),
  )
  adapter = registeredAdapter
  ready = true

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'Cursor ACP',
    settingsNs: SETTINGS_NAMESPACE,
    settingsPath: [],
  }])
  ctx.llm.registerAdapter([PROVIDER], registeredAdapter)
  ctx.on('session/disposed', (session: Session) => { void registeredAdapter.disposeSession(String(session.id)) })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') void registeredAdapter.disposeSession(String(session.id))
  })

  ctx.inject(['connection'], (sctx) => {
    const handler = async (endpoint: string, payload: unknown, signal: AbortSignal) => {
      try {
        if (endpoint === 'status' || endpoint === 'refresh') {
          if (endpoint === 'refresh') await store.refresh(true, operationSignal(signal), true)
          const resolved = options()
          const launch = await resolveCursorLaunch(resolved.command, attributionHeaders())
          const models = store.adapterConfig().models
          return {
            ok: true as const,
            value: {
              command: resolved.command,
              version: launch.version,
              compatible: isCursorLaunchVerified(launch),
              authStatus: store.authenticationState,
              defaultModel: resolved.defaultModel,
              defaultModelAvailable: models.some(model => model.id === resolved.defaultModel),
              models: models.map(model => ({ id: model.id, name: model.name })),
              error: store.lastError === undefined ? undefined : /^([A-Z][A-Z0-9_]+):/u.exec(store.lastError.message)?.[1] ?? 'CURSOR_PROVIDER_ERROR',
            },
          }
        }
        if (endpoint === 'configure') {
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('invalid settings payload')
          const command = Reflect.get(payload, 'command')
          const defaultModel = Reflect.get(payload, 'defaultModel')
          if (typeof command !== 'string' || command.trim().length === 0
            || typeof defaultModel !== 'string' || defaultModel.trim().length === 0) {
            throw new Error('command and defaultModel are required')
          }
          const settings = sctx.get('settings')
          if (settings === undefined) throw new Error('settings service is unavailable')
          await settings.update(SETTINGS_NAMESPACE, { command: command.trim(), defaultModel: defaultModel.trim() })
          return { ok: true as const, value: { saved: true } }
        }
        return { ok: false as const, error: { code: 'internal' as const, message: 'unknown Cursor ACP endpoint', details: {} } }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false as const, error: { code: 'internal' as const, message, details: {} } }
      }
    }
    sctx.effect(() => sctx.connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'loopback' }))
  })
}
