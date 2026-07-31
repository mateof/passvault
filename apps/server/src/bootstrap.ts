import { writeFileSync } from 'node:fs'
import {
  MINIMUM_PASSPHRASE_LENGTH,
  adminCreateAccount,
  sendPasswordSetupLink,
  setupUrl,
  type AccountsDeps,
} from './accounts.js'
import { addWhitelistEntry } from './administration.js'
import { adminSetupLinkFile } from './config.js'
import * as repo from './repository.js'

/**
 * The floor for a password an operator types into a deployment file.
 *
 * The same length the registration endpoint demands. A shorter one is refused rather than
 * accepted quietly, because `ADMIN_PASSWORD=admin` on an instance behind a tunnel is the
 * failure this whole feature exists to avoid.
 */
const MINIMUM_ADMIN_PASSWORD_LENGTH = 10

/**
 * What the deployment file asks for, applied once the database is open.
 *
 * This exists so that putting PassVault on a NAS is one file and one `docker compose up`:
 * without it, a fresh installation is closed, has no administrator, and the only way to get
 * one is to register through a browser at exactly the right moment — which is the bootstrap
 * hole every self-hosted application has and the reason so many of them ship a default
 * password. There is no default anything here; there is a file the operator already had to
 * edit to set `MASTER_KEY`.
 *
 * Two rules, both deliberate:
 *
 *   * **Registration settings seed, they do not enforce.** They are written when the database
 *     has never had them, and after that the administration screens own them. An operator who
 *     wants the file to keep winning sets `REGISTRATION_ENFORCE=true` and accepts that the
 *     screens will be overwritten on the next restart.
 *   * **`ADMIN_EMAIL` is idempotent and never destructive.** It creates the account if it is
 *     missing and promotes it if it exists. It never demotes anybody, never resets a password,
 *     and never touches key material — an environment variable must not be able to take over
 *     an account that already holds data.
 */
export interface BootstrapReport {
  /** Lines worth putting in the startup log, already written for a human reader. */
  notes: string[]
  warnings: string[]
  adminUserId?: string
  /** Present when the administrator has to be sent somewhere to choose a password. */
  adminSetupUrl?: string
}

export async function applyBootstrap(deps: AccountsDeps): Promise<BootstrapReport> {
  const report: BootstrapReport = { notes: [], warnings: [] }
  const { bootstrap } = deps.config

  await seedRegistrationSettings(deps, report)
  const adminUserId = await ensureAdministrator(deps, report)
  if (adminUserId) {
    report.adminUserId = adminUserId
  }
  await seedWhitelist(deps, report, adminUserId ?? null)

  if (
    bootstrap.registrationMode === 'WHITELIST' &&
    bootstrap.registrationWhitelist.length === 0 &&
    (await repo.listWhitelist(deps.db)).length === 0
  ) {
    report.warnings.push(
      'REGISTRATION_MODE is WHITELIST and the allow list is empty, so nobody can register. ' +
        'Set REGISTRATION_WHITELIST or add addresses from the administration screen.',
    )
  }

  return report
}

async function seedRegistrationSettings(
  deps: AccountsDeps,
  report: BootstrapReport,
): Promise<void> {
  const { bootstrap } = deps.config
  const wanted = {
    ...(bootstrap.registrationMode ? { mode: bootstrap.registrationMode } : {}),
    ...(bootstrap.allowPasswordLogin === undefined
      ? {}
      : { allowPasswordLogin: bootstrap.allowPasswordLogin }),
    ...(bootstrap.requireSecondFactor === undefined
      ? {}
      : { requireSecondFactor: bootstrap.requireSecondFactor }),
  }
  if (Object.keys(wanted).length === 0) {
    return
  }

  const existing = await repo.findRegistrationSettings(deps.db)
  if (existing && !bootstrap.enforce) {
    if (bootstrap.registrationMode && bootstrap.registrationMode !== existing.mode) {
      // Said out loud rather than silently ignored: an operator who edits the file and
      // restarts expects something to happen, and finding out days later that it did not is
      // worse than being told now.
      report.notes.push(
        `REGISTRATION_MODE says ${bootstrap.registrationMode} but this installation is already ` +
          `set to ${existing.mode}. The administration screen owns this setting; set ` +
          'REGISTRATION_ENFORCE=true if the deployment file should win on every start.',
      )
    }
    return
  }

  await repo.writeRegistrationSettings(deps.db, { ...wanted, updatedBy: null })
  report.notes.push(
    `registration settings ${existing ? 'reapplied from' : 'seeded from'} the environment: ` +
      Object.entries(wanted)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', '),
  )
}

