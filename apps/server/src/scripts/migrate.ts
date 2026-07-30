import { migrateToLatest, openDatabase } from '@passvault/db'
import { loadConfig } from '../config.js'

/**
 * Applies migrations without starting the server.
 *
 * The server migrates on boot as well, so this exists for the deployment that wants the schema
 * change to be a separate, reviewable step rather than something that happens during a restart.
 */
const config = loadConfig()
const handle = await openDatabase(config.databaseUrl)
try {
  const outcome = await migrateToLatest(handle)
  console.log(
    outcome.applied.length === 0
      ? `${outcome.engine}: already up to date`
      : `${outcome.engine}: applied ${outcome.applied.join(', ')}`,
  )
} finally {
  await handle.close()
}
