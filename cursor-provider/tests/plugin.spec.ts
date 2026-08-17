import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as CursorProvider from '../src/index.js'

let ctx: Context | undefined
let root: string | undefined
const previousDshHome = process.env.DSH_HOME

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
})

describe('Cursor ACP provider registration', () => {
  it('registers as a configurable native provider and loads cached live models', async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-plugin-test-'))
    process.env.DSH_HOME = root
    const cache = join(root, 'cache', 'llm-cursor-acp')
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'catalog.json'), JSON.stringify({
      version: 1,
      wireModels: [{ modelId: 'grok-4.6[effort=high,fast=true]', name: 'grok-4.6' }],
    }))
    ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(CursorProvider, {
      command: '/Users/zihan/.local/bin/cursor-agent',
      catalogTtlMs: Number.MAX_SAFE_INTEGER,
    })

    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'cursor-acp',
      displayName: 'Cursor ACP',
      settingsNs: CursorProvider.SETTINGS_NAMESPACE,
      settingsPath: [],
    })
    await expect(ctx.llm.listModels('cursor-acp')).resolves.toContainEqual({
      provider: 'cursor-acp',
      id: 'cursor-grok-4.6-high',
      name: 'Cursor grok-4.6 · high',
      inputModalities: ['text'],
    })
  })
})
