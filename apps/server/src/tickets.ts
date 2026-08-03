import { createHash, randomBytes } from 'node:crypto'
import { hashPassword, toBase64Url, verifyPassword } from '@passvault/crypto'
import { newId, toInstant } from '@passvault/db'
import { canSeePayment, type AssignmentMode, type BarcodeFormat } from '@passvault/tkpak'
import { badRequest, conflict, forbidden, notFound } from './errors.js'
import { findEvent, hasAccess, type EventDeps } from './events.js'
import * as repo from './repository.js'

/**
 * Tickets, assignment, and the one genuinely hard part of the product: deciding who gets a
 * ticket when two people claimed it while neither was online.
 */

const field = (ticketId: string, column: string) => ({
  table: 'tickets',
  column,
  rowId: ticketId,
})

/** Precomputed so the reconciliation tiebreak is an ordinary indexed comparison. */
const deviceHash = (deviceId: string): string =>
  createHash('sha256').update(deviceId, 'utf8').digest('base64url')

export interface NewTicket {
  /**
   * Its identifier, when it already has one.
   *
   * A ticket added on a phone is referred to by later operations — an assignment, a payment, a
   * withdrawal — by the id that phone gave it. Minting a new one here would make every one of
   * those operations point at nothing.
   */
  id?: string
  label?: string
  section?: string
  row?: string
  seat?: string
  barcode?: { format: BarcodeFormat; value: string }
  documentBlobId?: string
  documentPage?: number
  /** The import it was split out of, so a document can list what it produced. */
  sourceBatchId?: string
  assignmentMode?: AssignmentMode
}

export async function addTickets(
  deps: EventDeps,
  input: {
    eventId: string
    actorUserId: string
    eventKey: Uint8Array
    tickets: NewTicket[]
  },
): Promise<string[]> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }

  const ids: string[] = []
  const now = toInstant()
  for (const ticket of input.tickets) {
    const id = ticket.id ?? newId()
    ids.push(id)
    await deps.db.db
      .insertInto('tickets')
      .values({
        id,
        event_id: input.eventId,
        label_cipher: ticket.label
          ? Buffer.from(
              deps.crypto.encryptField(input.eventKey, ticket.label, field(id, 'label_cipher')),
            )
          : null,
        section_cipher: ticket.section
          ? Buffer.from(
              deps.crypto.encryptField(input.eventKey, ticket.section, field(id, 'section_cipher')),
            )
          : null,
        row_cipher: ticket.row
          ? Buffer.from(
              deps.crypto.encryptField(input.eventKey, ticket.row, field(id, 'row_cipher')),
            )
          : null,
        seat_cipher: ticket.seat
          ? Buffer.from(
              deps.crypto.encryptField(input.eventKey, ticket.seat, field(id, 'seat_cipher')),
            )
          : null,
        // The format is plaintext so a client knows how to render the code before decrypting it;
        // the payload — the thing of value — is not.
        barcode_format: ticket.barcode?.format ?? null,
        barcode_cipher: ticket.barcode
          ? Buffer.from(
              deps.crypto.encryptField(
                input.eventKey,
                ticket.barcode.value,
                field(id, 'barcode_cipher'),
              ),
            )
          : null,
        document_blob_id: ticket.documentBlobId ?? null,
        document_page: ticket.documentPage ?? null,
        source_batch_id: ticket.sourceBatchId ?? null,
        // Per ticket rather than per event, so one event can mix allocated seats with
        // self-claim ones.
        assignment_mode: ticket.assignmentMode ?? (event.default_assignment_mode as AssignmentMode),
        assignment_state: 'FREE',
        holder_user_id: null,
        holder_label_cipher: null,
        assigned_at: null,
        exported_at: null,
        status: 'ACTIVE',
        // The visibility controls start neutral: seen as soon as held, never blocked, never
        // returned, not shareable onward. Everything here is the creator's to change afterwards.
        visible_from: null,
        visible_hours_before: null,
        creator_blocked: 0,
        revealed_at: null,
        returned_at: null,
        share_permitted: 0,
        created_at: now,
        updated_at: now,
      })
      .execute()
  }
  return ids
}

