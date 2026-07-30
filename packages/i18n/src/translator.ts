import { IntlMessageFormat } from 'intl-messageformat'
import { CATALOGUES, DEFAULT_LOCALE, type Locale, type MessageKey } from './locales.js'

export type MessageValues = Record<string, string | number | Date | boolean | null | undefined>

export interface Translator {
  locale: Locale
  t: (key: MessageKey, values?: MessageValues) => string
}

/**
 * Compiled messages are cached per locale and key.
 *
 * Parsing an ICU pattern is not free and error messages are formatted on paths that are
 * already handling a failure, which is the worst place to add work.
 */
const compiled = new Map<string, IntlMessageFormat>()

function formatterFor(locale: Locale, key: MessageKey): IntlMessageFormat {
  const cacheKey = `${locale}:${key}`
  const existing = compiled.get(cacheKey)
  if (existing) {
    return existing
  }
  const pattern = CATALOGUES[locale][key]
  const formatter = new IntlMessageFormat(pattern, locale)
  compiled.set(cacheKey, formatter)
  return formatter
}

export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  try {
    return String(formatterFor(locale, key).format(values as never))
  } catch (cause) {
    // A pattern that needs a value the caller did not pass would otherwise throw from
    // inside an error handler, replacing a useful message with a stack trace. Falling
    // back to the raw pattern keeps the failure visible without losing the response.
    if (locale !== DEFAULT_LOCALE) {
      return translate(DEFAULT_LOCALE, key, values)
    }
    return CATALOGUES[DEFAULT_LOCALE][key]
  }
}

export function createTranslator(locale: Locale): Translator {
  return {
    locale,
    t: (key, values) => translate(locale, key, values),
  }
}

/** The placeholder names an ICU pattern requires, used by the catalogue completeness test. */
export function placeholdersOf(pattern: string): string[] {
  const found = new Set<string>()
  for (const match of pattern.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)) {
    if (match[1]) {
      found.add(match[1])
    }
  }
  return [...found].sort()
}
