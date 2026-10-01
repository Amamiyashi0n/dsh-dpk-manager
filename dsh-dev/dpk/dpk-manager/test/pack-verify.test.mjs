/** Pack/verify semantics: DSH conformance, tamper detection, manifest strictness. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { archiveFileName, packDirectory } from '../lib/pack.mjs'
import { verifyArchive } from '../lib/verify.mjs'
import { buildManifest, validateManifest, DPK_GENERATOR } from '../lib/dpk-manifest.mjs'
import { validateDshPackage } from '../lib/dsh-package.mjs'
import { writeZip } from '../lib/zip.mjs'
import { makePackage } from './helpers.mjs'

/** A structurally valid manifest, for field-level tests. */
function skeleton() {
  return buildManifest({
    name: '@local/x',
    version: '1.0.0',
    roles: ['plain'],
    files: [{ path: 'package/package.json', size: 3, sha256: 'a'.repeat(64) }],
  })
}

/** Rebuild an archive from a package directory, optionally perturbing one file. */
async function forgeFrom(packed, perturb) {
  const entries = [{ path: 'dpk.json', data: Buffer.from(`${JSON.stringify(packed.manifest, undefined, 2)}\n`) }]
  for (const file of packed.source.files) {
    let data = await readFile(file.absolute)
    data = perturb?.(file.path, data) ?? data
    entries.push({ path: `package/${file.path}`, data })
  }
  return writeZip(entries, { timestamp: '1980-01-01T00:00:00Z' })
}

test('packs a bundle package and verifies it end to end', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  assert.equal(packed.manifest.name, '@local/dpk-fixture')
  assert.equal(packed.manifest.version, '1.0.0')
  assert.deepEqual(packed.manifest.roles, ['bundle'])
  assert.equal(packed.manifest.generator, DPK_GENERATOR)
  assert.equal(packed.fileName, 'local-dpk-fixture-1.0.0.dpk')
  assert.equal(packed.manifest.files.length, 5)

  const verified = await verifyArchive(packed.buffer)
  assert.equal(verified.manifest.integrity.digest, packed.manifest.integrity.digest)
  assert.deepEqual(verified.packageFacts.roles, ['bundle'])
  assert.ok(verified.checks.some(check => check.startsWith('dsh: package.json passes strict conformance')))
})

test('packs reproducibly: identical input, identical bytes', async () => {
  const root = await makePackage()
  const first = await packDirectory(root)
  const second = await packDirectory(root)
  assert.ok(first.buffer.equals(second.buffer), 'two packs of one directory must be byte-identical')
})

test('detects one flipped content byte at the same size', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const forged = await forgeFrom(packed, (path, data) => {
    if (path !== 'icon.svg') return data
    const copy = Buffer.from(data)
    copy[10] ^= 0xff
    return copy
  })
  await assert.rejects(verifyArchive(forged), error => error.code === 'DPK_HASH_MISMATCH')
})

test('detects a size change before hashing', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const forged = await forgeFrom(packed, (path, data) => (path === 'index.js' ? Buffer.from('export function apply() { /* tampered */ }\n') : data))
  await assert.rejects(verifyArchive(forged), error => error.code === 'DPK_SIZE_MISMATCH')
})

test('rejects an archive that carries a file dpk.json does not list', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const entries = [
    { path: 'dpk.json', data: Buffer.from(`${JSON.stringify(packed.manifest, undefined, 2)}\n`) },
    { path: 'package/package.json', data: await readFile(join(root, 'package.json')) },
    { path: 'package/extra.js', data: Buffer.from('// unlisted\n') },
  ]
  await assert.rejects(verifyArchive(writeZip(entries)), error => error.code === 'DPK_UNLISTED_FILE')
})

test('rejects an archive missing a listed file', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const entries = [
    { path: 'dpk.json', data: Buffer.from(`${JSON.stringify(packed.manifest, undefined, 2)}\n`) },
    { path: 'package/package.json', data: await readFile(join(root, 'package.json')) },
  ]
  await assert.rejects(verifyArchive(writeZip(entries)), error => error.code === 'DPK_MISSING_FILE')
})

test('rejects a rewritten integrity digest', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const tampered = { ...packed.manifest, integrity: { algorithm: 'sha256', digest: '0'.repeat(64) } }
  assert.throws(() => validateManifest(tampered), error => error.code === 'DPK_INTEGRITY_MISMATCH')
})

