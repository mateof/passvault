import type { BarcodeBox } from './barcode.js'
import type { ImageSize } from './image.js'
import type { InkMap, PageRegion } from './rasterizer.js'

/**
 * Cutting a sheet that carries several passes into one region per pass.
 *
 * A page with two barcodes is two tickets, and until now both tickets carried the whole
 * sheet as their document — so the holder of the second seat opened their ticket and found
 * the first holder's code printed beside it. In an application whose point is that a code
 * reaches one person at one moment, that is the wrong default.
 *
 * The cut is a guillotine: find a straight line that separates the codes without crossing
 * any of them, take it, and repeat on each half. It handles the layouts vendors actually
 * print — two side by side, two stacked, a four-up grid of season passes — and it keeps the
 * text around each code, which a tight box around the symbol would throw away along with
 * the row and seat number.
 *
 * Where exactly inside the gap to cut is a second question, and the obvious answer is wrong.
 * Halfway between two barcodes sounds neutral until you notice that vendors print the code
 * at the *top* of each pass: the midpoint then lands inside the first pass and takes its
 * footer off. So when an ink map is available the line goes down the widest genuinely blank
 * band in the gap — the gutter between the two printed blocks — and falls back to the
 * midpoint only when there is no such band.
 *
 * When no straight line separates them the answer is `undefined`, not a guess. Overlapping
 * or interleaved codes are rare, and cutting one of them in half would be worse than
 * admitting the sheet cannot be divided.
 */

/** A barcode's bounds as fractions of the page, origin at the top left. */
export interface SheetBox {
  left: number
  top: number
  right: number
  bottom: number
}

type Axis = 'x' | 'y'

interface Cut {
  axis: Axis
  /** The empty band between the two groups, as fractions of the page along `axis`. */
  from: number
  to: number
  before: number[]
  after: number[]
}

function width(cut: Cut): number {
  return cut.to - cut.from
}

export function normalizeBox(box: BarcodeBox, size: ImageSize): SheetBox {
  return {
    left: box.left / size.width,
    top: box.top / size.height,
    right: box.right / size.width,
    bottom: box.bottom / size.height,
  }
}

/**
 * The widest empty band between the boxes along one axis.
 *
 * Sorting by the leading edge and tracking how far the boxes seen so far reach is what makes
 * this a separating line rather than a midpoint between two neighbours: a gap only counts
 * when every box before it ends before it starts.
 */
function widestGap(indices: number[], boxes: SheetBox[], axis: Axis): Cut | undefined {
  const low = (index: number): number => (axis === 'x' ? boxes[index]!.left : boxes[index]!.top)
  const high = (index: number): number =>
    axis === 'x' ? boxes[index]!.right : boxes[index]!.bottom

  const sorted = [...indices].sort((left, right) => low(left) - low(right))
  let best: Cut | undefined
  let reach = high(sorted[0]!)
  for (let position = 1; position < sorted.length; position += 1) {
    const starts = low(sorted[position]!)
    if (starts > reach && (best === undefined || starts - reach > width(best))) {
      best = {
        axis,
        from: reach,
        to: starts,
        before: sorted.slice(0, position),
        after: sorted.slice(position),
      }
    }
    reach = Math.max(reach, high(sorted[position]!))
  }
  return best
}

function widerOf(first: Cut | undefined, second: Cut | undefined): Cut | undefined {
  if (!first) return second
  if (!second) return first
  return width(first) >= width(second) ? first : second
}

/**
 * The middle of the widest blank band inside the gap, or the middle of the gap when the page
 * has nothing to say — no ink map, or ink everywhere between the codes.
 *
 * Blankness is judged only across `bounds`, not across the whole page. On a four-up sheet the
 * column between the left and right passes of the top row is not blank further down, where
 * the bottom row is printed, and measuring the whole page would find no gutter at all.
 */
function cutPoint(cut: Cut, bounds: PageRegion, ink: InkMap | undefined): number {
  const middle = cut.from + width(cut) / 2
  if (!ink || ink.width === 0 || ink.height === 0) {
    return middle
  }

  const along = cut.axis === 'x' ? ink.width : ink.height
  const across = cut.axis === 'x' ? ink.height : ink.width
  const acrossFrom = cut.axis === 'x' ? bounds.top : bounds.left
  const acrossTo = cut.axis === 'x' ? bounds.top + bounds.height : bounds.left + bounds.width

  const first = Math.max(0, Math.ceil(cut.from * along))
  const last = Math.min(along, Math.floor(cut.to * along))
  const crossFirst = Math.max(0, Math.floor(acrossFrom * across))
  const crossLast = Math.min(across, Math.ceil(acrossTo * across))

  const blank = (line: number): boolean => {
    for (let cross = crossFirst; cross < crossLast; cross += 1) {
      const at = cut.axis === 'x' ? cross * ink.width + line : line * ink.width + cross
      if (ink.ink[at]) {
        return false
      }
    }
    return true
  }

  let bestFrom = -1
  let bestTo = -1
  let runFrom = -1
  for (let line = first; line <= last; line += 1) {
    if (line < last && blank(line)) {
      if (runFrom < 0) {
        runFrom = line
      }
      continue
    }
    if (runFrom >= 0 && line - runFrom > bestTo - bestFrom) {
      bestFrom = runFrom
      bestTo = line
    }
    runFrom = -1
  }
  return bestFrom < 0 ? middle : (bestFrom + bestTo) / 2 / along
}

