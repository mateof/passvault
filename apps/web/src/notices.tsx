import { useCallback, useEffect, useState } from 'react'
import { api, type Invitation, type Notice } from './api/passvault'
import { ApiError } from './api/client'
import { useT } from './i18n'
import { useSession } from './session'
import { Banner, Button, Card, Empty, Field, Loading, Modal, PageHead } from './ui'

/**
 * What happened while you were not looking, and what needs an answer.
 *
 * Two lists with different jobs. Invitations are questions — somebody offered you an event and
 * nothing happens until you say yes or no — so they come first and are the reason this screen
 * exists. Notices are statements: your event was accepted, a ticket was assigned to you.
 *
 * An invitation is answered here rather than by the share appearing silently in the wallet,
 * because an event carries a friend's name, their seat and sometimes what they paid, and holding
 * one is a decision. The password, when there is one, is typed at the moment of accepting: that
 * is the first moment the person who has to type it is present.
 */
export function NoticesPage() {
  const { t, locale } = useT()
  const { me } = useSession()
  const [notices, setNotices] = useState<Notice[]>()
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [answering, setAnswering] = useState<Invitation>()
  const [failure, setFailure] = useState<string>()

  const load = useCallback(async () => {
    const [listed, offered] = await Promise.all([
      api.notifications(locale),
      api.invitations(locale),
    ])
    setNotices(listed.notifications)
    setInvitations(offered.invitations.filter((invitation) => invitation.state === 'PENDING'))
  }, [locale])

  useEffect(() => {
    if (me?.vaultUnlocked) void load()
  }, [load, me?.vaultUnlocked])

  if (!me?.vaultUnlocked) return <Banner kind="info">{t('notices.locked')}</Banner>
  if (!notices) return <Loading />

  /** The event's name lives in the notice: an invitation names an event nobody can decrypt yet. */
  const nameFor = (invitation: Invitation): string =>
    notices.find(
      (notice) => notice.kind === 'event.invited' && notice.payload.eventId === invitation.eventId,
    )?.payload.eventName ?? ''

  const answer = async (invitation: Invitation, password?: string) => {
    try {
      await api.acceptInvitation(locale, invitation.id, password)
      setAnswering(undefined)
      setFailure(undefined)
      await load()
    } catch (cause) {
      setFailure(cause instanceof ApiError ? cause.message : t('error.unexpected'))
    }
  }

  return (
    <>
      <PageHead
        title={t('notices.title')}
        subtitle={t('notices.subtitle')}
        action={
          notices.some((notice) => !notice.read) ? (
            <Button
              variant="quiet"
              icon="check"
              onClick={async () => {
                await api.markNoticesRead(locale)
                await load()
              }}
            >
              {t('notices.markAllRead')}
            </Button>
          ) : undefined
        }
      />

      {failure ? <Banner kind="error">{failure}</Banner> : null}

      {invitations.length > 0 ? (
        <Card title={t('notices.invitations')} icon="mail">
          <ul className="list">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="list-row">
                <span>
                  <strong>{nameFor(invitation) || t('notices.anEvent')}</strong>
                  {invitation.passwordProtected ? (
                    <span className="row-meta"> · {t('notices.needsPassword')}</span>
                  ) : null}
                </span>
                <span className="button-row">
                  <Button
                    icon="check"
                    onClick={() =>
                      // A protected event asks for its password; an open one is one press.
                      invitation.passwordProtected
                        ? setAnswering(invitation)
                        : void answer(invitation)
                    }
                  >
                    {t('notices.accept')}
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={async () => {
                      await api.declineInvitation(locale, invitation.id)
                      await load()
                    }}
                  >
                    {t('notices.decline')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={t('notices.recent')} icon="shield">
        {notices.length === 0 ? (
          <Empty icon="shield">{t('notices.none')}</Empty>
        ) : (
          <ul className="list">
            {notices.map((notice) => (
              <li key={notice.id} className="list-row">
                <span style={notice.read ? { opacity: 0.6 } : undefined}>
                  <Sentence notice={notice} />
                  <span className="row-meta"> · {shortWhen(notice.createdAt, locale)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={answering !== undefined}
        title={t('notices.accept')}
        icon="lock"
        onClose={() => setAnswering(undefined)}
      >
        {answering ? (
          <PasswordAnswer
            name={nameFor(answering)}
            onAccept={(password) => answer(answering, password)}
          />
        ) : null}
      </Modal>
    </>
  )
}

function PasswordAnswer({
  name,
  onAccept,
}: {
  name: string
  onAccept: (password: string) => void
}) {
  const { t } = useT()
  const [password, setPassword] = useState('')

  return (
    <>
      <p className="muted">{t('notices.passwordExplain', { event: name })}</p>
      <Field
        label={t('events.password')}
        value={password}
        onChange={setPassword}
        type="password"
        required
      />
      <div className="button-row">
        <Button icon="check" disabled={password === ''} onClick={() => onAccept(password)}>
          {t('notices.accept')}
        </Button>
      </div>
    </>
  )
}

/**
 * A notice is a key and a payload; the sentence is made here, in the reader's language.
 *
 * The catalogue is the only place wording lives, which is what lets a notice written months ago
 * still read correctly in a language added last week.
 */
function Sentence({ notice }: { notice: Notice }) {
  const { t } = useT()
  const event = notice.payload.eventName ?? ''
  switch (notice.kind) {
    case 'event.invited':
      return <>{t('notice.invited', { inviter: notice.payload.invitedBy ?? '', event })}</>
    case 'event.accepted':
      return <>{t('notice.accepted')}</>
    case 'event.declined':
      return <>{t('notice.declined')}</>
    case 'ticket.assigned':
      return <>{t('notice.assigned')}</>
    default:
      return <>{notice.kind}</>
  }
}

const shortWhen = (value: string, locale: string): string =>
  new Date(value).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

/**
 * How many unanswered things there are, for the badge on the menu.
 *
 * Polled rather than pushed: the alternative is a socket held open by every browser tab for a
 * number that changes a few times a day.
 */
export function useUnreadCount(): number {
  const { locale } = useT()
  const { me } = useSession()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!me?.vaultUnlocked) return
    let cancelled = false
    const check = () => {
      api
        .notifications(locale)
        .then((result) => {
          if (!cancelled) setUnread(result.unread)
        })
        .catch(() => undefined)
    }
    check()
    const timer = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [locale, me?.vaultUnlocked])

  return unread
}
