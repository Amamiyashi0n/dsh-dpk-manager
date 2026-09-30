/**
 * DSH 安装包管理助手 — the `dpk` tool as a Host plugin.
 *
 * Registers one agent-facing tool, `dpk`, over the pure action layer in
 * `lib/actions.mjs`. The privileged action (`install`) mirrors what the official
 * `plugin_manager` tool does before it touches a profile: it asks for
 * danger-full-access escalation through the same `sandboxPolicy`/`approval`
 * services and then calls the official `pluginManager` service. dpk never writes
 * a profile itself, and when the escalation prerequisites or the service are
 * missing it refuses to install and hands the caller the official tool call.
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
import { detectProfileName } from './lib/profile-policy.mjs'
import { defaultDshHome } from './lib/store.mjs'

/** Cordis plugin name. */
export const name = 'dsh-dpk-manager'
/** Tool registry the agent-facing tool registers into. */
export const inject = ['tools']

const TOOL = 'dpk'

/** The model-facing description; it names the gate and the ordering the model must follow. */
const DESCRIPTION = [
  'Manage DSH plugin packages: inspect or verify a .dpk archive, pack a package directory into a .dpk,',
  'install a verified archive into the current profile, or list what dpk installed locally.',
  'A .dpk is a validated zip carrying one standard DSH package; verify before installing.',
  'install changes this profile for every session and requires danger-full-access permission or approval for this call;',
  'it runs through the same plugin manager service as plugin_manager, so approval does not change the session permission mode.',
  'dryRun reports the deterministic store path and the exact hand-off without writing anything.',
].join(' ')

/** The parameter schema, in the same implicit-object form the Harness compiles from tool specs. */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: DPK_ACTIONS, description: 'Operation to perform.' },
    file: { type: 'string', description: 'Archive path for inspect, verify, and install.' },
    directory: { type: 'string', description: 'Package directory for pack.' },
    output: { type: 'string', description: 'For pack: the .dpk path to write; defaults to <name>-<version>.dpk in the working directory.' },
    name: { type: 'string', description: 'For which: a package name, optionally name@version.' },
    profile: { type: 'string', description: 'For install: target profile; defaults to this session profile.' },
    dryRun: { type: 'boolean', description: 'For install: verify and unpack nothing; report the store path and the exact hand-off only.' },
    force: { type: 'boolean', description: 'For install: re-extract even when the digest is already stored.' },
    keepArchive: { type: 'boolean', description: 'For install: also keep the .dpk under <home>/dpk/archives.' },
  },
  required: ['action'],
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
      const installer = args.action === 'install' && args.dryRun !== true
        ? createInstaller(ctx, exec, args)
        : undefined
      const result = await runDpkAction(args.action, args, {
        home,
        profile: args.profile ?? detectProfileName(home ?? defaultDshHome()),
        installer,
        log: (message) => { ctx.logger?.info?.(`dpk: ${message.trim()}`) },
      })
      return { action: result.action, text: result.text }
    },
    presentCall: args => ({
      card: 'generic',
      title: `DPK ${String(args?.action ?? '')}`.trim(),
      kind: args?.action === 'install' && args?.dryRun !== true ? 'other' : 'read',
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
 * Build the installer the install action uses: the same escalation gate and the
 * same service the official management tool uses.
 */
function createInstaller(ctx, exec, args) {
  return async (packageDir) => {
    const manager = ctx.get('pluginManager')
    if (manager === undefined) {
      throw new Error(
        'dpk: the plugin manager service is not composed, so nothing was installed.'
        + ` Run: plugin_manager action=install_bundle target=${packageDir}`,
      )
    }
    await judgeEscalation(ctx, exec, {
      requestedMode: 'danger-full-access',
      subject: 'package installation',
      justification: `dpk install ${args.file ?? packageDir}. Installing a package changes this profile for every session, and installed Host code runs outside the workspace sandbox.`,
    })
    const result = await manager.installBundle(packageDir, {})
    if (result?.application === 'failed') {
      throw new Error(
        `dpk: the plugin manager could not install ${packageDir}:`
        + ` ${result.error?.diagnostic ?? result.error?.code ?? 'unknown failure'}`,
      )
    }
    return result
  }
}