export async function assignTicket(
  deps: EventDeps,
  input: {
    ticketId: string
    actorUserId: string
    eventKey: Uint8Array
    holderUserId?: string
    holderLabel?: string
  },
): Promise<void> {
  const ticket = await requireTicket(deps, input.ticketId)
  const event = await findEvent(deps, ticket.event_id)
  if (!event || event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }
  if (!input.holderUserId && !input.holderLabel) {
    throw badRequest('claim.error.notClaimable')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({
      assignment_state: 'ASSIGNED',
      holder_user_id: input.holderUserId ?? null,
      // A holder with no account is stored as a name the organiser typed, which is user data and
      // therefore encrypted.
      holder_label_cipher: input.holderLabel
        ? Buffer.from(
            deps.crypto.encryptField(
              input.eventKey,
              input.holderLabel,
              field(input.ticketId, 'holder_label_cipher'),
            ),
          )
        : null,
      assigned_at: toInstant(),
      // Assigning to a holder starts them locked and un-returned, like a claim.
      returned_at: null,
      revealed_at: null,
      updated_at: toInstant(),
    })
    .where('id', '=', input.ticketId)
    .execute()
}

/**
 * Takes a free ticket for yourself, online.
 *
 * The self-claim mode as somebody in the group actually meets it: they open the event, press
 * claim, and get whichever ticket is still free. Coupons exist for the offline case — a phone
 * with no connectivity cannot be asked whether a ticket is still free, so it is given permission
 * in advance — and requiring one here would mean an organiser had to hand out a code per seat
 * before anybody could take theirs, which is the friction the mode exists to remove.
 *
 * One per person. Claiming is a race between friends, and a race the first person can win twice
 * is not a fair one.
 *
 * The guard against two people claiming the same seat is the `WHERE assignment_state = 'FREE'`
 * on the update, not the read above it: two requests can both see the same free ticket, and only
 * one of them can change a row that is still free. The loser is told to try again rather than
 * being handed a seat somebody else is already holding.
 */
export async function claimFreeTicket(
  deps: EventDeps,
  input: { eventId: string; userId: string; eventKey: Uint8Array },
): Promise<{ ticketId: string }> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }

  const held = await deps.db.db
    .selectFrom('tickets')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('holder_user_id', '=', input.userId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (held) {
    throw badRequest('claim.rejected.overAllowance', { allowance: 1 })
  }

  const free = (
    await deps.db.db
      .selectFrom('tickets')
      .select(['id', 'assignment_mode'])
      .where('event_id', '=', input.eventId)
      .where('status', '=', 'ACTIVE')
      .where('assignment_state', '=', 'FREE')
      .execute()
  ).filter((ticket) => ticket.assignment_mode === 'SELF_CLAIM')

  if (free.length === 0) {
    throw badRequest('claim.error.notClaimable')
  }

  // At random, which is what the request is: everybody grabbing the first-created ticket turns a
  // fair draw into a queue, and two people claiming at once would fight over the same row every
  // time. A uniform pick from cryptographic bytes spreads the contention and honours "al azar".
  const pick = (randomBytes(1)[0] ?? 0) % free.length
  const claimable = free[pick] as { id: string; assignment_mode: string }

  const result = await deps.db.db
    .updateTable('tickets')
    .set({
      assignment_state: 'CLAIMED',
      holder_user_id: input.userId,
      assigned_at: toInstant(),
      // A fresh holder starts as if the seat were new: not a return any more, and locked again
      // until the creator's gate lets it through.
      returned_at: null,
      revealed_at: null,
      updated_at: toInstant(),
    })
    .where('id', '=', claimable.id)
    .where('assignment_state', '=', 'FREE')
    .executeTakeFirst()

  if (Number(result.numUpdatedRows) === 0) {
    // Somebody else took it between the read and the write. Honest rather than silent: the
    // caller retries and gets the next one.
    throw badRequest('claim.rejected.lostRace')
  }

  await repo.recordAudit(deps.db, {
    actorUserId: input.userId,
    action: 'ticket.claimed',
    subjectKind: 'ticket',
    subjectId: claimable.id,
  })

  return { ticketId: claimable.id }
}

export interface IssuedCoupon {
  ticketId: string
  coupon: string
}

/**
 * Pre-issues one claim coupon per claimable ticket.
 *
 * This is what bounds an offline claim. A device with no connectivity cannot be asked whether a
 * ticket is still free, so instead it is given a coupon in advance: it can only claim a ticket
 * that was actually offered, and only up to its allowance. Without coupons, a client could
 * invent a claim for any ticket id it had ever seen.
 */
export async function issueClaimCoupons(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string; allowance?: number },
): Promise<IssuedCoupon[]> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }

  const claimable = await deps.db.db
    .selectFrom('tickets')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('status', '=', 'ACTIVE')
    .where('assignment_mode', '=', 'SELF_CLAIM')
    .where('assignment_state', '=', 'FREE')
    .execute()

  const issued: IssuedCoupon[] = []
  for (const ticket of claimable) {
    const coupon = toBase64Url(new Uint8Array(randomBytes(16)))
    await deps.db.db
      .insertInto('claim_coupons')
      .values({
        id: newId(),
        event_id: input.eventId,
        ticket_id: ticket.id,
        coupon_hash: await hashPassword(coupon, deps.argon2Params),
        allowance: input.allowance ?? 1,
        issued_by: input.actorUserId,
        issued_at: toInstant(),
        consumed_at: null,
      })
      .execute()
    issued.push({ ticketId: ticket.id, coupon })
  }
  return issued
}

