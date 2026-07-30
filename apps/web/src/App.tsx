import { useEffect, useState } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api } from './api/passvault'
import { I18nProvider, LOCALES, LOCALE_NAMES, useT, type Locale } from './i18n'
import { SessionProvider, useSession } from './session'
import { Banner, Button, Card, Field, Form, Loading, Select } from './ui'
import { EventPage, EventsPage } from './events'
import { AccountPage, AdminPage } from './account'

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
  const [pending, setPending] = useState<string>()
  const [code, setCode] = useState('')
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    api
      .providers(locale)
      .then((result) => setProviders(result.providers ?? []))
      // A server with no delegated login configured is the ordinary case, not a failure worth
      // showing: the password form works either way.
      .catch(() => setProviders([]))
  }, [locale])

  if (pending) {
    return (
      <Card title={t('login.secondFactor')}>
        <Form
          submitLabel={t('login.submit')}
          onSubmit={async () => {
            const result = await api.secondFactor(locale, pending, code)
            if (result.token) await signIn(result.token)
          }}
        >
          <p>{t('login.secondFactorHelp')}</p>
          <Field label={t('login.secondFactor')} value={code} onChange={setCode} required />
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
          } else if (result.secondFactorToken) {
            setPending(result.secondFactorToken)
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

      {providers.length > 0 ? (
        <div className="providers">
          <p>{t('login.orProvider')}</p>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              variant="quiet"
              onClick={async () => {
                const start = await fetch(`/api/v1/auth/oidc/${provider.id}/start`, {
                  method: 'POST',
                })
                const { authorizationUrl } = await start.json()
                // A full navigation, not a fetch. The provider has to see the browser.
                window.location.href = authorizationUrl
              }}
            >
              {provider.name}
            </Button>
          ))}
        </div>
      ) : null}

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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
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
          required
        />
        <Field
          label={t('vault.passphrase')}
          value={passphrase}
          onChange={setPassphrase}
          type="password"
          autoComplete="new-password"
          help={t('vault.setWarning')}
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
 * The second gate.
 *
 * The explanation is on the screen rather than in a help page because two secrets is the part
 * of this design a user is most likely to find baffling, and the moment they are asked for the
 * second one is the moment the explanation is worth reading.
 */
function VaultGate() {
  const { t, locale } = useT()
  const { refresh } = useSession()
  const [passphrase, setPassphrase] = useState('')

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

function Shell() {
  const { t, locale } = useT()
  const { me, signOut, refresh } = useSession()

  return (
    <div className="shell">
      <header className="top">
        <Link className="brand" to="/">
          {t('appName')}
        </Link>
        <nav>
          <Link to="/">{t('nav.events')}</Link>
          <Link to="/account">{t('nav.account')}</Link>
          {me?.isAdmin ? <Link to="/admin">{t('nav.admin')}</Link> : null}
          <button
            className="link"
            onClick={async () => {
              await api.lockVault(locale).catch(() => undefined)
              await refresh()
            }}
          >
            {t('vault.lock')}
          </button>
          <button className="link" onClick={signOut}>
            {t('nav.signOut')}
          </button>
        </nav>
      </header>

      <main>
        {me?.vaultUnlocked ? (
          <Routes>
            <Route path="/" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <VaultGate />
        )}
      </main>
    </div>
  )
}

function Gate() {
  const { ready, signedIn } = useSession()
  if (!ready) return <Loading />
  if (!signedIn) {
    return (
      <div className="shell">
        <main>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<LoginPage />} />
          </Routes>
        </main>
      </div>
    )
  }
  return <Shell />
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
