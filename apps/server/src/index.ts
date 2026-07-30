import { buildServer, listen } from './app.js'

/**
 * Entry point.
 *
 * Migrations run inside `buildServer`, not as a separate deployment step. The default
 * installation is somebody putting this on a NAS, and asking that person to run a migration
 * command before the application will start is how installations end up broken after an update.
 */
const server = await buildServer({ logger: true })

const shutdown = async (signal: string): Promise<void> => {
  server.app.log.info(`${signal} received, shutting down`)
  await server.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

const address = await listen(server)
server.app.log.info(
  `PassVault listening on ${address}, database ${server.db.engine}, data in ${server.config.dataDir}`,
)
