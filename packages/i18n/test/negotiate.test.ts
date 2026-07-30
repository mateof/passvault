import { describe, expect, it } from 'vitest'
import { negotiateLocale, resolveLocale } from '@passvault/i18n'

describe('choosing a locale from Accept-Language', () => {
  it('honours a plain Galician request', () => {
    expect(negotiateLocale('gl')).toBe('gl')
  })

  it('narrows a regional tag to the language', () => {
    expect(negotiateLocale('es-AR')).toBe('es')
  })

  it('honours quality values over header order', () => {
    expect(negotiateLocale('en;q=0.4, es;q=0.9')).toBe('es')
  })

  it('keeps header order when qualities are equal', () => {
    expect(negotiateLocale('en, es')).toBe('en')
  })

  it('skips a language it does not have', () => {
    expect(negotiateLocale('fr-FR, en-GB;q=0.8')).toBe('en')
  })

  it('falls back to Galician for a language nobody supports', () => {
    expect(negotiateLocale('ja, ko;q=0.5')).toBe('gl')
  })

  it('falls back to Galician for a missing header', () => {
    expect(negotiateLocale(undefined)).toBe('gl')
  })

  it('falls back to Galician for a wildcard', () => {
    expect(negotiateLocale('*')).toBe('gl')
  })

  it('ignores a language explicitly refused with q=0', () => {
    expect(negotiateLocale('es;q=0, en;q=0.5')).toBe('en')
  })

  it('answers rather than failing on a malformed header', () => {
    expect(negotiateLocale(';;;q=')).toBe('gl')
  })

  it('is case-insensitive about tags', () => {
    expect(negotiateLocale('ES-es')).toBe('es')
  })
})

describe('resolving the locale for a request', () => {
  it('prefers a stored preference over the header', () => {
    expect(resolveLocale({ storedPreference: 'gl', acceptLanguage: 'es-ES' })).toBe('gl')
  })

  it('uses the header when there is no stored preference', () => {
    expect(resolveLocale({ storedPreference: null, acceptLanguage: 'en-US' })).toBe('en')
  })

  it('ignores a stored preference the build no longer supports', () => {
    expect(resolveLocale({ storedPreference: 'pt', acceptLanguage: 'es' })).toBe('es')
  })
})
