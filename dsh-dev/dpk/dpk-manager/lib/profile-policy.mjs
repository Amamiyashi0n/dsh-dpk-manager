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

import { readFile, writeFile } from 'node:fs/promises'
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
