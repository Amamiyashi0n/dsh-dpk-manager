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
 * The four methods are driven by a human in the browser, exactly like the
 * official Plugins page: installation runs through the same `pluginManager`
 * service the page already uses (`installBundle`), so no tool-level sandbox
 * escalation applies here — that gate protects *model* actions, not the user's
 * own button.
 *
 * @module dpk/host-service
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runDpkAction } from './lib/actions.mjs'
import { packDirectory } from './lib/pack.mjs'
import { latestByName, latestEntry, matchEntries, readIndex, removeStoreDir, storeDir, writeIndex, defaultDshHome} from './lib/store.mjs'
import { dpkRoot } from './lib/store.mjs'
import { detectProfileName } from './lib/profile-policy.mjs'

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
  /** This service serves the profile whose node_modules physically holds this package. */
  const profileName = () => process.env.DSH_PROFILE ?? detectProfileName(home) ?? 'default'

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
      return {
        store: dpkRoot(home),
        entries: latestByName(index.entries).map(entry => ({
          name: entry.name,
          version: entry.version,
          digest: entry.digest,
          installedAt: entry.installedAt,
          source: entry.source,
          profiles: entry.profiles,
          installed: byName.get(entry.name)?.installed === true,
          enabled: byName.get(entry.name)?.enabled === true,
        })),
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

      const incoming = join(dpkRoot(home), 'incoming')
      await mkdir(incoming, { recursive: true })
      const path = join(incoming, `${Date.now()}-${fileName.replace(/[^\w.@-]+/gu, '_')}`)
      await writeFile(path, bytes)
      try {
        const manager = ctx.get('pluginManager')
        if (manager === undefined) throw new Error('dpk: the plugin manager service is not composed')
        const result = await runDpkAction('install', { file: path }, {
          home,
          profile: profileName(),
          installer: async (packageDir) => {
            const outcome = await manager.installBundle(packageDir, {})
            if (outcome?.application === 'failed') {
              throw new Error(`dpk: install failed: ${outcome.error?.diagnostic ?? outcome.error?.code ?? 'unknown failure'}`)
            }
            return outcome
          },
          log: message => { ctx.logger?.info?.(`dpk(ui): ${message.trim()}`) },
        })
        return { ...result.data, text: result.text }
      } finally {
        await rm(path, { force: true })
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
     * Uninstall a package through the official manager, forgetting this profile.
     * Nothing is retained: a ledger entry no profile references any more is
     * dropped together with its stored copy.
     * @param request - `{ name }`.
     */
    async removeArchive(request) {
      const name = String(request?.name ?? '')
      const root = dpkRoot(home)
      const manager = ctx.get('pluginManager')
      if (manager === undefined) throw new Error('dpk: the plugin manager service is not composed')
      const outcome = await manager.removeBundle(name)
      if (outcome?.application === 'failed') {
        throw new Error(`dpk: uninstall failed: ${outcome.error?.diagnostic ?? outcome.error?.code ?? 'unknown failure'}`)
      }
      const profile = profileName()
      const index = await readIndex(root)
      const dropped = []
      for (const entry of matchEntries(index.entries, name)) {
        entry.profiles = entry.profiles.filter(item => item !== profile)
        if (entry.profiles.length === 0) dropped.push(entry)
      }
      index.entries = index.entries.filter(entry => entry.profiles.length > 0)
      await writeIndex(root, index)
      for (const entry of dropped) await removeStoreDir(root, entry.digest)
      return { name, removed: true, pruned: dropped.length > 0, changed: outcome?.changed === true }
    }
  }

  for (const method of ['managed', 'importArchive', 'exportArchive', 'removeArchive']) markRemote(DpkRemoteService.prototype, method)
  const service = new DpkRemoteService()
  service.typertRemote = Object.freeze({
    service,
    serviceKey: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
  })
  ctx.provide(REMOTE_NAMESPACE, service)
  return service
}

/** Read a stored archive back as bytes (used by tests). */
export async function readStoredArchive(home, name) {
  const root = dpkRoot(home)
  const entry = latestEntry((await readIndex(root)).entries, name)
  if (entry === undefined) return undefined
  const bytes = await readFile(join(storeDir(root, entry.digest), 'dpk.json'))
  return { entry, manifest: JSON.parse(bytes.toString('utf8')) }
}