export interface ClaimRequestInput {
  ticketId: string
  userId: string
  deviceId: string
  coupon: string
  /**
   * The claiming device's logical clock. Ordering never uses a wall clock: a phone whose date is
   * a week out must not win or lose a race because of it.
   */
  lamport: number
  operationId?: string
}

/**
 * Records a claim as PROVISIONAL.
 *
 * Nothing is decided here, and that is deliberate. The device may have been offline when the
 * user tapped claim, so the only honest state is "pending confirmation" — which the interface
 * shows as exactly that, rather than telling the user the ticket is theirs and taking it back
 * later.
 */
export async function submitClaim(deps: EventDeps, input: ClaimRequestInput): Promise<string> {
  const ticket = await requireTicket(deps, input.ticketId)
  if (!(await hasAccess(deps, ticket.event_id, input.userId))) {
    throw forbidden()
  }
  if (ticket.assignment_mode !== 'SELF_CLAIM') {
    throw badRequest('claim.error.notClaimable')
  }
  if (ticket.status !== 'ACTIVE') {
    throw badRequest('claim.rejected.ticketWithdrawn')
  }

  const operationId = input.operationId ?? newId()
  const existing = await deps.db.db
    .selectFrom('claim_requests')
    .select('id')
    .where('operation_id', '=', operationId)
    .executeTakeFirst()
  if (existing) {
    // Idempotent by operation id, so replaying a sync that was interrupted mid-push changes
    // nothing.
    return existing.id
  }

  const id = newId()
  await deps.db.db
    .insertInto('claim_requests')
    .values({
      id,
      operation_id: operationId,
      ticket_id: input.ticketId,
      device_id: input.deviceId,
      user_id: input.userId,
      lamport: input.lamport,
      device_id_hash: deviceHash(input.deviceId),
      state: 'PENDING',
      reason: null,
      created_at: toInstant(),
      resolved_at: null,
    })
    .execute()

  // Stored on the request, not the ticket, so a second claimant does not overwrite the first's
  // record. The ticket only moves to PROVISIONAL as a hint for the interface.
  if (ticket.assignment_state === 'FREE') {
    await deps.db.db
      .updateTable('tickets')
      .set({ assignment_state: 'PROVISIONAL', updated_at: toInstant() })
      .where('id', '=', input.ticketId)
      .where('assignment_state', '=', 'FREE')
      .execute()
  }

  await recordCouponAttempt(deps, input, id)
  return id
}

/** Validates the coupon now, so reconciliation does not have to re-derive Argon2id per request. */
async function recordCouponAttempt(
  deps: EventDeps,
  input: ClaimRequestInput,
  requestId: string,
): Promise<void> {
  const coupons = await deps.db.db
    .selectFrom('claim_coupons')
    .selectAll()
    .where('ticket_id', '=', input.ticketId)
    .execute()

  for (const coupon of coupons) {
    if (await verifyPassword(coupon.coupon_hash, input.coupon)) {
      return
    }
  }
  await deps.db.db
    .updateTable('claim_requests')
    .set({ state: 'DISCARDED', reason: 'claim.rejected.invalidCoupon', resolved_at: toInstant() })
    .where('id', '=', requestId)
    .execute()
}

export interface Reconciliation {
  ticketId: string
  confirmed?: { requestId: string; userId: string | null }
  rejected: { requestId: string; userId: string | null; reason: string }[]
  finalState: 'FREE' | 'CLAIMED' | 'WITHDRAWN'
}

/**
 * Decides a contended ticket.
 *
 * Deterministic by construction: ordering is `(lamport, sha256(deviceId))`, so any participant
 * replaying the same set of requests computes the same winner. That is what makes the outcome
 * verifiable rather than an arbitrary decision the server announces.
 *
 * Losers are rejected with a reason, never left in limbo. Silently dropping a claim is the
 * failure this whole mechanism exists to avoid.
 */
