import { createHash } from 'node:crypto'
import { domainSeparated, fromBase64Url, toBase64Url, verifyBytes } from '@passvault/crypto'
import { newId, toInstant } from '@passvault/db'
import { badRequest, forbidden, notFound } from './errors.js'
import { ensureServerDevice, serverDeviceFrom, signAsServer } from './server-device.js'
import { findEvent, hasAccess, type EventDeps } from './events.js'
import * as repo from './repository.js'
import { reconcileTicket, setPayment, submitClaim } from './tickets.js'

/**
 * The signed operation log, as specified in `docs/spec/sync-protocol.md`.
 *
 * Devices exchange operations rather than state, because state loses the information needed to
 * decide who was first. Two devices that both moved a ticket from FREE to CLAIMED produce
 * identical state; only their histories differ, and that history is the product's hardest case.
 */
export const OPERATION_DOMAIN = 'passvault/v1/operation'

export type OperationType =
  | 'event.update'
  | 'ticket.assign'
  | 'ticket.unassign'
  | 'ticket.remove'
  | 'claim.request'
  | 'payment.set'

/** Types this version applies. Anything else is retained, not lost — see `applyOperation`. */
const APPLIED_TYPES: readonly string[] = [
  'event.update',
  'ticket.assign',
  'ticket.unassign',
  'ticket.remove',
  'claim.request',
  'payment.set',
]

/** Types only the event's creator may issue. Checked on replay, not trusted from the sender. */
const CREATOR_ONLY: readonly string[] = [
  'event.update',
  'ticket.assign',
  'ticket.unassign',
  'ticket.remove',
  'payment.set',
]

export interface SignedOperation {
  operationId: string
  deviceId: string
  actorUserId?: string | null
  lamport: number
  wallClock: string
  scope: { kind: 'event'; id: string }
  type: string
  body: Record<string, unknown>
  /** Ed25519 over the canonical form, base64url. */
  signature: string
}

/**
 * The canonical form an operation is signed over: sorted keys, no whitespace, signature omitted.
 *
 * This is the one place the project accepts a canonicalisation rule, and `.tkpak` deliberately
 * does not. A manifest is stored bytes, so "sign exactly what is on disk" works — the bytes exist.
 * An operation is re-serialised at every hop: a phone reads it from a file, holds it in SQLite, and
 * later posts it as JSON. There are no original bytes to preserve, so the rule has to be something
 * two implementations can both reproduce.
 */
export function canonicalBytes(operation: Omit<SignedOperation, 'signature'>): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(operation), 'utf8'))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined is dropped rather than serialised, so an optional field being absent and being
    // explicitly undefined produce the same bytes — otherwise a signature would depend on how a
    // client happened to build the object.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

export function signingInput(operation: Omit<SignedOperation, 'signature'>): Uint8Array {
  return domainSeparated(
    OPERATION_DOMAIN,
    new Uint8Array(createHash('sha256').update(canonicalBytes(operation)).digest()),
  )
}

const deviceHash = (deviceId: string): string =>
  createHash('sha256').update(deviceId, 'utf8').digest('base64url')

export interface RegisterDeviceInput {
  userId: string
  name: string
  /** Ed25519, base64url. What every signature from this device is checked against. */
  signingPublicKey: string
  /** X25519, base64url. Used for local pairing and sealed exports. */
  agreementPublicKey: string
  deviceId?: string
}

export async function registerDevice(
  deps: EventDeps,
  input: RegisterDeviceInput,
): Promise<{ deviceId: string }> {
  for (const key of [input.signingPublicKey, input.agreementPublicKey]) {
    try {
      if (fromBase64Url(key).length !== 32) {
        throw new Error('wrong length')
      }
    } catch {
      throw badRequest('error.unexpected')
    }
  }

  const existing = await deps.db.db
    .selectFrom('devices')
    .selectAll()
    .where('signing_public_key', '=', input.signingPublicKey)
    .executeTakeFirst()
  if (existing) {
    if (existing.user_id !== input.userId) {
      // A signing key identifies one device. Letting two accounts claim the same key would make
      // every signature ambiguous.
      throw forbidden()
    }
    await deps.db.db
      .updateTable('devices')
      .set({ last_seen_at: toInstant(), status: 'ACTIVE' })
      .where('id', '=', existing.id)
      .execute()
    return { deviceId: existing.id }
  }

  const deviceId = input.deviceId ?? newId()
  await deps.db.db
    .insertInto('devices')
    .values({
      id: deviceId,
      user_id: input.userId,
      name: input.name,
      signing_public_key: input.signingPublicKey,
      agreement_public_key: input.agreementPublicKey,
      status: 'ACTIVE',
      created_at: toInstant(),
      last_seen_at: toInstant(),
    })
    .execute()
  await repo.recordAudit(deps.db, {
    actorUserId: input.userId,
    actorDeviceId: deviceId,
    action: 'device.registered',
    subjectKind: 'device',
    subjectId: deviceId,
  })
  return { deviceId }
}

