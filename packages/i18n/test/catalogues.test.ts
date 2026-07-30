import { describe, expect, it } from 'vitest'
import {
  CATALOGUES,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  gl,
  placeholdersOf,
  type Locale,
  type MessageKey,
} from '@passvault/i18n'
import { IntlMessageFormat } from 'intl-messageformat'

const keys = Object.keys(gl) as MessageKey[]
const translations = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE)

/**
 * Catalogue completeness.
 *
 * The types already make a missing key a compile error, since every translation is typed
 * as `Record<MessageKey, string>` against Galician. What the types cannot see is a
 * translation that drops a placeholder — `{code}` left out of a message about a code
 * still compiles, and produces a sentence with a hole in it.
 */
describe('the default locale', () => {
  it('is Galician', () => {
    expect(DEFAULT_LOCALE).toBe('gl')
  })

  it('has messages to translate', () => {
    expect(keys.length).toBeGreaterThan(50)
  })
})

describe.each(translations)('the %s catalogue', (locale: Locale) => {
  it('translates every key', () => {
    const missing = keys.filter((key) => !CATALOGUES[locale][key])

    expect(missing).toEqual([])
  })

  it('leaves nothing as a copy of the Galician text', () => {
    // A handful of words are legitimately identical across these languages, so this
    // checks that the catalogue is not wholesale untranslated rather than flagging each
    // coincidence.
    const identical = keys.filter((key) => CATALOGUES[locale][key] === gl[key])

    expect(identical.length).toBeLessThan(keys.length / 4)
  })

  it('uses exactly the placeholders the Galician message uses', () => {
    const mismatched = keys
      .map((key) => ({
        key,
        expected: placeholdersOf(gl[key]),
        actual: placeholdersOf(CATALOGUES[locale][key]),
      }))
      .filter((entry) => entry.expected.join(',') !== entry.actual.join(','))

    expect(mismatched).toEqual([])
  })

  it('parses as valid ICU MessageFormat', () => {
    const broken: { key: string; error: string }[] = []
    for (const key of keys) {
      try {
        new IntlMessageFormat(CATALOGUES[locale][key], locale)
      } catch (error) {
        broken.push({ key, error: String(error) })
      }
    }

    expect(broken).toEqual([])
  })
})

describe('every catalogue', () => {
  it('parses as valid ICU MessageFormat in Galician too', () => {
    const broken: string[] = []
    for (const key of keys) {
      try {
        new IntlMessageFormat(gl[key], 'gl')
      } catch {
        broken.push(key)
      }
    }

    expect(broken).toEqual([])
  })

  it('has no key without a translation in any supported locale', () => {
    const gaps = SUPPORTED_LOCALES.flatMap((locale) =>
      keys.filter((key) => !CATALOGUES[locale][key]).map((key) => `${locale}:${key}`),
    )

    expect(gaps).toEqual([])
  })
})
