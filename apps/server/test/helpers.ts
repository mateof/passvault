import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_ARGON2_PARAMS, randomKey, toBase64Url } from '@passvault/crypto'
import { buildServer, type PassVaultServer } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { CapturingMailer } from '../src/mailer.js'

/**
 * A server for one test.
 *
 * In-memory SQLite, keys supplied so no secrets file is written, and Argon2id at test
 * parameters — the production settings would add roughly a second per password operation, and a
 * suite that takes minutes is a suite people stop running.
 */
export interface TestServer extends PassVaultServer {
  mailer: CapturingMailer
  dispose: () => Promise<void>
}

export async function startTestServer(overrides: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'passvault-test-'))
  const config = loadConfig({
    DATA_DIR: dataDir,
    DATABASE_URL: 'sqlite::memory:',
    MASTER_KEY: toBase64Url(randomKey()),
    BLIND_INDEX_KEY: toBase64Url(randomKey()),
    PUBLIC_URL: 'https://passvault.example.org',
    ...overrides,
  } as NodeJS.ProcessEnv)

  const mailer = new CapturingMailer()
  const server = await buildServer({ config, mailer, argon2Params: TEST_ARGON2_PARAMS })

  return {
    ...server,
    mailer,
    dispose: async () => {
      await server.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export const ADMIN = {
  email: 'mateo@example.org',
  password: 'unha-clave-longa-abondo',
  passphrase: 'frase do baul moi longa',
}

export const MEMBER = {
  email: 'ana@example.org',
  password: 'outra-clave-longa-abondo',
  passphrase: 'frase do baul de ana',
}

/**
 * Registers the first account, which a closed instance accepts and makes administrator.
 *
 * Every test needs one, because there is otherwise no way to change any setting — which is the
 * behaviour being relied on, so it is asserted here rather than assumed.
 */
export async function registerFirstAdmin(server: TestServer): Promise<{
  userId: string
  recoveryCode: string
}> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/registration',
    payload: ADMIN,
  })
  if (response.statusCode !== 201) {
    throw new Error(`first admin registration failed: ${response.statusCode} ${response.body}`)
  }
  return response.json()
}

export async function login(
  server: TestServer,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: credentials,
  })
  const body = response.json()
  if (body.status !== 'complete') {
    throw new Error(`expected a completed login, got ${JSON.stringify(body)}`)
  }
  return body.token
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

export async function setRegistrationMode(
  server: TestServer,
  token: string,
  mode: 'OPEN' | 'WHITELIST' | 'INVITATION' | 'CLOSED',
): Promise<void> {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/registration',
    headers: bearer(token),
    payload: { mode },
  })
  if (response.statusCode !== 200) {
    throw new Error(`could not set registration mode: ${response.statusCode} ${response.body}`)
  }
}
