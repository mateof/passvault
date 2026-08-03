import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import {
  api,
  type AccessEntry,
  type ClaimSummary,
  type EventDetail,
  type Group,
  type Tag,
  type EventSummary,
  type IngestProposal,
  type PaymentState,
  type PaymentVisibility,
  type TicketSummary,
} from './api/passvault'
import { ApiError } from './api/client'
import { useT } from './i18n'
import { useKnownAddress } from './groups'
import { TagForm } from './tags'
import { EventMark, Icon } from './icons'
import {
  Banner,
  Button,
  Card,
  Checkbox,
  DateTimeField,
  Empty,
  Field,
  FilePicker,
  Form,
  Loading,
  Modal,
  PageHead,
  Select,
  TagChip,
  StateBadge,
  useObjectUrl,
} from './ui'

/**
 * Events and the tickets inside them.
 *
 * The screens that matter here are the ones that say something the user cannot get back:
 * exporting a `.tkpak` and withdrawing a ticket. Both warn before, in the words the threat
 * model uses — withdraw, never revoke — because the file has already left and no interface
 * can pretend otherwise.
 */

/** A day, in the reader's language. The server stores an instant; nobody wants to read one. */
function shortDate(value: string | null | undefined, locale: string): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * When it starts, with the time if it has one.
 *
 * A date with no time is stored as midnight UTC, which is how "the 14th of August" is written
 * down — so a midnight instant is shown as a day and anything else gets its clock. Printing
 * "00:00" beside every dateless event would be inventing a detail nobody entered.
 */
function whenText(value: string | null | undefined, locale: string): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const midnightUtc = parsed.getUTCHours() === 0 && parsed.getUTCMinutes() === 0
  return midnightUtc
    ? shortDate(value, locale)
    : parsed.toLocaleString(locale, { dateStyle: 'long', timeStyle: 'short' })
}

export function EventsPage() {
  const { t, locale } = useT()
  const [events, setEvents] = useState<EventSummary[]>()
  const [tags, setTags] = useState<Tag[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('')
  const [order, setOrder] = useState<'date' | 'name' | 'added'>('date')
  const [showPast, setShowPast] = useState(true)

  const load = useCallback(async () => {
    try {
      // The list names ids; the names live behind the event key, so each one is fetched. An
      // event this session has not opened comes back as a refusal rather than a name, and it
      // is listed as locked instead of being dropped — a wallet that silently omits events is
      // worse than one that says it cannot read them yet.
      const listed = await api.events(locale)
      const loaded = await Promise.all(
        listed.events.map(async (summary) =>
          api
            .event(locale, summary.id)
            .then((detail) => ({ ...detail, tagIds: summary.tagIds ?? detail.tagIds ?? [] }))
            .catch(() => ({
              id: summary.id,
              name: '',
              passwordProtected: true,
              tagIds: summary.tagIds ?? [],
            })),
        ),
      )
      setEvents(loaded)
      // Labels come with the wallet rather than per event: a list of twelve events would
      // otherwise be thirteen requests to draw twelve coloured chips.
      setTags((await api.tags(locale)).tags)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('error.unexpected'))
      setEvents([])
    }
  }, [locale, t])

  useEffect(() => {
    void load()
  }, [load])

  if (events === undefined) return <Loading />

  const now = Date.now()
  const isPast = (event: EventSummary): boolean =>
    // An event with no date is never past: "we do not know when" is not "it already happened".
    // A day's grace, because a concert at nine last night is still the thing in your pocket
    // this morning and should not vanish while you are on the way home.
    event.startsAt !== undefined &&
    event.startsAt !== null &&
    new Date(event.startsAt).getTime() < now - 86_400_000

  const matches = (event: EventSummary): boolean => {
    const needle = search.trim().toLowerCase()
    const haystack = `${event.name ?? ''} ${event.venue ?? ''}`.toLowerCase()
    if (needle !== '' && !haystack.includes(needle)) return false
    if (tagFilter !== '' && !(event.tagIds ?? []).includes(tagFilter)) return false
    if (!showPast && isPast(event)) return false
    return true
  }

  const shown = events.filter(matches).sort((left, right) => {
    // Past events sink, whatever the order: they are still here and no longer the answer to
    // "what am I going to".
    const pastDifference = Number(isPast(left)) - Number(isPast(right))
    if (pastDifference !== 0) return pastDifference
    if (order === 'name') return (left.name ?? '').localeCompare(right.name ?? '', locale)
    if (order === 'date') {
      // Undated events after dated ones: a date is what this ordering is about, and a blank
      // sorts arbitrarily wherever it is put.
      if (!left.startsAt) return right.startsAt ? 1 : 0
      if (!right.startsAt) return -1
      return left.startsAt.localeCompare(right.startsAt)
    }
    return 0
  })

  return (
    <>
      <PageHead
        title={t('events.title')}
        subtitle={t('events.subtitle', { count: events.length })}
        action={
          <span className="button-row">
            {/* The browser's own reload does the same job, but a button beside the list says the
                data can be stale and names the cure — which a URL bar does not. */}
            <Button variant="quiet" icon="chevron" onClick={() => void load()}>
              {t('events.refresh')}
            </Button>
            <Button icon="plus" onClick={() => setCreating(true)}>
              {t('events.create')}
            </Button>
          </span>
        }
      />

      {error ? <Banner kind="error">{error}</Banner> : null}

      {/* A toolbar rather than three more stacked cards. Searching, filtering and ordering are
          one decision about the same list, and splitting them into panels is what made this
          page a column of boxes. */}
      {events.length > 0 ? (
        <div className="toolbar">
          <Field label={t('events.search')} value={search} onChange={setSearch} />
          <Select
            label={t('events.order')}
            value={order}
            onChange={(value) => setOrder(value as 'date' | 'name' | 'added')}
            options={[
              { value: 'date', label: t('events.orderDate') },
              { value: 'name', label: t('events.orderName') },
              { value: 'added', label: t('events.orderAdded') },
            ]}
          />
          <Checkbox label={t('events.showPast')} checked={showPast} onChange={setShowPast} />
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="toolbar">
          {tags.map((tag) => (
            <TagChip
              key={tag.id}
              name={tag.name}
              colour={tag.colour}
              on={tagFilter === '' || tagFilter === tag.id}
              onClick={() => setTagFilter(tagFilter === tag.id ? '' : tag.id)}
            />
          ))}
        </div>
      ) : null}

      <Modal
        open={creating}
        title={t('events.create')}
        icon="plus"
        onClose={() => setCreating(false)}
      >
        <CreateEventCard onCreated={load} onClose={() => setCreating(false)} />
      </Modal>

      {shown.length === 0 ? (
        <Card>
          <Empty icon="events">{events.length === 0 ? t('events.none') : t('events.noMatch')}</Empty>
        </Card>
      ) : (
        <div className="grid">
          {shown.map((event) => (
            <Link
              className={`card-link${isPast(event) ? ' past' : ''}`}
              key={event.id}
              to={`/events/${event.id}`}
            >
              <EventThumb event={event} />
              <span className="card-link-body">
                <span className="card-link-title">{event.name || t('events.locked')}</span>
                <span className="card-link-meta">
                  {event.venue ? (
                    <span>
                      <Icon name="place" size={14} />
                      {event.venue}
                    </span>
                  ) : null}
                  {event.startsAt ? (
                    <span>
                      <Icon name="calendar" size={14} />
                      {whenText(event.startsAt, locale)}
                    </span>
                  ) : null}
                  {event.passwordProtected ? (
                    <span>
                      <Icon name="lock" size={14} />
                      {t('events.protected')}
                    </span>
                  ) : null}
                  {(event.tagIds ?? []).map((tagId) => {
                    const tag = tags.find((row) => row.id === tagId)
                    return tag ? (
                      <TagChip key={tag.id} name={tag.name} colour={tag.colour} />
                    ) : null
                  })}
                </span>
              </span>
              <Icon name="chevron" size={18} />
            </Link>
          ))}
        </div>
      )}

      <ImportCard onImported={load} />
    </>
  )
}

