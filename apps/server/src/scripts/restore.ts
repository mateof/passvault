import { migrateToLatest, openDatabase, readBackupHeader, restoreFromFile } from '@passvault/db'
import { loadConfig } from '../config.js'

/**
 * Restores a logical backup into whatever DATABASE_URL currently names.
 *
 * The schema is migrated first, so restoring onto an empty database of a different engine works
 * without any manual preparation.
 */
const source = process.argv[2]
if (!source) {
  console.error('usage: npm run db:restore -- <backup.ndjson.gz>')
  process.exit(1)
}

const config = loadConfig()
const header = await readBackupHeader(source)
const handle = await openDatabase(config.databaseUrl)
try {
  await migrateToLatest(handle)
  const summary = await restoreFromFile(handle, source)
  console.log(
    `restored ${summary.rows} rows from a ${header.engine} backup taken ${header.generatedAt} ` +
      `into ${handle.engine}`,
  )
  if (header.engine !== handle.engine) {
    console.log(
      'Engines differ, which is a supported migration. Check that MASTER_KEY matches the one ' +
        'the backup was taken with, or the restored data will not decrypt.',
    )
  }
} finally {
  await handle.close()
}
