/**
 * DSH adapter bundle for the client-neutral `reverse-skill` router.
 *
 * Thin bundle: the provider engine lives in `@local/dsh-skill-dir`; this package
 * owns the `reverse-skill` identity and serves the router's own `skills/` root.
 * See that package's README for the frontmatter and precedence contract.
 *
 * @module @local/dsh-reverse-skill
 */

import { registerSkillDir } from '@local/dsh-skill-dir'

/** Cordis plugin name. */
export const name = 'dsh-reverse-skill'
/** Skill registry the provider registers into. */
export const inject = ['skills']

/**
 * Register the `reverse-skill` provider over the checkout's `skills/` root.
 * @param ctx - Context carrying the skill registry.
 * @param config - `repoRoot` (required, absolute checkout path), optional
 * `roots`, `extraRoots`, and `rank`.
 */
export function apply(ctx, config = {}) {
  registerSkillDir(ctx, {
    providerName: 'reverse-skill',
    roots: ['skills'],
    ...config,
  })
}
