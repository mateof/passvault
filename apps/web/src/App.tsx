import { useEffect, useState } from 'react'
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { api, MINIMUM_PASSPHRASE_LENGTH, MINIMUM_PASSWORD_LENGTH } from './api/passvault'
import { I18nProvider, LOCALES, LOCALE_NAMES, useT, type Locale } from './i18n'
import { SessionProvider, useSession } from './session'
import { Banner, Button, Card, Field, Form, Loading, Select } from './ui'
import { Icon, type IconName } from './icons'
import { ApiError } from './api/client'
import { passkeysSupported, usePasskey } from './api/webauthn'
import { EventPage, EventsPage } from './events'
import { GroupsPage } from './groups'
import { NoticesPage, useUnreadCount } from './notices'
import { TagsPage } from './tags'
import { AccountPage } from './account'
import { AdminPage } from './admin'

/**
 * The shell, and the two gates in front of it.
 *
 * Signing in and opening the vault are separate gates because they are separate facts. A user
 * with a valid session and a locked vault sees the second gate, not an error and not an empty
 * wallet — and that is the ordinary state after every reload, since the key that decrypts
 * their data lives only in the server process's memory.
 */

function LanguagePicker() {
  const { locale, setLocale, t } = useT()
  return (
    <Select<Locale>
      label={t('account.language')}
      value={locale}
      options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))}
      onChange={setLocale}
    />
  )
}

function LoginPage() {
  const { t, locale } = useT()
  const { signIn } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // The challenge the server hands back when it wants a second factor, with the methods it
  // will accept. Both travel back in the next request, which is what the server's shape
  // requires — an earlier version sent neither and the code field silently did nothing.
  const [pending, setPending] = useState<{ challenge: string; methods: ('totp' | 'email')[] }>()
  const [code, setCode] = useState('')
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    api
      .providers(locale)
      .then((result) => setProviders(result.providers ?? []))
      // A server with no delegated login configured is the ordinary case, not a failure worth
      // showing: the password form works either way.
      .catch(() => setProviders([]))
  }, [locale])

  /**
   * Signing in with a passkey.
   *
   * No email is asked for first. The options are discoverable — the server registers resident
   * credentials — so the authenticator knows which account it holds and the user picks it in the
   * system sheet rather than typing an address the browser is about to ignore.
   */
  const signInWithPasskey = async () => {
    setFailure(undefined)
    try {
      const options = await api.passkeyLoginOptions(locale)
      const assertion = await usePasskey(options as never)
      // Null is the user closing the sheet. Changing their mind is not an error.
      if (!assertion) return
      const result = await api.passkeyLogin(locale, assertion)
      if (result.token) await signIn(result.token)
    } catch (cause) {
      setFailure(cause instanceof ApiError ? cause.message : t('login.passkeyFailed'))
    }
  }

  if (pending) {
    const method = pending.methods.includes('totp') ? 'totp' : 'email'
    return (
      <Card title={t('login.secondFactor')}>
        <Form
          submitLabel={t('login.submit')}
          onSubmit={async () => {
            const result = await api.secondFactor(locale, pending.challenge, code, method)
            if (result.token) await signIn(result.token)
          }}
        >
          <p>{method === 'totp' ? t('login.secondFactorApp') : t('login.secondFactorHelp')}</p>
          <Field
            label={t('login.secondFactor')}
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            required
          />
        </Form>
      </Card>
    )
  }

  return (
    <Card title={t('login.title')}>
      <Form
        submitLabel={t('login.submit')}
        onSubmit={async () => {
          const result = await api.login(locale, email, password)
          if (result.token) {
            await signIn(result.token)
          } else if (result.challenge) {
            setPending({ challenge: result.challenge, methods: result.methods ?? ['email'] })
          }
        }}
      >
        <Field
          label={t('login.email')}
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="username"
          required
        />
        <Field
          label={t('login.password')}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="current-password"
          required
        />
      </Form>

      {failure ? <Banner kind="error">{failure}</Banner> : null}

      <div className="providers">
        {passkeysSupported() ? (
          <Button variant="quiet" icon="key" onClick={() => void signInWithPasskey()}>
            {t('login.passkey')}
          </Button>
        ) : null}

        {providers.length > 0 ? (
          <>
            <p className="muted">{t('login.orProvider')}</p>
            {providers.map((provider) => (
              <Button
                key={provider.id}
                variant="quiet"
                onClick={async () => {
                  try {
                    // The callback screen of this application, which is also what has to be
                    // registered with the provider. Sending none at all is what made every one
                    // of these buttons answer 400.
                    const { authorizationUrl } = await api.oidcStart(
                      locale,
                      provider.id,
                      `${window.location.origin}/auth/callback`,
                    )
                    // A full navigation, not a fetch. The provider has to see the browser.
                    window.location.href = authorizationUrl
                  } catch (cause) {
                    setFailure(cause instanceof ApiError ? cause.message : t('error.unexpected'))
                  }
                }}
              >
                {provider.name}
              </Button>
            ))}
          </>
        ) : null}
      </div>

      <p className="muted">
        <Link to="/register">{t('login.needAccount')}</Link>
      </p>
      <LanguagePicker />
    </Card>
  )
}

