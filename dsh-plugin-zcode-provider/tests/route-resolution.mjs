/** Standalone route derivation and stale-profile convergence tests. */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const fixtures = join(here, 'fixtures')
const { apply } = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)

const failures = []
let passed = 0
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

const ROUTES = [
  'builtin:bigmodel-coding-plan',
  'builtin:bigmodel-start-plan',
]

async function probe(routesConfig) {
  const logs = []
  const adapters = new Map()
  const mutations = []
  const services = new Map()
  const applyResult = apply({
    logger: {
      info: (message) => logs.push(String(message)),
      debug: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
    },
    get(name) {
      if (name !== 'settings') return undefined
      return { mutate: async (_ns, ops) => { mutations.push(...ops) } }
    },
    provide(name, service) {
      services.set(name, service)
      return () => services.delete(name)
    },
    inject: () => ({ dispose() {} }),
    llm: {
      registerAdapter(ids, adapter) {
        let registered = [...ids]
        const add = (values) => { for (const id of values) adapters.set(id, adapter) }
        const remove = () => {
          for (const id of registered) if (adapters.get(id) === adapter) adapters.delete(id)
        }
        add(registered)
        const handle = () => remove()
        handle.replace = (values) => {
          remove()
          registered = [...values]
          add(registered)
        }
        return handle
      },
      registerConfigurableProviders() {},
    },
    fiber: { entry: { options: { id: 'zcode-provider' } } },
  }, {
    providerConfigPath: join(fixtures, 'device-config-plans.json'),
    credentialsPath: join(fixtures, 'credentials.json'),
    telemetryStatePath: join(fixtures, 'telemetry-state.json'),
    signingEnabled: false,
    ...(routesConfig === undefined ? {} : { routes: routesConfig }),
  })
  const registrationOrder = [...adapters.keys()]
  const initialSnapshot = await services.get('zcodeEntitlements').snapshot({ range: '30d' })
  return { logs, adapters, mutations, services, applyResult, registrationOrder, initialSnapshot }
}

function fields(line) {
  const result = {}
  for (const part of line.split(' ')) {
    const split = part.indexOf('=')
    if (split > 0) result[part.slice(0, split)] = part.slice(split + 1)
  }
  return result
}

const stale = {
  'builtin:bigmodel-coding-plan': {
    id: 'builtin:bigmodel-coding-plan',
    display: 'Old Coding Plan',
    kind: 'anthropic',
    baseURL: 'https://invalid.example/anthropic',
    apiKey: 'stale-key',
    models: [{ id: 'stale-model', contextWindow: 1, maxTokens: 1 }],
  },
  'builtin:bigmodel-start-plan': {
    id: 'builtin:bigmodel-start-plan',
    display: 'Old Start Plan',
    kind: 'anthropic',
    baseURL: 'https://invalid.example/start',
    apiKey: 'stale-jwt',
    models: [{ id: 'stale-model', contextWindow: 1, maxTokens: 1 }],
  },
  'legacy-openai': {
    id: 'legacy-openai',
    display: 'Legacy OpenAI',
    kind: 'openai',
    baseURL: 'https://invalid.example/v1',
    apiKey: 'old',
    models: [{ id: 'old', contextWindow: 1, maxTokens: 1 }],
  },
}

