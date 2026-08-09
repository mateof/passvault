import { describe, expect, it } from 'vitest'
import { cutIntoRegions, type InkMap, type SheetBox } from '@passvault/ingest'

/**
 * Where the line goes when a sheet holds several passes.
 *
 * The end-to-end tests prove the crops are *safe* — no ticket carries a neighbour's code.
 * These prove they are *right*: that the cut lands in the gutter between two printed blocks
 * rather than halfway between two barcodes, which on a real ticket is inside the first pass.
 */

const box = (left: number, top: number, right: number, bottom: number): SheetBox => ({
  left,
  top,
  right,
  bottom,
})

/**
 * An ink map built from rectangles, in page fractions. A cell counts as printed when its
 * centre falls inside one of them.
 */
function inkOf(
  rectangles: { left: number; top: number; right: number; bottom: number }[],
  width = 40,
  height = 60,
): InkMap {
  const ink = new Uint8Array(width * height)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = (column + 0.5) / width
      const y = (row + 0.5) / height
      const printed = rectangles.some(
        (rectangle) =>
          x >= rectangle.left &&
          x <= rectangle.right &&
          y >= rectangle.top &&
          y <= rectangle.bottom,
      )
      if (printed) {
        ink[row * width + column] = 1
      }
    }
  }
  return { width, height, ink }
}

describe('two passes stacked on one sheet, each with its code at the top', () => {
  // What a real ticket looks like: two cards, each 45% of the sheet tall, with the barcode
  // just inside the top edge. The gutter between the cards is at 0.48–0.52.
  const codes = [box(0.8, 0.06, 0.92, 0.14), box(0.8, 0.56, 0.92, 0.64)]
  const cards = [
    { left: 0.03, top: 0.03, right: 0.97, bottom: 0.47 },
    { left: 0.03, top: 0.53, right: 0.97, bottom: 0.97 },
  ]

  it('keeps the first pass whole, footer and all', () => {
    const regions = cutIntoRegions(codes, inkOf(cards))

    // The card ends at 0.47. A cut above that saws its footer off, which is exactly what the
    // midpoint between the two barcodes — 0.35 — used to do.
    expect((regions?.[0]?.top ?? 1) + (regions?.[0]?.height ?? 0)).toBeGreaterThan(0.47)
  })

  it('leaves nothing of the first pass in the second region', () => {
    const regions = cutIntoRegions(codes, inkOf(cards))

    expect(regions?.[1]?.top).toBeGreaterThan(0.47)
  })

  it('stops before the second card starts', () => {
    const regions = cutIntoRegions(codes, inkOf(cards))

    expect((regions?.[0]?.top ?? 1) + (regions?.[0]?.height ?? 0)).toBeLessThan(0.53)
  })

  it('trims the blank paper each card is sitting on', () => {
    const regions = cutIntoRegions(codes, inkOf(cards))

    // Each card is 0.44 of the sheet tall. Anything much over that is empty paper the holder
    // would be looking at on their phone.
    expect(regions?.[0]?.height).toBeLessThan(0.5)
    expect(regions?.[1]?.height).toBeLessThan(0.5)
  })

  it('falls back to the midpoint with no ink map, which is safe but cuts the card', () => {
    const regions = cutIntoRegions(codes)

    expect(regions?.[0]?.height).toBeCloseTo(0.35, 5)
  })
})

describe('four passes printed two by two', () => {
  const codes = [
    box(0.1, 0.05, 0.2, 0.12),
    box(0.6, 0.05, 0.7, 0.12),
    box(0.1, 0.55, 0.2, 0.62),
    box(0.6, 0.55, 0.7, 0.62),
  ]
  const cards = [
    { left: 0.02, top: 0.02, right: 0.47, bottom: 0.46 },
    { left: 0.53, top: 0.02, right: 0.98, bottom: 0.46 },
    { left: 0.02, top: 0.54, right: 0.47, bottom: 0.98 },
    { left: 0.53, top: 0.54, right: 0.98, bottom: 0.98 },
  ]

  it('gives every pass its own quarter', () => {
    const regions = cutIntoRegions(codes, inkOf(cards))

    expect(regions).toHaveLength(4)
    for (const region of regions ?? []) {
      expect(region.width).toBeGreaterThan(0.4)
      expect(region.height).toBeGreaterThan(0.4)
    }
  })

  it('finds the column gutter inside a row, where the whole page has ink', () => {
    // The band at x≈0.5 is blank across the top row but printed further down, where the
    // bottom row sits. Judging blankness over the whole page would find no gutter at all.
    const regions = cutIntoRegions(codes, inkOf(cards))

    expect((regions?.[0]?.left ?? 1) + (regions?.[0]?.width ?? 0)).toBeLessThan(0.53)
    expect(regions?.[1]?.left).toBeGreaterThan(0.47)
  })

  it('gives no region a piece of another pass', () => {
    const regions = cutIntoRegions(codes, inkOf(cards)) ?? []

    for (const [index, region] of regions.entries()) {
      for (const [other, code] of codes.entries()) {
        if (other === index) {
          continue
        }
        const overlaps =
          region.left < code.right &&
          region.left + region.width > code.left &&
          region.top < code.bottom &&
          region.top + region.height > code.top

        expect(overlaps).toBe(false)
      }
    }
  })
})

describe('a sheet the guillotine cannot divide', () => {
  it('gives up rather than slicing a code in half', () => {
    const overlapping = [box(0.1, 0.1, 0.6, 0.6), box(0.3, 0.3, 0.8, 0.8)]

    expect(cutIntoRegions(overlapping, inkOf([]))).toBeUndefined()
  })

  it('says nothing for an empty sheet', () => {
    expect(cutIntoRegions([])).toBeUndefined()
  })

  it('gives a single code the whole page', () => {
    expect(cutIntoRegions([box(0.4, 0.4, 0.6, 0.6)])).toEqual([
      { left: 0, top: 0, width: 1, height: 1 },
    ])
  })
})

describe('an ink map with nothing usable in it', () => {
  const codes = [box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.6, 0.2, 0.7)]

  it('uses the midpoint when the gap is printed edge to edge', () => {
    const solid = inkOf([{ left: 0, top: 0, right: 1, bottom: 1 }])

    expect(cutIntoRegions(codes, solid)?.[0]?.height).toBeCloseTo(0.4, 5)
  })

  it('uses the midpoint when the map is empty', () => {
    const empty: InkMap = { width: 0, height: 0, ink: new Uint8Array(0) }

    expect(cutIntoRegions(codes, empty)?.[0]?.height).toBeCloseTo(0.4, 5)
  })
})
