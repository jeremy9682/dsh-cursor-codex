import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

export const VULNERABLE_RETURN = 'return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;'
export const PATCHED_RETURN = [
  'const copied = Object.isFrozen(options) ? deepFreeze(filtered) : filtered;',
  'return isAgentLoopRequest(options) ? markAgentLoopRequest(copied) : copied;',
].join('\n')

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function isPathWithin(root, path) {
  const remainder = relative(root, path)
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !remainder.startsWith(sep))
}

export async function assertResolvedPathIsIsolated(path, candidateRoot, activeRoot, label) {
  const [resolvedPath, candidate, active] = await Promise.all([
    realpath(path),
    realpath(candidateRoot),
    realpath(activeRoot),
  ])
  if (!isPathWithin(candidate, resolvedPath) || isPathWithin(active, resolvedPath)) {
    throw new Error(`ACTIVE_MUTATION_DENIED: resolved ${label} escapes the candidate root`)
  }
  return resolvedPath
}

async function hashFile(path, hash) {
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
}

export async function hashReleaseTree(root) {
  const releaseRoot = await realpath(root)
  const hash = createHash('sha256')

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const metadata = await lstat(path)
      const mode = metadata.mode & 0o7777
      if (entry.isSymbolicLink()) {
        let resolvedTarget
        try {
          resolvedTarget = await realpath(path)
        } catch {
          throw new Error(`RELEASE_SYMLINK_INVALID: ${relativePath}`)
        }
        if (!isPathWithin(releaseRoot, resolvedTarget)) {
          throw new Error(`RELEASE_SYMLINK_ESCAPE: ${relativePath}`)
        }
        hash.update(`L\0${relativePath}\0${mode.toString(8)}\0${await readlink(path)}\0`)
      } else if (entry.isDirectory()) {
        hash.update(`D\0${relativePath}\0${mode.toString(8)}\0`)
        await visit(path, relativePath)
      } else if (entry.isFile()) {
        hash.update(`F\0${relativePath}\0${mode.toString(8)}\0${metadata.size}\0`)
        await hashFile(path, hash)
        hash.update('\0')
      } else {
        throw new Error(`UNSUPPORTED_RELEASE_ENTRY: ${relativePath}`)
      }
    }
  }

  await visit(releaseRoot)
  return hash.digest('hex')
}

export async function readPackage(root) {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
}

export async function resolveDshLlmRoot(candidateRoot) {
  const root = await realpath(candidateRoot)
  const candidatePackage = await readPackage(root)
  if (candidatePackage.name === '@deepseek-ai/dsh-llm') return root
  if (candidatePackage.name !== '@deepseek-ai/dsh') {
    throw new Error(`expected @deepseek-ai/dsh or @deepseek-ai/dsh-llm at ${root}`)
  }
  const nested = resolve(root, 'node_modules/@deepseek-ai/dsh-llm')
  const nestedPackage = await readPackage(nested)
  if (nestedPackage.name !== '@deepseek-ai/dsh-llm') {
    throw new Error(`expected @deepseek-ai/dsh-llm below ${root}`)
  }
  return realpath(nested)
}

function exportedEntry(packageJson) {
  const rootExport = packageJson.exports?.['.']
  if (typeof rootExport === 'string') return rootExport
  if (typeof rootExport?.default === 'string') return rootExport.default
  if (typeof rootExport?.import === 'string') return rootExport.import
  if (typeof packageJson.module === 'string') return packageJson.module
  if (typeof packageJson.main === 'string') return packageJson.main
  throw new Error('@deepseek-ai/dsh-llm has no resolvable JavaScript entry')
}

export async function resolveDshLlmEntry(llmRoot) {
  const packageJson = await readPackage(llmRoot)
  return resolve(llmRoot, exportedEntry(packageJson))
}

export function patchAgentLoopMarkerSource(source) {
  if (source.includes(PATCHED_RETURN)) {
    return { kind: 'already-patched', source }
  }

  const occurrences = source.split(VULNERABLE_RETURN).length - 1
  if (occurrences !== 1) {
    throw new Error(
      occurrences === 0
        ? 'PATCH_DRIFT: vulnerable replay-filter return was not found'
        : `PATCH_DRIFT: found ${occurrences} vulnerable replay-filter returns`,
    )
  }
  if (!source.includes('function isAgentLoopRequest(') || !source.includes('function markAgentLoopRequest(')) {
    throw new Error('PATCH_DRIFT: agent-loop marker helpers are unavailable')
  }

  const indentMatch = source.match(/(^[\t ]*)return Object\.isFrozen\(options\) \? deepFreeze\(filtered\) : filtered;/m)
  if (indentMatch === null) throw new Error('PATCH_DRIFT: replay-filter indentation could not be determined')
  const indent = indentMatch[1]
  const replacement = PATCHED_RETURN.split('\n').map(line => `${indent}${line}`).join('\n')
  return {
    kind: 'patched',
    source: source.replace(`${indent}${VULNERABLE_RETURN}`, replacement),
  }
}

export function parseCliArgs(argv) {
  const values = new Map()
  const flags = new Set()
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    if (
      value === '--json'
      || value === '--no-patch'
      || value === '--allow-downgrade'
      || value === '--allow-install-scripts'
    ) {
      flags.add(value.slice(2))
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${value}`)
    values.set(value.slice(2), next)
    index += 1
  }
  return { values, flags, positionals }
}

export function compareSemver(left, right) {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  const a = pattern.exec(left)
  const b = pattern.exec(right)
  if (a === null || b === null) return undefined
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return Math.sign(difference)
  }
  const aPre = a[4]
  const bPre = b[4]
  if (aPre === undefined || bPre === undefined) return aPre === bPre ? 0 : aPre === undefined ? 1 : -1
  const aParts = aPre.split('.')
  const bParts = bPre.split('.')
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = aParts[index]
    const bPart = bParts[index]
    if (aPart === undefined || bPart === undefined) return aPart === bPart ? 0 : aPart === undefined ? -1 : 1
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/.test(aPart)
    const bNumeric = /^\d+$/.test(bPart)
    if (aNumeric && bNumeric) return Math.sign(Number(aPart) - Number(bPart))
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart < bPart ? -1 : 1
  }
  return 0
}

export function requiredArg(args, name) {
  const value = args.values.get(name)
  if (value === undefined || value.length === 0) throw new Error(`missing --${name}`)
  return value
}

export function safeReleaseName(spec, version, digest) {
  return `${spec.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${version.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${digest.slice(0, 12)}`
}

export async function assertCandidateIsIsolated(candidateRoot, activeRoot) {
  const [candidate, active] = await Promise.all([realpath(candidateRoot), realpath(activeRoot)])
  if (candidate === active) throw new Error('ACTIVE_MUTATION_DENIED: candidate root is the active DSH root')
  const candidateParent = `${candidate}/`
  const activeParent = `${active}/`
  if (candidate.startsWith(activeParent) || active.startsWith(candidateParent)) {
    throw new Error('ACTIVE_MUTATION_DENIED: candidate and active DSH roots overlap')
  }
  return { candidate, active }
}

export function dirnameFor(path) {
  return dirname(path)
}
