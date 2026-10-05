/**
 * Installation: verify → materialise into the local store → make the profile
 * hold it.
 *
 * dpk owns transport and integrity. Making the profile hold the package has two
 * implementations: the default writes the four things the Harness loader reads
 * (dependency row, `dsh.profile.bundles`, `node_modules` link, lockfile row)
 * through `profile-install.mjs` with no pnpm run, and `service` hands the store
 * directory to the official plugin manager service, which runs pnpm in the
 * profile. A package that declares runtime `dependencies` needs the latter.
 *
 * The steps are ordered so that no observable half-install exists. Managed
 * volumes are materialised before the profile is touched, and the profile write
 * — the commit point the loader reads at the next start — is atomic (a temp
 * file renamed over `package.json`). A failure anywhere in between removes the
 * copy this call placed and leaves the profile as it was.
 *
 * @module dpk/lib/install
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { localizeName } from './dsh-package.mjs'
import { verifyArchive, inspectArchive } from './verify.mjs'
import { readZipEntry } from './zip.mjs'
import { cacheDir, pruneCache, stageIn } from './staging.mjs'
import { PACKAGE_PREFIX } from './dpk-manifest.mjs'
import { recordInstall, storeDir, dpkRoot, defaultDshHome } from './store.mjs'
import { materializeVolumes, parseDataDeclaration } from './data.mjs'
import { detectProfileName, disableReleaseAgeCooldown } from './profile-policy.mjs'
import { applyProfileInstall, installedState, referencedDigests } from './profile-install.mjs'

/** An install that could not complete. */
export class DpkInstallError extends Error {
  constructor(message, code = 'DPK_INSTALL_FAILED', detail = {}) {
    super(message)
    this.name = 'DpkInstallError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Drive one install through the official manager, retrying as remove+install
 * when the manager cannot see a change: re-importing the very same digest
 * leaves the dependency row identical, and the official installer's diff then
 * answers `ambiguous-install` instead of installing. Removing the bundle first
 * turns the re-import into an ordinary install, so importing over an existing
 * installation — same version or newer — always succeeds.
 *
 * The remove half is not always available: a profile bundle that the manager
 * considers live answers `not-removable`, so the retry cannot be the only way
 * out of `ambiguous-install`. When the caller can prove the desired end state
 * already holds (`options.isSatisfied`), that answer is reported as
 * `unchanged` — before the manager is called at all, and again if the manager
 * answers ambiguous anyway. Nothing is removed in that case.
 *
 * @param manager - the plugin manager service (`installBundle`/`removeBundle`).
 * @param packageDir - the absolute store directory to install.
 * @param packageName - the bundle name the manager knows the package by.
 * @param options - `isSatisfied: () => Promise<boolean>`; true means the profile
 * already resolves exactly this directory, so the manager has nothing to do.
 * @returns the last install outcome; throws nothing the caller would not.
 */
export async function installOverwriting(manager, packageDir, packageName, options = {}) {
  const alreadySatisfied = async () => options.isSatisfied !== undefined
    && await options.isSatisfied() === true
  if (await alreadySatisfied()) {
    return { application: 'unchanged', unchanged: true }
  }
  const isAmbiguous = outcome => outcome?.application === 'failed'
    && [outcome.error?.diagnostic, outcome.error?.code]
      .some(field => typeof field === 'string' && field.includes('ambiguous-install'))
  let outcome = await manager.installBundle(packageDir, {})
  if (isAmbiguous(outcome)) {
    // The row cannot be diffed, which is exactly what "this digest is already
    // the installed dependency" looks like from the manager's side.
    if (await alreadySatisfied()) {
      return { application: 'unchanged', unchanged: true, manager: outcome.application }
    }
    const removed = await manager.removeBundle(packageName)
    if (removed?.application === 'failed') {
      throw new Error(`dpk: removing the previous installation failed: ${removed.error?.diagnostic ?? removed.error?.code ?? 'unknown failure'}`)
    }
    outcome = await manager.installBundle(packageDir, {})
  }
  return outcome
}

/**
 * The installer both callers of `via: "service"` share: the session tool and
 * the panel hand the store directory to the official plugin manager service,
 * with the same overwrite-tolerant behaviour and the same failure shape.
 *
 * @param manager - the plugin manager service, or undefined when not composed.
 * @param packageDir - the absolute store directory to install.
 * @param meta - `{ name, isSatisfied }` from the action layer.
 * @param options - `reason`: short phrase naming who asked, for error text.
 * @returns the install outcome; throws when the manager is absent or failed.
 */
export async function serviceInstall(manager, packageDir, meta, options = {}) {
  const reason = options.reason ?? 'install'
  if (manager === undefined) {
    throw new Error(`dpk: the plugin manager service is not composed, so nothing was installed. Run: plugin_manager action=install_bundle target=${packageDir}`)
  }
  const outcome = await installOverwriting(manager, packageDir, meta.name, {
    isSatisfied: meta.isSatisfied,
  })
  if (outcome?.application === 'failed') {
    throw new Error(`dpk: ${reason} failed: ${outcome.error?.diagnostic ?? outcome.error?.code ?? 'unknown failure'}`)
  }
  return outcome
}

/**
 * Place one package into the content-addressed store.
 *
 * `populate(directory)` is what actually fills the staging tree, so the caller
 * chooses how the bytes get there: the verifier can write them while it checks
 * their hashes (`verifyArchive(..., { extractTo })`), which is one
 * decompression and one write instead of two of each.
 *
 * @param root - the dpk root (`<home>/dpk`).
 * @param manifest - the verified manifest; its digest names the store entry.
 * @param populate - fills the staging package directory.
 * @param options - `{ reinstall }`.
 * @returns `{ digest, packageDir, created, root }`; `created: false` means the digest was already present.
 */
export async function placeStoreTree(root, manifest, populate, options = {}) {
  const digest = manifest.integrity.digest
  const target = storeDir(root, digest)
  const packageDir = join(target, 'package')
  if (existsSync(join(packageDir, 'package.json')) && options.reinstall !== true) {
    return { digest, packageDir, created: false, root }
  }

  const cache = cacheDir(root)
  const staging = await stageIn(cache, digest, 'tmp')
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, 'package'), { recursive: true })
  // Staging now lives in `cache/`, so the store directory it is renamed into
  // has to exist first.
  await mkdir(dirname(target), { recursive: true })
  // A target that is already there (a `reinstall`, or a digest whose stored
  // package.json went missing) is moved aside rather than deleted first: a
  // delete leaves the digest in no resolvable form at all, and a crash right
  // there breaks every profile that links it. The displaced directory carries a
  // staging name, so a crash before its cleanup leaves it collectable by
  // `autoremove` instead of lost.
  let displaced
  try {
    await populate(join(staging, 'package'))
    await localizeStoredPackage(join(staging, 'package'), manifest)
    if (existsSync(target)) {
      displaced = await stageIn(cache, `displaced-${digest}`, 'tmp')
      await rename(target, displaced)
    }
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (displaced !== undefined) {
      // Put the displaced copy back when the target is not holding a copy of
      // its own (the digest is content-addressed, so whatever is there now has
      // the same content either way).
      if (existsSync(target)) await rm(displaced, { recursive: true, force: true }).catch(() => {})
      else await rename(displaced, target).catch(() => {})
    }
    await pruneCache(cache)
    throw error
  }
  if (displaced !== undefined) await rm(displaced, { recursive: true, force: true })
  await pruneCache(cache)
  return { digest, packageDir, created: true, root }
}

