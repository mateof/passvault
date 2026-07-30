import { describe, expect, it } from 'vitest'
import { CryptoError, NONCE_BYTES, open, randomKey, randomNonce, seal } from '@passvault/crypto'

const plaintext = new Uint8Array(Buffer.from('8412-XXXX-1234', 'utf8'))
const aad = 'tkpak/v1/payload:test'

describe('AES-256-GCM sealing', () => {
  it('returns the original plaintext when opened with the same key, nonce and associated data', () => {
    const key = randomKey()
    const nonce = randomNonce()

    const ciphertext = seal({ key, nonce, plaintext, aad })

    expect(open({ key, nonce, ciphertext, aad })).toEqual(plaintext)
  })

  it('appends a 16-byte authentication tag to the ciphertext', () => {
    const ciphertext = seal({ key: randomKey(), nonce: randomNonce(), plaintext, aad })

    expect(ciphertext.length).toBe(plaintext.length + 16)
  })

  it('produces different ciphertext for the same plaintext under different nonces', () => {
    const key = randomKey()

    const first = seal({ key, nonce: randomNonce(), plaintext, aad })
    const second = seal({ key, nonce: randomNonce(), plaintext, aad })

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it('rejects a ciphertext whose associated data does not match', () => {
    const key = randomKey()
    const nonce = randomNonce()
    const ciphertext = seal({ key, nonce, plaintext, aad: 'tkpak/v1/payload:one' })

    expect(() => open({ key, nonce, ciphertext, aad: 'tkpak/v1/payload:two' })).toThrow(CryptoError)
  })

  it('rejects a ciphertext with a single flipped byte', () => {
    const key = randomKey()
    const nonce = randomNonce()
    const ciphertext = seal({ key, nonce, plaintext, aad })
    ciphertext[0] ^= 0x01

    expect(() => open({ key, nonce, ciphertext, aad })).toThrow(/authentication tag/)
  })

  it('reports the caller-supplied failure code so a wrong password is not read as tampering', () => {
    const nonce = randomNonce()
    const ciphertext = seal({ key: randomKey(), nonce, plaintext, aad })

    const attempt = () =>
      open({ key: randomKey(), nonce, ciphertext, aad, failureCode: 'WRONG_PASSWORD' })

    expect(attempt).toThrowError(expect.objectContaining({ code: 'WRONG_PASSWORD' }))
  })

  it('rejects a nonce of the wrong length rather than silently padding it', () => {
    const attempt = () =>
      seal({ key: randomKey(), nonce: new Uint8Array(NONCE_BYTES - 1), plaintext, aad })

    expect(attempt).toThrowError(expect.objectContaining({ code: 'MALFORMED_INPUT' }))
  })

  it('rejects a ciphertext shorter than the authentication tag', () => {
    const attempt = () =>
      open({ key: randomKey(), nonce: randomNonce(), ciphertext: new Uint8Array(8), aad })

    expect(attempt).toThrowError(expect.objectContaining({ code: 'MALFORMED_INPUT' }))
  })
})