/**
 * The mark for one event, with its picture if it has one.
 *
 * A component rather than a prop because each picture is a request of its own, and the icon has
 * to render immediately either way — a list that waits for twelve images before drawing anything
 * is a list that looks broken on a slow connection.
 */
function EventThumb({ event, size = 40 }: { event: EventSummary; size?: number }) {
  const { locale } = useT()
  const fetcher = useMemo(
    () => (event.hasImage ? () => api.eventImage(locale, event.id) : undefined),
    [event.hasImage, event.id, locale],
  )
  const imageUrl = useObjectUrl(fetcher)

  return (
    <EventMark icon={event.icon} colour={event.colour} size={size} imageUrl={imageUrl} alt="" />
  )
}

function CreateEventCard({
  onCreated,
  onClose,
}: {
  onCreated: () => Promise<void>
  onClose: () => void
}) {
  const { t, locale } = useT()
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [icon, setIcon] = useState('concert')
  const [colour, setColour] = useState('violet')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('OPEN')

  return (
    <Card title={t('events.create')} icon="plus">
      <Form
        submitLabel={t('action.save')}
        submitIcon="check"
        onSubmit={async () => {
          await api.createEvent(locale, {
            name,
            venue: venue || undefined,
            // The server wants a full instant, and a date input gives a day. Sent as
            // midnight UTC rather than dropped, which is what a bare date means here.
            // A local time, sent as the instant it is. The field gives "2026-08-14T21:00"
            // with no zone, and `new Date` reads that in the browser's own — which is the one
            // the person typing it meant.
            startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
            icon,
            colour,
            defaultAssignmentMode: mode,
            // Only when one was typed. An empty string would be a password, and a password
            // cannot be added or removed afterwards — it decides who can decrypt at all.
            password: password.trim() === '' ? undefined : password,
          })
          onClose()
          await onCreated()
        }}
      >
        <Field label={t('events.name')} value={name} onChange={setName} required />
        <Field label={t('events.venue')} value={venue} onChange={setVenue} />
        {/* A local datetime rather than a bare date: an event at nine in the evening is a
            different thing from one "on the 14th", and the wallet sorts by this. */}
        <DateTimeField label={t('events.startsAt')} value={startsAt} onChange={setStartsAt} />
        <Select
          label={t('events.assignmentMode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'OPEN', label: t('events.assignmentMode.OPEN') },
            { value: 'ASSIGNED', label: t('events.assignmentMode.ASSIGNED') },
            { value: 'SELF_CLAIM', label: t('events.assignmentMode.SELF_CLAIM') },
          ]}
        />
        <Field
          label={t('events.password')}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="new-password"
          help={t('events.passwordHelp')}
        />
        <MarkPicker icon={icon} colour={colour} onIcon={setIcon} onColour={setColour} />
      </Form>
    </Card>
  )
}

/**
 * Choosing the mark an event is recognised by.
 *
 * Swatches rather than two dropdowns. The whole value of the mark is that it is recognisable at
 * a glance in a list, and a list of colour names is exactly the thing that cannot be judged at a
 * glance.
 */
