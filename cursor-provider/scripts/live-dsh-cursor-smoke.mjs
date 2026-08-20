#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseCliArgs } from './dsh-upgrade-gate-lib.mjs'

const args = parseCliArgs(process.argv.slice(2))
const baseUrl = new URL(args.values.get('base-url') ?? 'http://127.0.0.1:3080')
const firstProvider = args.values.get('first-provider') ?? 'zcode'
const firstModel = args.values.get('first-model') ?? 'glm-5.3'
const cursorModel = args.values.get('cursor-model') ?? process.env.DSH_CURSOR_MODEL
if (cursorModel === undefined || cursorModel.length === 0) {
  throw new Error('set DSH_CURSOR_MODEL or pass --cursor-model with a model from the live Cursor catalog')
}
const timeoutMs = Number(args.values.get('timeout-ms') ?? 180_000)
const rpcTimeoutMs = Number(args.values.get('rpc-timeout-ms') ?? 30_000)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000) throw new Error('--timeout-ms must be an integer of at least 10000')
if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1_000) throw new Error('--rpc-timeout-ms must be an integer of at least 1000')

const sessionId = `session-cursor-upgrade-smoke-${Date.now()}`
const deadline = Date.now() + timeoutMs
const forbiddenDiagnostics = [
  'INVALID_REPLAY_STATE',
  'invalid pi-ai replay state',
  'POLICY_DENIED',
  'Cursor attempted built-in tool',
  'CURSOR_TIMEOUT',
  'raw output than the subprocess seam retained',
]

function remainingTimeout() {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`smoke exceeded ${timeoutMs}ms`)
  return Math.min(rpcTimeoutMs, remaining)
}

async function rpc(method, payload) {
  const rpcId = `cursor-upgrade-smoke-${randomUUID()}`
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl.origin },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(remainingTimeout()),
  })
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId) throw new Error(`${method} returned a mismatched rpcId`)
  if (envelope.result?.ok !== true) {
    throw new Error(`${method} failed: ${envelope.result?.error?.code ?? 'unknown'}: ${envelope.result?.error?.message ?? 'unknown error'}`)
  }
  return envelope.result.value
}

async function history() {
  return rpc('session.history', { sessionId, maxMessages: 100 })
}

async function waitForTurnEnd(expectedTurn) {
  while (Date.now() < deadline) {
    const snapshot = await history()
    if (snapshot.events.some(entry => entry.event.type === 'turn/end' && entry.event.data?.turn === expectedTurn)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  throw new Error(`timed out waiting for turn ${expectedTurn}`)
}

function assistantText(snapshot, provider, turn) {
  return snapshot.events
    .filter(entry => (
      entry.event.type === 'assistant/message'
      && entry.event.data?.turn === turn
      && entry.event.data?.message?.source?.provider === provider
    ))
    .flatMap(entry => entry.event.data.message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function toolResultText(entry) {
  return (entry.event.data?.message?.content ?? [])
    .filter(block => block.type === 'tool-result')
    .flatMap(block => block.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'dsh-cursor-upgrade-smoke-'))
const nonce = `DSH_CURSOR_SMOKE_${randomUUID().replaceAll('-', '')}`
const expectedOutput = `fixture.txt:2:${nonce}`
try {
  await writeFile(resolve(fixtureRoot, 'fixture.txt'), `ignore\n${nonce}\n`, { mode: 0o600 })
  await rpc('session.create', { sessionId, cwd: fixtureRoot, agentPreset: 'code' })
  await rpc('session.selectModel', { sessionId, provider: firstProvider, model: firstModel, reasoningEffort: 'high' })
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'Reply with exactly FIRST_PROVIDER_OK. Do not call tools.' }],
  })
  const firstHistory = await waitForTurnEnd(1)
  const firstText = assistantText(firstHistory, firstProvider, 1)
  if (firstText.trim() !== 'FIRST_PROVIDER_OK') throw new Error(`first provider smoke returned unexpected text: ${firstText}`)
  if (firstHistory.events.some(entry => entry.event.type === 'tool/call' && entry.event.data?.turn === 1)) {
    throw new Error('first provider unexpectedly called a tool')
  }

  await rpc('session.selectModel', { sessionId, provider: 'cursor-acp', model: cursorModel })
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{
      type: 'text',
      text: `Use only the scheduler-backed DSH bash tool to run exactly: rg -n --with-filename '${nonce}' fixture.txt. Then reply with exactly the command output and nothing else.`,
    }],
  })
  const finalHistory = await waitForTurnEnd(2)
  const cursorText = assistantText(finalHistory, 'cursor-acp', 2)
  const serialized = JSON.stringify(finalHistory.events)
  const diagnostics = forbiddenDiagnostics.filter(diagnostic => serialized.toLowerCase().includes(diagnostic.toLowerCase()))
  const cursorCalls = finalHistory.events.filter(entry => entry.event.type === 'tool/call' && entry.event.data?.turn === 2)
  if (cursorCalls.length !== 1) throw new Error(`expected exactly one Cursor tool call, received ${cursorCalls.length}`)
  const call = cursorCalls[0].event.data
  if (call.name !== 'run_code') throw new Error(`expected Cursor run_code tool, received ${call.name}`)
  let callArguments
  try {
    callArguments = JSON.parse(call.arguments)
  } catch {
    throw new Error('Cursor tool arguments were not valid JSON')
  }
  const code = String(callArguments.code ?? '')
  if (!code.includes('tools.bash') || !code.includes(nonce) || !code.includes('fixture.txt')) {
    throw new Error('Cursor tool call did not use scheduler-backed DSH bash with the nonce fixture')
  }
  const cursorResults = finalHistory.events.filter(entry => (
    entry.event.type === 'tool/result'
    && entry.event.data?.turn === 2
    && entry.event.data?.message?.source?.callId === call.callId
  ))
  if (cursorResults.length !== 1) throw new Error(`expected one correlated tool result, received ${cursorResults.length}`)
  const resultBlocks = cursorResults[0].event.data?.message?.content ?? []
  if (resultBlocks.some(block => block.type === 'tool-result' && block.isError === true)) {
    throw new Error('scheduler-backed DSH bash returned an error')
  }
  const resultText = toolResultText(cursorResults[0])
  const pass = resultText.includes(expectedOutput) && cursorText.trim() === expectedOutput && diagnostics.length === 0
  const result = {
    schemaVersion: 1,
    pass,
    sessionId,
    firstRoute: `${firstProvider}/${firstModel}`,
    cursorRoute: `cursor-acp/${cursorModel}`,
    expectedOutput,
    cursorText: cursorText.trim(),
    toolCall: { callId: call.callId, name: call.name },
    toolResultMatched: resultText.includes(expectedOutput),
    diagnostics,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!pass) process.exitCode = 1
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}
