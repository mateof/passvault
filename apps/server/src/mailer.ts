import type { Locale, MessageKey, MessageValues } from '@passvault/i18n'
import { translate } from '@passvault/i18n'
import type { ServerConfig } from './config.js'

export interface OutgoingMail {
  to: string
  subject: string
  body: string
}

export interface Mailer {
  send: (mail: OutgoingMail) => Promise<void>
}

/**
 * Sends a message in the recipient's own language.
 *
 * The locale comes from the user row rather than the request, because these are sent outside
 * any request — a code the user asked for arrives after the response has gone — so
 * `Accept-Language` is not available at the time it matters.
 */
export async function sendLocalised(
  mailer: Mailer,
  options: {
    to: string
    locale: Locale
    subjectKey: MessageKey
    bodyKey: MessageKey
    values?: MessageValues
  },
): Promise<void> {
  await mailer.send({
    to: options.to,
    subject: translate(options.locale, options.subjectKey, options.values),
    body: translate(options.locale, options.bodyKey, options.values),
  })
}

/**
 * The default when no SMTP server is configured: write the message to the log.
 *
 * This is what makes a zero-configuration installation usable rather than a dead end. A
 * self-hoster who has not set up mail can still complete a sign-in, because the code is in
 * the log they are already watching — and the log says plainly that the code is there, so
 * nobody has to guess.
 *
 * It also means one-time codes end up in the log file. Stated rather than hidden: the log
 * warns on first use, and docs/deployment.md says to configure SMTP for anything beyond a
 * private instance.
 */
export class LoggingMailer implements Mailer {
  private warned = false

  constructor(private readonly log: (message: string) => void) {}

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.warned) {
      this.warned = true
      this.log(
        'No SMTP_URL is configured, so mail is written to this log. One-time codes will ' +
          'therefore appear here in the clear. Configure SMTP_URL for any shared instance.',
      )
    }
    this.log(`mail to ${mail.to}: ${mail.subject}\n${mail.body}`)
  }
}

/** Collects messages instead of sending them. Used by the tests, which assert on what was sent. */
export class CapturingMailer implements Mailer {
  readonly sent: OutgoingMail[] = []

  async send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail)
  }

  lastTo(address: string): OutgoingMail | undefined {
    return [...this.sent].reverse().find((mail) => mail.to === address)
  }
}

/**
 * SMTP through nodemailer.
 *
 * A hand-written SMTP client was considered and rejected: it is the one place in this project
 * where the failure mode of a subtle bug is mail that silently does not arrive, and there is
 * no way to verify it here without a real server to talk to. Nodemailer is small, does exactly
 * this, and is MIT so it composes with GPL-3.
 */
export class SmtpMailer implements Mailer {
  private transport: Promise<{
    sendMail: (message: Record<string, unknown>) => Promise<unknown>
  }>

  constructor(
    private readonly smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = this.connect()
  }

  private async connect() {
    // A variable specifier, so TypeScript does not resolve an optional dependency at build
    // time: an installation that never sends mail must still compile without it.
    const specifier = 'nodemailer'
    const nodemailer = (await import(specifier)) as {
      createTransport: (url: string) => {
        sendMail: (message: Record<string, unknown>) => Promise<unknown>
      }
    }
    return nodemailer.createTransport(this.smtpUrl)
  }

  async send(mail: OutgoingMail): Promise<void> {
    const transport = await this.transport
    await transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
    })
  }
}

export function createMailer(config: ServerConfig, log: (message: string) => void): Mailer {
  return config.mail.smtpUrl
    ? new SmtpMailer(config.mail.smtpUrl, config.mail.from)
    : new LoggingMailer(log)
}