test('rejects unknown manifest fields and reserved future fields', () => {
  assert.throws(() => validateManifest({ ...skeleton(), extra: 1 }), error => error.code === 'DPK_MANIFEST_UNKNOWN_FIELD')
  assert.throws(() => validateManifest({ ...skeleton(), signatures: [] }), error => error.code === 'DPK_VERSION')
  assert.throws(() => validateManifest({ ...skeleton(), dpk: 2 }), error => error.code === 'DPK_VERSION')
  assert.throws(() => validateManifest({ ...skeleton(), roles: ['mystery'] }), error => error.code === 'DPK_MANIFEST_FIELD')
  assert.throws(() => validateManifest({ ...skeleton(), entry: 'package/x.json' }), error => error.code === 'DPK_MANIFEST_FIELD')
  assert.throws(() => validateManifest({ ...skeleton(), generator: 'nope' }), error => error.code === 'DPK_MANIFEST_FIELD')
})

test('rejects a file entry with an unknown field or a bad digest', () => {
  const manifest = skeleton()
  assert.throws(() => validateManifest({
    ...manifest,
    files: [{ ...manifest.files[0], extra: true }],
  }), error => error.code === 'DPK_MANIFEST_UNKNOWN_FIELD')
  assert.throws(() => validateManifest({
    ...manifest,
    files: [{ path: 'package/package.json', size: 3, sha256: 'ABC' }],
  }), error => error.code === 'DPK_MANIFEST_FIELD')
})

test('rejects an unsorted file list', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const reversed = { ...packed.manifest, files: [...packed.manifest.files].reverse() }
  assert.throws(() => validateManifest(reversed), error => error.code === 'DPK_MANIFEST_ORDER')
})

test('rejects a file path outside package/', () => {
  const manifest = skeleton()
  assert.throws(() => validateManifest({
    ...manifest,
    files: [{ path: 'dpk.json', size: 3, sha256: 'a'.repeat(64) }],
  }), error => error.code === 'DPK_MANIFEST_FIELD')
})

test('refuses a package name the registry would refuse', async () => {
  await assert.rejects(validateDshPackage(await makePackage({ manifest: { name: 'Bad Name' } })), error => error.code === 'PACKAGE_NAME')
  await assert.rejects(validateDshPackage(await makePackage({ manifest: { name: 'x'.repeat(215) } })), error => error.code === 'PACKAGE_NAME')
  {
    const facts = await validateDshPackage(await makePackage({ manifest: { name: 'plain-unscooped' } }))
    assert.equal(facts.name, '@local/plain-unscooped', 'an unscoped name is localized, not refused')
    assert.ok(facts.checkNotes.some(note => note.includes('@local/plain-unscooped')), facts.checkNotes.join(','))
  }
  {
    const facts = await validateDshPackage(await makePackage({ manifest: { name: '@other/scoped' } }))
    assert.equal(facts.name, '@local/scoped', 'a foreign scope is re-scoped to @local')
  }
  {
    const facts = await validateDshPackage(await makePackage({ manifest: { name: '@local/already' } }))
    assert.equal(facts.name, '@local/already', 'a local name passes through')
  }
})

test('refuses a missing or non-semver version', async () => {
  await assert.rejects(validateDshPackage(await makePackage({ manifest: { version: undefined } })), error => error.code === 'PACKAGE_VERSION')
  await assert.rejects(validateDshPackage(await makePackage({ manifest: { version: 'v1' } })), error => error.code === 'PACKAGE_VERSION')
})

test('refuses a bundle whose patch file is missing', async () => {
  const root = await makePackage({ manifest: { dsh: { manifestVersion: 1, bundle: { patch: './nope.yml' } } } })
  await assert.rejects(validateDshPackage(root), error => error.code === 'PACKAGE_BUNDLE')
})

test('refuses a patch path that escapes the package', async () => {
  const root = await makePackage({ manifest: { dsh: { manifestVersion: 1, bundle: { patch: '../outside.yml' } } } })
  await assert.rejects(validateDshPackage(root), error => error.code === 'PACKAGE_BUNDLE')
})

test('refuses a patch file that is not a top-level array', async () => {
  const root = await makePackage()
  await writeFile(join(root, 'cordis.patch.yml'), 'insert:\n  - id: x\n')
  await assert.rejects(validateDshPackage(root), error => error.code === 'PACKAGE_PATCH')
})

test('refuses a manifestVersion other than 1', async () => {
  const root = await makePackage({ manifest: { dsh: { manifestVersion: 2, bundle: { patch: './cordis.patch.yml' } } } })
  await assert.rejects(validateDshPackage(root), error => error.code === 'PACKAGE_DSH')
})

test('refuses a client manifest without a platform', async () => {
  const root = await makePackage({
    manifest: { dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, client: { immediately: true } } },
  })
  await assert.rejects(validateDshPackage(root), error => error.code === 'PACKAGE_CLIENT')
})

