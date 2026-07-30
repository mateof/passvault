import { describe, expect, it } from 'vitest'
import { createTranslator, translate } from '@passvault/i18n'

describe('formatting a message', () => {
  it('returns the Galician text by default', () => {
    expect(translate('gl', 'payment.state.PAID')).toBe('Pagada')
  })

  it('returns the Spanish text when asked', () => {
    expect(translate('es', 'assignment.state.PROVISIONAL')).toBe('Pendiente de confirmar')
  })

  it('returns the English text when asked', () => {
    expect(translate('en', 'assignment.state.PROVISIONAL')).toBe('Awaiting confirmation')
  })

  it('substitutes a value', () => {
    expect(translate('en', 'share.lan.compareCode', { code: '048213' })).toContain('048213')
  })

  it('uses the singular form for one', () => {
    expect(translate('gl', 'event.ticketCount', { count: 1 })).toBe('1 entrada')
  })

  it('uses the plural form for several', () => {
    expect(translate('gl', 'event.ticketCount', { count: 4 })).toBe('4 entradas')
  })

  it('uses the exact-zero form rather than a plural with a zero in it', () => {
    expect(translate('gl', 'event.ticketCount', { count: 0 })).toBe('sen entradas')
  })

  it('pluralises Spanish independently of Galician', () => {
    expect(translate('es', 'event.ticketCount', { count: 0 })).toBe('sin entradas')
  })

  it('pluralises English independently', () => {
    expect(translate('en', 'event.ticketCount', { count: 1 })).toBe('1 ticket')
  })

  it('formats a date in the reader language', () => {
    const formatted = translate('en', 'registration.invitation.body', {
      inviter: 'Mateo',
      link: 'https://example.org/i/abc',
      expiresAt: new Date('2026-08-14T19:00:00Z'),
    })

    expect(formatted).toContain('Aug')
  })
})

describe('a message whose values are missing', () => {
  it('returns text rather than throwing, because these are formatted while handling errors', () => {
    expect(() => translate('en', 'auth.error.tooManyAttempts')).not.toThrow()
  })
})

describe('a translator bound to a locale', () => {
  it('reports the locale it was created for', () => {
    expect(createTranslator('es').locale).toBe('es')
  })

  it('formats without repeating the locale at every call', () => {
    const { t } = createTranslator('es')

    expect(t('payment.state.UNPAID')).toBe('Sin pagar')
  })
})

describe('the messages that carry the product decisions', () => {
  it('tells the user an export cannot be taken back', () => {
    expect(translate('gl', 'share.export.noRevocation')).toContain('Non se pode retirar')
  })

  it('explains that an offline claim is not final yet', () => {
    expect(translate('en', 'claim.provisional.explain')).toContain('not final yet')
  })

  it('explains why the vault passphrase is separate from the password', () => {
    expect(translate('es', 'vault.explain.twoSecrets')).toContain('Google')
  })

  it('warns that being on the same network identifies nobody', () => {
    expect(translate('en', 'share.lan.warning.publicNetwork')).toContain('identifies nobody')
  })
})
