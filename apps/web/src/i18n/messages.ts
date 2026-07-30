/**
 * The interface's own words.
 *
 * `@passvault/i18n` carries what the server says — errors, emails — and those arrive already
 * translated because the client asks with `accept-language`. These are the strings only the
 * browser has, and they are separate for that reason rather than by accident.
 *
 * Galician is the source of truth and the other two are typed against it, so a language
 * missing a key does not compile. The project's other implementations enforce this with a
 * test; here the compiler does it, which is the same rule earlier.
 */

export const gl = {
  appName: 'PassVault',

  'nav.events': 'Eventos',
  'nav.account': 'Conta',
  'nav.admin': 'Administración',
  'nav.signOut': 'Saír',

  'action.cancel': 'Cancelar',
  'action.save': 'Gardar',
  'action.confirm': 'Confirmar',
  'action.back': 'Volver',
  'action.retry': 'Reintentar',
  'action.close': 'Pechar',

  'common.loading': 'Cargando…',
  'common.empty': 'Aínda non hai nada aquí.',
  'common.required': 'Este campo é obrigatorio.',

  'login.title': 'Entrar',
  'login.email': 'Correo electrónico',
  'login.password': 'Contrasinal',
  'login.submit': 'Entrar',
  'login.orProvider': 'Ou entra con',
  'login.passkey': 'Entrar cunha chave de acceso',
  'login.needAccount': 'Non tes conta? Rexístrate',
  'login.secondFactor': 'Código de verificación',
  'login.secondFactorHelp': 'Introduce o código que che enviamos.',

  'register.title': 'Crear conta',
  'register.submit': 'Crear conta',
  'register.haveAccount': 'Xa tes conta? Entra',
  'register.invitation': 'Código de invitación',
  'register.closed': 'O rexistro está pechado neste servidor.',

  // The two secrets are the design's hardest thing to explain, so the interface explains it
  // where the user meets it rather than in documentation nobody opens.
  'vault.title': 'Abrir o baúl',
  'vault.explain':
    'A frase do baúl non é o teu contrasinal de acceso. O contrasinal proba quen es; a frase descifra as túas entradas, e o servidor non a garda en ningures.',
  'vault.passphrase': 'Frase do baúl',
  'vault.unlock': 'Abrir',
  'vault.lock': 'Pechar o baúl',
  'vault.locked': 'O baúl está pechado.',
  'vault.setTitle': 'Elixe a frase do baúl',
  'vault.setWarning':
    'Se esquézela, pérdense os datos cifrados. Non hai forma de recuperala: garda o código de recuperación nun sitio seguro.',
  'vault.recoveryCode': 'Código de recuperación',

  'events.title': 'Os teus eventos',
  'events.create': 'Novo evento',
  'events.name': 'Nome do evento',
  'events.venue': 'Lugar',
  'events.startsAt': 'Data',
  'events.tickets': '{count, plural, one {# entrada} other {# entradas}}',
  'events.passwordProtected': 'Protexido cun contrasinal de evento',
  'events.openTitle': 'Este evento ten contrasinal',
  'events.openExplain':
    'O contrasinal do evento non é unha comprobación: é a clave que descifra os códigos das entradas. Sen el o servidor tampouco pode lelos.',
  'events.password': 'Contrasinal do evento',
  'events.open': 'Abrir',

  'tickets.title': 'Entradas',
  'tickets.add': 'Engadir entrada',
  'tickets.label': 'Etiqueta',
  'tickets.seat': 'Asento',
  'tickets.barcode': 'Código',
  'tickets.barcodeFormat': 'Tipo de código',
  'tickets.holder': 'Portador',
  'tickets.assign': 'Asignar',
  'tickets.claim': 'Reclamar',
  'tickets.withdraw': 'Retirar',
  'tickets.reconcile': 'Resolver reclamos',
  // "Retirar", never "revogar". Quen xa importou o ficheiro ten o código.
  'tickets.withdrawWarning':
    'Retirar marca a entrada como retirada no rexistro. Non llo quita a quen xa a teña: o código xa está no seu móbil.',

  'state.FREE': 'Libre',
  'state.PROVISIONAL': 'Pendente de confirmar',
  'state.CLAIMED': 'Reclamada',
  'state.ASSIGNED': 'Asignada',
  'state.WITHDRAWN': 'Retirada',
  'state.TRANSFERRED': 'Transferida',
  'state.provisionalExplain':
    'Reclamouse sen conexión. Aínda non é definitiva: confírmase cando o dispositivo poida sincronizar.',

  'payment.title': 'Pago',
  'payment.state': 'Estado',
  'payment.amount': 'Importe',
  'payment.currency': 'Moeda',
  'payment.visibility': 'Quen o pode ver',
  'payment.visibility.ALL': 'Todo o mundo',
  'payment.visibility.HOLDER_ONLY': 'Só quen leva a entrada',
  'payment.visibility.CREATOR_ONLY': 'Só quen creou o evento',
  'payment.PENDING': 'Pendente',
  'payment.PAID': 'Pagado',
  'payment.WAIVED': 'Perdoado',

  'transfer.export': 'Exportar .tkpak',
  'transfer.exportPassword': 'Contrasinal para o ficheiro',
  'transfer.exportWarning':
    'Cando alguén importa este ficheiro xa ten o código da entrada. Non se pode retirar despois.',
  'transfer.import': 'Importar .tkpak',
  'transfer.importPassword': 'Contrasinal do ficheiro',
  'transfer.importDone': '{count, plural, one {Importouse # entrada} other {Importáronse # entradas}} de «{event}».',
  'transfer.unverifiedSender': 'Non se puido verificar quen enviou este ficheiro.',

  'ingest.title': 'Importar un documento',
  'ingest.explain':
    'Non todas as entradas veñen unha por páxina: hai PDF con dúas por folla e outros cunha portada de instrucións. Revisa isto antes de gardalo.',
  'ingest.confirm': '{count, plural, one {Gardar # entrada} other {Gardar # entradas}}',
  'ingest.noBarcode': 'Non se atopou ningún código nesta páxina.',

  'account.title': 'A túa conta',
  'account.passkeys': 'Chaves de acceso',
  'account.addPasskey': 'Engadir unha chave de acceso',
  'account.noPasskeys': 'Non tes ningunha chave de acceso.',
  'account.language': 'Idioma',

  'admin.title': 'Administración',
  'admin.registrationMode': 'Modo de rexistro',
  'admin.invite': 'Invitar por correo',
  'admin.whitelist': 'Engadir á lista permitida',
  'admin.email': 'Correo electrónico',

  'quarantine.title': 'Operacións en corentena',
  'quarantine.explain':
    'Operacións recibidas que aínda non se poden aplicar, normalmente porque a chave do dispositivo que as asinou aínda non chegou. Gárdanse, non se perden.',
  'quarantine.empty': 'Non hai nada en corentena.',

  'error.offline': 'Non se puido contactar co servidor.',
  'error.unexpected': 'Algo foi mal.',
} as const

