/**
 * Plugin-owned persistent paths. These paths deliberately live under DSH so
 * the provider has no runtime dependency on a ZCode installation or profile.
 *
 * @module zcode-provider/storage
 */
/** Root for all zcode-provider state owned by DSH. */
export declare function defaultStorageRoot(home?: string): string;
/** Optional provider catalog imported into the plugin-owned store. */
export declare function defaultProviderConfigPath(storageRoot?: string): string;
/** Account credentials used by Coding Plan and Start Plan routes. */
export declare function defaultCredentialsPath(storageRoot?: string): string;
/** Stable device identifier used by protocol attribution. */
export declare function defaultTelemetryStatePath(storageRoot?: string): string;
