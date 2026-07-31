import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

/**
 * Which origins a passkey may legitimately come from.
 *
 * A browser sends the https origin. The Android app sends `android:apk-key-hash:...`, because
 * there is no page and no URL — the binding is to the installed package. Verifying against the
 * https origin alone refused every passkey created from the app *after* the system sheet had
 * already created one, which is indistinguishable, from the user's side, from the app crashing
 * on the way back.
 */
const FINGERPRINT =
  'BE:C5:86:C1:3B:AC:74:5C:0E:C3:30:B1:99:74:8D:CD:90:5F:68:00:B8:93:8C:DD:A8:F6:85:D4:92:9B:DF:C2'

let dataDir: string
let assetLinks: string

const baseEnv = (): NodeJS.ProcessEnv =>
  ({
    DATA_DIR: dataDir,
    PUBLIC_URL: 'https://passvault.example.org',
    MASTER_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaao',
    BLIND_INDEX_KEY: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbo',
    ASSETLINKS_FILE: assetLinks,
  }) as NodeJS.ProcessEnv

const writeAssetLinks = (fingerprints: string[]): void => {
  writeFileSync(
    assetLinks,
    JSON.stringify([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.mateof.passvault',
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ]),
  )
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'passvault-origins-'))
  assetLinks = join(dataDir, 'assetlinks.json')
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('the origins a passkey ceremony is accepted from', () => {
  it('always includes the browser origin', () => {
    writeAssetLinks([FINGERPRINT])

    expect(loadConfig(baseEnv()).webAuthn.origins).toContain('https://passvault.example.org')
  })

  it('includes the Android package, derived from the certificate the asset links name', () => {
    writeAssetLinks([FINGERPRINT])

    // The colon-separated hex of the signing certificate, as base64url. Written out rather than
    // recomputed here: a test that repeats the implementation cannot catch the implementation
    // being wrong.
    expect(loadConfig(baseEnv()).webAuthn.origins).toContain(
      'android:apk-key-hash:vsWGwTusdFwOwzCxmXSNzZBfaAC4k4zdqPaF1JKb38I',
    )
  })

  it('carries every certificate, so a debug build alongside a release one both work', () => {
    writeAssetLinks([FINGERPRINT, FINGERPRINT.replace(/^BE/, 'AA')])

    expect(loadConfig(baseEnv()).webAuthn.origins).toHaveLength(3)
  })

  it('takes an explicit list instead when one is given', () => {
    writeAssetLinks([FINGERPRINT])

    const config = loadConfig({
      ...baseEnv(),
      WEBAUTHN_ANDROID_ORIGINS: 'android:apk-key-hash:something-else',
    } as NodeJS.ProcessEnv)

    expect(config.webAuthn.origins).toEqual([
      'https://passvault.example.org',
      'android:apk-key-hash:something-else',
    ])
  })

  it('starts anyway when the asset links file is absent, since the web still works', () => {
    expect(loadConfig(baseEnv()).webAuthn.origins).toEqual(['https://passvault.example.org'])
  })

  it('starts anyway when it is unreadable, rather than refusing over a file it only reads', () => {
    writeFileSync(assetLinks, 'not json at all')

    expect(loadConfig(baseEnv()).webAuthn.origins).toEqual(['https://passvault.example.org'])
  })

  it('ignores a fingerprint that is not a SHA-256, which would produce a wrong origin silently', () => {
    writeAssetLinks(['AB:CD'])

    expect(loadConfig(baseEnv()).webAuthn.origins).toEqual(['https://passvault.example.org'])
  })
})
