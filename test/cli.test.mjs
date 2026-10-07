import assert from 'node:assert/strict'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { makePackage } from './helpers.mjs'
import { parseCliArgs } from '../src/cli.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = join(root, 'src', 'cli.mjs')

function runCli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('CLI maps build arguments to the shared action core', () => {
  assert.deepEqual(parseCliArgs(['build', './plugin', '--output', './out.dpk']), {
    action: 'build',
    args: { directory: './plugin', output: './out.dpk' },
    context: {},
    json: false,
  })
  assert.deepEqual(parseCliArgs(['build', 'directory=./plugin', 'output=./out/']), {
    action: 'build',
    args: { directory: './plugin', output: './out/' },
    context: {},
    json: false,
  })
})

test('CLI builds and verifies a package through the npm entry point', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpk-cli-'))
  const packageDir = await makePackage({ root: join(work, 'plugin') })
  const built = await runCli('build', packageDir)
  assert.equal(built.code, 0, built.stderr)
  const archive = join(packageDir, 'dpk-dist', 'local-dpk-fixture@1.0.0.dpk')
  await access(archive)
  assert.match(built.stdout, /wrote\s+/)

  const verified = await runCli('verify', archive, '--json')
  assert.equal(verified.code, 0, verified.stderr)
  assert.equal(JSON.parse(verified.stdout).name, '@local/dpk-fixture')
  assert.equal((await readFile(archive)).length > 0, true)
})

test('CLI reports usage errors without a stack trace', async () => {
  const result = await runCli('build')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /build needs `directory`/)
  assert.doesNotMatch(result.stderr, /Error:.*at /s)
})
