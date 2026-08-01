import { useCallback, useEffect, useState } from 'react'
import { api, MINIMUM_PASSPHRASE_LENGTH, type OpenSession } from './api/passvault'
import { ApiError } from './api/client'
import { createPasskey, passkeysSupported } from './api/webauthn'
import { useT, LOCALES, LOCALE_NAMES, type Locale } from './i18n'
import { useSession } from './session'
import { Banner, Button, Card, Field, Form, Loading, Select } from './ui'

/**
 * The account.
 *
 * Passkeys are listed and removable but not enrolled here: enrolling one needs the WebAuthn
 * ceremony, and a button that opens a browser prompt and then fails because the origin does
 * not match is worse than a button that is not there. It is noted as missing rather than
 * half-built.
 *
 * Running the server is a different job with a different audience, and lives in `admin.tsx`.
 */

export function AccountPage() {
  const { t, locale, setLocale } = useT()
  const { me } = useSession()
  const [passkeys, setPasskeys] = useState<{ id: string; name?: string; createdAt: string }[]>()
  const [enrolFailure, setEnrolFailure] = useState<string>()
  const [recovery, setRecovery] = useState<string>()
  const [passphrase, setPassphrase] = useState('')

  useEffect(() => {
    api
      .passkeys(locale)
      .then((result) => setPasskeys(result.passkeys ?? []))
      .catch(() => setPasskeys([]))
  }, [locale])

  return (
    <>
      <Card title={t('account.title')}>
        <p className="muted">{me?.userId}</p>
        <Select<Locale>
          label={t('account.language')}
          value={locale}
          options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))}
          onChange={setLocale}
        />
      </Card>

      <HandleCard />

      <SessionsCard />

      <Card title={t('vault.setTitle')}>
        <Banner kind="warning">{t('vault.setWarning')}</Banner>
        <Form
          submitLabel={t('action.save')}
          onSubmit={async () => {
            const result = await api.setPassphrase(locale, passphrase)
            setPassphrase('')
            if (result.recoveryCode) setRecovery(result.recoveryCode)
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
        {recovery ? (
          <Banner kind="success">
            {t('vault.recoveryCode')}: <code>{recovery}</code>
          </Banner>
        ) : null}
      </Card>

      <SecondFactorCard />

      <Card title={t('account.passkeys')} icon="key">
        <p className="muted">{t('account.passkeysExplain')}</p>
        {passkeys === undefined ? <Loading /> : null}
        {passkeys?.length === 0 ? <p className="muted">{t('account.noPasskeys')}</p> : null}
        <ul className="list">
          {(passkeys ?? []).map((passkey) => (
            <li key={passkey.id}>
              {passkey.name ?? passkey.id.slice(0, 8)}
              <span className="muted"> · {passkey.createdAt}</span>
              <Button
                variant="quiet"
                onClick={async () => {
                  await api.deletePasskey(locale, passkey.id)
                  setPasskeys((current) => current?.filter((one) => one.id !== passkey.id))
                }}
              >
                {t('action.close')}
              </Button>
            </li>
          ))}
        </ul>

        {passkeysSupported() ? (
          <>
            {enrolFailure ? <Banner kind="error">{enrolFailure}</Banner> : null}
            <div className="button-row">
              <Button
                icon="plus"
                onClick={async () => {
                  setEnrolFailure(undefined)
                  try {
                    const options = await api.passkeyRegisterOptions(locale)
                    const created = await createPasskey(options as never)
                    // Null is the user closing the system sheet, which is a choice rather than
                    // a failure and does not belong on screen as one.
                    if (!created) return
                    await api.passkeyRegister(locale, created, navigator.platform || undefined)
                    setPasskeys((await api.passkeys(locale)).passkeys ?? [])
                  } catch (cause) {
                    setEnrolFailure(
                      cause instanceof ApiError ? cause.message : t('login.passkeyFailed'),
                    )
                  }
                }}
              >
                {t('account.addPasskey')}
              </Button>
            </div>
          </>
        ) : (
          <p className="muted">{t('account.passkeysUnsupported')}</p>
        )}
      </Card>
    </>
  )
}

/**
 * Turning on a second factor.
 *
 * The server has had this since the beginning — a TOTP secret, a confirmation, and a setting that
 * demands one of everybody — and no client ever offered a way to enrol, so the feature existed and
 * nobody could switch it on.
 *
 * The secret is shown as text and as an `otpauth:` link rather than as a QR code. A QR would be
 * nicer on a desktop and this application has no QR encoder on the writing side; a link opens the
 * authenticator directly on the phone, which is where most people are, and the text works
 * everywhere else. Said plainly rather than dressed up as a preference.
 *
 * Nothing is armed until a code is confirmed. An unconfirmed secret never satisfies a second
 * factor, so an enrolment abandoned halfway cannot lock somebody out with a code they never
 * successfully scanned.
 */
