import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import { ApiError } from './api/client'
import { useT } from './i18n'
import { Icon, type IconName } from './icons'

/**
 * The small set of pieces every screen is built from.
 *
 * Kept deliberately plain. The interesting decisions in this application are about what is
 * said and when, not about the widgets, and a component library would put a layer between the
 * two for no gain here — the whole set is one file and every screen uses all of it.
 */

export function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  required?: boolean
  help?: string
  autoComplete?: string
  /**
   * The server's own rule, repeated here so the browser refuses to submit.
   *
   * Not belt and braces: without it a password one character short of the rule made a round
   * trip and came back as a refusal on a screen that had never said what the rule was.
   */
  minLength?: number
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        className="field-input"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        required={props.required}
        minLength={props.minLength}
        autoComplete={props.autoComplete}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
      {props.help ? <span className="field-help">{props.help}</span> : null}
    </label>
  )
}

export function Checkbox(props: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="field field-check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  )
}

/**
 * Choosing a file.
 *
 * A styled label wrapping a hidden input, because the native control cannot be styled and looks
 * like a piece of another application. The chosen name is shown: a picker that reports nothing is
 * how somebody uploads the wrong file twice.
 */
export function FilePicker(props: {
  label: string
  accept: string
  file?: File | undefined
  onChange: (file: File | undefined) => void
}) {
  return (
    <label className="file-drop">
      <Icon name="upload" />
      <span>{props.file ? props.file.name : props.label}</span>
      <input
        type="file"
        accept={props.accept}
        onChange={(event) => props.onChange(event.target.files?.[0])}
      />
    </label>
  )
}

export function Select<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select
        className="field-input"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'primary' | 'quiet' | 'danger'
  disabled?: boolean
  icon?: IconName
}) {
  return (
    <button
      className={`button button-${props.variant ?? 'primary'}`}
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.icon ? <Icon name={props.icon} size={18} /> : null}
      {props.children}
    </button>
  )
}

export function Card(props: { children: ReactNode; title?: string; icon?: IconName }) {
  return (
    <section className="card">
      {props.title ? (
        <div className="card-head">
          {props.icon ? (
            <span className="card-icon">
              <Icon name={props.icon} size={18} />
            </span>
          ) : null}
          <h2 className="card-title">{props.title}</h2>
        </div>
      ) : null}
      {props.children}
    </section>
  )
}

/** The heading of a screen, with whatever action belongs to the screen as a whole. */
export function PageHead(props: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-title">{props.title}</h1>
        {props.subtitle ? <p className="page-subtitle">{props.subtitle}</p> : null}
      </div>
      {props.action}
    </header>
  )
}

/**
 * Nothing here yet, said as a state rather than as an absence.
 *
 * An empty list that renders as empty space reads as something still loading. This says which
 * of the two it is.
 */
export function Empty(props: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={props.icon ?? 'events'} size={32} />
      <p>{props.children}</p>
    </div>
  )
}

/**
 * A message about something that happened.
 *
 * `warning` is not decoration here: it is what the export and withdraw screens use to say a
 * thing that cannot be undone, and it has to read differently from an error the user can fix.
 */
export function Banner(props: {
  kind: 'error' | 'warning' | 'info' | 'success'
  children: ReactNode
}) {
  const icon: IconName =
    props.kind === 'success' ? 'check' : props.kind === 'info' ? 'shield' : 'warning'
  return (
    <p
      className={`banner banner-${props.kind}`}
      role={props.kind === 'error' ? 'alert' : undefined}
    >
      <Icon name={icon} size={18} />
      <span>{props.children}</span>
    </p>
  )
}

export function Loading() {
  const { t } = useT()
  return <p className="loading">{t('common.loading')}</p>
}

/**
 * A form that shows what the server said when it refuses.
 *
 * The message comes from the server rather than being re-worded from a code, because the
 * server owns the wording and already translated it — the request carried `accept-language`.
 */
export function Form(props: {
  children: ReactNode
  onSubmit: () => Promise<void>
  submitLabel: string
  submitIcon?: IconName
  disabled?: boolean
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit()
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof TypeError
            ? t('error.offline')
            : t('error.unexpected'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      {props.children}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <div className="button-row">
        <Button
          type="submit"
          disabled={busy || props.disabled}
          {...(props.submitIcon ? { icon: props.submitIcon } : {})}
        >
          {busy ? t('common.loading') : props.submitLabel}
        </Button>
      </div>
    </form>
  )
}

/**
 * A blob from the API, as a URL a tag can point at.
 *
 * Needed because everything here is decrypted per session behind a bearer token held in memory:
 * an `<img src="/api/...">` arrives with no Authorization header and renders as a broken image.
 * So the bytes are fetched, wrapped in an object URL, and the URL is revoked when the component
 * goes away — without that last part, browsing a wallet leaks a copy of every poster it drew.
 */
export function useObjectUrl(fetcher: (() => Promise<Blob>) | undefined): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    if (!fetcher) {
      setUrl(undefined)
      return
    }
    let revoked = false
    let created: string | undefined
    fetcher()
      .then((blob) => {
        if (revoked) return
        created = URL.createObjectURL(blob)
        setUrl(created)
      })
      .catch(() => setUrl(undefined))
    return () => {
      revoked = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [fetcher])

  return url
}

/** The ticket states, with the colour and shape the Android app settled on. */
export function StateBadge({ state }: { state: string }) {
  const { t } = useT()
  const key = `state.${state}` as never
  return <span className={`badge badge-${state.toLowerCase()}`}>{t(key)}</span>
}

/**
 * A dialog, on the platform's own element.
 *
 * `<dialog showModal>` brings three things that are tedious and easy to get wrong by hand: focus
 * is trapped inside, Escape closes it, and it renders in the top layer so nothing on the page can
 * cover it. A div with a high z-index has none of those and is how a modal ends up impossible to
 * use with a keyboard.
 *
 * Used for the things that are *acts* — share this, label that, create one — while the page keeps
 * the things somebody came to read. The screens here had become long vertical stacks of panels,
 * most of which were not what the visit was about.
 */
export function Modal(props: {
  open: boolean
  title: string
  icon?: IconName
  onClose: () => void
  children: ReactNode
}) {
  const { t } = useT()
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (props.open && !dialog.open) dialog.showModal()
    if (!props.open && dialog.open) dialog.close()
  }, [props.open])

  return (
    <dialog
      ref={ref}
      className="modal"
      // Escape and the backdrop both close it, and both arrive here rather than as a state the
      // caller has to keep in step.
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose()
      }}
    >
      <div className="modal-head">
        <h2 className="modal-title">
          {props.icon ? <Icon name={props.icon} size={18} /> : null} {props.title}
        </h2>
        <Button variant="quiet" icon="close" onClick={props.onClose}>
          {t('action.close')}
        </Button>
      </div>
      <div className="modal-body">{props.children}</div>
    </dialog>
  )
}

/** A label, as the coloured chip it is drawn as everywhere. */
export function TagChip(props: {
  name: string
  colour: string
  on?: boolean
  onClick?: () => void
}) {
  const className = [
    'tag-chip',
    `mark-${props.colour}`,
    props.onClick ? 'is-selectable' : '',
    props.on === false ? 'is-off' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return props.onClick ? (
    <button type="button" className={className} onClick={props.onClick}>
      <span className="tag-dot" />
      {props.name}
    </button>
  ) : (
    <span className={className}>
      <span className="tag-dot" />
      {props.name}
    </span>
  )
}
