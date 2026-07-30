import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { KEY_BYTES, fromBase64Url, randomKey, toBase64Url } from '@passvault/crypto'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@passvault/i18n'

export interface ServerConfig {
  host: string
  port: number
  databaseUrl: string
  dataDir: string
  blobDir: string
  backupDir: string
  publicUrl: string
  defaultLocale: Locale
  masterKey: Uint8Array
  blindIndexKey: Uint8Array
  session: { idleMinutes: number; hardHours: number }
  otp: { length: number; ttlMinutes: number; maxAttempts: number }
  webAuthn: { relyingPartyId: string; relyingPartyName: string; origin: string }
  oidc: {
    google?: { clientId: string; clientSecret: string }
    microsoft?: { clientId: string; clientSecret: string; tenant: string }
  }
  mail: { from: string; smtpUrl?: string }
  /** True when secrets were generated on this boot, so the caller can say so loudly. */
  generatedSecrets: string[]
}

const SECRETS_FILE = 'secrets.json'

interface StoredSecrets {
  masterKey: string
  blindIndexKey: string
  createdAt: string
  note: string
}

/**
 * Reads configuration, generating what is missing.
 *
 * `npm run dev` with no `.env` has to work, because the default installation is somebody
 * putting this on a NAS. That requires generating a master key on first boot and keeping
 * it somewhere.
 *
 * The honest cost, which is documented rather than glossed over: a generated key is
 * written to `<dataDir>/secrets.json`, next to the database. Anybody who takes the data
 * directory takes both, so the "a stolen database alone yields nothing" property in
 * docs/threat-model.md does not hold for a zero-configuration installation. It holds as
 * soon as `MASTER_KEY` comes from the environment and the file is deleted, which is what
 * the startup log tells the operator to do and what docs/deployment.md documents.
 *
 * The alternative — refusing to start without a key — was rejected: it moves the failure
 * to first run, where a self-hosting user is least equipped to deal with it, and the usual
 * outcome is a key pasted from a tutorial that everyone else is also using.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.DATA_DIR ?? './data')
  mkdirSync(dataDir, { recursive: true })

  const generatedSecrets: string[] = []
  const masterKey = keyFrom(env.MASTER_KEY, 'MASTER_KEY')
  const blindIndexKey = keyFrom(env.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY')
  const resolved = resolveSecrets({ dataDir, masterKey, blindIndexKey, generatedSecrets })

  const port = Number(env.PORT ?? 8080)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT '${String(env.PORT)}' is not a usable port number`)
  }

  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '')
  const locale = env.DEFAULT_LOCALE
  if (locale !== undefined && !isLocale(locale)) {
    throw new Error(`DEFAULT_LOCALE '${locale}' is not one of gl, es, en`)
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    databaseUrl: env.DATABASE_URL ?? `sqlite:${join(dataDir, 'passvault.db')}`,
    dataDir,
    blobDir: env.BLOB_DIR ?? join(dataDir, 'blobs'),
    backupDir: env.BACKUP_DIR ?? resolve(env.BACKUP_DIR ?? './backups'),
    publicUrl,
    defaultLocale: locale ?? DEFAULT_LOCALE,
    masterKey: resolved.masterKey,
    blindIndexKey: resolved.blindIndexKey,
    session: {
      idleMinutes: positiveInteger(env.SESSION_IDLE_MINUTES, 30, 'SESSION_IDLE_MINUTES'),
      hardHours: positiveInteger(env.SESSION_HARD_HOURS, 24, 'SESSION_HARD_HOURS'),
    },
    otp: {
      length: positiveInteger(env.OTP_LENGTH, 6, 'OTP_LENGTH'),
      ttlMinutes: positiveInteger(env.OTP_TTL_MINUTES, 10, 'OTP_TTL_MINUTES'),
      maxAttempts: positiveInteger(env.OTP_MAX_ATTEMPTS, 5, 'OTP_MAX_ATTEMPTS'),
    },
    webAuthn: {
      relyingPartyId: env.WEBAUTHN_RP_ID ?? new URL(publicUrl).hostname,
      relyingPartyName: env.WEBAUTHN_RP_NAME ?? 'PassVault',
      origin: env.WEBAUTHN_ORIGIN ?? publicUrl,
    },
    oidc: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? {
            microsoft: {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
              tenant: env.MICROSOFT_TENANT ?? 'common',
            },
          }
        : {}),
    },
    mail: {
      from: env.MAIL_FROM ?? 'passvault@localhost',
      ...(env.SMTP_URL ? { smtpUrl: env.SMTP_URL } : {}),
    },
    generatedSecrets,
  }
}

function keyFrom(value: string | undefined, name: string): Uint8Array | undefined {
  if (!value) {
    return undefined
  }
  let key: Uint8Array
  try {
    key = fromBase64Url(value)
  } catch (cause) {
    throw new Error(`${name} must be ${KEY_BYTES} bytes of base64url`, { cause })
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must decode to ${KEY_BYTES} bytes, got ${key.length}`)
  }
  return key
}

function resolveSecrets(options: {
  dataDir: string
  masterKey: Uint8Array | undefined
  blindIndexKey: Uint8Array | undefined
  generatedSecrets: string[]
}): { masterKey: Uint8Array; blindIndexKey: Uint8Array } {
  if (options.masterKey && options.blindIndexKey) {
    return { masterKey: options.masterKey, blindIndexKey: options.blindIndexKey }
  }

  const path = join(options.dataDir, SECRETS_FILE)
  const stored = readStoredSecrets(path)
  if (stored) {
    return {
      masterKey: options.masterKey ?? fromBase64Url(stored.masterKey),
      blindIndexKey: options.blindIndexKey ?? fromBase64Url(stored.blindIndexKey),
    }
  }

  const masterKey = options.masterKey ?? randomKey()
  const blindIndexKey = options.blindIndexKey ?? randomKey()
  const secrets: StoredSecrets = {
    masterKey: toBase64Url(masterKey),
    blindIndexKey: toBase64Url(blindIndexKey),
    createdAt: new Date().toISOString(),
    note:
      'Generated on first boot so the server starts with no configuration. Move these into ' +
      'MASTER_KEY and BLIND_INDEX_KEY in the environment and delete this file: while it sits ' +
      'beside the database, anybody who copies the data directory has both the ciphertext and ' +
      'the key. Losing MASTER_KEY makes every encrypted value unreadable.',
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX mode. The file is still only as protected as the data directory,
    // which is the same situation as the database itself.
  }
  options.generatedSecrets.push(path)
  return { masterKey, blindIndexKey }
}

function readStoredSecrets(path: string): StoredSecrets | undefined {
  if (!existsSync(path)) {
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredSecrets
  } catch (cause) {
    // Refusing to start is right here: generating a new key would silently make every
    // encrypted value in the database unreadable.
    throw new Error(`${path} exists but cannot be read; refusing to generate new keys`, { cause })
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got '${value}'`)
  }
  return parsed
}
