/**
 * The one place the browser talks to the server.
 *
 * Every call goes through here so three things are true everywhere rather than in most
 * places: the bearer token is attached, a failure arrives as a typed error carrying the
 * server's translated message, and a 401 tears the session down instead of leaving the
 * interface pretending to be logged in.
 *
 * The token lives in memory, not in `localStorage`. A token in local storage is readable by
 * any script that gets injected into the page, and this one opens a wallet of bearer tickets.
 * The cost is that a refresh logs you out, which is the right trade for what it protects.
 */

let token: string | undefined
let onSessionLost: (() => void) | undefined

export function setToken(value: string | undefined): void {
  token = value
}

export function hasToken(): boolean {
  return token !== undefined
}

export function onUnauthenticated(handler: () => void): void {
  onSessionLost = handler
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The server's own message, already in the caller's language. */
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /**
   * Sent as raw bytes with the file's own content type, which is what the server parses.
   *
   * Not multipart. `@fastify/multipart` is a dependency there but was never registered, so every
   * upload this interface made came back as an unsupported media type — the file simply never
   * arrived. The server has always taken the bytes directly.
   */
  binary?: { file: Blob; headers?: Record<string, string> }
  /** Expect bytes rather than JSON, which is what an export returns. */
  blob?: boolean
  locale?: string
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  // Asked for in the user's language, so a validation failure comes back translated by the
  // side that owns the wording rather than being re-worded here from a code.
  if (options.locale) {
    headers['accept-language'] = options.locale
  }

  let body: BodyInit | undefined
  if (options.binary) {
    // `application/octet-stream` when the browser could not tell: the server sniffs the bytes
    // themselves to decide what a document is, so an honest fallback beats a guess.
    headers['content-type'] = options.binary.file.type || 'application/octet-stream'
    Object.assign(headers, options.binary.headers ?? {})
    body = options.binary.file
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  const response = await fetch(path, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  })

  if (response.status === 401) {
    // The session is gone whatever the caller was doing. Clearing it here rather than at each
    // call site is what stops an expired session showing an empty wallet instead of a login.
    token = undefined
    onSessionLost?.()
  }

  if (!response.ok) {
    const problem = await response.json().catch(() => undefined)
    throw new ApiError(
      response.status,
      problem?.message ?? problem?.error ?? `${response.status} ${response.statusText}`,
      problem?.code,
    )
  }

  if (options.blob) {
    return (await response.blob()) as T
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
