/**
 * Galician, the source of truth.
 *
 * Every other catalogue is typed as `Record<MessageKey, string>` against this one, so a
 * missing key is a compile error rather than a runtime fallback that quietly shows
 * English text in a Galician interface. `catalogues.test.ts` covers what the type cannot:
 * that each translation uses the same ICU placeholders.
 *
 * Messages are ICU MessageFormat. Plurals go through `{n, plural, ...}` rather than
 * string concatenation, because concatenation cannot be translated correctly.
 */
export const gl = {
  // ─── Interchange file errors, matching the codes in docs/spec/tkpak-v1.md ───
  'tkpak.error.NOT_A_TKPAK': 'Este ficheiro non é un paquete de entradas de PassVault.',
  'tkpak.error.UNSUPPORTED_VERSION':
    'Este ficheiro fíxose cunha versión máis nova de PassVault. Actualiza a aplicación para abrilo.',
  'tkpak.error.MALFORMED_MANIFEST': 'O ficheiro está danado e non se pode ler.',
  'tkpak.error.LIMIT_EXCEEDED': 'O ficheiro é demasiado grande ou pide demasiados recursos.',
  'tkpak.error.BAD_SIGNATURE':
    'A sinatura non concorda: alguén modificou o ficheiro despois de crealo.',
  'tkpak.error.UNKNOWN_ISSUER':
    'Non se puido verificar quen enviou este ficheiro. Confirma coa persoa que o mandou antes de fiarte del.',
  'tkpak.error.DIGEST_MISMATCH': 'O contido do ficheiro non concorda co que declara. Está danado.',
  'tkpak.error.WRONG_PASSWORD': 'O contrasinal non é correcto.',
  'tkpak.error.NO_USABLE_KEY_SLOT': 'Este ficheiro non está dirixido a ti nin admite contrasinal.',
  'tkpak.error.DECRYPTION_FAILED': 'O ficheiro foi alterado despois de selarse. Non se pode abrir.',
  'tkpak.error.FILE_ID_MISMATCH': 'O ficheiro é incoherente consigo mesmo. Está danado.',

  // ─── Authentication ───
  'auth.error.invalidCredentials': 'O correo ou o contrasinal non son correctos.',
  'auth.error.accountSuspended': 'Esta conta está suspendida. Fala co administrador.',
  'auth.error.secondFactorRequired': 'Fai falta o segundo factor para entrar.',
  'auth.error.invalidOtp': 'O código non é correcto.',
  'auth.error.expiredOtp': 'O código caducou. Pide outro.',
  'auth.error.tooManyAttempts':
    'Demasiados intentos. Agarda {minutes, plural, one {# minuto} other {# minutos}} antes de probar outra vez.',
  'auth.error.passkeyFailed': 'Non se puido verificar a chave de acceso.',
  'auth.error.passwordTooShort': 'O contrasinal ten que ter polo menos {minimum} caracteres.',
  'auth.error.passwordLoginDisabled':
    'Nesta instalación non se pode entrar con contrasinal. Usa Google, Microsoft ou unha chave de acceso.',
  'auth.otp.subject': 'O teu código de acceso a PassVault',
  'auth.otp.body':
    'O teu código é {code}. Caduca en {minutes, plural, one {# minuto} other {# minutos}}. Se non fuches ti quen o pediu, ignora esta mensaxe.',

  // ─── Registration ───
  'registration.error.closed': 'Esta instalación non acepta rexistros novos.',
  'registration.error.notWhitelisted': 'Este enderezo de correo non está autorizado a rexistrarse.',
  'registration.error.invitationRequired': 'Fai falta unha invitación para rexistrarse aquí.',
  'registration.error.invitationInvalid': 'Esta invitación non é válida.',
  'registration.error.invitationExpired': 'Esta invitación caducou.',
  'registration.error.invitationUsedUp': 'Esta invitación xa se usou o número de veces permitido.',
  'registration.error.emailInUse': 'Xa existe unha conta con este enderezo de correo.',
  'registration.invitation.subject': 'Invitación a PassVault',
  'registration.invitation.body':
    '{inviter} invítate a PassVault. Abre {link} para crear a túa conta. A invitación caduca o {expiresAt, date, medium}.',
  'registration.setupPassword.subject': 'Configura o teu contrasinal de PassVault',
  'registration.setupPassword.body':
    'Creouse unha conta para ti en PassVault. Abre {link} para escoller o teu contrasinal. A ligazón caduca o {expiresAt, date, medium}.',
  'registration.error.setupTokenInvalid':
    'Esta ligazón xa non é válida. Pide outra ao administrador.',

  // ─── Vault passphrase ───
  'vault.passphraseRequired': 'Introduce a túa frase de acceso ao baúl para ver as entradas.',
  'vault.error.wrongPassphrase': 'A frase de acceso non é correcta.',
  'vault.error.passphraseTooShort':
    'A frase de acceso ao baúl ten que ter polo menos {minimum} caracteres.',
  'vault.error.notSet': 'Aínda non estableceches unha frase de acceso ao baúl.',
  'vault.error.invalidRecoveryCode': 'O código de recuperación non é correcto.',
  'vault.warning.noRecovery':
    'Se esquences esta frase perdes os teus datos. Non existe forma de recuperalos sen o código de recuperación. Gárdao nun sitio seguro.',
  'vault.explain.twoSecrets':
    'A frase de acceso ao baúl non é o teu contrasinal de entrada. O contrasinal di quen es; a frase descifra os teus datos. Por iso son distintas: entrando con Google non hai contrasinal do que derivar unha chave.',

  // ─── Events ───
  'event.passwordRequired': 'Este evento pide un contrasinal. Pídello a quen o compartiu contigo.',
  'event.error.wrongPassword': 'O contrasinal do evento non é correcto.',
  'event.error.notCreator': 'Só quen creou o evento pode facer isto.',
  'event.warning.passwordLost':
    'Se se perde o contrasinal do evento non se poden recuperar as súas entradas.',
  'event.ticketCount': '{count, plural, =0 {sen entradas} one {# entrada} other {# entradas}}',

  // ─── Assignment and claims ───
  'assignment.state.FREE': 'Libre',
  'assignment.state.PROVISIONAL': 'Pendente de confirmar',
  'assignment.state.CLAIMED': 'Reclamada',
  'assignment.state.ASSIGNED': 'Asignada',
  'assignment.state.TRANSFERRED': 'Cedida',
  'assignment.mode.OPEN': 'Aberta a todo o grupo',
  'assignment.mode.ASSIGNED': 'Asignada polo organizador',
  'assignment.mode.SELF_CLAIM': 'Autorreclamo',
  'claim.provisional.explain':
    'Reclamaches esta entrada sen conexión. Aínda non é definitiva: confírmase cando o dispositivo poida sincronizar.',
  'claim.confirmed': 'A entrada é túa.',
  'claim.rejected.lostRace':
    'Outra persoa reclamou esta entrada antes ca ti. Volveu á lista de libres.',
  'claim.rejected.overAllowance':
    'Xa reclamaches o máximo de {allowance, plural, one {# entrada} other {# entradas}} neste evento.',
  'claim.rejected.invalidCoupon': 'Esta entrada non estaba ofrecida para reclamar.',
  'claim.rejected.ticketWithdrawn': 'O organizador retirou esta entrada.',
  'claim.error.notClaimable': 'Esta entrada non se pode reclamar.',
  'ticket.error.alreadyRevealed':
    'O código xa se mostrou, así que xa non se pode bloquear nin devolver.',
  'ticket.error.notHolder': 'Só quen ten esta entrada pode facer iso.',
  'ticket.error.locked': 'O código aínda non está dispoñible.',
  'claim.error.forSelfOnly': 'Só podes reclamar unha entrada para ti.',

  // ─── Payments ───
  'payment.state.UNPAID': 'Sen pagar',
  'payment.state.PARTIAL': 'Pagada en parte',
  'payment.state.PAID': 'Pagada',
  'payment.state.WAIVED': 'Non fai falta pagala',
  'payment.visibility.ALL': 'Visible para todo o grupo',
  'payment.visibility.HOLDER_ONLY': 'Visible só para quen ten a entrada',
  'payment.visibility.CREATOR_ONLY': 'Visible só para min',
  'payment.owes': '{holder} debe {amount}',
  'payment.summary': '{paid} de {total} pagadas',

  // ─── Ingestion ───
  'calendar.error.noDate':
    'Este evento aínda non ten data, así que non hai nada que engadir ao calendario.',
  'waitlist.error.creator':
    'Xa tes todas as entradas que ninguén máis ten: es quen creou o evento.',
  'checkin.error.empty': 'Non se leu ningún código. Volve intentalo.',
  'ingest.error.unsupportedFile':
    'Non se recoñece este tipo de ficheiro. Admítense PDF, imaxes PNG ou JPG e pases .pkpass.',
  'ingest.error.fileTooLarge': 'O ficheiro pasa do tamaño máximo de {maxMegabytes} MB.',
  'ingest.error.encryptedPdf': 'Este PDF está protexido con contrasinal e non se pode procesar.',
  'ingest.error.damagedFile': 'Non se puido ler o ficheiro. Pode estar incompleto.',
  'ingest.error.pkpassSignatureInvalid':
    'A sinatura deste pase de Apple Wallet non é válida. Pode estar alterado.',
  'ingest.warning.noBarcode':
    'Non se atopou ningún código nesta páxina. Repasa se é unha entrada ou unha folla de instrucións.',
  'ingest.warning.multipleBarcodes':
    'Atopáronse {count} códigos nesta páxina. Revisa como se reparten en entradas.',
  'ingest.warning.tooManyBarcodes':
    'Esta páxina leva máis de {limit} códigos e só se leron os {limit} primeiros. Divide o PDF para non perder as entradas que faltan.',
  'ingest.warning.sharedPage':
    'Non se puido repartir esta páxina, así que cada entrada leva a folla enteira e con ela os códigos das demais.',
  'ingest.warning.sameCodeOnSheet':
    'Estas entradas comparten o mesmo código. Hai vendedores que imprimen un só código por pedido, así que poden ser entradas distintas; outros repiten o código no resgardo. Mira a folla e decide.',
  'ingest.warning.duplicateBarcode':
    'Este código xa aparecía na páxina {firstSeenOnPage}. Déixase fóra para non crear o mesmo asento dúas veces.',
  'ingest.proposal.summary':
    'Atopáronse {tickets, plural, one {# entrada} other {# entradas}} en {pages, plural, one {# páxina} other {# páxinas}}. Revísao antes de gardar.',
  'ingest.proposal.reviewRequired':
    'Non todas as entradas vén unha por páxina: hai PDF con dúas por folla e outros cunha portada de instrucións. Confirma o resultado antes de gardalo.',

  // ─── Local network sharing ───
  'share.lan.searching': 'Buscando dispositivos na rede local…',
  'share.lan.compareCode':
    'Comprobade que os dous móbiles amosan os mesmos seis díxitos: {code}. Se non concordan, alguén se está a interpoñer; cancela.',
  'share.lan.codeMismatch':
    'Os códigos non concordan. Cancelouse a transferencia: isto pode ser un intento de interceptación.',
  'share.lan.confirmed': 'Dispositivo verificado. Xa se pode transferir.',
  'share.lan.warning.publicNetwork':
    'Estar na mesma rede non identifica a ninguén. Nunha rede pública calquera pode anunciarse con calquera nome, por iso hai que comparar os díxitos.',
  'share.export.noRevocation':
    'Cando alguén importa este ficheiro xa ten o código da entrada. Non se pode retirar despois.',

  // ─── Generic ───
  'error.unexpected': 'Produciuse un erro inesperado.',
  'error.forbidden': 'Non tes permiso para facer isto.',
  'error.notFound': 'Non se atopou o que buscabas.',
  'error.validation': 'Hai algún dato do formulario que non é válido. Repásao e proba outra vez.',
  'error.rateLimited': 'Demasiadas peticións. Proba outra vez en pouco.',
  'groups.error.unknownEmail': 'Non hai ningunha conta con ese correo neste servidor.',
  'groups.error.cannotRemoveOwner': 'Non se pode quitar a quen creou o grupo.',
  'groups.error.ownerOnly': 'Só quen creou o grupo pode borralo.',
  'groups.error.unknownUser': 'Non hai ningunha conta con ese correo neste servidor.',

  // --- Handles, labels, invitations and notices ---
  'handle.error.invalid':
    'Un nome de usuario ten entre 3 e 32 caracteres: letras sen acentos, números, punto, guión ou guión baixo.',
  'handle.error.taken': 'Ese nome de usuario xa está collido.',
  'tags.error.unknown': 'Esa etiqueta non existe ou non é túa.',
  'invitation.error.withdrawn': 'Este convite xa non está dispoñible.',
  'invitation.pending': '{inviter} comparte contigo {event}.',
  'notice.event.invited': '{inviter} comparte contigo {event}.',
  'notice.event.accepted': 'Aceptaron o evento que compartiches.',
  'notice.event.declined': 'Rexeitaron o evento que compartiches.',
  'notice.ticket.assigned': 'Asignáronche unha entrada.',

  // ─── Administración ───
  'admin.error.lastAdmin':
    'Este é o único administrador que queda. Nomea outro antes de quitarlle o cargo ou suspendelo, ou ninguén poderá administrar esta instalación.',
  'admin.error.selfSuspend': 'Non podes suspender a túa propia conta.',
  'admin.error.stillInvited':
    'Esta conta aínda non completou a configuración. Actívase soa cando a persoa escolla a súa frase do baúl.',
  'admin.error.alreadyWhitelisted': 'Este enderezo xa está na lista de correos autorizados.',
} as const

export type MessageKey = keyof typeof gl

/** A catalogue for one language. Typed against Galician, so an omission fails the build. */
export type Catalogue = Record<MessageKey, string>