export type OperationOutcome =
  | { operationId: string; state: 'APPLIED' }
  | { operationId: string; state: 'DUPLICATE' }
  | { operationId: string; state: 'QUARANTINED'; reason: string }
  | { operationId: string; state: 'REJECTED'; reason: string }

export interface PushResult {
  outcomes: OperationOutcome[]
  /** Tickets whose claims were reconciled after the batch, once rather than per operation. */
  reconciled: string[]
}

export interface SyncDeps extends EventDeps {
  crypto: EventDeps['crypto']
}

/**
 * Accepts a batch of operations.
 *
 * Reconciliation runs once at the end rather than per operation, which is the whole reason a batch
 * exists: a device replaying three offline claims must have them ordered against each other before
 * any is confirmed, not resolved one at a time in arrival order.
 */
export async function pushOperations(
  deps: SyncDeps,
  input: {
    eventId: string
    actorUserId: string
    eventKey: Uint8Array
    operations: SignedOperation[]
  },
): Promise<PushResult> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (!(await hasAccess(deps, input.eventId, input.actorUserId))) {
    throw forbidden()
  }

  const outcomes: OperationOutcome[] = []
  const touchedTickets = new Set<string>()

  for (const operation of input.operations) {
    outcomes.push(
      await accept(deps, {
        event,
        operation,
        actorUserId: input.actorUserId,
        eventKey: input.eventKey,
        touchedTickets,
      }),
    )
  }

  const reconciled: string[] = []
  for (const ticketId of touchedTickets) {
    await reconcileTicket(deps, ticketId)
    reconciled.push(ticketId)
  }

  return { outcomes, reconciled }
}

async function accept(
  deps: SyncDeps,
  context: {
    event: NonNullable<Awaited<ReturnType<typeof findEvent>>>
    operation: SignedOperation
    actorUserId: string
    eventKey: Uint8Array
    touchedTickets: Set<string>
  },
): Promise<OperationOutcome> {
  const { operation } = context

  if (operation.scope.kind !== 'event' || operation.scope.id !== context.event.id) {
    return { operationId: operation.operationId, state: 'REJECTED', reason: 'scope_mismatch' }
  }

  // Idempotent by operation id. Retrying an interrupted push is safe, and a duplicate is counted
  // rather than applied — which is what lets a device push without tracking what got through.
  const existing = await deps.db.db
    .selectFrom('operations')
    .select('operation_id')
    .where('operation_id', '=', operation.operationId)
    .executeTakeFirst()
  if (existing) {
    return { operationId: operation.operationId, state: 'DUPLICATE' }
  }

  const device = await deps.db.db
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', operation.deviceId)
    .executeTakeFirst()

  if (!device || device.status !== 'ACTIVE') {
    // Retained, not dropped. An unknown device is usually a peer whose key has not been exchanged
    // yet, so the operation waits in quarantine where the user can see it.
    await store(deps, context, 'QUARANTINED', 'unknown_device')
    return { operationId: operation.operationId, state: 'QUARANTINED', reason: 'unknown_device' }
  }

  const { signature, ...unsigned } = operation
  const verified = verifyBytes(
    fromBase64Url(device.signing_public_key),
    signingInput(unsigned),
    fromBase64Url(signature),
  )
  if (!verified) {
    await store(deps, context, 'REJECTED', 'bad_signature')
    return { operationId: operation.operationId, state: 'REJECTED', reason: 'bad_signature' }
  }

  // Authorisation is checked here rather than trusted from the sender, and on every device that
  // replays the log — so a compromised server cannot inject an assignment either.
  if (CREATOR_ONLY.includes(operation.type) && context.event.creator_user_id !== device.user_id) {
    await store(deps, context, 'REJECTED', 'not_permitted')
    return { operationId: operation.operationId, state: 'REJECTED', reason: 'not_permitted' }
  }

  if (!APPLIED_TYPES.includes(operation.type)) {
    // Kept for a future version rather than discarded: the log is append-only, and a reader that
    // learns the type later can still replay it.
    await store(deps, context, 'QUARANTINED', 'unknown_type')
    return { operationId: operation.operationId, state: 'QUARANTINED', reason: 'unknown_type' }
  }

  try {
    await applyOperation(deps, context, device.user_id)
  } catch (cause) {
    await store(deps, context, 'REJECTED', 'not_applicable')
    return { operationId: operation.operationId, state: 'REJECTED', reason: 'not_applicable' }
  }

  await store(deps, context, 'APPLIED', null)
  return { operationId: operation.operationId, state: 'APPLIED' }
}