function RegisterPage() {
  const { t, locale } = useT()
  const navigate = useNavigate()
  // An invitation arrives as a link, so the code is already in the address bar. Making somebody
  // copy it out of their own URL is the sort of small friction that turns into a support message.
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [invitationCode, setInvitationCode] = useState(params.get('invitation') ?? '')
  const [mode, setMode] = useState<string>()
  // A closed server still accepts its first administrator, or nobody could ever configure it.
  // Reading only `mode` locked the very first user out of a fresh install, which is exactly
  // the state every fresh install is in.
  const [firstAdmin, setFirstAdmin] = useState(false)
  const [recovery, setRecovery] = useState<{ code: string; warning?: string }>()

  useEffect(() => {
    api
      .registrationSettings(locale)
      .then((settings) => {
        setMode(settings.mode)
        setFirstAdmin(settings.acceptingFirstAdmin)
      })
      .catch(() => setMode('CLOSED'))
  }, [locale])

  if (mode === undefined) return <Loading />

  // Shown once and never again, which is what the server says when it sends it. Sending the
  // user straight to the sign-in screen with this on it would be handing them something they
  // cannot get back and then taking it away.
  if (recovery) {
    return (
      <Card title={t('vault.recoveryCode')}>
        <Banner kind="warning">{recovery.warning ?? t('vault.setWarning')}</Banner>
        <p className="barcode">{recovery.code}</p>
        <Button onClick={() => navigate('/login')}>{t('login.submit')}</Button>
      </Card>
    )
  }

  if (mode === 'CLOSED' && !firstAdmin) {
    return (
      <Card title={t('register.title')}>
        <Banner kind="info">{t('register.closed')}</Banner>
        <Link to="/login">{t('register.haveAccount')}</Link>
      </Card>
    )
  }

  return (
    <Card title={t('register.title')}>
      {/* The two secrets, explained at the moment both are being chosen rather than later. */}
      <p className="muted">{t('vault.explain')}</p>
      <Form
        submitLabel={t('register.submit')}
        onSubmit={async () => {
          const result = await api.register(locale, {
            email,
            password,
            passphrase,
            locale,
            // Only sent when the server asked for one, so an open server is not handed a field
            // it will reject as unexpected.
            ...(mode === 'INVITATION' ? { invitationCode } : {}),
          })
          if (result.recoveryCode) {
            setRecovery({ code: result.recoveryCode, warning: result.recoveryCodeWarning })
          } else {
            navigate('/login')
          }
        }}
      >
        <Field label={t('login.email')} value={email} onChange={setEmail} type="email" required />
        <Field
          label={t('login.password')}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="new-password"
          minLength={MINIMUM_PASSWORD_LENGTH}
          help={t('rule.minChars', { min: MINIMUM_PASSWORD_LENGTH })}
          required
        />
        <Field
          label={t('vault.passphrase')}
          value={passphrase}
          onChange={setPassphrase}
          type="password"
          autoComplete="new-password"
          minLength={MINIMUM_PASSPHRASE_LENGTH}
          help={`${t('rule.minChars', { min: MINIMUM_PASSPHRASE_LENGTH })} ${t('vault.setWarning')}`}
          required
        />
        {mode === 'INVITATION' ? (
          <Field
            label={t('register.invitation')}
            value={invitationCode}
            onChange={setInvitationCode}
            required
          />
        ) : null}
      </Form>
      <p className="muted">
        <Link to="/login">{t('register.haveAccount')}</Link>
      </p>
    </Card>
  )
}

/**
 * Where a provider sends the browser back to.
 *
 * The code and state arrive as query parameters and are handed straight to the server, which is
 * the side holding the verifier and the nonce. Nothing is decided here: this screen exists because
 * OAuth needs somewhere to land, and without it the whole delegated sign-in has no way to finish.
 */
