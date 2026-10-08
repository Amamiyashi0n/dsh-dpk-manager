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
import { spawn as spawnChild } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runDpkAction } from './lib/cli.mjs'
import { serviceInstall } from './lib/install.mjs'
import { importDataVolumes, parseDataDeclaration } from './lib/data.mjs'
import { packInstalledDirectory } from './lib/pack.mjs'
import { inspectArchive } from './lib/verify.mjs'
import { readIndex, pendingRestarts, storeDir, defaultDshHome, dpkRoot, matchEntries } from './lib/store.mjs'
import { latestByName, latestEntry } from './lib/versions.mjs'
import { detectProfileName } from './lib/profile-policy.mjs'
import { referencedDigests } from './lib/profile-install.mjs'
import { isOfficialManagerName } from './lib/dsh-package.mjs'

/** Wire namespace: the browser calls `ctx.remote.dpk.<method>`. */
export const REMOTE_NAMESPACE = 'dpk'

/** Shared descriptor key read by the Typert Gateway in source mode. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Decoded upload ceiling; the DPK format itself caps content far below this. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024
const DSH_WEB_PORT = 3080
const DSH_WEB_READY_TIMEOUT_MS = 30_000

/**
 * Resolve the live Desktop Web Host endpoint. The Desktop Host stays on its
 * own port; the debug switch starts a second, official `dsh web` process on
 * the fixed Web port below.
 * @param ctx - plugin context carrying the current Web services.
 * @returns the loopback endpoint and its authenticated launch URL.
 */
function liveWebEndpoint(ctx) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || connection === undefined) {
    throw new Error('dpk: the DSH Web service is unavailable in this profile')
  }
  const port = webServer.port
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('dpk: the DSH Web service has not finished listening')
  }
  if (typeof connection.authenticatedUrl !== 'function') {
    throw new Error('dpk: the DSH connection cannot create an authenticated Web URL')
  }
  const baseUrl = `http://127.0.0.1:${String(port)}`
  return { port, url: connection.authenticatedUrl(baseUrl) }
}

/** Locate the packaged DSH CLI entry without depending on a shell launcher. */
function dshWebCommand() {
  const resources = typeof process.resourcesPath === 'string' && process.resourcesPath !== ''
    ? process.resourcesPath
    : join(dirname(process.execPath), 'resources')
  const runtimeRoot = process.env.DSH_DESKTOP_DSH_DIR ?? join(resources, 'app.asar', 'dsh')
  return {
    command: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? process.execPath,
    args: [
      '--expose-internals',
      join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
      'web', '--no-open', '--port', String(DSH_WEB_PORT),
    ],
  }
}

/** Start the official standalone Web profile and wait for its authenticated URL. */
function startDshWeb(home, spawnProcess) {
  const { command, args } = dshWebCommand()
  const child = spawnProcess(command, args, {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const append = chunk => { output = (output + String(chunk)).slice(-16 * 1024) }
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const ready = chunk => {
      append(chunk)
      const match = /(?:^|\s)dsh web:\s+(http:\/\/127\.0\.0\.1:3080\/\?[^\s]+)/u.exec(output)
      if (match !== null) finish(resolve, { child, port: DSH_WEB_PORT, url: match[1] })
    }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', ready)
    child.stderr?.on('data', ready)
    child.once('error', error => finish(reject, error))
    child.once('close', code => {
      if (!settled) finish(reject, new Error(`dpk: dsh web exited before readiness (code ${String(code)}): ${output.trim()}`))
    })
    timer = setTimeout(() => {
      finish(reject, new Error(`dpk: dsh web did not become ready within ${DSH_WEB_READY_TIMEOUT_MS}ms`))
      try { child.kill() } catch {}
    }, DSH_WEB_READY_TIMEOUT_MS)
  })
}

