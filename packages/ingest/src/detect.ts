import { unzipSync } from 'fflate'
import { IngestError } from './errors.js'
import type { DocumentMediaType } from '@passvault/tkpak'

/**
 * Identifies a file by its content, not its name.
 *
 * A ticket arrives from a messaging app, where the extension is whatever the sender's
 * phone decided, and `.pkpass` in particular is routinely renamed to `.zip` in transit.
 * Magic bytes are the only reliable signal.
 */
export function detectMediaType(bytes: Uint8Array): DocumentMediaType {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return 'application/pdf'
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // A ZIP. Only an Apple Wallet pass if it holds a pass.json, which is also what
    // distinguishes it from a .tkpak — both are ZIP containers.
    if (looksLikePkpass(bytes)) {
      return 'application/vnd.apple.pkpass'
    }
    throw new IngestError(
      'UNSUPPORTED_FILE',
      'file is a ZIP archive but holds no pass.json, so it is not an Apple Wallet pass',
    )
  }
  throw new IngestError('UNSUPPORTED_FILE', 'file is not a PDF, PNG, JPEG or Apple Wallet pass')
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) {
    return false
  }
  return signature.every((byte, index) => bytes[index] === byte)
}

function looksLikePkpass(bytes: Uint8Array): boolean {
  try {
    return Object.hasOwn(unzipSync(bytes), 'pass.json')
  } catch {
    return false
  }
}

export function isSupported(bytes: Uint8Array): boolean {
  try {
    detectMediaType(bytes)
    return true
  } catch {
    return false
  }
}
