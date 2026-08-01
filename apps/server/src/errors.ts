import type { MessageKey, MessageValues } from '@passvault/i18n'

/**
 * An error with a translated message and an HTTP status.
 *
 * The message key rather than a string, so nothing user-facing is written in English inside
 * a handler and then shipped untranslated. If a failure needs new wording, it needs a new
 * catalogue entry, which the catalogue tests then require in all three languages.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly messageKey: MessageKey,
    readonly values?: MessageValues,
    options?: { cause?: unknown },
  ) {
    super(`${messageKey} (${status})`, options)
    this.name = 'AppError'
  }
}

export const badRequest = (key: MessageKey, values?: MessageValues): AppError =>
  new AppError(400, key, values)

export const unauthorized = (key: MessageKey, values?: MessageValues): AppError =>
  new AppError(401, key, values)

export const forbidden = (key: MessageKey = 'error.forbidden'): AppError => new AppError(403, key)

/**
 * 423: it exists and there is a key that opens it.
 *
 * Distinct from 401 on purpose, and the distinction is what two clients were tripping over. A
 * 401 means the session is not valid — the person has to prove who they are again. A locked
 * vault or a password-protected event is the opposite situation: the session is fine, the
 * server merely lacks a decryption secret only the user holds. Both clients treated any 401 as
 * "signed out", so every server restart (which empties the in-memory vault cache, by design)
 * looked like being logged out of everything.
 */
export const locked = (key: MessageKey, values?: MessageValues): AppError =>
  new AppError(423, key, values)

export const notFound = (key: MessageKey = 'error.notFound'): AppError => new AppError(404, key)

export const conflict = (key: MessageKey, values?: MessageValues): AppError =>
  new AppError(409, key, values)

export const tooManyRequests = (key: MessageKey, values?: MessageValues): AppError =>
  new AppError(429, key, values)
