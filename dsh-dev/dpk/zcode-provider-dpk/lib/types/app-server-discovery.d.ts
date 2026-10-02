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
 *  3. Add/Remove Programs registry (DisplayName match → InstallLocation or
 *     the directory containing UninstallString),
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
export interface RegistryQueryResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export type RegistryQueryRunner = (args: readonly string[]) => RegistryQueryResult;
/** Pull verified-install candidates from one App Paths value block. */
export declare function rootsFromAppPathsOutput(output: string): string[];
/** Extract a Windows executable path from an uninstall command line. */
export declare function executableFromUninstallString(value: string | undefined): string | undefined;
/** Resolve an uninstall command to its candidate installation directory. */
export declare function installRootFromUninstallString(value: string | undefined): string | undefined;
/** Pull an installation root from one Add/Remove Programs value block. */
export declare function rootFromUninstallOutput(output: string): string | undefined;
/** Candidate roots from the Windows registry: App Paths first, then uninstall. */
export declare function windowsRegistryRoots(run?: RegistryQueryRunner, log?: (message: string) => void): string[];
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