export async function reconcileTicket(deps: EventDeps, ticketId: string): Promise<Reconciliation> {
  const ticket = await requireTicket(deps, ticketId)
  const pending = await deps.db.db
    .selectFrom('claim_requests')
    .selectAll()
    .where('ticket_id', '=', ticketId)
    .where('state', '=', 'PENDING')
    .orderBy('lamport', 'asc')
    .orderBy('device_id_hash', 'asc')
    .execute()

  const result: Reconciliation = { ticketId, rejected: [], finalState: 'FREE' }

  if (ticket.status !== 'ACTIVE') {
    for (const request of pending) {
      await resolve(deps, request.id, 'REJECTED', 'claim.rejected.ticketWithdrawn')
      result.rejected.push({
        requestId: request.id,
        userId: request.user_id,
        reason: 'claim.rejected.ticketWithdrawn',
      })
    }
    result.finalState = 'WITHDRAWN'
    return result
  }

  if (ticket.assignment_state === 'CLAIMED' || ticket.assignment_state === 'ASSIGNED') {
    // Already settled — by an earlier reconciliation, or by the organiser assigning it directly.
    for (const request of pending) {
      await resolve(deps, request.id, 'REJECTED', 'claim.rejected.lostRace')
      result.rejected.push({
        requestId: request.id,
        userId: request.user_id,
        reason: 'claim.rejected.lostRace',
      })
    }
    result.finalState = 'CLAIMED'
    return result
  }

  let winner: (typeof pending)[number] | undefined
  for (const request of pending) {
    if (!winner && (await withinAllowance(deps, ticket.event_id, request.user_id, ticketId))) {
      winner = request
      continue
    }
    const reason = winner ? 'claim.rejected.lostRace' : 'claim.rejected.overAllowance'
    await resolve(deps, request.id, 'REJECTED', reason)
    result.rejected.push({ requestId: request.id, userId: request.user_id, reason })
  }

  if (!winner) {
    await deps.db.db
      .updateTable('tickets')
      .set({ assignment_state: 'FREE', updated_at: toInstant() })
      .where('id', '=', ticketId)
      .execute()
    return result
  }

  await resolve(deps, winner.id, 'CONFIRMED', null)
  await deps.db.db
    .updateTable('tickets')
    .set({
      assignment_state: 'CLAIMED',
      holder_user_id: winner.user_id,
      assigned_at: toInstant(),
      updated_at: toInstant(),
    })
    .where('id', '=', ticketId)
    .execute()
  await deps.db.db
    .updateTable('claim_coupons')
    .set({ consumed_at: toInstant() })
    .where('ticket_id', '=', ticketId)
    .execute()

  result.confirmed = { requestId: winner.id, userId: winner.user_id }
  result.finalState = 'CLAIMED'
  return result
}

async function resolve(
  deps: EventDeps,
  requestId: string,
  state: 'CONFIRMED' | 'REJECTED',
  reason: string | null,
): Promise<void> {
  await deps.db.db
    .updateTable('claim_requests')
    .set({ state, reason, resolved_at: toInstant() })
    .where('id', '=', requestId)
    .execute()
}

/** How many tickets this user has already been confirmed for in this event, against the allowance. */
async function withinAllowance(
  deps: EventDeps,
  eventId: string,
  userId: string | null,
  ticketId: string,
): Promise<boolean> {
  if (!userId) {
    return true
  }
  const coupon = await deps.db.db
    .selectFrom('claim_coupons')
    .select('allowance')
    .where('ticket_id', '=', ticketId)
    .executeTakeFirst()
  const allowance = coupon?.allowance ?? 1

  const confirmed = await deps.db.db
    .selectFrom('claim_requests')
    .innerJoin('tickets', 'tickets.id', 'claim_requests.ticket_id')
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .where('tickets.event_id', '=', eventId)
    .where('claim_requests.user_id', '=', userId)
    .where('claim_requests.state', '=', 'CONFIRMED')
    .executeTakeFirstOrThrow()

  return Number(confirmed.total) < allowance
}

export async function withdrawTicket(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string },
): Promise<void> {
  const ticket = await requireTicket(deps, input.ticketId)
  const event = await findEvent(deps, ticket.event_id)
  if (!event || event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }
  await deps.db.db
    .updateTable('tickets')
    .set({ status: 'WITHDRAWN', updated_at: toInstant() })
    .where('id', '=', input.ticketId)
    .execute()
  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    // Named withdrawn, not revoked. Anybody who already holds the barcode still holds it.
    action: 'ticket.withdrawn',
    subjectKind: 'ticket',
    subjectId: input.ticketId,
  })
}

export async function setPayment(
  deps: EventDeps,
  input: {
    ticketId: string
    actorUserId: string
    state: 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED'
    amountCents?: number
    currency?: string
    visibility: 'ALL' | 'HOLDER_ONLY' | 'CREATOR_ONLY'
  },
): Promise<void> {
  const ticket = await requireTicket(deps, input.ticketId)
  const event = await findEvent(deps, ticket.event_id)
  if (!event || event.creator_user_id !== input.actorUserId) {
    // Only the organiser records payments. A member marking their own ticket paid would make the
    // record worthless.
    throw forbidden()
  }
  if ((input.amountCents === undefined) !== (input.currency === undefined)) {
    throw badRequest('error.unexpected')
  }

  const existing = await deps.db.db
    .selectFrom('payments')
    .select('id')
    .where('ticket_id', '=', input.ticketId)
    .executeTakeFirst()

  const values = {
    state: input.state,
    amount_cents: input.amountCents ?? null,
    currency: input.currency ?? null,
    visibility: input.visibility,
    settled_at: input.state === 'PAID' ? toInstant() : null,
    recorded_by: input.actorUserId,
    updated_at: toInstant(),
  }

  if (existing) {
    await deps.db.db.updateTable('payments').set(values).where('id', '=', existing.id).execute()
    return
  }
  await deps.db.db
    .insertInto('payments')
    .values({ id: newId(), ticket_id: input.ticketId, ...values })
    .execute()
}

