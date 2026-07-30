import { IntlMessageFormat } from 'intl-messageformat'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { WEB_CATALOGUES, type WebMessageKey } from './messages'

/**
 * Which language the interface speaks.
 *
 * Galician by default and as the fallback, which is the project's rule everywhere: this is a
 * Galician application with translations, not an English one. The negotiation order is a
 * choice the user made, then what the browser asks for, then Galician.
 *
 * ICU MessageFormat rather than interpolation, because Galician and Spanish plurals need it —
 * «1 entradas» is what a template string produces and it is wrong in every language here.
 */

export type Locale = 'gl' | 'es' | 'en'

export const LOCALES: readonly Locale[] = ['gl', 'es', 'en']
export const DEFAULT_LOCALE: Locale = 'gl'

export const LOCALE_NAMES: Record<Locale, string> = {
  gl: 'Galego',
  es: 'Castellano',
  en: 'English',
}

const STORED = 'passvault.locale'

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

function negotiate(): Locale {
  const chosen = localStorage.getItem(STORED)
  if (chosen && isLocale(chosen)) {
    return chosen
  }
  for (const tag of navigator.languages ?? []) {
    // The base tag, so `es-AR` finds `es` rather than falling through to the default.
    const base = tag.split('-')[0]?.toLowerCase() ?? ''
    if (isLocale(base)) {
      return base
    }
  }
  return DEFAULT_LOCALE
}

export type Values = Record<string, string | number | boolean | Date | null | undefined>

interface Translation {
  locale: Locale
  t: (key: WebMessageKey, values?: Values) => string
  setLocale: (locale: Locale) => void
}

const TranslationContext = createContext<Translation | undefined>(undefined)

// Compiling an ICU pattern is not free, and these are formatted during render.
const compiled = new Map<string, IntlMessageFormat>()

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(negotiate)

  const value = useMemo<Translation>(
    () => ({
      locale,
      setLocale: (next) => {
        localStorage.setItem(STORED, next)
        setLocale(next)
      },
      t: (key, values) => {
        const pattern = WEB_CATALOGUES[locale][key] ?? WEB_CATALOGUES[DEFAULT_LOCALE][key]
        if (!values) {
          return pattern
        }
        const cacheKey = `${locale}:${key}`
        let formatter = compiled.get(cacheKey)
        if (!formatter) {
          formatter = new IntlMessageFormat(pattern, locale)
          compiled.set(cacheKey, formatter)
        }
        return String(formatter.format(values))
      },
    }),
    [locale],
  )

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>
}

export function useT(): Translation {
  const value = useContext(TranslationContext)
  if (!value) {
    throw new Error('useT was called outside the provider')
  }
  return value
}
