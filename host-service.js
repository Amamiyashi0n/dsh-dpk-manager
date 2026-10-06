/**
 * Host half of the assistant's Web UI: a Typert Remote service the browser calls.
 *
 * The package is linked into a user profile, so importing Harness peer packages
 * from here would make activation depend on the linked directory's physical
 * dependency layout. Typert deliberately makes its source-mode contract
 * structural: a provided service exposes a `typertRemote` binding and a stable
 * prototype descriptor. Register those two pieces directly and keep this DPK
 * self-contained.
 *
 * The methods are driven by a human in the browser, exactly like the
 * official Plugins page: installation runs through the same `pluginManager`
 * service the page already uses (`installBundle`), so no tool-level sandbox
 * escalation applies here — that gate protects *model* actions, not the user's
 * own button.
 *
 * @module dpk/host-service
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { defaultExportName, runDpkAction } from './lib/actions.mjs'
import { serviceInstall } from './lib/install.mjs'
import { packDirectory } from './lib/pack.mjs'
import { readIndex, pendingRestarts, storeDir, defaultDshHome, dpkRoot, matchEntries } from './lib/store.mjs'
import { latestByName, latestEntry } from './lib/versions.mjs'
import { detectProfileName } from './lib/profile-policy.mjs'
import { referencedDigests } from './lib/profile-install.mjs'

/** Wire namespace: the browser calls `ctx.remote.dpk.<method>`. */
export const REMOTE_NAMESPACE = 'dpk'

/** Shared descriptor key read by the Typert Gateway in source mode. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Decoded upload ceiling; the DPK format itself caps content far below this. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024

/**
 * Add one direct Remote marker in the protocol's versioned structural format.
 * @param prototype - the class prototype to mark.
 * @param methodName - the public instance method name.
 */
function markRemote(prototype, methodName) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value
  const marker = Object.freeze({
    method: methodName,
    invocation: Object.freeze({ kind: 'direct' }),
  })
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
    }),
  })
}

/**
 * Build and register the remote service on the plugin's context.
 * @param ctx - plugin context (services available through `ctx.get`).
 * @param config - optional `home` override for the dpk store.
 * @returns the service instance registered as `dpk` in the current plugin fiber.
 */
