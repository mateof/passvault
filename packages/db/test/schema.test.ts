import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TABLES_IN_DEPENDENCY_ORDER,
  migrateToLatest,
  newId,
  openDatabase,
  toInstant,
  type DatabaseHandle,
} from '@passvault/db'

/**
 * The schema, exercised on SQLite in memory.
 *
 * SQLite is the default engine and the only one available without Docker, so this is
 * where the schema's behaviour is pinned. `cross-engine.test.ts` runs the same
 * migrations against PostgreSQL, MySQL, MariaDB and SQL Server when a Docker daemon is
 * reachable, and says out loud when it is not.
 */
let handle: DatabaseHandle

beforeEach(async () => {
  handle = await openDatabase('sqlite::memory:')
  const outcome = await migrateToLatest(handle)
  expect(outcome.applied).toEqual(['0001_initial_schema'])
})

afterEach(async () => {
  await handle.close()
})

const now = toInstant()

async function aUser(): Promise<string> {
  const id = newId()
  await handle.db
    .insertInto('users')
    .values({
      id,
      email_cipher: Buffer.from('encrypted-address'),
      email_key: `blind-index-${id}`,
      display_name_cipher: null,
      password_hash: null,
      status: 'ACTIVE',
      locale: 'gl',
      is_admin: 0,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return id
}

async function anEvent(creator: string): Promise<string> {
  const id = newId()
  await handle.db
    .insertInto('events')
    .values({
      id,
      creator_user_id: creator,
      name_cipher: Buffer.from('encrypted-name'),
      venue_cipher: null,
      notes_cipher: null,
      starts_at: '2026-08-14T19:00:00.000Z',
      time_zone: 'Europe/Madrid',
      default_assignment_mode: 'ASSIGNED',
      password_protected: 1,
      sealed_key_envelope: Buffer.from('sealed'),
      authority_device_id: null,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    })
    .execute()
  return id
}

async function aTicket(eventId: string): Promise<string> {
  const id = newId()
  await handle.db
    .insertInto('tickets')
    .values({
      id,
      event_id: eventId,
      label_cipher: Buffer.from('encrypted-label'),
      section_cipher: null,
      row_cipher: null,
      seat_cipher: null,
      barcode_format: 'QR_CODE',
      barcode_cipher: Buffer.from('encrypted-barcode'),
      document_blob_id: null,
      document_page: null,
      assignment_mode: 'ASSIGNED',
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
  return id
}

describe('migrating a fresh database', () => {
  it('creates every table the schema declares', async () => {
    const tables = await handle.db.introspection.getTables()

    const names = tables.map((table) => table.name)
    for (const expected of TABLES_IN_DEPENDENCY_ORDER) {
      expect(names).toContain(expected)
    }
  })

  it('is idempotent, so a restart does not reapply anything', async () => {
    const second = await migrateToLatest(handle)

    expect(second.applied).toEqual([])
  })
})

describe('encrypted columns', () => {
  it('returns the exact bytes that were written', async () => {
    const ciphertext = Buffer.from([0x00, 0xff, 0x10, 0x80])
    const id = newId()
    await handle.db
      .insertInto('users')
      .values({
        id,
        email_cipher: ciphertext,
        email_key: `blind-${id}`,
        display_name_cipher: null,
        password_hash: null,
        status: 'ACTIVE',
        locale: 'gl',
        is_admin: 0,
        created_at: now,
        updated_at: now,
      })
      .execute()

    const stored = await handle.db
      .selectFrom('users')
      .select('email_cipher')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

    expect(Buffer.from(stored.email_cipher).equals(ciphertext)).toBe(true)
  })
})

describe('the email blind index', () => {
  it('rejects a second account with the same index, which is how duplicates are prevented', async () => {
    const first = await aUser()
    const shared = await handle.db
      .selectFrom('users')
      .select('email_key')
      .where('id', '=', first)
      .executeTakeFirstOrThrow()

    const duplicate = handle.db
      .insertInto('users')
      .values({
        id: newId(),
        email_cipher: Buffer.from('encrypted-address'),
        email_key: shared.email_key,
        display_name_cipher: null,
        password_hash: null,
        status: 'ACTIVE',
        locale: 'gl',
        is_admin: 0,
        created_at: now,
        updated_at: now,
      })
      .execute()

    await expect(duplicate).rejects.toThrow(/UNIQUE|constraint/i)
  })
})

describe('payment records', () => {
  it('accepts an amount together with a currency', async () => {
    const creator = await aUser()
    const ticket = await aTicket(await anEvent(creator))

    const insert = handle.db
      .insertInto('payments')
      .values({
        id: newId(),
        ticket_id: ticket,
        state: 'PAID',
        amount_cents: 4500,
        currency: 'EUR',
        visibility: 'ALL',
        settled_at: now,
        recorded_by: creator,
        updated_at: now,
      })
      .execute()

    await expect(insert).resolves.toBeDefined()
  })

  it('accepts a record with neither amount nor currency', async () => {
    const creator = await aUser()
    const ticket = await aTicket(await anEvent(creator))

    const insert = handle.db
      .insertInto('payments')
      .values({
        id: newId(),
        ticket_id: ticket,
        state: 'UNPAID',
        amount_cents: null,
        currency: null,
        visibility: 'CREATOR_ONLY',
        settled_at: null,
        recorded_by: creator,
        updated_at: now,
      })
      .execute()

    await expect(insert).resolves.toBeDefined()
  })

  it('rejects an amount without a currency, because that is not a sum of money', async () => {
    const creator = await aUser()
    const ticket = await aTicket(await anEvent(creator))

    const insert = handle.db
      .insertInto('payments')
      .values({
        id: newId(),
        ticket_id: ticket,
        state: 'PAID',
        amount_cents: 4500,
        currency: null,
        visibility: 'ALL',
        settled_at: now,
        recorded_by: creator,
        updated_at: now,
      })
      .execute()

    await expect(insert).rejects.toThrow(/constraint/i)
  })

  it('defaults visibility to the most private option', async () => {
    const creator = await aUser()
    const ticket = await aTicket(await anEvent(creator))
    const id = newId()
    await handle.db
      .insertInto('payments')
      .values({ id, ticket_id: ticket, state: 'UNPAID', recorded_by: creator, updated_at: now })
      .execute()

    const stored = await handle.db
      .selectFrom('payments')
      .select('visibility')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

    expect(stored.visibility).toBe('CREATOR_ONLY')
  })

  it('allows at most one record per ticket', async () => {
    const creator = await aUser()
    const ticket = await aTicket(await anEvent(creator))
    await handle.db
      .insertInto('payments')
      .values({
        id: newId(),
        ticket_id: ticket,
        state: 'UNPAID',
        recorded_by: creator,
        updated_at: now,
      })
      .execute()

    const second = handle.db
      .insertInto('payments')
      .values({
        id: newId(),
        ticket_id: ticket,
        state: 'PAID',
        recorded_by: creator,
        updated_at: now,
      })
      .execute()

    await expect(second).rejects.toThrow(/UNIQUE|constraint/i)
  })
})

describe('enumerated columns', () => {
  it('rejects an assignment state the domain does not define', async () => {
    const creator = await aUser()
    const eventId = await anEvent(creator)

    const insert = handle.db
      .insertInto('tickets')
      .values({
        id: newId(),
        event_id: eventId,
        assignment_mode: 'ASSIGNED',
        assignment_state: 'SOLD' as never,
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .execute()

    await expect(insert).rejects.toThrow(/constraint/i)
  })

  it('rejects a registration mode outside the four the product defines', async () => {
    const insert = handle.db
      .insertInto('registration_settings')
      .values({
        id: 1,
        mode: 'ANYONE' as never,
        allow_password_login: 1,
        require_second_factor: 0,
        updated_at: now,
        updated_by: null,
      })
      .execute()

    await expect(insert).rejects.toThrow(/constraint/i)
  })
})

describe('foreign keys', () => {
  it('refuses a ticket pointing at an event that does not exist', async () => {
    const insert = handle.db
      .insertInto('tickets')
      .values({
        id: newId(),
        event_id: newId(),
        assignment_mode: 'OPEN',
        assignment_state: 'FREE',
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .execute()

    // Requires PRAGMA foreign_keys = ON, which SQLite leaves off by default; without it
    // orphaned rows accumulate silently.
    await expect(insert).rejects.toThrow(/FOREIGN KEY|constraint/i)
  })

  it('refuses to delete an event while tickets reference it, since nothing cascades', async () => {
    const creator = await aUser()
    const eventId = await anEvent(creator)
    await aTicket(eventId)

    const remove = handle.db.deleteFrom('events').where('id', '=', eventId).execute()

    await expect(remove).rejects.toThrow(/FOREIGN KEY|constraint/i)
  })
})

describe('the claim reconciliation index', () => {
  it('orders requests by logical clock then device hash, never by wall clock', async () => {
    const creator = await aUser()
    const ticket = await aTicket(await anEvent(creator))
    const deviceA = newId()
    const deviceB = newId()
    for (const device of [deviceA, deviceB]) {
      await handle.db
        .insertInto('devices')
        .values({
          id: device,
          user_id: creator,
          name: device === deviceA ? "Ana's phone" : "Brais's phone",
          signing_public_key: `sign-${device}`,
          agreement_public_key: `agree-${device}`,
          status: 'ACTIVE',
          created_at: now,
          last_seen_at: null,
        })
        .execute()
    }
    // The later wall clock deliberately belongs to the lower logical clock, which is the
    // case a clock-based ordering would get wrong.
    await handle.db
      .insertInto('claim_requests')
      .values([
        {
          id: newId(),
          operation_id: newId(),
          ticket_id: ticket,
          device_id: deviceA,
          user_id: creator,
          lamport: 7,
          device_id_hash: 'aaa',
          state: 'PENDING',
          reason: null,
          created_at: '2026-07-30T12:00:00.000Z',
          resolved_at: null,
        },
        {
          id: newId(),
          operation_id: newId(),
          ticket_id: ticket,
          device_id: deviceB,
          user_id: creator,
          lamport: 3,
          device_id_hash: 'bbb',
          state: 'PENDING',
          reason: null,
          created_at: '2026-07-30T18:00:00.000Z',
          resolved_at: null,
        },
      ])
      .execute()

    const ordered = await handle.db
      .selectFrom('claim_requests')
      .select(['lamport', 'device_id_hash'])
      .where('ticket_id', '=', ticket)
      .orderBy('lamport')
      .orderBy('device_id_hash')
      .execute()

    expect(ordered.map((request) => request.lamport)).toEqual([3, 7])
  })
})
