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

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Where the CLI bundle and the built-in provider catalog sit inside an install. */
const CLI_RELATIVE = join('resources', 'glm', 'zcode.cjs')
const BUILTIN_RELATIVE = join('resources', 'config', 'provider', 'zcode-builtin.json')

/** A verified install: the paths the app-server bridge launches and reads. */
export interface ZcodeInstall {
  readonly installRoot: string
  readonly cliPath: string
  readonly builtinProviderConfigPath: string | undefined
}

/**
 * Map one candidate install root to the verified paths inside it.
 * @returns the install when the CLI bundle exists under the root, else undefined.
 */
export function zcodeInstallFromRoot(root: string): ZcodeInstall | undefined {
  const trimmed = root.trim()
  if (trimmed === '') return undefined
  const cliPath = join(trimmed, CLI_RELATIVE)
  if (!existsSync(cliPath)) return undefined
  const builtinProviderConfigPath = join(trimmed, BUILTIN_RELATIVE)
  return {
    installRoot: trimmed,
    cliPath,
    builtinProviderConfigPath: existsSync(builtinProviderConfigPath) ? builtinProviderConfigPath : undefined,
  }
}

/** Read one value line out of `reg query` output, whatever its code page. */
function regValue(output: string, name: string): string | undefined {
  // Value lines look like `    InstallLocation    REG_SZ    C:\...ZCode`; the
  // value name may be localized (e.g. `(默认)`), so match on the type column.
  const lines = output.split(/\r?\n/u)
  const wanted = name === '(default)' ? undefined : name
  for (const line of lines) {
    const match = /^\s*(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/u.exec(line)
    if (match === null) continue
    if (wanted === undefined || match[1] === wanted || match[1].startsWith('(')) {
      return match[2]
    }
  }
  return undefined
}

/** `reg query` with the classic parser quirks kept in one place. */
function regQuery(args: readonly string[]): string | undefined {
  const run = spawnSync('reg', [...args], { encoding: 'utf8', windowsHide: true, timeout: 4_000 })
  return run.status === 0 && run.stdout.length > 0 ? run.stdout : undefined
}

/** Candidate roots from the Windows registry: App Paths first, then uninstall. */
function windowsRegistryRoots(): string[] {
  const roots: string[] = []
  const appPaths = [
    ['HKCU', 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'App Paths', 'zcode.exe'],
    ['HKLM', 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'App Paths', 'zcode.exe'],
  ] as const
  for (const [hive, ...path] of appPaths) {
    const output = regQuery([hive, 'query', path.join('\\')])
    if (output === undefined) continue
    // The (default) value carries the full exe path; the `Path` value is the dir.
    const exe = regValue(output, '(default)')
    const dir = regValue(output, 'Path')
    for (const candidate of exe !== undefined ? [dirname(exe)] : []) roots.push(candidate)
    if (dir !== undefined) roots.push(dir.replace(/[\\/]+$/u, ''))
  }

  for (const hive of ['HKCU', 'HKLM'] as const) {
    for (const view of ['SOFTWARE', 'SOFTWARE\\WOW6432Node'] as const) {
      const key = `${hive}\\${view}\\Microsoft\\Windows\\CurrentVersion\\Uninstall`
      const listing = regQuery([hive, 'query', key])
      if (listing === undefined) continue
      for (const sub of listing.split(/\r?\n/u)) {
        const keyMatch = /^HKEY_\w+\\(.+)$/u.exec(sub.trim())
        if (keyMatch === null) continue
        const output = regQuery([hive, 'query', keyMatch[1]])
        if (output === undefined) continue
        const display = regValue(output, 'DisplayName')
        if (display === undefined || !/^zcode(\s|$)/iu.test(display)) continue
        const location = regValue(output, 'InstallLocation')
        if (location !== undefined && location !== '') roots.push(location.replace(/[\\/]+$/u, ''))
      }
    }
  }
  return roots
}

/** Candidate roots from `where`/`which` and the well-known install directories. */
function filesystemRoots(): string[] {
  const roots: string[] = []
  const lookup = process.platform === 'win32'
    ? spawnSync('where', ['zcode'], { encoding: 'utf8', windowsHide: true, timeout: 4_000 })
    : spawnSync('which', ['zcode'], { encoding: 'utf8', timeout: 4_000 })
  if (lookup.status === 0) {
    for (const hit of lookup.stdout.split(/\r?\n/u)) {
      const exe = hit.trim()
      if (exe !== '') roots.push(exe.endsWith('.exe') || exe.includes('/') || exe.includes('\\') ? dirname(exe) : exe)
    }
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local !== undefined) roots.push(join(local, 'Programs', 'zcode'))
    for (const program of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
      if (program !== undefined) roots.push(join(program, 'ZCode'))
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/ZCode.app/Contents/Resources')
  } else {
    roots.push('/opt/zcode', '/opt/ZCode', '/usr/lib/zcode')
  }
  roots.push(join(homedir(), '.local', 'share', 'zcode'))
  return roots
}

let cached: ZcodeInstall | undefined
let hasCached = false

/**
 * Find the ZCode install on this machine. Every candidate is verified against
 * the CLI bundle on disk; the first verified root wins. The result is cached —
 * installs do not move while the host runs.
 * @param roots - candidate roots to verify, in priority order (tests inject;
 * injected calls never touch the cache).
 * @returns the verified install, or undefined when nothing on this machine
 * looks like a ZCode installation.
 */
export function discoverZcodeInstall(roots?: readonly string[]): ZcodeInstall | undefined {
  if (roots === undefined && hasCached) return cached
  const candidates = roots ?? [...windowsRegistryRoots(), ...filesystemRoots()]
  let found: ZcodeInstall | undefined
  const seen = new Set<string>()
  for (const root of candidates) {
    const key = root.toLowerCase().replaceAll('/', '\\')
    if (seen.has(key)) continue
    seen.add(key)
    const install = zcodeInstallFromRoot(root)
    if (install !== undefined) {
      found = install
      break
    }
  }
  if (roots === undefined) {
    cached = found
    hasCached = true
  }
  return found
}
