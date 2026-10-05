/**
 * DSH 安装包管理助手 — the `dpk` tool as a Host plugin.
 *
 * Registers one agent-facing tool, `dpk`, over the pure action layer in
 * `lib/actions.mjs`. Actions that change the profile or persistent data ask
 * for danger-full-access escalation first, through the same
 * `sandboxPolicy`/`approval` services the official `plugin_manager` tool uses;
 * read-only actions need no gate. Installation writes the profile itself by
 * default (no pnpm); `via: "service"` hands the store directory to the official
 * plugin manager service instead.
 *
 * This module deliberately imports **nothing** from the Harness: a profile
 * bundle is loaded by the Harness's own module loader, and bare imports of
 * Harness packages are not guaranteed to resolve there. Everything it needs
 * arrives through `ctx` (services) or is defined locally, which also keeps the
 * package self-contained enough to travel as a `.dpk`.
 *
 * @module dsh-dpk-manager
 */

import { DPK_ACTIONS, runDpkAction } from './lib/actions.mjs'
import { REMOTE_NAMESPACE, createDpkRemoteService } from './host-service.js'
import { serviceInstall } from './lib/install.mjs'
import { detectProfileName } from './lib/profile-policy.mjs'
import { defaultDshHome } from './lib/store.mjs'

/** Cordis plugin name. */
export const name = 'dsh-dpk-manager'
/** Tool registry the agent-facing tool registers into. */
export const inject = ['tools']

const TOOL = 'dpk'

/** The model-facing description; it names the gate and the ordering the model must follow. */
const DESCRIPTION = [
  'Manage DSH plugin packages with apt\'s high-level shape: update reports which installed packages have a newer .dpk available,',
  'upgrade installs those newer .dpk files, install adds a verified archive to the current profile, remove drops one from it,',
  'purge deletes a package\'s managed data, autoremove reclaims stored packages no profile references,',
  'list shows what dpk installed (with a loadability diagnosis), show describes one .dpk archive or one installed package',
  '(version, digest, store path, which profiles resolve it, and its managed data volumes).',
  'verify checks an archive before you trust it and build packs a package directory into one.',
  'A .dpk is a validated zip carrying one standard DSH package; verify before installing.',
  'install, upgrade, remove, purge and autoremove change this profile or persistent data and require danger-full-access permission or approval for the call;',
  'by default dpk writes the profile itself (dependency row, bundle list, node_modules link, lockfile row) with no pnpm run, and the change is live at the next Harness start;',
  'via "service" hands the install to the official plugin manager service instead, which runs pnpm in the profile.',
  'import writes carried volume files back at the class the package declares now.',
  'export carries app volumes, snap carries app and data volumes; each takes one package (name=) or every recorded package (all: true).',
  'pkg reads or adjusts one data file on disk (op=list/add/remove/set): its form follows how many packages it holds, so adding a second package promotes it to the archive form and removing down to one demotes it back, extension included.',
].join(' ')

