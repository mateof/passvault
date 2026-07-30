import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import {
  completePairing,
  publicKeyFromPrivate,
  signBytes,
  open as aeadOpen,
  seal as aeadSeal,
  hkdf,
  toBase64Url,
  fromBase64Url,
  generateAgreementKeyPair,
} from '@passvault/crypto'
import { signingInput, type SignedOperation } from '../apps/server/src/operations.js'

/**
 * The other phone, played by this workstation.
 *
 * The Android transfer needs a peer on the same network, and mDNS does not cross the emulator's
 * NAT — so this connects the other way, through `adb forward`, and speaks the same wire protocol.
 *
 * It is a test harness and also a fifth cross-implementation check. The six digits it prints are
 * derived by the server's TypeScript pairing code from the transcript the Kotlin side produced; if
 * the two ever stop agreeing, the digits on this terminal and the digits on the phone differ, which
 * is exactly the symptom a real user would see and exactly what `LocalPairingTest` pins.
 *
 *   adb logcat -s PassVaultShare        # read the port the app is listening on
 *   adb forward tcp:9999 tcp:<port>
 *   npx tsx scripts/local-transfer-peer.ts 9999
 */

const port = Number(process.argv[2] ?? 9999)
const VERSION = 1

const DEVICE_ID = '0192f5c0-9999-7000-8000-ffffeeeedddd'
const EVENT_ID = '0192f5b1-9999-7000-8000-444455556666'

const signingPrivateKey = new Uint8Array(randomBytes(32))
const signingPublicKey = publicKeyFromPrivate(signingPrivateKey)
const agreement = generateAgreementKeyPair()

class Framed {
  private buffer = Buffer.alloc(0)
  private waiters: ((frame: Buffer) => void)[] = []

  constructor(private socket: import('node:net').Socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
  }

  private drain(): void {
    while (this.buffer.length >= 4 && this.waiters.length > 0) {
      const length = this.buffer.readInt32BE(0)
      if (this.buffer.length < 4 + length) return
      const frame = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      this.waiters.shift()!(frame)
    }
  }

  read(): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      this.drain()
    })
  }

  write(payload: Buffer): void {
    const header = Buffer.alloc(4)
    header.writeInt32BE(payload.length, 0)
    this.socket.write(Buffer.concat([header, payload]))
  }
}

/** Mirrors `TransferProtocol.nonceOf`: eight zero bytes then a big-endian counter. */
function nonceOf(counter: number): Uint8Array {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(BigInt(counter), 4)
  return new Uint8Array(nonce)
}

class Session {
  private sent = 0
  private received = 0

  constructor(
    private framed: Framed,
    private sendKey: Uint8Array,
    private receiveKey: Uint8Array,
  ) {}

  send(value: unknown): void {
    const plaintext = new Uint8Array(Buffer.from(JSON.stringify(value), 'utf8'))
    const sealed = aeadSeal({
      key: this.sendKey,
      nonce: nonceOf(this.sent),
      plaintext,
      aad: `passvault/v1/transfer:${this.sent}`,
    })
    this.sent += 1
    this.framed.write(Buffer.from(sealed))
  }

  async receive(): Promise<any> {
    const frame = await this.framed.read()
    const opened = aeadOpen({
      key: this.receiveKey,
      nonce: nonceOf(this.received),
      ciphertext: new Uint8Array(frame),
      aad: `passvault/v1/transfer:${this.received}`,
    })
    this.received += 1
    return JSON.parse(Buffer.from(opened).toString('utf8'))
  }
}

/** An operation this peer will offer the phone, signed the way the specification says. */
function operation(type: string, body: Record<string, unknown>, lamport: number): SignedOperation {
  const unsigned = {
    operationId: `0192f5d0-9999-7000-8000-${String(lamport).padStart(12, '0')}`,
    deviceId: DEVICE_ID,
    actorUserId: null,
    lamport,
    wallClock: '2026-07-30T12:00:00.000Z',
    scope: { kind: 'event' as const, id: EVENT_ID },
    type,
    body,
  }
  return { ...unsigned, signature: toBase64Url(signBytes(signingPrivateKey, signingInput(unsigned))) }
}

const offered: SignedOperation[] = [
  operation(
    'device.register',
    {
      deviceId: DEVICE_ID,
      signingPublicKey: toBase64Url(signingPublicKey),
      agreementPublicKey: toBase64Url(agreement.publicKey),
      name: 'Workstation',
    },
    1,
  ),
  operation('event.create', { name: 'Concerto de proba' }, 2),
  operation(
    'ticket.add',
    {
      ticketId: '0192f5b2-9999-7000-8000-777788889999',
      barcodeFormat: 'QR_CODE',
      barcodeValue: '8412-PEER-0001',
    },
    3,
  ),
]

const socket = connect({ host: '127.0.0.1', port }, async () => {
  const framed = new Framed(socket)

  const ephemeral = generateAgreementKeyPair()
  // This side dials, so it is the initiator, and both must agree on that or they order the
  // transcript differently and every honest pairing looks like an attack.
  framed.write(
    Buffer.from(
      JSON.stringify({
        kind: 'hello',
        version: VERSION,
        deviceId: DEVICE_ID,
        name: 'Workstation',
        ephemeralPublicKey: toBase64Url(ephemeral.publicKey),
        signingPublicKey: toBase64Url(signingPublicKey),
      }),
      'utf8',
    ),
  )

  const greeting = JSON.parse((await framed.read()).toString('utf8'))
  console.log(`the phone says it is "${greeting.name}" (${greeting.deviceId})`)

  const paired = completePairing({
    ownPrivateKey: ephemeral.privateKey,
    ownPublicKey: ephemeral.publicKey,
    peerPublicKey: fromBase64Url(greeting.ephemeralPublicKey),
    isInitiator: true,
  })

  console.log('')
  console.log(`  compare these with the phone:  ${paired.shortAuthenticationString.split('').join(' ')}`)
  console.log('')

  const sendKey = hkdf(paired.sessionKey, new Uint8Array(0), 'passvault/v1/transfer/initiator')
  const receiveKey = hkdf(paired.sessionKey, new Uint8Array(0), 'passvault/v1/transfer/responder')
  const session = new Session(framed, sendKey, receiveKey)

  session.send({ kind: 'confirm' })
  const confirmation = await session.receive()
  if (confirmation.kind !== 'confirm') {
    throw new Error(`expected a confirmation, got ${confirmation.kind}`)
  }
  console.log('both sides confirmed; the session is authenticated')

  session.send({ kind: 'sync.request', operations: offered })
  console.log(`offered ${offered.length} operations`)

  const answer = await session.receive()
  console.log(`the phone returned ${answer.operations?.length ?? 0} operations`)
  for (const received of answer.operations ?? []) {
    console.log(`  ${received.type}  lamport=${received.lamport}  device=${received.deviceId.slice(0, 8)}…`)
  }
  socket.end()
})

socket.on('error', (cause) => {
  console.error(`could not talk to the phone: ${cause.message}`)
  process.exit(1)
})