async function applyOperation(
  deps: SyncDeps,
  context: {
    event: NonNullable<Awaited<ReturnType<typeof findEvent>>>
    operation: SignedOperation
    eventKey: Uint8Array
    touchedTickets: Set<string>
  },
  deviceUserId: string | null,
): Promise<void> {
  const { operation } = context
  const body = operation.body

  switch (operation.type) {
    case 'claim.request': {
      const ticketId = String(body.ticketId)
      await submitClaim(deps, {
        ticketId,
        userId: deviceUserId ?? '',
        deviceId: operation.deviceId,
        coupon: String(body.coupon ?? ''),
        lamport: operation.lamport,
        operationId: operation.operationId,
      })
      // Deferred: the batch is ordered against itself before anything is confirmed.
      context.touchedTickets.add(ticketId)
      return
    }
    case 'payment.set': {
      await setPayment(deps, {
        ticketId: String(body.ticketId),
        actorUserId: context.event.creator_user_id,
        state: body.state as 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED',
        ...(body.amountCents === undefined ? {} : { amountCents: Number(body.amountCents) }),
        ...(body.currency === undefined ? {} : { currency: String(body.currency) }),
        visibility: body.visibility as 'ALL' | 'HOLDER_ONLY' | 'CREATOR_ONLY',
      })
      return
    }
    case 'ticket.assign': {
      await deps.db.db
        .updateTable('tickets')
        .set({
          assignment_state: 'ASSIGNED',
          holder_user_id: body.holderUserId ? String(body.holderUserId) : null,
          holder_label_cipher: body.holderLabel
            ? Buffer.from(
                deps.crypto.encryptField(context.eventKey, String(body.holderLabel), {
                  table: 'tickets',
                  column: 'holder_label_cipher',
                  rowId: String(body.ticketId),
                }),
              )
            : null,
          assigned_at: toInstant(),
          updated_at: toInstant(),
        })
        .where('id', '=', String(body.ticketId))
        .where('event_id', '=', context.event.id)
        .execute()
      return
    }
    case 'ticket.unassign': {
      await deps.db.db
        .updateTable('tickets')
        .set({
          assignment_state: 'FREE',
          holder_user_id: null,
          holder_label_cipher: null,
          assigned_at: null,
          updated_at: toInstant(),
        })
        .where('id', '=', String(body.ticketId))
        .where('event_id', '=', context.event.id)
        .execute()
      return
    }
    case 'ticket.remove': {
      // A tombstone. It wins over any concurrent edit to the same ticket, and reviving one is a new
      // ticket rather than an undelete, so the history stays honest about what happened.
      await deps.db.db
        .updateTable('tickets')
        .set({ status: 'WITHDRAWN', updated_at: toInstant() })
        .where('id', '=', String(body.ticketId))
        .where('event_id', '=', context.event.id)
        .execute()
      return
    }
    case 'event.update': {
      const changes: Record<string, Buffer | string | null> = {}
      if (typeof body.name === 'string') {
        changes.name_cipher = Buffer.from(
          deps.crypto.encryptField(context.eventKey, body.name, {
            table: 'events',
            column: 'name_cipher',
            rowId: context.event.id,
          }),
        )
      }
      if (typeof body.venue === 'string') {
        changes.venue_cipher = Buffer.from(
          deps.crypto.encryptField(context.eventKey, body.venue, {
            table: 'events',
            column: 'venue_cipher',
            rowId: context.event.id,
          }),
        )
      }
      if (typeof body.startsAt === 'string') {
        changes.starts_at = body.startsAt
      }
      if (Object.keys(changes).length > 0) {
        await deps.db.db
          .updateTable('events')
          .set({ ...changes, updated_at: toInstant() })
          .where('id', '=', context.event.id)
          .execute()
      }
      return
    }
    default:
      throw new Error(`no handler for ${operation.type}`)
  }
}

