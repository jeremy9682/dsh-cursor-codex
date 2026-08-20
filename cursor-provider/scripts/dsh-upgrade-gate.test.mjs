import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  PATCHED_RETURN,
  VULNERABLE_RETURN,
  assertCandidateIsIsolated,
  assertResolvedPathIsIsolated,
  compareSemver,
  hashReleaseTree,
  patchAgentLoopMarkerSource,
  resolveDshLlmRoot,
} from './dsh-upgrade-gate-lib.mjs'

const HELPERS = 'function markAgentLoopRequest() {}\nfunction isAgentLoopRequest() {}\n'

test('patches exactly one vulnerable replay-filter return', () => {
  const input = `${HELPERS}\nfunction forAdapter() {\n  ${VULNERABLE_RETURN}\n}\n`
  const result = patchAgentLoopMarkerSource(input)
  assert.equal(result.kind, 'patched')
  assert.match(result.source, /const copied = Object\.isFrozen/)
  assert.match(result.source, /return isAgentLoopRequest\(options\)/)
  assert.ok(!result.source.includes(VULNERABLE_RETURN))
})

test('is idempotent for an already patched bundle', () => {
  const input = `${HELPERS}\n${PATCHED_RETURN}\n`
  assert.deepEqual(patchAgentLoopMarkerSource(input), { kind: 'already-patched', source: input })
})

test('fails closed when the vulnerable source drifts or marker helpers are absent', () => {
  assert.throws(() => patchAgentLoopMarkerSource(HELPERS), /PATCH_DRIFT/)
  assert.throws(() => patchAgentLoopMarkerSource(VULNERABLE_RETURN), /helpers are unavailable/)
  assert.throws(
    () => patchAgentLoopMarkerSource(`${HELPERS}${VULNERABLE_RETURN}\n${VULNERABLE_RETURN}`),
    /found 2/,
  )
})

