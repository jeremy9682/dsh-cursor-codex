#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { runCursorGenericRuntime, type CursorRuntimeOptions } from './cursor-runtime.js'
import type { GenericRunStart } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function parseRuntimeArguments(argv: readonly string[]): CursorRuntimeOptions {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === undefined || !key.startsWith('--') || value === undefined) throw new Error(`invalid runtime argument ${String(key)}`)
    const existing = values.get(key) ?? []
    existing.push(value)
    values.set(key, existing)
    index += 1
  }
  const one = (name: string): string | undefined => values.get(name)?.at(-1)
  const cursorCommand = one('--cursor-command')
  const wireModel = one('--wire-model')
  if (cursorCommand === undefined || wireModel === undefined) throw new Error('--cursor-command and --wire-model are required')
  const headers: Record<string, string> = {}
  for (const header of values.get('--header') ?? []) {
    const separator = header.indexOf(':')
    if (separator <= 0) throw new Error('runtime --header must use name:value')
    headers[header.slice(0, separator).trim().toLowerCase()] = header.slice(separator + 1).trim()
  }
  return {
    cursorCommand,
    wireModel,
    headers,
    maxMcpBodyBytes: positiveInteger(one('--max-mcp-body-bytes') ?? '1048576', '--max-mcp-body-bytes'),
    maxProtocolLineBytes: positiveInteger(one('--max-protocol-line-bytes') ?? '4194304', '--max-protocol-line-bytes'),
    promptTimeoutMs: positiveInteger(one('--prompt-timeout-ms') ?? '300000', '--prompt-timeout-ms'),
    graceMs: positiveInteger(one('--grace-ms') ?? '5000', '--grace-ms'),
    ...(one('--host-home') === undefined ? {} : { hostHome: one('--host-home')! }),
    requireSandbox: one('--require-sandbox') !== 'false',
  }
}

function parseRunStart(line: string): GenericRunStart {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.type !== 'run.start' || typeof value.runId !== 'string' || typeof value.task !== 'string'
    || (value.instructions !== undefined && typeof value.instructions !== 'string') || !Array.isArray(value.capabilities)) {
    throw new Error('first generic runtime input must be run.start')
  }
  return value as unknown as GenericRunStart
}

async function main(): Promise<void> {
  const options = parseRuntimeArguments(process.argv.slice(2))
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  let first: IteratorResult<string>
  do {
    first = await iterator.next()
    if (first.done) throw new Error('generic runtime input closed before run.start')
  } while (first.value.trim().length === 0)
  const start = parseRunStart(first.value)
  const remaining = new PassThrough()
  const forward = (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) remaining.write(`${line}\n`)
    remaining.end()
  })()
  await runCursorGenericRuntime(start, options, { input: remaining, output: process.stdout })
  lines.close()
  await forward
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`${JSON.stringify({ type: 'result', status: 'failed', output: '', error: message })}\n`)
    process.exitCode = 1
  })
}
