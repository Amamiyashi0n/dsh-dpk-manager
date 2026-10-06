import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/**
 * Build the npm command that marks every version older than the just-published
 * version as deprecated. The range intentionally excludes the current and any
 * future version, so re-running the hook is idempotent for this release.
 */
export function deprecationPlan(manifest) {
  if (typeof manifest?.name !== 'string' || manifest.name.length === 0) {
    throw new Error('release: package.json must contain a package name')
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    throw new Error(`release: invalid package version ${JSON.stringify(manifest.version)}`)
  }

  const registry = manifest.publishConfig?.registry ?? DEFAULT_REGISTRY
  const spec = `${manifest.name}@<${manifest.version}`
  const message = `Deprecated: use ${manifest.name}@${manifest.version}.`
  return {
    args: ['deprecate', spec, message, `--registry=${registry}`],
    message,
    registry,
    spec,
  }
}

/** Run npm with inherited output so a publish log shows the deprecation step. */
export function runNpm(args, options = {}) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`release: npm deprecate exited with code ${code ?? 'unknown'}`))
    })
  })
}

export async function deprecatePreviousVersions(manifest, runner = runNpm, cwd = process.cwd()) {
  const plan = deprecationPlan(manifest)
  await runner(plan.args, { cwd })
  return plan
}

async function readManifest(root = process.cwd()) {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}

export async function publishCleanup({ root = process.cwd(), runner = runNpm, env = process.env } = {}) {
  if (env.npm_config_dry_run === 'true') {
    return { skipped: true }
  }
  return deprecatePreviousVersions(await readManifest(root), runner, root)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishCleanup()
}
