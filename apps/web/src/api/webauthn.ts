/**
 * Passkeys in the browser.
 *
 * The server speaks the JSON form of WebAuthn — every binary field is base64url — and the browser
 * API speaks `ArrayBuffer`. Something has to translate, and this is it: about thirty lines rather
 * than a dependency, which keeps the bundle free of a library whose whole job is two `for` loops.
 *
 * `PublicKeyCredential.parseCreationOptionsFromJSON` does exactly this and is not used, because it
 * landed in Safari only in 17.4 and this is the one screen where a browser being a year behind
 * means somebody cannot sign in at all. The conversion is done by hand and works everywhere the
 * API itself does.
 *
 * Nothing here decides anything. The ceremony's whole security property is that the private key
 * never leaves the authenticator and the origin is checked by the platform rather than by any code
 * on this page — including this code.
 */

const fromBase64Url = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

const toBase64Url = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Whether this browser can do the ceremony at all, so a button is not offered that cannot work. */
export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' && window.PublicKeyCredential !== undefined

interface CreationOptions {
  challenge: string
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: { type: 'public-key'; alg: number }[]
  timeout?: number
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[]
  authenticatorSelection?: Record<string, unknown>
  attestation?: string
}

interface RequestOptions {
  challenge: string
  rpId?: string
  timeout?: number
  allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[]
  userVerification?: string
}

/**
 * Creates a passkey for this account.
 *
 * Returns null when the user closes the system prompt. Backing out is a choice, not a failure, and
 * reporting it as an error puts a red message on screen for somebody who simply changed their mind.
 */
export async function createPasskey(
  options: CreationOptions,
): Promise<Record<string, unknown> | null> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64Url(options.challenge),
      user: { ...options.user, id: fromBase64Url(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map((entry) => ({
        ...entry,
        id: fromBase64Url(entry.id),
        transports: entry.transports as AuthenticatorTransport[] | undefined,
      })),
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null

  if (!credential) {
    return null
  }
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  }
}

/** Signs a challenge with an existing passkey. Null when the user dismissed the prompt. */
export async function usePasskey(options: RequestOptions): Promise<Record<string, unknown> | null> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromBase64Url(options.challenge),
      allowCredentials: options.allowCredentials?.map((entry) => ({
        ...entry,
        id: fromBase64Url(entry.id),
        transports: entry.transports as AuthenticatorTransport[] | undefined,
      })),
    } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null

  if (!credential) {
    return null
  }
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  }
}
