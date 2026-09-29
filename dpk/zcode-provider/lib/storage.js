/**
 * Plugin-owned persistent paths. These paths deliberately live under DSH so
 * the provider has no runtime dependency on a ZCode installation or profile.
 *
 * @module zcode-provider/storage
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Root for all zcode-provider state owned by DSH. */
export function defaultStorageRoot(home = homedir()) {
    return join(home, '.dsh', 'zcode-provider');
}
/** Optional provider catalog imported into the plugin-owned store. */
export function defaultProviderConfigPath(storageRoot) {
    return join(storageRoot?.trim() || defaultStorageRoot(), 'providers.json');
}
/** Account credentials used by Coding Plan and Start Plan routes. */
export function defaultCredentialsPath(storageRoot) {
    return join(storageRoot?.trim() || defaultStorageRoot(), 'credentials.json');
}
/** Stable device identifier used by protocol attribution. */
export function defaultTelemetryStatePath(storageRoot) {
    return join(storageRoot?.trim() || defaultStorageRoot(), 'telemetry-state.json');
}
