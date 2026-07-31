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
      updated_at: toInstant(),
    })
    .where('id', '=', input.ticketId)
    .execute()
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

export interface TicketProjection {
  id: string
  label: string | null
  section: string | null
  row: string | null
  seat: string | null
  barcode: { format: string; value: string } | null
  assignmentMode: string
  assignmentState: string
  holderUserId: string | null
  holderLabel: string | null
  status: string
  payment?: {
    state: string
    amountCents: number | null
    currency: string | null
    visibility: string
    settledAt: string | null
  }
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
      'payments.state as payment_state',
      'payments.amount_cents',
      'payments.currency',
      'payments.visibility',
      'payments.settled_at',
    ])
    .where('tickets.event_id', '=', input.eventId)
    .orderBy('tickets.created_at', 'asc')
    .execute()

  return rows.map((row) => {
    const isHolder = row.holder_user_id === input.viewerUserId
    const maySeeBarcode = isCreator || row.assignment_mode === 'OPEN' || isHolder

    const projection: TicketProjection = {
      id: row.id,
      label: decrypt(deps, input.eventKey, row.label_cipher, field(row.id, 'label_cipher')),
      section: decrypt(deps, input.eventKey, row.section_cipher, field(row.id, 'section_cipher')),
      row: decrypt(deps, input.eventKey, row.row_cipher, field(row.id, 'row_cipher')),
      seat: decrypt(deps, input.eventKey, row.seat_cipher, field(row.id, 'seat_cipher')),
      barcode:
        maySeeBarcode && row.barcode_cipher && row.barcode_format
          ? {
              format: row.barcode_format,
              value: deps.crypto.decryptField(
                input.eventKey,
                new Uint8Array(row.barcode_cipher),
                field(row.id, 'barcode_cipher'),
              ),
            }
          : null,
      assignmentMode: row.assignment_mode,
      assignmentState: row.assignment_state,
      holderUserId: row.holder_user_id,
      holderLabel: decrypt(
        deps,
        input.eventKey,
        row.holder_label_cipher,
        field(row.id, 'holder_label_cipher'),
      ),
      status: row.status,
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