async function store(
  deps: SyncDeps,
  context: {
    event: NonNullable<Awaited<ReturnType<typeof findEvent>>>
    operation: SignedOperation
    eventKey: Uint8Array
  },
  state: 'APPLIED' | 'QUARANTINED' | 'REJECTED',
  reason: string | null,
): Promise<void> {
  const { operation } = context
  await deps.db.db
    .insertInto('operations')
    .values({
      operation_id: operation.operationId,
      event_id: context.event.id,
      device_id: operation.deviceId,
      actor_user_id: operation.actorUserId ?? null,
      lamport: operation.lamport,
      device_id_hash: deviceHash(operation.deviceId),
      wall_clock: operation.wallClock,
      type: operation.type,
      // The body is encrypted at rest like everything else of value. The signature covers the
      // plaintext, so a puller gets the body back and can verify independently of this server.
      body_cipher: Buffer.from(
        deps.crypto.encryptField(context.eventKey, JSON.stringify(operation.body), {
          table: 'operations',
          column: 'body_cipher',
          rowId: operation.operationId,
        }),
      ),
      signature: operation.signature,
      state,
      quarantine_reason: reason,
      received_at: toInstant(),
      applied_at: state === 'APPLIED' ? toInstant() : null,
    })
    .execute()
}

/**
 * Records something this server did, as a signed operation.
 *
 * Called by the endpoints that change an event so the log is the record of what happened rather
 * than a channel other devices happen to push into. Before this, creating an event and adding
 * forty tickets through the API left the operations table empty, and a phone synchronising that
 * event received nothing — correctly, because nothing had been written down.
 *
 * Failures are swallowed deliberately and logged by the caller's error handling: a wallet change
 * that succeeded must not be reported as failed because its audit entry could not be written.
 * The alternative — rolling the change back — trades a missing log line for a lost ticket.
 */
/**
 * Puts the server's `device.register` into an event's log, once.
 *
 * Scoped per event because the log is per event: a device that appears in one event's history has
 * no business appearing in another's, and a peer syncing a single event has to be able to verify
 * everything in it from that event alone.
 */
async function announceServerDevice(
  deps: SyncDeps,
  device: ReturnType<typeof serverDeviceFrom>,
  eventId: string,
  eventKey: Uint8Array,
): Promise<void> {
  const existing = await deps.db.db
    .selectFrom('operations')
    .select('operation_id')
    .where('event_id', '=', eventId)
    .where('device_id', '=', device.deviceId)
    .where('type', '=', 'device.register')
    .executeTakeFirst()
  if (existing) {
    return
  }

  const registration = signAsServer(device, {
    operationId: newId(),
    deviceId: device.deviceId,
    actorUserId: null,
    lamport: await nextLamport(deps, eventId),
    wallClock: toInstant(),
    scope: { kind: 'event', id: eventId },
    type: 'device.register',
    body: {
      deviceId: device.deviceId,
      signingPublicKey: toBase64Url(device.signingPublicKey),
      agreementPublicKey: toBase64Url(device.signingPublicKey),
      name: 'PassVault server',
    },
  })

  await storeServerOperation(deps, registration, eventId, eventKey)
}

async function storeServerOperation(
  deps: SyncDeps,
  operation: SignedOperation,
  eventId: string,
  eventKey: Uint8Array,
): Promise<void> {
  await deps.db.db
    .insertInto('operations')
    .values({
      operation_id: operation.operationId,
      event_id: eventId,
      device_id: operation.deviceId,
      actor_user_id: operation.actorUserId ?? null,
      lamport: operation.lamport,
      device_id_hash: deviceHash(operation.deviceId),
      wall_clock: operation.wallClock,
      type: operation.type,
      body_cipher: Buffer.from(
        deps.crypto.encryptField(eventKey, JSON.stringify(operation.body), {
          table: 'operations',
          column: 'body_cipher',
          rowId: operation.operationId,
        }),
      ),
      signature: operation.signature,
      state: 'APPLIED',
      quarantine_reason: null,
      received_at: toInstant(),
      applied_at: toInstant(),
    })
    .execute()
}

