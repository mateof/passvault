import { useEffect, useState } from 'react'
import { api, MINIMUM_PASSPHRASE_LENGTH } from './api/passvault'
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

      <Card title={t('account.passkeys')}>
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
      </Card>
    </>
  )
}