export type WebMessages = typeof gl
export type WebMessageKey = keyof WebMessages

export const es: Record<WebMessageKey, string> = {
  appName: 'PassVault',

  'nav.events': 'Eventos',
  'nav.account': 'Cuenta',
  'nav.admin': 'Administración',
  'nav.signOut': 'Salir',

  'action.cancel': 'Cancelar',
  'action.save': 'Guardar',
  'action.confirm': 'Confirmar',
  'action.back': 'Volver',
  'action.retry': 'Reintentar',
  'action.close': 'Cerrar',

  'common.loading': 'Cargando…',
  'common.empty': 'Todavía no hay nada aquí.',
  'common.required': 'Este campo es obligatorio.',

  'login.title': 'Entrar',
  'login.email': 'Correo electrónico',
  'login.password': 'Contraseña',
  'login.submit': 'Entrar',
  'login.orProvider': 'O entra con',
  'login.passkey': 'Entrar con una llave de acceso',
  'login.needAccount': '¿No tienes cuenta? Regístrate',
  'login.secondFactor': 'Código de verificación',
  'login.secondFactorHelp': 'Introduce el código que te hemos enviado.',

  'register.title': 'Crear cuenta',
  'register.submit': 'Crear cuenta',
  'register.haveAccount': '¿Ya tienes cuenta? Entra',
  'register.invitation': 'Código de invitación',
  'register.closed': 'El registro está cerrado en este servidor.',

  'vault.title': 'Abrir el baúl',
  'vault.explain':
    'La frase del baúl no es tu contraseña de acceso. La contraseña prueba quién eres; la frase descifra tus entradas, y el servidor no la guarda en ningún sitio.',
  'vault.passphrase': 'Frase del baúl',
  'vault.unlock': 'Abrir',
  'vault.lock': 'Cerrar el baúl',
  'vault.locked': 'El baúl está cerrado.',
  'vault.setTitle': 'Elige la frase del baúl',
  'vault.setWarning':
    'Si la olvidas, se pierden los datos cifrados. No hay forma de recuperarla: guarda el código de recuperación en un sitio seguro.',
  'vault.recoveryCode': 'Código de recuperación',

  'events.title': 'Tus eventos',
  'events.create': 'Nuevo evento',
  'events.name': 'Nombre del evento',
  'events.venue': 'Lugar',
  'events.startsAt': 'Fecha',
  'events.tickets': '{count, plural, one {# entrada} other {# entradas}}',
  'events.passwordProtected': 'Protegido con una contraseña de evento',
  'events.openTitle': 'Este evento tiene contraseña',
  'events.openExplain':
    'La contraseña del evento no es una comprobación: es la clave que descifra los códigos de las entradas. Sin ella el servidor tampoco puede leerlos.',
  'events.password': 'Contraseña del evento',
  'events.open': 'Abrir',

  'tickets.title': 'Entradas',
  'tickets.add': 'Añadir entrada',
  'tickets.label': 'Etiqueta',
  'tickets.seat': 'Asiento',
  'tickets.barcode': 'Código',
  'tickets.barcodeFormat': 'Tipo de código',
  'tickets.holder': 'Portador',
  'tickets.assign': 'Asignar',
  'tickets.claim': 'Reclamar',
  'tickets.withdraw': 'Retirar',
  'tickets.reconcile': 'Resolver reclamaciones',
  'tickets.withdrawWarning':
    'Retirar marca la entrada como retirada en el registro. No se la quita a quien ya la tenga: el código ya está en su móvil.',

  'state.FREE': 'Libre',
  'state.PROVISIONAL': 'Pendiente de confirmar',
  'state.CLAIMED': 'Reclamada',
  'state.ASSIGNED': 'Asignada',
  'state.WITHDRAWN': 'Retirada',
  'state.TRANSFERRED': 'Transferida',
  'state.provisionalExplain':
    'Se reclamó sin conexión. Todavía no es definitiva: se confirma cuando el dispositivo pueda sincronizar.',

  'payment.title': 'Pago',
  'payment.state': 'Estado',
  'payment.amount': 'Importe',
  'payment.currency': 'Moneda',
  'payment.visibility': 'Quién lo puede ver',
  'payment.visibility.ALL': 'Todo el mundo',
  'payment.visibility.HOLDER_ONLY': 'Solo quien lleva la entrada',
  'payment.visibility.CREATOR_ONLY': 'Solo quien creó el evento',
  'payment.PENDING': 'Pendiente',
  'payment.PAID': 'Pagado',
  'payment.WAIVED': 'Perdonado',

  'transfer.export': 'Exportar .tkpak',
  'transfer.exportPassword': 'Contraseña para el archivo',
  'transfer.exportWarning':
    'Cuando alguien importa este archivo ya tiene el código de la entrada. No se puede retirar después.',
  'transfer.import': 'Importar .tkpak',
  'transfer.importPassword': 'Contraseña del archivo',
  'transfer.importDone':
    '{count, plural, one {Se ha importado # entrada} other {Se han importado # entradas}} de «{event}».',
  'transfer.unverifiedSender': 'No se ha podido verificar quién envió este archivo.',

  'ingest.title': 'Importar un documento',
  'ingest.explain':
    'No todas las entradas vienen una por página: hay PDF con dos por hoja y otros con una portada de instrucciones. Revisa esto antes de guardarlo.',
  'ingest.confirm': '{count, plural, one {Guardar # entrada} other {Guardar # entradas}}',
  'ingest.noBarcode': 'No se ha encontrado ningún código en esta página.',

  'account.title': 'Tu cuenta',
  'account.passkeys': 'Llaves de acceso',
  'account.addPasskey': 'Añadir una llave de acceso',
  'account.noPasskeys': 'No tienes ninguna llave de acceso.',
  'account.language': 'Idioma',

  'admin.title': 'Administración',
  'admin.registrationMode': 'Modo de registro',
  'admin.invite': 'Invitar por correo',
  'admin.whitelist': 'Añadir a la lista permitida',
  'admin.email': 'Correo electrónico',

  'quarantine.title': 'Operaciones en cuarentena',
  'quarantine.explain':
    'Operaciones recibidas que todavía no se pueden aplicar, normalmente porque la clave del dispositivo que las firmó aún no ha llegado. Se guardan, no se pierden.',
  'quarantine.empty': 'No hay nada en cuarentena.',

  'error.offline': 'No se ha podido contactar con el servidor.',
  'error.unexpected': 'Algo ha ido mal.',
}