/**
 * What a viewer can do about claiming, since they no longer see the free tickets themselves.
 *
 * A member's ticket list is filtered to what is theirs, which means the free self-claim tickets
 * are invisible to them — correct for privacy, but then how do they know there is one to grab?
 * This is the answer the button reads: how many are claimable, and whether they already hold one.
 */
export interface ClaimSummary {
  /** Free self-claim tickets left in the event. */
  freeToClaim: number
  /** True once this viewer holds a ticket here, so the button becomes "you already have one". */
  alreadyHolds: boolean
}

export async function claimSummary(
  deps: EventDeps,
  input: { eventId: string; viewerUserId: string },
): Promise<ClaimSummary> {
  const free = await deps.db.db
    .selectFrom('tickets')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('event_id', '=', input.eventId)
    .where('status', '=', 'ACTIVE')
    .where('assignment_mode', '=', 'SELF_CLAIM')
    .where('assignment_state', '=', 'FREE')
    .executeTakeFirst()
  const held = await deps.db.db
    .selectFrom('tickets')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('status', '=', 'ACTIVE')
    .where('holder_user_id', '=', input.viewerUserId)
    .executeTakeFirst()
  return { freeToClaim: Number(free?.count ?? 0), alreadyHolds: held !== undefined }
}

export interface TicketProjection {
  id: string
  label: string | null
  section: string | null
  row: string | null
  seat: string | null
  barcode: { format: string; value: string } | null
  /**
   * Whether a barcode download would succeed right now — the viewer is entitled and it is not
   * locked. For a holder the barcode itself is never in the list: they fetch it once, on view,
   * and that fetch is what marks it seen. This flag is how the list offers the "view" without
   * handing the code over.
   */
  barcodeAvailable: boolean
  assignmentMode: string
  assignmentState: string
  holderUserId: string | null
  holderLabel: string | null
  /** The holder's public name, resolved for the creator so a claim reads as a person, not an id. */
  holderHandle: string | null
  status: string
  /** The moment the barcode may first be seen, or null for no time gate. Shown as a countdown. */
  visibleFrom: string | null
  /** True when this viewer is entitled to the barcode but it is currently withheld. */
  locked: boolean
  /** Why it is withheld: 'blocked', 'unpaid', or 'notYet'. Null when it is not locked. */
  lockReason: 'blocked' | 'unpaid' | 'notYet' | null
  /** Whether the creator is holding it back. Their control, shown to them and to the holder. */
  blocked: boolean
  /** When it was handed back and left free, for the creator's list. Null otherwise. */
  returnedAt: string | null
  /** Whether the barcode has ever been served to the holder — past which it cannot be blocked. */
  revealed: boolean
  /** Whether the holder is allowed to pass this ticket on. Off unless the creator lent it. */
  sharePermitted: boolean
  payment?: {
    state: string
    amountCents: number | null
    currency: string | null
    visibility: string
    settledAt: string | null
  }
}

/**
 * When a ticket's barcode becomes visible, as an absolute instant, or null for no time gate.
 *
 * The relative rule wins when it and an event start are both present, so a re-dated event carries
 * its "day before" with it rather than stranding an absolute moment the creator has to redo.
 */
function effectiveVisibleFrom(
  ticket: { visible_from: string | null; visible_hours_before: number | null },
  event: { starts_at: string | null },
): string | null {
  if (ticket.visible_hours_before != null && event.starts_at) {
    return toInstant(new Date(new Date(event.starts_at).getTime() - ticket.visible_hours_before * 3600_000))
  }
  return ticket.visible_from
}

/**
 * Projects an event's tickets for one viewer.
 *
 * Two rules are enforced here rather than in an interface:
 *
 *   * a barcode is included only for someone entitled to it — under ASSIGNED and SELF_CLAIM,
 *     that is the holder and the organiser, not every member of the group;
 *   * a payment record the viewer may not see is **omitted**, not flagged. Sending it and asking
 *     the client not to display it is not a control.
 */