function SecondFactorCard() {
  const { t, locale } = useT()
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string }>()
  const [code, setCode] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  if (confirmed) {
    return (
      <Card title={t('account.secondFactor')} icon="shield">
        <Banner kind="success">{t('account.secondFactorOn')}</Banner>
      </Card>
    )
  }

  return (
    <Card title={t('account.secondFactor')} icon="shield">
      <p className="muted">{t('account.secondFactorExplain')}</p>

      {!enrolment ? (
        <div className="button-row">
          <Button icon="shield" onClick={async () => setEnrolment(await api.totpEnrol(locale))}>
            {t('account.secondFactorStart')}
          </Button>
        </div>
      ) : (
        <>
          <p className="field-help">{t('account.secondFactorScan')}</p>
          <p className="barcode">{enrolment.secret}</p>
          <p className="muted">
            <a href={enrolment.uri}>{t('account.secondFactorOpen')}</a>
          </p>
          <Form
            submitLabel={t('action.confirm')}
            submitIcon="check"
            onSubmit={async () => {
              await api.totpConfirm(locale, code)
              setConfirmed(true)
            }}
          >
            <Field
              label={t('login.secondFactor')}
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
              required
            />
          </Form>
        </>
      )}
    </Card>
  )
}


/**
 * The name people can find you by.
 *
 * Everything else this account knows about somebody is encrypted; a handle deliberately is not,
 * because being findable is the whole job. An address is how you reach a person and is theirs to
 * give out; a handle is how somebody else names them to the server — "share it with ana" — and a
 * name nobody can look up is not a name.
 *
 * Optional, and stays optional. An account without one is shared with by address exactly as
 * before, which is what every account did until now.
 */
function HandleCard() {
  const { t, locale } = useT()
  const { me, refresh } = useSession()
  // Prefilled with the name you already have, which is the difference between "change my name"
  // and staring at an empty field wondering whether you ever chose one.
  const [handle, setHandle] = useState(me?.handle ?? '')
  const [taken, setTaken] = useState<boolean>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    // The session can arrive after the first render; the field follows it once, and never
    // overwrites something being typed.
    if (me?.handle && handle === '') setHandle(me.handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.handle])

  useEffect(() => {
    const trimmed = handle.trim()
    if (trimmed.length < 3) {
      setTaken(undefined)
      return
    }
    let cancelled = false
    // Debounced: this fires per keystroke and asks a question about every account on the server.
    const timer = setTimeout(() => {
      api
        .handleAvailable(locale, trimmed)
        .then((result) => {
          if (!cancelled) setTaken(result.taken)
        })
        .catch(() => {
          if (!cancelled) setTaken(undefined)
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [handle, locale])

  return (
    <Card title={t('handle.title')} icon="account">
      <p className="muted">{t('handle.explain')}</p>
      {me?.handle ? (
        <p className="muted">
          {t('handle.current')} <strong>@{me.handle}</strong>
        </p>
      ) : (
        <p className="muted">{t('handle.none')}</p>
      )}
      <Form
        submitLabel={t('handle.save')}
        submitIcon="check"
        disabled={
          handle.trim().length < 3 || (taken === true && handle.trim() !== (me?.handle ?? ''))
        }
        onSubmit={async () => {
          await api.setHandle(locale, handle.trim())
          setSaved(true)
          // The session is where every screen reads the handle from, so it has to learn too.
          await refresh()
        }}
      >
        <Field
          label={t('handle.field')}
          value={handle}
          onChange={(value) => {
            setHandle(value)
            setSaved(false)
          }}
          autoComplete="off"
          {...(taken === true ? { help: t('handle.taken') } : {})}
          {...(taken === false ? { help: t('handle.free') } : {})}
        />
      </Form>
      {saved ? <Banner kind="success">{t('handle.saved')}</Banner> : null}
    </Card>
  )
}

/**
 * Where this account is open, and how to close one.
 *
 * A session used to be invisible: it existed, it expired eventually, and the only way to end one
 * was to stop using it. A phone left in a taxi is exactly the case this has to answer, and
 * "wait for it to expire" is not an answer.
 *
 * What each row shows is what the request carried — a user agent, an address, when it was last
 * used. None of it is proof of anything, and it is presented as a way to recognise which row is
 * which rather than as a security claim.
 */
function SessionsCard() {
  const { t, locale } = useT()
  const [sessions, setSessions] = useState<OpenSession[]>()

  const load = useCallback(async () => {
    setSessions((await api.sessions(locale)).sessions)
  }, [locale])

  useEffect(() => {
    void load()
  }, [load])

  if (!sessions) return null

  return (
    <Card title={t('sessions.title')} icon="shield">
      <p className="muted">{t('sessions.subtitle')}</p>
      <ul className="list">
        {sessions.map((session) => (
          <li key={session.id} className="list-row">
            <span>
              {session.userAgent ?? t('sessions.unknownClient')}
              <span className="row-meta">
                {session.ipAddress ? ` · ${session.ipAddress}` : ''}
                {session.lastSeenAt
                  ? ` · ${t('sessions.lastSeen')} ${new Date(session.lastSeenAt).toLocaleString(locale)}`
                  : ''}
                {session.current ? ` · ${t('sessions.current')}` : ''}
              </span>
            </span>
            {/* Ending the current one is allowed and is simply signing out: somebody pressing the
                button next to the session they are using has said something perfectly clear. */}
            <Button
              variant="quiet"
              onClick={async () => {
                await api.revokeSession(locale, session.id)
                await load()
              }}
            >
              {t('sessions.revoke')}
            </Button>
          </li>
        ))}
      </ul>
      {sessions.length > 1 ? (
        <div className="button-row">
          <Button
            variant="danger"
            onClick={async () => {
              await api.revokeOtherSessions(locale)
              await load()
            }}
          >
            {t('sessions.revokeOthers')}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
