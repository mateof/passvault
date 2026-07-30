import { describe, expect, it } from 'vitest'
import { applyPaymentVisibility, canSeePayment, openWithPassword, writeTkpak } from '@passvault/tkpak'
import { ARGON2, EVENT_PASSWORD, aBundle, anIssuer } from './fixtures.js'

describe('who may see a payment record', () => {
  it('shows an ALL record to anyone', () => {
    expect(canSeePayment('ALL', { isCreator: false, isHolder: false })).toBe(true)
  })

  it('shows a HOLDER_ONLY record to its holder', () => {
    expect(canSeePayment('HOLDER_ONLY', { isCreator: false, isHolder: true })).toBe(true)
  })

  it('hides a HOLDER_ONLY record from other members', () => {
    expect(canSeePayment('HOLDER_ONLY', { isCreator: false, isHolder: false })).toBe(false)
  })

  it('shows a HOLDER_ONLY record to the organiser, who recorded it', () => {
    expect(canSeePayment('HOLDER_ONLY', { isCreator: true, isHolder: false })).toBe(true)
  })

  it('hides a CREATOR_ONLY record even from the person it concerns', () => {
    expect(canSeePayment('CREATOR_ONLY', { isCreator: false, isHolder: true })).toBe(false)
  })

  it('shows a CREATOR_ONLY record to the organiser', () => {
    expect(canSeePayment('CREATOR_ONLY', { isCreator: true, isHolder: false })).toBe(true)
  })
})

describe('filtering a bundle before export', () => {
  const bundle = { ...aBundle(), fileId: 'test-file' }

  it("keeps the recipient's own HOLDER_ONLY record", () => {
    const filtered = applyPaymentVisibility(bundle, { isCreator: false, holderLabel: 'Brais' })

    expect(filtered.tickets[1]?.payment?.state).toBe('UNPAID')
  })

  it("removes another person's HOLDER_ONLY record", () => {
    const filtered = applyPaymentVisibility(bundle, { isCreator: false, holderLabel: 'Ana' })

    expect(filtered.tickets[1]?.payment).toBeUndefined()
  })

  it('keeps records marked visible to everyone', () => {
    const filtered = applyPaymentVisibility(bundle, { isCreator: false, holderLabel: 'Brais' })

    expect(filtered.tickets[0]?.payment?.state).toBe('PAID')
  })

  it('keeps every record for the organiser, for their own backup', () => {
    const filtered = applyPaymentVisibility(bundle, { isCreator: true })

    expect(filtered.tickets.filter((ticket) => ticket.payment).length).toBe(2)
  })

  it('leaves tickets without a payment record untouched', () => {
    const filtered = applyPaymentVisibility(bundle, { isCreator: false, holderLabel: 'Ana' })

    expect(filtered.tickets[2]).toEqual(bundle.tickets[2])
  })
})

describe('a private amount that was filtered out', () => {
  it('is absent from the encrypted payload, not merely hidden by the reader', async () => {
    const bundle = aBundle()
    bundle.tickets[1]!.payment = {
      state: 'UNPAID',
      amountCents: 9999,
      currency: 'EUR',
      visibility: 'CREATOR_ONLY',
    }

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: applyPaymentVisibility({ ...bundle, fileId: 'unused' }, {
        isCreator: false,
        holderLabel: 'Ana',
      }),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })
    const opened = await openWithPassword(archive, EVENT_PASSWORD)

    expect(JSON.stringify(opened.bundle)).not.toContain('9999')
  })
})
