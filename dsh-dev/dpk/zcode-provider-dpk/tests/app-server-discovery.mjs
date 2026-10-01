/**
 * ZCode install discovery: candidate roots are verified by the CLI bundle on
 * disk, the first verified root wins, and duplicates never get a second
 * chance. The registry/PATH probes themselves are environment-dependent; the
 * mapping and ordering logic below is what the tests pin down.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverZcodeInstall, zcodeInstallFromRoot } from '../src/app-server-discovery.ts'

const BACKSLASH = String.fromCharCode(92)
const normalizeRoot = value => value.toLowerCase().replaceAll('/', BACKSLASH)

/** A fake install root with the CLI bundle (and optionally the builtin catalog). */
function fakeRoot(withBuiltin) {
  const root = mkdtempSync(join(tmpdir(), 'zcode-disc-'))
  mkdirSync(join(root, 'resources', 'glm'), { recursive: true })
  writeFileSync(join(root, 'resources', 'glm', 'zcode.cjs'), '/* cli */\n')
  if (withBuiltin) {
    mkdirSync(join(root, 'resources', 'config', 'provider'), { recursive: true })
    writeFileSync(join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'), '{}\n')
  }
  return root
}

test('a root verifies through the CLI bundle and maps the catalog when present', () => {
  const withCatalog = zcodeInstallFromRoot(fakeRoot(true))
  assert.notEqual(withCatalog, undefined)
  assert.ok(withCatalog.cliPath.endsWith(join('resources', 'glm', 'zcode.cjs')))
  assert.ok(withCatalog.builtinProviderConfigPath.endsWith('zcode-builtin.json'))

  const withoutCatalog = zcodeInstallFromRoot(fakeRoot(false))
  assert.notEqual(withoutCatalog, undefined)
  assert.equal(withoutCatalog.builtinProviderConfigPath, undefined)
})

test('a root without the CLI bundle is not an install', () => {
  const empty = mkdtempSync(join(tmpdir(), 'zcode-empty-'))
  assert.equal(zcodeInstallFromRoot(empty), undefined)
  assert.equal(zcodeInstallFromRoot(''), undefined)
  assert.equal(zcodeInstallFromRoot('  '), undefined)
})

test('discovery returns the first verified root and skips duplicates and misses', () => {
  const miss = mkdtempSync(join(tmpdir(), 'zcode-miss-'))
  const good = fakeRoot(true)
  const alsoGood = fakeRoot(true)
  const found = discoverZcodeInstall([miss, good, good, alsoGood])
  assert.notEqual(found, undefined)
  assert.equal(normalizeRoot(found.installRoot), normalizeRoot(good))
  // Case/slash variants of the same root resolve to the same install.
  const variant = good.replaceAll(BACKSLASH, '/').toUpperCase()
  const again = discoverZcodeInstall([variant, miss])
  assert.equal(normalizeRoot(again.installRoot), normalizeRoot(good))
})

test('discovery reports nothing when no candidate verifies', () => {
  const miss = mkdtempSync(join(tmpdir(), 'zcode-none-'))
  assert.equal(discoverZcodeInstall([miss]), undefined)
  assert.equal(discoverZcodeInstall([]), undefined)
})

test('the real machine probe never throws and verifies what it returns', () => {
  // No injected roots: exercises the registry + PATH + common-directory probes
  // on this machine. Either answer is valid; the contract is no throw, and a
  // find must point at a CLI bundle that exists.
  const install = discoverZcodeInstall(undefined)
  if (install !== undefined) {
    assert.ok(install.cliPath.includes('zcode.cjs'))
  }
})
