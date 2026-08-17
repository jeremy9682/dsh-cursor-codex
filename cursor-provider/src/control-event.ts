import type { TokenUsage } from '@deepseek-ai/dsh-llm'

export const CURSOR_CONTROL_PREFIX = '\u001edsh-cursor:'

export type CursorControlEvent =
  | { readonly stopReason: 'max_tokens' }
  | { readonly usage: TokenUsage }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export function escapeCursorControlText(text: string): string {
  return text.replaceAll(CURSOR_CONTROL_PREFIX, '␞dsh-cursor:')
}

export function encodeCursorControl(event: CursorControlEvent): string {
  return `${CURSOR_CONTROL_PREFIX}${JSON.stringify(event)}`
}

/** Parse only package-owned bridge controls; ordinary model text is untouched. */
export function parseCursorControl(message: string): CursorControlEvent | undefined {
  if (!message.startsWith(CURSOR_CONTROL_PREFIX)) return undefined
  const value: unknown = JSON.parse(message.slice(CURSOR_CONTROL_PREFIX.length))
  if (!isRecord(value)) throw new Error('invalid Cursor control event')
  if (value.stopReason === 'max_tokens') return { stopReason: 'max_tokens' }
  if (isRecord(value.usage)) {
    const inputTokens = nonNegativeInteger(value.usage.inputTokens)
    const outputTokens = nonNegativeInteger(value.usage.outputTokens)
    if (inputTokens === undefined || outputTokens === undefined) throw new Error('invalid Cursor usage control')
    return {
      usage: {
        inputTokens,
        outputTokens,
        ...(nonNegativeInteger(value.usage.cacheReadTokens) === undefined ? {} : { cacheReadTokens: nonNegativeInteger(value.usage.cacheReadTokens)! }),
        ...(nonNegativeInteger(value.usage.cacheWriteTokens) === undefined ? {} : { cacheWriteTokens: nonNegativeInteger(value.usage.cacheWriteTokens)! }),
        ...(nonNegativeInteger(value.usage.reasoningTokens) === undefined ? {} : { reasoningTokens: nonNegativeInteger(value.usage.reasoningTokens)! }),
      },
    }
  }
  throw new Error('unknown Cursor control event')
}
