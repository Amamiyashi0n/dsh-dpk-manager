/**
 * The apt lifecycle's other half: `update` reports what is available, `upgrade`
 * installs it.
 *
 * Two kinds of package share one lifecycle, and each answers "is there a newer
 * version" from its own upstream:
 *
 * - **registry packages** (what the official Plugins page installs: a package
 *   name on npm) — the upstream is the npm registry, asked through `pnpm view`
 *   *in the profile directory*, exactly like the official page's own preflight,
 *   so the profile's registry, proxy and authentication all apply. `update`
 *   reports name@latest; `upgrade` hands the spec to the official plugin
 *   manager's `installBundle(name)`, which runs pnpm — the only way to install
 *   a registry tree.
 * - **file packages** (`.dpk` archives) — the upstream is the directory the
 *   package came from (the ledger records each source), plus any directory the
 *   caller names. A scan costs milliseconds, so nothing is cached and `upgrade`
 *   installs the newer `.dpk` itself, without pnpm.
 *
 * @module dpk/lib/upgrade
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { localizeName } from './dsh-package.mjs'
import { installedProfileVersion, referencedDigests, registryRows } from './profile-install.mjs'
import { compareVersions } from './versions.mjs'
import { readIndex, storeDir } from './store.mjs'
import { readArchiveManifest } from './verify.mjs'

/** One line of a scan failure, so a half-written build artifact cannot break the run. */
function reason(error) {
  return String(error instanceof Error ? error.message : error)
}

/**
 * The newest `.dpk` per package name across some directories.
 * @returns `{ best, warnings }`; `best` is `Map<localized name, { name, version, file }>`.
 */
async function scanCandidates(directories) {
  const best = new Map()
  const warnings = []
  for (const directory of directories) {
    let names
    try {
      names = await readdir(directory)
    } catch (error) {
      warnings.push(`${directory}: unreadable (${reason(error)})`)
      continue
    }
    for (const name of names.filter(entry => entry.toLowerCase().endsWith('.dpk')).sort()) {
      const file = join(directory, name)
      try {
        const manifest = readArchiveManifest(await readFile(file))
        const key = localizeName(manifest.name)
        const current = best.get(key)
        if (current === undefined || compareVersions(manifest.version, current.version) > 0) {
          best.set(key, { name: manifest.name, version: manifest.version, file })
        }
      } catch (error) {
        warnings.push(`${file}: not a readable .dpk (${reason(error)})`)
      }
    }
  }
  return { best, warnings }
}

/**
 * What one installed package currently is: the store copy's own version, which
 * is immutable per digest (the ledger's copy is provenance, not the authority).
 */
