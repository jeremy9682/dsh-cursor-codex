import React, { useEffect, useState } from 'react'

export const inject = ['slots', 'locale', 'connection']

const NS = 'settings.cursorAcp'
const CHANNEL = '/cursor-acp'
const STYLE = `
.cursorAcp{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}
.cursorAcp h2,.cursorAcp p{margin:0}.cursorAcp h2{font-size:16px;line-height:24px;font-weight:500}
.cursorAcpCard{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.cursorAcpGrid{display:grid;grid-template-columns:140px minmax(0,1fr);gap:10px 12px;align-items:center}.cursorAcpGrid label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.cursorAcpGrid input,.cursorAcpGrid select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-module-platform);color:inherit}
.cursorAcpRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cursorAcpStatus{font-size:13px;color:var(--dsw-alias-label-secondary)}.cursorAcpError{font-size:13px;color:var(--dsw-alias-state-error-primary)}
.cursorAcp button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 12px;background:var(--dsw-alias-bg-module-platform);color:inherit;cursor:pointer}.cursorAcp button:disabled{opacity:.5;cursor:not-allowed}
@media(max-width:640px){.cursorAcpGrid{grid-template-columns:1fr}}
`

const copy = {
  en: {
    nav: 'Cursor ACP', title: 'Cursor ACP subscription', intro: 'Uses the signed-in Cursor Agent subscription. Credentials and account identity never cross into this page.',
    path: 'Cursor Agent path', defaultModel: 'Preferred default', refresh: 'Refresh models', save: 'Save settings', signedIn: 'Signed in', signedOut: 'Sign-in unavailable', verified: 'Verified', unknown: 'Unknown', required: 'Login required', loading: 'Loading…', models: 'models', saved: 'Settings saved.', failed: 'Cursor ACP request failed.',
  },
  zh: {
    nav: 'Cursor ACP', title: 'Cursor ACP 订阅', intro: '使用已登录的 Cursor Agent 订阅；凭据和账户身份不会传到此页面。',
    path: 'Cursor Agent 路径', defaultModel: '首选默认模型', refresh: '刷新模型', save: '保存设置', signedIn: '已登录', signedOut: '登录不可用', verified: '已验证', unknown: '未知', required: '需要登录', loading: '加载中…', models: '个模型', saved: '设置已保存。', failed: 'Cursor ACP 请求失败。',
  },
}

interface Health {
  readonly command: string
  readonly version?: string
  readonly compatible: boolean
  readonly authStatus: 'verified' | 'required' | 'unknown'
  readonly defaultModel: string
  readonly defaultModelAvailable: boolean
  readonly models: readonly { readonly id: string; readonly name: string }[]
  readonly error?: string
}

interface RpcResult { readonly ok: boolean; readonly value?: unknown; readonly error?: { readonly message?: string } }
interface Rpc { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult> }
interface Props { readonly rpc: Rpc; readonly t: (key: keyof typeof copy.en) => string }

function healthValue(result: RpcResult): Health {
  if (!result.ok || typeof result.value !== 'object' || result.value === null) throw new Error(result.error?.message ?? 'Cursor ACP RPC failed')
  return result.value as Health
}

function CursorSection({ rpc, t }: Props): React.ReactElement {
  const [health, setHealth] = useState<Health>()
  const [command, setCommand] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const load = (endpoint: 'status' | 'refresh'): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    return rpc.call(CHANNEL, endpoint, {}).then(healthValue).then(next => {
      setHealth(next)
      setCommand(next.command)
      setDefaultModel(next.defaultModel)
    }).catch(error => setMessage(error instanceof Error ? error.message : t('failed'))).finally(() => setBusy(false))
  }
  useEffect(() => { void load('status') }, [])
  const save = (): void => {
    setBusy(true)
    setMessage(undefined)
    rpc.call(CHANNEL, 'configure', { command, defaultModel }).then(result => {
      if (!result.ok) throw new Error(result.error?.message ?? t('failed'))
      return load('status').then(() => { setMessage(t('saved')) })
    }).catch(error => setMessage(error instanceof Error ? error.message : t('failed'))).finally(() => setBusy(false))
  }
  const status = health === undefined
    ? t('loading')
    : `${health.authStatus === 'verified' ? t('signedIn') : t('signedOut')} · ${t(health.authStatus)} · ${String(health.models.length)} ${t('models')}${health.version === undefined ? '' : ` · ${health.version}`}`
  return React.createElement('div', { className: 'cursorAcp' },
    React.createElement('h2', null, t('title')),
    React.createElement('p', { className: 'cursorAcpStatus' }, t('intro')),
    React.createElement('div', { className: 'cursorAcpCard' },
      React.createElement('div', { className: 'cursorAcpStatus' }, status),
      React.createElement('div', { className: 'cursorAcpGrid' },
        React.createElement('label', { htmlFor: 'cursor-acp-command' }, t('path')),
        React.createElement('input', { id: 'cursor-acp-command', value: command, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCommand(event.currentTarget.value), disabled: busy }),
        React.createElement('label', { htmlFor: 'cursor-acp-default' }, t('defaultModel')),
        React.createElement('select', { id: 'cursor-acp-default', value: defaultModel, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setDefaultModel(event.currentTarget.value), disabled: busy || health === undefined },
          ...(health?.models ?? []).map(model => React.createElement('option', { key: model.id, value: model.id }, model.name))),
      ),
      React.createElement('div', { className: 'cursorAcpRow' },
        React.createElement('button', { type: 'button', disabled: busy, onClick: () => { void load('refresh') } }, t('refresh')),
        React.createElement('button', { type: 'button', disabled: busy || command.trim() === '' || defaultModel.trim() === '', onClick: save }, t('save')),
      ),
      message === undefined ? null : React.createElement('p', { className: health?.error === undefined ? 'cursorAcpStatus' : 'cursorAcpError' }, message),
      health?.error === undefined ? null : React.createElement('p', { className: 'cursorAcpError' }, health.error),
    ),
  )
}

interface ClientContext {
  readonly locale: { register(ns: string, value: unknown): () => void; bind(ns: string): (key: keyof typeof copy.en) => string }
  readonly slots: { inject(name: string, callback: () => void): void; register(options: unknown, component: unknown): () => void }
  get(name: string): unknown
  effect(factory: () => (() => void), label?: string): void
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, copy), 'cursor-acp: locale')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@jeremy9682/dsh-llm-cursor-acp'
    tag.textContent = STYLE
    document.head.append(tag)
    return () => tag.remove()
  }, 'cursor-acp: style')
  const connection = ctx.get('connection') as { readonly rpc: Rpc }
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'cursor-acp', order: 16, label: () => t('nav'), locale: NS,
    inject: () => ({ rpc: connection.rpc, t }),
  }, CursorSection))
}
