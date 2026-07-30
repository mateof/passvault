import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backupToFile,
  migrateToLatest,
  newId,
  openDatabase,
  readBackupHeader,
  restoreFromFile,
  toInstant,
  type DatabaseHandle,
} from '@passvault/db'

/**
 * Logical backup and restore.
 *
 * This is also how an installation moves between engines: back up, repoint
 * `DATABASE_URL`, restore. So the important property is not that the file is small but
 * that everything survives the round trip exactly — particularly the encrypted columns,
 * where a single altered byte makes the data permanently unreadable rather than merely
 * wrong.
 */
let handle: DatabaseHandle
let directory: string

const now = toInstant()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passvault-backup-'))
  handle = await openDatabase('sqlite::memory:')
  const migrated = await migrateToLatest(handle)
  expect(migrated.applied).toHaveLength(1)
})

afterEach(async () => {
  await handle.close()
  await rm(directory, { recursive: true, force: true })
})

async function seedUser(ciphertext: Buffer): Promise<string> {
  const id = newId()
  await handle.db
    .insertInto('users')
    .values({
      id,
      email_cipher: ciphertext,
      email_key: `blind-${id}`,
      display_name_cipher: null,
      password_hash: '$argon2id$v=19$m=8192,t=1,p=1$c2FsdA$aGFzaA',
      status: 'ACTIVE',
      locale: 'gl',
      is_admin: 1,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return id
}

async function freshTarget(): Promise<DatabaseHandle> {
  const target = await openDatabase('sqlite::memory:')
  await migrateToLatest(target)
  return target
}

describe('writing a backup', () => {
  it('reports how many rows it wrote', async () => {
    await seedUser(Buffer.from('encrypted'))

    const summary = await backupToFile(handle, join(directory, 'backup.ndjson.gz'))

    expect(summary.rows).toBe(1)
  })

  it('records which engine produced it', async () => {
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)

    expect((await readBackupHeader(path)).engine).toBe('sqlite')
  })

  it('rejects a path that does not exist, rather than waiting forever', async () => {
    await expect(readBackupHeader(join(directory, 'missing.gz'))).rejects.toThrow(/ENOENT/)
  })

  it('rejects a file that is not gzip', async () => {
    const path = join(directory, 'not-gzip.gz')
    await writeFile(path, 'plain text pretending to be a backup')

    await expect(readBackupHeader(path)).rejects.toThrow()
  })

  it('rejects a gzip file that is not a PassVault backup', async () => {
    const path = join(directory, 'other.gz')
    await writeFile(path, gzipSync(Buffer.from('{"format":"something-else"}\n')))

    await expect(readBackupHeader(path)).rejects.toThrow(/not a PassVault backup/)
  })
})

describe('restoring a backup', () => {
  it('restores every row', async () => {
    await seedUser(Buffer.from('encrypted'))
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)
    const target = await freshTarget()

    const summary = await restoreFromFile(target, path)

    expect(summary.rows).toBe(1)
    await target.close()
  })

  it('restores encrypted columns byte for byte', async () => {
    const ciphertext = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d])
    const userId = await seedUser(ciphertext)
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)
    const target = await freshTarget()
    await restoreFromFile(target, path)

    const restored = await target.db
      .selectFrom('users')
      .select('email_cipher')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()

    expect(Buffer.from(restored.email_cipher).equals(ciphertext)).toBe(true)
    await target.close()
  })

  it('does not turn a text column that looks like base64 into bytes', async () => {
    // The stored Argon2id hash is full of base64. A backup format that guessed at
    // encoding by shape would corrupt exactly this column.
    const userId = await seedUser(Buffer.from('encrypted'))
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)
    const target = await freshTarget()
    await restoreFromFile(target, path)

    const restored = await target.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()

    expect(restored.password_hash).toBe('$argon2id$v=19$m=8192,t=1,p=1$c2FsdA$aGFzaA')
    await target.close()
  })

  it('preserves integer flags rather than restoring them as booleans', async () => {
    const userId = await seedUser(Buffer.from('encrypted'))
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)
    const target = await freshTarget()
    await restoreFromFile(target, path)

    const restored = await target.db
      .selectFrom('users')
      .select('is_admin')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()

    expect(restored.is_admin).toBe(1)
    await target.close()
  })

  it('restores parents before children, so foreign keys hold throughout', async () => {
    const creator = await seedUser(Buffer.from('encrypted'))
    const eventId = newId()
    await handle.db
      .insertInto('events')
      .values({
        id: eventId,
        creator_user_id: creator,
        name_cipher: Buffer.from('encrypted-name'),
        default_assignment_mode: 'SELF_CLAIM',
        password_protected: 0,
        sealed_key_envelope: Buffer.from('sealed'),
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .execute()
    await handle.db
      .insertInto('tickets')
      .values({
        id: newId(),
        event_id: eventId,
        assignment_mode: 'SELF_CLAIM',
        assignment_state: 'FREE',
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .execute()
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)
    const target = await freshTarget()

    const summary = await restoreFromFile(target, path)

    expect(summary.perTable.tickets).toBe(1)
    await target.close()
  })

  it('carries the header of the backup it read', async () => {
    const path = join(directory, 'backup.ndjson.gz')
    await backupToFile(handle, path)
    const target = await freshTarget()

    const summary = await restoreFromFile(target, path)

    expect(summary.header.format).toBe('passvault-backup')
    await target.close()
  })
})
