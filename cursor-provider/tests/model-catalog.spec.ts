import { describe, expect, it } from 'vitest'
import { normalizeCursorCatalog, parseCursorWireModel, requireCatalogModel } from '../src/model-catalog.js'

const provider = 'cursor-acp'

describe('Cursor model catalog', () => {
  it('maps the requested Grok default to a stable id', () => {
    const catalog = normalizeCursorCatalog(provider, [{
      modelId: 'grok-4.6[effort=high,fast=true]',
      name: 'grok-4.6',
    }])
    expect(catalog).toEqual([{
      provider,
      id: 'cursor-grok-4.6-high',
      name: 'Cursor grok-4.6 · high',
      inputModalities: ['text'],
      wireModelId: 'grok-4.6[effort=high,fast=true]',
    }])
  })

  it('parses context capacity and reasoning spelling', () => {
    const [model] = normalizeCursorCatalog(provider, [{
      modelId: 'gpt-5.6-sol[context=272k,reasoning=medium,fast=false]',
      name: 'gpt-5.6-sol',
    }])
    expect(model?.id).toBe('cursor-gpt-5.6-sol-medium')
    expect(model?.contextWindow).toBe(272_000)
  })

  it('keeps unknown Cursor parameters out of stable ids', () => {
    expect(parseCursorWireModel('claude-opus-5[thinking=true,context=300k,effort=high,fast=false]')).toEqual({
      base: 'claude-opus-5',
      parameters: { thinking: 'true', context: '300k', effort: 'high', fast: 'false' },
    })
  })

  it('deduplicates wire ids and hashes stable-id collisions', () => {
    const catalog = normalizeCursorCatalog(provider, [
      { modelId: 'same[effort=high,fast=true]', name: 'Same' },
      { modelId: 'same[effort=high,fast=false]', name: 'Same' },
      { modelId: 'same[effort=high,fast=true]', name: 'Duplicate' },
    ])
    expect(catalog).toHaveLength(2)
    expect(catalog[0]?.id).toMatch(/^cursor-same-high-[a-f0-9]{8}$/u)
    expect(catalog[1]?.id).toMatch(/^cursor-same-high-[a-f0-9]{8}$/u)
    expect(catalog[0]?.id).not.toBe(catalog[1]?.id)
  })

  it('rejects unknown stable model ids', () => {
    expect(() => requireCatalogModel([], 'cursor-missing')).toThrowError(/unknown Cursor ACP model/u)
  })
})
