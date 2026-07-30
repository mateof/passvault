import { useEffect, useState } from 'react'
import { api } from './api/passvault'
import { useT, LOCALES, LOCALE_NAMES, type Locale } from './i18n'
import { useSession } from './session'
import { Banner, Button, Card, Field, Form, Loading, Select } from './ui'

/**
 * The account, and the server's own settings for whoever administers it.
 *
 * Passkeys are listed and removable but not enrolled here: enrolling one needs the WebAuthn
 * ceremony, and a button that opens a browser prompt and then fails because the origin does
 * not match is worse than a button that is not there. It is noted as missing rather than
 * half-built.
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

export function AdminPage() {
  const { t, locale } = useT()
  const { me } = useSession()
  const [mode, setMode] = useState('CLOSED')
  const [email, setEmail] = useState('')
  const [invited, setInvited] = useState<string>()

  useEffect(() => {
    api
      .registrationSettings(locale)
      .then((settings) => setMode(settings.mode))
      .catch(() => undefined)
  }, [locale])

  if (!me?.isAdmin) return <Banner kind="info">{t('common.empty')}</Banner>

  return (
    <>
      <Card title={t('admin.title')}>
        <Form
          submitLabel={t('action.save')}
          onSubmit={async () => {
            await api.registrationSettingsUpdate(locale, { mode })
          }}
        >
          <Select
            label={t('admin.registrationMode')}
            value={mode}
            options={['OPEN', 'INVITATION', 'WHITELIST', 'CLOSED'].map((value) => ({
              value,
              label: value,
            }))}
            onChange={setMode}
          />
        </Form>
      </Card>

      <Card title={t('admin.invite')}>
        <Form
          submitLabel={t('admin.invite')}
          onSubmit={async () => {
            const result = await api.invite(locale, email)
            setInvited(result.token ?? '')
            setEmail('')
          }}
        >
          <Field label={t('admin.email')} value={email} onChange={setEmail} type="email" required />
        </Form>
        {invited !== undefined ? (
          <Banner kind="success">
            {invited ? <code>{invited}</code> : t('action.confirm')}
          </Banner>
        ) : null}
      </Card>

      <Card title={t('admin.whitelist')}>
        <Form
          submitLabel={t('admin.whitelist')}
          onSubmit={async () => {
            await api.whitelist(locale, email)
            setEmail('')
          }}
        >
          <Field label={t('admin.email')} value={email} onChange={setEmail} type="email" required />
        </Form>
      </Card>
    </>
  )
}