/**
 * The dependency names a package declares in its own `package.json`, read from
 * the archive so the install path can be chosen before anything is extracted.
 *
 * A package with runtime dependencies needs pnpm: linking the store directory
 * gives the profile the package, not the registry tree that package expects.
 */
function declaredDependencies(bytes, index) {
  const entry = index.entries.find(item => item.path === `${PACKAGE_PREFIX}package.json` && !item.path.endsWith('/'))
  if (entry === undefined) return []
  try {
    const manifest = JSON.parse(readZipEntry(bytes, entry).toString('utf8'))
    const dependencies = manifest?.dependencies
    return dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
      ? Object.keys(dependencies)
      : []
  } catch (_unreadable) {
    return []
  }
}

/**
 * Install a `.dpk` file into a profile.
 *
 * Two modes, chosen by `installMode` (default: `service` when an `installer` is
 * passed or the package declares runtime `dependencies`, otherwise `profile`):
 *
 *  - `profile` — dpk writes the profile itself: dependency row, bundle list,
 *    `node_modules` link and lockfile row. No pnpm, no plugin manager service,
 *    and it works while the app is running (a live bundle cannot be removed
 *    through the official service at all: `not-removable`). The new package is
 *    live after the next Harness start. It cannot install a registry dependency
 *    tree, so a package that declares `dependencies` takes the other path.
 *  - `service` — the official plugin manager service installs it (it runs pnpm
 *    in the profile), which is what the official Plugins page does.
 *
 * @param options - `file`, `profile`, `home`, `reinstall`,
 * `installMode`, `installer` (async `(packageDir, meta) => outcome`), `log`.
 * @returns a structured result describing every step.
 */
