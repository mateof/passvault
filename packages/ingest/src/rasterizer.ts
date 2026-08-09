import { createRequire } from 'node:module'
import { IngestError } from './errors.js'
import { INGEST_LIMITS } from './limits.js'

/**
 * Turning PDF pages into images, which is what a barcode decoder needs.
 *
 * Behind an interface for two reasons. The real implementation needs pdf.js and a native
 * canvas, which are optional dependencies — an installation that only handles `.pkpass`
 * files and photographs should not require them. And the Android app rasterises with the
 * platform's own `PdfRenderer`, so the surrounding logic has to be independent of how the
 * pixels are produced.
 *
 * The shape is open-once-render-many rather than a single `render(pdf, page)` call, which
 * was the first design and was wrong twice over. It reparsed the whole document per page,
 * and — the part that actually broke — pdf.js *transfers* the input buffer to its worker,
 * detaching it. The second call received an empty buffer and failed with a clone error a
 * long way from the cause.
 */
export interface RasterizedDocument {
  pageCount: number
  /** Renders one page, 1-based, as PNG bytes. */
  renderPage: (pageNumber: number, widthPx?: number) => Promise<Uint8Array>
  /**
   * Renders part of a page, so a sheet holding several passes can be cut into one image per
   * ticket. `widthPx` is the width of the returned image, not of the whole page.
   *
   * Optional: a rasterizer that cannot clip simply omits it, and ingestion falls back to
   * giving every ticket on the sheet the whole sheet — with a warning saying so, since that
   * puts each holder's code in front of the others.
   */
  renderRegion?: (pageNumber: number, region: PageRegion, widthPx?: number) => Promise<Uint8Array>
  /**
   * A coarse map of where the page has something drawn on it.
   *
   * Cutting a shared sheet halfway between two barcodes puts the line wherever the arithmetic
   * lands, and vendors print the code at the top of each pass — so the midpoint falls inside
   * the first pass and saws its footer off. This says where the paper is actually blank, so
   * the cut can go in the gutter between the two printed blocks instead.
   *
   * Optional, like `renderRegion`: without it the cut falls back to the midpoint, which is
   * safe but ugly.
   */
  inkMap?: (pageNumber: number) => Promise<InkMap>
  close: () => Promise<void>
}

/**
 * Which cells of a low-resolution render have anything on them.
 *
 * Row-major, one byte per cell, `1` where something is drawn. Coarse on purpose: this looks
 * for the white band between two printed passes, not for detail.
 */
export interface InkMap {
  width: number
  height: number
  ink: Uint8Array
}

export interface PageRasterizer {
  open: (pdf: Uint8Array) => Promise<RasterizedDocument>
}

/**
 * A rectangle on a page, as fractions of the page box with the origin at the top left.
 *
 * Fractions rather than points, because the caller works from barcode positions measured in
 * the pixels of a render whose scale it never chose.
 */
export interface PageRegion {
  left: number
  top: number
  width: number
  height: number
}

const WHOLE_PAGE: PageRegion = { left: 0, top: 0, width: 1, height: 1 }

/** Below this a crop stops being legible, whatever fraction of the sheet it covers. */
const MINIMUM_CROP_WIDTH = 320

/** Lighter than this in every channel is paper, not print. */
const INK_THRESHOLD = 248

/** A region from outside cannot be trusted to lie on the page, and a canvas of zero throws. */
function clampRegion(region: PageRegion): PageRegion {
  // Short of 1, so that what is left of the page is never zero wide.
  const left = Math.min(Math.max(region.left, 0), 0.99)
  const top = Math.min(Math.max(region.top, 0), 0.99)
  return {
    left,
    top,
    width: Math.min(Math.max(region.width, 0.01), 1 - left),
    height: Math.min(Math.max(region.height, 0.01), 1 - top),
  }
}

interface NodeCanvas {
  width: number
  height: number
  toBuffer: (mime: 'image/png') => Buffer
}

interface CanvasFactory {
  create: (
    width: number,
    height: number,
  ) => { canvas: NodeCanvas; context: CanvasRenderingContext2D }
}

