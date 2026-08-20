import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type AdminInvitation,
  type AdminUser,
  type AdminWhitelistEntry,
  type AuditEntry,
  type RegistrationMode,
  type RegistrationSettings,
} from './api/passvault'
import { useT, LOCALES, LOCALE_NAMES, type Locale } from './i18n'
import { useSession } from './session'
import { Banner, Button, Card, Field, Form, Loading, Select } from './ui'
import { AuditList } from './organise'

/**
 * Running the installation.
 *
 * The four registration modes are the spine of this screen, because they are the decision that
 * determines everything else on it: an allow list is dead weight in `INVITATION` mode and
 * invitations are pointless in `OPEN`. The mode is chosen first and the rest of the screen says
 * whether it is currently doing anything.
 *
 * Everything here can also be set in the deployment file, which is what makes a fresh
 * installation usable without a browser. That is a seed, not a lock: the file wins on first
 * boot and this screen wins afterwards — unless the operator asked for the opposite with
 * `REGISTRATION_ENFORCE`, which is why a banner says so when they did.
 */

const MODES: RegistrationMode[] = ['OPEN', 'WHITELIST', 'INVITATION', 'CLOSED']

/** A copyable one-off secret: an invitation code, a setup link. Shown once and never again. */
function OneTimeValue({ label, value }: { label: string; value: string }) {
  const { t } = useT()
  return (
    <Banner kind="success">
      <span>{label}</span>
      <code className="one-time">{value}</code>
      <Button
        variant="quiet"
        onClick={() => void navigator.clipboard?.writeText(value).catch(() => undefined)}
      >
        {t('admin.copy')}
      </Button>
    </Banner>
  )
}

