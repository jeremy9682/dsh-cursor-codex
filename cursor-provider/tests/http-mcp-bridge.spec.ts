import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenericToolBroker } from '../src/generic-tool-broker.js'
import { HttpMcpBridge } from '../src/http-mcp-bridge.js'

const bridges: HttpMcpBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())) })

async function post(bridge: HttpMcpBridge, body: unknown, token = bridge.token): Promise<Response> {
  return fetch(bridge.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function wrongHostStatus(bridge: HttpMcpBridge): Promise<number | undefined> {
  const endpoint = new URL(bridge.endpoint)
  return await new Promise((resolve, reject) => {
    const req = request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        host: 'attacker.invalid',
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
      },
    }, res => {
      res.resume()
      res.once('end', () => resolve(res.statusCode))
    })
    req.once('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }))
  })
}

describe('private HTTP MCP bridge', () => {
  it('authenticates initialize and lists the exact action space', async () => {
    const broker = new GenericToolBroker(async () => {})
    const bridge = new HttpMcpBridge([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }], broker, 4096)
    bridges.push(bridge)
    await bridge.start()

    expect((await post(bridge, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).status).toBe(200)
    const listed = await post(bridge, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    await expect(listed.json()).resolves.toMatchObject({ result: { tools: [{ name: 'echo' }] } })
    expect((await post(bridge, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'wrong')).status).toBe(401)
    expect(await wrongHostStatus(bridge)).toBe(400)
  })

  it('suspends tools/call until the generic result arrives', async () => {
    let outbound: Record<string, unknown> | undefined
    const broker = new GenericToolBroker(async message => { outbound = message as Record<string, unknown> })
    const bridge = new HttpMcpBridge([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }], broker, 4096)
    bridges.push(bridge)
    await bridge.start()

    const pending = post(bridge, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
    await vi.waitFor(() => expect(outbound?.type).toBe('tool.call'))
    const concurrent = await post(bridge, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo', arguments: {} } })
    await expect(concurrent.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('concurrent') } })
    broker.resolve({ type: 'tool.result', id: outbound?.id as string, success: true, content: 'scheduled:hi' })
    await expect((await pending).json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'scheduled:hi' }], isError: false },
    })
  })

  it('rejects unknown tools, oversized bodies, and stale results', async () => {
    const broker = new GenericToolBroker(async () => {})
    const bridge = new HttpMcpBridge([], broker, 256)
    bridges.push(bridge)
    await bridge.start()
    const unknown = await post(bridge, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'missing' } })
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: -32000 } })
    const oversized = await fetch(bridge.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(1_000) }),
    })
    expect(oversized.status).toBe(413)
    expect(() => broker.resolve({ type: 'tool.result', id: 'stale', success: false, content: 'denied' })).toThrow(/no pending/u)
  })
})
