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
  'rule.minChars': '{min, plural, one {Polo menos # carácter.} other {Polo menos # caracteres.}}',

  'login.title': 'Entrar',
  'login.email': 'Correo electrónico',
  'login.password': 'Contrasinal',
  'login.submit': 'Entrar',
  'login.orProvider': 'Ou entra con',
  'login.passkey': 'Entrar cunha chave de acceso',
  'login.needAccount': 'Non tes conta? Rexístrate',
  'login.secondFactor': 'Código de verificación',
  'login.secondFactorHelp': 'Introduce o código que che enviamos por correo.',
  'login.secondFactorApp': 'Introduce o código da túa aplicación de autenticación.',

  'setPassword.title': 'Configura a túa conta',
  'setPassword.help':
    'Creouse unha conta para ti. Escolle o teu contrasinal: quen a creou non o vai coñecer.',
  'setPassword.submit': 'Configurar a conta',
  'setPassword.noToken':
    'Falta o código desta ligazón. Abre a ligazón completa que che enviaron por correo.',

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
  'events.subtitle': '{count, plural, =0 {Aínda non hai eventos} one {# evento} other {# eventos}}',
  'events.none': 'Aínda non tes ningún evento. Crea un ou importa un ficheiro .tkpak.',
  'events.locked': 'Evento pechado',
  'events.protected': 'Con contrasinal',
  'events.notReadableByServer':
    'Este evento ten contrasinal, así que quen administra o servidor non pode ler as súas entradas.',
  'events.icon': 'Icona',
  'events.colour': 'Cor',
  'events.icon.concert': 'Concerto',
  'events.icon.football': 'Deporte',
  'events.icon.theatre': 'Teatro',
  'events.icon.cinema': 'Cine',
  'events.icon.travel': 'Viaxe',
  'events.icon.museum': 'Museo',
  'events.icon.party': 'Festa',
  'events.icon.other': 'Outro',
  'events.appearance': 'Cambiar a imaxe do evento',
  'events.imageChoose': 'Escoller unha imaxe (PNG ou JPG)',
  'events.imageHelp':
    'Gárdase cifrada coa clave do evento, coma calquera outro documento. Se importas un PDF e non escolles ningunha, úsase a súa primeira páxina.',
  'events.imageRemove': 'Quitar a imaxe',
  'tickets.none': 'Este evento aínda non ten entradas.',
  'tickets.noBarcode': 'Esta entrada non ten código, ou non tes permiso para velo.',
  'documents.title': 'Ficheiros orixinais',
  'documents.explain':
    'O ficheiro que che mandaron, enteiro. Garda tamén as páxinas que non son entradas — o mapa, as instrucións, as condicións — que son xusto as que a división descarta.',
  'documents.type.pdf': 'Documento PDF',
  'documents.type.image': 'Imaxe',
  'documents.type.pass': 'Pase de Apple Wallet',
  'documents.pages': '{count, plural, one {# páxina} other {# páxinas}}',
  'documents.fromHere':
    '{count, plural, =0 {sen entradas} one {# entrada de aquí} other {# entradas de aquí}}',
  'documents.open': 'Abrir',
  'transfer.importChoose': 'Escoller un ficheiro .tkpak',
  'ingest.choose': 'Escoller un PDF, imaxe ou .pkpass',
  'ingest.page': 'páxina {page}',
  'payment.save': 'Gardar o pago',
  'payment.UNPAID': 'Sen pagar',
  'payment.PARTIAL': 'Pagada en parte',
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
  'payment.PAID': 'Pagado',
  'payment.WAIVED': 'Perdoado',

  'transfer.export': 'Exportar .tkpak',
  'transfer.exportPassword': 'Contrasinal para o ficheiro',
  'transfer.exportWarning':
    'Cando alguén importa este ficheiro xa ten o código da entrada. Non se pode retirar despois.',
  'transfer.import': 'Importar .tkpak',
  'transfer.importPassword': 'Contrasinal do ficheiro',
  'transfer.importDone':
    '{count, plural, one {Importouse # entrada} other {Importáronse # entradas}} de «{event}».',
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
  'admin.notAdministrator': 'Esta pantalla é só para quen administra o servidor.',
  'admin.registration': 'Quen se pode rexistrar',
  'admin.registrationMode': 'Modo de rexistro',
  'admin.mode.OPEN': 'Aberto',
  'admin.mode.WHITELIST': 'Só correos autorizados',
  'admin.mode.INVITATION': 'Só por invitación',
  'admin.mode.CLOSED': 'Pechado',
  'admin.mode.OPEN.help': 'Calquera que chegue ao servidor pode crear unha conta.',
  'admin.mode.WHITELIST.help':
    'Só se poden rexistrar os enderezos que engadas abaixo. Útil cando sabes de antemán quen vai entrar.',
  'admin.mode.INVITATION.help':
    'Fai falta un código de invitación. Créalos abaixo: cada un ten caducidade e número de usos.',
  'admin.mode.CLOSED.help':
    'Ninguén se pode rexistrar por si mesmo. Ti podes seguir creando contas desde aquí.',
  'admin.allowPasswordLogin': 'Permitir entrar con contrasinal',
  'admin.requireSecondFactor': 'Esixir segundo factor',
  'admin.requireSecondFactorHelp':
    'Quen non teña unha app de códigos recibe un código por correo. Sen SMTP_URL configurado non se pode enviar, así que esas contas quedarían sen poder entrar.',
  'admin.enforcedByEnvironment':
    'REGISTRATION_ENFORCE está activo: o ficheiro de despregue volverá escribir isto no próximo reinicio.',
  'admin.saved': 'Gardado.',

  'admin.users': 'Contas',
  'admin.role.admin': 'Administra',
  'admin.role.member': 'Membro',
  'admin.status.ACTIVE': 'Activa',
  'admin.status.INVITED': 'Pendente de configurar',
  'admin.status.SUSPENDED': 'Suspendida',
  'admin.noVault': 'sen baúl',
  'admin.noPassword': 'sen contrasinal',
  'admin.promote': 'Facer administrador',
  'admin.demote': 'Quitar administración',
  'admin.suspend': 'Suspender',
  'admin.reinstate': 'Reactivar',
  'admin.sendSetupLink': 'Enviar ligazón de configuración',
  'admin.setupLink': 'Ligazón de configuración:',
  'admin.createUser': 'Crear unha conta',
  'admin.createUserHelp':
    'Créase sen contrasinal e envíase unha ligazón para que a persoa escolla o seu. Ti nunca chegas a coñecelo, e a frase do baúl escóllea ela: se a escolleses ti, poderías ler os seus datos.',
  'admin.alsoAdministrator': 'Que tamén administre o servidor',
  'admin.closedStillWorks':
    'O rexistro está pechado, pero as contas creadas desde aquí seguen funcionando.',

  'admin.invitations': 'Invitacións',
  'admin.invitationsInactive':
    'O servidor non está en modo invitación, así que estes códigos non se piden ao rexistrarse.',
  'admin.invite': 'Crear invitación',
  'admin.inviteLink': 'Ligazón de invitación:',
  'admin.emailOptional': 'Correo electrónico (opcional)',
  'admin.inviteEmailHelp':
    'Se pos un enderezo, a invitación só vale para el. Se o deixas baleiro vale para calquera que teña o código.',
  'admin.maxUses': 'Usos permitidos',
  'admin.ttlHours': 'Caduca en (horas)',
  'admin.boundToAddress': 'Para un enderezo concreto',
  'admin.anyAddress': 'Para calquera enderezo',
  'admin.usesOf': 'usada {uses} de {max}',
  'admin.expiresOn': 'caduca o {date}',
  'admin.spent': 'xa non vale',
  'admin.revoke': 'Anular',

  'admin.whitelist': 'Correos autorizados',
  'admin.whitelistAdd': 'Engadir',
  'admin.whitelistHelp':
    'Só se garda unha forma cifrada do enderezo e un índice para buscalo. Serve para autorizar, non para escribirlle.',
  'admin.whitelistInactive':
    'O servidor non está en modo «só correos autorizados», así que esta lista non se comproba agora mesmo.',
  'admin.remove': 'Quitar',
  'admin.email': 'Correo electrónico',
  'admin.copy': 'Copiar',

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
  'rule.minChars': '{min, plural, one {Al menos # carácter.} other {Al menos # caracteres.}}',

  'login.title': 'Entrar',
  'login.email': 'Correo electrónico',
  'login.password': 'Contraseña',
  'login.submit': 'Entrar',
  'login.orProvider': 'O entra con',
  'login.passkey': 'Entrar con una llave de acceso',
  'login.needAccount': '¿No tienes cuenta? Regístrate',
  'login.secondFactor': 'Código de verificación',
  'login.secondFactorHelp': 'Introduce el código que te hemos enviado por correo.',
  'login.secondFactorApp': 'Introduce el código de tu aplicación de autenticación.',

  'setPassword.title': 'Configura tu cuenta',
  'setPassword.help':
    'Se ha creado una cuenta para ti. Elige tu contraseña: quien la creó no va a conocerla.',
  'setPassword.submit': 'Configurar la cuenta',
  'setPassword.noToken':
    'Falta el código de este enlace. Abre el enlace completo que te enviaron por correo.',

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
  'events.subtitle':
    '{count, plural, =0 {Todavía no hay eventos} one {# evento} other {# eventos}}',
  'events.none': 'Todavía no tienes ningún evento. Crea uno o importa un archivo .tkpak.',
  'events.locked': 'Evento cerrado',
  'events.protected': 'Con contraseña',
  'events.notReadableByServer':
    'Este evento tiene contraseña, así que quien administra el servidor no puede leer sus entradas.',
  'events.icon': 'Icono',
  'events.colour': 'Color',
  'events.icon.concert': 'Concierto',
  'events.icon.football': 'Deporte',
  'events.icon.theatre': 'Teatro',
  'events.icon.cinema': 'Cine',
  'events.icon.travel': 'Viaje',
  'events.icon.museum': 'Museo',
  'events.icon.party': 'Fiesta',
  'events.icon.other': 'Otro',
  'events.appearance': 'Cambiar la imagen del evento',
  'events.imageChoose': 'Elegir una imagen (PNG o JPG)',
  'events.imageHelp':
    'Se guarda cifrada con la clave del evento, como cualquier otro documento. Si importas un PDF y no eliges ninguna, se usa su primera página.',
  'events.imageRemove': 'Quitar la imagen',
  'tickets.none': 'Este evento todavía no tiene entradas.',
  'tickets.noBarcode': 'Esta entrada no tiene código, o no tienes permiso para verlo.',
  'documents.title': 'Archivos originales',
  'documents.explain':
    'El archivo que te mandaron, entero. Guarda también las páginas que no son entradas — el mapa, las instrucciones, las condiciones — que son justo las que la división descarta.',
  'documents.type.pdf': 'Documento PDF',
  'documents.type.image': 'Imagen',
  'documents.type.pass': 'Pase de Apple Wallet',
  'documents.pages': '{count, plural, one {# página} other {# páginas}}',
  'documents.fromHere':
    '{count, plural, =0 {sin entradas} one {# entrada de aquí} other {# entradas de aquí}}',
  'documents.open': 'Abrir',
  'transfer.importChoose': 'Elegir un archivo .tkpak',
  'ingest.choose': 'Elegir un PDF, imagen o .pkpass',
  'ingest.page': 'página {page}',
  'payment.save': 'Guardar el pago',
  'payment.UNPAID': 'Sin pagar',
  'payment.PARTIAL': 'Pagada en parte',
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
  'admin.notAdministrator': 'Esta pantalla es solo para quien administra el servidor.',
  'admin.registration': 'Quién se puede registrar',
  'admin.registrationMode': 'Modo de registro',
  'admin.mode.OPEN': 'Abierto',
  'admin.mode.WHITELIST': 'Solo correos autorizados',
  'admin.mode.INVITATION': 'Solo por invitación',
  'admin.mode.CLOSED': 'Cerrado',
  'admin.mode.OPEN.help': 'Cualquiera que llegue al servidor puede crear una cuenta.',
  'admin.mode.WHITELIST.help':
    'Solo se pueden registrar las direcciones que añadas abajo. Útil cuando sabes de antemano quién va a entrar.',
  'admin.mode.INVITATION.help':
    'Hace falta un código de invitación. Créalos abajo: cada uno tiene caducidad y número de usos.',
  'admin.mode.CLOSED.help':
    'Nadie se puede registrar por su cuenta. Tú puedes seguir creando cuentas desde aquí.',
  'admin.allowPasswordLogin': 'Permitir entrar con contraseña',
  'admin.requireSecondFactor': 'Exigir segundo factor',
  'admin.requireSecondFactorHelp':
    'Quien no tenga una app de códigos recibe uno por correo. Sin SMTP_URL configurado no se puede enviar, así que esas cuentas se quedarían sin poder entrar.',
  'admin.enforcedByEnvironment':
    'REGISTRATION_ENFORCE está activo: el fichero de despliegue volverá a escribir esto en el próximo reinicio.',
  'admin.saved': 'Guardado.',

  'admin.users': 'Cuentas',
  'admin.role.admin': 'Administra',
  'admin.role.member': 'Miembro',
  'admin.status.ACTIVE': 'Activa',
  'admin.status.INVITED': 'Pendiente de configurar',
  'admin.status.SUSPENDED': 'Suspendida',
  'admin.noVault': 'sin baúl',
  'admin.noPassword': 'sin contraseña',
  'admin.promote': 'Hacer administrador',
  'admin.demote': 'Quitar administración',
  'admin.suspend': 'Suspender',
  'admin.reinstate': 'Reactivar',
  'admin.sendSetupLink': 'Enviar enlace de configuración',
  'admin.setupLink': 'Enlace de configuración:',
  'admin.createUser': 'Crear una cuenta',
  'admin.createUserHelp':
    'Se crea sin contraseña y se envía un enlace para que la persona elija la suya. Tú nunca llegas a conocerla, y la frase del baúl la elige ella: si la eligieras tú, podrías leer sus datos.',
  'admin.alsoAdministrator': 'Que también administre el servidor',
  'admin.closedStillWorks':
    'El registro está cerrado, pero las cuentas creadas desde aquí siguen funcionando.',

  'admin.invitations': 'Invitaciones',
  'admin.invitationsInactive':
    'El servidor no está en modo invitación, así que estos códigos no se piden al registrarse.',
  'admin.invite': 'Crear invitación',
  'admin.inviteLink': 'Enlace de invitación:',
  'admin.emailOptional': 'Correo electrónico (opcional)',
  'admin.inviteEmailHelp':
    'Si pones una dirección, la invitación solo vale para ella. Si lo dejas vacío vale para cualquiera que tenga el código.',
  'admin.maxUses': 'Usos permitidos',
  'admin.ttlHours': 'Caduca en (horas)',
  'admin.boundToAddress': 'Para una dirección concreta',
  'admin.anyAddress': 'Para cualquier dirección',
  'admin.usesOf': 'usada {uses} de {max}',
  'admin.expiresOn': 'caduca el {date}',
  'admin.spent': 'ya no vale',
  'admin.revoke': 'Anular',

  'admin.whitelist': 'Correos autorizados',
  'admin.whitelistAdd': 'Añadir',
  'admin.whitelistHelp':
    'Solo se guarda una forma cifrada de la dirección y un índice para buscarla. Sirve para autorizar, no para escribirle.',
  'admin.whitelistInactive':
    'El servidor no está en modo «solo correos autorizados», así que esta lista no se comprueba ahora mismo.',
  'admin.remove': 'Quitar',
  'admin.email': 'Correo electrónico',
  'admin.copy': 'Copiar',

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
  'rule.minChars': '{min, plural, one {At least # character.} other {At least # characters.}}',

  'login.title': 'Sign in',
  'login.email': 'Email address',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.orProvider': 'Or sign in with',
  'login.passkey': 'Sign in with a passkey',
  'login.needAccount': 'No account? Register',
  'login.secondFactor': 'Verification code',
  'login.secondFactorHelp': 'Enter the code we emailed you.',
  'login.secondFactorApp': 'Enter the code from your authenticator app.',

  'setPassword.title': 'Set up your account',
  'setPassword.help':
    'An account has been created for you. Choose your own password: whoever created it will not know it.',
  'setPassword.submit': 'Set up the account',
  'setPassword.noToken':
    'This link is missing its code. Open the full link that was emailed to you.',

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
  'events.subtitle': '{count, plural, =0 {No events yet} one {# event} other {# events}}',
  'events.none': 'No events yet. Create one, or import a .tkpak file.',
  'events.locked': 'Locked event',
  'events.protected': 'Password protected',
  'events.notReadableByServer':
    'This event has a password, so whoever runs the server cannot read its tickets.',
  'events.icon': 'Icon',
  'events.colour': 'Colour',
  'events.icon.concert': 'Concert',
  'events.icon.football': 'Sport',
  'events.icon.theatre': 'Theatre',
  'events.icon.cinema': 'Cinema',
  'events.icon.travel': 'Travel',
  'events.icon.museum': 'Museum',
  'events.icon.party': 'Party',
  'events.icon.other': 'Other',
  'events.appearance': 'Change how this event looks',
  'events.imageChoose': 'Choose a picture (PNG or JPG)',
  'events.imageHelp':
    'Stored encrypted under the event key, like every other document. Import a PDF and choose nothing, and its first page is used.',
  'events.imageRemove': 'Remove the picture',
  'tickets.none': 'This event has no tickets yet.',
  'tickets.noBarcode': 'This ticket has no barcode, or you are not entitled to see it.',
  'documents.title': 'Original files',
  'documents.explain':
    'The file you were sent, kept whole. It also holds the pages that are not tickets — the map, the instructions, the terms — which are exactly the ones splitting drops.',
  'documents.type.pdf': 'PDF document',
  'documents.type.image': 'Image',
  'documents.type.pass': 'Apple Wallet pass',
  'documents.pages': '{count, plural, one {# page} other {# pages}}',
  'documents.fromHere':
    '{count, plural, =0 {no tickets} one {# ticket from this} other {# tickets from this}}',
  'documents.open': 'Open',
  'transfer.importChoose': 'Choose a .tkpak file',
  'ingest.choose': 'Choose a PDF, image or .pkpass',
  'ingest.page': 'page {page}',
  'payment.save': 'Save the payment',
  'payment.UNPAID': 'Unpaid',
  'payment.PARTIAL': 'Part paid',
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
  'admin.notAdministrator': 'This screen is only for whoever administers the server.',
  'admin.registration': 'Who can register',
  'admin.registrationMode': 'Registration mode',
  'admin.mode.OPEN': 'Open',
  'admin.mode.WHITELIST': 'Allowed addresses only',
  'admin.mode.INVITATION': 'By invitation only',
  'admin.mode.CLOSED': 'Closed',
  'admin.mode.OPEN.help': 'Anybody who reaches the server can create an account.',
  'admin.mode.WHITELIST.help':
    'Only the addresses you add below can register. Useful when you already know who is joining.',
  'admin.mode.INVITATION.help':
    'An invitation code is required. Create them below: each has an expiry and a number of uses.',
  'admin.mode.CLOSED.help':
    'Nobody can register on their own. You can still create accounts from here.',
  'admin.allowPasswordLogin': 'Allow signing in with a password',
  'admin.requireSecondFactor': 'Require a second factor',
  'admin.requireSecondFactorHelp':
    'Anybody without an authenticator app gets a code by email. Without SMTP_URL configured it cannot be sent, so those accounts would be locked out.',
  'admin.enforcedByEnvironment':
    'REGISTRATION_ENFORCE is on: the deployment file will write these settings again on the next restart.',
  'admin.saved': 'Saved.',

  'admin.users': 'Accounts',
  'admin.role.admin': 'Administrator',
  'admin.role.member': 'Member',
  'admin.status.ACTIVE': 'Active',
  'admin.status.INVITED': 'Setup pending',
  'admin.status.SUSPENDED': 'Suspended',
  'admin.noVault': 'no vault',
  'admin.noPassword': 'no password',
  'admin.promote': 'Make administrator',
  'admin.demote': 'Remove administrator',
  'admin.suspend': 'Suspend',
  'admin.reinstate': 'Reinstate',
  'admin.sendSetupLink': 'Send a setup link',
  'admin.setupLink': 'Setup link:',
  'admin.createUser': 'Create an account',
  'admin.createUserHelp':
    'It is created without a password and a link is sent so the person chooses their own. You never learn it, and they choose the vault passphrase themselves: if you chose it, you could read their data.',
  'admin.alsoAdministrator': 'Also administers the server',
  'admin.closedStillWorks': 'Registration is closed, but accounts created from here still work.',

  'admin.invitations': 'Invitations',
  'admin.invitationsInactive':
    'The server is not in invitation mode, so these codes are not asked for when registering.',
  'admin.invite': 'Create an invitation',
  'admin.inviteLink': 'Invitation link:',
  'admin.emailOptional': 'Email address (optional)',
  'admin.inviteEmailHelp':
    'With an address, the invitation only works for that address. Left empty it works for anybody holding the code.',
  'admin.maxUses': 'Uses allowed',
  'admin.ttlHours': 'Expires in (hours)',
  'admin.boundToAddress': 'For one specific address',
  'admin.anyAddress': 'For any address',
  'admin.usesOf': 'used {uses} of {max}',
  'admin.expiresOn': 'expires {date}',
  'admin.spent': 'no longer valid',
  'admin.revoke': 'Revoke',

  'admin.whitelist': 'Allowed addresses',
  'admin.whitelistAdd': 'Add',
  'admin.whitelistHelp':
    'Only an encrypted form of the address and an index to find it are stored. It is there to authorise, not to write to.',
  'admin.whitelistInactive':
    'The server is not in “allowed addresses only” mode, so this list is not being checked right now.',
  'admin.remove': 'Remove',
  'admin.email': 'Email address',
  'admin.copy': 'Copy',

  'quarantine.title': 'Quarantined operations',
  'quarantine.explain':
    'Operations that arrived but cannot be applied yet, usually because the key of the device that signed them has not arrived. They are kept, not lost.',
  'quarantine.empty': 'Nothing is quarantined.',

  'error.offline': 'The server could not be reached.',
  'error.unexpected': 'Something went wrong.',
}

export const WEB_CATALOGUES = { gl, es, en }