test('refuses an icon outside the package, with a bad extension, or oversized', async () => {
  await assert.rejects(validateDshPackage(await makePackage({ manifest: { icon: '../outside.svg' } })), error => error.code === 'PACKAGE_ICON')
  await assert.rejects(validateDshPackage(await makePackage({ manifest: { icon: './icon.gif' } })), error => error.code === 'PACKAGE_ICON')
  const big = await makePackage({ extraFiles: { 'big.svg': 'x'.repeat(256 * 1024 + 1) }, manifest: { icon: './big.svg' } })
  await assert.rejects(validateDshPackage(big), error => error.code === 'PACKAGE_ICON')
})

test('refuses a bad locale language id and empty display text', async () => {
  await assert.rejects(validateDshPackage(await makePackage({ extraFiles: { 'locale/not_a_lang.json': '{}\n' } })), error => error.code === 'PACKAGE_LOCALE')
  await assert.rejects(validateDshPackage(await makePackage({ extraFiles: { 'locale/fr.json': `${JSON.stringify({ meta: { title: '  ' } })}\n` } })), error => error.code === 'PACKAGE_LOCALE')
})

test('refuses symlinks inside a package', async (context) => {
  const root = await makePackage()
  try {
    await symlink(join(root, 'index.js'), join(root, 'linked.js'))
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOSYS' || error.code === 'EACCES') {
      context.skip('this host cannot create symlinks without elevation')
      return
    }
    throw error
  }
  await assert.rejects(validateDshPackage(root), error => error.code === 'PACKAGE_SYMLINK')
})

test('derives roles: bundle, client, both, and plain', async () => {
  assert.deepEqual((await validateDshPackage(await makePackage())).roles, ['bundle'])
  assert.deepEqual((await validateDshPackage(await makePackage({
    manifest: { dsh: { manifestVersion: 1, client: { platform: 'web' } } },
  }))).roles, ['client'])
  assert.deepEqual((await validateDshPackage(await makePackage({
    manifest: { dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } },
  }))).roles, ['bundle', 'client'])
  assert.deepEqual((await validateDshPackage(await makePackage({ manifest: { dsh: undefined } }))).roles, ['plain'])
})

test('warns instead of failing when locale files are absent', async () => {
  const root = await makePackage()
  await rm(join(root, 'locale'), { recursive: true, force: true })
  const facts = await validateDshPackage(root)
  assert.ok(facts.warnings.some(warning => warning.includes('locale')))
})

test('archive file naming strips the scope', () => {
  assert.equal(archiveFileName('@local/dsh-reverse-skill', '1.2.3'), 'local-dsh-reverse-skill-1.2.3.dpk')
  assert.equal(archiveFileName('zcode-provider', '1.0.0'), 'zcode-provider-1.0.0.dpk')
})

test('rejects an unexpected top-level entry', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const forged = writeZip([
    { path: 'dpk.json', data: Buffer.from(`${JSON.stringify(packed.manifest)}\n`) },
    { path: 'README.md', data: Buffer.from('stray\n') },
  ])
  await assert.rejects(verifyArchive(forged), error => error.code === 'DPK_LAYOUT')
})

test('accepts a plain package and reports its role', async () => {
  const root = await makePackage({ manifest: { dsh: undefined } })
  const packed = await packDirectory(root)
  const verified = await verifyArchive(packed.buffer)
  assert.deepEqual(verified.manifest.roles, ['plain'])
})

test('notes the structural-only patch check', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const verified = await verifyArchive(packed.buffer)
  assert.ok(verified.notes.some(note => note.includes('structurally a top-level YAML array')))
})

test('deep verification can be skipped', async () => {
  const root = await makePackage()
  const packed = await packDirectory(root)
  const shallow = await verifyArchive(packed.buffer, { deep: false })
  assert.equal(shallow.packageFacts, undefined)
  assert.ok(shallow.warnings.some(warning => warning.includes('deep check skipped')))
})

test('never packs node_modules', async () => {
  const root = await makePackage()
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'export default 1\n')
  const facts = await validateDshPackage(root)
  assert.ok(!facts.files.some(file => file.path.startsWith('node_modules/')))
})

test('never packs the package dist build-output directory', async () => {
  const root = await makePackage()
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'pkg-1.0.0.dpk'), 'stale archive bytes')
  const facts = await validateDshPackage(root)
  assert.ok(!facts.files.some(file => file.path.startsWith('dist/')))
})

test('the packed package subtree is exactly the source directory', async () => {
  const root = await makePackage({ extraFiles: { 'nested/deep/file.txt': 'deep\n' } })
  const packed = await packDirectory(root)
  const listed = packed.manifest.files.map(file => file.path).sort()
  const onDisk = packed.source.files.map(file => `package/${file.path}`).sort()
  assert.deepEqual(listed, onDisk)
})
