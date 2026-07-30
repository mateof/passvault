/**
 * Which relational engine an installation is pointed at, and the SQL differences
 * that cannot be abstracted away.
 *
 * Choosing the engine from a URL rather than at build time is the requirement that
 * ruled out an ORM which fixes the provider when it generates code. Everything here
 * is decided at boot from `DATABASE_URL`.
 */
export type Engine = 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'mssql' | 'oracle'

export const ENGINES: readonly Engine[] = [
  'sqlite',
  'postgres',
  'mysql',
  'mariadb',
  'mssql',
  'oracle',
]

export interface EngineTarget {
  engine: Engine
  /** The original URL, passed to the driver. */
  url: string
  /** For SQLite, the file path; `:memory:` for a throwaway database. */
  file?: string
}

const SCHEMES: Record<string, Engine> = {
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite',
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mssql: 'mssql',
  sqlserver: 'mssql',
  oracle: 'oracle',
}

export class UnsupportedEngineError extends Error {
  constructor(scheme: string) {
    super(
      `DATABASE_URL scheme '${scheme}' is not supported. Use one of: ${Object.keys(SCHEMES).join(', ')}.`,
    )
    this.name = 'UnsupportedEngineError'
  }
}

/**
 * Parses `DATABASE_URL`.
 *
 * SQLite is parsed by hand rather than with `new URL`, because `sqlite:./data/db.sqlite`
 * is a relative path and the URL parser mangles it into a host.
 */
export function parseDatabaseUrl(url: string): EngineTarget {
  const separator = url.indexOf(':')
  if (separator < 1) {
    throw new UnsupportedEngineError(url)
  }
  const scheme = url.slice(0, separator).toLowerCase()
  const engine = SCHEMES[scheme]
  if (!engine) {
    throw new UnsupportedEngineError(scheme)
  }
  if (engine === 'sqlite') {
    const rest = url.slice(separator + 1).replace(/^\/\//, '')
    return { engine, url, file: rest === '' ? ':memory:' : rest }
  }
  return { engine, url }
}

/**
 * Column types per engine.
 *
 * The three that actually differ are binary, text and the identifier type. Everything
 * else in the schema is `int` or `varchar(n)`, which every engine spells the same way.
 */
export function columnTypes(engine: Engine): {
  binary: string
  text: string
  varchar: (length: number) => string
} {
  switch (engine) {
    case 'sqlite':
      return { binary: 'blob', text: 'text', varchar: (n) => `varchar(${n})` }
    case 'postgres':
      return { binary: 'bytea', text: 'text', varchar: (n) => `varchar(${n})` }
    case 'mysql':
    case 'mariadb':
      // MySQL indexes a prefix of a TEXT column only, so anything indexed must be a
      // varchar. Nothing in this schema indexes a text column, but the distinction is
      // why they are separate types here.
      return { binary: 'longblob', text: 'text', varchar: (n) => `varchar(${n})` }
    case 'mssql':
      return { binary: 'varbinary(max)', text: 'nvarchar(max)', varchar: (n) => `nvarchar(${n})` }
    case 'oracle':
      // Oracle's VARCHAR is a deprecated synonym for VARCHAR2, and its CLOB cannot be
      // compared with = without a function, which is why no text column here is queried.
      return { binary: 'blob', text: 'clob', varchar: (n) => `varchar2(${n})` }
  }
}

/**
 * Whether the engine rejects a unique index containing more than one NULL.
 *
 * SQL Server does, which is why every nullable natural key in the schema has a
 * non-null mirror column. Kept as a predicate so the reason is discoverable from the
 * code rather than only from a comment in the DBML.
 */
export function treatsNullsAsEqualInUniqueIndex(engine: Engine): boolean {
  return engine === 'mssql'
}
