import { Buffer } from 'node:buffer'
import type { Readable, Writable } from 'node:stream'
import type { Stream } from '@agentclientprotocol/sdk'

type AcpMessage = Stream extends { readonly readable: ReadableStream<infer Message> } ? Message : never

function parseMessage(line: Buffer): AcpMessage {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line)
  } catch {
    throw new Error('Cursor ACP emitted invalid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Cursor ACP emitted malformed JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Cursor ACP emitted a non-object JSON-RPC message')
  }
  return value as AcpMessage
}

/** Strict bounded ACP NDJSON framing that never logs raw protocol content. */
export function strictAcpNdJsonStream(output: Writable, input: Readable, maxLineBytes: number): Stream {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error('maxLineBytes must be positive')
  let buffered = Buffer.alloc(0)
  let ended = false
  let failed = false
  let controller: ReadableStreamDefaultController<AcpMessage> | undefined

  const cleanup = (): void => {
    input.off('data', onData)
    input.off('error', onError)
    input.off('end', onEnd)
  }
  const fail = (error: Error): void => {
    if (failed) return
    failed = true
    cleanup()
    controller?.error(error)
  }
  const drain = (): void => {
    if (controller === undefined || failed) return
    while ((controller.desiredSize ?? 1) > 0) {
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) break
      if (newline > maxLineBytes) {
        fail(new Error(`Cursor ACP protocol line exceeds ${String(maxLineBytes)} bytes`))
        return
      }
      let line = buffered.subarray(0, newline)
      buffered = buffered.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.length > 0) {
        try {
          controller.enqueue(parseMessage(line))
        } catch (error: unknown) {
          fail(error instanceof Error ? error : new Error('Cursor ACP framing failed'))
          return
        }
      }
    }
    if (buffered.indexOf(0x0a) < 0 && buffered.byteLength > maxLineBytes) {
      fail(new Error(`Cursor ACP protocol line exceeds ${String(maxLineBytes)} bytes`))
      return
    }
    if ((controller.desiredSize ?? 1) <= 0) input.pause()
    else if (ended) {
      if (buffered.length > 0) {
        try {
          controller.enqueue(parseMessage(buffered))
        } catch (error: unknown) {
          fail(error instanceof Error ? error : new Error('Cursor ACP framing failed'))
          return
        }
      }
      buffered = Buffer.alloc(0)
      cleanup()
      controller.close()
    }
  }
  const onData = (chunk: Buffer | string): void => {
    if (failed) return
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    drain()
  }
  const onError = (error: Error): void => { fail(error) }
  const onEnd = (): void => {
    ended = true
    drain()
  }

  const readable = new ReadableStream<AcpMessage>({
    start(next) {
      controller = next
      input.on('data', onData)
      input.once('error', onError)
      input.once('end', onEnd)
    },
    pull() {
      drain()
      if (!ended && !failed) input.resume()
    },
    cancel() {
      cleanup()
      input.pause()
    },
  }, { highWaterMark: 1 })

  const writable = new WritableStream<AcpMessage>({
    write(message) {
      let line: string
      try {
        line = `${JSON.stringify(message)}\n`
      } catch {
        throw new Error('Cursor ACP request is not JSON serializable')
      }
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error(`Cursor ACP request exceeds ${String(maxLineBytes)} bytes`)
      return new Promise<void>((resolve, reject) => {
        output.write(line, error => error === null || error === undefined ? resolve() : reject(error))
      })
    },
  })

  return { readable, writable }
}
