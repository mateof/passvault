import { join } from 'node:path'
import { backupToFile, openDatabase } from '@passvault/db'
import { loadConfig } from '../config.js'

/**
 * Writes a logical backup.
 *
 * The file restores onto any supported engine, which is also how an installation changes
 * database: back up, repoint DATABASE_URL, restore. See docs/database.md.
 *
 * Note what this does not include: the master key. A backup of the database alone cannot be
 * decrypted, which is the point — and also means a restore needs the key from somewhere else.
 */
const config = loadConfig()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = process.argv[2] ?? join(config.backupDir, `passvault-${stamp}.ndjson.gz`)

const handle = await openDatabase(config.databaseUrl)
try {
  const summary = await backupToFile(handle, target)
  console.log(`wrote ${summary.rows} rows to ${summary.path}`)
  console.log(
    'This file holds ciphertext only. Without MASTER_KEY it cannot be read, so back that up ' +
      'separately and somewhere else.',
  )
} finally {
  await handle.close()
}