export async function projectTickets(
  deps: EventDeps,
  input: { eventId: string; viewerUserId: string; eventKey: Uint8Array },
): Promise<TicketProjection[]> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  const isCreator = event.creator_user_id === input.viewerUserId

  const rows = await deps.db.db
    .selectFrom('tickets')
    .leftJoin('payments', 'payments.ticket_id', 'tickets.id')
    .select([
      'tickets.id',
      'tickets.label_cipher',
      'tickets.section_cipher',
      'tickets.row_cipher',
      'tickets.seat_cipher',
      'tickets.barcode_format',
      'tickets.barcode_cipher',
      'tickets.assignment_mode',
      'tickets.assignment_state',
      'tickets.holder_user_id',
      'tickets.holder_label_cipher',
      'tickets.status',
      'tickets.visible_from',
      'tickets.visible_hours_before',
      'tickets.creator_blocked',
      'tickets.revealed_at',
      'tickets.returned_at',
      'tickets.share_permitted',
      'payments.state as payment_state',
      'payments.amount_cents',
      'payments.currency',
      'payments.visibility',
      'payments.settled_at',
    ])
    .where('tickets.event_id', '=', input.eventId)
    .orderBy('tickets.created_at', 'asc')
    .execute()

  const now = toInstant()

  // Who holds each ticket, by handle, resolved once for the creator. A claim they cannot put a
  // name to is a list of ticket ids and user ids — true, and useless for "who got which".
  const handles = new Map<string, string | null>()
  if (isCreator) {
    const holderIds = [...new Set(rows.map((r) => r.holder_user_id).filter(Boolean))] as string[]
    if (holderIds.length > 0) {
      const found = await deps.db.db
        .selectFrom('users')
        .select(['id', 'handle'])
        .where('id', 'in', holderIds)
        .execute()
      for (const user of found) {
        handles.set(user.id, user.handle)
      }
    }
  }

  // Barcodes served to a holder for the first time, so the reveal line is written once the read
  // has actually handed the code over rather than when the creator merely allowed it.
  const projected = rows.map((row) => {
    const isHolder = row.holder_user_id === input.viewerUserId
    // Whether this viewer is entitled to the barcode at all: the creator always, a member only
    // for a shared-wallet (OPEN) ticket or one they hold.
    const entitled = row.assignment_mode === 'OPEN' || isHolder

    // The gate the creator controls. It applies to a member's view only — the creator sees their
    // own barcode regardless, because withholding it from themselves protects no one.
    const visibleFrom = effectiveVisibleFrom(row, event)
    const unpaid = row.payment_state === 'UNPAID' || row.payment_state === 'PARTIAL'
    const lockReason: 'blocked' | 'unpaid' | 'notYet' | null = row.creator_blocked === 1
      ? 'blocked'
      : unpaid
        ? 'unpaid'
        : visibleFrom && now < visibleFrom
          ? 'notYet'
          : null
    const locked = !isCreator && entitled && lockReason !== null
    const maySeeBarcode = isCreator || (entitled && lockReason === null)

    // A holder never gets the barcode in the list. They fetch it once, on view, through the
    // download endpoint, and that fetch is what reveals it and closes the creator's window to
    // pull it back. The creator sees their own inline (it is theirs), and an OPEN ticket is a
    // shared wallet with nothing to withhold, so those keep the value here.
    const holderGate = !isCreator && isHolder

    const projection: TicketProjection = {
      id: row.id,
      label: decrypt(deps, input.eventKey, row.label_cipher, field(row.id, 'label_cipher')),
      section: decrypt(deps, input.eventKey, row.section_cipher, field(row.id, 'section_cipher')),
      row: decrypt(deps, input.eventKey, row.row_cipher, field(row.id, 'row_cipher')),
      seat: decrypt(deps, input.eventKey, row.seat_cipher, field(row.id, 'seat_cipher')),
      barcode:
        maySeeBarcode && !holderGate && row.barcode_cipher && row.barcode_format
          ? {
              format: row.barcode_format,
              value: deps.crypto.decryptField(
                input.eventKey,
                new Uint8Array(row.barcode_cipher),
                field(row.id, 'barcode_cipher'),
              ),
            }
          : null,
      barcodeAvailable: maySeeBarcode && row.barcode_cipher !== null,
      assignmentMode: row.assignment_mode,
      assignmentState: row.assignment_state,
      holderUserId: row.holder_user_id,
      holderLabel: decrypt(
        deps,
        input.eventKey,
        row.holder_label_cipher,
        field(row.id, 'holder_label_cipher'),
      ),
      holderHandle: row.holder_user_id ? (handles.get(row.holder_user_id) ?? null) : null,
      status: row.status,
      visibleFrom,
      locked,
      lockReason: locked ? lockReason : null,
      blocked: row.creator_blocked === 1,
      returnedAt: row.returned_at,
      // The line past which the creator can no longer block: drawn by the download endpoint when
      // the holder actually fetches the code, not by merely listing the event.
      revealed: row.revealed_at !== null,
      sharePermitted: row.share_permitted === 1,
    }

    if (
      row.payment_state &&
      row.visibility &&
      canSeePayment(row.visibility as 'ALL' | 'HOLDER_ONLY' | 'CREATOR_ONLY', {
        isCreator,
        isHolder,
      })
    ) {
      projection.payment = {
        state: row.payment_state,
        amountCents: row.amount_cents,
        currency: row.currency,
        visibility: row.visibility,
        settledAt: row.settled_at,
      }
    }

    return projection
  })

  // Under self-claim a member sees only the ticket they took — "vea só a súa entrada". The free
  // ones and those other people grabbed are not on their screen at all; the claim button, which
  // reads the count separately, is how they know there is one to take. Open and assigned events
  // are left as they were: a shared wallet shows everything, an assigned one shows the list with
  // barcodes gated, and only the creator sees the whole self-claim draw and who won each seat.
  if (isCreator) {
    return projected
  }
  return projected.filter(
    (ticket) =>
      ticket.assignmentMode !== 'SELF_CLAIM' || ticket.holderUserId === input.viewerUserId,
  )
}

