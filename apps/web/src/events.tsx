import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type EventDetail, type EventSummary, type TicketSummary } from './api/passvault'
import { ApiError } from './api/client'
import { useT } from './i18n'
import { Banner, Button, Card, Field, Form, Loading, Select, StateBadge } from './ui'

/**
 * Events and the tickets inside them.
 *
 * The screens that matter here are the ones that say something the user cannot get back:
 * exporting a `.tkpak` and withdrawing a ticket. Both warn before, in the words the threat
 * model uses — withdraw, never revoke — because the file has already left and no interface
 * can pretend otherwise.
 */

export function EventsPage() {
  const { t, locale } = useT()
  const [events, setEvents] = useState<EventSummary[]>()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [error, setError] = useState<string>()

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
            .catch(() => ({ id: summary.id, name: '', passwordProtected: true })),
        ),
      )
      setEvents(loaded)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('error.unexpected'))
      setEvents([])
    }
  }, [locale, t])

  useEffect(() => {
    void load()
  }, [load])

  if (events === undefined) return <Loading />

  return (
    <>
      <Card title={t('events.title')}>
        {error ? <Banner kind="error">{error}</Banner> : null}
        {events.length === 0 ? <p className="muted">{t('common.empty')}</p> : null}
        <ul className="list">
          {events.map((event) => (
            <li key={event.id}>
              <Link to={`/events/${event.id}`}>
                <strong>{event.name || event.id.slice(0, 8)}</strong>
                {event.venue ? <span className="muted"> · {event.venue}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
        <Button variant="quiet" onClick={() => setCreating((open) => !open)}>
          {t('events.create')}
        </Button>
      </Card>

      {creating ? (
        <Card title={t('events.create')}>
          <Form
            submitLabel={t('action.save')}
            onSubmit={async () => {
              await api.createEvent(locale, {
                name,
                venue: venue || undefined,
                // The server wants a full instant, and a date input gives a day. Sent as
                // midnight UTC rather than dropped, which is what a bare date means here.
                startsAt: startsAt ? new Date(`${startsAt}T00:00:00.000Z`).toISOString() : undefined,
              })
              setName('')
              setVenue('')
              setStartsAt('')
              setCreating(false)
              await load()
            }}
          >
            <Field label={t('events.name')} value={name} onChange={setName} required />
            <Field label={t('events.venue')} value={venue} onChange={setVenue} />
            <Field label={t('events.startsAt')} value={startsAt} onChange={setStartsAt} type="date" />
          </Form>
        </Card>
      ) : null}

      <ImportCard onImported={load} />
    </>
  )
}

function ImportCard({ onImported }: { onImported: () => Promise<void> }) {
  const { t, locale } = useT()
  const [file, setFile] = useState<File>()
  const [password, setPassword] = useState('')
  const [result, setResult] = useState<{ count: number; event: string }>()

  return (
    <Card title={t('transfer.import')}>
      <input
        type="file"
        accept=".tkpak,application/vnd.passvault.tkpak,application/octet-stream"
        onChange={(event) => setFile(event.target.files?.[0])}
      />
      <Form
        submitLabel={t('transfer.import')}
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
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      const [detail, listed] = await Promise.all([
        api.event(locale, id),
        api.tickets(locale, id),
      ])
      setEvent(detail)
      setTickets(listed.tickets ?? [])
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

  if (needsPassword) {
    return (
      <Card title={t('events.openTitle')}>
        <p className="muted">{t('events.openExplain')}</p>
        <Form
          submitLabel={t('events.open')}
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

  return (
    <>
      <Card title={event.name}>
        {event.venue ? <p className="muted">{event.venue}</p> : null}
        {event.startsAt ? <p className="muted">{event.startsAt}</p> : null}
        <p>{t('events.tickets', { count: tickets.length })}</p>
        <Link to="/">{t('action.back')}</Link>
      </Card>

      <Card title={t('tickets.title')}>
        {tickets.length === 0 ? <p className="muted">{t('common.empty')}</p> : null}
        <ul className="list">
          {tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} onChanged={load} />
          ))}
        </ul>
      </Card>

      <AddTicketCard eventId={id} onAdded={load} />
      <IngestCard eventId={id} onIngested={load} />
      <ExportCard eventId={id} />
      <QuarantineCard eventId={id} />
    </>
  )
}

function TicketRow({ ticket, onChanged }: { ticket: TicketSummary; onChanged: () => Promise<void> }) {
  const { t, locale } = useT()
  const [open, setOpen] = useState(false)
  const [holder, setHolder] = useState('')
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)

  return (
    <li className="ticket">
      <button className="ticket-head" onClick={() => setOpen((value) => !value)}>
        <span>{ticket.label ?? ticket.id.slice(0, 8)}</span>
        {ticket.seat ? <span className="muted">{ticket.seat}</span> : null}
        <StateBadge state={ticket.assignmentState} />
      </button>

      {ticket.assignmentState === 'PROVISIONAL' ? (
        // Never rendered as settled. The single most important user-facing consequence of the
        // offline design, and the reason it is said here and not only in a list badge.
        <Banner kind="warning">{t('state.provisionalExplain')}</Banner>
      ) : null}

      {open ? (
        <div className="ticket-body">
          {ticket.barcodeValue ? (
            <p className="barcode">
              {ticket.barcodeValue}
              {ticket.barcodeFormat ? <span className="muted"> ({ticket.barcodeFormat})</span> : null}
            </p>
          ) : null}

          <Form
            submitLabel={t('tickets.assign')}
            onSubmit={async () => {
              await api.assign(locale, ticket.id, { holderLabel: holder })
              await onChanged()
            }}
          >
            <Field label={t('tickets.holder')} value={holder} onChange={setHolder} />
          </Form>

          <PaymentForm ticket={ticket} onChanged={onChanged} />

          {confirmWithdraw ? (
            <>
              <Banner kind="warning">{t('tickets.withdrawWarning')}</Banner>
              <Button
                variant="danger"
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
            </>
          ) : (
            <Button variant="quiet" onClick={() => setConfirmWithdraw(true)}>
              {t('tickets.withdraw')}
            </Button>
          )}

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
      ) : null}
    </li>
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
  const [state, setState] = useState(ticket.paymentState ?? 'PENDING')
  const [amount, setAmount] = useState(String((ticket.amountCents ?? 0) / 100))
  const [visibility, setVisibility] = useState('ALL')

  return (
    <Form
      submitLabel={t('payment.title')}
      onSubmit={async () => {
        await api.setPayment(locale, ticket.id, {
          state,
          // Integer cents, the same as everywhere else. Money as a float is how a total ends
          // up a penny out and nobody can say which row did it.
          amountCents: Math.round(Number(amount) * 100),
          currency: ticket.currency ?? 'EUR',
          visibility,
        })
        await onChanged()
      }}
    >
      <Select
        label={t('payment.state')}
        value={state}
        options={[
          { value: 'PENDING', label: t('payment.PENDING') },
          { value: 'PAID', label: t('payment.PAID') },
          { value: 'WAIVED', label: t('payment.WAIVED') },
        ]}
        onChange={setState}
      />
      <Field label={t('payment.amount')} value={amount} onChange={setAmount} type="number" />
      <Select
        label={t('payment.visibility')}
        value={visibility}
        options={[
          { value: 'ALL', label: t('payment.visibility.ALL') },
          { value: 'HOLDER_ONLY', label: t('payment.visibility.HOLDER_ONLY') },
          { value: 'CREATOR_ONLY', label: t('payment.visibility.CREATOR_ONLY') },
        ]}
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
    <Card title={t('tickets.add')}>
      <Form
        submitLabel={t('action.save')}
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
  const [proposal, setProposal] = useState<{ ingestId: string; tickets: unknown[] }>()
  const [excluded, setExcluded] = useState<Set<number>>(new Set())

  return (
    <Card title={t('ingest.title')}>
      <p className="muted">{t('ingest.explain')}</p>
      <input
        type="file"
        accept="application/pdf,image/*,.pkpass"
        onChange={(event) => setFile(event.target.files?.[0])}
      />
      {!proposal ? (
        <Form
          submitLabel={t('ingest.title')}
          disabled={!file}
          onSubmit={async () => {
            if (!file) return
            setProposal(await api.ingest(locale, eventId, file))
          }}
        >
          <span />
        </Form>
      ) : (
        <>
          <ul className="list">
            {proposal.tickets.map((raw, index) => {
              const ticket = raw as { suggestedLabel?: string; barcode?: { value: string } }
              const included = !excluded.has(index)
              return (
                <li key={index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() =>
                        setExcluded((current) => {
                          const next = new Set(current)
                          if (included) next.add(index)
                          else next.delete(index)
                          return next
                        })
                      }
                    />
                    {ticket.suggestedLabel ?? `#${index + 1}`}
                    {ticket.barcode ? (
                      <span className="muted"> · {ticket.barcode.value}</span>
                    ) : (
                      <span className="muted"> · {t('ingest.noBarcode')}</span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
          <Form
            submitLabel={t('ingest.confirm', { count: proposal.tickets.length - excluded.size })}
            onSubmit={async () => {
              const include = proposal.tickets
                .map((_, index) => index)
                .filter((index) => !excluded.has(index))
              await api.confirmIngest(locale, eventId, proposal.ingestId, include)
              setProposal(undefined)
              setExcluded(new Set())
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
    <Card title={t('transfer.export')}>
      {/* Said before the button, not after the download. */}
      <Banner kind="warning">{t('transfer.exportWarning')}</Banner>
      <Form
        submitLabel={t('transfer.export')}
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
    <Card title={t('quarantine.title')}>
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