const originalFetch = globalThis.fetch
let degraded = false
let fetchCalls = 0
globalThis.fetch = async (url) => {
  fetchCalls += 1
  const href = String(url)
  if (href.includes('/subscription/list')) {
    if (degraded) return new Response('temporary', { status: 503 })
    return Response.json({ code: 200, data: [{ productId: 'coding', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] })
  }
  if (href.includes('/billing/balance')) {
    if (degraded) return new Response('temporary', { status: 503 })
    return Response.json({
      code: 0,
      data: {
        server_time: 100,
        plans: [{ user_plan_id: 'up', plan_id: 'zcode-v3-start-plan', name: 'Start Plan', status: 'active', entitlements: [{ entitlement_id: 'e', effective_at: 90 }] }],
        balances: [{ user_plan_id: 'up', plan_id: 'zcode-v3-start-plan', entitlement_id: 'e', capabilities: ['model:glm-5.3-flash'], total_units: 10, used_units: 1, remaining_units: 9 }],
      },
    })
  }
  if (href.includes('/model-usage')) return Response.json({ code: 200, data: {} })
  return Response.json({ code: 200, data: { limits: [] } })
}
const derived = await probe(undefined)
const healed = await probe(stale)

check('apply publishes configured account routes synchronously', derived.applyResult === undefined)
check('account route registration order matches 2.4.0',
  JSON.stringify(derived.registrationOrder) === JSON.stringify(ROUTES),
  JSON.stringify(derived.registrationOrder))
check('initial entitlement snapshot confirms both account routes',
  derived.initialSnapshot.core.accountProviders['account:bigmodel-individual-coding-plan'].state.entitled === true
  && derived.initialSnapshot.core.accountProviders['account:bigmodel-start-plan'].state.entitled === true)

const callsAfterWarmSnapshot = fetchCalls
await derived.services.get('zcodeEntitlements').snapshot({ range: '30d' })
check('repeated entitlement snapshot reuses the warmed report', fetchCalls === callsAfterWarmSnapshot,
  `fetch calls increased from ${callsAfterWarmSnapshot} to ${fetchCalls}`)

const callsBeforeForcedRefresh = fetchCalls
await derived.services.get('zcodeEntitlements').snapshot({ range: '30d', force: true })
check('explicit entitlement refresh bypasses the short cache', fetchCalls > callsBeforeForcedRefresh,
  `fetch calls stayed at ${fetchCalls}`)

for (const [route, expected] of [
  ['builtin:bigmodel-coding-plan', { access: 'zhipu-account/individual-coding-plan', credential: 'credential-store' }],
  ['builtin:bigmodel-start-plan', { access: 'zhipu-account/start-plan', credential: 'zcode-jwt' }],
]) {
  const line = derived.logs.find((value) => value.includes(`注册 ${route} `)) ?? ''
  const parsed = fields(line)
  check(`${route}: registered`, derived.adapters.has(route))
  check(`${route}: access`, parsed.access === expected.access, String(parsed.access))
  check(`${route}: credential`, parsed.credential === expected.credential, String(parsed.credential))
  check(`${route}: family`, parsed.family === 'bigmodel', String(parsed.family))
  check(`${route}: no external execution mode`, !line.includes('delegate') && !line.includes('engine'), line)

  const derivedModels = await derived.adapters.get(route).listModels(route)
  const healedModels = await healed.adapters.get(route).listModels(route)
  check(`${route}: stale profile converges to fixture models`,
    JSON.stringify(healedModels) === JSON.stringify(derivedModels), JSON.stringify(healedModels))
}

check('legacy OpenAI route is removed', !healed.adapters.has('legacy-openai'))
check('stale routes are written back through settings',
  healed.mutations.some((op) => op.op === 'set' && ROUTES.includes(op.path.at(-1)))
  && healed.mutations.some((op) => op.op === 'unset' && op.path.at(-1) === 'legacy-openai'))

degraded = true
const degradedSnapshot = await derived.services.get('zcodeEntitlements').snapshot({ force: true })
check('temporary entitlement outage retains Coding Plan Registry publication',
  derived.adapters.has('builtin:bigmodel-coding-plan'))
check('temporary entitlement outage retains Start Plan Registry publication',
  derived.adapters.has('builtin:bigmodel-start-plan'))
check('temporary entitlement outage retains last-known-good account facts',
  degradedSnapshot.core.accountProviders['account:bigmodel-individual-coding-plan'].state.entitled === true
  && degradedSnapshot.core.accountProviders['account:bigmodel-start-plan'].state.entitled === true,
  JSON.stringify(degradedSnapshot.core.accountProviders))

globalThis.fetch = originalFetch

console.log(`\n${passed}/${passed + failures.length} tests passed`)
if (failures.length) {
  console.error(`\nFailures:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
