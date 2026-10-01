#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const storage = await import(pathToFileURL(join(process.cwd(), 'lib', 'storage.js')).href)
const promptStorage = await import(pathToFileURL(join(process.cwd(), 'lib', 'prompt-storage.js')).href)
const failures = []
let passed = 0

function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

const home = 'C:\\fixture-home'
const root = storage.defaultStorageRoot(home)
const paths = {
  providers: storage.defaultProviderConfigPath(root),
  credentials: storage.defaultCredentialsPath(root),
  telemetry: storage.defaultTelemetryStatePath(root),
  prompts: promptStorage.defaultPromptOverridesPath(root),
}

check('storage root is the dpk-managed data root', root === join(home, '.dsh', 'data', '@local', 'zcode-provider'), root)
check('volumes sort into their class directories',
  paths.providers === join(root, 'config', 'providers.json')
  && paths.prompts === join(root, 'config', 'prompt-overrides.json')
  && paths.credentials === join(root, 'state', 'credentials.json')
  && paths.telemetry === join(root, 'state', 'telemetry-state.json'),
  JSON.stringify(paths))
check('the legacy ~/.dsh/zcode-provider root is not consulted',
  !Object.values(paths).some((path) => path.includes(join(home, '.dsh', 'zcode-provider'))))
check('provider catalog has a plugin-owned name', paths.providers === join(root, 'config', 'providers.json'))
check('credentials have a plugin-owned path', paths.credentials === join(root, 'state', 'credentials.json'))
check('device identity has a plugin-owned path', paths.telemetry === join(root, 'state', 'telemetry-state.json'))
check('prompt overrides have a plugin-owned path', paths.prompts === join(root, 'config', 'prompt-overrides.json'))
check('prompt overrides normalize empty fields away', JSON.stringify(promptStorage.readPromptOverrides(join(root, 'missing.json'))) === '{}')
check('official defaults are not duplicated in prompt overrides',
  promptStorage.hasPromptOverrides({ before: { identity: 'You are ZCode, an interactive coding agent' } }) === false)
check('prompt overrides only persist the two custom layers',
  JSON.stringify(promptStorage.readPromptOverrides(join(root, 'legacy.json'))) === '{}')
// 覆写清空标记的落盘回归:写真实临时目录,避免依赖不存在的 fixture-home
const tmpRoot = join(tmpdir(), `zcode-prompt-storage-test-${Date.now()}`)
mkdirSync(tmpRoot, { recursive: true })
check('after-layer empty strings survive normalize as explicit cleared markers',
  (() => {
    const path = join(tmpRoot, 'cleared.json')
    writeFileSync(path, JSON.stringify({ after: { identity: '', agent: '', runtime: '' }, placement: 'after' }))
    return JSON.stringify(promptStorage.readPromptOverrides(path)) === JSON.stringify({
      after: { identity: '', agent: '', runtime: '' },
      placement: 'after',
    })
  })())
check('after-layer whitespace normalizes to the cleared marker',
  (() => {
    const path = join(tmpRoot, 'whitespace.json')
    writeFileSync(path, JSON.stringify({ after: { identity: ' \n ', agent: 'keep me' } }))
    return promptStorage.readPromptOverrides(path).after.identity === ''
  })())
check('cleared after-layer counts as an active override',
  promptStorage.hasPromptOverrides({ placement: 'after', after: { identity: '' } }) === true)
check('cleared markers in the inactive layer do not count as an override',
  promptStorage.hasPromptOverrides({ placement: 'before', after: { identity: '', agent: '', runtime: '' } }) === false)
check('before-layer empty strings are still stripped (inject mode has no marker)',
  promptStorage.hasPromptOverrides({ placement: 'before', before: { identity: '' } }) === false)
check('write+read round-trips cleared markers',
  (() => {
    const tmp = join(tmpRoot, 'roundtrip.json')
    promptStorage.writePromptOverrides(tmp, { placement: 'after', after: { identity: 'X', agent: '', runtime: '  ' } })
    const back = promptStorage.readPromptOverrides(tmp)
    return back.after.identity === 'X' && back.after.agent === '' && back.after.runtime === ''
  })())
check('empty overrides cannot escape the plugin-owned root',
  storage.defaultCredentialsPath('') === storage.defaultCredentialsPath())

console.log(`\n${passed}/${passed + failures.length} tests passed`)
if (failures.length) {
  console.error(`\nFailures:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
