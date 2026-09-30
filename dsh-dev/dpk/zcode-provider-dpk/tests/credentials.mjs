/**
 * 凭证解析测试:官方规则(凭证库 → 账号级 api-key;start-plan → zcodejwttoken)
 * 与密文解密(`enc:v1:` AES-256-GCM,密钥 = SHA-256(fallback 种子))。
 *
 * 用法:node tests/credentials.mjs
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { deriveCredentialKey, decryptStoreValue, readCredentialStore, resolvePlanCredential, defaultCredentialsPath } =
  await import(pathToFileURL(join(here, '..', 'lib', 'credentials.js')).href)

const failures = []
let passed = 0
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) } else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

const HOME = 'C:\\fixture-home'
const USER = 'fixture-user'
const key = deriveCredentialKey(HOME, USER)

function encrypt(plaintext, k = key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`
}

// ---- 1. 解密 ----
const secret = 'provisioned-key.0123456789abcdef'
const enc = encrypt(secret)
check('解密:enc:v1 密文可还原明文', decryptStoreValue(enc, key) === secret)
check('解密:明文原样返回', decryptStoreValue('plain-value', key) === 'plain-value')
let wrongKeyFailed = false
try { decryptStoreValue(enc, deriveCredentialKey(HOME, 'other-user')) } catch { wrongKeyFailed = true }
check('解密:错误密钥解密失败(GCM 认证)', wrongKeyFailed)
let malformedFailed = false
try { decryptStoreValue('enc:v1:only.two', key) } catch { malformedFailed = true }
check('解密:格式非法抛错', malformedFailed)

// ---- 2. 解析规则 ----
const dir = mkdtempSync(join(tmpdir(), 'zcode-cred-'))
const credPath = join(dir, 'credentials.json')
const IDENTITY = '44000000000000000'
const INDIVIDUAL = 'account:bigmodel-individual-coding-plan'
try {
  writeFileSync(credPath, JSON.stringify({
    'oauth:active_provider': encrypt('bigmodel'),
    'zcodejwttoken': encrypt('jwt-from-store'),
    [`account-provider:${INDIVIDUAL}:identity`]: IDENTITY,
    [`account-provider:coding-plan:${INDIVIDUAL}:account:${IDENTITY}:api-key`]: encrypt(secret),
  }), 'utf8')

  const individual = resolvePlanCredential({
    credentialsPath: credPath, providerId: INDIVIDUAL, family: 'bigmodel',
    planKind: 'individual-coding-plan', fallbackApiKey: 'config-fallback', home: HOME, user: USER,
  })
  check('individual coding plan:取账号级 provisioned key', individual.apiKey === secret, `${individual.apiKey} / ${individual.source}`)
  check('individual coding plan:来源标记 credential-store', individual.source === 'credential-store')

  const startPlan = resolvePlanCredential({
    credentialsPath: credPath, providerId: 'account:bigmodel-start-plan', family: 'bigmodel',
    planKind: 'start-plan', fallbackApiKey: 'config-start-token', home: HOME, user: USER,
  })
  check('start plan:active provider 命中 family 时取 zcodejwttoken', startPlan.apiKey === 'jwt-from-store', `${startPlan.apiKey} / ${startPlan.source}`)
  check('start plan:来源标记 zcode-jwt', startPlan.source === 'zcode-jwt')

  const otherFamily = resolvePlanCredential({
    credentialsPath: credPath, providerId: 'account:zai-start-plan', family: 'zai',
    planKind: 'start-plan', fallbackApiKey: 'config-zai-token', home: HOME, user: USER,
  })
  check('start plan:active provider 不匹配时回落配置层', otherFamily.apiKey === 'config-zai-token' && otherFamily.source === 'config')

  const missing = resolvePlanCredential({
    credentialsPath: join(dir, 'nope.json'), providerId: INDIVIDUAL, family: 'bigmodel',
    planKind: 'individual-coding-plan', fallbackApiKey: 'config-fallback', home: HOME, user: USER,
  })
  check('凭证库缺失:回落配置层', missing.apiKey === 'config-fallback' && missing.source === 'config')

  const nothing = resolvePlanCredential({
    credentialsPath: credPath, providerId: IDENTITY === '' ? 'x' : 'account:bigmodel-team-coding-plan',
    family: 'bigmodel', planKind: 'individual-coding-plan', home: HOME, user: USER,
  })
  check('凭证库无该 provider 且无回落:来源 none', nothing.apiKey === '' && nothing.source === 'none', nothing.source)

  const emptyStore = readCredentialStore(join(dir, 'nope.json'))
  check('凭证库不可读:返回空表', Object.keys(emptyStore).length === 0)

  check('默认凭证路径位于插件自有根目录', defaultCredentialsPath('X:\\root') === join('X:\\root', 'credentials.json'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed}/${passed + failures.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
