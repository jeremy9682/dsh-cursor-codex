#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executableOnPathSync } from 'agent-virtualization'
import { CursorCatalogStore } from './catalog-store.js'
import { isCursorLaunchVerified, resolveCursorLaunch } from './cursor-runtime.js'
import {
  DEFAULT_CURSOR_MODEL,
  type ResolvedCursorProviderConfig,
} from './types.js'

export const CLI_ATTRIBUTION_HEADERS = {
  'user-agent': 'deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)',
} as const

function resolveCliConfig(command: string | undefined): ResolvedCursorProviderConfig {
  const resolvedCommand = command?.trim() || executableOnPathSync('cursor-agent')
  if (resolvedCommand === undefined) throw new Error('CURSOR_COMMAND_MISSING: cursor-agent is not installed or configured')
  return {
    command: resolvedCommand,
    defaultModel: DEFAULT_CURSOR_MODEL,
    catalogTtlMs: 5 * 60 * 1_000,
    promptTimeoutMs: 5 * 60 * 1_000,
    graceMs: 5_000,
    maxProtocolLineBytes: 4 * 1024 * 1024,
    maxMcpBodyBytes: 1024 * 1024,
    stderrMaxBytes: 64 * 1024,
  }
}

function createCliStore(config: ResolvedCursorProviderConfig): CursorCatalogStore {
  const siblingRuntime = fileURLToPath(new URL('./runtime-bin.js', import.meta.url))
  const runtimeBin = existsSync(siblingRuntime)
    ? siblingRuntime
    : fileURLToPath(new URL('../dist/runtime-bin.js', import.meta.url))
  return new CursorCatalogStore({
    cacheRoot: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'llm-cursor-acp'),
    runtimeBin,
    bridgeCommand: process.execPath,
    bridgeArgs: [fileURLToPath(new URL('./cli/bin.js', import.meta.resolve('agent-virtualization')))],
    hostHome: homedir(),
    headers: CLI_ATTRIBUTION_HEADERS,
    config,
  })
}

interface CliOptions {
  readonly command: 'doctor' | 'models' | 'probe'
  readonly cursorCommand?: string
  readonly json: boolean
  readonly refresh: boolean
}

export function parseCliArguments(argv: readonly string[]): CliOptions {
  const command = argv[0]
  if (command !== 'doctor' && command !== 'models' && command !== 'probe') {
    throw new Error('usage: dsh-cursor-provider <doctor|models|probe> [--command PATH] [--refresh] [--json]')
  }
  let cursorCommand: string | undefined
  let json = false
  let refresh = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') json = true
    else if (argument === '--refresh') refresh = true
    else if (argument === '--command') {
      cursorCommand = argv[index + 1]
      if (cursorCommand === undefined) throw new Error('--command requires a path')
      index += 1
    } else throw new Error(`unknown option ${String(argument)}`)
  }
  return { command, ...(cursorCommand === undefined ? {} : { cursorCommand }), json, refresh }
}

function errorCode(error: Error | undefined): string | undefined {
  if (error === undefined) return undefined
  return /^([A-Z][A-Z0-9_]+):/u.exec(error.message)?.[1] ?? 'CURSOR_PROVIDER_ERROR'
}

async function run(options: CliOptions): Promise<void> {
  const config = resolveCliConfig(options.cursorCommand)
  const store = createCliStore(config)
  await store.load()
  await store.refresh(options.refresh || options.command !== 'models').catch(() => {})
  const catalog = store.adapterConfig().models
  const sandboxAvailable = process.platform === 'darwin'
    && await access('/usr/bin/sandbox-exec').then(() => true, () => false)
  const launch = await resolveCursorLaunch(config.command, CLI_ATTRIBUTION_HEADERS).catch(() => undefined)
  const version = launch?.version
  const report = {
    provider: 'cursor-acp',
    command: config.command,
    version,
    compatible: launch !== undefined && isCursorLaunchVerified(launch),
    signedIn: store.authenticated,
    authStatus: store.authenticationState,
    sandbox: sandboxAvailable ? 'seatbelt' : 'unavailable',
    defaultModel: config.defaultModel,
    defaultModelAvailable: catalog.some(model => model.id === config.defaultModel),
    error: errorCode(store.lastError),
    models: catalog.map(model => ({ id: model.id, name: model.name })),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  if (options.command === 'models') {
    for (const model of report.models) process.stdout.write(`${model.id}\t${model.name}\n`)
    return
  }
  process.stdout.write([
    `provider: ${report.provider}`,
    `command: ${report.command}`,
    `version: ${report.version ?? 'unknown'}`,
    `compatible: ${String(report.compatible)}`,
    `signed-in: ${String(report.signedIn)} (${report.authStatus})`,
    `sandbox: ${report.sandbox}`,
    `default-model: ${report.defaultModel} (${report.defaultModelAvailable ? 'available' : 'unavailable'})`,
    `catalog-models: ${String(report.models.length)}`,
    ...(report.error === undefined ? [] : [`error: ${report.error}`]),
  ].join('\n') + '\n')
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void run(parseCliArguments(process.argv.slice(2))).catch(error => {
    const code = errorCode(error instanceof Error ? error : new Error(String(error))) ?? 'CURSOR_PROVIDER_ERROR'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  })
}
