/**
 * 自洽安装:profile 的三处(dependency 行 / dsh.profile.bundles / node_modules 链接)
 * 加上 pnpm-lock.yaml 的 importer 行,全部由 dpk 自己写,不调 pnpm、不调官方服务。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packDirectory } from '../src/lib/pack.mjs'
import { installArchive, installOverwriting } from '../src/lib/install.mjs'
import {
  applyProfileInstall, applyProfileRemove, ensurePackageLink, installedState, isBundlePackage,
  linkSpecifier, patchLockfileImporter, profileDir, readProfileManifest,
} from '../src/lib/profile-install.mjs'
import { dpkRoot, readIndex } from '../src/lib/store.mjs'
import { makeHome, makePackage } from './helpers.mjs'

/** A profile directory with the parts every real profile has. */
async function makeProfile(home, profile = 'probe', options = {}) {
  const dir = profileDir(home, profile)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: { profile: { bundles: options.bundles ?? [] } },
  }, undefined, 2)}\n`)
  if (options.lockfile !== undefined) await writeFile(join(dir, 'pnpm-lock.yaml'), options.lockfile)
  return dir
}

/** The lockfile pnpm writes for an empty profile. */
const EMPTY_LOCKFILE = 'lockfileVersion: \'9.0\'\n\nimporters:\n\n  .: {}\n'

/** The shape pnpm writes once the importer has dependencies. */
const LOCKFILE_WITH_ONE = [
  'lockfileVersion: \'9.0\'',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  "      '@local/dsh-base':",
  '        specifier: link:C:/store/base/package',
  '        version: link:../../store/base/package',
  '',
  'packages:',
  '',
  'snapshots:',
  '',
].join('\n')

test('applyProfileInstall writes the dependency row, the bundle list, the link and the lockfile row', async () => {
  const home = await makeHome()
  const packageDir = join(home, 'dpk', 'store', 'deadbeef', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@local/x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })}\n`)
  const dir = await makeProfile(home, 'probe', { lockfile: LOCKFILE_WITH_ONE })

  const applied = await applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir })

  assert.equal(applied.changed, true)
  assert.equal(applied.bundlesChanged, true)
  assert.equal(applied.lockfile, 'updated')
  const manifest = await readProfileManifest(dir)
  assert.equal(manifest.dependencies['@local/x'], linkSpecifier(packageDir))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@local/x'])
  assert.equal(await isBundlePackage(packageDir), true)

  const link = join(dir, 'node_modules', '@local', 'x')
  const { realpath } = await import('node:fs/promises')
  assert.equal(await realpath(link), await realpath(packageDir), 'the loader resolves the bundle through this link')

  const lockfile = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')
  assert.match(lockfile, /'@local\/x':\n {8}specifier: link:.*\/package\n {8}version: link:\.\.\/\.\.\/dpk\/store\/deadbeef\/package/)
  assert.ok(lockfile.includes("'@local/dsh-base':"), 'the unrelated row is untouched')
  assert.ok(lockfile.trimEnd().endsWith('snapshots:'), 'the rest of the file is untouched')
})

test('a local bundle takes over and removes the official package with the same registry name', async () => {
  const home = await makeHome()
  const officialDir = join(home, 'official', 'x')
  const packageDir = join(home, 'dpk', 'store', 'deadbeef', 'package')
  await mkdir(officialDir, { recursive: true })
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(officialDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0' })}\n`)
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@local/x', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })}\n`)
  const dir = await makeProfile(home, 'probe', {
    dependencies: { x: '1.0.0' },
    bundles: ['x'],
    lockfile: [
      'lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:',
      '      x:', '        specifier: 1.0.0', '        version: 1.0.0', '',
      'packages:', '', 'snapshots:', '',
    ].join('\n'),
  })
  await symlink(officialDir, join(dir, 'node_modules', 'x'), 'junction')

  const applied = await applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir })

  assert.equal(applied.replacedPackageName, 'x')
  const manifest = await readProfileManifest(dir)
  assert.equal(Object.hasOwn(manifest.dependencies, 'x'), false)
  assert.equal(manifest.dependencies['@local/x'], linkSpecifier(packageDir))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@local/x'])
  assert.equal(existsSync(join(dir, 'node_modules', 'x')), false)
  assert.equal(await (await import('node:fs/promises')).realpath(join(dir, 'node_modules', '@local', 'x')), await (await import('node:fs/promises')).realpath(packageDir))
  const lockfile = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')
  assert.doesNotMatch(lockfile, /^      x:/m)
  assert.match(lockfile, /^      '@local\/x':/m)
})

test('profileDir accepts one safe directory name and rejects traversal forms', async () => {
  const home = await makeHome()
  assert.equal(profileDir(home, 'desktop'), join(home, 'profiles', 'desktop'))
  for (const profile of ['.', '..', '../escape', '..\\escape', 'nested/profile', 'C:\\escape', '/absolute']) {
    assert.throws(() => profileDir(home, profile), error => error.code === 'DPK_PROFILE_INVALID', profile)
  }
})

