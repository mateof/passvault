import type { Catalogue } from './gl.js'

export const en: Catalogue = {
  'tkpak.error.NOT_A_TKPAK': 'This file is not a PassVault ticket package.',
  'tkpak.error.UNSUPPORTED_VERSION':
    'This file was made with a newer version of PassVault. Update the app to open it.',
  'tkpak.error.MALFORMED_MANIFEST': 'The file is damaged and cannot be read.',
  'tkpak.error.LIMIT_EXCEEDED': 'The file is too large or asks for too many resources.',
  'tkpak.error.BAD_SIGNATURE':
    'The signature does not match: the file was modified after it was created.',
  'tkpak.error.UNKNOWN_ISSUER':
    'The sender of this file could not be verified. Check with whoever sent it before trusting it.',
  'tkpak.error.DIGEST_MISMATCH': 'The file contents do not match what it declares. It is damaged.',
  'tkpak.error.WRONG_PASSWORD': 'That password is not correct.',
  'tkpak.error.NO_USABLE_KEY_SLOT': 'This file is not addressed to you and takes no password.',
  'tkpak.error.DECRYPTION_FAILED': 'The file was altered after it was sealed. It cannot be opened.',
  'tkpak.error.FILE_ID_MISMATCH': 'The file is inconsistent with itself. It is damaged.',

  'auth.error.invalidCredentials': 'That email or password is not correct.',
  'auth.error.accountSuspended': 'This account is suspended. Talk to the administrator.',
  'auth.error.secondFactorRequired': 'A second factor is needed to sign in.',
  'auth.error.invalidOtp': 'That code is not correct.',
  'auth.error.expiredOtp': 'That code has expired. Ask for another.',
  'auth.error.tooManyAttempts':
    'Too many attempts. Wait {minutes, plural, one {# minute} other {# minutes}} before trying again.',
  'auth.error.passkeyFailed': 'The passkey could not be verified.',
  'auth.error.passwordTooShort': 'The password has to be at least {minimum} characters long.',
  'auth.error.passwordLoginDisabled':
    'This installation does not allow signing in with a password. Use Google, Microsoft or a passkey.',
  'auth.otp.subject': 'Your PassVault sign-in code',
  'auth.otp.body':
    'Your code is {code}. It expires in {minutes, plural, one {# minute} other {# minutes}}. If you did not ask for it, ignore this message.',

  'registration.error.closed': 'This installation is not accepting new registrations.',
  'registration.error.notWhitelisted': 'This email address is not allowed to register.',
  'registration.error.invitationRequired': 'An invitation is needed to register here.',
  'registration.error.invitationInvalid': 'This invitation is not valid.',
  'registration.error.invitationExpired': 'This invitation has expired.',
  'registration.error.invitationUsedUp':
    'This invitation has already been used its allowed number of times.',
  'registration.error.emailInUse': 'An account with this email address already exists.',
  'registration.invitation.subject': 'Invitation to PassVault',
  'registration.invitation.body':
    '{inviter} invites you to PassVault. Open {link} to create your account. The invitation expires on {expiresAt, date, medium}.',
  'registration.setupPassword.subject': 'Set your PassVault password',
  'registration.setupPassword.body':
    'An account has been created for you on PassVault. Open {link} to choose your password. The link expires on {expiresAt, date, medium}.',
  'registration.error.setupTokenInvalid':
    'This link is no longer valid. Ask the administrator for another.',

  'vault.passphraseRequired': 'Enter your vault passphrase to see your tickets.',
  'vault.error.wrongPassphrase': 'That passphrase is not correct.',
  'vault.error.passphraseTooShort':
    'The vault passphrase must be at least {minimum} characters long.',
  'vault.error.notSet': 'You have not set a vault passphrase yet.',
  'vault.error.invalidRecoveryCode': 'That recovery code is not correct.',
  'vault.warning.noRecovery':
    'If you forget this passphrase your data is gone. There is no way to recover it without the recovery code. Keep it somewhere safe.',
  'vault.explain.twoSecrets':
    'The vault passphrase is not your sign-in password. The password says who you are; the passphrase decrypts your data. They are separate because signing in with Google provides no password to derive a key from.',

  'event.passwordRequired': 'This event needs a password. Ask whoever shared it with you.',
  'event.error.wrongPassword': 'That event password is not correct.',
  'event.error.notCreator': 'Only whoever created the event can do this.',
  'event.warning.passwordLost': 'If the event password is lost, its tickets cannot be recovered.',
  'event.ticketCount': '{count, plural, =0 {no tickets} one {# ticket} other {# tickets}}',

  'assignment.state.FREE': 'Free',
  'assignment.state.PROVISIONAL': 'Awaiting confirmation',
  'assignment.state.CLAIMED': 'Claimed',
  'assignment.state.ASSIGNED': 'Assigned',
  'assignment.state.TRANSFERRED': 'Handed over',
  'assignment.mode.OPEN': 'Open to the whole group',
  'assignment.mode.ASSIGNED': 'Allocated by the organiser',
  'assignment.mode.SELF_CLAIM': 'Self-claim',
  'claim.provisional.explain':
    'You claimed this ticket while offline. It is not final yet: it is confirmed once the device can synchronise.',
  'claim.confirmed': 'The ticket is yours.',
  'claim.rejected.lostRace':
    'Somebody claimed this ticket before you. It has gone back to the free list.',
  'claim.rejected.overAllowance':
    'You have already claimed your limit of {allowance, plural, one {# ticket} other {# tickets}} for this event.',
  'claim.rejected.invalidCoupon': 'This ticket was not offered for claiming.',
  'claim.rejected.ticketWithdrawn': 'The organiser withdrew this ticket.',
  'claim.error.notClaimable': 'This ticket cannot be claimed.',
  'claim.error.forSelfOnly': 'You can only claim a ticket for yourself.',

  'payment.state.UNPAID': 'Unpaid',
  'payment.state.PARTIAL': 'Part paid',
  'payment.state.PAID': 'Paid',
  'payment.state.WAIVED': 'No payment needed',
  'payment.visibility.ALL': 'Visible to the whole group',
  'payment.visibility.HOLDER_ONLY': 'Visible only to the ticket holder',
  'payment.visibility.CREATOR_ONLY': 'Visible only to me',
  'payment.owes': '{holder} owes {amount}',
  'payment.summary': '{paid} of {total} paid',

  'ingest.error.unsupportedFile':
    'This file type is not recognised. PDFs, PNG or JPG images and .pkpass passes are supported.',
  'ingest.error.fileTooLarge': 'The file is over the {maxMegabytes} MB limit.',
  'ingest.error.encryptedPdf': 'This PDF is password protected and cannot be processed.',
  'ingest.error.damagedFile': 'The file could not be read. It may be incomplete.',
  'ingest.error.pkpassSignatureInvalid':
    'The signature on this Apple Wallet pass is not valid. It may have been altered.',
  'ingest.warning.noBarcode':
    'No barcode was found on this page. Check whether it is a ticket or a page of instructions.',
  'ingest.warning.multipleBarcodes':
    '{count} barcodes were found on this page. Check how they split into tickets.',
  'ingest.proposal.summary':
    'Found {tickets, plural, one {# ticket} other {# tickets}} across {pages, plural, one {# page} other {# pages}}. Review before saving.',
  'ingest.proposal.reviewRequired':
    'Tickets do not always come one per page: some PDFs put two on a sheet and others lead with instructions. Confirm the result before saving it.',

  'share.lan.searching': 'Looking for devices on the local network…',
  'share.lan.compareCode':
    'Check that both phones show the same six digits: {code}. If they differ, somebody is interposing; cancel.',
  'share.lan.codeMismatch':
    'The codes do not match. The transfer was cancelled: this may be an interception attempt.',
  'share.lan.confirmed': 'Device verified. Ready to transfer.',
  'share.lan.warning.publicNetwork':
    'Being on the same network identifies nobody. On a public network anyone can advertise under any name, which is why the digits have to be compared.',
  'share.export.noRevocation':
    'Once somebody imports this file they hold the ticket barcode. It cannot be taken back afterwards.',

  'error.unexpected': 'Something went wrong.',
  'error.forbidden': 'You do not have permission to do this.',
  'error.notFound': 'That could not be found.',
  'error.validation': 'Something in the form is not valid. Check it and try again.',
  'error.rateLimited': 'Too many requests. Try again shortly.',
  'groups.error.unknownEmail': 'No account on this server uses that email address.',
  'groups.error.cannotRemoveOwner': 'The person who created the group cannot be removed.',

  // ─── Administration ───
  'admin.error.lastAdmin':
    'This is the last administrator left. Appoint another one before demoting or suspending them, or nobody will be able to administer this installation.',
  'admin.error.selfSuspend': 'You cannot suspend your own account.',
  'admin.error.stillInvited':
    'This account has not finished setting itself up. It becomes active on its own once the person chooses their vault passphrase.',
  'admin.error.alreadyWhitelisted': 'That address is already on the allow list.',
}
