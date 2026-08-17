import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

/** Stable provider route shown by DeepSeek Harness. */
export const CURSOR_ACP_PROVIDER = 'cursor-acp' as const
/** Settings namespace rendered by the native Models page. */
export const CURSOR_ACP_SETTINGS_NS = 'llm-cursor-acp' as const
/** Required default model identity. */
export const DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6-high' as const
/** Agent Virtualization model-provider wire version. */
export const MODEL_PROVIDER_PROTOCOL = 'agent-virtualization/model-provider/v1' as const

/** Raw model row returned by Cursor ACP session setup. */
export interface CursorWireModel {
  readonly modelId: string
  readonly name: string
  readonly description?: string
}

/** Stable DSH catalog row paired with the exact current Cursor wire id. */
export interface CursorCatalogModel extends LlmModelInfo {
  readonly wireModelId: string
  readonly contextWindow?: number
}

/** Catalog row with a generated Agent Virtualization runtime configuration. */
export interface CursorRuntimeModel extends CursorCatalogModel {
  readonly configPath: string
}

/** Process configuration consumed by the DSH adapter. */
export interface CursorAdapterConfig {
  readonly bridgeCommand: string
  readonly bridgeArgs: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly graceMs: number
  readonly maxProtocolLineBytes: number
  readonly stderrMaxBytes: number
  readonly models: readonly CursorRuntimeModel[]
  readonly tombstones: readonly CursorRuntimeModel[]
}

/** Loader/settings input for the provider. */
export interface CursorProviderConfig {
  command?: string
  defaultModel?: string
  catalogTtlMs?: number
  promptTimeoutMs?: number
  graceMs?: number
  maxProtocolLineBytes?: number
  maxMcpBodyBytes?: number
  stderrMaxBytes?: number
}

/** Runtime and safety configuration after schema validation. */
export interface ResolvedCursorProviderConfig {
  readonly command: string
  readonly defaultModel: string
  readonly catalogTtlMs: number
  readonly promptTimeoutMs: number
  readonly graceMs: number
  readonly maxProtocolLineBytes: number
  readonly maxMcpBodyBytes: number
  readonly stderrMaxBytes: number
}

/** Input accepted by the Agent Virtualization model-provider process. */
export type ModelProviderInput =
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'model.run'
      readonly requestId: string
      readonly task: string
      readonly workspace: string
      readonly tools: readonly {
        readonly name: string
        readonly description: string
        readonly inputSchema: Record<string, unknown>
      }[]
      readonly metadata: Readonly<Record<string, string>>
    }
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'tool.result'
      readonly requestId: string
      readonly callId: string
      readonly success: boolean
      readonly content: string
    }
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'model.cancel'
      readonly requestId: string
      readonly reason: string
    }

/** Output emitted by the Agent Virtualization model-provider process. */
export type ModelProviderOutput =
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'model.event'
      readonly requestId: string
      readonly event: { readonly type: string; readonly message?: string }
    }
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'tool.call'
      readonly requestId: string
      readonly callId: string
      readonly name: string
      readonly arguments: unknown
    }
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'model.result'
      readonly requestId: string
      readonly result: {
        readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
        readonly output: string
        readonly error?: string
      }
    }
  | {
      readonly protocol: typeof MODEL_PROVIDER_PROTOCOL
      readonly type: 'model.error'
      readonly requestId?: string
      readonly error: string
    }

/** Generic-JSONL request sent from Agent Virtualization to the Cursor runtime. */
export interface GenericRunStart {
  readonly type: 'run.start'
  readonly runId: string
  readonly task: string
  readonly instructions?: string
  readonly capabilities: readonly {
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
  }[]
}

/** Generic-JSONL tool result sent back to the Cursor runtime. */
export interface GenericToolResult {
  readonly type: 'tool.result'
  readonly id?: string
  readonly success: boolean
  readonly content: string
}
