#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCandidateIsIsolated,
  assertResolvedPathIsIsolated,
  compareSemver,
  hashReleaseTree,
  parseCliArgs,
  patchAgentLoopMarkerSource,
  readPackage,
  requiredArg,
  resolveDshLlmEntry,
  resolveDshLlmRoot,
  safeReleaseName,
  sha256,
} from './dsh-upgrade-gate-lib.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const probeScript = resolve(scriptRoot, 'probe-dsh-agent-loop-marker.mjs')

function run(command, argv, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { timeoutMs, processGroup = false, maxOutputBytes = 2_000_000, ...spawnOptions } = options
    const child = spawn(command, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: processGroup && process.platform !== 'win32',
      ...spawnOptions,
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timedOut = false
    let killTimer
    const kill = signal => {
      try {
        if (processGroup && process.platform !== 'win32') process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 5_000)
      killTimer.unref()
    }, timeoutMs)
    timeout?.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const collect = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxOutputBytes) {
        kill('SIGTERM')
        reject(new Error(`SUBPROCESS_OUTPUT_LIMIT: ${command} exceeded ${maxOutputBytes} bytes`))
        return target
      }
      return target + chunk
    }
    child.stdout?.on('data', chunk => { stdout = collect(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = collect(stderr, chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (timeout !== undefined) clearTimeout(timeout)
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

async function probe(candidateRoot) {
  const result = await run(process.execPath, [probeScript, '--candidate-root', candidateRoot, '--json'], {
    timeoutMs: 60_000,
    processGroup: true,
  })
  if (result.timedOut) throw new Error('CANDIDATE_PROBE_TIMEOUT: probe exceeded 60000ms')
  let payload
  try {
    payload = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(`PROBE_PROTOCOL_ERROR: probe returned invalid JSON (exit ${result.code})`)
  }
  return { exitCode: result.code, stderr: result.stderr, ...payload }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function stage(args) {
  const candidateRootArg = requiredArg(args, 'candidate-root')
  const activeRootArg = requiredArg(args, 'active-root')
  const stateDir = resolve(args.values.get('state-dir') ?? resolve(homedir(), '.dsh/upgrade-gate'))
  const roots = await assertCandidateIsIsolated(candidateRootArg, activeRootArg)
  const [dshPackage, activePackage] = await Promise.all([
    readPackage(roots.candidate),
    readPackage(roots.active),
  ])
  const versionOrder = compareSemver(String(dshPackage.version ?? ''), String(activePackage.version ?? ''))
  if (!args.flags.has('allow-downgrade')) {
    if (versionOrder !== undefined && versionOrder < 0) {
      throw new Error(`DOWNGRADE_DENIED: candidate ${dshPackage.version} is older than active ${activePackage.version}`)
    }
    if (versionOrder === undefined && dshPackage.version !== activePackage.version) {
      throw new Error(`VERSION_ORDER_UNKNOWN: cannot safely compare candidate ${dshPackage.version} with active ${activePackage.version}`)
    }
  }
  const llmRoot = await assertResolvedPathIsIsolated(
    await resolveDshLlmRoot(roots.candidate),
    roots.candidate,
    roots.active,
    'dsh-llm root',
  )
  const llmPackage = await readPackage(llmRoot)
  const entry = await assertResolvedPathIsIsolated(
    await resolveDshLlmEntry(llmRoot),
    roots.candidate,
    roots.active,
    'dsh-llm entry',
  )
  const entryMode = (await stat(entry)).mode & 0o777
  const before = await readFile(entry, 'utf8')
  const beforeHash = sha256(before)
  const firstProbe = await probe(roots.candidate)
  let patchKind = 'not-needed'
  let afterHash = beforeHash
  let finalProbe = firstProbe

  if (!firstProbe.pass) {
    if (firstProbe.exitCode !== 12) {
      throw new Error(`CANDIDATE_PROBE_ERROR: ${firstProbe.error ?? `exit ${firstProbe.exitCode}`}`)
    }
    if (args.flags.has('no-patch')) throw new Error('CANDIDATE_INCOMPATIBLE: agent-loop marker is not preserved')
    const patched = patchAgentLoopMarkerSource(before)
    patchKind = patched.kind
    if (patched.kind === 'patched') {
      const backupDir = resolve(stateDir, 'backups', beforeHash)
      await mkdir(backupDir, { recursive: true, mode: 0o700 })
      await writeFile(resolve(backupDir, 'dsh-llm-entry.before.js'), before, { mode: 0o600 })
      const temporary = `${entry}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, patched.source, { mode: entryMode })
      await rename(temporary, entry)
      afterHash = sha256(patched.source)
    }
    finalProbe = await probe(roots.candidate)
    if (!finalProbe.pass) {
      throw new Error(`CANDIDATE_STILL_INCOMPATIBLE: ${finalProbe.error ?? 'agent-loop marker was not preserved after patch'}`)
    }
  }

  const releaseTreeSha256 = await hashReleaseTree(roots.candidate)

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: 'ready-for-cursor-smoke',
    candidateRoot: roots.candidate,
    activeRootAtValidation: roots.active,
    dshVersion: String(dshPackage.version ?? 'unknown'),
    activeDshVersionAtValidation: String(activePackage.version ?? 'unknown'),
    dshLlmVersion: String(llmPackage.version ?? 'unknown'),
    patchKind,
    entrySha256Before: beforeHash,
    entrySha256After: afterHash,
    releaseTreeSha256,
    probeBefore: firstProbe,
    probeAfter: finalProbe,
  }
  const releaseName = safeReleaseName('dsh', manifest.dshVersion, afterHash)
  const manifestPath = resolve(stateDir, 'candidates', releaseName, 'gate.json')
  await writeJsonAtomic(manifestPath, manifest)
  return { ...manifest, manifestPath }
}

async function prepare(args) {
  const activeRoot = requiredArg(args, 'active-root')
  const spec = requiredArg(args, 'spec')
  const stateDir = resolve(args.values.get('state-dir') ?? resolve(homedir(), '.dsh/upgrade-gate'))
  const releaseDir = resolve(args.values.get('release-dir') ?? resolve(homedir(), `.dsh/releases/${new Date().toISOString().replace(/[:.]/g, '-')}`))
  const installTimeoutMs = Number(args.values.get('install-timeout-ms') ?? 900_000)
  if (!Number.isSafeInteger(installTimeoutMs) || installTimeoutMs < 1_000) {
    throw new Error('--install-timeout-ms must be an integer of at least 1000')
  }
  await mkdir(dirname(releaseDir), { recursive: true, mode: 0o700 })
  await mkdir(releaseDir, { recursive: false, mode: 0o700 })
  const installEnv = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .filter(name => process.env[name] !== undefined)
      .map(name => [name, process.env[name]]),
  )
  installEnv.CI = 'true'
  installEnv.npm_config_audit = 'false'
  installEnv.npm_config_fund = 'false'
  const installArgs = ['install', '--prefix', releaseDir, '--no-save', '--no-audit', '--no-fund']
  if (!args.flags.has('allow-install-scripts')) installArgs.push('--ignore-scripts')
  installArgs.push(spec)
  const installed = await run(args.values.get('npm') ?? 'npm', installArgs, {
    env: installEnv,
    timeoutMs: installTimeoutMs,
    processGroup: true,
  })
  if (installed.code !== 0) {
    const reason = installed.timedOut ? `timed out after ${installTimeoutMs}ms` : `npm exited ${installed.code}`
    throw new Error(`CANDIDATE_INSTALL_FAILED: ${reason}: ${installed.stderr.trim()}`)
  }
  const candidateRoot = resolve(releaseDir, 'node_modules/@deepseek-ai/dsh')
  const stageArgs = {
    values: new Map([
      ['candidate-root', candidateRoot],
      ['active-root', activeRoot],
      ['state-dir', stateDir],
    ]),
    flags: args.flags,
    positionals: [],
  }
  return {
    releaseDir,
    installScriptsEnabled: args.flags.has('allow-install-scripts'),
    ...(await stage(stageArgs)),
  }
}

async function withActivationLock(activeLink, callback) {
  const lockPath = `${activeLink}.upgrade-gate.lock`
  await mkdir(dirname(activeLink), { recursive: true, mode: 0o700 })
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`ACTIVATION_LOCKED: ${lockPath}`)
    throw error
  }
  try {
    await writeFile(resolve(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 })
    return await callback()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function replaceLink(activeLink, target, expectedCurrent) {
  if (await realpath(activeLink) !== expectedCurrent) {
    throw new Error('ACTIVE_LINK_CHANGED: expected-current guard rejected the link update')
  }
  const temporary = `${activeLink}.${process.pid}.${randomUUID()}.tmp`
  await symlink(target, temporary)
  try {
    if (await realpath(activeLink) !== expectedCurrent) {
      throw new Error('ACTIVE_LINK_CHANGED: expected-current guard rejected the link update')
    }
    await rename(temporary, activeLink)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function promote(args) {
  const candidateRoot = await realpath(requiredArg(args, 'candidate-root'))
  const activeLink = resolve(requiredArg(args, 'active-link'))
  const manifestPath = resolve(requiredArg(args, 'manifest'))
  const smokeScript = resolve(requiredArg(args, 'smoke-script'))
  const smokeTimeoutMs = Number(args.values.get('smoke-timeout-ms') ?? 360_000)
  if (!Number.isSafeInteger(smokeTimeoutMs) || smokeTimeoutMs < 10_000) {
    throw new Error('--smoke-timeout-ms must be an integer of at least 10000')
  }

  return withActivationLock(activeLink, async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.status !== 'ready-for-cursor-smoke' || await realpath(manifest.candidateRoot) !== candidateRoot) {
      throw new Error('PROMOTION_DENIED: manifest does not validate this candidate')
    }
    const expectedActive = await realpath(manifest.activeRootAtValidation)
    const llmRoot = await assertResolvedPathIsIsolated(
      await resolveDshLlmRoot(candidateRoot),
      candidateRoot,
      expectedActive,
      'dsh-llm root',
    )
    const llmEntry = await assertResolvedPathIsIsolated(
      await resolveDshLlmEntry(llmRoot),
      candidateRoot,
      expectedActive,
      'dsh-llm entry',
    )
    const entryHash = sha256(await readFile(llmEntry))
    if (entryHash !== manifest.entrySha256After) throw new Error('PROMOTION_DENIED: dsh-llm entry changed after validation')
    const treeHashBeforeSmoke = await hashReleaseTree(candidateRoot)
    if (treeHashBeforeSmoke !== manifest.releaseTreeSha256) {
      throw new Error('PROMOTION_DENIED: candidate release tree changed after validation')
    }
    let previousTarget
    try {
      previousTarget = await realpath(activeLink)
    } catch {
      throw new Error('PROMOTION_DENIED: active link is missing; bootstrap it to the validated active root first')
    }
    if (previousTarget !== expectedActive) {
      throw new Error('PROMOTION_DENIED: active link changed after candidate validation')
    }
    const smoke = await run(smokeScript, [], {
      env: {
        ...process.env,
        DSH_CANDIDATE_ROOT: candidateRoot,
        DSH_CANDIDATE_TREE_SHA256: manifest.releaseTreeSha256,
        DSH_GATE_MANIFEST: manifestPath,
      },
      timeoutMs: smokeTimeoutMs,
      processGroup: true,
    })
    if (smoke.timedOut) throw new Error(`CURSOR_SMOKE_TIMEOUT: exceeded ${smokeTimeoutMs}ms`)
    if (smoke.code !== 0) {
      throw new Error(`CURSOR_SMOKE_FAILED: ${smoke.stderr.trim() || smoke.stdout.trim() || `exit ${smoke.code}`}`)
    }
    let receipt
    try {
      receipt = JSON.parse(smoke.stdout.trim())
    } catch {
      throw new Error('CURSOR_SMOKE_PROTOCOL_ERROR: smoke must print exactly one JSON receipt')
    }
    if (
      receipt.schemaVersion !== 1
      || receipt.pass !== true
      || await realpath(receipt.candidateRoot) !== candidateRoot
      || receipt.releaseTreeSha256 !== manifest.releaseTreeSha256
      || receipt.live?.pass !== true
      || !Number.isSafeInteger(receipt.listener?.pid)
    ) {
      throw new Error('CURSOR_SMOKE_PROTOCOL_ERROR: smoke receipt does not attest this candidate')
    }
    const treeHashAfterSmoke = await hashReleaseTree(candidateRoot)
    if (treeHashAfterSmoke !== manifest.releaseTreeSha256) {
      throw new Error('PROMOTION_DENIED: candidate release tree changed while smoke was running')
    }
    if (await realpath(activeLink) !== expectedActive) {
      throw new Error('PROMOTION_DENIED: active link changed while the Cursor smoke was running')
    }

    const recordPath = resolve(dirname(manifestPath), 'promotion.json')
    const promotion = {
      schemaVersion: 1,
      status: 'switch-pending',
      preparedAt: new Date().toISOString(),
      activeLink,
      candidateRoot,
      previousTarget,
      manifestPath,
      smokeReceipt: receipt,
      restartRequired: true,
    }
    await writeJsonAtomic(recordPath, promotion)
    await replaceLink(activeLink, candidateRoot, expectedActive)
    const promoted = { ...promotion, status: 'promoted', promotedAt: new Date().toISOString() }
    try {
      await writeJsonAtomic(recordPath, promoted)
    } catch (error) {
      await replaceLink(activeLink, previousTarget, candidateRoot)
      throw new Error(`PROMOTION_RECORD_FAILED_AND_LINK_ROLLED_BACK: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { ...promoted, recordPath }
  })
}

async function rollback(args) {
  const activeLink = resolve(requiredArg(args, 'active-link'))
  const target = await realpath(requiredArg(args, 'target'))
  const expectedCurrent = await realpath(requiredArg(args, 'expected-current'))
  return withActivationLock(activeLink, async () => {
    const targetPackage = await readPackage(target)
    if (targetPackage.name !== '@deepseek-ai/dsh') throw new Error('ROLLBACK_DENIED: target is not a DSH root')
    if (await realpath(activeLink) !== expectedCurrent) {
      throw new Error('ROLLBACK_DENIED: active link no longer points to the expected failed candidate')
    }
    await replaceLink(activeLink, target, expectedCurrent)
    return { schemaVersion: 1, activeLink, expectedCurrent, target, restartRequired: true }
  })
}

function usage() {
  return [
    'usage:',
    '  dsh-cursor-upgrade-gate probe --candidate-root PATH',
    '  dsh-cursor-upgrade-gate stage --candidate-root PATH --active-root PATH [--state-dir PATH] [--no-patch]',
    '  dsh-cursor-upgrade-gate prepare --active-root PATH --spec PACKAGE [--release-dir PATH] [--state-dir PATH] [--install-timeout-ms N] [--allow-install-scripts]',
    '  dsh-cursor-upgrade-gate promote --candidate-root PATH --active-link PATH --manifest PATH --smoke-script PATH [--smoke-timeout-ms N]',
    '  dsh-cursor-upgrade-gate rollback --active-link PATH --expected-current PATH --target PATH',
  ].join('\n')
}

const args = parseCliArgs(process.argv.slice(2))
const command = args.positionals[0]
try {
  let result
  if (command === 'probe') result = await probe(requiredArg(args, 'candidate-root'))
  else if (command === 'stage') result = await stage(args)
  else if (command === 'prepare') result = await prepare(args)
  else if (command === 'promote') result = await promote(args)
  else if (command === 'rollback') result = await rollback(args)
  else throw new Error(usage())
  process.stdout.write(`${JSON.stringify(result, null, args.flags.has('json') ? 2 : 0)}\n`)
  if (command === 'probe' && !result.pass) process.exitCode = result.exitCode || 12
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
