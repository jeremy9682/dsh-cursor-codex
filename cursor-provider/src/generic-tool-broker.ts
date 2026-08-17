import { randomUUID } from 'node:crypto'
import type { GenericToolResult } from './types.js'

interface PendingCall {
  readonly resolve: (result: GenericToolResult) => void
  readonly reject: (error: Error) => void
}

/** Suspends Cursor MCP calls while Agent Virtualization and DSH execute them. */
export class GenericToolBroker {
  private readonly pending = new Map<string, PendingCall>()
  private closed: Error | undefined

  constructor(private readonly send: (message: unknown) => Promise<void>) {}

  async invoke(name: string, arguments_: unknown, signal?: AbortSignal): Promise<GenericToolResult> {
    if (this.closed !== undefined) throw this.closed
    if (this.pending.size > 0) throw new Error('concurrent Cursor MCP calls are not allowed')
    const id = randomUUID()
    const result = new Promise<GenericToolResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    const onAbort = (): void => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      pending.reject(signal?.reason instanceof Error ? signal.reason : new Error('tool call aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.send({ type: 'tool.call', id, name, arguments: arguments_ })
      return await result
    } catch (error: unknown) {
      this.pending.delete(id)
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  resolve(message: GenericToolResult): void {
    if (message.id === undefined) throw new Error('generic tool result is missing id')
    const pending = this.pending.get(message.id)
    if (pending === undefined) throw new Error(`no pending generic tool call ${JSON.stringify(message.id)}`)
    this.pending.delete(message.id)
    pending.resolve(message)
  }

  close(error: Error): void {
    if (this.closed !== undefined) return
    this.closed = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
  }
}
