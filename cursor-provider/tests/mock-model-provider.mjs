import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const protocol = 'agent-virtualization/model-provider/v1'
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let requestId
let callId
let output = ''
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
for await (const line of lines) {
  if (line.trim().length === 0) continue
  const message = JSON.parse(line)
  if (message.type === 'model.run') {
    requestId = message.requestId
    if (message.task.includes('MALFORMED')) {
      process.stdout.write('{not-json}\n')
      break
    }
    if (message.task.includes('ABNORMAL_EXIT')) process.exit(17)
    if (message.task.includes('WAIT_FOR_ABORT')) {
      send({ protocol, type: 'model.event', requestId, event: { type: 'reasoning.delta', message: 'waiting' } })
      continue
    }
    const failure = [
      ['AUTH_EXPIRED', 'AUTH_EXPIRED: Cursor login expired'],
      ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED: Cursor quota exhausted'],
      ['TIMED_OUT', 'TIMEOUT: Cursor prompt timed out'],
      ['INCOMPATIBLE_CURSOR_ACP', 'INCOMPATIBLE_CURSOR_ACP: unsupported protocol'],
    ].find(([marker]) => message.task.includes(marker))
    if (failure !== undefined) {
      send({
        protocol,
        type: 'model.result',
        requestId,
        result: {
          status: failure[0] === 'TIMED_OUT' ? 'timed_out' : 'failed',
          output: '',
          error: failure[1],
        },
      })
      break
    }
    if (message.task.includes('ECHO_MODEL')) {
      send({ protocol, type: 'model.result', requestId, result: { status: 'completed', output: message.metadata.model } })
      break
    }
    if (message.tools.length > 0 || message.task.includes('FORCE_TOOL')) {
      callId = randomUUID()
      send({ protocol, type: 'model.event', requestId, event: { type: 'message.delta', message: 'before-tool' } })
      output = 'before-tool'
      send({ protocol, type: 'tool.call', requestId, callId, name: message.tools[0]?.name ?? 'forbidden', arguments: { text: 'from-cursor' } })
    } else {
      send({ protocol, type: 'model.event', requestId, event: { type: 'reasoning.delta', message: 'think' } })
      send({ protocol, type: 'model.event', requestId, event: { type: 'message.delta', message: 'cursor-text' } })
      send({ protocol, type: 'model.result', requestId, result: { status: 'completed', output: 'cursor-text' } })
      break
    }
  } else if (message.type === 'tool.result') {
    const suffix = ` resumed:${message.content}`
    output += suffix
    send({ protocol, type: 'model.event', requestId, event: { type: 'message.delta', message: suffix } })
    send({ protocol, type: 'model.result', requestId, result: { status: 'completed', output } })
    break
  } else if (message.type === 'model.cancel') {
    send({ protocol, type: 'model.result', requestId, result: { status: 'cancelled', output, error: message.reason } })
    break
  }
}
lines.close()
