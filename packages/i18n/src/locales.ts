import { en } from './messages/en.js'
import { es } from './messages/es.js'
import { gl, type Catalogue, type MessageKey } from './messages/gl.js'

export type Locale = 'gl' | 'es' | 'en'

export const SUPPORTED_LOCALES: readonly Locale[] = ['gl', 'es', 'en']

/**
 * Galician is the default, and also the fallback for a language nobody asked for.
 *
 * The alternative — falling back to English for unrecognised locales — is the usual
 * choice and was deliberately not made here: this is a Galician-first product, and the
 * default should reflect that rather than treating Galician as a translation of an
 * English original.
 */
export const DEFAULT_LOCALE: Locale = 'gl'

export const CATALOGUES: Record<Locale, Catalogue> = { gl, es, en }

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * Reduces a BCP 47 tag to a supported locale: `gl-ES` and `gl` both become `gl`.
 * Returns undefined rather than a default, so the caller can distinguish "asked for
 * something we do not have" from "asked for nothing".
 */
export function narrowToSupported(tag: string): Locale | undefined {
  const primary = tag.trim().toLowerCase().split('-')[0]
  return primary && isLocale(primary) ? primary : undefined
}

export type { Catalogue, MessageKey }
