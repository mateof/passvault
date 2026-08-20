import { useEffect, useState } from 'react'
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer'
import wasmUrl from 'zxing-wasm/writer/zxing_writer.wasm?url'
import { useT } from './i18n'

/**
 * Drawing a ticket's code as the symbol a scanner reads.
 *
 * Until this existed the holder was shown the payload as text — `http://qr.example/NNSG…` — which
 * is the correct value and useless at a turnstile. A person standing at the door with this page
 * open could not get in.
 *
 * Drawn in the browser from the value the download returned, rather than fetched as an image from
 * the server. The server has no business rendering a barcode it went to such lengths not to hand
 * around, and a code that only ever exists as pixels in this tab is one that was never written to
 * a cache, a proxy or a log on the way here.
 *
 * ZXing again, the same library that reads them during ingestion, so what is drawn and what is
 * decoded cannot disagree. The WebAssembly is bundled and served from this origin: the library
 * would otherwise pull it from a CDN, which would make showing a ticket depend on the network at
 * exactly the moment — a queue, a basement venue, a festival field — when there is none.
 */

prepareZXingModule({ overrides: { locateFile: () => wasmUrl } })

/** This project's format names, as the writer spells them. */
const WRITER_FORMATS: Record<string, string> = {
  QR_CODE: 'QRCode',
  AZTEC: 'Aztec',
  PDF_417: 'PDF417',
  CODE_128: 'Code128',
  CODE_39: 'Code39',
  EAN_13: 'EAN13',
  DATA_MATRIX: 'DataMatrix',
}

type State = { kind: 'drawing' } | { kind: 'drawn'; svg: string } | { kind: 'failed' }

export function BarcodeSymbol({ value, format }: { value: string; format: string }) {
  const { t } = useT()
  const [state, setState] = useState<State>({ kind: 'drawing' })

  useEffect(() => {
    let live = true
    const written = WRITER_FORMATS[format]
    if (!written) {
      setState({ kind: 'failed' })
      return
    }
    setState({ kind: 'drawing' })
    // SVG rather than a bitmap: a turnstile scanner is held at whatever distance it is held at,
    // and a symbol that stays sharp when the page is zoomed is the difference between one scan
    // and four.
    writeBarcode(value, { format: written, scale: 8 })
      .then((result) => {
        if (!live) return
        setState(result.svg ? { kind: 'drawn', svg: result.svg } : { kind: 'failed' })
      })
      .catch(() => {
        if (live) setState({ kind: 'failed' })
      })
    return () => {
      live = false
    }
  }, [value, format])

  if (state.kind === 'failed') {
    // The value still gets through. A code this build cannot draw is one somebody can type into
    // whatever else reads it, which beats an empty box.
    return (
      <div className="barcode-symbol">
        <p className="muted">{t('tickets.symbolFailed')}</p>
        <p className="barcode">{value}</p>
      </div>
    )
  }

  return (
    <div className="barcode-symbol">
      {state.kind === 'drawing' ? (
        <p className="muted">{t('tickets.symbolDrawing')}</p>
      ) : (
        // From our own encoder, over a value this tab already holds. Nothing here came off the
        // network as markup.
        <div
          className="barcode-symbol-image"
          role="img"
          aria-label={t('tickets.symbolLabel', { value })}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      {/* Kept beside the symbol: a scanner that will not read the screen is a real event, and
          then somebody reads the value out loud. */}
      <p className="barcode">
        {value}
        <span className="muted"> ({format})</span>
      </p>
    </div>
  )
}