function OidcCallbackPage() {
  const { t, locale } = useT()
  const { signIn } = useSession()
  const [params] = useSearchParams()
  const [failure, setFailure] = useState<string>()

  const state = params.get('state')
  const code = params.get('code')

  useEffect(() => {
    if (!state || !code) {
      setFailure(t('login.callbackMissing'))
      return
    }
    api
      .oidcCallback(locale, state, code)
      .then((result) => signIn(result.token))
      .catch((cause) =>
        setFailure(cause instanceof ApiError ? cause.message : t('error.unexpected')),
      )
  }, [state, code, locale, signIn, t])

  return (
    <Card title={t('login.title')}>
      {failure ? <Banner kind="error">{failure}</Banner> : <Loading />}
      {failure ? <Link to="/login">{t('register.haveAccount')}</Link> : null}
    </Card>
  )
}

/**
 * Setting a password from the link an administrator sent.
 *
 * Reached signed out, from an email, and it asks for both secrets at once because both are
 * being chosen for the first time. The address is asked for as well as the token: the token
 * alone must not be enough to take over an account whose address the holder does not know,
 * and the server checks that they match.
 */
function SetPasswordPage() {
  const { t, locale } = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; warning?: string }>()
  const token = params.get('token') ?? ''

  if (recovery) {
    return (
      <Card title={t('vault.recoveryCode')}>
        <Banner kind="warning">{recovery.warning ?? t('vault.setWarning')}</Banner>
        <p className="barcode">{recovery.code}</p>
        <Button onClick={() => navigate('/login')}>{t('login.submit')}</Button>
      </Card>
    )
  }

  if (!token) {
    return (
      <Card title={t('setPassword.title')}>
        <Banner kind="error">{t('setPassword.noToken')}</Banner>
        <Link to="/login">{t('register.haveAccount')}</Link>
      </Card>
    )
  }

  return (
    <Card title={t('setPassword.title')}>
      <p className="muted">{t('setPassword.help')}</p>
      <p className="muted">{t('vault.explain')}</p>
      <Form
        submitLabel={t('setPassword.submit')}
        onSubmit={async () => {
          const result = await api.completeSetup(locale, { token, email, password, passphrase })
          if (result.recoveryCode) {
            setRecovery({ code: result.recoveryCode, warning: result.recoveryCodeWarning })
          } else {
            navigate('/login')
          }
        }}
      >
        <Field label={t('login.email')} value={email} onChange={setEmail} type="email" required />
        <Field
          label={t('login.password')}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="new-password"
          minLength={MINIMUM_PASSWORD_LENGTH}
          help={t('rule.minChars', { min: MINIMUM_PASSWORD_LENGTH })}
          required
        />
        <Field
          label={t('vault.passphrase')}
          value={passphrase}
          onChange={setPassphrase}
          type="password"
          autoComplete="new-password"
          minLength={MINIMUM_PASSPHRASE_LENGTH}
          help={`${t('rule.minChars', { min: MINIMUM_PASSPHRASE_LENGTH })} ${t('vault.setWarning')}`}
          required
        />
      </Form>
    </Card>
  )
}

/**
 * The second gate.
 *
 * The explanation is on the screen rather than in a help page because two secrets is the part
 * of this design a user is most likely to find baffling, and the moment they are asked for the
 * second one is the moment the explanation is worth reading.
 *
 * Two states, not one. An account created by an administrator, by a provider or by a passkey
 * has no vault at all until its owner chooses a passphrase, and asking such a user to "unlock"
 * is asking for a secret that has never existed — which is precisely what the first
 * administrator of a container-deployed installation would have met.
 */
function VaultGate() {
  const { t, locale } = useT()
  const { me, refresh } = useSession()
  const [passphrase, setPassphrase] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; warning?: string }>()

  if (recovery) {
    return (
      <Card title={t('vault.recoveryCode')}>
        <Banner kind="warning">{recovery.warning ?? t('vault.setWarning')}</Banner>
        <p className="barcode">{recovery.code}</p>
        <Button onClick={() => void refresh()}>{t('action.confirm')}</Button>
      </Card>
    )
  }

  if (me?.vaultConfigured === false) {
    return (
      <Card title={t('vault.setTitle')}>
        <p className="muted">{t('vault.explain')}</p>
        <Banner kind="warning">{t('vault.setWarning')}</Banner>
        <Form
          submitLabel={t('action.save')}
          onSubmit={async () => {
            const result = await api.setPassphrase(locale, passphrase)
            setPassphrase('')
            if (result.recoveryCode) {
              setRecovery({ code: result.recoveryCode, warning: result.recoveryCodeWarning })
            } else {
              await refresh()
            }
          }}
        >
          <Field
            label={t('vault.passphrase')}
            value={passphrase}
            onChange={setPassphrase}
            type="password"
            autoComplete="new-password"
            minLength={MINIMUM_PASSPHRASE_LENGTH}
            help={t('rule.minChars', { min: MINIMUM_PASSPHRASE_LENGTH })}
            required
          />
        </Form>
      </Card>
    )
  }

  return (
    <Card title={t('vault.title')}>
      <p className="muted">{t('vault.explain')}</p>
      <Form
        submitLabel={t('vault.unlock')}
        onSubmit={async () => {
          await api.unlockVault(locale, passphrase)
          await refresh()
        }}
      >
        <Field
          label={t('vault.passphrase')}
          value={passphrase}
          onChange={setPassphrase}
          type="password"
          autoComplete="current-password"
          required
        />
      </Form>
    </Card>
  )
}

