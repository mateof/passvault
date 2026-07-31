import type { SVGProps } from 'react'

/**
 * The icon set, drawn here rather than installed.
 *
 * A library would be several thousand glyphs to ship a dozen, and this project has no build-time
 * tree-shaking story it can rely on for CSS-adjacent assets. These are stroked paths on a 24-unit
 * grid with a common stroke width, which is what makes an icon set look like a set rather than
 * like a collection — the alternative is a cheerful mix of weights that reads as unfinished.
 *
 * Every icon is decorative: it sits beside a label that already says the same thing. So they carry
 * `aria-hidden` and nothing announces them, which is right — a screen reader saying "calendar,
 * Events" is worse than one saying "Events".
 */

export type IconName =
  | 'events'
  | 'ticket'
  | 'account'
  | 'admin'
  | 'lock'
  | 'unlock'
  | 'signOut'
  | 'plus'
  | 'upload'
  | 'download'
  | 'check'
  | 'close'
  | 'chevron'
  | 'image'
  | 'file'
  | 'users'
  | 'mail'
  | 'shield'
  | 'calendar'
  | 'place'
  | 'money'
  | 'menu'
  | 'copy'
  | 'warning'
  | 'key'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** In pixels. Inherits the text colour, so it is styled by whatever it sits inside. */
  size?: number
}

const PATHS: Record<IconName, string> = {
  // A ticket stub with a perforation, which is what this application is about.
  ticket:
    'M3 9V7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a2 2 0 0 0 0-4M15 6v2M15 11v2M15 16v2',
  events:
    'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 9h16M9 3v4M15 3v4',
  account: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  admin: 'M12 3 4 6v5c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6zM9 12l2 2 4-4',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  unlock:
    'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M8 11V7a4 4 0 0 1 7.5-2M12 15v2',
  signOut: 'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  download: 'M12 4v12M8 12l4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  check: 'M5 13l4 4L19 7',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  image:
    'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 16l4-4 4 4M14 14l2-2 4 4M15 9h.01',
  file: 'M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M14 3v5h5M9 13h6M9 17h6',
  users:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13a7 7 0 0 1 4 7',
  mail: 'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 7l9 6 9-6',
  shield: 'M12 3 4 6v5c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6z',
  calendar:
    'M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 10h16M8 3v5M16 3v5',
  place:
    'M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  money:
    'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9h.01M18 15h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  copy: 'M9 9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1',
  warning: 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
  key: 'M15 3a6 6 0 1 1-5.6 8.2L3 17.6V21h3.4l1-1v-2h2v-2h2l1.4-1.4A6 6 0 0 1 15 3M17 7h.01',
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/**
 * The icons an event can be given, and the colours they can be given in.
 *
 * A small closed set on purpose. The point is that a wallet of twelve events is scannable at a
 * glance, and that works because a concert is always the same shape in the same place — an
 * arbitrary picture per event is the other feature, and it is a different one.
 */
export const EVENT_ICONS = [
  'concert',
  'football',
  'theatre',
  'cinema',
  'travel',
  'museum',
  'party',
  'other',
] as const

export type EventIconName = (typeof EVENT_ICONS)[number]

export const EVENT_COLOURS = [
  'violet',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
] as const

export type EventColour = (typeof EVENT_COLOURS)[number]

const EVENT_PATHS: Record<EventIconName, string> = {
  concert:
    'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 18V6l11-3v12M9 8l11-3M20 15a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  football:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7.5l3.5 2.5-1.3 4.1H9.8L8.5 10zM12 3v4.5M20.6 9.7l-4.9.3M18 19l-3.2-4.4M6 19l3.2-4.4M3.4 9.7l4.9.3',
  theatre: 'M4 5h16v7a8 8 0 0 1-16 0zM9 10h.01M15 10h.01M9 15c1.8 1.3 4.2 1.3 6 0',
  cinema: 'M3 8h18v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 8l3-5M9 8l3-5M15 8l3-5M10 12v5l4-2.5z',
  travel:
    'M2 16l9-2.5V6a1.5 1.5 0 0 1 3 0v6.7l8 2.3v2l-8-1.5v3.2l2.5 1.8V22l-4-1-4 1v-1.5L11 18.7V15.5L2 18z',
  museum: 'M3 9l9-5 9 5v2H3zM5 11v7M10 11v7M14 11v7M19 11v7M3 21h18M3 18h18',
  party: 'M4 20l5.5-13 8.5 8.5zM9.5 7 18 15.5M14 3v3M19 5l-2 2M21 10h-3',
  other: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.5 9.5A2.5 2.5 0 1 1 12 13v1.5M12 17.5h.01',
}

/**
 * The mark that stands for an event: its icon, in its colour.
 *
 * Falls back to the neutral shape rather than to nothing, because an event with no icon chosen —
 * every event that existed before this feature — still has to render as something.
 */
export function EventMark({
  icon,
  colour,
  size = 40,
  imageUrl,
  alt = '',
}: {
  icon?: string | null
  colour?: string | null
  size?: number
  /** When the event carries a picture, it wins: it is more specific than any icon. */
  imageUrl?: string | null
  alt?: string
}) {
  const chosen = (EVENT_ICONS as readonly string[]).includes(icon ?? '')
    ? (icon as EventIconName)
    : 'other'
  const hue = (EVENT_COLOURS as readonly string[]).includes(colour ?? '')
    ? (colour as EventColour)
    : 'violet'

  if (imageUrl) {
    return (
      <img
        className="event-mark event-mark-image"
        src={imageUrl}
        alt={alt}
        width={size}
        height={size}
      />
    )
  }

  return (
    <span className={`event-mark event-mark-${hue}`} style={{ width: size, height: size }}>
      <svg
        width={size * 0.55}
        height={size * 0.55}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d={EVENT_PATHS[chosen]} />
      </svg>
    </span>
  )
}