function shortDate(value: string, locale: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

function RegistrationCard({
  settings,
  onSaved,
}: {
  settings: RegistrationSettings
  onSaved: (next: RegistrationSettings) => void
}) {
  const { t, locale } = useT()
  const [mode, setMode] = useState<RegistrationMode>(settings.mode)
  const [allowPasswordLogin, setAllowPasswordLogin] = useState(settings.allowPasswordLogin)
  const [requireSecondFactor, setRequireSecondFactor] = useState(settings.requireSecondFactor)
  // Kept as a string so the "follow the deployment default" option has a value of its own rather
  // than being an awkward empty number. Mapped back to a number, or null, at the moment of saving.
  const [sessionDays, setSessionDays] = useState<string>(
    settings.sessionDays != null ? String(settings.sessionDays) : 'default',
  )
  const [saved, setSaved] = useState(false)

  return (
    <Card title={t('admin.registration')}>
      {settings.enforcedByEnvironment ? (
        <Banner kind="warning">{t('admin.enforcedByEnvironment')}</Banner>
      ) : null}
      <Form
        submitLabel={t('action.save')}
        onSubmit={async () => {
          const next = await api.registrationSettingsUpdate(locale, {
            mode,
            allowPasswordLogin,
            requireSecondFactor,
            sessionDays: sessionDays === 'default' ? null : Number(sessionDays),
          })
          onSaved({ ...settings, ...next })
          setSaved(true)
        }}
      >
        <Select<RegistrationMode>
          label={t('admin.registrationMode')}
          value={mode}
          options={MODES.map((value) => ({ value, label: t(`admin.mode.${value}`) }))}
          onChange={(value) => {
            setMode(value)
            setSaved(false)
          }}
        />
        {/* What the chosen mode means, next to the choice. A four-way setting whose options are
            single words is the kind that gets set wrong and stays wrong. */}
        <p className="muted">{t(`admin.mode.${mode}.help`)}</p>

        <label className="field field-check">
          <input
            type="checkbox"
            checked={allowPasswordLogin}
            onChange={(event) => setAllowPasswordLogin(event.target.checked)}
          />
          <span>{t('admin.allowPasswordLogin')}</span>
        </label>
        <label className="field field-check">
          <input
            type="checkbox"
            checked={requireSecondFactor}
            onChange={(event) => setRequireSecondFactor(event.target.checked)}
          />
          <span>{t('admin.requireSecondFactor')}</span>
        </label>
        <p className="muted">{t('admin.requireSecondFactorHelp')}</p>

        <Select<string>
          label={t('admin.sessionLength')}
          value={sessionDays}
          options={[
            { value: 'default', label: t('admin.sessionLength.default') },
            { value: '30', label: t('admin.sessionLength.30') },
            { value: '90', label: t('admin.sessionLength.90') },
            { value: '180', label: t('admin.sessionLength.180') },
            { value: '365', label: t('admin.sessionLength.365') },
          ]}
          onChange={(value) => {
            setSessionDays(value)
            setSaved(false)
          }}
        />
        {/* Said plainly, because "how long you stay signed in" is a trade the operator is making
            on everyone's behalf: convenience against how long a stolen token keeps working. */}
        <p className="muted">{t('admin.sessionLengthHelp')}</p>
      </Form>
      {saved ? <Banner kind="success">{t('admin.saved')}</Banner> : null}
    </Card>
  )
}

function UsersCard({ mode }: { mode: RegistrationMode }) {
  const { t, locale } = useT()
  const { me } = useSession()
  const [users, setUsers] = useState<AdminUser[]>()
  const [error, setError] = useState<string>()
  const [email, setEmail] = useState('')
  const [newUserLocale, setNewUserLocale] = useState<Locale>(locale)
  const [makeAdmin, setMakeAdmin] = useState(false)
  const [setupUrl, setSetupUrl] = useState<string>()

  const reload = useCallback(async () => {
    const result = await api.adminUsers(locale)
    setUsers(result.users)
  }, [locale])

  useEffect(() => {
    reload().catch(() => setUsers([]))
  }, [reload])

  // Every action on a row can be refused by the server — the last administrator cannot be
  // demoted — and the refusal is the useful part, so it is shown rather than swallowed.
  const act = async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('error.unexpected'))
    }
  }

  return (
    <>
      <Card title={t('admin.users')}>
        {users === undefined ? <Loading /> : null}
        {error ? <Banner kind="error">{error}</Banner> : null}
        <ul className="list admin-users">
          {(users ?? []).map((user) => (
            <li key={user.userId} className="admin-row">
              <div className="admin-user-who">
                <strong>{user.email ?? user.userId.slice(0, 8)}</strong>
                <span className="muted">
                  {[
                    // The handle first: it is the name people actually refer to each other by,
                    // and the row an administrator is asked to find is "the one that is @mateo".
                    user.handle ? `@${user.handle}` : undefined,
                    user.isAdmin ? t('admin.role.admin') : t('admin.role.member'),
                    t(`admin.status.${user.status}` as never),
                    user.hasVault ? undefined : t('admin.noVault'),
                    user.hasPassword ? undefined : t('admin.noPassword'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <div className="admin-user-actions">
                <Button
                  variant="quiet"
                  onClick={() =>
                    void act(() =>
                      api.adminChangeUser(locale, user.userId, { isAdmin: !user.isAdmin }),
                    )
                  }
                >
                  {user.isAdmin ? t('admin.demote') : t('admin.promote')}
                </Button>
                <Button
                  variant="danger"
                  disabled={user.userId === me?.userId}
                  onClick={() => {
                    // A browser confirm rather than a silent click-through: this removes the
                    // account, its events, and every file they kept — from everyone's wallets.
                    if (window.confirm(t('admin.deleteUserWarning'))) {
                      void act(() => api.adminDeleteUser(locale, user.userId))
                    }
                  }}
                >
                  {t('admin.deleteUser')}
                </Button>
                {user.handle ? (
                  // Freeing a name is the administrator's answer to "an abandoned account is
                  // squatting on my name". The account keeps working; the name becomes claimable.
                  <Button
                    variant="quiet"
                    onClick={() => void act(() => api.adminClearHandle(locale, user.userId))}
                  >
                    {t('admin.clearHandle')}
                  </Button>
                ) : null}
                <Button
                  variant={user.status === 'SUSPENDED' ? 'quiet' : 'danger'}
                  disabled={user.userId === me?.userId || user.status === 'INVITED'}
                  onClick={() =>
                    void act(() =>
                      api.adminChangeUser(locale, user.userId, {
                        status: user.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED',
                      }),
                    )
                  }
                >
                  {user.status === 'SUSPENDED' ? t('admin.reinstate') : t('admin.suspend')}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() =>
                    void act(async () => {
                      const result = await api.adminSetupLink(locale, user.userId)
                      setSetupUrl(result.setupUrl)
                    })
                  }
                >
                  {t('admin.sendSetupLink')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {setupUrl ? <OneTimeValue label={t('admin.setupLink')} value={setupUrl} /> : null}
      </Card>

      <Card title={t('admin.createUser')}>
        {/* Neither of the two routes lets an administrator choose somebody's vault passphrase.
            They cannot: a passphrase they know is a vault they can read. */}
        <p className="muted">{t('admin.createUserHelp')}</p>
        <Form
          submitLabel={t('admin.createUser')}
          onSubmit={async () => {
            const created = await api.adminCreateUser(locale, {
              email,
              locale: newUserLocale,
              isAdmin: makeAdmin,
            })
            setSetupUrl(created.setupUrl)
            setEmail('')
            setMakeAdmin(false)
            await reload()
          }}
        >
          <Field label={t('admin.email')} value={email} onChange={setEmail} type="email" required />
          <Select<Locale>
            label={t('account.language')}
            value={newUserLocale}
            options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))}
            onChange={setNewUserLocale}
          />
          <label className="field field-check">
            <input
              type="checkbox"
              checked={makeAdmin}
              onChange={(event) => setMakeAdmin(event.target.checked)}
            />
            <span>{t('admin.alsoAdministrator')}</span>
          </label>
        </Form>
        {mode === 'CLOSED' ? <p className="muted">{t('admin.closedStillWorks')}</p> : null}
      </Card>
    </>
  )
}

function InvitationsCard({ active }: { active: boolean }) {
  const { t, locale } = useT()
  const [invitations, setInvitations] = useState<AdminInvitation[]>()
  const [email, setEmail] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [ttlHours, setTtlHours] = useState('72')
  const [issued, setIssued] = useState<string>()

  const reload = useCallback(async () => {
    const result = await api.adminInvitations(locale)
    setInvitations(result.invitations)
  }, [locale])

  useEffect(() => {
    reload().catch(() => setInvitations([]))
  }, [reload])

  return (
    <Card title={t('admin.invitations')}>
      {!active ? <p className="muted">{t('admin.invitationsInactive')}</p> : null}
      <Form
        submitLabel={t('admin.invite')}
        onSubmit={async () => {
          const result = await api.invite(locale, {
            ...(email ? { email } : {}),
            maxUses: Number(maxUses),
            ttlHours: Number(ttlHours),
          })
          setIssued(result.url)
          setEmail('')
          await reload()
        }}
      >
        <Field
          label={t('admin.emailOptional')}
          value={email}
          onChange={setEmail}
          type="email"
          help={t('admin.inviteEmailHelp')}
        />
        <Field label={t('admin.maxUses')} value={maxUses} onChange={setMaxUses} type="number" />
        <Field label={t('admin.ttlHours')} value={ttlHours} onChange={setTtlHours} type="number" />
      </Form>
      {/* The link, once. Only its hash is stored, so leaving this screen loses it. */}
      {issued ? <OneTimeValue label={t('admin.inviteLink')} value={issued} /> : null}

      {invitations === undefined ? <Loading /> : null}
      {invitations?.length === 0 ? <p className="muted">{t('common.empty')}</p> : null}
      <ul className="list">
        {(invitations ?? []).map((invitation) => (
          <li key={invitation.id} className="admin-row">
            <span>
              {invitation.boundToAddress ? t('admin.boundToAddress') : t('admin.anyAddress')}
              <span className="muted">
                {' · '}
                {t('admin.usesOf', { uses: invitation.uses, max: invitation.maxUses })}
                {' · '}
                {invitation.live
                  ? t('admin.expiresOn', { date: shortDate(invitation.expiresAt, locale) })
                  : t('admin.spent')}
              </span>
            </span>
            {invitation.live ? (
              <Button
                variant="quiet"
                onClick={async () => {
                  await api.revokeInvitation(locale, invitation.id)
                  await reload()
                }}
              >
                {t('admin.revoke')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function WhitelistCard({ active }: { active: boolean }) {
  const { t, locale } = useT()
  const [entries, setEntries] = useState<AdminWhitelistEntry[]>()
  const [email, setEmail] = useState('')

  const reload = useCallback(async () => {
    const result = await api.adminWhitelist(locale)
    setEntries(result.entries)
  }, [locale])

  useEffect(() => {
    reload().catch(() => setEntries([]))
  }, [reload])

  return (
    <Card title={t('admin.whitelist')}>
      {!active ? <p className="muted">{t('admin.whitelistInactive')}</p> : null}
      <p className="muted">{t('admin.whitelistHelp')}</p>
      <Form
        submitLabel={t('admin.whitelistAdd')}
        onSubmit={async () => {
          await api.whitelist(locale, email)
          setEmail('')
          await reload()
        }}
      >
        <Field label={t('admin.email')} value={email} onChange={setEmail} type="email" required />
      </Form>

      {entries === undefined ? <Loading /> : null}
      {entries?.length === 0 ? <p className="muted">{t('common.empty')}</p> : null}
      <ul className="list">
        {(entries ?? []).map((entry) => (
          <li key={entry.id} className="admin-row">
            <span>{entry.email ?? entry.id.slice(0, 8)}</span>
            <Button
              variant="quiet"
              onClick={async () => {
                await api.removeFromWhitelist(locale, entry.id)
                await reload()
              }}
            >
              {t('admin.remove')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function AdminPage() {
  const { t, locale } = useT()
  const { me } = useSession()
  const [settings, setSettings] = useState<RegistrationSettings>()

  useEffect(() => {
    api
      .adminRegistration(locale)
      .then(setSettings)
      .catch(() => undefined)
  }, [locale])

  if (!me?.isAdmin) {
    return <Banner kind="info">{t('admin.notAdministrator')}</Banner>
  }
  if (!settings) {
    return <Loading />
  }

  return (
    <>
      <RegistrationCard settings={settings} onSaved={setSettings} />
      <UsersCard mode={settings.mode} />
      <InvitationsCard active={settings.mode === 'INVITATION'} />
      <WhitelistCard active={settings.mode === 'WHITELIST'} />
      <InstallationAuditCard />
    </>
  )
}

/**
 * The installation's own trail.
 *
 * Written from fourteen places since the beginning and never once readable. Loaded on demand: it
 * is the last card on the screen and nobody opens administration to read a log.
 */
function InstallationAuditCard() {
  const { t, locale } = useT()
  const [entries, setEntries] = useState<AuditEntry[]>()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    api
      .adminAudit(locale)
      .then((answer) => setEntries(answer.entries))
      .catch(() => setEntries([]))
  }, [open, locale])

  return (
    <Card title={t('audit.installation')} icon="shield">
      {open ? (
        <AuditList entries={entries} />
      ) : (
        <div className="button-row">
          <Button variant="quiet" onClick={() => setOpen(true)}>
            {t('audit.show')}
          </Button>
        </div>
      )}
    </Card>
  )
}