export async function installArchive(options) {
  const log = options.log ?? (() => {})
  const bytes = options.buffer ?? await readFileBytes(options.file)

  const root = options.root ?? dpkRoot(options.home)
  // Identity first, without paying for content: the digest decides both the
  // store path and whether the store already holds this package.
  const inspected = inspectArchive(bytes)
  const { manifest } = inspected
  const digest = manifest.integrity.digest
  const packageDir = join(storeDir(root, digest), 'package')
  const stored = existsSync(join(packageDir, 'package.json'))
  // The profile this install targets comes from the explicit argument; the
  // ambient DSH variables describe the *running* session's profile, which a
  // Host-provided tool call must never silently retarget (a test inside DSH,
  // or an install into another profile, would write policy into this one).
  const home = options.home ?? process.env.DSH_HOME ?? defaultDshHome()
  const profile = options.profile
    ?? process.env.DSH_PROFILE
    ?? detectProfileName(home)
    ?? 'default'
  // A package with runtime dependencies needs pnpm: linking the store directory
  // gives the profile the package, not the registry tree it expects. That is the
  // one thing the self-contained path cannot do, so it is decided here, before
  // anything is written, and reported either way.
  const dependencies = declaredDependencies(bytes, inspected.index)
  const requested = options.installMode
  const mode = requested ?? (typeof options.installer === 'function' ? 'service' : dependencies.length > 0 ? 'service' : 'profile')
  if (requested === 'profile' && dependencies.length > 0) {
    log(`warn     ${manifest.name} declares dependencies (${dependencies.join(', ')}); their registry tree is not installed by the profile write`)
  }
  if (requested === undefined && dependencies.length > 0) {
    log(`mode     service: ${manifest.name} declares dependencies (${dependencies.join(', ')}), which only pnpm can resolve`)
  }

  // Two fast paths, both about not paying twice for the same bytes:
  //  - reuse: this digest is already in the store, so its DSH conformance was
  //    settled when it was placed; re-hashing the archive is enough to prove we
  //    are looking at that same content again.
  //  - cold: verify *into* the store staging tree, so the package is written
  //    once instead of once into a temp dir and once into the store.
  let verified
  let placed
  log(`verify   ${options.file}`)
  if (stored && options.reinstall !== true) {
    verified = await verifyArchive(bytes, { deep: false, inspected })
    verified.warnings.push(`deep check skipped: digest ${digest} is already in the store (its DSH conformance was settled when it was placed)`)
    placed = { digest, packageDir, created: false, root }
    log(`reuse   store/${digest}/package`)
    log(`verify   content re-hashed; deep DSH check covered by the stored copy of ${digest.slice(0, 12)}…`)
  } else {
    placed = await placeStoreTree(root, manifest, async (directory) => {
      verified = await verifyArchive(bytes, { deep: true, extractTo: directory, inspected })
    }, {
      reinstall: options.reinstall === true,
    })
    log(`unpack  store/${placed.digest}/package`)
  }

  // Two ways to make the profile hold this package. The default writes the
  // profile directly — dependency row, `dsh.profile.bundles`, the
  // `node_modules` link and the lockfile row are exactly what the Harness
  // loader reads, and pnpm is only transport. `service` keeps the official
  // plugin manager path (it runs pnpm in the profile) for callers that want the
  // official machinery, e.g. to build native addons or resolve registry peers.
  const profileDir = join(home, 'profiles', profile)
  const packageName = localizeName(manifest.name)

  // Managed data volumes (SPEC §13): the declaration is re-read from the
  // stored package.json (the single authoritative copy; the manifest's `dsh`
  // duplicate was validated at verify time).
  //
  // They are materialised *before* the profile is touched, which inverts
  // dpkg's unpack-then-conffile order for one reason: dpk's profile write is
  // the commit point — the thing the loader reads at the next start — and it
  // must not become visible while anything it needs is still missing. In this
  // order a volume that cannot be materialised aborts the install with the
  // previous version still fully in charge, instead of leaving the profile
  // pointing at a version whose declared files were never placed.
  const volumes = parseDataDeclaration(
    JSON.parse(await readFile(join(placed.packageDir, 'package.json'), 'utf8')).dsh?.data,
    `${manifest.name}: package.json`,
  )
  let volumeOutcomes = []
  let installOutcome
  let appliedChanged = false
  try {
    if (volumes.length > 0) {
      volumeOutcomes = await materializeVolumes(home, packageName, volumes, placed.packageDir, { log })
      for (const outcome of volumeOutcomes) {
        if (outcome.action === 'kept-local') {
          log(`data     ${outcome.path}: kept the local copy; the new seed is staged at ${outcome.staged}`)
        }
      }
    }
    if (mode === 'service') {
      // The official installer runs pnpm in the profile, which revalidates every
      // registry dependency there; the release-age cooldown could refuse freshly
      // published ones (this manager included). The import is deliberate and
      // digest-verified, so opt the profile out before pnpm starts. A policy we
      // cannot write only risks the cooldown, never the install itself.
      try {
        if (await disableReleaseAgeCooldown(profileDir)) {
          log(`policy   minimumReleaseAge: 0 -> ${join(profileDir, 'pnpm-workspace.yaml')}`)
        }
      } catch (error) {
        log(`policy   could not update ${join(profileDir, 'pnpm-workspace.yaml')}: ${String(error instanceof Error ? error.message : error)}`)
      }
      if (typeof options.installer !== 'function') {
        throw new DpkInstallError(
          dependencies.length > 0
            ? `${manifest.name} declares dependencies (${dependencies.join(', ')}), which need pnpm; install it with via: "service".\n`
              + `Equivalent call: plugin_manager action=install_bundle target=${placed.packageDir}`
            : 'installMode "service" needs an installer: the official plugin manager service.\n'
              + `Equivalent call: plugin_manager action=install_bundle target=${placed.packageDir}`,
          'DPK_NO_INSTALLER',
          { packageDir: placed.packageDir, profile, dependencies },
        )
      }
      // What "already installed" means is a fact about the profile, not about the
      // ledger, so it is read from the same files the loader reads.
      const state = await installedState({ home, profile, packageName, packageDir: placed.packageDir })
      log(`install  plugin manager service -> ${placed.packageDir}`)
      installOutcome = await options.installer(placed.packageDir, {
        name: manifest.name,
        version: manifest.version,
        digest: placed.digest,
        isSatisfied: async () => state.installed,
      })
      if (installOutcome?.unchanged === true) {
        log(`unchanged the profile already resolves store/${placed.digest}/package; pnpm was not run`)
      }
    } else {
      const applied = await applyProfileInstall({ home, profile, packageName, packageDir: placed.packageDir })
      appliedChanged = applied.changed
      installOutcome = {
        application: applied.changed ? 'applied' : 'unchanged',
        changed: applied.changed,
        unchanged: !applied.changed,
        linkPath: applied.linkPath,
        lockfile: applied.lockfile,
      }
      log(`${applied.changed ? 'write  ' : 'unchanged '} profile ${profile}: ${packageName} -> store/${placed.digest}/package`)
      if (applied.lockfile === 'unrecognised') {
        log(`warn     ${join(profileDir, 'pnpm-lock.yaml')} has a shape dpk does not patch; the next pnpm run will rewrite that row`)
      }
      // The profile write makes the package loadable, not loaded: the Harness
      // reads the profile when it starts. The official service can apply it to
      // the running process — `setBundleEnabled` reconciles a profile the
      // runtime already owns, with no pnpm run — so ask it to, and let its
      // answer decide whether the running Harness still needs a restart. A
      // service that is not composed, or refuses, costs nothing: the write is
      // already committed.
      const appliedLive = await applyToRunning(options.apply, packageName, true, log)
      if (appliedLive !== undefined) {
        installOutcome.application = appliedLive.application ?? installOutcome.application
        installOutcome.live = appliedLive.application === 'applied'
      }
    }
  } catch (error) {
    // Nothing half-installed survives: the copy this call placed goes, so a
    // failed install leaves the store exactly as it found it (the profile was
    // never touched — the commit is the last write above, and it is atomic).
    await discardPlacedCopy({ home, root, digest: placed.digest, created: placed.created, log })
    throw error
  }

  // Only a run that changed what the Harness loads may move `installedAt`: the
  // panel turns "an entry newer than this process started" into a restart
  // prompt, and refreshing a data volume is not a reason to restart. So this
  // asks exactly what the loader would see differently: a new store copy, or a
  // profile it has to re-read.
  const wroteSomething = placed.created === true
    || (mode === 'service' ? installOutcome?.changed === true : appliedChanged)
  // `live` is the difference between "installed" and "installed and in force":
  // the service path applies as it installs, and the profile path asked it to
  // apply above. Either way the ledger records it, so the panel does not ask
  // for the restart the install no longer needs.
  const live = mode === 'service'
    ? installOutcome?.application === 'applied'
    : installOutcome?.live === true
  await recordInstall(root, {
    // The store copy was localized, so the ledger carries the same name the
    // profile dependency does — a legacy unscoped archive lands as @local/….
    name: packageName,
    version: manifest.version,
    digest: placed.digest,
    source: options.file,
    refresh: wroteSomething,
    live,
  })
  log(`record   ${join(root, 'index.json')}`)
  return {
    ...verified, ...placed, profile, via: mode, command: null,
    created: placed.created,
    volumes: volumeOutcomes,
    installOutcome: installOutcome ?? null,
    unchanged: installOutcome?.unchanged === true,
    live,
  }
}

