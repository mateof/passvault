import type { PaymentVisibility, TkpakBundle, TkpakTicket } from './types.js'

export interface ViewerRole {
  /** True for the person who created the event. */
  isCreator: boolean
  /** True when the viewer is the holder of the ticket being considered. */
  isHolder: boolean
}

/**
 * The single definition of who may see a payment record.
 *
 * Kept as a predicate over roles rather than over rows so that the `.tkpak` writer
 * and the server API can share the rule without sharing their types. The rule
 * existing in one place is the point: two copies would eventually disagree, and the
 * failure mode is disclosing what somebody asked to keep private.
 */
export function canSeePayment(visibility: PaymentVisibility, viewer: ViewerRole): boolean {
  switch (visibility) {
    case 'ALL':
      return true
    case 'HOLDER_ONLY':
      return viewer.isHolder || viewer.isCreator
    case 'CREATOR_ONLY':
      return viewer.isCreator
  }
}

export interface ExportViewer {
  isCreator: boolean
  /** User id of the recipient, when they have an account. */
  userId?: string | null
  /** Holder label of the recipient, for exports to people without an account. */
  holderLabel?: string
}

function viewerHolds(ticket: TkpakTicket, viewer: ExportViewer): boolean {
  if (viewer.userId && ticket.assignment.holderUserId) {
    return ticket.assignment.holderUserId === viewer.userId
  }
  if (viewer.holderLabel && ticket.assignment.holderLabel) {
    return ticket.assignment.holderLabel === viewer.holderLabel
  }
  return false
}

/**
 * Strips payment records the recipient is not entitled to see, before the bundle is
 * encrypted.
 *
 * Filtering at export rather than at display is deliberate: once the record is inside
 * the file, the recipient has it whatever the reader chooses to render.
 */
export function applyPaymentVisibility(bundle: TkpakBundle, viewer: ExportViewer): TkpakBundle {
  return {
    ...bundle,
    tickets: bundle.tickets.map((ticket) => {
      if (!ticket.payment) {
        return ticket
      }
      const visible = canSeePayment(ticket.payment.visibility, {
        isCreator: viewer.isCreator,
        isHolder: viewerHolds(ticket, viewer),
      })
      if (visible) {
        return ticket
      }
      const { payment: _omitted, ...withoutPayment } = ticket
      return withoutPayment
    }),
  }
}