test('applyProfileInstall is idempotent: the second call changes nothing', async () => {
  const home = await makeHome()
  const packageDir = join(home, 'dpk', 'store', 'deadbeef', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@local/x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })}\n`)
  const dir = await makeProfile(home, 'probe', { lockfile: EMPTY_LOCKFILE })
  await applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir })
  const before = await readFile(join(dir, 'package.json'), 'utf8')
  const lockBefore = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')

  const again = await applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir })

  assert.equal(again.changed, false, 'nothing to do')
  assert.equal(again.lockfile, 'unchanged')
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before)
  assert.equal(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8'), lockBefore)
  const state = await installedState({ home, profile: 'probe', packageName: '@local/x', packageDir })
  assert.equal(state.installed, true, state.reasons.join(' | '))
})

test('a plain dependency is installed but never listed as a bundle', async () => {
  const home = await makeHome()
  const packageDir = join(home, 'dpk', 'store', 'cafe', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: 'plain', version: '1.0.0' })}\n`)
  const dir = await makeProfile(home, 'probe')

  const applied = await applyProfileInstall({ home, profile: 'probe', packageName: 'plain', packageDir })

  assert.equal(applied.bundlesChanged, false)
  const manifest = await readProfileManifest(dir)
  assert.equal(manifest.dependencies.plain, linkSpecifier(packageDir))
  assert.deepEqual(manifest.dsh.profile.bundles, [])
  assert.equal(existsSync(join(dir, 'node_modules', 'plain', 'package.json')), true)
})

test('a bundle with multiple patch files is listed in the profile bundle set', async () => {
  const home = await makeHome()
  const packageDir = join(home, 'dpk', 'store', 'multi-patch', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@local/multi-patch',
    version: '1.0.0',
    dsh: { bundle: { patch: ['./one.yml', './two.yml'] } },
  })}\n`)
  const dir = await makeProfile(home, 'probe')

  const applied = await applyProfileInstall({ home, profile: 'probe', packageName: '@local/multi-patch', packageDir })

  assert.equal(applied.bundlesChanged, true)
  assert.equal(await isBundlePackage(packageDir), true)
  const manifest = await readProfileManifest(dir)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@local/multi-patch'])
})

test('reinstalling a bundle as a plain package removes its stale bundle entry', async () => {
  const home = await makeHome()
  const packageDir = join(home, 'dpk', 'store', 'switch', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@local/switch', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } },
  })}\n`)
  await makeProfile(home, 'probe')
  await applyProfileInstall({ home, profile: 'probe', packageName: '@local/switch', packageDir })

  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@local/switch', version: '1.0.0' })}\n`)
  const applied = await applyProfileInstall({ home, profile: 'probe', packageName: '@local/switch', packageDir })

  assert.equal(applied.bundlesChanged, true)
  assert.deepEqual((await readProfileManifest(profileDir(home, 'probe'))).dsh.profile.bundles, [])
})

test('installedState refuses a link that points somewhere else', async () => {
  const home = await makeHome()
  const dir = await makeProfile(home, 'probe')
  const wanted = join(home, 'dpk', 'store', 'aaaa', 'package')
  const other = join(home, 'dpk', 'store', 'bbbb', 'package')
  for (const target of [wanted, other]) {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), `${JSON.stringify({ name: '@local/x' })}\n`)
  }
  await applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir: wanted })
  const link = join(dir, 'node_modules', '@local', 'x')
  await rm(link, { recursive: true, force: true })
  await symlink(other, link, 'junction')

  const state = await installedState({ home, profile: 'probe', packageName: '@local/x', packageDir: wanted })

  assert.equal(state.installed, false)
  assert.ok(state.reasons.some((reason) => reason.includes('resolves to')), state.reasons.join(' | '))
})

test('ensurePackageLink refuses to replace a real directory', async () => {
  const home = await makeHome()
  const dir = await makeProfile(home, 'probe')
  const real = join(dir, 'node_modules', '@local', 'x')
  await mkdir(real, { recursive: true })
  const packageDir = join(home, 'store', 'package')
  await mkdir(packageDir, { recursive: true })

  await assert.rejects(
    ensurePackageLink({ profileDir: dir, packageName: '@local/x', packageDir }),
    (error) => error.code === 'DPK_PROFILE_LINK_CONFLICT',
  )
  assert.equal(existsSync(join(real, 'package.json')), false, 'nothing was written into somebody else\'s directory')
})

test('a refused link leaves the profile without a dependency row', async () => {
  const home = await makeHome()
  const dir = await makeProfile(home, 'probe')
  const real = join(dir, 'node_modules', '@local', 'x')
  await mkdir(real, { recursive: true })
  const packageDir = join(home, 'dpk', 'store', 'aaaa', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@local/x', dsh: { bundle: { patch: './cordis.patch.yml' } } })}\n`)

  await assert.rejects(
    applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir }),
    (error) => error.code === 'DPK_PROFILE_LINK_CONFLICT',
  )

  // The link is written before the row, so a failure here cannot leave a
  // dependency the loader would try to resolve at the next start.
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, {})
  assert.deepEqual(manifest.dsh.profile.bundles, [])
  assert.equal(existsSync(join(dir, 'pnpm-lock.yaml')), false, 'and the lockfile was not touched either')
})

