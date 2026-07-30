import { describe, expect, it } from 'vitest'
import {
  SLOT_CREATOR,
  SLOT_RECOVERY_CODE,
  SLOT_VAULT_PASSPHRASE,
  TEST_ARGON2_PARAMS,
  addKeySlot,
  addPasswordSlot,
  createDataKey,
  emptyEnvelope,
  generateRecoveryCode,
  hasSlot,
  openSealedEnvelope,
  randomKey,
  removeSlot,
  resealEnvelope,
  sealEnvelope,
  unlockWithKey,
  unlockWithPassword,
  type KeyEnvelope,
} from '@passvault/crypto'

const PASSPHRASE = 'correo cabalo batería grampa'

async function envelopeWithPassphrase(): Promise<{ envelope: KeyEnvelope; dataKey: Uint8Array }> {
  const dataKey = createDataKey()
  const envelope = await addPasswordSlot(
    emptyEnvelope(),
    SLOT_VAULT_PASSPHRASE,
    dataKey,
    PASSPHRASE,
    TEST_ARGON2_PARAMS,
  )
  expect(hasSlot(envelope, SLOT_VAULT_PASSPHRASE)).toBe(true)
  return { envelope, dataKey }
}

describe('key envelope slots', () => {
  it('returns the same data key that was wrapped', async () => {
    const { envelope, dataKey } = await envelopeWithPassphrase()

    const unlocked = await unlockWithPassword(envelope, SLOT_VAULT_PASSPHRASE, PASSPHRASE)

    expect(unlocked).toEqual(dataKey)
  })

  it('reports a wrong passphrase as WRONG_PASSWORD rather than as tampering', async () => {
    const { envelope } = await envelopeWithPassphrase()

    const attempt = unlockWithPassword(envelope, SLOT_VAULT_PASSPHRASE, 'not the passphrase')

    await expect(attempt).rejects.toThrowError(expect.objectContaining({ code: 'WRONG_PASSWORD' }))
  })

  it('accepts a passphrase typed in a different Unicode normalisation form', async () => {
    const { envelope, dataKey } = await envelopeWithPassphrase()
    const decomposed = PASSPHRASE.normalize('NFD')
    expect(decomposed).not.toBe(PASSPHRASE)

    const unlocked = await unlockWithPassword(envelope, SLOT_VAULT_PASSPHRASE, decomposed)

    expect(unlocked).toEqual(dataKey)
  })

  it('opens the same data key through a recovery code slot', async () => {
    const { envelope, dataKey } = await envelopeWithPassphrase()
    const recoveryCode = generateRecoveryCode()
    const withRecovery = await addPasswordSlot(
      envelope,
      SLOT_RECOVERY_CODE,
      dataKey,
      recoveryCode,
      TEST_ARGON2_PARAMS,
    )

    const unlocked = await unlockWithPassword(withRecovery, SLOT_RECOVERY_CODE, recoveryCode)

    expect(unlocked).toEqual(dataKey)
  })

  it('opens a raw-key slot with the key it was wrapped under', async () => {
    const { envelope, dataKey } = await envelopeWithPassphrase()
    const creatorKey = randomKey()
    const withCreator = addKeySlot(envelope, SLOT_CREATOR, dataKey, creatorKey)

    expect(unlockWithKey(withCreator, SLOT_CREATOR, creatorKey)).toEqual(dataKey)
  })

  it('refuses to open a password slot with a raw key', async () => {
    const { envelope } = await envelopeWithPassphrase()

    const attempt = () => unlockWithKey(envelope, SLOT_VAULT_PASSPHRASE, randomKey())

    expect(attempt).toThrowError(expect.objectContaining({ code: 'MALFORMED_INPUT' }))
  })

  it('cannot open a slot that was removed', async () => {
    const { envelope } = await envelopeWithPassphrase()

    const stripped = removeSlot(envelope, SLOT_VAULT_PASSPHRASE)

    await expect(
      unlockWithPassword(stripped, SLOT_VAULT_PASSPHRASE, PASSPHRASE),
    ).rejects.toThrowError(/no slot/)
  })

  it('leaves the original envelope untouched when adding a slot', async () => {
    const { envelope, dataKey } = await envelopeWithPassphrase()

    addKeySlot(envelope, SLOT_CREATOR, dataKey, randomKey())

    expect(hasSlot(envelope, SLOT_CREATOR)).toBe(false)
  })
})

describe('the server layer around the envelope', () => {
  it('recovers the envelope with the master key it was sealed under', async () => {
    const { envelope } = await envelopeWithPassphrase()
    const masterKey = randomKey()

    const reopened = openSealedEnvelope(sealEnvelope(envelope, masterKey), masterKey)

    expect(reopened).toEqual(envelope)
  })

  it('yields nothing to an attacker holding the database alone', async () => {
    const { envelope } = await envelopeWithPassphrase()
    const sealed = sealEnvelope(envelope, randomKey())

    const attempt = () => openSealedEnvelope(sealed, randomKey())

    expect(attempt).toThrowError(expect.objectContaining({ code: 'WRONG_KEY' }))
  })

  it('yields nothing to an attacker holding the database and the master key', async () => {
    const { envelope } = await envelopeWithPassphrase()
    const masterKey = randomKey()

    const reopened = openSealedEnvelope(sealEnvelope(envelope, masterKey), masterKey)
    const attempt = unlockWithPassword(reopened, SLOT_VAULT_PASSPHRASE, 'guessed passphrase')

    await expect(attempt).rejects.toThrowError(expect.objectContaining({ code: 'WRONG_PASSWORD' }))
  })

  it('rotates the master key without needing the vault passphrase', async () => {
    const { envelope, dataKey } = await envelopeWithPassphrase()
    const oldMaster = randomKey()
    const newMaster = randomKey()
    const sealed = sealEnvelope(envelope, oldMaster)

    const rotated = resealEnvelope(sealed, oldMaster, newMaster)

    const unlocked = await unlockWithPassword(
      openSealedEnvelope(rotated, newMaster),
      SLOT_VAULT_PASSPHRASE,
      PASSPHRASE,
    )
    expect(unlocked).toEqual(dataKey)
  })

  it('stops accepting the previous master key after rotation', async () => {
    const { envelope } = await envelopeWithPassphrase()
    const oldMaster = randomKey()
    const newMaster = randomKey()

    const rotated = resealEnvelope(sealEnvelope(envelope, oldMaster), oldMaster, newMaster)

    expect(() => openSealedEnvelope(rotated, oldMaster)).toThrowError(
      expect.objectContaining({ code: 'WRONG_KEY' }),
    )
  })
})
