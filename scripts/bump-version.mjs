import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Raises the patch version everywhere it is written down.
 *
 * Every merge to main publishes an image, and an image nobody can name by version can only be
 * pinned by commit hash — which is not a version anybody reads, compares or asks a friend to run.
 * So the number moves on its own, and the workflow tags the image with it.
 *
 * The lockfile matters as much as the manifests. It records a version for the root and for each
 * workspace, and leaving those behind means the tree describes two different versions of itself
 * — harmless today, because npm checks dependencies rather than a workspace's own version, and
 * exactly the sort of drift that becomes a confusing `npm ci` failure two npm releases later.
 *
 * A patch bump, always. What is in a merge is not something a script can judge: a release that
 * deserves a minor or a major is a decision somebody makes by editing these files or pushing a
 * tag, and this only guarantees that the number never stands still.
 */
const MANIFESTS = ['package.json', 'apps/server/package.json', 'apps/web/package.json']

/** The workspaces the lockfile mirrors, keyed the way it keys them. */
const LOCK_ENTRIES = ['', 'apps/server', 'apps/web']

const current = JSON.parse(readFileSync(MANIFESTS[0], 'utf8')).version
const [major, minor, patch] = current.split('.')
if (![major, minor, patch].every((part) => /^\d+$/.test(part ?? ''))) {
  throw new Error(`the version is not three numbers: ${current}`)
}
const next = [major, minor, Number(patch) + 1].join('.')

for (const file of MANIFESTS) {
  const text = readFileSync(file, 'utf8')
  // A targeted replacement rather than a re-serialisation: writing the parsed object back would
  // reformat somebody's file and put a diff in front of the one line that changed.
  const updated = text.replace(/"version": "[^"]*"/, `"version": "${next}"`)
  if (updated === text) {
    throw new Error(`no version field in ${file}`)
  }
  writeFileSync(file, updated)
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
lock.version = next
for (const entry of LOCK_ENTRIES) {
  if (lock.packages?.[entry]) {
    lock.packages[entry].version = next
  }
}
// The lockfile is generated, so re-serialising it is what npm itself does. Two spaces and a
// trailing newline is npm's own shape; anything else shows up as a whole-file diff.
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)

console.log(next)
