#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const failures = []
let passed = 0

function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

function filesUnder(root) {
  const output = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...filesUnder(path))
    else output.push(path)
  }
  return output
}

const packageJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(pkgRoot, 'client.js'), 'utf8')
check('package uses a release version', /^\d+\.\d+\.\d+$/.test(packageJson.version))
check('package includes split entitlement projection',
  clientSource.includes("directDescriptor('zcodeEntitlements', 'snapshot'")
  && clientSource.includes("directDescriptor('zcodeEntitlements', 'usage'")
  && clientSource.includes("directDescriptor(CAPTCHA_REMOTE_NAMESPACE, 'claim'")
  && clientSource.includes("directDescriptor(CAPTCHA_REMOTE_NAMESPACE, 'complete'")
  && clientSource.includes('loadInitialSnapshot'))
check('Web client has an explicit package export', packageJson.exports?.['./client'] === './client.js')
check('Web client declares only public DSH service dependencies',
  JSON.stringify(packageJson.dsh?.client?.inject) === JSON.stringify([
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-settings',
  ]))
check('source and tests are declared as distributable files',
  packageJson.files.includes('src') && packageJson.files.includes('tests') && packageJson.files.includes('tsconfig.json'))

const packageFiles = filesUnder(pkgRoot)
const binaryExtensions = new Set(['.exe', '.dll', '.node', '.so', '.dylib'])
const binaries = packageFiles.filter((path) => binaryExtensions.has(extname(path).toLowerCase()))
check('package contains no native or executable business binaries', binaries.length === 0,
  binaries.map((path) => relative(pkgRoot, path)).join(','))

const runtimeFiles = packageFiles.filter((path) => {
  const name = relative(pkgRoot, path).replaceAll('\\', '/')
  return name.startsWith('src/') || name.startsWith('lib/')
    || ['package.json', 'cordis.patch.yml', 'client.js'].includes(name)
})
const forbidden = [
  ['zcode', '.cjs'].join(''),
  ['app', '-', 'server'].join(''),
  ['zcode', '-', 'cli'].join(''),
  ['engine', 'BunPath'].join(''),
  ['engine', 'Cwd'].join(''),
  ['delegated', 'Sessions'].join(''),
  ['zcode', 'ConfigPath'].join(''),
  ['zcode', 'CatalogPath'].join(''),
  ['C:', '\\Users', '\\Amamiya'].join(''),
  ['C:', '/Users', '/Amamiya'].join(''),
  ['Dev', '-ws-next'].join(''),
  ['Dev', '_ws'].join(''),
]
const boundaryLeaks = []
// The shipped lib/index.js is an esbuild bundle that intentionally inlines the
// vendored dsh-llm/schemastery code plus every module (transport included), so
// it carries the app-server markers by construction. The banner identifies it;
// boundary discipline is enforced on src/ and the unbundled module files.
const BUNDLED_ENTRY_BANNER = 'zcode-provider bundled entry'
const isBundledEntry = (path, text) =>
  relative(pkgRoot, path).replaceAll('\\', '/') === 'lib/index.js' && text.includes(BUNDLED_ENTRY_BANNER)
for (const path of runtimeFiles) {
  const text = readFileSync(path, 'utf8')
  if (isBundledEntry(path, text)) continue
  for (const token of forbidden) {
    // The comparison transport is the sole explicit integration boundary. It
    // may name and launch the configured ZCode CLI, while the normal provider
    // implementation remains self-contained and readable.
    const appServerBoundary = path.replaceAll('\\', '/').includes('app-server')
    if (token === 'app-server'
      || ((token === 'zcode.cjs' || token === 'zcode-cli') && appServerBoundary)) continue
    if (text.toLowerCase().includes(token.toLowerCase())) {
      boundaryLeaks.push(`${relative(pkgRoot, path)}:${token}`)
    }
  }
}
check('runtime is detached from external ZCode implementation and machine paths',
  boundaryLeaks.length === 0, boundaryLeaks.join(','))
const forbiddenBrowserAutomation = runtimeFiles.filter((path) => {
  if (path.replaceAll('\\', '/').includes('app-server')) return false
  const text = readFileSync(path, 'utf8')
  if (isBundledEntry(path, text)) return false
  return text.includes('node:child_process')
    || text.includes('spawn(')
    || text.includes('captcha-browser')
    || text.includes('chromiumPath')
    || text.includes('captchaProfileDir')
})
check('CAPTCHA is carried only by the existing DSH Web UI, without browser automation',
  forbiddenBrowserAutomation.length === 0,
  forbiddenBrowserAutomation.map((path) => relative(pkgRoot, path)).join(','))
check('app-server comparison boundary is isolated to its transport module',
  runtimeFiles.filter((path) => /(?:^|[\\/])app-server\.(?:ts|js)$/.test(path))
    .every((path) => readFileSync(path, 'utf8').includes('workspace/generateText')))
check('package has no opaque oversized source blob',
  runtimeFiles.every((path) => statSync(path).size < 2 * 1024 * 1024))

const { apply } = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
let adapter
const logs = []
const missingConfig = join(pkgRoot, 'tests', 'fixtures', 'missing-device-config.json')
const routeId = 'fixture:standalone'
let activated = true
try {
  await apply({
    logger: {
      info: (message) => logs.push(String(message)),
      debug: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
    },
    get: () => undefined,
    inject: () => ({ dispose() {} }),
    llm: {
      registerAdapter(ids, value) { if (ids.includes(routeId)) adapter = value },
      registerConfigurableProviders() {},
    },
    fiber: { entry: { options: { id: 'zcode-provider' } } },
  }, {
    providerConfigPath: missingConfig,
    // 隔离机器上的真实提示词覆写状态:本文件断言官方三块
    promptOverridesPath: join(pkgRoot, 'tests', 'fixtures', 'prompt-overrides.isolated.json'),
    signingEnabled: false,
    routes: {
      [routeId]: {
        id: routeId,
        display: 'Standalone fixture',
        kind: 'anthropic',
        baseURL: 'https://fixture.invalid/anthropic',
        apiKey: 'fixture-key',
        models: [{ id: 'GLM-5.3-Flash', contextWindow: 200000, maxTokens: 128000, inputModalities: ['text'] }],
      },
    },
  })
} catch (error) {
  activated = false
  logs.push(String(error))
}
check('missing optional device config does not block activation', activated, logs.join(' | '))
check('plugin-owned route registers without ZCode installation', adapter !== undefined)

const sse = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"read_file","input":{}}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
  'data: {"type":"message_stop"}',
  '',
].join('\n\n')

const originalFetch = globalThis.fetch
let requestBody
globalThis.fetch = async (_url, init = {}) => {
  requestBody = JSON.parse(String(init.body))
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
try {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: routeId,
    model: 'GLM-5.3-Flash',
    sessionId: 'sess_standalone',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })) chunks.push(chunk)

  check('standalone request carries the three official system blocks',
    requestBody.system.length === 3 && requestBody.system[0].text === 'You are ZCode, an interactive coding agent')
  check('DSH tools are projected onto the Anthropic wire request',
    requestBody.tools?.[0]?.name === 'read_file' && requestBody.tool_choice?.type === 'auto')
  check('wire tool use returns DSH tool-call chunks',
    chunks.some((chunk) => chunk.type === 'tool-call-delta' && chunk.name === 'read_file')
    && chunks.at(-1)?.reason?.kind === 'tool-calls')
} finally {
  globalThis.fetch = originalFetch
}

console.log(`\n${passed}/${passed + failures.length} tests passed`)
if (failures.length) {
  console.error(`\nFailures:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