async function ensureAdministrator(
  deps: AccountsDeps,
  report: BootstrapReport,
): Promise<string | undefined> {
  const { bootstrap } = deps.config
  if (!bootstrap.adminEmail) {
    return undefined
  }

  const existing = await repo.findUserByEmailIndex(
    deps.db,
    deps.crypto.emailIndex(bootstrap.adminEmail),
  )
  if (existing) {
    if (existing.is_admin !== 1) {
      await repo.setUserAdmin(deps.db, existing.id, true)
      await repo.recordAudit(deps.db, {
        action: 'user.promoted',
        subjectKind: 'user',
        subjectId: existing.id,
      })
      report.notes.push(`${bootstrap.adminEmail} promoted to administrator by ADMIN_EMAIL`)
    }
    await offerSetupAgain(deps, report, existing)
    return existing.id
  }

  if (bootstrap.adminPassword && bootstrap.adminPassword.length < MINIMUM_ADMIN_PASSWORD_LENGTH) {
    report.warnings.push(
      `ADMIN_PASSWORD is shorter than ${MINIMUM_ADMIN_PASSWORD_LENGTH} characters; the account ` +
        'was created with a one-time setup link instead.',
    )
  }
  const usablePassword =
    bootstrap.adminPassword && bootstrap.adminPassword.length >= MINIMUM_ADMIN_PASSWORD_LENGTH
      ? bootstrap.adminPassword
      : undefined

  const created = await adminCreateAccount(deps, {
    actorUserId: null,
    email: bootstrap.adminEmail,
    isAdmin: true,
    ...(bootstrap.adminLocale ? { locale: bootstrap.adminLocale } : {}),
    ...(usablePassword ? { initialPassword: usablePassword } : {}),
  })

  if (usablePassword) {
    report.notes.push(
      `administrator ${bootstrap.adminEmail} created from ADMIN_EMAIL. Sign in with ` +
        'ADMIN_PASSWORD and choose a vault passphrase; the passphrase is not the password and ' +
        `has to be at least ${MINIMUM_PASSPHRASE_LENGTH} characters.`,
    )
    report.warnings.push(
      'ADMIN_PASSWORD is in the environment of a running container. Change the password from ' +
        'the account screen and remove it from the deployment file.',
    )
  } else if (created.setupToken) {
    announceSetupLink(deps, report, setupUrl(deps, created.setupToken), 'created')
  }
  return created.userId
}

/**
 * Issues another setup link for an administrator who never finished setting up.
 *
 * Every restart, and that is the point. The first link expires after 72 hours, and without
 * this the operator of a container whose mail never worked has an administrator account that
 * exists, cannot be signed into, and cannot be recovered short of deleting the database —
 * which was true of the first version of this file and is the failure it was written to
 * prevent. Restarting the container is the one recovery step every self-hoster already knows.
 *
 * Nothing happens once the account has either a password or key material: at that point
 * somebody has been through setup and reissuing a link would be handing out a way in.
 */
async function offerSetupAgain(
  deps: AccountsDeps,
  report: BootstrapReport,
  user: { id: string; password_hash: string | null },
): Promise<void> {
  if (user.password_hash !== null) {
    return
  }
  if (await repo.findUserKeys(deps.db, user.id)) {
    return
  }
  const email = deps.config.bootstrap.adminEmail
  if (!email) {
    return
  }
  const token = await sendPasswordSetupLink(deps, {
    userId: user.id,
    email,
    locale: deps.config.bootstrap.adminLocale ?? deps.config.defaultLocale,
  })
  announceSetupLink(deps, report, setupUrl(deps, token), 'never finished setting up')
}

/**
 * Says where the link is, in every place the operator might be looking.
 *
 * The log, because that is where a startup message belongs, and a file in the data directory,
 * because a container log is not always reachable — see `adminSetupLinkFile`. Failing to write
 * the file is reported and not fatal: a read-only mount is a reason to fix the mount, not a
 * reason to refuse to start a server that is otherwise working.
 */
function announceSetupLink(
  deps: AccountsDeps,
  report: BootstrapReport,
  url: string,
  why: 'created' | 'never finished setting up',
): void {
  const email = deps.config.bootstrap.adminEmail
  report.adminSetupUrl = url
  report.notes.push(
    `administrator ${email} ${why === 'created' ? 'created from ADMIN_EMAIL with no password' : 'has never finished setting up'}. ` +
      `Open this link within 72 hours to set a password: ${url}`,
  )

  const path = adminSetupLinkFile(deps.config)
  try {
    writeFileSync(
      path,
      `${url}\n\nOpen this once, within 72 hours of the timestamp on this file, to set the\n` +
        `password for ${email}. This file is deleted as soon as the link is used. If it has\n` +
        'expired, restart the container and a new one is written here.\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    report.notes.push(`the same link is in ${path}, in case this log is not where you can see it`)
  } catch (cause) {
    report.warnings.push(`could not write the setup link to ${path}: ${String(cause)}`)
  }

  if (!deps.config.mail.smtpUrl) {
    report.warnings.push(
      'No SMTP_URL is configured, so that link was not emailed. It is in this log and in the ' +
        'file above, and nowhere else.',
    )
  }
}

async function seedWhitelist(
  deps: AccountsDeps,
  report: BootstrapReport,
  addedBy: string | null,
): Promise<void> {
  const wanted = deps.config.bootstrap.registrationWhitelist
  if (wanted.length === 0) {
    return
  }
  const added: string[] = []
  for (const email of wanted) {
    if (await repo.isWhitelisted(deps.db, deps.crypto.emailIndex(email))) {
      continue
    }
    try {
      await addWhitelistEntry(deps, { email, addedBy })
      added.push(email)
    } catch (cause) {
      report.warnings.push(`could not add ${email} to the allow list: ${String(cause)}`)
    }
  }
  if (added.length > 0) {
    report.notes.push(`allow list seeded from REGISTRATION_WHITELIST: ${added.join(', ')}`)
  }
}
