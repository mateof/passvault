import { TEST_ARGON2_PARAMS, generateAgreementKeyPair, generateSigningKeyPair } from '@passvault/crypto'
import { v7 as uuidv7 } from 'uuid'
import type { TkpakBundle, TkpakDocument, TkpakIssuerIdentity } from '@passvault/tkpak'

export const EVENT_PASSWORD = 'sempre en Galiza'

export const ARGON2 = TEST_ARGON2_PARAMS

export function anIssuer(displayName = 'Mateo'): TkpakIssuerIdentity {
  const { privateKey } = generateSigningKeyPair()
  return { deviceId: uuidv7(), privateKey, displayName }
}

export function aRecipient(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return generateAgreementKeyPair()
}

/** Four tickets for one event, the shape a real export takes. */
export function aBundle(overrides: Partial<Omit<TkpakBundle, 'fileId'>> = {}): Omit<
  TkpakBundle,
  'fileId'
> {
  return {
    exportedAt: '2026-07-30T10:15:00.000Z',
    event: {
      id: uuidv7(),
      name: 'Festival do Norte 2026',
      venue: 'Recinto Ferial, Vilagarcía',
      startsAt: '2026-08-14T19:00:00.000Z',
      timeZone: 'Europe/Madrid',
      defaultAssignmentMode: 'ASSIGNED',
      passwordProtected: true,
    },
    tickets: [
      {
        id: uuidv7(),
        label: 'Grada A 14-B',
        seat: 'B',
        row: '14',
        barcode: { format: 'QR_CODE', value: '8412-AAAA-0001' },
        assignmentMode: 'ASSIGNED',
        assignment: { state: 'ASSIGNED', holderLabel: 'Ana', assignedAt: '2026-07-29T18:02:11.000Z' },
        payment: { state: 'PAID', amountCents: 4500, currency: 'EUR', visibility: 'ALL' },
      },
      {
        id: uuidv7(),
        label: 'Grada A 14-C',
        barcode: { format: 'AZTEC', value: '8412-AAAA-0002' },
        assignmentMode: 'ASSIGNED',
        assignment: { state: 'ASSIGNED', holderLabel: 'Brais' },
        payment: { state: 'UNPAID', amountCents: 4500, currency: 'EUR', visibility: 'HOLDER_ONLY' },
      },
      {
        id: uuidv7(),
        label: 'Grada A 14-D',
        barcode: { format: 'PDF_417', value: '8412-AAAA-0003' },
        assignmentMode: 'SELF_CLAIM',
        assignment: { state: 'FREE' },
      },
      {
        id: uuidv7(),
        label: 'Grada A 14-E',
        barcode: { format: 'CODE_128', value: '8412-AAAA-0004' },
        assignmentMode: 'SELF_CLAIM',
        assignment: { state: 'PROVISIONAL', holderLabel: 'Xoán' },
      },
    ],
    operations: [],
    ...overrides,
  }
}

export function aPdfDocument(id = uuidv7()): TkpakDocument {
  // Enough of a PDF to be recognisably one; ingestion tests use real files.
  const bytes = Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.alloc(512, 0x20),
    Buffer.from('\n%%EOF\n', 'ascii'),
  ])
  return { id, mediaType: 'application/pdf', bytes: new Uint8Array(bytes) }
}
