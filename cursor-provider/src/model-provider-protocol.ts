import { Buffer } from 'node:buffer'
import type { Readable, Writable } from 'node:stream'
import { MODEL_PROVIDER_PROTOCOL, type ModelProviderInput, type ModelProviderOutput } from './types.js'

interface Waiter {
  readonly resolve: (value: ModelProviderOutput) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse and validate one untrusted Agent Virtualization output line. */
export function parseModelProviderOutput(line: string): ModelProviderOutput {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.protocol !== MODEL_PROVIDER_PROTOCOL || typeof value.type !== 'string') {
    throw new Error('invalid Agent Virtualization model-provider message')
  }
  if (value.type === 'tool.call') {
    if (typeof value.requestId !== 'string' || typeof value.callId !== 'string' || typeof value.name !== 'string'
      || !Object.hasOwn(value, 'arguments')) {
      throw new Error('invalid Agent Virtualization tool.call message')
    }
  } else if (value.type === 'model.event') {
    if (typeof value.requestId !== 'string' || !isRecord(value.event) || typeof value.event.type !== 'string') {
      throw new Error('invalid Agent Virtualization model.event message')
    }
    if (value.event.message !== undefined && typeof value.event.message !== 'string') {
      throw new Error('invalid Agent Virtualization model.event message text')
    }
  } else if (value.type === 'model.result') {
    if (typeof value.requestId !== 'string' || !isRecord(value.result)
      || !['completed', 'failed', 'cancelled', 'timed_out'].includes(String(value.result.status))
      || typeof value.result.output !== 'string'
      || (value.result.error !== undefined && typeof value.result.error !== 'string')) {
      throw new Error('invalid Agent Virtualization model.result message')
    }
  } else if (value.type === 'model.error') {
    if (typeof value.error !== 'string' || (value.requestId !== undefined && typeof value.requestId !== 'string')) {
      throw new Error('invalid Agent Virtualization model.error message')
    }
  } else {
    throw new Error(`unknown Agent Virtualization message type ${JSON.stringify(value.type)}`)
  }
  return value as unknown as ModelProviderOutput
}

/** Bounded ordered NDJSON mailbox for one persistent model-provider bridge. */
export class ModelProviderMailbox {
  private bytes = Buffer.alloc(0)
  private readonly values: ModelProviderOutput[] = []
  private queuedBytes = 0
  private readonly waiters: Waiter[] = []
  private closed: Error | undefined

  constructor(input: Readable, private readonly maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error('maxLineBytes must be positive')
    input.on('data', (chunk: Buffer | string) => { this.push(chunk) })
    input.on('error', (error: Error) => { this.fail(error) })
    input.on('end', () => { this.close(new Error('Agent Virtualization stdout closed')) })
  }

  next(signal?: AbortSignal): Promise<ModelProviderOutput> {
    const value = this.values.shift()
    if (value !== undefined) {
      this.queuedBytes -= Buffer.byteLength(JSON.stringify(value))
      return Promise.resolve(value)
    }
    if (this.closed !== undefined) return Promise.reject(this.closed)
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : {
          signal,
          onAbort: () => {
            const index = this.waiters.indexOf(waiter)
            if (index >= 0) this.waiters.splice(index, 1)
            reject(abortError(signal))
          },
        }),
      }
      waiter.signal?.addEventListener('abort', waiter.onAbort!, { once: true })
      this.waiters.push(waiter)
    })
  }

  close(error: Error): void {
    if (this.closed !== undefined) return
    this.closed = error
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort!)
      waiter.reject(error)
    }
  }

  private push(chunk: Buffer | string): void {
    if (this.closed !== undefined) return
    this.bytes = Buffer.concat([this.bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    let newline = this.bytes.indexOf(0x0a)
    while (newline >= 0) {
      if (newline > this.maxLineBytes) {
        this.fail(new Error(`Agent Virtualization protocol line exceeds ${String(this.maxLineBytes)} bytes`))
        return
      }
      const line = this.bytes.subarray(0, newline).toString('utf8').replace(/\r$/u, '')
      this.bytes = this.bytes.subarray(newline + 1)
      if (line.length > 0) {
        try {
          this.pushValue(parseModelProviderOutput(line))
          if (this.closed !== undefined) return
        } catch (error: unknown) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
          return
        }
      }
      newline = this.bytes.indexOf(0x0a)
    }
    if (this.bytes.byteLength > this.maxLineBytes) {
      this.close(new Error(`Agent Virtualization protocol line exceeds ${String(this.maxLineBytes)} bytes`))
    }
  }

  private fail(error: Error): void {
    this.values.length = 0
    this.queuedBytes = 0
    this.close(error)
  }

  private pushValue(value: ModelProviderOutput): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (this.values.length >= 256 || this.queuedBytes + bytes > this.maxLineBytes * 8) {
        this.fail(new Error('Agent Virtualization protocol queue exceeds bounded capacity'))
        return
      }
      this.values.push(value)
      this.queuedBytes += bytes
      return
    }
    waiter.signal?.removeEventListener('abort', waiter.onAbort!)
    waiter.resolve(value)
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('model-provider wait aborted')
}

/** Write one host message without closing the bridge stdin. */
export function writeModelProviderInput(output: Writable, message: ModelProviderInput): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(message)}\n`, error => error === null || error === undefined ? resolve() : reject(error))
  })
}