test('resolves either a DSH root or a direct dsh-llm root', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-gate-'))
  const dsh = resolve(root, 'dsh')
  const llm = resolve(dsh, 'node_modules/@deepseek-ai/dsh-llm')
  await mkdir(llm, { recursive: true })
  await Promise.all([
    writeFile(resolve(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' })),
    writeFile(resolve(llm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm' })),
  ])
  assert.equal(await resolveDshLlmRoot(dsh), await realpath(llm))
  assert.equal(await resolveDshLlmRoot(llm), await realpath(llm))
})

test('refuses to mutate the active root or an overlapping root', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-gate-isolation-'))
  const candidate = resolve(root, 'candidate')
  const separate = resolve(root, 'separate')
  await Promise.all([mkdir(candidate), mkdir(separate)])
  await assert.rejects(assertCandidateIsIsolated(candidate, candidate), /ACTIVE_MUTATION_DENIED/)
  assert.deepEqual(await assertCandidateIsIsolated(candidate, separate), {
    candidate: await realpath(candidate),
    active: await realpath(separate),
  })
})

test('refuses a nested dsh-llm symlink that escapes into the active root', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-gate-nested-isolation-'))
  const candidate = resolve(root, 'candidate')
  const active = resolve(root, 'active')
  const activeLlm = resolve(active, 'node_modules/@deepseek-ai/dsh-llm')
  await Promise.all([
    mkdir(resolve(candidate, 'node_modules/@deepseek-ai'), { recursive: true }),
    mkdir(activeLlm, { recursive: true }),
  ])
  await Promise.all([
    writeFile(resolve(candidate, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' })),
    writeFile(resolve(active, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' })),
    writeFile(resolve(activeLlm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm' })),
  ])
  await symlink(activeLlm, resolve(candidate, 'node_modules/@deepseek-ai/dsh-llm'))
  const roots = await assertCandidateIsIsolated(candidate, active)
  const escaped = await resolveDshLlmRoot(candidate)
  await assert.rejects(
    assertResolvedPathIsIsolated(escaped, roots.candidate, roots.active, 'dsh-llm root'),
    /ACTIVE_MUTATION_DENIED/,
  )
})

test('hashes the full release tree, including modes and symlink targets', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-tree-hash-'))
  await writeFile(resolve(root, 'file.txt'), 'one\n', { mode: 0o600 })
  await symlink('file.txt', resolve(root, 'link'))
  const first = await hashReleaseTree(root)
  assert.equal(await hashReleaseTree(root), first)
  await writeFile(resolve(root, 'file.txt'), 'two\n', { mode: 0o600 })
  assert.notEqual(await hashReleaseTree(root), first)
})

test('rejects every release symlink that resolves outside the candidate tree', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-tree-symlink-escape-'))
  const external = await mkdtemp(resolve(tmpdir(), 'dsh-tree-symlink-external-'))
  await writeFile(resolve(external, 'dependency.js'), 'external\n')
  await symlink(resolve(external, 'dependency.js'), resolve(root, 'dependency.js'))
  await assert.rejects(hashReleaseTree(root), /RELEASE_SYMLINK_ESCAPE/)
})

test('orders stable and prerelease versions without binding to rc.8', () => {
  assert.equal(compareSemver('0.1.0-rc.8', '0.1.0-rc.7'), 1)
  assert.equal(compareSemver('0.1.0', '0.1.0-rc.99'), 1)
  assert.equal(compareSemver('0.2.0-beta.1', '0.1.9'), 1)
  assert.equal(compareSemver('not-semver', '0.1.0'), undefined)
})

test('prepares a rehearsal whose Cursor plugin imports the candidate DSH instance', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-rehearsal-'))
  const sourceHome = resolve(root, 'source-home')
  const sourceProfile = resolve(sourceHome, 'profiles/web')
  const plugin = resolve(root, 'cursor-plugin')
  const activeLlm = resolve(root, 'active-dsh-llm')
  const candidate = resolve(root, 'candidate')
  const candidateModules = resolve(candidate, 'node_modules/@deepseek-ai')
  const rehearsal = resolve(root, 'rehearsal')
  await Promise.all([
    mkdir(resolve(sourceProfile, 'node_modules/@jeremy9682'), { recursive: true }),
    mkdir(resolve(plugin, 'node_modules/@deepseek-ai'), { recursive: true }),
    mkdir(activeLlm, { recursive: true }),
    mkdir(resolve(candidateModules, 'dsh-llm'), { recursive: true }),
    mkdir(resolve(candidateModules, 'dsh-settings'), { recursive: true }),
    mkdir(resolve(candidateModules, 'schemastery'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(resolve(candidate, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' })),
    writeFile(resolve(candidateModules, 'dsh-llm/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm' })),
    writeFile(resolve(plugin, 'package.json'), JSON.stringify({ name: '@jeremy9682/dsh-llm-cursor-acp' })),
    writeFile(resolve(sourceProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' })),
    writeFile(resolve(sourceHome, 'settings.yaml'), 'settings: true\n'),
    writeFile(resolve(sourceHome, '.credentials.yaml'), 'credentialRef: test-only\n'),
  ])
  await Promise.all([
    symlink(plugin, resolve(sourceProfile, 'node_modules/@jeremy9682/dsh-llm-cursor-acp')),
    symlink(activeLlm, resolve(plugin, 'node_modules/@deepseek-ai/dsh-llm')),
  ])

  const script = resolve(import.meta.dirname, 'prepare-dsh-candidate-rehearsal.mjs')
  const result = spawnSync(process.execPath, [
    script,
    '--candidate-root', candidate,
    '--source-home', sourceHome,
    '--rehearsal-home', rehearsal,
    '--cursor-plugin-root', plugin,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const rehearsalPlugin = resolve(rehearsal, 'plugins/dsh-llm-cursor-acp')
  assert.equal(
    await readlink(resolve(rehearsal, 'profiles/web/node_modules/@jeremy9682/dsh-llm-cursor-acp')),
    rehearsalPlugin,
  )
  assert.equal(
    await readlink(resolve(rehearsalPlugin, 'node_modules/@deepseek-ai/dsh-llm')),
    await realpath(resolve(candidateModules, 'dsh-llm')),
  )
  await assert.rejects(access(resolve(rehearsal, '.credentials.yaml')), /ENOENT/)

  const rehearsalWithCredentials = resolve(root, 'rehearsal-with-credentials')
  const withCredentials = spawnSync(process.execPath, [
    script,
    '--candidate-root', candidate,
    '--source-home', sourceHome,
    '--rehearsal-home', rehearsalWithCredentials,
    '--cursor-plugin-root', plugin,
    '--credentials-file', resolve(sourceHome, '.credentials.yaml'),
  ], { encoding: 'utf8' })
  assert.equal(withCredentials.status, 0, withCredentials.stderr)
  assert.equal((await stat(resolve(rehearsalWithCredentials, '.credentials.yaml'))).mode & 0o777, 0o600)
})

test('candidate smoke normalizes localhost and refuses to exercise the active host port', async () => {
  const script = resolve(import.meta.dirname, 'candidate-cursor-smoke.sh')
  const candidate = await mkdtemp(resolve(tmpdir(), 'dsh-candidate-smoke-url-'))
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_CANDIDATE_ROOT: candidate,
      DSH_CANDIDATE_TREE_SHA256: 'test',
      DSH_GATE_MANIFEST: resolve(candidate, 'gate.json'),
      DSH_CURSOR_MODEL: 'cursor-test-model',
      DSH_CANDIDATE_BASE_URL: 'http://localhost:3080',
      DSH_ACTIVE_BASE_URL: 'http://127.0.0.1:3080',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate URL resolves to the active listener/)
})
