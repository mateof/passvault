import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, type Me } from './api/passvault'
import { onUnauthenticated, setToken } from './api/client'
import { useT } from './i18n'

/**
 * Who is signed in, and whether their vault is open.
 *
 * Two separate facts, deliberately, because the design keeps them separate: signing in proves
 * who you are and opening the vault decrypts your data. A session with a locked vault is a
 * normal state the interface has to render, not an error — it is what every reload produces,
 * since the key lives in the server process's memory and nowhere else.
 */

interface Session {
  me: Me | undefined
  ready: boolean
  signedIn: boolean
  signIn: (token: string) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const SessionContext = createContext<Session | undefined>(undefined)

export function SessionProvider({ children }: { children: ReactNode }) {
  const { locale } = useT()
  const [me, setMe] = useState<Me | undefined>()
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me(locale))
    } catch {
      setMe(undefined)
    } finally {
      setReady(true)
    }
  }, [locale])

  useEffect(() => {
    // A 401 from anywhere drops the session here rather than at each call site, so an expired
    // session shows the sign-in screen instead of a wallet that has quietly stopped loading.
    onUnauthenticated(() => setMe(undefined))
  }, [])

  /**
   * Asks the server who this is, once, when the page loads.
   *
   * This is what makes a refresh survivable. The session lives in an httpOnly cookie the browser
   * sends on its own, so the answer is either an account or a 401 — but nothing asked, so every
   * F5 landed on the sign-in screen with a perfectly good session sitting on the server, and the
   * open vault behind it thrown away for nothing.
   *
   * `refresh` is deliberately not a dependency. It changes with the locale, and re-running this on
   * a language change would be a second identity check for a decision about words.
   */
  useEffect(() => {
    void refresh()
  }, [])

  const signIn = useCallback(
    async (token: string) => {
      setToken(token)
      await refresh()
    },
    [refresh],
  )

  const signOut = useCallback(async () => {
    // Told to the server as well as forgotten here. Dropping the token locally leaves a
    // session alive on the server until it expires, which is not what "sign out" means — and
    // now also leaves a cookie behind, which would read as still being signed in.
    await api.logout(locale).catch(() => undefined)
    setToken(undefined)
    setMe(undefined)
  }, [locale])

  const value = useMemo<Session>(
    () => ({ me, ready, signedIn: me !== undefined, signIn, signOut, refresh }),
    [me, ready, signIn, signOut, refresh],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const value = useContext(SessionContext)
  if (!value) {
    throw new Error('useSession was called outside the provider')
  }
  return value
}
