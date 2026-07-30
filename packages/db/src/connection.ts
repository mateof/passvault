import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Kysely, Migrator, type Dialect } from 'kysely'
import { parseDatabaseUrl, type Engine, type EngineTarget } from './engine.js'
import { migrationProvider } from './migrations.js'
import type { Database } from './schema.js'

export interface DatabaseHandle {
  db: Kysely<Database>
  engine: Engine
  target: EngineTarget
  close: () => Promise<void>
}

/**
 * Opens a connection to whatever engine `DATABASE_URL` names.
 *
 * Drivers are imported dynamically so a default SQLite installation never loads the
 * PostgreSQL, MySQL or SQL Server clients. That keeps startup quick and means a driver
 * an installation will never use is never loaded.
 */
export async function openDatabase(url: string): Promise<DatabaseHandle> {
  const target = parseDatabaseUrl(url)
  const dialect = await createDialect(target)
  const db = new Kysely<Database>({ dialect })
  return {
    db,
    engine: target.engine,
    target,
    close: () => db.destroy(),
  }
}

async function createDialect(target: EngineTarget): Promise<Dialect> {
  switch (target.engine) {
    case 'sqlite':
      return sqliteDialect(target)
    case 'postgres':
      return postgresDialect(target)
    case 'mysql':
    case 'mariadb':
      return mysqlDialect(target)
    case 'mssql':
      return mssqlDialect(target)
  }
}

async function sqliteDialect(target: EngineTarget): Promise<Dialect> {
  const [{ SqliteDialect }, { default: SqliteDatabase }] = await Promise.all([
    import('kysely'),
    import('better-sqlite3'),
  ])
  const file = target.file ?? ':memory:'
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true })
  }
  const database = new SqliteDatabase(file)
  // Write-ahead logging so a reader is not blocked by a writer, and foreign keys on,
  // which SQLite disables by default — the one setting whose absence silently lets
  // orphaned rows accumulate.
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  return new SqliteDialect({ database })
}

async function postgresDialect(target: EngineTarget): Promise<Dialect> {
  const [{ PostgresDialect }, pg] = await Promise.all([import('kysely'), import('pg')])
  return new PostgresDialect({ pool: new pg.default.Pool({ connectionString: target.url }) })
}

async function mysqlDialect(target: EngineTarget): Promise<Dialect> {
  const [{ MysqlDialect }, mysql] = await Promise.all([import('kysely'), import('mysql2')])
  return new MysqlDialect({
    pool: mysql.createPool({
      uri: target.url,
      // Without this, mysql2 returns DECIMAL and BIGINT as strings in some versions and
      // numbers in others. Nothing in the schema uses them, and the setting documents
      // that dependence rather than leaving it to chance.
      supportBigNumbers: true,
      decimalNumbers: false,
    }),
  })
}

async function mssqlDialect(target: EngineTarget): Promise<Dialect> {
  const [{ MssqlDialect }, tarn, tedious] = await Promise.all([
    import('kysely'),
    import('tarn'),
    import('tedious'),
  ])
  const parsed = new URL(target.url)
  return new MssqlDialect({
    tarn: { ...tarn, options: { min: 0, max: 10 } },
    tedious: {
      ...tedious,
      connectionFactory: () =>
        new tedious.Connection({
          server: parsed.hostname,
          options: {
            port: parsed.port ? Number(parsed.port) : 1433,
            database: parsed.pathname.replace(/^\//, ''),
            trustServerCertificate: parsed.searchParams.get('trustServerCertificate') !== 'false',
            encrypt: parsed.searchParams.get('encrypt') !== 'false',
          },
          authentication: {
            type: 'default',
            options: {
              userName: decodeURIComponent(parsed.username),
              password: decodeURIComponent(parsed.password),
            },
          },
        }),
    },
  })
}

export interface MigrationOutcome {
  applied: string[]
  engine: Engine
}

/**
 * Brings the schema up to date.
 *
 * Run at boot, not as a separate deployment step: the product's default is a
 * single-file SQLite database that someone put on a NAS, and asking that person to run
 * a migration command before the application will start is how installations end up
 * broken after an update.
 */
export async function migrateToLatest(handle: DatabaseHandle): Promise<MigrationOutcome> {
  const migrator = new Migrator({
    db: handle.db,
    provider: migrationProvider(handle.engine),
  })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
  return {
    engine: handle.engine,
    applied: (results ?? [])
      .filter((result) => result.status === 'Success')
      .map((result) => result.migrationName),
  }
}
