/**
 * pnpm's supply-chain cooldown (minimumReleaseAge) revalidates every registry
 * dependency of a profile on each install, so installing one package can be
 * refused over another that was published within the cooldown — this manager
 * itself, right in the window after a release. A `.dpk` import is a deliberate,
 * digest-verified install, so the profile's `pnpm-workspace.yaml` opts out of
 * the cooldown before the official installer runs pnpm. A value the user
 * configured explicitly is always left alone.
 *
 * @module dpk/lib/profile-policy
 */

import { readdirSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** A top-level `minimumReleaseAge` key, whatever value it carries. */
const RELEASE_AGE_KEY = /^minimumReleaseAge\s*:/m

/**
 * Ensure the profile's pnpm workspace declares no release-age cooldown.
 * @param profileDir - the DSH profile directory pnpm installs into.
 * @returns true when the file was written, false when nothing needed changing.
 */
export async function disableReleaseAgeCooldown(profileDir) {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (RELEASE_AGE_KEY.test(text)) return false
  const gap = text === '' || text.endsWith('\n') ? '' : '\n'
  await writeFile(file, `${text}${gap}minimumReleaseAge: 0\n`, 'utf8')
  return true
}

/**
 * The name of the profile this package instance serves. A Host process does
 * not export `DSH_PROFILE` (Harness sets it only in child shells), so when it
 * is absent, locate the profile whose `node_modules` physically holds this
 * package: the running package's real path equals that profile's copy, through
 * the direct install, the store `link:` junction, or a `file:` install alike.
 * @param home - the DSH home holding `profiles/`.
 * @returns the profile name, or undefined when nothing identifies one.
 */
export function detectProfileName(home) {
  if (process.env.DSH_PROFILE !== undefined && process.env.DSH_PROFILE !== '') return process.env.DSH_PROFILE
  try {
    const self = realpathSync(join(fileURLToPath(new URL('../..', import.meta.url))))
    const profiles = join(home, 'profiles')
    for (const name of readdirSync(profiles)) {
      try {
        if (realpathSync(join(profiles, name, 'node_modules', 'dsh-dpk-manager')) === self) return name
      } catch {
        // This profile does not hold the package; keep looking.
      }
    }
  } catch {
    // No readable profiles directory: the name stays undetermined.
  }
  return undefined
}