function halves(bounds: PageRegion, cut: Cut, ink: InkMap | undefined): [PageRegion, PageRegion] {
  const point = cutPoint(cut, bounds, ink)
  if (cut.axis === 'x') {
    const at = Math.min(Math.max(point, bounds.left), bounds.left + bounds.width)
    return [
      { ...bounds, width: at - bounds.left },
      { ...bounds, left: at, width: bounds.left + bounds.width - at },
    ]
  }
  const at = Math.min(Math.max(point, bounds.top), bounds.top + bounds.height)
  return [
    { ...bounds, height: at - bounds.top },
    { ...bounds, top: at, height: bounds.top + bounds.height - at },
  ]
}

const WHOLE_PAGE: PageRegion = { left: 0, top: 0, width: 1, height: 1 }

/** Paper left around a trimmed region, as a fraction of the page. */
const MARGIN = 0.012

/**
 * Shrinks a region to what is printed inside it.
 *
 * A sheet of two passes on A4 usually leaves the bottom third empty, and the guillotine hands
 * that emptiness to whichever pass sits last — a ticket that is two thirds blank paper on a
 * phone screen. This pulls each region in to its own printing.
 *
 * It only ever shrinks, and never past the barcode: a trim that cropped the code out would
 * turn a ticket into a picture of a ticket.
 */
function tighten(region: PageRegion, box: SheetBox, ink: InkMap): PageRegion {
  const firstColumn = Math.max(0, Math.floor(region.left * ink.width))
  const lastColumn = Math.min(ink.width, Math.ceil((region.left + region.width) * ink.width))
  const firstRow = Math.max(0, Math.floor(region.top * ink.height))
  const lastRow = Math.min(ink.height, Math.ceil((region.top + region.height) * ink.height))

  let left = ink.width
  let right = -1
  let top = ink.height
  let bottom = -1
  for (let row = firstRow; row < lastRow; row += 1) {
    for (let column = firstColumn; column < lastColumn; column += 1) {
      if (!ink.ink[row * ink.width + column]) {
        continue
      }
      if (column < left) left = column
      if (column > right) right = column
      if (row < top) top = row
      if (row > bottom) bottom = row
    }
  }
  if (right < 0 || bottom < 0) {
    return region
  }

  // The printing, then the barcode, then a margin — and never outside the region it came from.
  const wanted = {
    left: Math.min(left / ink.width, box.left) - MARGIN,
    top: Math.min(top / ink.height, box.top) - MARGIN,
    right: Math.max((right + 1) / ink.width, box.right) + MARGIN,
    bottom: Math.max((bottom + 1) / ink.height, box.bottom) + MARGIN,
  }
  const trimmed = {
    left: Math.max(region.left, wanted.left),
    top: Math.max(region.top, wanted.top),
    right: Math.min(region.left + region.width, wanted.right),
    bottom: Math.min(region.top + region.height, wanted.bottom),
  }
  return {
    left: trimmed.left,
    top: trimmed.top,
    width: trimmed.right - trimmed.left,
    height: trimmed.bottom - trimmed.top,
  }
}

/**
 * One region per box, each holding exactly its own barcode, or `undefined` if the boxes
 * cannot be separated by straight cuts. Regions come back in the order the boxes were given.
 *
 * `ink` is optional and only moves the line within a gap that was already safe, so leaving it
 * out changes where the cut lands, never whether the result is correct.
 */
export function cutIntoRegions(boxes: SheetBox[], ink?: InkMap): PageRegion[] | undefined {
  if (boxes.length === 0) {
    return undefined
  }
  const regions = new Array<PageRegion | undefined>(boxes.length)

  const divide = (indices: number[], bounds: PageRegion): boolean => {
    const first = indices[0]
    if (indices.length === 1 && first !== undefined) {
      regions[first] = bounds
      return true
    }
    const chosen = widerOf(widestGap(indices, boxes, 'x'), widestGap(indices, boxes, 'y'))
    if (!chosen) {
      return false
    }
    const [left, right] = halves(bounds, chosen, ink)
    return divide(chosen.before, left) && divide(chosen.after, right)
  }

  if (
    !divide(
      boxes.map((_, index) => index),
      WHOLE_PAGE,
    )
  ) {
    return undefined
  }
  if (!regions.every((region) => region !== undefined)) {
    return undefined
  }
  const divided = regions as PageRegion[]
  return ink ? divided.map((region, index) => tighten(region, boxes[index]!, ink)) : divided
}
