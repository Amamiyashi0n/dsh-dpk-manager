#!/usr/bin/env node
/**
 * Run this package's test files — every one of them — then report once.
 *
 * `npm test` used to be a single `&&` chain, so the first failing file hid every
 * file behind it: a real failure in `tests/native-account.mjs` silently kept
 * `tests/standalone-package.mjs` from running, and that file is the offline gate
 * proving this archive activates and serves requests with no ZCode installed.
 * A red suite therefore also suppressed the evidence that the rest was fine.
 *
 * Every file below runs regardless of its predecessors and the exit code
 * reflects the whole set. Two files stay out of the chain on purpose:
 * `tests/loader-composition.mjs` needs the maintainer monorepo's linked
 * workspaces (run it through `npm run test:integration`), and the files under
 * `tests/fixtures/` are inputs, not suites.
 *
 * Usage: node scripts/run-tests.mjs [--only <substring>]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const FILES = [
  'tests/equivalence.mjs',
  'tests/storage.mjs',
  'tests/prompt-remote.mjs',
  'tests/auth-backend.mjs',
  'tests/credentials.mjs',
  'tests/route-resolution.mjs',
  'tests/entitlements.mjs',
  'tests/usage.mjs',
  'tests/usage-remote.mjs',
  'tests/diagnostics.mjs',
  'tests/client.mjs',
  'tests/offpeak.mjs',
  'tests/official-prompt.mjs',
  'tests/captcha.mjs',
  'tests/captcha-remote.mjs',
  'tests/image-wire.mjs',
  'tests/official-wire.mjs',
  'tests/app-server.mjs',
  'tests/app-server-discovery.mjs',
  'tests/native-account.mjs',
  'tests/standalone-package.mjs',
]

const only = process.argv.indexOf('--only')
const selected = only === -1 ? FILES : FILES.filter(file => file.includes(process.argv[only + 1] ?? ''))

if (selected.length === 0) {
  console.error(`run-tests: --only matched none of ${FILES.length} test files`)
  process.exit(1)
}

const failed = []
for (const file of selected) {
  // stdio inherited: the suites print their own labelled results, and this
  // process only owns the verdict.
  const result = spawnSync(process.execPath, [join(root, file)], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) failed.push({ file, status: result.status ?? 'no exit status' })
}

if (failed.length === 0) {
  console.log(`\nrun-tests: ${selected.length} test files passed`)
  process.exit(0)
}
console.error(`\nrun-tests: ${failed.length} of ${selected.length} test files failed`)
for (const { file, status } of failed) console.error(`  ${file} (exit ${status})`)
process.exit(1)
