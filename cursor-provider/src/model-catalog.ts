import { createHash } from 'node:crypto'
import type { CursorCatalogModel, CursorWireModel } from './types.js'

interface ParsedWireModel {
  readonly base: string
  readonly parameters: Readonly<Record<string, string>>
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Parse Cursor's parameterized model spelling without interpreting unknown keys. */
export function parseCursorWireModel(modelId: string): ParsedWireModel {
  const open = modelId.lastIndexOf('[')
  if (open < 1 || !modelId.endsWith(']')) return { base: modelId, parameters: {} }
  const base = modelId.slice(0, open)
  const body = modelId.slice(open + 1, -1)
  const parameters: Record<string, string> = {}
  if (body.trim().length > 0) {
    for (const entry of body.split(',')) {
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      const key = entry.slice(0, separator).trim()
      const value = entry.slice(separator + 1).trim()
      if (key.length > 0 && value.length > 0) parameters[key] = value
    }
  }
  return { base, parameters }
}

function contextWindow(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const match = /^(\d+(?:\.\d+)?)([km]?)$/iu.exec(value.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1
  const result = Math.round(amount * multiplier)
  return Number.isSafeInteger(result) && result > 0 ? result : undefined
}

function preferredLevel(parameters: Readonly<Record<string, string>>): string | undefined {
  return parameters.effort ?? parameters.reasoning
}

function baseStableId(model: CursorWireModel): string {
  const parsed = parseCursorWireModel(model.modelId)
  const base = slug(parsed.base || model.name)
  const level = preferredLevel(parsed.parameters)
  return `cursor-${base.length > 0 ? base : 'model'}${level === undefined ? '' : `-${slug(level)}`}`
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** Normalize one live Cursor catalog into deterministic DSH ids. */
export function normalizeCursorCatalog(
  provider: string,
  wireModels: readonly CursorWireModel[],
): CursorCatalogModel[] {
  const uniqueWire = new Map<string, CursorWireModel>()
  for (const model of wireModels) {
    if (model.modelId.trim().length === 0 || model.name.trim().length === 0) continue
    if (!uniqueWire.has(model.modelId)) uniqueWire.set(model.modelId, model)
  }
  const baseCounts = new Map<string, number>()
  for (const model of uniqueWire.values()) {
    const id = baseStableId(model)
    baseCounts.set(id, (baseCounts.get(id) ?? 0) + 1)
  }
  return [...uniqueWire.values()].map(model => {
    const parsed = parseCursorWireModel(model.modelId)
    const base = baseStableId(model)
    const id = baseCounts.get(base) === 1 ? base : `${base}-${shortHash(model.modelId)}`
    const level = preferredLevel(parsed.parameters)
    const capacity = contextWindow(parsed.parameters.context)
    return {
      provider,
      id,
      name: `Cursor ${model.name}${level === undefined ? '' : ` · ${level}`}`,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: ['text'],
      wireModelId: model.modelId,
      ...(capacity === undefined ? {} : { contextWindow: capacity }),
    }
  })
}

/** Resolve an exact stable model id without silently falling back. */
export function requireCatalogModel(
  catalog: readonly CursorCatalogModel[],
  modelId: string,
): CursorCatalogModel {
  const model = catalog.find(candidate => candidate.id === modelId)
  if (model === undefined) {
    const error = new Error(`unknown Cursor ACP model "${modelId}"`) as Error & { code: string }
    error.code = 'UNKNOWN_MODEL'
    throw error
  }
  return model
}
