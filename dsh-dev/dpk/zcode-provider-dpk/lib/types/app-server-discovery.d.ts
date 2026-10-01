/**
 * ZCode installation discovery: find the real install on this machine.
 *
 * The app-server bridge needs the ZCode CLI bundle (`resources/glm/zcode.cjs`)
 * and its built-in provider catalog. Historically those paths came from
 * `DSH_ZCODE_REPO`/`DSH_ZCODE_CLI_PATH` env vars or a hand-written profile
 * patch — dead paths that break on any machine configured differently.
 * Discovery instead asks the system where ZCode lives, in order of authority:
 *
 *  1. Windows App Paths registry (`zcode.exe` → install root),
 *  2. `zcode` on PATH (`where`/`which`),
 *  3. Add/Remove Programs registry (DisplayName match → InstallLocation),
 *  4. the well-known per-user and per-machine install directories.
 *
 * Every candidate root is verified by the CLI bundle actually being there, so
 * a stale registry entry can never win over a working install. Env vars and
 * explicit config remain available as overrides; discovery only fills the
 * default.
 *
 * @module zcode-provider/zcode-discovery
 */
/** A verified install: the paths the app-server bridge launches and reads. */
export interface ZcodeInstall {
    readonly installRoot: string;
    readonly cliPath: string;
    readonly builtinProviderConfigPath: string | undefined;
}
/**
 * Map one candidate install root to the verified paths inside it.
 * @returns the install when the CLI bundle exists under the root, else undefined.
 */
export declare function zcodeInstallFromRoot(root: string): ZcodeInstall | undefined;
/**
 * Find the ZCode install on this machine. Every candidate is verified against
 * the CLI bundle on disk; the first verified root wins. The result is cached —
 * installs do not move while the host runs.
 * @param roots - candidate roots to verify, in priority order (tests inject;
 * injected calls never touch the cache).
 * @returns the verified install, or undefined when nothing on this machine
 * looks like a ZCode installation.
 */
export declare function discoverZcodeInstall(roots?: readonly string[]): ZcodeInstall | undefined;