/**
 * Ask the official service to apply a profile change to the running Harness.
 *
 * `setBundleEnabled` is a reconcile, not an install: it persists the entry's
 * enablement and loads or unloads it on a live profile (`hmr` composed), which
 * is why dpk's zero-pnpm profile path can be exactly as immediate as the
 * official installer's. It runs no pnpm and touches no registry.
 *
 * A failure is reported, never fatal: the profile write is already committed,
 * and the worst case is the restart that used to be the only case.
 *
 * @param apply - `(name, enabled) => Promise<{ application }>`, or undefined.
 * @param name - the bundle name the service knows the package by.
 * @param enabled - true to load, false to unload.
 * @param log - progress sink.
 * @returns the service's outcome, or undefined when there is no service to ask.
 */
async function applyToRunning(apply, name, enabled, log) {
  if (typeof apply !== 'function') return undefined
  try {
    const outcome = await apply(name, enabled)
    if (outcome === undefined || outcome === null) return undefined
    log(`live     ${name}: ${outcome.application === 'applied'
      ? 'applied to the running Harness'
      : `application ${String(outcome.application ?? 'unknown')}`}`)
    return outcome
  } catch (error) {
    log(`warn     could not apply ${name} to the running Harness: ${String(error instanceof Error ? error.message : error)}`)
    return undefined
  }
}

