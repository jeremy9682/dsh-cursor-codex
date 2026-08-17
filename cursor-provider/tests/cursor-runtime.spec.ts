import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { buildCursorAcpArguments, configureCursorSession, cursorSeatbeltProfile, cursorSessionMode, expectedMcpPermission, isCursorLaunchVerified, isCursorVersionVerified, resolveCursorLaunch } from '../src/cursor-runtime.js'
import { CLI_ATTRIBUTION_HEADERS } from '../src/cli.js'
import { parseRuntimeArguments } from '../src/runtime-bin.js'
import { encodeCursorControl, parseCursorControl } from '../src/control-event.js'

const cursor = '/opt/cursor-agent'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Cursor ACP runtime boundary', () => {
  it('uses agent mode only when the DSH Agent Loop exposes scheduler tools', () => {
    expect(cursorSessionMode(0)).toBe('ask')
    expect(cursorSessionMode(1)).toBe('agent')
    expect(cursorSessionMode(12)).toBe('agent')
  })

  it('configures the ACP session mode before selecting the Cursor model', async () => {
    const calls: unknown[] = []
    const connection = {
      async setSessionMode(value: unknown) { calls.push(['mode', value]) },
      async setSessionConfigOption(value: unknown) { calls.push(['model', value]) },
    }
    await configureCursorSession(connection, 'session-1', 4, 'grok-4.6[effort=high]')
    expect(calls).toEqual([
      ['mode', { sessionId: 'session-1', modeId: 'agent' }],
      ['model', { sessionId: 'session-1', configId: 'model', value: 'grok-4.6[effort=high]' }],
    ])
  })

  it('injects mandatory DSH attribution with Cursor supported headers', () => {
    const headers = attributionHeaders()
    expect(CLI_ATTRIBUTION_HEADERS).toEqual(headers)
    const args = buildCursorAcpArguments('/cursor/index.js', headers)
    expect(args).toContain('--header')
    expect(args).toContain(`user-agent: ${headers['user-agent']}`)
    expect(args.slice(-3)).toEqual(['--sandbox', 'enabled', 'acp'])
  })

  it('resolves an official Cursor launcher and extracts its verified version without a shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursor-launch-test-'))
    roots.push(root)
    const install = join(root, 'versions', '2026.08.11-e8db854')
    await mkdir(install, { recursive: true })
    await Promise.all([
      writeFile(join(install, 'cursor-agent'), '#!/usr/bin/env bash\nSCRIPT_DIR/index.js\n'),
      writeFile(join(install, 'node'), ''),
      writeFile(join(install, 'index.js'), ''),
    ])
    const launch = await resolveCursorLaunch(join(install, 'cursor-agent'), attributionHeaders())
    expect(launch.command).toMatch(/\/versions\/2026\.08\.11-e8db854\/node$/u)
    expect(launch.args).toContain('acp')
    expect(launch.args).toContain('--use-system-ca')
    expect(launch.version).toBe('2026.08.11-e8db854')
    expect(isCursorVersionVerified(launch.version)).toBe(true)
    expect(isCursorLaunchVerified(launch)).toBe(false)
    expect(isCursorVersionVerified('2099.01.01-unknown')).toBe(false)
  })

  it('builds a profile that denies real-home reads and writes with narrow exceptions', () => {
    const profile = cursorSeatbeltProfile('/host/.local/share/cursor-agent/version', '/private/run', '/host')
    expect(profile).toContain('(deny process-exec)')
    expect(profile).toContain('(allow process-exec (literal "/host/.local/share/cursor-agent/version/node"))')
    expect(profile).toContain('(allow process-exec (literal "/usr/bin/security"))')
    expect(profile).toContain('(allow process-exec (literal "/usr/bin/git"))')
    expect(profile).toContain('(deny file-read-data')
    expect(profile).toContain('(deny file-write* (require-all')
    expect(profile).toContain('(require-not (literal "/dev/null"))')
    expect(profile).toContain('/host/Library/Keychains')
    expect(profile).toContain('/private/run')
  })

  it('allows only exact non-filesystem MCP permission shapes', () => {
    const tools = new Set(['echo'])
    expect(expectedMcpPermission({ toolCallId: '1', title: 'dsh-abcd-echo: echo', kind: 'execute' }, 'dsh-abcd', tools)).toBe(true)
    expect(expectedMcpPermission({ toolCallId: '2', title: 'dsh-abcd-echo-extra: echo', kind: 'execute' }, 'dsh-abcd', tools)).toBe(false)
    expect(expectedMcpPermission({ toolCallId: '3', title: 'dsh-abcd-echo: echo', kind: 'read' }, 'dsh-abcd', tools)).toBe(false)
    expect(expectedMcpPermission({
      toolCallId: '4',
      title: 'dsh-abcd-echo: echo',
      kind: 'execute',
      locations: [{ path: '/host/file' }],
    }, 'dsh-abcd', tools)).toBe(false)
  })

  it('parses repeated attribution headers and enforced runtime bounds', () => {
    expect(parseRuntimeArguments([
      '--cursor-command', cursor,
      '--wire-model', 'grok-4.6[effort=high]',
      '--header', 'user-agent: dsh/1',
      '--header', 'x-test: value',
      '--max-mcp-body-bytes', '4096',
      '--max-protocol-line-bytes', '8192',
      '--prompt-timeout-ms', '5000',
      '--grace-ms', '1000',
      '--require-sandbox', 'true',
    ])).toMatchObject({
      cursorCommand: cursor,
      wireModel: 'grok-4.6[effort=high]',
      headers: { 'user-agent': 'dsh/1', 'x-test': 'value' },
      maxMcpBodyBytes: 4096,
      maxProtocolLineBytes: 8192,
      requireSandbox: true,
    })
  })

  it('round-trips private stop and disjoint usage controls', () => {
    expect(parseCursorControl(encodeCursorControl({ stopReason: 'max_tokens' }))).toEqual({ stopReason: 'max_tokens' })
    expect(parseCursorControl(encodeCursorControl({ usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 } }))).toEqual({
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
    })
    expect(parseCursorControl('ordinary text')).toBeUndefined()
  })
})
