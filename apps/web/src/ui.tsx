import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { ApiError } from './api/client'
import { useT } from './i18n'

/**
 * The small set of pieces every screen is built from.
 *
 * Kept deliberately plain. The interesting decisions in this application are about what is
 * said and when, not about the widgets, and a component library would put a layer between the
 * two for no gain here.
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
        autoComplete={props.autoComplete}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
      {props.help ? <span className="field-help">{props.help}</span> : null}
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
}) {
  return (
    <button
      className={`button button-${props.variant ?? 'primary'}`}
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  )
}

export function Card(props: { children: ReactNode; title?: string }) {
  return (
    <section className="card">
      {props.title ? <h2 className="card-title">{props.title}</h2> : null}
      {props.children}
    </section>
  )
}

/**
 * A message about something that happened.
 *
 * `warning` is not decoration here: it is what the export and withdraw screens use to say a
 * thing that cannot be undone, and it has to read differently from an error the user can fix.
 */
export function Banner(props: { kind: 'error' | 'warning' | 'info' | 'success'; children: ReactNode }) {
  return (
    <p className={`banner banner-${props.kind}`} role={props.kind === 'error' ? 'alert' : undefined}>
      {props.children}
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
      <Button type="submit" disabled={busy || props.disabled}>
        {busy ? t('common.loading') : props.submitLabel}
      </Button>
    </form>
  )
}

/** The ticket states, with the colour and shape the Android app settled on. */
export function StateBadge({ state }: { state: string }) {
  const { t } = useT()
  const key = `state.${state}` as never
  return <span className={`badge badge-${state.toLowerCase()}`}>{t(key)}</span>
}
