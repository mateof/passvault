/**
 * An event as a calendar entry.
 *
 * `starts_at` and `time_zone` have been on every event since the beginning and nothing has ever
 * been able to read them but this application. A ticket is for a night, and the place people keep
 * their nights is their calendar.
 *
 * iCalendar is written out by hand rather than pulled in as a dependency. The subset needed here
 * is one VEVENT with four fields; a library would be tens of kilobytes to produce a document this
 * file produces in forty lines, and the escaping rules — which are the only part with any teeth —
 * would still have to be understood to use it correctly.
 */

/** RFC 5545 §3.3.5: an instant in UTC, without separators. */
function stamp(instant: string): string {
  return `${new Date(instant).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

/**
 * RFC 5545 §3.3.11. Backslash, semicolon and comma are structural, and a newline inside a value
 * has to be written as the two characters `\n` — an actual line break would end the property and
 * make the rest of the note look like a field nobody understands.
 */
function escape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * §3.1: no line may exceed 75 octets, and a continuation begins with one space.
 *
 * Folded on octets rather than characters, because the limit is bytes and an accented character
 * is two of them — a line folded at 75 characters can still be a line of 80 bytes, which some
 * readers truncate and others reject outright.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) {
    return line
  }
  const parts: string[] = []
  let at = 0
  let limit = 75
  while (at < bytes.length) {
    // Never split a multi-byte character: back off until the slice decodes cleanly.
    let take = Math.min(limit, bytes.length - at)
    while (take > 1 && (bytes[at + take]! & 0xc0) === 0x80) {
      take -= 1
    }
    parts.push(bytes.subarray(at, at + take).toString('utf8'))
    at += take
    // A continuation line spends one of its octets on the leading space.
    limit = 74
  }
  return parts.join('\r\n ')
}

export interface CalendarEvent {
  id: string
  name: string
  venue?: string | null
  notes?: string | null
  startsAt: string
  /** How long to say it lasts. Nothing in the schema records an end, so this is a stated guess. */
  hours?: number
  /** The address of this installation, so the entry links back to the tickets. */
  url?: string
}

export function icalendar(event: CalendarEvent): string {
  const start = new Date(event.startsAt)
  const end = new Date(start.getTime() + (event.hours ?? 3) * 60 * 60 * 1000)

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PassVault//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // The event's own identifier, so re-importing updates the entry rather than making a second
    // one. A calendar that grows a duplicate every time somebody downloads the file is worse than
    // no calendar entry at all.
    `UID:${event.id}@passvault`,
    // Not the current time: this file is generated on every request, and a DTSTAMP that moved
    // would make every download look like an amendment.
    `DTSTAMP:${stamp(event.startsAt)}`,
    `DTSTART:${stamp(start.toISOString())}`,
    `DTEND:${stamp(end.toISOString())}`,
    `SUMMARY:${escape(event.name)}`,
    ...(event.venue ? [`LOCATION:${escape(event.venue)}`] : []),
    ...(event.notes ? [`DESCRIPTION:${escape(event.notes)}`] : []),
    ...(event.url ? [`URL:${escape(event.url)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]

  // CRLF throughout, which the specification requires and several readers enforce.
  return `${lines.map(fold).join('\r\n')}\r\n`
}