/**
 * Undo the store placement of an install that did not complete.
 *
 * Only a copy *this call created* is a candidate, and only while no profile
 * resolves it: the digest is content-addressed, so another profile may have
 * installed the very same package before or concurrently, and its copy must
 * survive this call's failure. Leaving the directory is recoverable
 * (`autoremove` collects it); deleting a copy someone loads is not.
 *
 * @param options - `{ home, root, digest, created, log }`.
 */
async function discardPlacedCopy(options) {
  if (options.created !== true) return
  try {
    const { references } = await referencedDigests({ home: options.home, root: options.root })
    if (references.has(options.digest)) return
    await rm(storeDir(options.root, options.digest), { recursive: true, force: true })
    options.log?.(`undo     store/${options.digest.slice(0, 12)}/package (the install did not complete)`)
  } catch (error) {
    // The rollback is best effort: the caller is already reporting the real
    // failure, and an unreferenced copy is collectable by `autoremove`.
    options.log?.(`undo     could not remove store/${options.digest.slice(0, 12)}/package: ${String(error instanceof Error ? error.message : error)}`)
  }
}

/**
 * Re-scope the stored package copy: a source package whose name lacks the
 * local scope is installed under `@local/…`, so the profile dependency, the
 * ledger, and the panel all carry one name. The loader matches bundle rows by
 * `name`, so the patch rows naming the package follow; row ids and the
 * module's own registration id stay as built (the working
 * `@local/dsh-reverse-skill` layout), which means a package with a client
 * half must already ship scoped client ids (see `@local/example-provider`).
 * @param packageDir - the freshly extracted store copy, rewritten in place.
 * @param manifest - the verified dpk manifest whose `name` is already localized.
 */
async function localizeStoredPackage(packageDir, manifest) {
  const manifestPath = join(packageDir, 'package.json')
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  const original = raw.name
  const local = localizeName(original)
  if (local === original) return
  raw.name = local
  await writeFile(manifestPath, `${JSON.stringify(raw, undefined, 2)}\n`)
  const patchPath = join(packageDir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    // Loader rows match the package by `name`; retarget every row that names
    // the package. Ids, configs, and other values are left untouched.
    const pattern = new RegExp(`(name\\s*:\\s*['"]?)${escapeRegExp(original)}(['"]?\\s*)$`, 'gm')
    const patch = await readFile(patchPath, 'utf8')
    await writeFile(patchPath, patch.replace(pattern, `$1${local}$2`))
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read a file with a dpk-flavoured error. */
async function readFileBytes(file) {
  try {
    return await readFile(file)
  } catch (error) {
    throw new DpkInstallError(`cannot read ${file}: ${String(error)}`, 'DPK_READ_FAILED')
  }
}