/**
 * One entry in the side rail.
 *
 * `NavLink` rather than `Link` so the current screen is marked without this component knowing
 * anything about the route table — which is what stops the highlight drifting out of step with
 * where the user actually is.
 */
function NavItem({
  to,
  icon,
  label,
  end,
  badge,
}: {
  to: string
  icon: IconName
  label: string
  end?: boolean
  /** A count worth interrupting for. Absent or zero draws nothing at all. */
  badge?: number
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-link${isActive ? ' nav-link-active' : ''}`}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {badge ? <span className="badge-count">{badge}</span> : null}
    </NavLink>
  )
}

/**
 * The shell around every signed-in screen.
 *
 * A side rail on a desktop and a bar along the bottom on a phone — the same list, moved to
 * where the hand is. Locking the vault lives in it rather than on the account screen because it
 * is the one action a user wants within reach at any moment: it is what they reach for when
 * somebody else picks up the laptop.
 */
function Shell() {
  const { t, locale } = useT()
  const { me, signOut, refresh } = useSession()
  const unread = useUnreadCount()

  return (
    <div className="app">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <Icon name="ticket" size={18} />
          </span>
          {t('appName')}
        </Link>

        <nav className="nav">
          <NavItem to="/" icon="events" label={t('nav.events')} end />
          <NavItem to="/groups" icon="users" label={t('nav.groups')} />
          <NavItem to="/tags" icon="events" label={t('nav.tags')} />
          {/* The count is the point of this entry: an invitation nobody notices is a share that
              never happened, and this is the only place that can say so. */}
          <NavItem to="/notices" icon="mail" label={t('nav.notices')} badge={unread} />
          <NavItem to="/account" icon="account" label={t('nav.account')} />
          {me?.isAdmin ? <NavItem to="/admin" icon="admin" label={t('nav.admin')} /> : null}
        </nav>

        <div className="nav-spacer" />

        <div className="sidebar-footer">
          <p className="sidebar-account">
            <Icon name="account" size={16} />
            {me?.userId.slice(0, 8)}
          </p>
          <button
            className="nav-link"
            onClick={async () => {
              await api.lockVault(locale).catch(() => undefined)
              await refresh()
            }}
          >
            <Icon name="lock" />
            <span>{t('vault.lock')}</span>
          </button>
          <button className="nav-link" onClick={signOut}>
            <Icon name="signOut" />
            <span>{t('nav.signOut')}</span>
          </button>
        </div>
      </aside>

      <main className="content">
        <div className="content-inner">
          {me?.vaultUnlocked ? (
            <Routes>
              <Route path="/" element={<EventsPage />} />
              <Route path="/events/:id" element={<EventPage />} />
              <Route path="/groups" element={<GroupsPage />} />
              <Route path="/tags" element={<TagsPage />} />
              <Route path="/notices" element={<NoticesPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : (
            <VaultGate />
          )}
        </div>
      </main>
    </div>
  )
}

/** The signed-out screens, centred on a field of their own so they do not look like a page. */
function SignedOut() {
  const { t } = useT()
  return (
    <div className="gate">
      <div className="gate-inner">
        <p className="gate-brand">
          <span className="brand-mark">
            <Icon name="ticket" size={18} />
          </span>
          {t('appName')}
        </p>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          {/* Reached from a mail an administrator sent, so it has to work signed out. */}
          <Route path="/set-password" element={<SetPasswordPage />} />
          {/* Where Google and Microsoft send the browser back to. */}
          <Route path="/auth/callback" element={<OidcCallbackPage />} />
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </div>
    </div>
  )
}

function Gate() {
  const { ready, signedIn } = useSession()
  if (!ready) return <Loading />
  return signedIn ? <Shell /> : <SignedOut />
}

export default function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </BrowserRouter>
    </I18nProvider>
  )
}
