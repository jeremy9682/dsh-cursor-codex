import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { strictAcpNdJsonStream } from '../src/acp-stream.js'

describe('strict Cursor ACP framing', () => {
  it('preserves split and coalesced JSON-RPC messages', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stream = strictAcpNdJsonStream(output, input, 1024)
    const reader = stream.readable.getReader()
    input.write('{"jsonrpc":"2.0","id":1')
    input.write('}\n{"jsonrpc":"2.0","id":2}\n')
    await expect(reader.read()).resolves.toMatchObject({ value: { id: 1 }, done: false })
    await expect(reader.read()).resolves.toMatchObject({ value: { id: 2 }, done: false })
    input.end()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
  })

  it('fails closed without logging malformed raw protocol content', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reader = strictAcpNdJsonStream(output, input, 1024).readable.getReader()
    input.end('{secret malformed}\n')
    await expect(reader.read()).rejects.toThrow('malformed JSON')
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('bounds incoming and outgoing ACP lines', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stream = strictAcpNdJsonStream(output, input, 32)
    const reader = stream.readable.getReader()
    input.end(`${JSON.stringify({ value: 'x'.repeat(64) })}\n`)
    await expect(reader.read()).rejects.toThrow(/exceeds 32 bytes/u)
    const writer = stream.writable.getWriter()
    await expect(writer.write({ jsonrpc: '2.0', method: 'x'.repeat(64) } as never)).rejects.toThrow(/exceeds 32 bytes/u)
  })
})
