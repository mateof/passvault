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
  close: () => Promise<void>
}

export interface PageRasterizer {
  open: (pdf: Uint8Array) => Promise<RasterizedDocument>
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

      return {
        pageCount: document.numPages,
        async renderPage(pageNumber, widthPx = INGEST_LIMITS.renderWidth) {
          const page = await document.getPage(pageNumber)
          const unscaled = page.getViewport({ scale: 1 })
          const viewport = page.getViewport({
            scale: Math.min(widthPx, INGEST_LIMITS.renderWidth) / unscaled.width,
          })
          // The canvas comes from pdf.js's own factory. Creating one directly with
          // @napi-rs/canvas and passing it in looks equivalent and crashes the process.
          const { canvas, context } = (document.canvasFactory as unknown as CanvasFactory).create(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
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
          return new Uint8Array(canvas.toBuffer('image/png'))
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
