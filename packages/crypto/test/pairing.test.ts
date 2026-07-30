import { describe, expect, it } from 'vitest'
import {
  SAS_DIGITS,
  completePairing,
  generateAgreementKeyPair,
  type PairingResult,
} from '@passvault/crypto'

/**
 * Two phones meeting on a local network. `pairTwoDevices` is the honest case;
 * `pairThroughAttacker` is a device sitting between them, agreeing separately with
 * each side — which is exactly what mDNS discovery cannot rule out.
 */
function pairTwoDevices(): { initiator: PairingResult; responder: PairingResult } {
  const ana = generateAgreementKeyPair()
  const brais = generateAgreementKeyPair()
  return {
    initiator: completePairing({
      ownPrivateKey: ana.privateKey,
      ownPublicKey: ana.publicKey,
      peerPublicKey: brais.publicKey,
      isInitiator: true,
    }),
    responder: completePairing({
      ownPrivateKey: brais.privateKey,
      ownPublicKey: brais.publicKey,
      peerPublicKey: ana.publicKey,
      isInitiator: false,
    }),
  }
}

function pairThroughAttacker(): { initiator: PairingResult; responder: PairingResult } {
  const ana = generateAgreementKeyPair()
  const brais = generateAgreementKeyPair()
  const attacker = generateAgreementKeyPair()
  return {
    // Ana believes she is talking to Brais but agrees with the attacker.
    initiator: completePairing({
      ownPrivateKey: ana.privateKey,
      ownPublicKey: ana.publicKey,
      peerPublicKey: attacker.publicKey,
      isInitiator: true,
    }),
    // Brais likewise.
    responder: completePairing({
      ownPrivateKey: brais.privateKey,
      ownPublicKey: brais.publicKey,
      peerPublicKey: attacker.publicKey,
      isInitiator: false,
    }),
  }
}

describe('local network pairing', () => {
  it('derives the same session key on both devices', () => {
    const { initiator, responder } = pairTwoDevices()

    expect(initiator.sessionKey).toEqual(responder.sessionKey)
  })

  it('shows the same digits on both screens', () => {
    const { initiator, responder } = pairTwoDevices()

    expect(initiator.shortAuthenticationString).toBe(responder.shortAuthenticationString)
  })

  it('shows six digits, zero-padded, so a leading zero is never dropped', () => {
    const { initiator } = pairTwoDevices()

    expect(initiator.shortAuthenticationString).toMatch(new RegExp(`^\\d{${SAS_DIGITS}}$`))
  })

  it('shows different digits on each screen when a device sits in the middle', () => {
    const { initiator, responder } = pairThroughAttacker()

    expect(initiator.shortAuthenticationString).not.toBe(responder.shortAuthenticationString)
  })

  it('gives the interposed device no way to reach the honest session key', () => {
    const { initiator, responder } = pairThroughAttacker()

    expect(initiator.sessionKey).not.toEqual(responder.sessionKey)
  })

  it('derives different digits for each pairing attempt, since the keys are ephemeral', () => {
    const first = pairTwoDevices().initiator.shortAuthenticationString
    const second = pairTwoDevices().initiator.shortAuthenticationString

    expect(first).not.toBe(second)
  })
})
