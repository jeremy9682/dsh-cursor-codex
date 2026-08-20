#!/usr/bin/env node
import { chmod, copyFile, cp, lstat, mkdir, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCliArgs, requiredArg, resolveDshLlmRoot } from './dsh-upgrade-gate-lib.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptRoot, '..')

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function replaceSymlink(path, target) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await rm(path, { force: true })
  await symlink(target, path)
}

async function packageLinks(nodeModules) {
  const links = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    const path = resolve(nodeModules, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(path)
      continue
    }
    if (!entry.isDirectory() || !entry.name.startsWith('@')) continue
    for (const scoped of await readdir(path, { withFileTypes: true })) {
      if (scoped.isSymbolicLink()) links.push(resolve(path, scoped.name))
    }
  }
  return links
}

async function absolutizeCopiedPackageLinks(sourceModules, destinationModules) {
  for (const sourceLink of await packageLinks(sourceModules)) {
    const relative = sourceLink.slice(sourceModules.length + 1)
    await replaceSymlink(resolve(destinationModules, relative), await realpath(sourceLink))
  }
}

async function copyOptional(source, destination, mode) {
  if (!await pathExists(source)) return false
  await copyFile(source, destination)
  await chmod(destination, mode)
  return true
}

const args = parseCliArgs(process.argv.slice(2))
try {
  const candidateRoot = await realpath(requiredArg(args, 'candidate-root'))
  const sourceHome = await realpath(args.values.get('source-home') ?? resolve(homedir(), '.dsh'))
  const rehearsalHome = resolve(requiredArg(args, 'rehearsal-home'))
  const cursorPluginRoot = await realpath(args.values.get('cursor-plugin-root') ?? packageRoot)
  if (await pathExists(rehearsalHome)) throw new Error(`REHEARSAL_EXISTS: refusing to replace ${rehearsalHome}`)
  await resolveDshLlmRoot(candidateRoot)

  const sourceProfile = resolve(sourceHome, 'profiles/web')
  const rehearsalProfile = resolve(rehearsalHome, 'profiles/web')
  const rehearsalPlugin = resolve(rehearsalHome, 'plugins/dsh-llm-cursor-acp')
  await mkdir(resolve(rehearsalHome, 'profiles'), { recursive: true, mode: 0o700 })
  await cp(sourceProfile, rehearsalProfile, { recursive: true, dereference: false, errorOnExist: true })
  await cp(cursorPluginRoot, rehearsalPlugin, { recursive: true, dereference: false, errorOnExist: true })
  await absolutizeCopiedPackageLinks(resolve(sourceProfile, 'node_modules'), resolve(rehearsalProfile, 'node_modules'))
  await absolutizeCopiedPackageLinks(resolve(cursorPluginRoot, 'node_modules'), resolve(rehearsalPlugin, 'node_modules'))

  await replaceSymlink(
    resolve(rehearsalProfile, 'node_modules/@jeremy9682/dsh-llm-cursor-acp'),
    rehearsalPlugin,
  )
  for (const dependency of ['dsh-llm', 'dsh-settings', 'schemastery']) {
    await replaceSymlink(
      resolve(rehearsalPlugin, `node_modules/@deepseek-ai/${dependency}`),
      resolve(candidateRoot, `node_modules/@deepseek-ai/${dependency}`),
    )
  }

  const settingsFile = resolve(args.values.get('settings-file') ?? resolve(sourceHome, 'settings.yaml'))
  const credentialsFile = args.values.get('credentials-file')
  const copiedSettings = await copyOptional(settingsFile, resolve(rehearsalHome, 'settings.yaml'), 0o600)
  let copiedCredentials = false
  if (credentialsFile !== undefined) {
    if (!await pathExists(resolve(credentialsFile))) throw new Error(`CREDENTIALS_NOT_FOUND: ${resolve(credentialsFile)}`)
    copiedCredentials = await copyOptional(resolve(credentialsFile), resolve(rehearsalHome, '.credentials.yaml'), 0o600)
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    candidateRoot,
    rehearsalHome,
    rehearsalPlugin,
    copiedSettings,
    copiedCredentials,
    start: `DSH_HOME=${rehearsalHome} ${resolve(candidateRoot, 'lib/bin.js')} web --no-open --port 3081`,
  }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
