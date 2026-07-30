/**
 * The wire types of `.tkpak` version 1, as specified in `docs/spec/tkpak-v1.md`.
 *
 * These are deliberately separate from the server's internal domain types even
 * where they currently coincide. The format is a contract with an independent
 * Kotlin implementation: it must be free to stay still while the database schema
 * changes, and it must be obvious in a diff when a change alters the wire format.
 */

export const TKPAK_FORMAT = 'tkpak'
export const TKPAK_VERSION = 1

export type BarcodeFormat =
  | 'QR_CODE'
  | 'AZTEC'
  | 'PDF_417'
  | 'CODE_128'
  | 'CODE_39'
  | 'EAN_13'
  | 'DATA_MATRIX'

export type AssignmentMode = 'OPEN' | 'ASSIGNED' | 'SELF_CLAIM'

export type AssignmentState = 'FREE' | 'PROVISIONAL' | 'CLAIMED' | 'ASSIGNED' | 'TRANSFERRED'

export type PaymentState = 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED'

export type PaymentVisibility = 'ALL' | 'HOLDER_ONLY' | 'CREATOR_ONLY'

export type DocumentMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'application/vnd.apple.pkpass'

export interface TkpakIssuer {
  deviceId: string
  /** Ed25519 public key, base64url. Verifies `signature.bin`. */
  publicKey: string
  /** Free text, cleartext and unverified. Never presented as an identity claim. */
  displayName?: string
}

export interface Argon2KeySlot {
  kind: 'argon2id'
  salt: string
  memoryKiB: number
  iterations: number
  parallelism: number
  wrapNonce: string
  wrappedFileKey: string
}

export interface SealedKeySlot {
  kind: 'x25519-sealed'
  recipientPublicKey: string
  ephemeralPublicKey: string
  wrapNonce: string
  wrappedFileKey: string
}

export type TkpakKeySlot = Argon2KeySlot | SealedKeySlot

export interface TkpakPartDigest {
  nonce: string
  /** SHA-256 of the ciphertext, tag included. */
  sha256: string
  byteLength: number
}

export interface TkpakBlobEntry extends TkpakPartDigest {
  id: string
  mediaType: DocumentMediaType
}

/**
 * Cleartext, and therefore readable by anyone who obtains the file, including a
 * messaging provider. Holds nothing sensitive: no barcode, holder name, amount or
 * note. See the specification for why it exists at all.
 */
export interface TkpakPreview {
  ticketCount: number
  eventName?: string
  eventStartsAt?: string
  venue?: string
}

export interface TkpakManifest {
  format: typeof TKPAK_FORMAT
  version: number
  fileId: string
  createdAt: string
  issuer: TkpakIssuer
  keySlots: TkpakKeySlot[]
  payload: TkpakPartDigest
  blobs: TkpakBlobEntry[]
  preview?: TkpakPreview
}

export interface TkpakEvent {
  id: string
  name: string
  venue?: string
  startsAt?: string
  timeZone?: string
  notes?: string
  defaultAssignmentMode: AssignmentMode
  passwordProtected: boolean
}

export interface TkpakBarcode {
  format: BarcodeFormat
  value: string
}

export interface TkpakAssignment {
  state: AssignmentState
  /** Name as the organiser typed it. Present even when the holder has no account. */
  holderLabel?: string
  holderUserId?: string | null
  assignedAt?: string
}

export interface TkpakPayment {
  state: PaymentState
  amountCents?: number
  currency?: string
  visibility: PaymentVisibility
  settledAt?: string
}

export interface TkpakTicket {
  id: string
  label?: string
  section?: string
  row?: string
  seat?: string
  barcode?: TkpakBarcode
  documentBlobId?: string
  documentPage?: number
  assignmentMode: AssignmentMode
  assignment: TkpakAssignment
  /**
   * Omitted entirely when the recipient is not entitled to see it. Filtering happens
   * in the writer, never in the reader: sending the record and asking the other side
   * not to display it is not a control.
   */
  payment?: TkpakPayment
}

export interface TkpakBundle {
  fileId: string
  exportedAt: string
  exportedFor?: string
  event: TkpakEvent
  tickets: TkpakTicket[]
  /** Signed operation-log entries, letting a file double as a sync transport. */
  operations: unknown[]
}

export interface TkpakDocument {
  id: string
  mediaType: DocumentMediaType
  bytes: Uint8Array
}

export const BARCODE_FORMATS: readonly BarcodeFormat[] = [
  'QR_CODE',
  'AZTEC',
  'PDF_417',
  'CODE_128',
  'CODE_39',
  'EAN_13',
  'DATA_MATRIX',
]

export const DOCUMENT_MEDIA_TYPES: readonly DocumentMediaType[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.apple.pkpass',
]