export function createDpkRemoteService(ctx, config = {}) {
  const home = config.home ?? defaultDshHome()
  /** An omitted mode lets installArchive choose pnpm only when dependencies require it. */
  const installMode = config.installMode === 'service' || config.installMode === 'profile'
    ? config.installMode
    : undefined
  /** This service serves the profile whose node_modules physically holds this package. */
  const profileName = () => process.env.DSH_PROFILE ?? detectProfileName(home) ?? 'default'
  /** Apply direct profile changes to the running Harness when the service supports it. */
  const apply = async (name, enabled, profile) => {
    if (profile !== profileName()) return { application: 'restart-required', changed: false, profile }
    const manager = await Promise.resolve(ctx.get('pluginManager'))
    if (manager === undefined || typeof manager.setBundleEnabled !== 'function') return undefined
    return manager.setBundleEnabled(name, enabled)
  }

  class DpkRemoteService {
    /** Packages this assistant installed locally, joined with what the profile really holds. */
    async managed() {
      let bundles = []
      try {
        bundles = (await ctx.get('pluginManager')?.listBundles()) ?? []
      } catch {
        bundles = []
      }
      const byName = new Map(bundles.map(bundle => [bundle.name, bundle]))
      const index = await readIndex(dpkRoot(home))
      // Both answers come from their owner: "which profile uses this digest" is
      // read from the profiles, and "does the running Harness need a restart" is
      // read from the ledger's install times against this process's start.
      const { references } = await referencedDigests({ home, root: dpkRoot(home) })
      // The reminder names the packages, not just the fact: whichever the
      // running Harness has not loaded is what the next start will bring.
      const awaitingRestart = pendingRestarts(index.entries)
      const referenced = new Set([...references.keys()])
      const visible = index.entries.filter(entry => referenced.has(entry.digest))
      const visibleNames = new Set(visible.map(entry => entry.name))
      const unreferencedLatest = latestByName(index.entries).filter(entry => !visibleNames.has(entry.name))
      const managedEntries = [...visible, ...unreferencedLatest]
      return {
        store: dpkRoot(home),
        ...(awaitingRestart.length > 0
          ? {
              restartRequired: true,
              awaitingRestart: awaitingRestart.map(entry => ({ name: entry.name, version: entry.version })),
            }
          : {}),
        entries: managedEntries.map(entry => {
          // The card shows the version that actually runs: the profile's own
          // (possibly npm-updated) install wins over the ledger's record of
          // which .dpk generation was imported.
          const bundle = byName.get(entry.name)
          const installedVersion = bundle?.version
          const profiles = references.get(entry.digest) ?? []
          return {
            name: entry.name,
            version: installedVersion ?? entry.version,
            ...(installedVersion !== undefined && installedVersion !== entry.version
              ? { dpkVersion: entry.version }
              : {}),
            digest: entry.digest,
            installedAt: entry.installedAt,
            source: entry.source,
            profiles,
            profileState: profiles.length === 0 ? 'unreferenced' : `used by ${profiles.join(', ')}`,
            installed: bundle?.installed === true,
            enabled: bundle?.enabled === true,
          }
        }),
      }
    }

    /**
     * Verify an uploaded archive, unpack it into the local store and install it.
     * @param input - `{ fileName, base64 }` from the browser's file picker.
     */
    async importArchive(input) {
      const fileName = typeof input?.fileName === 'string' ? input.fileName : 'upload.dpk'
      if (!fileName.toLowerCase().endsWith('.dpk')) throw new Error('dpk: only .dpk archives can be imported')
      if (typeof input?.base64 !== 'string' || input.base64 === '') throw new Error('dpk: the uploaded archive is empty')
      const bytes = Buffer.from(input.base64, 'base64')
      if (bytes.length === 0) throw new Error('dpk: the uploaded archive is empty')
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`dpk: the uploaded archive exceeds ${MAX_UPLOAD_BYTES} bytes`)

      // The upload lands in the system temp directory, not in the dpk root: it
      // is transport for one call and must not survive it.
      const incoming = await mkdtemp(join(tmpdir(), 'dpk-incoming-'))
      const path = join(incoming, fileName.replace(/[^\w.@-]+/gu, '_'))
      await writeFile(path, bytes)
      try {
        const manager = ctx.get('pluginManager')
        // Self-contained by default: the panel writes the profile through dpk,
        // so an import costs no pnpm run and works while a bundle is live. The
        // official service stays available for callers that need it.
        const installer = installMode === 'service' || installMode === undefined
          ? (packageDir, meta) => serviceInstall(manager, packageDir, meta, {
              reason: 'install',
              currentProfile: profileName(),
            })
          : undefined
        const result = await runDpkAction('install', { file: path }, {
          home,
          profile: profileName(),
          currentProfile: profileName(),
          installer,
          installMode,
          profileByDefault: installMode === undefined,
          apply,
          requireLive: true,
          log: message => { ctx.logger?.info?.(`dpk(ui): ${message.trim()}`) },
        })
        return { ...result.data, text: result.text }
      } finally {
        await rm(incoming, { recursive: true, force: true })
      }
    }

    /**
     * Write one package's volumes to a data file and hand back its bytes.
     *
     * `verb` is the dpk verb that decides which classes travel: `export` carries
     * app volumes, `snap` carries app and data volumes. The file is built by the
     * same action the tool runs, in a scratch directory that does not survive the
     * call — the panel is transport, not a second implementation.
     *
     * @param request - `{ name, verb }`.
     */
    async exportVolumes(request) {
      const requested = String(request?.name ?? '')
      const verb = request?.verb
      if (verb !== 'export' && verb !== 'snap') throw new Error('dpk: exportVolumes needs verb "export" or "snap"')
      // Resolve the name first so the file is named after the package the ledger
      // records, not after whatever spelling the caller passed (`pkg@1.0.0`).
      const entry = latestEntry((await readIndex(dpkRoot(home))).entries, requested)
      if (entry === undefined) throw new Error(`dpk: no stored package matches ${requested}`)

      const outgoing = await mkdtemp(join(tmpdir(), 'dpk-outgoing-'))
      try {
        const output = join(outgoing, defaultExportName(verb, entry.name))
        const result = await runDpkAction(verb, { name: entry.name, output }, {
          home,
          log: message => { ctx.logger?.info?.(`dpk(ui): ${message.trim()}`) },
        })
        const bytes = await readFile(result.data.output)
        return {
          fileName: basename(result.data.output),
          base64: bytes.toString('base64'),
          bytes: bytes.length,
          name: entry.name,
          verb,
          text: result.text,
        }
      } finally {
        await rm(outgoing, { recursive: true, force: true })
      }
    }

    /**
     * Re-pack an installed package from the store into a `.dpk` and hand it back.
     * @param request - `{ name, version? }` naming the ledger entry.
     */
    async exportArchive(request) {
      const root = dpkRoot(home)
      const requested = String(request?.name ?? '')
      const entry = request?.version === undefined
        ? latestEntry((await readIndex(root)).entries, requested)
        : matchEntries((await readIndex(root)).entries, `${requested}@${request.version}`)[0]
      if (entry === undefined) throw new Error(`dpk: no stored package matches ${requested}`)
      const packageDir = storeDir(root, entry.digest) + '/package'
      const packed = await packDirectory(packageDir)
      return {
        fileName: packed.fileName,
        base64: packed.buffer.toString('base64'),
        bytes: packed.buffer.length,
        name: packed.manifest.name,
        version: packed.manifest.version,
        digest: packed.manifest.integrity.digest,
      }
    }

    /**
     * Remove a package through dpk. The official service must unload the bundle
     * first while the profile still contains it; only then are local profile and
     * store files removed.
     * @param request - `{ name }`.
     */
    async removeArchive(request) {
      const name = String(request?.name ?? '')
      // Reaching the next line means the profile really held the package: the
      // action throws otherwise, so no "removed: true" field is needed to say so.
      const result = await runDpkAction('remove', { name }, {
        home,
        profile: profileName(),
        apply,
        requireLive: true,
        log: message => { ctx.logger?.info?.(`dpk(ui): ${message.trim()}`) },
      })
      return { ...result.data, name, text: result.text }
    }
  }

  for (const method of ['managed', 'importArchive', 'exportVolumes', 'exportArchive', 'removeArchive']) markRemote(DpkRemoteService.prototype, method)
  const service = new DpkRemoteService()
  service.typertRemote = Object.freeze({
    service,
    serviceKey: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
  })
  ctx.provide(REMOTE_NAMESPACE, service)
  return service
}
