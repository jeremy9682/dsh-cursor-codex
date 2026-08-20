#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  parseCliArgs,
  readPackage,
  requiredArg,
  resolveDshLlmEntry,
  resolveDshLlmRoot,
} from './dsh-upgrade-gate-lib.mjs'

async function loadPackageEntry(llmRoot, name) {
  const require = createRequire(resolve(llmRoot, 'package.json'))
  return import(pathToFileURL(require.resolve(name)).href)
}

async function runProbe(candidateRoot) {
  const llmRoot = await resolveDshLlmRoot(candidateRoot)
  const llmPackage = await readPackage(llmRoot)
  const llmEntry = await resolveDshLlmEntry(llmRoot)
  const [llm, cordis] = await Promise.all([
    import(pathToFileURL(llmEntry).href),
    loadPackageEntry(llmRoot, '@deepseek-ai/cordis'),
  ])
  const {
    default: LlmRuntime,
    LlmAdapter,
    createMessage,
    isAgentLoopRequest,
    markAgentLoopRequest,
  } = llm
  if (
    typeof LlmRuntime !== 'function'
    || typeof LlmAdapter !== 'function'
    || typeof createMessage !== 'function'
    || typeof isAgentLoopRequest !== 'function'
    || typeof markAgentLoopRequest !== 'function'
    || typeof cordis.Context !== 'function'
  ) throw new Error('INCOMPATIBLE_DSH_LLM_API: required public exports are unavailable')

  class RecordingAdapter extends LlmAdapter {
    lastOptions

    async * stream(options) {
      this.lastOptions = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const context = new cordis.Context()
  const historical = new RecordingAdapter()
  const target = new RecordingAdapter()
  try {
    await context.plugin(LlmRuntime)
    context.llm.registerAdapter(['historical'], historical)
    context.llm.registerAdapter(['target'], target)
    const options = markAgentLoopRequest(Object.freeze({
      provider: 'target',
      model: 'new-model',
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'historical response' }],
        source: {
          kind: 'model',
          provider: 'historical',
          model: 'old-model',
          replayState: { private: 'must-not-cross-adapter' },
        },
      })],
    }))
    for await (const _chunk of context.llm.stream(options)) { /* drain */ }

    const delivered = target.lastOptions
    const replayState = delivered?.messages?.[0]?.source?.replayState
    const result = {
      schemaVersion: 1,
      package: '@deepseek-ai/dsh-llm',
      version: String(llmPackage.version ?? 'unknown'),
      markerPreserved: delivered !== undefined && isAgentLoopRequest(delivered),
      replayStateStripped: replayState === undefined,
      copied: delivered !== undefined && delivered !== options,
      frozen: delivered !== undefined && Object.isFrozen(delivered),
    }
    return { ...result, pass: result.markerPreserved && result.replayStateStripped && result.copied && result.frozen }
  } finally {
    await context.dispose?.()
  }
}

const args = parseCliArgs(process.argv.slice(2))
try {
  const result = await runProbe(requiredArg(args, 'candidate-root'))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.pass) process.exitCode = 12
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 13
}
