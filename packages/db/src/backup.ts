import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import type { DatabaseHandle } from './connection.js'
import { TABLES_IN_DEPENDENCY_ORDER, type Database } from './schema.js'

/**
 * Logical backup as gzipped NDJSON.
 *
 * Native dumps are faster and smaller, and there are six of them with six restore
 * procedures. One neutral format means the same file restores onto any supported
 * engine, which is also how migrating from SQLite to PostgreSQL is done: back up,
 * repoint `DATABASE_URL`, restore. No separate migration tool to maintain.
 *
 * The file is a header line followed by one line per row. Line-oriented so a restore
 * streams instead of loading everything, and so a truncated file is detectable rather
 * than silently half-parsed.
 */
export const BACKUP_FORMAT = 'passvault-backup'
export const BACKUP_VERSION = 1

export interface BackupHeader {
  format: typeof BACKUP_FORMAT
  version: number
  engine: string
  generatedAt: string
  tables: string[]
}

interface EncodedBytes {
  $bytes: string
}

export interface BackupSummary {
  path: string
  rows: number
  perTable: Record<string, number>
}

/**
 * Binary columns become `{"$bytes": "..."}`.
 *
 * A tagged object rather than a bare base64 string, because a text column can legally
 * contain base64 and a restore must not turn one into bytes.
 */
function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { $bytes: Buffer.from(value).toString('base64') } satisfies EncodedBytes
  }
  return value
}

function decodeValue(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    '$bytes' in value &&
    typeof (value as EncodedBytes).$bytes === 'string'
  ) {
    return Buffer.from((value as EncodedBytes).$bytes, 'base64')
  }
  return value
}

function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)]))
}

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decodeValue(value)]))
}

export async function backupToFile(handle: DatabaseHandle, path: string): Promise<BackupSummary> {
  await mkdir(dirname(path), { recursive: true })
  const gzip = createGzip()
  const written = pipeline(gzip, createWriteStream(path))

  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    engine: handle.engine,
    generatedAt: new Date().toISOString(),
    tables: [...TABLES_IN_DEPENDENCY_ORDER],
  }
  gzip.write(`${JSON.stringify(header)}\n`)

  const perTable: Record<string, number> = {}
  let rows = 0
  for (const table of TABLES_IN_DEPENDENCY_ORDER) {
    const records = await handle.db.selectFrom(table).selectAll().execute()
    perTable[table] = records.length
    for (const record of records) {
      gzip.write(
        `${JSON.stringify({ table, row: encodeRow(record as Record<string, unknown>) })}\n`,
      )
      rows += 1
    }
  }

  gzip.end()
  await written
  return { path, rows, perTable }
}

interface LineReader {
  next: () => Promise<string | undefined>
  close: () => void
}

/**
 * A line reader that fails instead of hanging.
 *
 * `readline` over a piped stream does not surface the stream's `error` event through its
 * async iterator, so a missing file or a truncated gzip leaves `for await` waiting
 * forever while the error escapes as an unhandled exception. Racing each read against
 * the stream errors turns both into a rejection the caller can report.
 */
function openLines(path: string): LineReader {
  const file = createReadStream(path)
  const gunzip = createGunzip()
  const failed = new Promise<never>((_resolve, reject) => {
    file.on('error', reject)
    gunzip.on('error', reject)
  })
  // Nothing else awaits this promise, and an unobserved rejection would take the process
  // down; the race below observes it while reading, and this keeps it observed after.
  failed.catch(() => undefined)
  const lines = createInterface({ input: file.pipe(gunzip), crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  return {
    next: async () => {
      const result = await Promise.race([iterator.next(), failed])
      return result.done ? undefined : result.value
    },
    close: () => {
      lines.close()
      gunzip.destroy()
      file.destroy()
    },
  }
}

function parseHeader(path: string, line: string): BackupHeader {
  let header: BackupHeader
  try {
    header = JSON.parse(line) as BackupHeader
  } catch {
    throw new Error(`${path} does not start with a backup header`)
  }
  if (header.format !== BACKUP_FORMAT) {
    throw new Error(`${path} is not a PassVault backup`)
  }
  if (header.version > BACKUP_VERSION) {
    throw new Error(
      `${path} is backup version ${header.version}; this build reads up to ${BACKUP_VERSION}`,
    )
  }
  return header
}

/**
 * Reads only the header.
 *
 * Separate from the restore on purpose. `readline.createInterface` starts consuming its
 * stream the moment it is created, so validating the header on one interface and then
 * doing any asynchronous work before iterating loses lines. The restore therefore
 * validates with this function, which owns and closes its own stream, and opens a fresh
 * stream immediately before consuming it.
 */
export async function readBackupHeader(path: string): Promise<BackupHeader> {
  const reader = openLines(path)
  try {
    const line = await reader.next()
    if (line === undefined) {
      throw new Error(`${path} is empty`)
    }
    return parseHeader(path, line)
  } finally {
    reader.close()
  }
}

export interface RestoreSummary {
  header: BackupHeader
  rows: number
  perTable: Record<string, number>
}

export interface RestoreOptions {
  /** Rows inserted per statement. Kept modest so SQL Server's parameter limit is not hit. */
  batchSize?: number
}

export async function restoreFromFile(
  handle: DatabaseHandle,
  path: string,
  options: RestoreOptions = {},
): Promise<RestoreSummary> {
  const header = await readBackupHeader(path)
  const batchSize = options.batchSize ?? 100

  // A fresh reader, opened immediately before it is consumed. The header was validated
  // on a reader that has already been closed.
  const reader = openLines(path)

  const pending = new Map<string, Record<string, unknown>[]>()
  const perTable: Record<string, number> = {}
  let rows = 0
  let seenHeader = false

  const flush = async (table: string): Promise<void> => {
    const batch = pending.get(table)
    if (!batch || batch.length === 0) {
      return
    }
    await handle.db
      .insertInto(table as keyof Database)
      .values(batch as never)
      .execute()
    pending.set(table, [])
  }

  try {
    for (;;) {
      const line = await reader.next()
      if (line === undefined) {
        break
      }
      if (!seenHeader) {
        seenHeader = true
        continue
      }
      if (line.trim() === '') {
        continue
      }
      const { table, row } = JSON.parse(line) as {
        table: string
        row: Record<string, unknown>
      }
      if (!TABLES_IN_DEPENDENCY_ORDER.includes(table as never)) {
        throw new Error(`backup references unknown table '${table}'`)
      }
      const batch = pending.get(table) ?? []
      batch.push(decodeRow(row))
      pending.set(table, batch)
      perTable[table] = (perTable[table] ?? 0) + 1
      rows += 1
      if (batch.length >= batchSize) {
        await flush(table)
      }
    }
  } finally {
    reader.close()
  }

  // Flush in dependency order, so a child table's rows are never inserted before the
  // parent rows they reference. The backup is written in that order too, but a partial
  // batch can still be outstanding for an earlier table when the file ends.
  for (const table of TABLES_IN_DEPENDENCY_ORDER) {
    await flush(table)
  }

  return { header, rows, perTable }
}
