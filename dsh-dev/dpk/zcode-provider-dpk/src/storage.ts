/**
 * Managed persistent paths (dpk data volumes, SPEC.md §13).
 *
 * Durable files live under the dpk-managed data root
 * `~/.dsh/data/@local/zcode-provider/<class>/…` and are declared in
 * package.json (`dsh.data.volumes`); dpk seeds config volumes at install time
 * and upgrades them conffile-style. The legacy root `~/.dsh/zcode-provider`
 * is NOT read as a fallback — the switch is deliberately breaking, so a
 * half-migrated machine fails visibly instead of silently resurrecting old
 * state.
 *
 * Class assignment:
 *   config  providers.json, prompt-overrides.json   (user-authored, migrates)
 *   state   credentials.json, telemetry-state.json,
 *           auth-backend.json                       (host-bound, never migrates)
 *
 * @module zcode-provider/storage
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The dpk-managed package name this plugin installs under. */
export const PACKAGE_NAME = '@local/zcode-provider'

/** Root of this package's managed data volumes. */
export function defaultStorageRoot(home: string = homedir()): string {
  return join(home, '.dsh', 'data', '@local', 'zcode-provider')
}

/** Optional provider catalog imported into the plugin-owned store. */
export function defaultProviderConfigPath(storageRoot?: string): string {
  return join(storageRoot?.trim() || defaultStorageRoot(), 'config', 'providers.json')
}

/** Account credentials used by Coding Plan and Start Plan routes. */
export function defaultCredentialsPath(storageRoot?: string): string {
  return join(storageRoot?.trim() || defaultStorageRoot(), 'state', 'credentials.json')
}

/** Stable device identifier used by protocol attribution. */
export function defaultTelemetryStatePath(storageRoot?: string): string {
  return join(storageRoot?.trim() || defaultStorageRoot(), 'state', 'telemetry-state.json')
}