test('applyProfileRemove drops the row, the bundle entry and the link', async () => {
  const home = await makeHome()
  const packageDir = join(home, 'dpk', 'store', 'deadbeef', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@local/x', dsh: { bundle: { patch: './p.yml' } } })}\n`)
  const dir = await makeProfile(home, 'probe', { lockfile: EMPTY_LOCKFILE })
  await applyProfileInstall({ home, profile: 'probe', packageName: '@local/x', packageDir })

  const removed = await applyProfileRemove({ home, profile: 'probe', packageName: '@local/x' })

  assert.equal(removed.changed, true)
  assert.equal(removed.bundlesChanged, true)
  const manifest = await readProfileManifest(dir)
  assert.equal(Object.hasOwn(manifest.dependencies, '@local/x'), false)
  assert.deepEqual(manifest.dsh.profile.bundles, [])
  assert.equal(existsSync(join(dir, 'node_modules', '@local', 'x')), false)
  assert.equal((await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).includes('@local/x'), false)
})

test('patchLockfileImporter leaves an unrecognised lockfile alone', async () => {
  const text = 'lockfileVersion: \'9.0\'\n'
  assert.equal(patchLockfileImporter(text, { name: 'x', specifier: 'link:a', version: 'link:b' }), undefined)
  assert.equal(patchLockfileImporter('importers:\n\n  .:\n    dependencies:\n      a:\n        version: link:a\n', { name: 'a', remove: true }).includes('a:'), false)
})

test('installArchive writes the profile itself and never calls a manager', async () => {
  const home = await makeHome()
  await makeProfile(home, 'probe')
  const root = await makePackage()
  const packed = await packDirectory(root)

  const result = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe', log: () => {} })

  assert.equal(result.via, 'profile')
  assert.equal(result.unchanged, false)
  assert.equal(result.installOutcome.application, 'applied')
  const manifest = await readProfileManifest(profileDir(home, 'probe'))
  assert.equal(manifest.dependencies['@local/dpk-fixture'], linkSpecifier(result.packageDir))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@local/dpk-fixture'])
  assert.equal(existsSync(join(profileDir(home, 'probe'), 'node_modules', '@local', 'dpk-fixture', 'package.json')), true)
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1)

  // The same archive again: the profile already holds it, so nothing changes.
  const again = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe', log: () => {} })
  assert.equal(again.unchanged, true)
  assert.equal(again.created, false)
})

test('installArchive in service mode still hands the store directory to the installer', async () => {
  const home = await makeHome()
  const root = await makePackage()
  const packed = await packDirectory(root)
  const calls = []

  const result = await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe',
    installer: async (packageDir, meta) => { calls.push([packageDir, meta.name]); return { application: 'applied' } },
    log: () => {},
  })

  assert.equal(result.via, 'service')
  assert.deepEqual(calls, [[result.packageDir, '@local/dpk-fixture']])
  assert.equal(existsSync(join(home, 'profiles', 'probe', 'package.json')), false, 'the profile was not written by dpk')
})

test('installMode service without an installer is a caller error, not a silent profile write', async () => {
  const home = await makeHome()
  const root = await makePackage()
  const packed = await packDirectory(root)
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe', installMode: 'service', log: () => {} }),
    (error) => error.code === 'DPK_NO_INSTALLER',
  )
})

test('a package with runtime dependencies takes the pnpm path, and says why', async () => {
  const home = await makeHome()
  const root = await makePackage({ manifest: { dependencies: { 'some-registry-pkg': '^1.0.0' } } })
  const packed = await packDirectory(root)

  // No installer: the only path that can install the dependency tree is pnpm.
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe', log: () => {} }),
    (error) => error.code === 'DPK_NO_INSTALLER' && error.message.includes('some-registry-pkg') && error.message.includes('via: "service"'),
  )

  const calls = []
  const result = await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe', log: () => {},
    installer: async (packageDir) => { calls.push(packageDir); return { application: 'applied' } },
  })
  assert.equal(result.via, 'service', 'a registry dependency tree is what pnpm is for')
  assert.equal(calls.length, 1)
})

test('forcing the profile write on such a package warns instead of silently dropping the tree', async () => {
  const home = await makeHome()
  await makeProfile(home, 'probe')
  const root = await makePackage({ manifest: { dependencies: { 'some-registry-pkg': '^1.0.0' } } })
  const packed = await packDirectory(root)
  const lines = []

  const result = await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'probe',
    installMode: 'profile', log: (message) => lines.push(message),
  })

  assert.equal(result.via, 'profile')
  assert.ok(lines.some((line) => line.includes('some-registry-pkg')), lines.join(' | '))
  assert.equal(existsSync(join(profileDir(home, 'probe'), 'node_modules', '@local', 'dpk-fixture', 'package.json')), true)
})

test('installOverwriting keeps its manager contract for service mode', async () => {
  const manager = { installBundle: async () => ({ application: 'applied' }), removeBundle: async () => ({ changed: true }) }
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture')
  assert.equal(outcome.application, 'applied')
})
