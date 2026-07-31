import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KEY_BYTES, fromBase64Url, randomKey, toBase64Url } from '@passvault/crypto'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@passvault/i18n'

export type RegistrationMode = 'OPEN' | 'WHITELIST' | 'INVITATION' | 'CLOSED'

const REGISTRATION_MODES: readonly RegistrationMode[] = [
  'OPEN',
  'WHITELIST',
  'INVITATION',
  'CLOSED',
]

/**
 * What the deployment file says about who administers this installation and who may join it.
 *
 * All of it is optional, and none of it is authoritative after the first boot: these values
 * seed the database and the administration screens own them afterwards. The alternative —
 * the environment winning on every restart — was rejected because it makes the screens a lie,
 * and an operator who closes registration from the browser expects it to stay closed. The
 * escape hatch is `REGISTRATION_ENFORCE`, for somebody who would rather the compose file be
 * the single source of truth and the screens read-only in practice.
 */
export interface BootstrapConfig {
  /** The account that owns the installation. Created if absent, promoted if it already exists. */
  adminEmail?: string
  /** Optional. Without it the account is created with a one-time link instead of a password. */
  adminPassword?: string
  adminLocale?: Locale
  registrationMode?: RegistrationMode
  /** Seeded into the allow list, so `WHITELIST` mode works on first boot with no clicking. */
  registrationWhitelist: string[]
  allowPasswordLogin?: boolean
  requireSecondFactor?: boolean
  /** Reapplies the registration settings on every boot rather than only seeding them once. */
  enforce: boolean
}

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
  webAuthn: {
    relyingPartyId: string
    relyingPartyName: string
    /** The browser's origin. Kept alone as well as in `origins` because it is what a client is told. */
    origin: string
    /** Everything a ceremony may legitimately come from, the Android package included. */
    origins: string[]
  }
  /** Read for the Android signing fingerprints, and served verbatim at /.well-known. */
  assetLinksFile: string
  oidc: {
    google?: { clientId: string; clientSecret: string }
    microsoft?: { clientId: string; clientSecret: string; tenant: string }
  }
  mail: { from: string; smtpUrl?: string }
  bootstrap: BootstrapConfig
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
 * the startup log tells the operator to do and what `.env.example` documents.
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
  const assetLinksFile = resolve(
    env.ASSETLINKS_FILE ??
      join(dirname(fileURLToPath(import.meta.url)), '..', 'well-known', 'assetlinks.json'),
  )

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
      origins: [env.WEBAUTHN_ORIGIN ?? publicUrl, ...androidOrigins(env, assetLinksFile)],
    },
    assetLinksFile,
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
    bootstrap: readBootstrap(env),
    generatedSecrets,
  }
}

/**
 * The origins an Android build of the app presents during a WebAuthn ceremony.
 *
 * A browser sends `https://passvault.example.org`. An Android app does not: the platform sends
 * `android:apk-key-hash:<base64url of the SHA-256 of the signing certificate>`, because there is
 * no page and no URL — the binding is to the installed package instead. Verifying against the
 * https origin alone therefore refuses every passkey created from the app, *after* the system
 * sheet has already created it, which reads to the user as the app breaking on the way back.
 *
 * The fingerprints are read from `assetlinks.json` rather than configured separately. That file
 * already has to exist, already has to name the exact certificate, and is already served from
 * this domain — two lists of the same fingerprints would be one list and one stale list.
 *
 * `WEBAUTHN_ANDROID_ORIGINS` overrides it, for a debug build signed with a different key or an
 * installation whose asset links are served by something else.
 */
function androidOrigins(env: NodeJS.ProcessEnv, assetLinksFile: string): string[] {
  const configured = (env.WEBAUTHN_ANDROID_ORIGINS ?? '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (configured.length > 0) {
    return configured
  }
  if (!existsSync(assetLinksFile)) {
    return []
  }
  try {
    const statements = JSON.parse(readFileSync(assetLinksFile, 'utf8')) as {
      target?: { sha256_cert_fingerprints?: string[] }
    }[]
    return statements
      .flatMap((statement) => statement.target?.sha256_cert_fingerprints ?? [])
      .map((fingerprint) => fingerprint.replace(/[^0-9a-fA-F]/g, ''))
      .filter((hex) => hex.length === 64)
      .map((hex) => `android:apk-key-hash:${toBase64Url(new Uint8Array(Buffer.from(hex, 'hex')))}`)
  } catch {
    // A malformed asset links file is a reason for passkeys from the app not to work, not a
    // reason for the server not to start. The file is served verbatim elsewhere, so whoever
    // wrote it can see what they wrote.
    return []
  }
}

/**
 * Where the administrator's one-time setup link is left when there is no mail server.
 *
 * A file in the data directory, because the log is not always reachable. On a Synology the
 * container log is a panel in another application that may or may not be showing anything,
 * while the data directory is a folder in File Station that the operator already has open —
 * and if this cannot be read, the installation has an administrator nobody can sign in as.
 *
 * The token is single-use, expires in 72 hours, and the file is deleted the moment it is
 * redeemed. It sits beside the database, which already holds far more.
 */
export const adminSetupLinkFile = (config: { dataDir: string }): string =>
  join(config.dataDir, 'ADMIN-SETUP-LINK.txt')

function readBootstrap(env: NodeJS.ProcessEnv): BootstrapConfig {
  const adminLocale = env.ADMIN_LOCALE
  if (adminLocale !== undefined && !isLocale(adminLocale)) {
    throw new Error(`ADMIN_LOCALE '${adminLocale}' is not one of gl, es, en`)
  }
  const mode = env.REGISTRATION_MODE?.trim().toUpperCase()
  if (mode !== undefined && mode !== '' && !isRegistrationMode(mode)) {
    throw new Error(`REGISTRATION_MODE '${mode}' is not one of ${REGISTRATION_MODES.join(', ')}`)
  }

  return {
    ...(env.ADMIN_EMAIL?.trim() ? { adminEmail: env.ADMIN_EMAIL.trim() } : {}),
    ...(env.ADMIN_PASSWORD ? { adminPassword: env.ADMIN_PASSWORD } : {}),
    ...(adminLocale ? { adminLocale } : {}),
    ...(mode && isRegistrationMode(mode) ? { registrationMode: mode } : {}),
    // Commas, semicolons, spaces and newlines all separate, because a compose file, a `.env`
    // and a Synology text box each encourage a different one.
    registrationWhitelist: (env.REGISTRATION_WHITELIST ?? '')
      .split(/[,;\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    ...booleanOrAbsent(env.ALLOW_PASSWORD_LOGIN, 'ALLOW_PASSWORD_LOGIN', 'allowPasswordLogin'),
    ...booleanOrAbsent(env.REQUIRE_SECOND_FACTOR, 'REQUIRE_SECOND_FACTOR', 'requireSecondFactor'),
    enforce: parseBoolean(env.REGISTRATION_ENFORCE, 'REGISTRATION_ENFORCE') ?? false,
  }
}

function isRegistrationMode(value: string): value is RegistrationMode {
  return (REGISTRATION_MODES as readonly string[]).includes(value)
}

function booleanOrAbsent(
  value: string | undefined,
  name: string,
  key: string,
): Record<string, boolean> {
  const parsed = parseBoolean(value, name)
  return parsed === undefined ? {} : { [key]: parsed }
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }
  const normalised = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(normalised)) {
    return true
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalised)) {
    return false
  }
  throw new Error(`${name} must be true or false, got '${value}'`)
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