/** The parameter schema, in the same implicit-object form the Harness compiles from tool specs. */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: DPK_ACTIONS, description: 'Operation to perform, named after the apt verb for it.' },
    file: { type: 'string', description: 'For install and verify: the .dpk to work on; for show: the .dpk to describe; for import: the data file to write back; for pkg: the data file to read or adjust.' },
    directory: { type: 'string', description: 'For build: the DSH package directory to pack. For update and upgrade: one extra directory of .dpk files to scan, beyond the directories the installed packages came from.' },
    output: { type: 'string', description: 'For build: the .dpk path to write, or a directory to write it into — an existing directory, or a path written with a trailing separator — in which case the standard <name>-<version>.dpk goes inside it and the directory is created if missing. Omit it and the archive goes to <package>/dpk-dist/<name>-<version>.dpk. For export/snap: the file path. Their defaults are under the working directory: <name>-data.json or <name>-snap.json for one package, dpks.dpks or snap.dpks for all.' },
    op: { type: 'string', enum: ['list', 'add', 'remove', 'set'], description: 'For pkg: list what the file carries (read-only), add a package to it from this machine\'s install (an entry already there is refreshed), remove one from it, or set — rename — the package name the file records for one entry (needs `to`). remove and set refuse a package the file does not carry.' },
    to: { type: 'string', description: 'For pkg op=set: the package name the file should carry from now on. The entry\'s volumes are untouched; a name that is not installed here is allowed and reported.' },
    verb: { type: 'string', enum: ['export', 'snap'], description: 'For pkg op=add: which volumes of the package the file takes — "snap" (the default) carries app and data volumes, "export" carries app volumes only.' },
    createdAt: { type: 'string', description: 'For build: RFC 3339 timestamp recorded as the manifest createdAt. Default writes the fixed reproducible epoch; "now" records the real build time (the archive then stops being byte-reproducible).' },
    timestamp: { type: 'string', description: 'For build: ISO timestamp for the zip entry times, between 1980 and 2107. Default is the DOS epoch that makes builds byte-reproducible.' },
    name: { type: 'string', description: 'For show/export/snap/purge/remove: a package name, optionally name@version; a @local/ package may be named by its own name or by the scoped one. For export/snap it selects the one package the single-package file is about. For import: not needed for a single-package file (it names its own package); for a .dpks archive it selects one package inside it.' },
    all: { type: 'boolean', description: 'For export/snap: the whole-machine scope — every recorded package into one .dpks archive instead of one package into one JSON file.' },
    profile: { type: 'string', description: 'For install and remove: target profile; defaults to this session profile.' },
    reinstall: { type: 'boolean', description: 'For install: place the store copy again even when the digest is already stored (apt --reinstall).' },
    deep: { type: 'boolean', description: 'For verify: false hashes the archive without extracting and re-validating the package as a DSH package (the analogue of dpkg --no-debsig). Default: true.' },
    via: { type: 'string', enum: ['profile', 'service'], description: 'For install and upgrade: how the profile is written. "profile" writes the dependency row, bundle list, node_modules link and lockfile row directly — no pnpm, works while the app runs, effective at the next Harness start. "service" hands the package to the official plugin manager service, which runs pnpm in the profile. Default: "profile" for a self-contained package, "service" when the package declares runtime dependencies (only pnpm can install that registry tree).' },
  },
  required: ['action'],
}


/**
 * The escalation prose for the actions that touch a profile or persistent data,
 * in one table so every gate names its own subject and consequence.
 */
const GATED_ACTIONS = {
  install: () => ({
    subject: 'package installation',
    justification: 'Installing a package changes this profile for every session, and installed Host code runs outside the workspace sandbox.',
  }),
  upgrade: () => ({
    subject: 'package upgrade',
    justification: 'Upgrading installs newer packages into every profile that resolves an older one, and installed Host code runs outside the workspace sandbox.',
  }),
  remove: args => ({
    subject: 'package removal',
    justification: `dpk remove ${args.name ?? ''}. Removing drops the dependency from this profile for every session.`,
  }),
  purge: args => ({
    subject: 'data purge',
    justification: `dpk purge ${args.name ?? ''}. Purging deletes every managed data volume (data and app) of the package for good.`,
  }),
  import: args => ({
    subject: 'data import',
    justification: `dpk import ${args.name ?? ''} ${args.file ?? ''}. Importing overwrites the package's data volumes with the carried file contents.`,
  }),
  autoremove: () => ({
    subject: 'store collection',
    justification: 'dpk autoremove. Collecting deletes every stored package no profile references any more; the original .dpk is then the only copy.',
  }),
}

