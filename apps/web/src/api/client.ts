/**
 * The one place the browser talks to the server.
 *
 * Every call goes through here so four things are true everywhere rather than in most places:
 * the bearer token is attached, a failure arrives as a typed error carrying the server's
 * translated message, an expired access token is quietly refreshed before the caller ever sees
 * it, and a 401 that survives that tears the session down instead of leaving the interface
 * pretending to be logged in.
 *
 * The access token lives in memory, not in `localStorage`. A token in local storage is readable
 * by any script injected into the page, and this one opens a wallet of bearer tickets. The
 * refresh token is never in memory at all: it is an httpOnly cookie the browser sends only to the
 * refresh endpoint, so no script here can read it. When the short access token expires, the
 * refresh happens against that cookie and the caller sees a brief pause, not a logout.
 */

let token: string | undefined
let onSessionLost: (() => void) | undefined

/** In-flight refresh, so a burst of 401s triggers one exchange rather than a stampede of them. */
let refreshing: Promise<boolean> | null = null

/**
 * Trades the refresh cookie for a new access token, once at a time.
 *
 * The refresh token rides in an httpOnly cookie scoped to this path, so there is nothing to pass
 * — the browser attaches it. Success updates the in-memory access token; failure means the
 * refresh token is spent or gone, which is a real sign-out.
 */
async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const response = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (!response.ok) {
          return false
        }
        const body = (await response.json().catch(() => undefined)) as { token?: string } | undefined
        if (body?.token) {
          token = body.token
        }
        return true
      } catch {
        return false
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

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
  const send = (): Promise<Response> => {
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

    return fetch(path, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
    })
  }

  let response = await send()

  // The access token may simply have aged out. Refresh once against the cookie and retry before
  // treating a 401 as a real sign-out — the whole point of the short access token is that its
  // expiry is a pause, not a logout. The refresh endpoint itself is exempt, or a failed refresh
  // would try to refresh itself forever.
  if (response.status === 401 && path !== '/api/v1/auth/refresh' && (await refreshAccessToken())) {
    response = await send()
  }

  if (response.status === 401) {
    // Still gone after a refresh attempt. Clearing it here rather than at each call site is what
    // stops an expired session showing an empty wallet instead of a login.
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
