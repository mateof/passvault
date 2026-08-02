import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomKey, toBase64Url } from '@passvault/crypto'
import {
  ADMIN,
  MEMBER,
  bearer,
  login,
  registerFirstAdmin,
  setRegistrationMode,
  startTestServer,
  type TestServer,
} from './helpers.js'

/**
 * The same phone, a different account.
 *
 * A device's signing key is created once per install and never changes, so signing out of one
 * account and into another on the same handset presents the server with a key it has already
 * seen — under a different owner. The old rule called that forbidden, which locked the phone out
 * of syncing for every account but the first it ever used. It is not forbidden: a phone can serve
 * whoever is signed in on it, and this is what deleting an account and reusing the phone needs too.
 */
let server: TestServer
let admin: string
let member: string

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  admin = await login(server, ADMIN)
  await setRegistrationMode(server, admin, 'OPEN')
  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  member = await login(server, MEMBER)
})

afterEach(async () => {
  await server.dispose()
})

const key = () => toBase64Url(new Uint8Array(randomKey()))

const register = (token: string, signing: string, agreement: string) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: bearer(token),
    payload: { name: 'Phone', signingPublicKey: signing, agreementPublicKey: agreement },
  })

describe('registering a device already known under another account', () => {
  it('reassigns it rather than refusing, so the phone can sync for whoever signed in', async () => {
    const signing = key()
    const agreement = key()

    const first = await register(admin, signing, agreement)
    expect(first.statusCode).toBe(201)
    const deviceId = first.json().deviceId

    const second = await register(member, signing, agreement)
    expect(second.statusCode).toBe(201)
    // The same device row, now owned by the account that just registered it.
    expect(second.json().deviceId).toBe(deviceId)
    const row = await server.db.db
      .selectFrom('devices')
      .select(['user_id', 'status'])
      .where('id', '=', deviceId)
      .executeTakeFirst()
    const memberId = (await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })).json()
      .userId
    expect(row?.user_id).toBe(memberId)
    expect(row?.status).toBe('ACTIVE')
  })
})
