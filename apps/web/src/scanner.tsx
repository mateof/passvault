import { useCallback, useEffect, useRef, useState } from 'react'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { api, type CheckInResult } from './api/passvault'
import { ApiError } from './api/client'
import { useT } from './i18n'
import { Banner, Button, Card } from './ui'

/**
 * The door.
 *
 * A camera, a code, and a sentence about what to do — which is all a person standing at a gate
 * with a queue behind them can act on. The interesting answer is not "valid": it is *this one has
 * already been through, at 20:14*, said while the person holding it is still in front of you.
 *
 * The reader WebAssembly is a second, larger module than the writer the wallet uses, and it is
 * bundled rather than fetched from a CDN for the same reason: the door of a venue is the least
 * connected place this software runs. It is a separate asset, so nobody who never works a door
 * downloads a megabyte of decoder.
 */

prepareZXingModule({ overrides: { locateFile: () => wasmUrl } })

/** How often to look at the video. Fast enough to feel instant, slow enough not to cook a phone. */
const SCAN_INTERVAL_MS = 250

/**
 * How long a result stays on screen before the scanner starts looking again.
 *
 * Without a pause the same code is read twenty times a second and the count would climb while
 * somebody stood still holding their phone up.
 */
const HOLD_RESULT_MS = 2500

type Camera = 'starting' | 'running' | 'denied' | 'unsupported'

export function DoorScanner({ eventId, onChanged }: { eventId: string; onChanged: () => void }) {
  const { t, locale } = useT()
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const busy = useRef(false)
  const [camera, setCamera] = useState<Camera>('starting')
  const [result, setResult] = useState<CheckInResult>()
  const [failure, setFailure] = useState<string>()

  const present = useCallback(
    async (value: string) => {
      try {
        const outcome = await api.checkIn(locale, eventId, value)
        setResult(outcome)
        setFailure(undefined)
        onChanged()
      } catch (error) {
        setFailure(error instanceof ApiError ? error.message : t('checkin.failed'))
      }
    },
    [eventId, locale, onChanged, t],
  )

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      // An insecure origin, or a browser without a camera API. Saying which is not possible from
      // here, so the message offers the way round it instead: type the code.
      setCamera('unsupported')
      return
    }
    let stream: MediaStream | undefined
    let stopped = false

    navigator.mediaDevices
      // The back camera on a phone, which is the one pointed at somebody else's screen.
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((opened) => {
        if (stopped) {
          opened.getTracks().forEach((track) => track.stop())
          return
        }
        stream = opened
        if (video.current) {
          video.current.srcObject = opened
        }
        setCamera('running')
      })
      .catch(() => setCamera('denied'))

    return () => {
      stopped = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    if (camera !== 'running') {
      return
    }
    const timer = setInterval(async () => {
      // One read at a time. Frames arrive faster than the decoder finishes, and queueing them
      // would mean scanning a picture of where the phone used to be.
      if (busy.current) {
        return
      }
      const frame = video.current
      const surface = canvas.current
      if (!frame || !surface || frame.videoWidth === 0) {
        return
      }
      busy.current = true
      try {
        surface.width = frame.videoWidth
        surface.height = frame.videoHeight
        const context = surface.getContext('2d', { willReadFrequently: true })
        if (!context) {
          return
        }
        context.drawImage(frame, 0, 0)
        const image = context.getImageData(0, 0, surface.width, surface.height)
        const found = await readBarcodes(image, {
          formats: ['QRCode', 'Aztec', 'PDF417', 'Code128', 'Code39', 'DataMatrix'],
          tryHarder: false,
          tryRotate: true,
          maxNumberOfSymbols: 1,
        })
        const code = found.find((symbol) => symbol.isValid && symbol.text.length > 0)
        if (code) {
          await present(code.text)
          // Hold the answer up long enough to be read, and stop counting the same phone.
          await new Promise((wake) => setTimeout(wake, HOLD_RESULT_MS))
        }
      } catch {
        // A frame that would not decode is the normal state of a camera pointed at a queue.
      } finally {
        busy.current = false
      }
    }, SCAN_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [camera, present])

  return (
    <Card title={t('checkin.title')} icon="ticket">
      <p className="muted">{t('checkin.explain')}</p>

      {camera === 'denied' ? <Banner kind="warning">{t('checkin.cameraDenied')}</Banner> : null}
      {camera === 'unsupported' ? (
        <Banner kind="warning">{t('checkin.cameraUnsupported')}</Banner>
      ) : null}

      {camera === 'running' || camera === 'starting' ? (
        <div className="scanner">
          <video ref={video} className="scanner-view" autoPlay playsInline muted />
          <canvas ref={canvas} hidden />
        </div>
      ) : null}

      <ManualEntry onSubmit={present} />

      {failure ? <Banner kind="error">{failure}</Banner> : null}
      {result ? <Outcome result={result} /> : null}
    </Card>
  )
}

/**
 * What the door is told.
 *
 * Colour carries the answer before the words do, because at a gate nobody reads a sentence. The
 * repeat is the one that has to be unmistakable: it is the only outcome that needs a person to
 * do something.
 */
function Outcome({ result }: { result: CheckInResult }) {
  const { t, locale } = useT()
  const when = result.firstUsedAt
    ? new Date(result.firstUsedAt).toLocaleString(locale, {
        timeStyle: 'short',
        dateStyle: 'short',
      })
    : undefined

  if (result.outcome === 'ADMITTED') {
    return (
      <Banner kind="success">
        {t('checkin.admitted', { seat: result.label ?? result.holder ?? '' })}
      </Banner>
    )
  }
  if (result.outcome === 'ALREADY_USED') {
    return (
      <Banner kind="error">
        {t('checkin.alreadyUsed', {
          when: when ?? '',
          count: result.usedCount ?? 2,
          seat: result.label ?? result.holder ?? '',
        })}
      </Banner>
    )
  }
  if (result.outcome === 'WITHDRAWN') {
    return <Banner kind="error">{t('checkin.withdrawn')}</Banner>
  }
  return <Banner kind="warning">{t('checkin.unknown')}</Banner>
}

/** Typing the code, for a screen too cracked or too dim for a camera to read. */
function ManualEntry({ onSubmit }: { onSubmit: (value: string) => Promise<void> }) {
  const { t } = useT()
  const [value, setValue] = useState('')

  return (
    <form
      className="scanner-manual"
      onSubmit={(event) => {
        event.preventDefault()
        const typed = value.trim()
        if (!typed) {
          return
        }
        setValue('')
        void onSubmit(typed)
      }}
    >
      <input
        className="field-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t('checkin.manual')}
        aria-label={t('checkin.manual')}
      />
      <Button type="submit" variant="quiet">
        {t('checkin.check')}
      </Button>
    </form>
  )
}
