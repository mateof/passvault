/**
 * Opens a file written by the Android app with this repository's reader.
 *
 * The reference vectors prove the Kotlin reader agrees with the TypeScript writer. This proves the
 * other direction, which the vectors cannot: a round trip inside one implementation shows only that
 * it is self-consistent.
 *
 * Produce the sample first, in the passvault-android checkout:
 *
 *   ./gradlew :app:testDebugUnitTest --tests '*TkpakWriterTest*'
 *
 * then run `npm run interop:check -- <path to app/build/interop>`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectTkpak, openWithPassword } from '../packages/tkpak/src/index.js'

const directory = process.argv[2] ?? '../passvault-android/app/build/interop'
const descriptor = JSON.parse(
  await readFile(join(directory, 'written-by-android.json'), 'utf8'),
) as { archive: string; password: string; ticketCount: number }

const archive = new Uint8Array(await readFile(join(directory, descriptor.archive)))
const inspection = inspectTkpak(archive)
const opened = await openWithPassword(archive, descriptor.password)

const failures: string[] = []
if (!inspection.signatureValid) failures.push('signature did not verify')
if (opened.bundle.tickets.length !== descriptor.ticketCount) {
  failures.push(`expected ${descriptor.ticketCount} tickets, got ${opened.bundle.tickets.length}`)
}
if (opened.bundle.tickets.some((ticket) => !ticket.barcode?.value)) {
  failures.push('a ticket came back without its barcode')
}

console.log(`signature  : ${inspection.signatureValid ? 'valid' : 'INVALID'}`)
console.log(`event      : ${opened.bundle.event.name}`)
console.log(`tickets    : ${opened.bundle.tickets.length}`)
console.log(`barcodes   : ${opened.bundle.tickets.map((t) => t.barcode?.value).join(', ')}`)
console.log(`documents  : ${[...opened.documents.values()].map((d) => `${d.mediaType} ${d.bytes.length}B`).join(', ')}`)

if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nOK: this reader opened a file written by the Android app.')
