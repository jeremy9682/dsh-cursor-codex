import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CursorCatalogStore, type CursorCatalogStoreOptions } from '../src/catalog-store.js'
import type { CursorProbeResult, } from '../src/cursor-probe.js'
import type { ResolvedCursorProviderConfig } from '../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const config: ResolvedCursorProviderConfig = {
  command: '/cursor-agent',
  defaultModel: 'cursor-grok-4.6-high',
  catalogTtlMs: 60_000,
  promptTimeoutMs: 5_000,
  graceMs: 1_000,
  maxProtocolLineBytes: 64 * 1024,
  maxMcpBodyBytes: 4_096,
  stderrMaxBytes: 4_096,
}

async function options(probe: NonNullable<CursorCatalogStoreOptions['probe']>): Promise<CursorCatalogStoreOptions> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'cursor-store-test-'))
  roots.push(cacheRoot)
  return {
    cacheRoot,
    runtimeBin: '/package/runtime-bin.js',
    bridgeCommand: '/node',
    bridgeArgs: ['/agent-virtualization/bin.js'],
    hostHome: '/host-home',
    headers: { 'user-agent': 'deepseek-harness/test' },
    config,
    probe,
  }
}

function result(modelId: string): CursorProbeResult {
  return { authenticated: true, models: [{ modelId, name: modelId.split('[')[0]! }] }
}

describe('dynamic Cursor catalog store', () => {
  it('writes Agent Virtualization configs with exact wire model and attribution', async () => {
    const storeOptions = await options(async () => result('grok-4.6[effort=high,fast=true]'))
    const store = new CursorCatalogStore(storeOptions)
    await store.refresh(true)
    const [model] = store.adapterConfig().models
    expect(model?.id).toBe('cursor-grok-4.6-high')
    const runtime = JSON.parse(await readFile(model!.configPath, 'utf8')) as Record<string, any>
    expect(runtime.runtime.type).toBe('generic-jsonl')
    expect(runtime.runtime.args).toContain('grok-4.6[effort=high,fast=true]')
    expect(runtime.runtime.args).toContain('user-agent:deepseek-harness/test')
    expect(runtime.runtime.args).toContain('--max-protocol-line-bytes')
    expect(runtime.environment.sandbox).toMatchObject({ mode: 'read-only', network: 'inherit', requireEnforcement: false })
    expect(runtime.sandboxProvider).toMatchObject({ type: 'noop' })
  })

  it('orders the configured stable default first for native model selection', async () => {
    const store = new CursorCatalogStore(await options(async () => ({
      authenticated: true,
      models: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'grok-4.6[effort=high,fast=true]', name: 'grok-4.6' },
      ],
    })))
    await store.refresh(true)
    expect(store.adapterConfig().models.map(model => model.id)).toEqual(['cursor-grok-4.6-high', 'cursor-default'])
  })

  it('keeps removed models as resolution tombstones but not current models', async () => {
    let next = result('grok-4.6[effort=high]')
    const store = new CursorCatalogStore(await options(async () => next))
    await store.refresh(true)
    next = result('gpt-5.6[effort=medium]')
    await store.refresh(true)
    expect(store.adapterConfig().models.map(model => model.id)).toEqual(['cursor-gpt-5.6-medium'])
    expect(store.adapterConfig().tombstones.map(model => model.id)).toContain('cursor-grok-4.6-high')
  })

  it('persists wire-to-stable mappings when a slug collision appears later', async () => {
    let models: CursorProbeResult = {
      authenticated: true,
      models: [{ modelId: 'foo/bar[]', name: 'foo/bar' }],
    }
    const storeOptions = await options(async () => models)
    const store = new CursorCatalogStore(storeOptions)
    await store.refresh(true)
    expect(store.adapterConfig().models[0]?.id).toBe('cursor-foo-bar')
    models = {
      authenticated: true,
      models: [
        { modelId: 'foo/bar[]', name: 'foo/bar' },
        { modelId: 'foo-bar[]', name: 'foo-bar' },
      ],
    }
    await store.refresh(true)
    const ids = Object.fromEntries(store.adapterConfig().models.map(model => [model.wireModelId, model.id]))
    expect(ids['foo/bar[]']).toBe('cursor-foo-bar')
    expect(ids['foo-bar[]']).toMatch(/^cursor-foo-bar-[a-f0-9]{8}$/u)

    const reloaded = new CursorCatalogStore({ ...storeOptions, probe: async () => { throw new Error('must not probe') } })
    await reloaded.load()
    expect(Object.fromEntries(reloaded.adapterConfig().models.map(model => [model.wireModelId, model.id]))).toEqual(ids)
  })

  it('retains last-good catalog when refresh fails', async () => {
    let fail = false
    const store = new CursorCatalogStore(await options(async () => {
      if (fail) throw new Error('CURSOR_TRANSPORT: offline')
      return result('grok-4.6[effort=high]')
    }))
    await store.refresh(true)
    fail = true
    await expect(store.refresh(true)).resolves.toBeUndefined()
    await expect(store.refresh(true, undefined, true)).rejects.toThrow('CURSOR_TRANSPORT: offline')
    expect(store.adapterConfig().models).toHaveLength(1)
    expect(store.lastError?.message).toBe('CURSOR_TRANSPORT: offline')
    expect(store.authenticationState).toBe('unknown')
    expect(store.authenticated).toBe(false)
  })

  it('marks auth expiry unhealthy, preserves last-good, and refreshes after account change', async () => {
    let next: CursorProbeResult = result('grok-4.6[effort=high]')
    const store = new CursorCatalogStore(await options(async () => next))
    await store.refresh(true)
    next = { authenticated: false, models: [] }
    await store.refresh(true)
    expect(store.authenticated).toBe(false)
    expect(store.authenticationState).toBe('required')
    expect(store.adapterConfig().models.map(model => model.id)).toEqual(['cursor-grok-4.6-high'])
    next = result('claude-sonnet-5[effort=high]')
    await store.refresh(true)
    expect(store.authenticated).toBe(true)
    expect(store.authenticationState).toBe('verified')
    expect(store.adapterConfig().models.map(model => model.id)).toEqual(['cursor-claude-sonnet-5-high'])
  })

  it('propagates lifecycle cancellation into an active catalog probe', async () => {
    let observed: AbortSignal | undefined
    const store = new CursorCatalogStore(await options(async (_command, _headers, signal) => {
      observed = signal
      return await new Promise<CursorProbeResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const controller = new AbortController()
    const refresh = store.refresh(true, controller.signal, true)
    controller.abort(new Error('plugin disposed'))
    await expect(refresh).rejects.toThrow('plugin disposed')
    expect(observed?.aborted).toBe(true)
  })

  it('loads the secret-free persisted catalog without probing', async () => {
    const storeOptions = await options(async () => result('grok-4.6[effort=high]'))
    const first = new CursorCatalogStore(storeOptions)
    await first.refresh(true)
    const loaded = new CursorCatalogStore({ ...storeOptions, probe: async () => { throw new Error('must not probe') } })
    await loaded.load()
    expect(loaded.adapterConfig().models.map(model => model.id)).toEqual(['cursor-grok-4.6-high'])
    expect(loaded.authenticationState).toBe('unknown')
    expect(loaded.authenticated).toBe(false)
  })
})
