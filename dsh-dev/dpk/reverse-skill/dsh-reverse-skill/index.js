/**
 * DSH bundle for the client-neutral `reverse-skill` router, self-contained:
 * the `SKILL.md` provider engine ships inside this package (`lib/skill-dir.js`)
 * and the bundle serves the checkout's `skills/` root. One package, one `.dpk`.
 * See lib/skill-dir.js for the frontmatter and precedence contract.
 *
 * @module @local/dsh-reverse-skill
 */

import { registerSkillDir } from './lib/skill-dir.js'

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
