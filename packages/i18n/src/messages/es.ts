import type { Catalogue } from './gl.js'

export const es: Catalogue = {
  'tkpak.error.NOT_A_TKPAK': 'Este archivo no es un paquete de entradas de PassVault.',
  'tkpak.error.UNSUPPORTED_VERSION':
    'Este archivo se creó con una versión más nueva de PassVault. Actualiza la aplicación para abrirlo.',
  'tkpak.error.MALFORMED_MANIFEST': 'El archivo está dañado y no se puede leer.',
  'tkpak.error.LIMIT_EXCEEDED': 'El archivo es demasiado grande o pide demasiados recursos.',
  'tkpak.error.BAD_SIGNATURE':
    'La firma no coincide: alguien modificó el archivo después de crearlo.',
  'tkpak.error.UNKNOWN_ISSUER':
    'No se ha podido verificar quién envió este archivo. Confírmalo con quien te lo mandó antes de fiarte de él.',
  'tkpak.error.DIGEST_MISMATCH':
    'El contenido del archivo no coincide con lo que declara. Está dañado.',
  'tkpak.error.WRONG_PASSWORD': 'La contraseña no es correcta.',
  'tkpak.error.NO_USABLE_KEY_SLOT': 'Este archivo no va dirigido a ti ni admite contraseña.',
  'tkpak.error.DECRYPTION_FAILED': 'El archivo se alteró después de sellarse. No se puede abrir.',
  'tkpak.error.FILE_ID_MISMATCH': 'El archivo es incoherente consigo mismo. Está dañado.',

  'auth.error.invalidCredentials': 'El correo o la contraseña no son correctos.',
  'auth.error.accountSuspended': 'Esta cuenta está suspendida. Habla con el administrador.',
  'auth.error.secondFactorRequired': 'Hace falta el segundo factor para entrar.',
  'auth.error.invalidOtp': 'El código no es correcto.',
  'auth.error.expiredOtp': 'El código ha caducado. Pide otro.',
  'auth.error.tooManyAttempts':
    'Demasiados intentos. Espera {minutes, plural, one {# minuto} other {# minutos}} antes de volver a probar.',
  'auth.error.passkeyFailed': 'No se ha podido verificar la llave de acceso.',
  'auth.error.passwordLoginDisabled':
    'En esta instalación no se puede entrar con contraseña. Usa Google, Microsoft o una llave de acceso.',
  'auth.otp.subject': 'Tu código de acceso a PassVault',
  'auth.otp.body':
    'Tu código es {code}. Caduca en {minutes, plural, one {# minuto} other {# minutos}}. Si no lo has pedido tú, ignora este mensaje.',

  'registration.error.closed': 'Esta instalación no acepta registros nuevos.',
  'registration.error.notWhitelisted': 'Esta dirección de correo no está autorizada a registrarse.',
  'registration.error.invitationRequired': 'Hace falta una invitación para registrarse aquí.',
  'registration.error.invitationInvalid': 'Esta invitación no es válida.',
  'registration.error.invitationExpired': 'Esta invitación ha caducado.',
  'registration.error.invitationUsedUp':
    'Esta invitación ya se ha usado el número de veces permitido.',
  'registration.error.emailInUse': 'Ya existe una cuenta con esta dirección de correo.',
  'registration.invitation.subject': 'Invitación a PassVault',
  'registration.invitation.body':
    '{inviter} te invita a PassVault. Abre {link} para crear tu cuenta. La invitación caduca el {expiresAt, date, medium}.',
  'registration.setupPassword.subject': 'Configura tu contraseña de PassVault',
  'registration.setupPassword.body':
    'Se ha creado una cuenta para ti en PassVault. Abre {link} para elegir tu contraseña. El enlace caduca el {expiresAt, date, medium}.',
  'registration.error.setupTokenInvalid':
    'Este enlace ya no es válido. Pide otro al administrador.',

  'vault.passphraseRequired': 'Introduce tu frase de acceso al baúl para ver las entradas.',
  'vault.error.wrongPassphrase': 'La frase de acceso no es correcta.',
  'vault.error.passphraseTooShort':
    'La frase de acceso al baúl tiene que tener al menos {minimum} caracteres.',
  'vault.error.notSet': 'Todavía no has establecido una frase de acceso al baúl.',
  'vault.error.invalidRecoveryCode': 'El código de recuperación no es correcto.',
  'vault.warning.noRecovery':
    'Si olvidas esta frase pierdes tus datos. No hay forma de recuperarlos sin el código de recuperación. Guárdalo en un sitio seguro.',
  'vault.explain.twoSecrets':
    'La frase de acceso al baúl no es tu contraseña de entrada. La contraseña dice quién eres; la frase descifra tus datos. Por eso son distintas: entrando con Google no hay contraseña de la que derivar una clave.',

  'event.passwordRequired':
    'Este evento pide una contraseña. Pídesela a quien lo compartió contigo.',
  'event.error.wrongPassword': 'La contraseña del evento no es correcta.',
  'event.warning.passwordLost':
    'Si se pierde la contraseña del evento no se pueden recuperar sus entradas.',
  'event.ticketCount': '{count, plural, =0 {sin entradas} one {# entrada} other {# entradas}}',

  'assignment.state.FREE': 'Libre',
  'assignment.state.PROVISIONAL': 'Pendiente de confirmar',
  'assignment.state.CLAIMED': 'Reclamada',
  'assignment.state.ASSIGNED': 'Asignada',
  'assignment.state.TRANSFERRED': 'Cedida',
  'assignment.mode.OPEN': 'Abierta a todo el grupo',
  'assignment.mode.ASSIGNED': 'Asignada por el organizador',
  'assignment.mode.SELF_CLAIM': 'Autorreclamo',
  'claim.provisional.explain':
    'Has reclamado esta entrada sin conexión. Todavía no es definitiva: se confirma cuando el dispositivo pueda sincronizar.',
  'claim.confirmed': 'La entrada es tuya.',
  'claim.rejected.lostRace':
    'Otra persona reclamó esta entrada antes que tú. Ha vuelto a la lista de libres.',
  'claim.rejected.overAllowance':
    'Ya has reclamado el máximo de {allowance, plural, one {# entrada} other {# entradas}} en este evento.',
  'claim.rejected.invalidCoupon': 'Esta entrada no estaba ofrecida para reclamar.',
  'claim.rejected.ticketWithdrawn': 'El organizador ha retirado esta entrada.',
  'claim.error.notClaimable': 'Esta entrada no se puede reclamar.',
  'claim.error.forSelfOnly': 'Solo puedes reclamar una entrada para ti.',

  'payment.state.UNPAID': 'Sin pagar',
  'payment.state.PARTIAL': 'Pagada en parte',
  'payment.state.PAID': 'Pagada',
  'payment.state.WAIVED': 'No hace falta pagarla',
  'payment.visibility.ALL': 'Visible para todo el grupo',
  'payment.visibility.HOLDER_ONLY': 'Visible solo para quien tiene la entrada',
  'payment.visibility.CREATOR_ONLY': 'Visible solo para mí',
  'payment.owes': '{holder} debe {amount}',
  'payment.summary': '{paid} de {total} pagadas',

  'ingest.error.unsupportedFile':
    'No se reconoce este tipo de archivo. Se admiten PDF, imágenes PNG o JPG y pases .pkpass.',
  'ingest.error.fileTooLarge': 'El archivo pasa del tamaño máximo de {maxMegabytes} MB.',
  'ingest.error.encryptedPdf': 'Este PDF está protegido con contraseña y no se puede procesar.',
  'ingest.error.damagedFile': 'No se ha podido leer el archivo. Puede estar incompleto.',
  'ingest.error.pkpassSignatureInvalid':
    'La firma de este pase de Apple Wallet no es válida. Puede estar alterado.',
  'ingest.warning.noBarcode':
    'No se ha encontrado ningún código en esta página. Repasa si es una entrada o una hoja de instrucciones.',
  'ingest.warning.multipleBarcodes':
    'Se han encontrado {count} códigos en esta página. Revisa cómo se reparten en entradas.',
  'ingest.proposal.summary':
    'Se han encontrado {tickets, plural, one {# entrada} other {# entradas}} en {pages, plural, one {# página} other {# páginas}}. Revísalo antes de guardar.',
  'ingest.proposal.reviewRequired':
    'No todas las entradas vienen una por página: hay PDF con dos por hoja y otros con una portada de instrucciones. Confirma el resultado antes de guardarlo.',

  'share.lan.searching': 'Buscando dispositivos en la red local…',
  'share.lan.compareCode':
    'Comprobad que los dos móviles muestran los mismos seis dígitos: {code}. Si no coinciden, alguien se está interponiendo; cancela.',
  'share.lan.codeMismatch':
    'Los códigos no coinciden. Se ha cancelado la transferencia: esto puede ser un intento de interceptación.',
  'share.lan.confirmed': 'Dispositivo verificado. Ya se puede transferir.',
  'share.lan.warning.publicNetwork':
    'Estar en la misma red no identifica a nadie. En una red pública cualquiera puede anunciarse con cualquier nombre, y por eso hay que comparar los dígitos.',
  'share.export.noRevocation':
    'Cuando alguien importa este archivo ya tiene el código de la entrada. No se puede retirar después.',

  'error.unexpected': 'Se ha producido un error inesperado.',
  'error.forbidden': 'No tienes permiso para hacer esto.',
  'error.notFound': 'No se ha encontrado lo que buscabas.',
  'error.rateLimited': 'Demasiadas peticiones. Prueba otra vez en un momento.',
}