/** Stop only the standalone Web process created by this DPK service. */
async function stopDshWeb(state) {
  if (state === undefined || state.child === undefined) return
  const child = state.child
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5_000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill() } catch { clearTimeout(timer); resolve() }
  })
}

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
  const spawnProcess = config.spawnProcess ?? spawnChild
  let dshWebProcess
  let dshWebStart
  let debugGeneration = 0
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
    /** The external DSH Web handoff is opt-in and process-local by design. */
    debugMode = false

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
      // The manager is an official DSH plugin, never a local DPK package: filter
      // any legacy self-install records out so they never surface as local cards.
      const entries = index.entries.filter(entry => !isOfficialManagerName(entry.name))
      // Both answers come from their owner: "which profile uses this digest" is
      // read from the profiles, and "does the running Harness need a restart" is
      // read from the ledger's install times against this process's start.
      const { references } = await referencedDigests({ home, root: dpkRoot(home) })
      // The reminder names the packages, not just the fact: whichever the
      // running Harness has not loaded is what the next start will bring.
      const awaitingRestart = pendingRestarts(entries)
      const referenced = new Set([...references.keys()])
      const visible = entries.filter(entry => referenced.has(entry.digest))
      const visibleNames = new Set(visible.map(entry => entry.name))
      const unreferencedLatest = latestByName(entries).filter(entry => !visibleNames.has(entry.name))
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

    /** Return the Desktop Host and standalone dsh web state. */
    debugStatus() {
      if (dshWebProcess !== undefined
        && (dshWebProcess.child.exitCode !== null || dshWebProcess.child.signalCode !== null)) {
        dshWebProcess = undefined
        this.debugMode = false
      }
      let endpoint
      let error
      try {
        endpoint = liveWebEndpoint(ctx)
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason)
      }
      return {
        enabled: this.debugMode && dshWebProcess !== undefined,
        available: endpoint !== undefined,
        ...(endpoint === undefined ? { error } : { port: endpoint.port }),
        ...(this.debugMode && dshWebProcess !== undefined
          ? { dshWebPort: dshWebProcess.port, url: dshWebProcess.url }
          : {}),
      }
    }

    /** Start or stop the standalone dsh web debug profile. */
    async setDebugMode(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('dpk: debug mode expects a boolean')
      if (!enabled) {
        const generation = ++debugGeneration
        this.debugMode = false
        const running = dshWebProcess
        dshWebProcess = undefined
        const starting = dshWebStart
        await stopDshWeb(running)
        if (starting !== undefined) {
          void starting.then(state => {
            if (debugGeneration === generation) return stopDshWeb(state)
            return undefined
          }).catch(() => {})
        }
        let available = true
        let port
        try {
          const endpoint = liveWebEndpoint(ctx)
          port = endpoint.port
        } catch { available = false }
        return { enabled: false, available, ...(port === undefined ? {} : { port }) }
      }
      const endpoint = liveWebEndpoint(ctx)
      if (endpoint.port === DSH_WEB_PORT) {
        throw new Error('dpk: standalone dsh web is already the current Web Host')
      }
      const generation = ++debugGeneration
      if (dshWebProcess === undefined) {
        const starting = dshWebStart ?? (dshWebStart = startDshWeb(home, spawnProcess))
        try {
          const started = await starting
          if (generation !== debugGeneration) {
            await stopDshWeb(started)
            return { enabled: false, available: true, port: endpoint.port }
          }
          dshWebProcess = started
          dshWebProcess.child.once('close', () => {
            if (dshWebProcess?.child === started.child) {
              dshWebProcess = undefined
              this.debugMode = false
            }
          })
        } finally {
          if (dshWebStart === starting) dshWebStart = undefined
        }
      }
      this.debugMode = true
      return {
        enabled: true,
        available: true,
        port: endpoint.port,
        dshWebPort: dshWebProcess.port,
        url: dshWebProcess.url,
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
        // Validate the optional data payload before changing the profile. The
        // package install below still performs the full DSH verification.
        const inspected = inspectArchive(bytes)
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
        if (inspected.data !== undefined && inspected.data.files.length > 0) {
          const packageDir = result.data.storePath
          const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
          const volumes = parseDataDeclaration(packageJson.dsh?.data, `${result.data.name}: package.json`)
          await importDataVolumes(home, result.data.name, volumes, inspected.data.files, {
            log: message => { ctx.logger?.info?.(`dpk(ui): ${message.trim()}`) },
          })
        }
        return { ...result.data, text: result.text }
      } finally {
        await rm(incoming, { recursive: true, force: true })
      }
    }

    /**
     * Re-pack one package and attach its managed volumes as DPK data.
     *
     * `export` carries app volumes and `snap` carries app and data volumes.
     * Both results are `.dpk` archives and can be fed back to the import action.
     *
     * @param request - `{ name, verb }`.
     */
    async exportVolumes(request) {
      const requested = String(request?.name ?? '')
      const verb = request?.verb
      if (verb !== 'export' && verb !== 'snap') throw new Error('dpk: exportVolumes needs verb "export" or "snap"')
      // Resolve the name first so the file is named after the package the ledger
      // records, not after whatever spelling the caller passed (`pkg@1.0.0`).
      const entries = (await readIndex(dpkRoot(home))).entries.filter(entry => !isOfficialManagerName(entry.name))
      const entry = latestEntry(entries, requested)
      if (entry === undefined) throw new Error(`dpk: no stored package matches ${requested}`)

      const packageDir = storeDir(dpkRoot(home), entry.digest) + '/package'
      const packed = await packInstalledDirectory(packageDir, {
        home,
        packageName: entry.name,
        classes: verb === 'export' ? ['app'] : undefined,
      })
      return {
        fileName: packed.fileName,
        base64: packed.buffer.toString('base64'),
        bytes: packed.buffer.length,
        name: entry.name,
        version: packed.manifest.version,
        digest: packed.manifest.integrity.digest,
        verb,
      }
    }

    /**
     * Re-pack an installed package from the store into a `.dpk` and hand it back.
     * @param request - `{ name, version? }` naming the ledger entry.
     */
    async exportArchive(request) {
      const root = dpkRoot(home)
      const requested = String(request?.name ?? '')
      const entries = (await readIndex(root)).entries.filter(entry => !isOfficialManagerName(entry.name))
      const entry = request?.version === undefined
        ? latestEntry(entries, requested)
        : matchEntries(entries, `${requested}@${request.version}`)[0]
      if (entry === undefined) throw new Error(`dpk: no stored package matches ${requested}`)
      const packageDir = storeDir(root, entry.digest) + '/package'
      const packed = await packInstalledDirectory(packageDir, {
        home,
        packageName: entry.name,
        classes: ['app'],
      })
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
      // A stale store link can still be visible to dpk after the official
      // manager no longer lists the package. Such a package has no running
      // bundle to unload; requiring a live result would stop cleanup before
      // the profile link and ledger row are removed. Active bundles stay strict:
      // a failed live unload must never leave code running after this action.
      let requireLive = true
      try {
        const manager = await Promise.resolve(ctx.get('pluginManager'))
        if (manager !== undefined && typeof manager.listBundles === 'function') {
          const bundle = (await manager.listBundles()).find(item => item.name === name)
          requireLive = bundle?.installed === true && bundle?.enabled === true
        }
      } catch {
        // Keep the strict default when the manager cannot describe its state.
      }
      const result = await runDpkAction('remove', { name }, {
        home,
        profile: profileName(),
        apply: requireLive ? apply : undefined,
        requireLive,
        log: message => { ctx.logger?.info?.(`dpk(ui): ${message.trim()}`) },
      })
      return { ...result.data, name, text: result.text }
    }
  }

  for (const method of ['managed', 'debugStatus', 'setDebugMode', 'importArchive', 'exportVolumes', 'exportArchive', 'removeArchive']) markRemote(DpkRemoteService.prototype, method)
  const service = new DpkRemoteService()
  service.typertRemote = Object.freeze({
    service,
    serviceKey: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
  })
  ctx.provide(REMOTE_NAMESPACE, service)
  return service
}
