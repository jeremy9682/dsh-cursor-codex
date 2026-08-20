#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashReleaseTree } from './dsh-upgrade-gate-lib.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const candidateRoot = await realpath(process.env.DSH_CANDIDATE_ROOT ?? '')
const manifestPath = resolve(process.env.DSH_GATE_MANIFEST ?? '')
const expectedTreeHash = process.env.DSH_CANDIDATE_TREE_SHA256 ?? ''
const cursorModel = process.env.DSH_CURSOR_MODEL ?? ''
const candidateUrl = new URL(process.env.DSH_CANDIDATE_BASE_URL ?? '')
const activeUrl = new URL(process.env.DSH_ACTIVE_BASE_URL ?? 'http://127.0.0.1:3080')
if (cursorModel.length === 0) throw new Error('CANDIDATE_SMOKE_DENIED: set DSH_CURSOR_MODEL from the candidate catalog')

function normalizedLocalUrl(url) {
  if (url.protocol !== 'http:') throw new Error('CANDIDATE_SMOKE_DENIED: candidate URL must use local HTTP')
  const host = url.hostname.toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('CANDIDATE_SMOKE_DENIED: candidate URL must be loopback-only')
  }
  const port = url.port || '80'
  return `http://loopback:${port}`
}

if (normalizedLocalUrl(candidateUrl) === normalizedLocalUrl(activeUrl)) {
  throw new Error('CANDIDATE_SMOKE_DENIED: candidate URL resolves to the active listener')
}

function run(command, argv, timeoutMs = 60_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)
    timeout.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timeout)
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

function parseElapsed(value) {
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{2}):(\d{2})$/.exec(value.trim())
  if (match === null) throw new Error(`CANDIDATE_SMOKE_DENIED: could not parse listener elapsed time ${value.trim()}`)
  return ((((Number(match[1] ?? 0) * 24) + Number(match[2] ?? 0)) * 60 + Number(match[3])) * 60) + Number(match[4])
}

const port = candidateUrl.port || '80'
const lsof = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 10_000)
if (lsof.code !== 0) throw new Error(`CANDIDATE_SMOKE_DENIED: no candidate listener on port ${port}`)
const listenerPids = [...new Set(lsof.stdout.trim().split(/\s+/).filter(Boolean).map(Number))]
if (listenerPids.length !== 1 || !Number.isSafeInteger(listenerPids[0])) {
  throw new Error(`CANDIDATE_SMOKE_DENIED: expected exactly one listener on port ${port}`)
}
const listenerPid = listenerPids[0]
const [commandResult, elapsedResult] = await Promise.all([
  run('ps', ['-p', String(listenerPid), '-o', 'command='], 10_000),
  run('ps', ['-p', String(listenerPid), '-o', 'etime='], 10_000),
])
if (commandResult.code !== 0 || elapsedResult.code !== 0) throw new Error('CANDIDATE_SMOKE_DENIED: listener process disappeared')
const candidateEntrypoint = resolve(candidateRoot, 'lib/bin.js')
if (!commandResult.stdout.includes(candidateEntrypoint)) {
  throw new Error('CANDIDATE_SMOKE_DENIED: listener command is not running the candidate DSH entrypoint')
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (await realpath(manifest.candidateRoot) !== candidateRoot || manifest.releaseTreeSha256 !== expectedTreeHash) {
  throw new Error('CANDIDATE_SMOKE_DENIED: manifest does not match the requested candidate')
}
const elapsedSeconds = parseElapsed(elapsedResult.stdout)
const listenerStartedAtMs = Date.now() - elapsedSeconds * 1_000
const manifestCreatedAtMs = Date.parse(manifest.createdAt)
if (!Number.isFinite(manifestCreatedAtMs) || listenerStartedAtMs + 2_000 < manifestCreatedAtMs) {
  throw new Error('CANDIDATE_SMOKE_DENIED: candidate listener predates its gate manifest; restart the disposable host')
}
if (await hashReleaseTree(candidateRoot) !== expectedTreeHash) {
  throw new Error('CANDIDATE_SMOKE_DENIED: candidate release tree changed before runtime smoke')
}

const probe = await run(process.execPath, [
  resolve(scriptRoot, 'probe-dsh-agent-loop-marker.mjs'),
  '--candidate-root', candidateRoot,
  '--json',
], 60_000)
if (probe.timedOut || probe.code !== 0) throw new Error(`CANDIDATE_PROBE_FAILED: ${probe.stderr.trim() || probe.stdout.trim()}`)
const probeReceipt = JSON.parse(probe.stdout.trim())
if (probeReceipt.pass !== true) throw new Error('CANDIDATE_PROBE_FAILED: marker/replay contract did not pass')

const version = await run(resolve(candidateRoot, 'lib/bin.js'), ['--version'], 30_000)
if (version.timedOut || version.code !== 0) throw new Error(`CANDIDATE_VERSION_FAILED: ${version.stderr.trim()}`)

const live = await run(process.execPath, [
  resolve(scriptRoot, 'live-dsh-cursor-smoke.mjs'),
  '--base-url', candidateUrl.toString(),
  '--cursor-model', cursorModel,
], 240_000)
if (live.timedOut || live.code !== 0) throw new Error(`CANDIDATE_LIVE_SMOKE_FAILED: ${live.stderr.trim() || live.stdout.trim()}`)
const liveReceipt = JSON.parse(live.stdout.trim())
if (liveReceipt.pass !== true) throw new Error('CANDIDATE_LIVE_SMOKE_FAILED: live receipt was not green')

if (await hashReleaseTree(candidateRoot) !== expectedTreeHash) {
  throw new Error('CANDIDATE_SMOKE_DENIED: candidate release tree changed during runtime smoke')
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  pass: true,
  candidateRoot,
  releaseTreeSha256: expectedTreeHash,
  dshVersion: String(manifest.dshVersion),
  versionOutput: version.stdout.trim(),
  listener: {
    pid: listenerPid,
    command: commandResult.stdout.trim(),
    elapsedSeconds,
    candidateEntrypoint,
  },
  probe: probeReceipt,
  live: liveReceipt,
})}\n`)
