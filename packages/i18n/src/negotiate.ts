import { DEFAULT_LOCALE, narrowToSupported, type Locale } from './locales.js'

interface Preference {
  tag: string
  quality: number
}

/**
 * Picks a locale from an `Accept-Language` header.
 *
 * Quality values are honoured, and equal qualities keep header order, which is what a
 * browser means by listing them. Anything unparseable is skipped rather than failing the
 * request: a malformed header is not a reason to refuse to answer.
 */
export function negotiateLocale(
  acceptLanguage: string | undefined | null,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  for (const preference of parsePreferences(acceptLanguage)) {
    if (preference.tag === '*') {
      return fallback
    }
    const narrowed = narrowToSupported(preference.tag)
    if (narrowed) {
      return narrowed
    }
  }
  return fallback
}

function parsePreferences(header: string | undefined | null): Preference[] {
  if (!header) {
    return []
  }
  const preferences: Preference[] = []
  for (const [index, part] of header.split(',').entries()) {
    const [tag, ...parameters] = part.split(';').map((piece) => piece.trim())
    if (!tag) {
      continue
    }
    const quality = qualityOf(parameters)
    if (quality <= 0) {
      // q=0 means "explicitly not this one".
      continue
    }
    // The index keeps a stable sort within one quality level, since Array.sort is only
    // guaranteed stable for the comparator's ties in modern engines and being explicit
    // costs nothing.
    preferences.push({ tag, quality: quality - index * 1e-6 })
  }
  return preferences.sort((left, right) => right.quality - left.quality)
}

function qualityOf(parameters: string[]): number {
  for (const parameter of parameters) {
    const match = /^q=([\d.]+)$/i.exec(parameter)
    if (match?.[1]) {
      const parsed = Number.parseFloat(match[1])
      return Number.isFinite(parsed) ? parsed : 1
    }
  }
  return 1
}

/**
 * The locale for a request, in the order that respects what the user chose.
 *
 * A stored preference wins over the header: someone who set the interface to Galician on
 * a phone configured in Spanish means it. The header is only a guess about a first visit.
 */
export function resolveLocale(options: {
  storedPreference?: string | null
  acceptLanguage?: string | null
}): Locale {
  const stored = options.storedPreference ? narrowToSupported(options.storedPreference) : undefined
  return stored ?? negotiateLocale(options.acceptLanguage)
}