/**
 * Register the tool.
 * @param ctx - Context carrying the tool registry and the sandbox/approval services.
 * @param config - Optional `home` override for the local dpk store.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['action', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const home = config.home ?? process.env.DSH_HOME ?? undefined
      // Every profile- or data-writing action earns the same gate, from one
      // table, and it fires before dpk writes anything.
      const gate = GATED_ACTIONS[args.action]?.(args)
      if (gate !== undefined) {
        await judgeEscalation(ctx, exec, { requestedMode: 'danger-full-access', ...gate })
      }
      // The official service is opt-in (`via: "service"`); the default writes
      // the profile directly, with no pnpm run and no manager dependency.
      // `upgrade` installs the same way, once per profile that resolves an older
      // package, so it needs the same installer.
      const installing = args.action === 'install' || args.action === 'upgrade'
      const installer = installing && args.via === 'service'
        ? createInstaller(ctx)
        : undefined
      // The profile path writes the four things the loader reads, but writing
      // them cannot make the *running* Harness read them again. The official
      // service can: `setBundleEnabled` reconciles a profile the runtime already
      // owns — no pnpm, no registry — so an install is usable, and a removal is
      // gone, the moment the action returns instead of at the next start.
      const touchingProfile = args.action === 'install' || args.action === 'upgrade' || args.action === 'remove'
      const apply = touchingProfile ? buildApplier(ctx) : undefined
      const result = await runDpkAction(args.action, args, {
        home,
        profile: args.profile ?? detectProfileName(home ?? defaultDshHome()),
        installer,
        apply,
        installMode: args.via === 'service' ? 'service' : undefined,
        log: (message) => { ctx.logger?.info?.(`dpk: ${message.trim()}`) },
        // `update`/`upgrade` ask the npm registry what a package's newest
        // version is. The ask goes through the official plugin manager's
        // `inspect(name)` — the same `pnpm view` the Plugins page runs in the
        // profile, so the profile's registry, proxy and authentication apply.
        // Absent (a Host without the manager), `update` simply answers from
        // local .dpk directories and says the registry was unavailable.
        view: buildRegistryView(ctx),
        // A registry upgrade is a real pnpm install run by the official
        // service, so it earns the same gate as an install before it starts.
        registryInstaller: buildRegistryInstaller(ctx),
        beforeRegistryUpgrade: profile => judgeEscalation(ctx, exec, {
          requestedMode: 'danger-full-access',
          subject: 'registry package upgrade',
          justification: `dpk upgrade. Upgrading ${profile} to the newest npm version of a registry package runs pnpm and changes this profile for every session.`,
        }),
      })
      return { action: result.action, text: result.text }
    },
    presentCall: args => ({
      card: 'generic',
      title: `DPK ${String(args?.action ?? '')}`.trim(),
      // The same table answers "does this write": a gated action is 'other',
      // everything else is 'read'.
      kind: GATED_ACTIONS[args?.action] === undefined ? 'read' : 'other',
      rawInput: args?.file ?? args?.directory ?? args?.name ?? String(args?.action ?? ''),
    }),
  })

  ctx.logger?.info?.(`${name}: registered the ${TOOL} tool (${DPK_ACTIONS.length} actions)`)

  // The browser half (import / export / uninstall / provenance on the Plugins
  // page) talks to this namespace. A missing protocol package degrades to the
  // in-session tool, never to a failed bundle.
  const remote = tryRemoteService(ctx, config)
  if (remote === undefined) {
    ctx.logger?.warn?.(
      `${name}: the Web UI half is unavailable (${remoteFailure ?? 'unknown reason'});`
      + ' the in-session dpk tool keeps working.',
    )
  } else {
    ctx.logger?.info?.(`${name}: remote namespace "${REMOTE_NAMESPACE}" is available to the Plugins page`)
  }
}

/** Why the Web UI half failed, when it did. */
let remoteFailure

/**
 * Build the remote service without ever failing the bundle: the in-session
 * tool must survive a Host that cannot host the browser half.
 */
function tryRemoteService(ctx, config) {
  try {
    return createDpkRemoteService(ctx, config)
  } catch (error) {
    remoteFailure = String(error instanceof Error ? error.message : error).split('\n')[0]
    return undefined
  }
}

/** The strictly-wider escalation table, mirroring `@deepseek-ai/dsh-sandbox#WIDER_MODES`. */
const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * Ask the npm registry what a package's newest version is, through the official
 * plugin manager's `inspect(name)` — the same `pnpm view` the Plugins page runs
 * in the profile, so the profile's registry, proxy and authentication apply.
 *
 * Returns `undefined` when no manager is composed: `update` then answers from
 * local .dpk directories and notes that the registry side was unavailable,
 * rather than failing a read-only report over a missing service.
 *
 * @param ctx - Context carrying `pluginManager`.
 * @returns an async `(profile, name) => { version } | null`, or `undefined`.
 */
function buildRegistryView(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || typeof manager.inspect !== 'function') return undefined
  return async (profile, name) => {
    const inspection = await manager.inspect(name)
    return inspection?.status === 'accepted' && typeof inspection.version === 'string'
      ? { version: inspection.version }
      : null
  }
}

