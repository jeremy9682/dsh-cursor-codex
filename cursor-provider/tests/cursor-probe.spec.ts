import { describe, expect, it } from 'vitest'
import { probeFailureOutcome } from '../src/cursor-probe.js'

describe('Cursor catalog probe failure classification', () => {
  it('preserves CURSOR_CATALOG_EMPTY instead of rewriting it to transient transport', () => {
    const outcome = probeFailureOutcome(new Error('CURSOR_CATALOG_EMPTY: Cursor ACP returned no models'), '', false)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('CURSOR_CATALOG_EMPTY: Cursor ACP returned no models')
  })

  it('keeps genuine unclassified transport failures transient', () => {
    const outcome = probeFailureOutcome(new Error('agent stream failed'), '', false)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('CURSOR_TRANSPORT: Cursor ACP catalog probe failed')
  })

  it('maps authentication evidence to an unauthenticated result', () => {
    expect(probeFailureOutcome(new Error('agent stream failed'), 'please sign in to continue', false))
      .toEqual({ authenticated: false, models: [] })
  })

  it('maps protocol evidence to an incompatible-ACP failure', () => {
    const outcome = probeFailureOutcome(new Error('unsupported protocol version'), '', false)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('INCOMPATIBLE_CURSOR_ACP: Cursor ACP catalog protocol failed')
  })

  it('classifies deadline kills as CURSOR_TIMEOUT', () => {
    const outcome = probeFailureOutcome(new Error('agent stream failed'), '', true)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('CURSOR_TIMEOUT: Cursor ACP catalog probe timed out')
  })
})