/**
 * The creator's controls over one ticket's barcode.
 *
 * Each is a small, guarded write, and the guards are the feature: a block that arrives after the
 * barcode has been seen is refused, because it would be a promise the screen cannot keep.
 */
async function requireCreator(deps: EventDeps, ticketId: string) {
  const ticket = await requireTicket(deps, ticketId)
  const event = await findEvent(deps, ticket.event_id)
  if (!event) {
    throw notFound()
  }
  return { ticket, event }
}

/** Sets when the holder may first see the barcode: an absolute moment, hours before the event, or neither. */
export async function setTicketVisibility(
  deps: EventDeps,
  input: {
    ticketId: string
    actorUserId: string
    visibleFrom?: string | null
    hoursBeforeEvent?: number | null
  },
): Promise<void> {
  const { event } = await requireCreator(deps, input.ticketId)
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({
      // At most one gate: a relative rule and an absolute one at once would be two answers to one
      // question. Setting either clears the other.
      visible_from: input.hoursBeforeEvent != null ? null : (input.visibleFrom ?? null),
      visible_hours_before: input.visibleFrom != null ? null : (input.hoursBeforeEvent ?? null),
      updated_at: toInstant(),
    })
    .where('id', '=', input.ticketId)
    .execute()
}

/**
 * Holds a barcode back, or refuses to when it is already out.
 *
 * The refusal is the point: once the barcode has been served, the holder may have a photograph,
 * and a block that pretended otherwise would be security theatre. So blocking is allowed only
 * while the ticket has never been revealed.
 */
export async function blockTicket(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string },
): Promise<void> {
  const { ticket, event } = await requireCreator(deps, input.ticketId)
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }
  if (ticket.revealed_at) {
    throw badRequest('ticket.error.alreadyRevealed')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({ creator_blocked: 1, updated_at: toInstant() })
    .where('id', '=', input.ticketId)
    .execute()
}

/** Lets the barcode through again. Always allowed — the creator can change their mind at any time. */
export async function unblockTicket(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string },
): Promise<void> {
  const { event } = await requireCreator(deps, input.ticketId)
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({ creator_blocked: 0, updated_at: toInstant() })
    .where('id', '=', input.ticketId)
    .execute()
}

/** Lends or revokes the holder's ability to pass this ticket on. */
export async function setSharePermission(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string; permitted: boolean },
): Promise<void> {
  const { event } = await requireCreator(deps, input.ticketId)
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({ share_permitted: input.permitted ? 1 : 0, updated_at: toInstant() })
    .where('id', '=', input.ticketId)
    .execute()
}

/**
 * Hands a seat back, if it can still be handed back.
 *
 * Only the holder, and only while the barcode is still locked to them: once it has been revealed
 * there is nothing left to return honestly — they have seen the code. The seat goes back to the
 * pool free, marked returned so the creator's list can say so, and its reveal line is cleared so
 * whoever takes it next starts locked again.
 */
export async function returnTicket(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string },
): Promise<void> {
  const ticket = await requireTicket(deps, input.ticketId)
  if (ticket.holder_user_id !== input.actorUserId) {
    throw forbidden('ticket.error.notHolder')
  }
  if (ticket.revealed_at) {
    // The whole point of returning is to give back something unused. A revealed barcode is not
    // that, so the interface must not pretend a return undoes having seen it.
    throw badRequest('ticket.error.alreadyRevealed')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({
      assignment_state: 'FREE',
      holder_user_id: null,
      holder_label_cipher: null,
      assigned_at: null,
      returned_at: toInstant(),
      revealed_at: null,
      updated_at: toInstant(),
    })
    .where('id', '=', input.ticketId)
    .execute()
  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: 'ticket.returned',
    subjectKind: 'ticket',
    subjectId: input.ticketId,
  })
}