export async function recordOperation(
  deps: SyncDeps,
  input: {
    eventId: string
    eventKey: Uint8Array
    actorUserId: string | null
    type: string
    body: Record<string, unknown>
  },
): Promise<SignedOperation | undefined> {
  const device = serverDeviceFrom(deps.crypto)
  await ensureServerDevice(deps.db, device, null)

  // The server announces itself in each event's log before it says anything else there.
  //
  // Without this the operations arrive at a phone signed by a device it has never heard of, and
  // its acceptance rules quarantine them as `unknown_device` — correctly, because an unverifiable
  // signature is not something to apply. The symptom is a sync that reports zero received while
  // the rows sit in quarantine, which is what a first end-to-end run actually produced.
  //
  // A registration carries the key that verifies it, so it is self-describing: a peer checks it
  // against the key it announces, remembers that key, and then re-examines everything it was
  // holding from that device.
  await announceServerDevice(deps, device, input.eventId, input.eventKey)

  const operation = signAsServer(device, {
    operationId: newId(),
    deviceId: device.deviceId,
    actorUserId: input.actorUserId,
    lamport: await nextLamport(deps, input.eventId),
    wallClock: toInstant(),
    scope: { kind: 'event', id: input.eventId },
    type: input.type,
    body: input.body,
  })

  await storeServerOperation(deps, operation, input.eventId, input.eventKey)

  return operation
}

export interface PullResult {
  operations: SignedOperation[]
  /** Opaque to the client. Pass it back to continue where this left off. */
  cursor: string
  hasMore: boolean
}

/**
 * Returns operations the caller has not seen.
 *
 * The cursor is arrival order, not logical order, and that distinction matters. Logical order —
 * `(lamport, device hash)` — is how a replay decides outcomes. But a cursor answers "what have I
 * already been given", and an operation with a low lamport can arrive late; ordering the cursor
 * logically would skip it forever.
 */
export async function pullOperations(
  deps: SyncDeps,
  input: {
    eventId: string
    actorUserId: string
    eventKey: Uint8Array
    cursor?: string
    limit?: number
  },
): Promise<PullResult> {
  if (!(await hasAccess(deps, input.eventId, input.actorUserId))) {
    throw forbidden()
  }
  const limit = Math.min(input.limit ?? 200, 500)
  const cursor = input.cursor ?? ''

  let query = deps.db.db
    .selectFrom('operations')
    .selectAll()
    .where('event_id', '=', input.eventId)
    .where('state', '=', 'APPLIED')
    .orderBy('received_at', 'asc')
    .orderBy('operation_id', 'asc')
    .limit(limit + 1)
  if (cursor) {
    // Fixed-width instants, so a string comparison is a chronological one.
    query = query.where('received_at', '>', cursor)
  }

  const rows = await query.execute()
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return {
    operations: page.map((row) => ({
      operationId: row.operation_id,
      deviceId: row.device_id,
      actorUserId: row.actor_user_id,
      lamport: row.lamport,
      wallClock: row.wall_clock,
      scope: { kind: 'event' as const, id: row.event_id },
      type: row.type,
      body: JSON.parse(
        deps.crypto.decryptField(input.eventKey, new Uint8Array(row.body_cipher), {
          table: 'operations',
          column: 'body_cipher',
          rowId: row.operation_id,
        }),
      ) as Record<string, unknown>,
      signature: row.signature,
    })),
    cursor: page.at(-1)?.received_at ?? cursor,
    hasMore,
  }
}

/**
 * The next logical clock value a device should use for this event.
 *
 * Offered so a device that has been offline does not have to guess and lose every race on
 * reconnection. It is a hint, not an authority: the device raises its own counter to at least this.
 */
export async function nextLamport(deps: SyncDeps, eventId: string): Promise<number> {
  const row = await deps.db.db
    .selectFrom('operations')
    .select((eb) => eb.fn.max('lamport').as('highest'))
    .where('event_id', '=', eventId)
    .executeTakeFirst()
  return Number(row?.highest ?? 0) + 1
}

export async function listQuarantined(deps: SyncDeps, eventId: string) {
  return deps.db.db
    .selectFrom('operations')
    .select(['operation_id', 'device_id', 'type', 'quarantine_reason', 'received_at'])
    .where('event_id', '=', eventId)
    .where('state', '=', 'QUARANTINED')
    .orderBy('received_at', 'asc')
    .execute()
}
