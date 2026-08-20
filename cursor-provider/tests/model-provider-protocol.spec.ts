import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ModelProviderMailbox, parseModelProviderOutput, writeModelProviderInput } from '../src/model-provider-protocol.js'
import { MODEL_PROVIDER_PROTOCOL } from '../src/types.js'

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('Agent Virtualization model-provider protocol', () => {
  it('preserves split and coalesced output ordering', async () => {
    const input = new PassThrough()
    const mailbox = new ModelProviderMailbox(input, 1024)
    const first = line({ protocol: MODEL_PROVIDER_PROTOCOL, type: 'model.event', requestId: 'r', event: { type: 'message.delta', message: 'a' } })
    const second = line({ protocol: MODEL_PROVIDER_PROTOCOL, type: 'model.result', requestId: 'r', result: { status: 'completed', output: 'a' } })
    input.write(first.slice(0, 7))
    input.write(first.slice(7) + second)
    await expect(mailbox.next()).resolves.toMatchObject({ type: 'model.event' })
    await expect(mailbox.next()).resolves.toMatchObject({ type: 'model.result' })
  })

  it('fails closed on malformed and oversized lines', async () => {
    const malformed = new PassThrough()
    const malformedMailbox = new ModelProviderMailbox(malformed, 1024)
    malformed.write('{"protocol":"wrong"}\n')
    await expect(malformedMailbox.next()).rejects.toThrow(/invalid Agent Virtualization/u)

    const oversized = new PassThrough()
    const oversizedMailbox = new ModelProviderMailbox(oversized, 8)
    oversized.write('123456789')
    await expect(oversizedMailbox.next()).rejects.toThrow(/exceeds 8 bytes/u)
  })

  it('pauses and resumes across stream chunks larger than the message high-water mark', async () => {
    const input = new PassThrough()
    const mailbox = new ModelProviderMailbox(input, 64 * 1024)
    const event = line({ protocol: MODEL_PROVIDER_PROTOCOL, type: 'model.event', requestId: 'r', event: { type: 'message.delta', message: 'x' } })
    input.write(event.repeat(300) + event.slice(0, 5))
    input.write(event.slice(5) + event.repeat(299))
    for (let index = 0; index < 600; index += 1) {
      await expect(mailbox.next()).resolves.toMatchObject({ type: 'model.event' })
    }
  })

  it('fails closed when queued and unparsed protocol bytes exceed the byte cap', async () => {
    const input = new PassThrough()
    const mailbox = new ModelProviderMailbox(input, 256)
    const event = line({ protocol: MODEL_PROVIDER_PROTOCOL, type: 'model.event', requestId: 'r', event: { type: 'message.delta', message: 'x'.repeat(80) } })
    input.write(event.repeat(32))
    await expect(mailbox.next()).rejects.toThrow(/queue exceeds bounded capacity/u)
  })

  it('validates terminal status and event text', () => {
    expect(() => parseModelProviderOutput(line({
      protocol: MODEL_PROVIDER_PROTOCOL,
      type: 'model.result',
      requestId: 'r',
      result: { status: 'mystery', output: '' },
    }).trim())).toThrow(/model.result/u)
    expect(() => parseModelProviderOutput(line({
      protocol: MODEL_PROVIDER_PROTOCOL,
      type: 'model.event',
      requestId: 'r',
      event: { type: 'message.delta', message: 1 },
    }).trim())).toThrow(/event message text/u)
  })

  it('cancels one waiter without consuming the next value', async () => {
    const input = new PassThrough()
    const mailbox = new ModelProviderMailbox(input, 1024)
    const controller = new AbortController()
    const waiting = mailbox.next(controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    input.write(line({ protocol: MODEL_PROVIDER_PROTOCOL, type: 'model.error', requestId: 'r', error: 'later' }))
    await expect(mailbox.next()).resolves.toMatchObject({ type: 'model.error', error: 'later' })
  })

  it('writes one NDJSON input without closing the stream', async () => {
    const output = new PassThrough()
    let received = ''
    output.on('data', chunk => { received += chunk.toString('utf8') })
    await writeModelProviderInput(output, {
      protocol: MODEL_PROVIDER_PROTOCOL,
      type: 'model.cancel',
      requestId: 'r',
      reason: 'stop',
    })
    expect(received).toBe(line({ protocol: MODEL_PROVIDER_PROTOCOL, type: 'model.cancel', requestId: 'r', reason: 'stop' }))
    expect(output.destroyed).toBe(false)
  })
})
