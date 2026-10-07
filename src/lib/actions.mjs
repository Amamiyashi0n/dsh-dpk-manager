/**
 * Compatibility exports for the pre-CLI action module path.
 *
 * The command core lives in `cli.mjs`; keep this path as a forwarding module
 * for packages that already import `dsh-dpk-manager/lib/actions.mjs`.
 *
 * @module dpk/lib/actions
 */

export * from './cli.mjs'
