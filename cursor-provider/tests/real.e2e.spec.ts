import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as CursorProvider from '../src/index.js'

const enabled = process.env.DSH_CURSOR_E2E === '1'
let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function realHarness(): Promise<Context> {
  const context = new Context()
  ctx = context
  await context.plugin(AgentRegistry)
  await context.plugin(LlmRuntime)
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(CursorProvider, {
    command: process.env.DSH_CURSOR_COMMAND ?? '/Users/zihan/.local/bin/cursor-agent',
    defaultModel: 'cursor-grok-4.6-high',
    promptTimeoutMs: 180_000,
  })
  return context
}

function waitForIdle(context: Context, agent: Agent): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      dispose()
      reject(new Error('real Cursor Agent Loop did not become idle'))
    }, 240_000)
    const dispose = context.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timeout)
      dispose()
      resolve()
    })
  })
}

async function realAgentLoopHarness(): Promise<Context> {
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  await context.plugin(SessionStore)
  await context.plugin(SystemPrompt, { persona: 'Use the exact DSH Action Space requested by the user.' })
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(CursorProvider, {
    command: process.env.DSH_CURSOR_COMMAND ?? '/Users/zihan/.local/bin/cursor-agent',
    defaultModel: 'cursor-grok-4.6-high',
    promptTimeoutMs: 180_000,
  })
  return context
}

describe.skipIf(!enabled)('real keyless Cursor ACP provider', () => {
  it('streams text through the native DSH LLM provider', { timeout: 240_000 }, async () => {
    const context = await realHarness()
    const chunks: StreamChunk[] = []
    for await (const chunk of context.llm.stream({
      provider: 'cursor-acp',
      model: 'cursor-grok-4.6-high',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly: cursor-native-stream-ok' }],
        source: { kind: 'user' },
      })],
    })) chunks.push(chunk)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    expect(text, JSON.stringify(chunks)).toContain('cursor-native-stream-ok')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('routes one Cursor MCP call through the DSH Tool Scheduler and resumes it', { timeout: 300_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-real-tool-e2e-'))
    const context = await realAgentLoopHarness()
    context.tools.register(defineContentToolFixture({
      name: 'cursor_scheduler_echo',
      description: 'Return the supplied marker through the DeepSeek Harness scheduler.',
      parameters: { marker: { type: 'string', description: 'Exact marker to return.' } },
      async execute(args) {
        return Promise.resolve([{ type: 'text', text: `scheduled-by-dsh:${String(args.marker)}` }])
      },
    }))
    const agent = context.agentLoop.create(
      SessionId('cursor-real-tool-e2e'),
      { provider: 'cursor-acp', model: 'cursor-grok-4.6-high' },
      { cwd: root },
    )
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Call the cursor_scheduler_echo DSH tool exactly once with {"marker":"roundtrip-ok"}. Then reply with only the returned tool text.',
      }],
      source: { kind: 'user' },
    }))
    await idle

    const eventTypes = agent.session.events.map(event => event.type)
    const toolCallIndex = eventTypes.indexOf('tool/call')
    const toolResultIndex = eventTypes.indexOf('tool/result')
    const streamDiagnostics = agent.session.events
      .filter(event => event.type === 'assistant/chunk')
      .map(event => event.type === 'assistant/chunk' ? event.data.chunk : undefined)
    expect(toolCallIndex, JSON.stringify({ eventTypes, streamDiagnostics })).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex, JSON.stringify(eventTypes)).toBeGreaterThan(toolCallIndex)
    const final = agent.session.deriveMessages().at(-1)
    expect(final?.role).toBe('assistant')
    expect(final?.content).toContainEqual({ type: 'text', text: 'scheduled-by-dsh:roundtrip-ok' })
  })
})