/**
 * Install one registry package spec through the official plugin manager's
 * `installBundle(spec)` — a name@version, which pnpm resolves and installs
 * with the registry tree the package needs. Failure surfaces as a thrown
 * error with the manager's own diagnostic, so `upgrade` reports it per package
 * and goes on with the rest.
 *
 * @param ctx - Context carrying `pluginManager`.
 * @returns an async `(spec, meta) => outcome`, or `undefined` when absent.
 */
function buildRegistryInstaller(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || typeof manager.installBundle !== 'function') return undefined
  return (spec, meta) => manager.installBundle(spec, { isSatisfied: meta.isSatisfied })
}

/**
 * Apply one installed bundle to the **running** Harness, through the official
 * plugin manager's `setBundleEnabled`.
 *
 * That call persists the entry's enablement and reconciles the live profile:
 * with `hmr` composed it loads or unloads the bundle immediately and answers
 * `application: 'applied'`; on a startup profile, or for a profile this process
 * does not own, it answers `restart-required` and costs nothing. dpk never
 * passes the answer off as success — the action layer reports which one it got.
 *
 * @param ctx - Context carrying `pluginManager`.
 * @returns an async `(name, enabled) => outcome | undefined`.
 */
function buildApplier(ctx) {
  return async (name, enabled) => {
    const manager = await Promise.resolve(ctx.get('pluginManager'))
    if (manager === undefined || typeof manager.setBundleEnabled !== 'function') return undefined
    return await manager.setBundleEnabled(name, enabled)
  }
}

/**
 * Ask for sandbox escalation exactly as the official management tool does.
 *
 * This mirrors `@deepseek-ai/dsh-sandbox#approveEscalation` (the same request,
 * reason text, and outcome vocabulary) because a profile bundle cannot rely on
 * importing Harness packages. It fails closed: every path that cannot prove a
 * grant throws before the profile is touched.
 *
 * @param ctx - Context carrying `sandboxPolicy` and `approval`.
 * @param exec - The tool execution (agent, call id, signal).
 * @param request - `{ requestedMode, justification, subject }`.
 */
async function judgeEscalation(ctx, exec, request) {
  const { requestedMode, justification, subject } = request
  const policy = ctx.get('sandboxPolicy')
  const effectiveMode = policy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })?.mode
  if (effectiveMode === undefined) {
    throw new Error('dpk: cannot determine the sandbox mode of this call, so the profile will not be changed')
  }
  // Repeating the call's effective mode needs no approval; anything else must be strictly wider.
  if (requestedMode === effectiveMode) return effectiveMode
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(requestedMode)) {
    throw new Error(`dpk: sandbox escalation to "${requestedMode}" is not strictly wider than this call's "${effectiveMode}" mode`)
  }
  const approver = ctx.get('approval')
  if (approver === undefined) throw new Error(`dpk: escalating to "${requestedMode}" needs approval, but no approval service is composed`)
  if (exec.agent === undefined) throw new Error(`dpk: escalating to "${requestedMode}" needs approval, but the call has no agent to route it through`)
  const outcome = await approver.request({
    agent: exec.agent,
    toolName: TOOL,
    callId: exec.callId,
    reason: `escalate sandbox to ${requestedMode}: ${justification}`,
    ...exec.signal === undefined ? {} : { signal: exec.signal },
  })
  if (outcome === 'allowed-once') return requestedMode
  if (outcome === 'rejected') throw new Error(`dpk: the user rejected escalating this ${subject} to "${requestedMode}"`)
  if (outcome === 'cancelled') throw new Error(`dpk: approval for escalating to "${requestedMode}" was cancelled`)
  throw new Error(`dpk: escalating to "${requestedMode}" needs approval, but no approval channel is available`)
}

/**
 * Build the installer the `via: "service"` install action uses: the escalation
 * gate has already fired at the tool level; this just carries the store
 * directory to the official management service with the shared overwrite rules.
 */
function createInstaller(ctx) {
  return async (packageDir, meta) => serviceInstall(await Promise.resolve(ctx.get('pluginManager')), packageDir, meta, {
    reason: `the plugin manager could not install ${packageDir}`,
  })
}
