import { describe, expect, it } from 'vitest'
import { detectMediaType, isSupported } from '@passvault/ingest'
import { barcodePng, pkpass, plainZip, ticketPdf } from './fixtures.js'

describe('identifying a file by its content', () => {
  it('recognises a PDF', async () => {
    expect(detectMediaType(await ticketPdf([{ codes: [{ text: 'A' }] }]))).toBe('application/pdf')
  })

  it('recognises a PNG', async () => {
    expect(detectMediaType(await barcodePng('A'))).toBe('image/png')
  })

  it('recognises a JPEG by its marker', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

    expect(detectMediaType(jpeg)).toBe('image/jpeg')
  })

  it('recognises an Apple Wallet pass, which is a ZIP holding a pass.json', () => {
    expect(detectMediaType(pkpass())).toBe('application/vnd.apple.pkpass')
  })

  it('rejects a ZIP that is not a pass, rather than accepting any archive', () => {
    expect(() => detectMediaType(plainZip())).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE' }),
    )
  })

  it('rejects a file it does not know', () => {
    expect(() => detectMediaType(new Uint8Array(Buffer.from('hello', 'utf8')))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE' }),
    )
  })

  it('rejects an empty file without reading past its end', () => {
    expect(() => detectMediaType(new Uint8Array())).toThrow()
  })

  it('answers without throwing when asked only whether a file is supported', () => {
    expect(isSupported(new Uint8Array(Buffer.from('hello', 'utf8')))).toBe(false)
  })
})
