#!/usr/bin/env node
/**
 * Repair the shared ZCode credential store for standalone app-server use.
 *
 * Background (re-app-server/README.md): the account-provider api-key entries in
 * ~/.zcode/v2/credentials.json were written under a custom ZCODE_CREDENTIAL_SECRET
 * that is no longer known, so every official standalone child (zcode.cjs
 * app-server) fails to decrypt them, stays fail-closed (entitled:false) and the
 * Provider Registry drops the account providers (provider_not_found).
 *
 * This script re-encrypts the individual coding-plan api-key entry with the
 * OFFICIAL fallback secret (zcode-credential-fallback:<platform>:<homedir>:<user>),
 * taking the current plaintext key from the plugin's providers.json — the same
 * key the white-box direct wire uses today.
 *
 * Usage: node fix-credential-reencrypt.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir, userInfo, platform } from 'node:os'

const CRED_PATH = `${homedir()}/.zcode/v2/credentials.json`
const PROVIDERS_PATH = `${homedir()}/.dsh/zcode-provider/providers.json`
const IDENTITY = '44021786437209270'
const TARGET = `account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:${IDENTITY}:api-key`

const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
  || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`
const key = createHash('sha256').update(secret, 'utf-8').digest()

function encrypt(value) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(value, 'utf-8'), c.final()])
  return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`
}
function decrypt(value) {
  const [a, l, u] = value.slice('enc:v1:'.length).split('.')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(a, 'base64url'))
  d.setAuthTag(Buffer.from(l, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(u, 'base64url')), d.final()]).toString('utf-8')
}

const dry = process.argv.includes('--dry-run')
const providers = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf-8'))
const apiKey = providers.provider?.['builtin:bigmodel-coding-plan']?.options?.apiKey?.trim()
if (!apiKey) throw new Error('coding-plan apiKey not found in providers.json')

const store = JSON.parse(readFileSync(CRED_PATH, 'utf-8'))
const old = store[TARGET]
console.log(`target entry present: ${Boolean(old)} (old value decryptable with fallback: ${
  (() => { try { decrypt(old); return true } catch { return false } })()})`)

store[TARGET] = encrypt(apiKey)
const roundtrip = decrypt(store[TARGET])
if (roundtrip !== apiKey) throw new Error('roundtrip mismatch')
console.log(`re-encrypted with official fallback secret, roundtrip OK (${roundtrip.length} chars)`)

if (dry) {
  console.log('dry-run: not writing')
} else {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17)
  copyFileSync(CRED_PATH, `${CRED_PATH}.bak-pre-reenc-${stamp}`)
  writeFileSync(CRED_PATH, JSON.stringify(store, null, 2) + '\n')
  console.log(`written (backup: credentials.json.bak-pre-reenc-${stamp})`)
}
