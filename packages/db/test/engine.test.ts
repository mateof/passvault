import { describe, expect, it } from 'vitest'
import {
  ENGINES,
  UnsupportedEngineError,
  columnTypes,
  parseDatabaseUrl,
  treatsNullsAsEqualInUniqueIndex,
} from '@passvault/db'

describe('choosing an engine from DATABASE_URL', () => {
  it('defaults an installation to SQLite', () => {
    expect(parseDatabaseUrl('sqlite:./data/passvault.db').engine).toBe('sqlite')
  })

  it('keeps a relative SQLite path intact, which the URL parser would turn into a host', () => {
    expect(parseDatabaseUrl('sqlite:./data/passvault.db').file).toBe('./data/passvault.db')
  })

  it('treats an empty SQLite path as an in-memory database', () => {
    expect(parseDatabaseUrl('sqlite::memory:').file).toBe(':memory:')
  })

  it('recognises PostgreSQL', () => {
    expect(parseDatabaseUrl('postgres://user:pass@host:5432/passvault').engine).toBe('postgres')
  })

  it('recognises the postgresql spelling too', () => {
    expect(parseDatabaseUrl('postgresql://user:pass@host:5432/passvault').engine).toBe('postgres')
  })

  it('distinguishes MariaDB from MySQL, because their DDL diverges', () => {
    expect(parseDatabaseUrl('mariadb://user:pass@host:3306/passvault').engine).toBe('mariadb')
  })

  it('recognises SQL Server under both schemes', () => {
    expect(parseDatabaseUrl('sqlserver://user:pass@host:1433/passvault').engine).toBe('mssql')
  })

  it('rejects an unknown scheme instead of guessing', () => {
    expect(() => parseDatabaseUrl('mongodb://host/passvault')).toThrow(UnsupportedEngineError)
  })

  it('names the supported schemes in the error, so the fix is obvious', () => {
    expect(() => parseDatabaseUrl('mongodb://host/passvault')).toThrow(/sqlite/)
  })
})

describe('column types per engine', () => {
  it('has a binary type for every supported engine', () => {
    for (const engine of ENGINES) {
      expect(columnTypes(engine).binary).toBeTruthy()
    }
  })

  it('uses bytea on PostgreSQL', () => {
    expect(columnTypes('postgres').binary).toBe('bytea')
  })

  it('uses varbinary(max) on SQL Server', () => {
    expect(columnTypes('mssql').binary).toBe('varbinary(max)')
  })

  it('uses nvarchar on SQL Server so non-ASCII text survives', () => {
    expect(columnTypes('mssql').varchar(36)).toBe('nvarchar(36)')
  })
})

describe('unique indexes over nullable columns', () => {
  it('flags SQL Server, which is why nullable natural keys have non-null mirror columns', () => {
    expect(treatsNullsAsEqualInUniqueIndex('mssql')).toBe(true)
  })

  it('does not flag the engines that permit many NULLs in a unique index', () => {
    expect(treatsNullsAsEqualInUniqueIndex('postgres')).toBe(false)
  })
})
