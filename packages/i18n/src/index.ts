export {
  CATALOGUES,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  narrowToSupported,
  type Catalogue,
  type Locale,
  type MessageKey,
} from './locales.js'
export { en } from './messages/en.js'
export { es } from './messages/es.js'
export { gl } from './messages/gl.js'
export { negotiateLocale, resolveLocale } from './negotiate.js'
export {
  createTranslator,
  placeholdersOf,
  translate,
  type MessageValues,
  type Translator,
} from './translator.js'