export async function createPdfJsRasterizer(): Promise<PageRasterizer> {
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  let standardFontDataUrl: string
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const require = createRequire(import.meta.url)
    // Real ticket PDFs use the standard fonts, and pdf.js needs the font data to render a page
    // that references one. A filesystem path, not a `file://` URL: under Node the legacy build
    // reads this with `fs`, and Node's `fetch` refuses file URLs outright — so the URL form
    // failed for every standard font and rendered their text as empty boxes. Nothing is
    // fetched either way, which is the property that matters: this has to work on a plane.
    const marker = require.resolve('pdfjs-dist/package.json')
    standardFontDataUrl = `${marker.slice(0, marker.length - 'package.json'.length)}standard_fonts/`
  } catch (cause) {
    throw new IngestError(
      'RASTERIZER_UNAVAILABLE',
      'rendering PDF pages needs the optional packages: npm install pdfjs-dist @napi-rs/canvas',
      { cause },
    )
  }

  return {
    async open(pdf) {
      // A copy, because pdf.js transfers ownership of the buffer to its worker. Without it
      // the caller's bytes are detached and every later use of them — splitting the same
      // document, storing it — reads zero length.
      const data = Uint8Array.from(pdf)
      // A PDF is untrusted input: no font faces, no system fonts, and no URL configured for
      // anything else pdf.js might otherwise fetch.
      const loading = pdfjs.getDocument({
        data,
        disableFontFace: true,
        useSystemFonts: false,
        standardFontDataUrl,
      })
      let document: Awaited<typeof loading.promise>
      try {
        document = await loading.promise
      } catch (cause) {
        await loading.destroy()
        throw new IngestError('DAMAGED_FILE', 'pdf.js could not open the document', { cause })
      }

      /**
       * Paints a region of a page onto a canvas of that region's size.
       *
       * The whole-page render is the same operation with the region set to the whole page,
       * which is why there is one implementation rather than two that drift apart.
       */
      const paint = async (
        pageNumber: number,
        widthPx: number,
        region: PageRegion,
      ): Promise<{ canvas: NodeCanvas; context: CanvasRenderingContext2D }> => {
        const page = await document.getPage(pageNumber)
        const unscaled = page.getViewport({ scale: 1 })
        const scale = widthPx / (unscaled.width * region.width)
        const viewport = page.getViewport({
          scale,
          // Shifts the page under a canvas cut to the region. Without the offsets this
          // would be the whole page squeezed into the crop's dimensions.
          offsetX: -region.left * unscaled.width * scale,
          offsetY: -region.top * unscaled.height * scale,
        })
        // The canvas comes from pdf.js's own factory. Creating one directly with
        // @napi-rs/canvas and passing it in looks equivalent and crashes the process.
        const { canvas, context } = (document.canvasFactory as unknown as CanvasFactory).create(
          Math.ceil(unscaled.width * region.width * scale),
          Math.ceil(unscaled.height * region.height * scale),
        )
        // White first: a transparent background flattens to black, and a barcode on black
        // does not decode.
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context,
          viewport,
        }).promise
        page.cleanup()
        return { canvas, context }
      }

      const png = async (
        pageNumber: number,
        widthPx: number,
        region: PageRegion,
      ): Promise<Uint8Array> => {
        const { canvas } = await paint(pageNumber, widthPx, region)
        return new Uint8Array(canvas.toBuffer('image/png'))
      }

      return {
        pageCount: document.numPages,
        renderPage: async (pageNumber, widthPx = INGEST_LIMITS.renderWidth) =>
          png(pageNumber, Math.min(widthPx, INGEST_LIMITS.renderWidth), WHOLE_PAGE),
        renderRegion: async (pageNumber, region, widthPx) => {
          const clamped = clampRegion(region)
          const target = Math.min(
            widthPx ?? INGEST_LIMITS.cropRenderWidth * clamped.width,
            INGEST_LIMITS.cropRenderWidth,
          )
          // A region can be a narrow strip, and a strip asked for at one pixel wide is not
          // a document anybody can read.
          return png(pageNumber, Math.max(target, MINIMUM_CROP_WIDTH), clamped)
        },
        inkMap: async (pageNumber) => {
          const { canvas, context } = await paint(pageNumber, INGEST_LIMITS.inkMapWidth, WHOLE_PAGE)
          const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
          const ink = new Uint8Array(width * height)
          for (let pixel = 0; pixel < ink.length; pixel += 1) {
            const at = pixel * 4
            // Near-white counts as blank. The background was filled white before rendering,
            // so anything the page drew — including the palest tint of a ticket's card — is
            // darker than this in at least one channel.
            if (
              data[at]! < INK_THRESHOLD ||
              data[at + 1]! < INK_THRESHOLD ||
              data[at + 2]! < INK_THRESHOLD
            ) {
              ink[pixel] = 1
            }
          }
          return { width, height, ink }
        },
        close: async () => {
          // The loading task owns the worker, so destroying the document proxy is not
          // enough; one leaked worker per document adds up quickly on a server.
          await loading.destroy()
        },
      }
    },
  }
}