export const en: Record<WebMessageKey, string> = {
  appName: 'PassVault',

  'nav.events': 'Events',
  'nav.account': 'Account',
  'nav.admin': 'Administration',
  'nav.signOut': 'Sign out',

  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.confirm': 'Confirm',
  'action.back': 'Back',
  'action.retry': 'Try again',
  'action.close': 'Close',

  'common.loading': 'Loading…',
  'common.empty': 'Nothing here yet.',
  'common.required': 'This field is required.',

  'login.title': 'Sign in',
  'login.email': 'Email address',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.orProvider': 'Or sign in with',
  'login.passkey': 'Sign in with a passkey',
  'login.needAccount': 'No account? Register',
  'login.secondFactor': 'Verification code',
  'login.secondFactorHelp': 'Enter the code we sent you.',

  'register.title': 'Create an account',
  'register.submit': 'Create account',
  'register.haveAccount': 'Already have an account? Sign in',
  'register.invitation': 'Invitation code',
  'register.closed': 'Registration is closed on this server.',

  'vault.title': 'Open the vault',
  'vault.explain':
    'The vault passphrase is not your sign-in password. The password proves who you are; the passphrase decrypts your tickets, and the server keeps it nowhere.',
  'vault.passphrase': 'Vault passphrase',
  'vault.unlock': 'Open',
  'vault.lock': 'Lock the vault',
  'vault.locked': 'The vault is locked.',
  'vault.setTitle': 'Choose your vault passphrase',
  'vault.setWarning':
    'If you forget it, the encrypted data is lost. There is no way to recover it: keep the recovery code somewhere safe.',
  'vault.recoveryCode': 'Recovery code',

  'events.title': 'Your events',
  'events.create': 'New event',
  'events.name': 'Event name',
  'events.venue': 'Venue',
  'events.startsAt': 'Date',
  'events.tickets': '{count, plural, one {# ticket} other {# tickets}}',
  'events.passwordProtected': 'Protected with an event password',
  'events.openTitle': 'This event has a password',
  'events.openExplain':
    'The event password is not a check: it is the key that decrypts the ticket barcodes. Without it the server cannot read them either.',
  'events.password': 'Event password',
  'events.open': 'Open',

  'tickets.title': 'Tickets',
  'tickets.add': 'Add a ticket',
  'tickets.label': 'Label',
  'tickets.seat': 'Seat',
  'tickets.barcode': 'Barcode',
  'tickets.barcodeFormat': 'Barcode type',
  'tickets.holder': 'Holder',
  'tickets.assign': 'Assign',
  'tickets.claim': 'Claim',
  'tickets.withdraw': 'Withdraw',
  'tickets.reconcile': 'Resolve claims',
  'tickets.withdrawWarning':
    'Withdrawing marks the ticket as withdrawn in the log. It does not take it back from anybody who already holds it: the barcode is already on their phone.',

  'state.FREE': 'Free',
  'state.PROVISIONAL': 'Awaiting confirmation',
  'state.CLAIMED': 'Claimed',
  'state.ASSIGNED': 'Assigned',
  'state.WITHDRAWN': 'Withdrawn',
  'state.TRANSFERRED': 'Transferred',
  'state.provisionalExplain':
    'Claimed while offline. It is not final yet: it is confirmed once the device can synchronise.',

  'payment.title': 'Payment',
  'payment.state': 'Status',
  'payment.amount': 'Amount',
  'payment.currency': 'Currency',
  'payment.visibility': 'Who can see it',
  'payment.visibility.ALL': 'Everybody',
  'payment.visibility.HOLDER_ONLY': 'Only the ticket holder',
  'payment.visibility.CREATOR_ONLY': 'Only the event creator',
  'payment.PENDING': 'Pending',
  'payment.PAID': 'Paid',
  'payment.WAIVED': 'Waived',

  'transfer.export': 'Export .tkpak',
  'transfer.exportPassword': 'Password for the file',
  'transfer.exportWarning':
    'Once somebody imports this file they hold the ticket barcode. It cannot be taken back afterwards.',
  'transfer.import': 'Import .tkpak',
  'transfer.importPassword': 'File password',
  'transfer.importDone':
    '{count, plural, one {Imported # ticket} other {Imported # tickets}} from “{event}”.',
  'transfer.unverifiedSender': 'The sender of this file could not be verified.',

  'ingest.title': 'Import a document',
  'ingest.explain':
    'Tickets do not always come one per page: some PDFs put two on a sheet and others lead with instructions. Check this before saving it.',
  'ingest.confirm': '{count, plural, one {Save # ticket} other {Save # tickets}}',
  'ingest.noBarcode': 'No barcode was found on this page.',

  'account.title': 'Your account',
  'account.passkeys': 'Passkeys',
  'account.addPasskey': 'Add a passkey',
  'account.noPasskeys': 'You have no passkeys.',
  'account.language': 'Language',

  'admin.title': 'Administration',
  'admin.registrationMode': 'Registration mode',
  'admin.invite': 'Invite by email',
  'admin.whitelist': 'Add to the allow list',
  'admin.email': 'Email address',

  'quarantine.title': 'Quarantined operations',
  'quarantine.explain':
    'Operations that arrived but cannot be applied yet, usually because the key of the device that signed them has not arrived. They are kept, not lost.',
  'quarantine.empty': 'Nothing is quarantined.',

  'error.offline': 'The server could not be reached.',
  'error.unexpected': 'Something went wrong.',
}

export const WEB_CATALOGUES = { gl, es, en }
