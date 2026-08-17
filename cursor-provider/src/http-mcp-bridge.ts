import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GenericToolBroker } from './generic-tool-broker.js'

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorized(expected: string, actual: string | undefined): boolean {
  if (actual === undefined || !actual.startsWith('Bearer ')) return false
  const supplied = actual.slice('Bearer '.length)
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function response(res: ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function errorResponse(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.byteLength
    if (size > maxBytes) throw new Error('MCP request body exceeds configured limit')
    chunks.push(chunk)
  }
  if (size === 0) throw new Error('MCP request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Private stateless Streamable HTTP MCP server for one Cursor ACP session. */
export class HttpMcpBridge {
  readonly token = randomBytes(32).toString('hex')
  readonly serverName = `dsh-${randomBytes(8).toString('hex')}`
  private readonly path = `/mcp/${randomBytes(16).toString('hex')}`
  private readonly server: Server
  private started = false
  private closed = false
  private endpointValue: string | undefined
  private hostValue: string | undefined
  private readonly toolsByName: ReadonlyMap<string, McpToolDefinition>

  constructor(
    tools: readonly McpToolDefinition[],
    private readonly broker: GenericToolBroker,
    private readonly maxBodyBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('maxBodyBytes must be positive')
    this.toolsByName = new Map(tools.map(tool => [tool.name, tool]))
    if (this.toolsByName.size !== tools.length) throw new Error('MCP tool names must be unique')
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('MCP bridge is closed')
    if (this.started) return
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.server.once('error', onError)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    const address = this.server.address() as AddressInfo
    this.hostValue = `127.0.0.1:${String(address.port)}`
    this.endpointValue = `http://${this.hostValue}${this.path}`
    this.started = true
  }

  get endpoint(): string {
    if (this.endpointValue === undefined) throw new Error('MCP bridge is not started')
    return this.endpointValue
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.started) return
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== this.path) {
      response(res, 404)
      return
    }
    if (this.hostValue === undefined || req.headers.host !== this.hostValue) {
      response(res, 400)
      return
    }
    if (!authorized(this.token, req.headers.authorization)) {
      response(res, 401)
      return
    }
    if (req.method === 'GET') {
      response(res, 405)
      return
    }
    if (req.method !== 'POST') {
      response(res, 405)
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      response(res, 415)
      return
    }
    let raw: unknown
    try {
      raw = await readBody(req, this.maxBodyBytes)
    } catch (error: unknown) {
      response(res, error instanceof SyntaxError ? 400 : 413, errorResponse(null, -32700, 'invalid MCP request body'))
      return
    }
    if (!isRecord(raw) || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
      response(res, 400, errorResponse(isRecord(raw) ? raw.id : null, -32600, 'invalid MCP JSON-RPC request'))
      return
    }
    const request = raw as JsonRpcRequest
    if (request.id === undefined) {
      response(res, 202)
      return
    }
    try {
      const result = await this.dispatch(request.method as string, request.params, req)
      response(res, 200, { jsonrpc: '2.0', id: request.id, result })
    } catch (error: unknown) {
      response(res, 200, errorResponse(request.id, -32000, error instanceof Error ? error.message : 'MCP call failed'))
    }
  }

  private async dispatch(method: string, params: unknown, req: IncomingMessage): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const object = isRecord(params) ? params : {}
        return {
          protocolVersion: typeof object.protocolVersion === 'string' ? object.protocolVersion : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: this.serverName, version: '0.1.0' },
        }
      }
      case 'ping': return {}
      case 'tools/list':
        return { tools: [...this.toolsByName.values()] }
      case 'tools/call': {
        if (!isRecord(params) || typeof params.name !== 'string') throw new Error('invalid MCP tools/call parameters')
        if (!this.toolsByName.has(params.name)) throw new Error(`unknown MCP tool ${JSON.stringify(params.name)}`)
        const controller = new AbortController()
        req.once('aborted', () => controller.abort(new Error('Cursor disconnected from MCP call')))
        const result = await this.broker.invoke(params.name, params.arguments, controller.signal)
        return {
          content: [{ type: 'text', text: result.content }],
          isError: !result.success,
        }
      }
      default: throw new Error(`unsupported MCP request ${method}`)
    }
  }
}