async function installedVersion(root, digest, ledgerVersion) {
  try {
    const manifest = JSON.parse(await readFile(join(storeDir(root, digest), 'package', 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string') return manifest.version
  } catch (_unreadable) {
    // Fall through to the ledger's record of the same install.
  }
  return ledgerVersion ?? null
}

/** The un-scoped registry name a package would be published under: `example-provider`. */
export function registryName(name) {
  return String(name).replace(/^@[^/]+\//, '')
}

/**
 * Read the world and describe every upgrade that is available.
 *
 * Read-only: directory scans and registry lookups, never a write.
 *
 * @param options - `{ home, root, directory, view }`; `directory` adds one place
 * to look beyond the directories the installed packages came from, and `view`
 * is an async `(profile, name) => { version } | null` that asks the npm
 * registry about one package name — the tool wires it to `pnpm view` through
 * the official plugin manager, so a registry lookup only happens when a
 * profile's manager can answer.
 * @returns `{ plan, upgradable, directories, warnings }`, where each plan row is
 * `{ profile, name, digest, current, available, file, from, upgrade }`; `from`
 * is `'registry'` or `'file'`.
 */
export async function planUpgrades(options) {
  const root = options.root
  const index = await readIndex(root)
  const { rows } = await referencedDigests({ home: options.home, root })
  const ledgerVersion = new Map(index.entries.map(entry => [entry.digest, entry.version]))

  const wanted = new Set()
  const warnings = []
  for (const entry of index.entries) {
    if (typeof entry.source !== 'string' || entry.source === '') continue
    if (!/\.dpk$/i.test(entry.source)) continue
    const directory = dirname(resolve(entry.source))
    if (existsSync(directory)) wanted.add(directory)
    else warnings.push(`${entry.source}: the directory this package came from is gone`)
  }
  if (typeof options.directory === 'string' && options.directory !== '') wanted.add(resolve(options.directory))
  const directories = [...wanted].sort()

  const { best, warnings: scanWarnings } = await scanCandidates(directories)
  warnings.push(...scanWarnings)

  // One registry question per package name, shared by every profile that
  // resolves it: the answer does not depend on who asks.
  const registryVersions = new Map()
  const versions = new Map()
  // Names with a registry-spec row anywhere in the profiles: these are npm
  // packages (the official page's installs), and only they get asked.
  const npmNames = new Set((await registryRows({ home: options.home })).rows.map(row => row.name))
  const plan = []
  for (const row of rows) {
    if (!versions.has(row.digest)) {
      versions.set(row.digest, await installedVersion(root, row.digest, ledgerVersion.get(row.digest)))
    }
    const current = versions.get(row.digest)
    const key = localizeName(row.name)
    let from = 'file'
    let available = best.get(key)?.version ?? null
    let file = best.get(key)?.file ?? null

    // A .dpk-only package (a file: source, no npm presence) has nothing to ask
    // the registry: asking would burn a network round trip on packages that can
    // never upgrade from there. Only a package that also lives on npm — the
    // registryRows() collected from the same profiles — gets asked.
    if (available === null && typeof options.view === 'function' && npmNames.has(registryName(row.name))) {
      const registryKey = registryName(row.name)
      if (!registryVersions.has(registryKey)) {
        try {
          registryVersions.set(registryKey, await options.view(row.profile, registryName(row.name)))
        } catch (error) {
          warnings.push(`registry ${row.profile}/${registryName(row.name)} unavailable: ${reason(error)}`)
          registryVersions.set(registryKey, null)
        }
      }
      const answer = registryVersions.get(registryKey)
      if (answer !== null && answer !== undefined) {
        from = 'registry'
        available = typeof answer?.version === 'string' ? answer.version : null
      }
    }

    plan.push({
      profile: row.profile,
      name: row.name,
      digest: row.digest,
      current,
      available,
      file,
      from,
      upgrade: available !== null && current !== null && compareVersions(available, current) > 0,
    })
  }

  // Packages the official Plugins page installed: registry-spec rows with no
  // digest, running from the profile's own node_modules. Their whole lifecycle
  // is a registry question, so without this loop `update` would be deaf to
  // every package dpk did not put there itself.
  if (typeof options.view === 'function') {
    const { rows: specRows } = await registryRows({ home: options.home })
    for (const row of specRows) {
      // A dpk-managed row (link: into the store) is already covered by the
      // digest plan above; `file:` rows have no registry upstream at all.
      const scoped = localizeName(row.name)
      if (rows.some(digestRow => digestRow.profile === row.profile && localizeName(digestRow.name) === scoped)) continue
      const profileDir = join(resolve(options.home), 'profiles', row.profile)
      const current = await installedProfileVersion({ profileDir, name: row.name })
      const registryKey = `spec:${row.name}`
      if (!registryVersions.has(registryKey)) {
        try {
          registryVersions.set(registryKey, await options.view(row.profile, row.name))
        } catch (error) {
          warnings.push(`registry ${row.profile}/${row.name} unavailable: ${reason(error)}`)
          registryVersions.set(registryKey, null)
        }
      }
      const answer = registryVersions.get(registryKey)
      const available = typeof answer?.version === 'string' ? answer.version : null
      plan.push({
        profile: row.profile,
        name: row.name,
        digest: null,
        current,
        available,
        file: null,
        from: 'registry',
        upgrade: available !== null && current !== null && compareVersions(available, current) > 0,
      })
    }
  }
  return { plan, upgradable: plan.filter(row => row.upgrade), directories, warnings }
}
