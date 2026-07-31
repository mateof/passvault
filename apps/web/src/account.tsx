import { useEffect, useState } from 'react'
import { api, MINIMUM_PASSPHRASE_LENGTH } from './api/passvault'
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
