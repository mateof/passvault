import { useMemo } from 'react'
import type { TicketSummary } from './api/passvault'
import { useT } from './i18n'
import { Card } from './ui'

/**
 * What the group owes, added up.
 *
 * The figures were always there, one per ticket, and nobody ever added them: the question the
 * person who paid for ten seats actually asks — how much am I still owed, and by whom — could
 * only be answered by opening ten rows and doing the arithmetic. Two message keys for it had sat
 * in all three catalogues, unused, since payments were written.
 *
 * Derived from the ticket list rather than from a summary endpoint of its own, and that is the
 * decision worth stating. The server already decides, per ticket, whether this viewer may see its
 * payment — ALL, HOLDER_ONLY or CREATOR_ONLY, applied in `projectTickets`. A second place that
 * reasons about the same rule is a second chance to get it wrong and publish a figure somebody
 * chose to keep private. So this adds up exactly what arrived, which is exactly what the viewer
 * is allowed to know: a member who may see only their own debt sees a total of one.
 *
 * Money is grouped by currency and never converted. An event with seats bought in two currencies
 * shows two totals, because inventing an exchange rate would be inventing a number.
 */

interface Owed {
  /** The holder as this viewer knows them, or undefined for a seat nobody holds. */
  who: string | undefined
  cents: number
  currency: string
  tickets: number
}

interface Totals {
  paid: number
  total: number
  outstanding: Owed[]
}

const OUTSTANDING = new Set(['UNPAID', 'PARTIAL'])

function summarise(tickets: TicketSummary[]): Totals {
  const owed = new Map<string, Owed>()
  let paid = 0
  let total = 0

  for (const ticket of tickets) {
    const payment = ticket.payment
    // No payment on the row means either that none was recorded or that this viewer may not see
    // it. Both are silence, and silence is not a debt.
    if (!payment) {
      continue
    }
    total += 1
    if (!OUTSTANDING.has(payment.state)) {
      paid += 1
      continue
    }
    const who = ticket.holderHandle ?? ticket.holderLabel ?? undefined
    const currency = payment.currency ?? 'EUR'
    const key = `${who ?? ''} ${currency}`
    const entry = owed.get(key) ?? { who, cents: 0, currency, tickets: 0 }
    entry.cents += payment.amountCents ?? 0
    entry.tickets += 1
    owed.set(key, entry)
  }

  return {
    paid,
    total,
    // Most owed first, since that is the one worth sending a message about.
    outstanding: [...owed.values()].sort((left, right) => right.cents - left.cents),
  }
}

export function PaymentSummary({ tickets }: { tickets: TicketSummary[] }) {
  const { t, locale } = useT()
  const totals = useMemo(() => summarise(tickets), [tickets])

  // Nothing recorded, or nothing this viewer may see. Either way there is no card to draw.
  if (totals.total === 0) {
    return null
  }

  const money = (cents: number, currency: string) =>
    (cents / 100).toLocaleString(locale, { style: 'currency', currency })

  return (
    <Card title={t('payments.title')} icon="money">
      <p>{t('payment.summary', { paid: totals.paid, total: totals.total })}</p>
      {totals.outstanding.length === 0 ? (
        <p className="muted">{t('payments.allSettled')}</p>
      ) : (
        <ul className="list">
          {totals.outstanding.map((entry) => (
            <li key={`${entry.who ?? ''}-${entry.currency}`} className="payment-owed">
              <span>
                {entry.who
                  ? t('payment.owes', {
                      holder: entry.who,
                      amount: money(entry.cents, entry.currency),
                    })
                  : t('payments.unassignedOwes', { amount: money(entry.cents, entry.currency) })}
              </span>
              {/* How many seats, beside the figure. A seat marked unpaid with no amount against
                  it contributes nothing to the total, and "owes 0" on its own reads as settled. */}
              <span className="muted">{t('payments.owedTickets', { count: entry.tickets })}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
