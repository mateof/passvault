import { useEffect, useState } from 'react'
import { api, type AllocationResult, type AuditEntry, type Group } from './api/passvault'
import { useT } from './i18n'
import { Banner, Button, Card, Empty, Select } from './ui'

/**
 * Three things the organiser could never do from a screen, however long the data had been there.
 *
 * Handing the event out to a whole group at once, putting the date in a calendar, and reading what
 * happened to the seats. They live together because they are the same screen in use — the one an
 * organiser opens after the tickets are imported and before the night itself.
 */

/**
 * Give everybody in a group a seat.
 *
 * The group is chosen, not typed, because the organiser's question is "everybody in this circle"
 * and asking them to list addresses is asking them to do the join by hand. Who got nothing is
 * reported rather than left to be worked out by counting what changed.
 */
export function AllocateCard({
  eventId,
  onChanged,
}: {
  eventId: string
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [groups, setGroups] = useState<Group[]>()
  const [groupId, setGroupId] = useState('')
  const [result, setResult] = useState<AllocationResult>()
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    api
      .groups(locale)
      .then((answer) => setGroups(answer.groups))
      .catch(() => setGroups([]))
  }, [locale])

  if (!groups || groups.length === 0) {
    return null
  }

  return (
    <Card title={t('allocate.title')} icon="users">
      <p className="muted">{t('allocate.explain')}</p>
      <Select
        label={t('allocate.group')}
        value={groupId}
        options={[
          { value: '', label: t('allocate.choose') },
          ...groups.map((group) => ({ value: group.id, label: group.name })),
        ]}
        onChange={setGroupId}
      />
      <div className="button-row">
        <Button
          icon="check"
          disabled={!groupId}
          onClick={async () => {
            setFailure(undefined)
            setResult(undefined)
            try {
              const members = await api.groupMembers(locale, groupId)
              // Order is the group's own, which is the order the organiser sees it in. Anything
              // else would make "who got the front row" depend on a sort nobody chose.
              const answer = await api.allocate(
                locale,
                eventId,
                members.members.map((member) => member.userId),
              )
              setResult(answer)
              await onChanged()
            } catch {
              setFailure(t('allocate.failed'))
            }
          }}
        >
          {t('allocate.run')}
        </Button>
      </div>

      {failure ? <Banner kind="error">{failure}</Banner> : null}
      {result ? (
        <>
          <Banner kind="success">
            {t('allocate.done', { count: result.assigned.length, remaining: result.remaining })}
          </Banner>
          {result.unseated.length > 0 ? (
            <Banner kind="warning">
              {t('allocate.unseated', { count: result.unseated.length })}
            </Banner>
          ) : null}
        </>
      ) : null}
    </Card>
  )
}

/** The date, in the place people keep their dates. */
export function CalendarButton({ eventId }: { eventId: string }) {
  const { t, locale } = useT()
  const [failure, setFailure] = useState<string>()

  return (
    <>
      <Button
        variant="quiet"
        icon="calendar"
        onClick={async () => {
          try {
            const file = await api.calendar(locale, eventId)
            // Downloaded rather than opened: an .ics handed to the browser is a file the
            // operating system knows what to do with, and every calendar knows how to take it.
            const url = URL.createObjectURL(file)
            const link = document.createElement('a')
            link.href = url
            link.download = `${eventId}.ics`
            link.click()
            URL.revokeObjectURL(url)
            setFailure(undefined)
          } catch {
            setFailure(t('calendar.failed'))
          }
        }}
      >
        {t('calendar.add')}
      </Button>
      {failure ? <Banner kind="warning">{failure}</Banner> : null}
    </>
  )
}

/**
 * What happened to these seats.
 *
 * Behind a button, and loaded only when asked. Nobody opens an event to read a log, and fetching
 * two hundred rows on every visit to answer a question nobody asked is how a wallet gets slow.
 */
export function AuditCard({ eventId }: { eventId: string }) {
  const { t, locale } = useT()
  const [entries, setEntries] = useState<AuditEntry[]>()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    api
      .eventAudit(locale, eventId)
      .then((answer) => setEntries(answer.entries))
      .catch(() => setEntries([]))
  }, [open, locale, eventId])

  return (
    <Card title={t('audit.title')} icon="shield">
      {!open ? (
        <>
          <p className="muted">{t('audit.explain')}</p>
          <div className="button-row">
            <Button variant="quiet" onClick={() => setOpen(true)}>
              {t('audit.show')}
            </Button>
          </div>
        </>
      ) : (
        <AuditList entries={entries} />
      )}
    </Card>
  )
}

export function AuditList({ entries }: { entries: AuditEntry[] | undefined }) {
  const { t, locale } = useT()

  if (!entries) {
    return <p className="muted">{t('audit.loading')}</p>
  }
  if (entries.length === 0) {
    return <Empty icon="shield">{t('audit.none')}</Empty>
  }
  return (
    <ul className="list">
      {entries.map((entry) => (
        <li key={entry.id} className="audit-row">
          {/* The action code, not a translated sentence. There are dozens of them, they are the
              vocabulary of the trail, and inventing a phrase for each would mean a trail that
              says something slightly different in every language. */}
          <code>{entry.action}</code>
          <span className="muted">{entry.actor ?? t('audit.nobody')}</span>
          <span className="muted">
            {new Date(entry.createdAt).toLocaleString(locale, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </span>
        </li>
      ))}
    </ul>
  )
}