export function MarkPicker({
  icon,
  colour,
  onIcon,
  onColour,
}: {
  icon: string
  colour: string
  onIcon: (value: string) => void
  onColour: (value: string) => void
}) {
  const { t } = useT()
  const icons = ['concert', 'football', 'theatre', 'cinema', 'travel', 'museum', 'party', 'other']
  const colours = ['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink']

  return (
    <>
      <div className="field">
        <span className="field-label">{t('events.icon')}</span>
        <div className="picker">
          {icons.map((option) => (
            <button
              type="button"
              key={option}
              className={`picker-option${option === icon ? ' picker-option-chosen' : ''}`}
              onClick={() => onIcon(option)}
              aria-label={t(`events.icon.${option}` as never)}
              title={t(`events.icon.${option}` as never)}
            >
              <EventMark icon={option} colour={colour} size={38} />
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">{t('events.colour')}</span>
        <div className="picker">
          {colours.map((option) => (
            <button
              type="button"
              key={option}
              className={`picker-option${option === colour ? ' picker-option-chosen' : ''}`}
              onClick={() => onColour(option)}
              aria-label={option}
              title={option}
            >
              <EventMark icon={icon} colour={option} size={30} />
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function ImportCard({ onImported }: { onImported: () => Promise<void> }) {
  const { t, locale } = useT()
  const [file, setFile] = useState<File>()
  const [password, setPassword] = useState('')
  const [result, setResult] = useState<{ count: number; event: string }>()

  return (
    <Card title={t('transfer.import')} icon="download">
      <FilePicker
        label={t('transfer.importChoose')}
        accept=".tkpak,application/vnd.passvault.tkpak,application/octet-stream"
        file={file}
        onChange={setFile}
      />
      <Form
        submitLabel={t('transfer.import')}
        submitIcon="download"
        disabled={!file}
        onSubmit={async () => {
          if (!file) return
          const imported = await api.importFile(locale, file, password)
          await onImported()
          setResult({ count: imported.ticketCount, event: imported.eventId })
        }}
      >
        <Field
          label={t('transfer.importPassword')}
          value={password}
          onChange={setPassword}
          type="password"
        />
      </Form>
      {result ? (
        <Banner kind="success">
          {t('transfer.importDone', { count: result.count, event: result.event })}
        </Banner>
      ) : null}
    </Card>
  )
}

export function EventPage() {
  const { id = '' } = useParams()
  const { t, locale } = useT()
  const [event, setEvent] = useState<EventDetail>()
  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [claim, setClaim] = useState<ClaimSummary>()
  const [serverTime, setServerTime] = useState<string>()
  const [openDialog, setOpenDialog] = useState<
    'edit' | 'appearance' | 'tags' | 'share' | 'password' | 'add' | 'export' | 'delete'
  >()
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      const [detail, listed] = await Promise.all([api.event(locale, id), api.tickets(locale, id)])
      setEvent(detail)
      setTickets(listed.tickets ?? [])
      setClaim(listed.claim)
      setServerTime(listed.serverTime)
      setNeedsPassword(false)
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 423)) {
        // The event key is not open in this session. Not an error: the password is the key
        // that decrypts the barcodes, so this is the ordinary state until it is given.
        setNeedsPassword(true)
      } else {
        setError(cause instanceof ApiError ? cause.message : t('error.unexpected'))
      }
    }
  }, [id, locale, t])

  useEffect(() => {
    void load()
  }, [load])

  const closeAndReload = () => {
    setOpenDialog(undefined)
    void load()
  }

  if (needsPassword) {
    return (
      <Card title={t('events.openTitle')} icon="lock">
        <p className="muted">{t('events.openExplain')}</p>
        <Form
          submitLabel={t('events.open')}
          submitIcon="unlock"
          onSubmit={async () => {
            await api.openEvent(locale, id, password)
            await load()
          }}
        >
          <Field
            label={t('events.password')}
            value={password}
            onChange={setPassword}
            type="password"
            required
          />
        </Form>
      </Card>
    )
  }

  if (error) return <Banner kind="error">{error}</Banner>
  if (!event) return <Loading />

  const meta = [
    event.venue ? { icon: 'place' as const, text: event.venue } : undefined,
    event.startsAt
      ? { icon: 'calendar' as const, text: whenText(event.startsAt, locale) }
      : undefined,
    { icon: 'ticket' as const, text: t('events.tickets', { count: tickets.length }) },
  ].filter(Boolean) as { icon: 'place' | 'calendar' | 'ticket'; text: string }[]

  return (
    <>
      <p className="muted">
        <Link to="/">
          <Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} />{' '}
          {t('action.back')}
        </Link>
      </p>

      <Card>
        <div className="card-link" style={{ border: 'none', padding: 0, boxShadow: 'none' }}>
          <EventThumb event={event} size={56} />
          <div className="card-link-body">
            <h1 className="page-title">{event.name}</h1>
            <div className="card-link-meta">
              {meta.map((entry) => (
                <span key={entry.icon}>
                  <Icon name={entry.icon} size={14} />
                  {entry.text}
                </span>
              ))}
            </div>
          </div>
        </div>
        {/* Said plainly rather than left to be inferred from the absence of a padlock. */}
        {event.readableByServer === false ? (
          <Banner kind="info">{t('events.notReadableByServer')}</Banner>
        ) : null}
      </Card>

      {/* The acts, each behind a button. The page itself keeps what a visit is usually for:
          the tickets and the original documents. Everything here reloads the event on close,
          because a dialog that edits and a page that does not notice is worse than either. */}
      {event.isCreator !== false ? (
        <div className="toolbar">
          <Button variant="quiet" icon="calendar" onClick={() => setOpenDialog('edit')}>
            {t('events.edit')}
          </Button>
          <Button variant="quiet" icon="image" onClick={() => setOpenDialog('appearance')}>
            {t('events.appearance')}
          </Button>
          <Button variant="quiet" icon="events" onClick={() => setOpenDialog('tags')}>
            {t('nav.tags')}
          </Button>
          <Button variant="quiet" icon="users" onClick={() => setOpenDialog('share')}>
            {t('sharing.title')}
          </Button>
          <Button variant="quiet" icon="lock" onClick={() => setOpenDialog('password')}>
            {t('events.password')}
          </Button>
          <Button variant="quiet" icon="plus" onClick={() => setOpenDialog('add')}>
            {t('tickets.add')}
          </Button>
          <Button variant="quiet" icon="download" onClick={() => setOpenDialog('export')}>
            {t('export.title')}
          </Button>
          <Button variant="quiet" icon="warning" onClick={() => setOpenDialog('delete')}>
            {t('events.delete')}
          </Button>
        </div>
      ) : null}

      {/* Only for somebody the event was shared with. The creator makes the tickets; they do
          not queue for a random one of their own. */}
      {event.isCreator === false ? (
        <ClaimCard eventId={id} claim={claim} onClaimed={load} />
      ) : null}

      <Modal
        open={openDialog === 'edit'}
        title={t('events.edit')}
        icon="calendar"
        onClose={closeAndReload}
      >
        <EditFactsForm event={event} onSaved={closeAndReload} />
      </Modal>

      <Modal
        open={openDialog === 'appearance'}
        title={t('events.appearance')}
        icon="image"
        onClose={closeAndReload}
      >
        <EventAppearanceCard event={event} onChanged={load} />
      </Modal>

      <Modal
        open={openDialog === 'tags'}
        title={t('nav.tags')}
        icon="events"
        onClose={closeAndReload}
      >
        <EventTagsForm eventId={id} onSaved={closeAndReload} />
      </Modal>

      <Modal
        open={openDialog === 'share'}
        title={t('sharing.title')}
        icon="users"
        onClose={closeAndReload}
      >
        <SharingCard eventId={id} />
      </Modal>

      <Modal
        open={openDialog === 'password'}
        title={t('events.password')}
        icon="lock"
        onClose={closeAndReload}
      >
        <PasswordForm eventId={id} onChanged={closeAndReload} />
      </Modal>

      <Modal
        open={openDialog === 'add'}
        title={t('tickets.add')}
        icon="plus"
        onClose={closeAndReload}
      >
        <AddTicketCard eventId={id} onAdded={load} />
        <IngestCard eventId={id} onIngested={load} />
      </Modal>

      <Modal
        open={openDialog === 'export'}
        title={t('export.title')}
        icon="download"
        onClose={closeAndReload}
      >
        <ExportCard eventId={id} />
      </Modal>

      <Modal
        open={openDialog === 'delete'}
        title={t('events.delete')}
        icon="warning"
        onClose={() => setOpenDialog(undefined)}
      >
        <DeleteEventForm eventId={id} eventName={event.name} />
      </Modal>

      <DocumentsCard eventId={id} tickets={tickets} onChanged={load} />

      <Card title={t('tickets.title')} icon="ticket">
        {tickets.length === 0 ? <Empty icon="ticket">{t('tickets.none')}</Empty> : null}
        <ul className="list">
          {tickets.map((ticket) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              isCreator={event.isCreator !== false}
              serverTime={serverTime}
              onChanged={load}
            />
          ))}
        </ul>
      </Card>

      <QuarantineCard eventId={id} />
    </>
  )
}

/**
 * Who this event is shared with, and with whom else to share it.
 *
 * Sharing used to be write-only — an organiser could grant access and had no way to see what they
 * had granted, so "did I remember to share this with the family?" could only be answered by doing
 * it again. A group is chosen from the ones you have; a person is typed as an address and checked
 * before the button does anything, because a typo in an address is otherwise discovered when a
 * friend never sees the ticket.
 */
function SharingCard({ eventId }: { eventId: string }) {
  const { t, locale } = useT()
  const [access, setAccess] = useState<AccessEntry[]>()
  const [groups, setGroups] = useState<Group[]>([])
  const [group, setGroup] = useState('')
  const [email, setEmail] = useState('')
  const [denied, setDenied] = useState(false)
  const known = useKnownAddress(email)

  const load = useCallback(async () => {
    try {
      const [shared, mine] = await Promise.all([
        api.eventAccess(locale, eventId),
        api.groups(locale),
      ])
      setAccess(shared.access)
      setGroups(mine.groups)
      setDenied(false)
    } catch (cause) {
      // Only the creator may read the guest list. For everybody else this card is not an error,
      // it is simply not theirs.
      if (cause instanceof ApiError && cause.status === 403) setDenied(true)
      else setAccess([])
    }
  }, [eventId, locale])

  useEffect(() => {
    void load()
  }, [load])

  if (denied) return null
  if (!access) return null

  return (
    <Card title={t('sharing.title')} icon="users">
      {access.length === 0 ? (
        <Empty icon="users">{t('sharing.none')}</Empty>
      ) : (
        <ul className="list">
          {access.map((entry) => (
            <li key={`${entry.subjectKind}:${entry.subjectId}`} className="list-row">
              <span>
                <Icon name={entry.subjectKind === 'GROUP' ? 'users' : 'account'} size={16} />{' '}
                {entry.label || entry.subjectId.slice(0, 8)}
                {/* The state that decides what revoking can promise, said on the row itself:
                    offered-not-answered, downloaded, or shared-and-idle. */}
                {entry.pending ? (
                  <span className="muted"> · {t('sharing.state.pending')}</span>
                ) : entry.downloaded ? (
                  <span className="muted"> · {t('sharing.state.downloaded')}</span>
                ) : (
                  <span className="muted"> · {t('sharing.state.notDownloaded')}</span>
                )}
              </span>
              <Button
                variant="quiet"
                onClick={async () => {
                  // The confirmation tells the truth for this person: a clean removal when they
                  // have not pulled it yet, an honest "cannot take it back" when they have.
                  const warning = entry.downloaded
                    ? t('sharing.revokeConfirm.downloaded')
                    : t('sharing.revokeConfirm.clean')
                  if (!window.confirm(warning)) return
                  await api.revokeEventAccess(locale, eventId, {
                    subjectKind: entry.subjectKind,
                    subjectId: entry.subjectId,
                  })
                  await load()
                }}
              >
                {t('sharing.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Revoking stops what happens next and cannot recall what was already delivered. Said
          here rather than in a tooltip, because people expect the opposite. */}
      {access.length > 0 ? <Banner kind="info">{t('sharing.revokeExplain')}</Banner> : null}

      {groups.length > 0 ? (
        <Form
          submitLabel={t('sharing.shareWithGroup')}
          submitIcon="users"
          disabled={group === ''}
          onSubmit={async () => {
            await api.shareEvent(locale, eventId, { subjectKind: 'GROUP', subjectId: group })
            setGroup('')
            await load()
          }}
        >
          <Select
            label={t('sharing.group')}
            value={group}
            onChange={setGroup}
            options={[
              { value: '', label: t('sharing.choose') },
              ...groups.map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
          />
        </Form>
      ) : (
        <p className="muted">{t('sharing.noGroups')}</p>
      )}

      <Form
        submitLabel={t('sharing.shareWithPerson')}
        submitIcon="mail"
        disabled={known !== true}
        onSubmit={async () => {
          await api.shareEvent(locale, eventId, { subjectKind: 'USER', email: email.trim() })
          setEmail('')
          await load()
        }}
      >
        <Field
          label={t('sharing.email')}
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="off"
          {...(known === false ? { help: t('groups.unknownEmail') } : {})}
          {...(known === true ? { help: t('groups.knownEmail') } : {})}
        />
      </Form>
    </Card>
  )
}

/**
 * Taking a free ticket, for the people an event was shared with.
 *
 * Only ever shown when there is something to take: a self-claim ticket still free, and none of
 * them already held by whoever is looking. A claim button on an event with nothing left to claim
 * is a button whose only function is to produce a refusal.
 */
function ClaimCard({
  eventId,
  claim,
  onClaimed,
}: {
  eventId: string
  claim: ClaimSummary | undefined
  onClaimed: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [failure, setFailure] = useState<string>()

  // Read from the server's summary rather than counted from the ticket list, which a member no
  // longer sees: the free self-claim tickets are hidden from them on purpose, so the button that
  // grabs one has to be told there is one to grab. Nothing to take, or one already held, no card.
  if (!claim || claim.freeToClaim === 0 || claim.alreadyHolds) return null

  return (
    <Card title={t('claim.title')} icon="ticket">
      <p className="muted">{t('claim.explain', { count: claim.freeToClaim })}</p>
      {failure ? <Banner kind="error">{failure}</Banner> : null}
      <div className="button-row">
        <Button
          icon="check"
          onClick={async () => {
            try {
              await api.claimFree(locale, eventId)
              setFailure(undefined)
              await onClaimed()
            } catch (cause) {
              setFailure(cause instanceof ApiError ? cause.message : t('error.unexpected'))
            }
          }}
        >
          {t('claim.take')}
        </Button>
      </div>
    </Card>
  )
}

/**
 * Editing the facts of an event: where, when, how tickets are handed out.
 *
 * Facts rather than appearance — these travel through the operation log to every phone that
 * holds the event, where an icon is served by this installation alone. That is also why the
 * form is explicit about clearing: a date removed here is removed everywhere.
 */
function EditFactsForm({ event, onSaved }: { event: EventDetail; onSaved: () => void }) {
  const { t, locale } = useT()
  const [name, setName] = useState(event.name ?? '')
  const [venue, setVenue] = useState(event.venue ?? '')
  const [startsAt, setStartsAt] = useState(toLocalInput(event.startsAt))
  const [mode, setMode] = useState(event.defaultAssignmentMode ?? 'OPEN')

  return (
    <Form
      submitLabel={t('action.save')}
      submitIcon="check"
      disabled={name.trim() === ''}
      onSubmit={async () => {
        await api.updateEventFacts(locale, event.id, {
          name: name.trim(),
          venue: venue.trim() === '' ? null : venue.trim(),
          startsAt: startsAt === '' ? null : new Date(startsAt).toISOString(),
          defaultAssignmentMode: mode,
        })
        onSaved()
      }}
    >
      <Field label={t('events.name')} value={name} onChange={setName} required />
      <Field label={t('events.venue')} value={venue} onChange={setVenue} />
      <DateTimeField label={t('events.startsAt')} value={startsAt} onChange={setStartsAt} />
      <Select
        label={t('events.assignmentMode')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'OPEN', label: t('events.assignmentMode.OPEN') },
          { value: 'ASSIGNED', label: t('events.assignmentMode.ASSIGNED') },
          { value: 'SELF_CLAIM', label: t('events.assignmentMode.SELF_CLAIM') },
        ]}
      />
    </Form>
  )
}

/** A stored instant as the local value a datetime-local input edits. Empty for none. */
function toLocalInput(value: string | null | undefined): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/**
 * The labels this event carries, with a way to make one without leaving.
 *
 * Inline creation is the difference between labelling an event and abandoning the attempt: the
 * moment somebody wants "Vigo" on this event is the moment the label does not exist yet, and a
 * round trip through another screen loses them.
 */
function EventTagsForm({ eventId, onSaved }: { eventId: string; onSaved: () => void }) {
  const { t, locale } = useT()
  const [tags, setTags] = useState<Tag[]>()
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [makingNew, setMakingNew] = useState(false)

  const load = useCallback(async () => {
    const [mine, detail] = await Promise.all([api.tags(locale), api.event(locale, eventId)])
    setTags(mine.tags)
    setChosen(new Set(detail.tagIds ?? []))
  }, [eventId, locale])

  useEffect(() => {
    void load()
  }, [load])

  if (!tags) return <Loading />

  return (
    <>
      {tags.length === 0 && !makingNew ? <p className="muted">{t('tags.empty')}</p> : null}
      <div className="toolbar">
        {tags.map((tag) => (
          <TagChip
            key={tag.id}
            name={tag.name}
            colour={tag.colour}
            on={chosen.has(tag.id)}
            onClick={() =>
              setChosen((current) => {
                const next = new Set(current)
                if (next.has(tag.id)) next.delete(tag.id)
                else next.add(tag.id)
                return next
              })
            }
          />
        ))}
      </div>

      {makingNew ? (
        <TagForm
          onSubmit={async (name, colour) => {
            const created = await api.createTag(locale, name, colour)
            setMakingNew(false)
            await load()
            // The label somebody just made is the one they wanted on this event.
            setChosen((current) => new Set(current).add(created.tagId))
          }}
        />
      ) : (
        <Button variant="quiet" icon="plus" onClick={() => setMakingNew(true)}>
          {t('tags.create')}
        </Button>
      )}

      <div className="button-row">
        <Button
          icon="check"
          onClick={async () => {
            await api.setEventTags(locale, eventId, [...chosen])
            onSaved()
          }}
        >
          {t('action.save')}
        </Button>
      </div>
    </>
  )
}

/**
 * The event password: seen, copied, changed, set or removed.
 *
 * Seen and copied because its job is social as well as cryptographic — whoever set it has to
 * tell it to their friends, usually weeks later, and "I chose it in March" is not a password.
 * The warnings around removal are the ones the security model requires: with no password the
 * operator of this installation can read the tickets, and that is said in words.
 */
function PasswordForm({ eventId, onChanged }: { eventId: string; onChanged: () => void }) {
  const { t, locale } = useT()
  const [current, setCurrent] = useState<string | null>()
  const [next, setNext] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api
      .eventPassword(locale, eventId)
      .then((result) => setCurrent(result.password))
      .catch(() => setCurrent(null))
  }, [eventId, locale])

  if (current === undefined) return <Loading />

  return (
    <>
      {current ? (
        <>
          <p className="muted">{t('password.current')}</p>
          <p className="barcode">
            {current}
            <Button
              variant="quiet"
              icon="copy"
              onClick={() => {
                void navigator.clipboard?.writeText(current).catch(() => undefined)
                setCopied(true)
              }}
            >
              {t('password.copy')}
            </Button>
          </p>
          {copied ? <Banner kind="success">{t('password.copied')}</Banner> : null}
        </>
      ) : (
        <Banner kind="info">{t('password.none')}</Banner>
      )}

      <Form
        submitLabel={current ? t('password.change') : t('password.set')}
        submitIcon="lock"
        disabled={next.length < 4}
        onSubmit={async () => {
          await api.setEventPassword(locale, eventId, next)
          onChanged()
        }}
      >
        <Field
          label={t('password.new')}
          value={next}
          onChange={setNext}
          type="password"
          autoComplete="new-password"
          help={t('password.changeExplain')}
        />
      </Form>

      {current ? (
        <>
          <Banner kind="warning">{t('password.removeWarning')}</Banner>
          <div className="button-row">
            <Button
              variant="danger"
              onClick={async () => {
                await api.setEventPassword(locale, eventId, null)
                onChanged()
              }}
            >
              {t('password.remove')}
            </Button>
          </div>
        </>
      ) : null}
    </>
  )
}

/**
 * The documents tickets were split out of, listed as things in their own right.
 *
 * A ten-page PDF becomes ten tickets, and the file itself is not one of them — but it is what
 * the user was sent, it holds the pages ingestion left out (the map, the terms, the instructions)
 * and it is what they will want when a turnstile disagrees with the app. Each document says which
 * tickets came from it, so a wallet with two imports does not present twenty anonymous passes.
 */
function DocumentsCard({
  eventId,
  tickets,
  onChanged,
}: {
  eventId: string
  tickets: TicketSummary[]
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [documents, setDocuments] =
    useState<
      {
        id: string
        mediaType: string
        pageCount?: number | null
        byteCount?: number | null
        ticketIds: string[]
      }[]
    >()

  useEffect(() => {
    api
      .documents(locale, eventId)
      .then((result) => setDocuments(result.documents ?? []))
      .catch(() => setDocuments([]))
  }, [eventId, locale, onChanged])

  if (!documents || documents.length === 0) return null

  const labelOf = (ticketId: string): string =>
    tickets.find((ticket) => ticket.id === ticketId)?.label ?? ticketId.slice(0, 8)

  return (
    <Card title={t('documents.title')} icon="file">
      <p className="muted">{t('documents.explain')}</p>
      <ul className="list">
        {documents.map((document) => (
          <li key={document.id} className="admin-row">
            <div className="admin-user-who">
              <strong>
                <Icon name="file" size={16} />{' '}
                {t(`documents.type.${mediaKind(document.mediaType)}` as never)}
              </strong>
              <span className="muted">
                {[
                  document.pageCount
                    ? t('documents.pages', { count: document.pageCount })
                    : undefined,
                  document.byteCount ? readableSize(document.byteCount) : undefined,
                  t('documents.fromHere', { count: document.ticketIds.length }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {document.ticketIds.length > 0 ? (
                <span className="muted">{document.ticketIds.map(labelOf).join(', ')}</span>
              ) : null}
            </div>
            <Button
              variant="quiet"
              icon="download"
              onClick={async () => {
                // Fetched rather than linked: the bytes are decrypted per session behind a
                // bearer token, so a plain link would open an unauthenticated tab.
                const blob = await api.document(locale, eventId, document.id)
                const url = URL.createObjectURL(blob)
                window.open(url, '_blank', 'noopener')
                // Left alive briefly: revoking immediately races the tab that is opening it.
                setTimeout(() => URL.revokeObjectURL(url), 60_000)
              }}
            >
              {t('documents.open')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const mediaKind = (mediaType: string): string =>
  mediaType.includes('pdf') ? 'pdf' : mediaType.includes('image') ? 'image' : 'pass'

const readableSize = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} kB`

/** Changing how an event looks. Only its creator can, and only they are shown the form. */
function EventAppearanceCard({
  event,
  onChanged,
}: {
  event: EventDetail
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [open, setOpen] = useState(false)
  const [icon, setIcon] = useState(event.icon ?? 'other')
  const [colour, setColour] = useState(event.colour ?? 'violet')
  const [image, setImage] = useState<File>()

  if (event.isCreator === false) return null

  if (!open) {
    return (
      <p className="muted">
        <button className="link" onClick={() => setOpen(true)}>
          {t('events.appearance')}
        </button>
      </p>
    )
  }

  return (
    <Card title={t('events.appearance')} icon="image">
      <Form
        submitLabel={t('action.save')}
        submitIcon="check"
        onSubmit={async () => {
          await api.updateEvent(locale, event.id, { icon, colour })
          if (image) {
            await api.uploadEventImage(locale, event.id, image)
          }
          setImage(undefined)
          setOpen(false)
          await onChanged()
        }}
      >
        <MarkPicker icon={icon} colour={colour} onIcon={setIcon} onColour={setColour} />
        <FilePicker
          label={t('events.imageChoose')}
          accept="image/png,image/jpeg,image/webp"
          file={image}
          onChange={setImage}
        />
        <p className="field-help">{t('events.imageHelp')}</p>
      </Form>
      {event.hasImage ? (
        <div className="button-row">
          <Button
            variant="quiet"
            icon="close"
            onClick={async () => {
              await api.deleteEventImage(locale, event.id)
              await onChanged()
            }}
          >
            {t('events.imageRemove')}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}

/**
 * How long until a time-locked code opens, ticking down once a second.
 *
 * The clock is the server's, not the browser's: `serverTime` is when the list was fetched, and the
 * gap between that and the target is anchored at mount, so winding the machine's clock forward does
 * not bring the code out early — the same rule the server enforces when it decides to serve it.
 */
function Countdown({ target, serverTime }: { target: string; serverTime?: string }) {
  const { t } = useT()
  // Offset between this machine's clock and the server's, fixed at mount. Everything is measured
  // from the server's now so a wrong local clock cannot move the deadline.
  const [skew] = useState(() => (serverTime ? Date.parse(serverTime) - Date.now() : 0))
  const targetMs = useMemo(() => Date.parse(target), [target])
  const [now, setNow] = useState(() => Date.now() + skew)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew), 1000)
    return () => clearInterval(id)
  }, [skew])

  const remaining = Math.max(0, targetMs - now)
  const total = Math.floor(remaining / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const parts = days > 0 ? [days + 'd', hours + 'h', minutes + 'm'] : [hours + 'h', minutes + 'm', seconds + 's']
  return <>{t('tickets.lockedCountdown', { remaining: parts.join(' ') })}</>
}

function TicketRow({
  ticket,
  isCreator,
  serverTime,
  onChanged,
}: {
  ticket: TicketSummary
  isCreator: boolean
  serverTime?: string
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [open, setOpen] = useState(false)
  const [holder, setHolder] = useState(ticket.holderLabel ?? '')
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)

  return (
    <li className="ticket">
      <button className="ticket-head" onClick={() => setOpen((value) => !value)}>
        <Icon name="ticket" size={18} />
        <span>{ticket.label ?? ticket.id.slice(0, 8)}</span>
        {ticket.seat ? <span className="muted">{ticket.seat}</span> : null}
        <StateBadge state={ticket.assignmentState} />
        <Icon name="chevron" size={18} className={`icon chevron${open ? ' chevron-open' : ''}`} />
      </button>

      {ticket.assignmentState === 'PROVISIONAL' ? (
        // Never rendered as settled. The single most important user-facing consequence of the
        // offline design, and the reason it is said here and not only in a list badge.
        <Banner kind="warning">{t('state.provisionalExplain')}</Banner>
      ) : null}

      {open ? (
        <div className="ticket-body">
          {ticket.barcode ? (
            <p className="barcode">
              {ticket.barcode.value}
              <span className="muted"> ({ticket.barcode.format})</span>
            </p>
          ) : ticket.locked ? (
            // Why it is withheld, in the words the person can act on: pay it, wait for it, or ask
            // the creator. The countdown is measured against the server's clock, sent with the
            // list, so moving the phone's time does nothing.
            <Banner kind="info">
              {ticket.lockReason === 'unpaid'
                ? t('tickets.lockedUnpaid')
                : ticket.lockReason === 'blocked'
                  ? t('tickets.lockedBlocked')
                  : ticket.visibleFrom ? (
                      // A live count while there is time to count, falling back to the plain date
                      // for a target the server sent without a parseable instant.
                      <Countdown target={ticket.visibleFrom} serverTime={serverTime} />
                    ) : (
                      t('tickets.lockedUntil', {
                        when: whenText(ticket.visibleFrom ?? undefined, locale) ?? '',
                      })
                    )}
            </Banner>
          ) : (
            <p className="muted">{t('tickets.noBarcode')}</p>
          )}

          {/* Whether it is paid, when the creator chose to show it. The server only sends the
              payment to a viewer allowed to see it, so its mere presence here is the permission —
              a member sees it for their own debt, or for everybody's, or not at all. */}
          {ticket.payment ? (
            <p className="muted">
              <Icon name="money" size={14} /> {t(`payment.${ticket.payment.state}` as never)}
              {ticket.payment.amountCents != null && ticket.payment.amountCents > 0
                ? ` · ${(ticket.payment.amountCents / 100).toLocaleString(locale, {
                    style: 'currency',
                    currency: ticket.payment.currency ?? 'EUR',
                  })}`
                : ''}
            </p>
          ) : null}

          {/* The holder's way out, while there is still nothing to keep: a locked ticket can be
              handed back, and once the code has been seen it cannot. */}
          {!isCreator &&
          ticket.holderUserId &&
          !ticket.revealed &&
          ticket.assignmentState !== 'FREE' ? (
            <div className="button-row">
              <Button
                variant="quiet"
                onClick={async () => {
                  if (!window.confirm(t('tickets.returnConfirm'))) return
                  await api.returnTicket(locale, ticket.id)
                  await onChanged()
                }}
              >
                {t('tickets.return')}
              </Button>
            </div>
          ) : null}

          {isCreator ? (
            <>
              <Form
                submitLabel={t('tickets.assign')}
                onSubmit={async () => {
                  await api.assign(locale, ticket.id, { holderLabel: holder })
                  await onChanged()
                }}
              >
                <Field label={t('tickets.holder')} value={holder} onChange={setHolder} />
              </Form>

              {/* By address, which is the difference between writing somebody's name on a ticket
                  and giving it to them: an assigned holder with an account is the only one who
                  can see the barcode of their own ticket and nobody else's. */}
              <AssignToAccount ticketId={ticket.id} onChanged={onChanged} />

              <PaymentForm ticket={ticket} onChanged={onChanged} />

              <VisibilityControls ticket={ticket} serverTime={serverTime} onChanged={onChanged} />

              {confirmWithdraw ? (
                <>
                  <Banner kind="warning">{t('tickets.withdrawWarning')}</Banner>
                  <div className="button-row">
                    <Button
                      variant="danger"
                      icon="check"
                      onClick={async () => {
                        await api.withdraw(locale, ticket.id)
                        setConfirmWithdraw(false)
                        await onChanged()
                      }}
                    >
                      {t('action.confirm')}
                    </Button>
                    <Button variant="quiet" onClick={() => setConfirmWithdraw(false)}>
                      {t('action.cancel')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="button-row">
                  <Button variant="quiet" onClick={() => setConfirmWithdraw(true)}>
                    {t('tickets.withdraw')}
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={async () => {
                      await api.reconcile(locale, ticket.id).catch(() => undefined)
                      await onChanged()
                    }}
                  >
                    {t('tickets.reconcile')}
                  </Button>
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * The creator's grip on one shared barcode: when it opens, whether it is held back, and whether
 * the holder may pass it on.
 *
 * The block button disables itself the moment the code has been revealed, because from there the
 * holder may have a photograph and a block would be a lie. The visibility is set either to an exact
 * moment or to a span before the event — the second follows a re-dated event, which the first
 * cannot.
 */
function VisibilityControls({
  ticket,
  serverTime,
  onChanged,
}: {
  ticket: TicketSummary
  serverTime?: string
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [when, setWhen] = useState(toLocalInput(ticket.visibleFrom ?? undefined))

  return (
    <div className="ticket-visibility">
      <p className="field-help">{t('tickets.visibilityExplain')}</p>
      <DateTimeField label={t('tickets.visibleFrom')} value={when} onChange={setWhen} />
      <div className="button-row">
        <Button
          variant="quiet"
          onClick={async () => {
            await api.setTicketVisibility(locale, ticket.id, {
              visibleFrom: when === '' ? null : new Date(when).toISOString(),
              hoursBeforeEvent: null,
            })
            await onChanged()
          }}
        >
          {t('tickets.setVisibility')}
        </Button>
        {/* The common case as one tap: open the day before the event. */}
        <Button
          variant="quiet"
          onClick={async () => {
            await api.setTicketVisibility(locale, ticket.id, {
              hoursBeforeEvent: 24,
              visibleFrom: null,
            })
            await onChanged()
          }}
        >
          {t('tickets.visibleDayBefore')}
        </Button>
        {when !== '' || ticket.visibleFrom ? (
          <Button
            variant="quiet"
            onClick={async () => {
              setWhen('')
              await api.setTicketVisibility(locale, ticket.id, {
                visibleFrom: null,
                hoursBeforeEvent: null,
              })
              await onChanged()
            }}
          >
            {t('tickets.visibilityClear')}
          </Button>
        ) : null}
      </div>

      <div className="button-row">
        {ticket.blocked ? (
          <Button
            variant="quiet"
            onClick={async () => {
              await api.unblockTicket(locale, ticket.id)
              await onChanged()
            }}
          >
            {t('tickets.unblock')}
          </Button>
        ) : (
          <Button
            variant="quiet"
            // Once seen, blocking is refused by the server; the button says why it is off rather
            // than failing when pressed.
            disabled={ticket.revealed}
            onClick={async () => {
              await api.blockTicket(locale, ticket.id)
              await onChanged()
            }}
          >
            {ticket.revealed ? t('tickets.blockRevealed') : t('tickets.block')}
          </Button>
        )}
      </div>

      <label className="field field-check">
        <input
          type="checkbox"
          checked={ticket.sharePermitted ?? false}
          onChange={async (event) => {
            await api.setSharePermission(locale, ticket.id, event.target.checked)
            await onChanged()
          }}
        />
        <span>{t('tickets.allowShare')}</span>
      </label>
      {serverTime ? <p className="field-help">{t('tickets.serverTime', { when: whenText(serverTime, locale) ?? '' })}</p> : null}
    </div>
  )
}

function AssignToAccount({
  ticketId,
  onChanged,
}: {
  ticketId: string
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [email, setEmail] = useState('')
  const known = useKnownAddress(email)

  return (
    <Form
      submitLabel={t('tickets.assignTo')}
      submitIcon="account"
      disabled={known !== true}
      onSubmit={async () => {
        const found = await api.lookup(locale, email.trim())
        if (!found.userId) return
        await api.assign(locale, ticketId, { holderUserId: found.userId })
        setEmail('')
        await onChanged()
      }}
    >
      <Field
        label={t('tickets.holderEmail')}
        value={email}
        onChange={setEmail}
        type="email"
        autoComplete="off"
        {...(known === false ? {help: t('groups.unknownEmail')} : {})}
        {...(known === true ? {help: t('groups.knownEmail')} : {})}
      />
    </Form>
  )
}

function PaymentForm({
  ticket,
  onChanged,
}: {
  ticket: TicketSummary
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  // The states the server actually accepts. This offered a "PENDING" the schema has never had,
  // so recording a payment failed validation every time it was tried.
  const [state, setState] = useState<PaymentState>(ticket.payment?.state ?? 'UNPAID')
  const [amount, setAmount] = useState(String((ticket.payment?.amountCents ?? 0) / 100))
  const [visibility, setVisibility] = useState<PaymentVisibility>(
    ticket.payment?.visibility ?? 'ALL',
  )

  return (
    <Form
      submitLabel={t('payment.save')}
      submitIcon="money"
      onSubmit={async () => {
        await api.setPayment(locale, ticket.id, {
          state,
          // Integer cents, the same as everywhere else. Money as a float is how a total ends
          // up a penny out and nobody can say which row did it.
          amountCents: Math.round(Number(amount) * 100),
          currency: ticket.payment?.currency ?? 'EUR',
          visibility,
        })
        await onChanged()
      }}
    >
      <Select<PaymentState>
        label={t('payment.state')}
        value={state}
        options={(['UNPAID', 'PARTIAL', 'PAID', 'WAIVED'] as const).map((value) => ({
          value,
          label: t(`payment.${value}` as never),
        }))}
        onChange={setState}
      />
      <Field label={t('payment.amount')} value={amount} onChange={setAmount} type="number" />
      <Select<PaymentVisibility>
        label={t('payment.visibility')}
        value={visibility}
        options={(['ALL', 'HOLDER_ONLY', 'CREATOR_ONLY'] as const).map((value) => ({
          value,
          label: t(`payment.visibility.${value}` as never),
        }))}
        onChange={setVisibility}
      />
    </Form>
  )
}

function AddTicketCard({ eventId, onAdded }: { eventId: string; onAdded: () => Promise<void> }) {
  const { t, locale } = useT()
  const [label, setLabel] = useState('')
  const [seat, setSeat] = useState('')
  const [barcode, setBarcode] = useState('')
  const [format, setFormat] = useState('QR_CODE')

  return (
    <Card title={t('tickets.add')} icon="plus">
      <Form
        submitLabel={t('action.save')}
        submitIcon="check"
        onSubmit={async () => {
          await api.addTickets(locale, eventId, [
            {
              label: label || undefined,
              seat: seat || undefined,
              barcode: barcode ? { format, value: barcode } : undefined,
            },
          ])
          setLabel('')
          setSeat('')
          setBarcode('')
          await onAdded()
        }}
      >
        <Field label={t('tickets.label')} value={label} onChange={setLabel} />
        <Field label={t('tickets.seat')} value={seat} onChange={setSeat} />
        <Field label={t('tickets.barcode')} value={barcode} onChange={setBarcode} />
        <Select
          label={t('tickets.barcodeFormat')}
          value={format}
          options={['QR_CODE', 'AZTEC', 'PDF_417', 'CODE_128', 'DATA_MATRIX'].map((value) => ({
            value,
            label: value,
          }))}
          onChange={setFormat}
        />
      </Form>
    </Card>
  )
}

function IngestCard({ eventId, onIngested }: { eventId: string; onIngested: () => Promise<void> }) {
  const { t, locale } = useT()
  const [file, setFile] = useState<File>()
  const [proposal, setProposal] = useState<IngestProposal>()
  const [excluded, setExcluded] = useState<Set<number>>(new Set())

  return (
    <Card title={t('ingest.title')} icon="upload">
      <p className="muted">{t('ingest.explain')}</p>
      <FilePicker
        label={t('ingest.choose')}
        accept="application/pdf,image/*,.pkpass"
        file={file}
        onChange={setFile}
      />
      {!proposal ? (
        <Form
          submitLabel={t('ingest.title')}
          submitIcon="upload"
          disabled={!file}
          onSubmit={async () => {
            if (!file) return
            const proposed = await api.ingest(locale, eventId, file)
            setProposal(proposed)
            // The server already decided which pages look like tickets — a page of
            // instructions arrives with `include: false`. Starting with everything ticked
            // would throw that judgement away and import the map as a ticket.
            setExcluded(new Set(proposed.entries.filter((e) => !e.include).map((e) => e.index)))
          }}
        >
          <span />
        </Form>
      ) : (
        <>
          <ul className="list">
            {proposal.entries.map((entry) => {
              const included = !excluded.has(entry.index)
              return (
                <li key={entry.index}>
                  <label className="field field-check">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() =>
                        setExcluded((current) => {
                          const next = new Set(current)
                          if (included) next.add(entry.index)
                          else next.delete(entry.index)
                          return next
                        })
                      }
                    />
                    <span>
                      {entry.suggestedLabel || `#${entry.index + 1}`}
                      {entry.pageNumber ? (
                        <span className="muted">
                          {' '}
                          · {t('ingest.page', { page: entry.pageNumber })}
                        </span>
                      ) : null}
                      {entry.barcode ? (
                        <span className="muted"> · {entry.barcode.value}</span>
                      ) : (
                        <span className="muted"> · {t('ingest.noBarcode')}</span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <Form
            submitLabel={t('ingest.confirm', { count: proposal.entries.length - excluded.size })}
            submitIcon="check"
            onSubmit={async () => {
              const include = proposal.entries
                .map((entry) => entry.index)
                .filter((index) => !excluded.has(index))
              await api.confirmIngest(locale, eventId, proposal.ingestId, include)
              setProposal(undefined)
              setExcluded(new Set())
              setFile(undefined)
              await onIngested()
            }}
          >
            <span />
          </Form>
        </>
      )}
    </Card>
  )
}

function ExportCard({ eventId }: { eventId: string }) {
  const { t, locale } = useT()
  const [password, setPassword] = useState('')

  return (
    <Card title={t('transfer.export')} icon="upload">
      {/* Said before the button, not after the download. */}
      <Banner kind="warning">{t('transfer.exportWarning')}</Banner>
      <Form
        submitLabel={t('transfer.export')}
        submitIcon="download"
        onSubmit={async () => {
          const blob = await api.exportEvent(locale, eventId, { password })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `${eventId}.tkpak`
          anchor.click()
          URL.revokeObjectURL(url)
        }}
      >
        <Field
          label={t('transfer.exportPassword')}
          value={password}
          onChange={setPassword}
          type="password"
          required
        />
      </Form>
    </Card>
  )
}

function QuarantineCard({ eventId }: { eventId: string }) {
  const { t, locale } = useT()
  const [rows, setRows] = useState<{ operationId: string; type: string; reason: string }[]>()

  useEffect(() => {
    api
      .quarantine(locale, eventId)
      .then((result) => setRows(result.operations ?? []))
      .catch(() => setRows([]))
  }, [eventId, locale])

  if (!rows || rows.length === 0) return null

  return (
    <Card title={t('quarantine.title')} icon="shield">
      <p className="muted">{t('quarantine.explain')}</p>
      <ul className="list">
        {rows.map((row) => (
          <li key={row.operationId}>
            <code>{row.type}</code> <span className="muted">{row.reason}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}


/**
 * The end of an event, said before it happens.
 *
 * Different from withdrawing a ticket, which is a tombstone in a log that keeps telling the
 * story: this removes the story — tickets, history, files — for everyone the event was shared
 * with. Phones that already hold a copy keep it; nothing can reach into them.
 */
function DeleteEventForm({ eventId, eventName }: { eventId: string; eventName: string }) {
  const { t, locale } = useT()
  const navigate = useNavigate()
  const [failure, setFailure] = useState<string>()

  return (
    <>
      <Banner kind="warning">{t('events.deleteWarning', { name: eventName })}</Banner>
      {failure ? <Banner kind="error">{failure}</Banner> : null}
      <Button
        variant="danger"
        onClick={async () => {
          try {
            await api.deleteEvent(locale, eventId)
            navigate('/')
          } catch (cause) {
            setFailure(cause instanceof ApiError ? cause.message : t('error.unexpected'))
          }
        }}
      >
        {t('events.deleteConfirm')}
      </Button>
    </>
  )
}
