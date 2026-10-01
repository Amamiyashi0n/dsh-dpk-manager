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
/** The dpk-managed package name this plugin installs under. */
export declare const PACKAGE_NAME = "@local/zcode-provider";
/** Root of this package's managed data volumes. */
export declare function defaultStorageRoot(home?: string): string;
/** Optional provider catalog imported into the plugin-owned store. */
export declare function defaultProviderConfigPath(storageRoot?: string): string;
/** Account credentials used by Coding Plan and Start Plan routes. */
export declare function defaultCredentialsPath(storageRoot?: string): string;
/** Stable device identifier used by protocol attribution. */
export declare function defaultTelemetryStatePath(storageRoot?: string): string;
