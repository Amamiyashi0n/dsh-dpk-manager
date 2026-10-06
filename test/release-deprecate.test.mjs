import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deprecatePreviousVersions, deprecationPlan, publishCleanup } from '../scripts/deprecate-previous.mjs'

test('the release plan deprecates only versions older than the current release', () => {
  const plan = deprecationPlan({
    name: 'dsh-dpk-manager',
    version: '2.1.62',
    publishConfig: { registry: 'https://registry.npmjs.org/' },
  })

  assert.equal(plan.spec, 'dsh-dpk-manager@<2.1.62')
  assert.equal(plan.message, 'Deprecated: use dsh-dpk-manager@2.1.62.')
  assert.deepEqual(plan.args, [
    'deprecate',
    'dsh-dpk-manager@<2.1.62',
    'Deprecated: use dsh-dpk-manager@2.1.62.',
    '--registry=https://registry.npmjs.org/',
  ])
})

test('the release plan inherits the package registry', () => {
  assert.equal(
    deprecationPlan({ name: '@scope/plugin', version: '1.0.0' }).args.at(-1),
    '--registry=https://registry.npmjs.org/',
  )
  assert.equal(
    deprecationPlan({ name: '@scope/plugin', version: '1.0.0', publishConfig: { registry: 'https://registry.example.test/' } }).args.at(-1),
    '--registry=https://registry.example.test/',
  )
})

test('deprecation failure is surfaced after npm publish', async () => {
  const calls = []
  await assert.rejects(
    deprecatePreviousVersions({ name: 'dsh-dpk-manager', version: '2.1.62' }, async (args, options) => {
      calls.push({ args, options })
      throw new Error('registry rejected deprecation')
    }),
    /registry rejected deprecation/,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[0], 'deprecate')
})

test('dry-run skips remote deprecation', async () => {
  let called = false
  const result = await publishCleanup({
    env: { npm_config_dry_run: 'true' },
    runner: async () => { called = true },
  })
  assert.deepEqual(result, { skipped: true })
  assert.equal(called, false)
})