/**
 * Takes an assignment back, if the holder has not yet seen the code.
 *
 * The creator's mirror of {@link returnTicket}: same guard, opposite hand. Once the barcode has been
 * downloaded it is out — the holder may have a photograph — so a creator who could still pull the
 * seat back then would be trusting a promise the screen cannot keep. The seat returns to the pool
 * free; because assignment is server state and never an operation, undoing it is a server write and
 * nothing needs to reach the old holder's log — they simply stop being its holder.
 */
export async function unassignTicket(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string },
): Promise<void> {
  const { ticket, event } = await requireCreator(deps, input.ticketId)
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }
  if (ticket.revealed_at) {
    throw badRequest('ticket.error.alreadyRevealed')
  }
  await deps.db.db
    .updateTable('tickets')
    .set({
      assignment_state: 'FREE',
      holder_user_id: null,
      holder_label_cipher: null,
      assigned_at: null,
      returned_at: null,
      revealed_at: null,
      updated_at: toInstant(),
    })
    .where('id', '=', input.ticketId)
    .execute()
  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: 'ticket.unassigned',
    subjectKind: 'ticket',
    subjectId: input.ticketId,
  })
}

/**
 * Serves a barcode on demand — the download that stands in for a holder ever carrying it.
 *
 * This is the only path a holder's code reaches a screen: it is not in the list, not in the sync
 * log, only here. Refused while locked or to a viewer not entitled. The moment it crosses to a
 * non-creator holder it is marked revealed — from there the creator can no longer block it and a
 * return is no longer honest — so the act of downloading is the act of being seen.
 */
export async function getTicketBarcode(
  deps: EventDeps,
  input: { ticketId: string; viewerUserId: string; eventKey: Uint8Array },
): Promise<{ format: string; value: string }> {
  const ticket = await requireTicket(deps, input.ticketId)
  const event = await findEvent(deps, ticket.event_id)
  if (!event) {
    throw notFound()
  }
  const payment = await deps.db.db
    .selectFrom('payments')
    .select('state')
    .where('ticket_id', '=', input.ticketId)
    .executeTakeFirst()

  const isCreator = event.creator_user_id === input.viewerUserId
  const isHolder = ticket.holder_user_id === input.viewerUserId
  const entitled = ticket.assignment_mode === 'OPEN' || isHolder
  if (!isCreator && !entitled) {
    throw forbidden()
  }
  const visibleFrom = effectiveVisibleFrom(ticket, event)
  const unpaid = payment?.state === 'UNPAID' || payment?.state === 'PARTIAL'
  const locked =
    !isCreator &&
    (ticket.creator_blocked === 1 ||
      unpaid ||
      (visibleFrom !== null && toInstant() < visibleFrom))
  if (locked) {
    throw badRequest('ticket.error.locked')
  }
  if (!ticket.barcode_cipher || !ticket.barcode_format) {
    throw notFound()
  }
  // The download is the reveal. Written before the value leaves, and only for a genuine holder:
  // the creator reading their own code does not close their own window to take the seat back.
  if (!isCreator && isHolder && !ticket.revealed_at) {
    await deps.db.db
      .updateTable('tickets')
      .set({ revealed_at: toInstant(), updated_at: toInstant() })
      .where('id', '=', input.ticketId)
      .where('revealed_at', 'is', null)
      .execute()
  }
  return {
    format: ticket.barcode_format,
    value: deps.crypto.decryptField(
      input.eventKey,
      new Uint8Array(ticket.barcode_cipher),
      field(input.ticketId, 'barcode_cipher'),
    ),
  }
}

function decrypt(
  deps: EventDeps,
  key: Uint8Array,
  stored: Buffer | Uint8Array | null,
  ref: { table: string; column: string; rowId: string },
): string | null {
  return stored === null ? null : deps.crypto.decryptField(key, new Uint8Array(stored), ref)
}

async function requireTicket(deps: EventDeps, ticketId: string) {
  const ticket = await deps.db.db
    .selectFrom('tickets')
    .selectAll()
    .where('id', '=', ticketId)
    .executeTakeFirst()
  if (!ticket) {
    throw notFound()
  }
  return ticket
}

export async function ensureDevice(
  deps: EventDeps,
  input: { userId: string; deviceId?: string; name?: string },
): Promise<string> {
  if (input.deviceId) {
    const existing = await deps.db.db
      .selectFrom('devices')
      .select('id')
      .where('id', '=', input.deviceId)
      .executeTakeFirst()
    if (existing) {
      return existing.id
    }
  }
  const id = input.deviceId ?? newId()
  try {
    await deps.db.db
      .insertInto('devices')
      .values({
        id,
        user_id: input.userId,
        name: input.name ?? 'web',
        signing_public_key: `pending:${id}`,
        agreement_public_key: `pending:${id}`,
        status: 'ACTIVE',
        created_at: toInstant(),
        last_seen_at: toInstant(),
      })
      .execute()
  } catch (cause) {
    throw conflict('error.unexpected', undefined)
  }
  return id
}
