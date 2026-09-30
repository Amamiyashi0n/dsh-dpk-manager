/**
 * Provider self-check: drives `registerSkillDir()` with a stub context and no registry.
 *
 * Usage: node test/provider.test.mjs <absolute reverse-skill checkout path>
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'

const { registerSkillDir } = await import('../index.js')

const repoRoot = process.argv[2]
if (repoRoot === undefined) {
  console.error('usage: node test/provider.test.mjs <absolute reverse-skill checkout path>')
  process.exit(2)
}

let provider
const warnings = []
const ctx = {
  skills: {
    registerProvider(create) {
      provider = create({ signal: new AbortController().signal, invalidate() {} })
      return () => {}
    },
  },
  logger: {
    info() {},
    warn(message) {
      warnings.push(message)
    },
  },
}

/** Capture the provider a fresh registration produces. */
function capture() {
  let captured
  return {
    ctx: { skills: { registerProvider(create) { captured = create({ invalidate() {} }); return () => {} } }, logger: { info() {}, warn() {} } },
    get: () => captured,
  }
}

// --- configuration validation -------------------------------------------------
assert.throws(() => registerSkillDir(stubCtx(), {}), /repoRoot must be the absolute path/u)
assert.throws(() => registerSkillDir(stubCtx(), { repoRoot: 'relative/path' }), /must be absolute/u)
assert.throws(() => registerSkillDir(stubCtx(), { repoRoot: join(repoRoot, 'docs') }), /has no skills\/ directory/u)
assert.throws(() => registerSkillDir(stubCtx(), { repoRoot, extraRoots: ['../..'] }), /escapes config\.repoRoot/u)

// --- registration: the skills/ root -------------------------------------------
registerSkillDir(ctx, {
  providerName: 'reverse-skill',
  repoRoot,
  roots: ['skills'],
  extraRoots: ['CTF-Sandbox-Orchestrator'],
})
assert.equal(provider.name, 'reverse-skill')

const observation = await provider.list({})
assert.equal(observation.complete, true)
const candidates = observation.candidates
const names = candidates.map(candidate => candidate.name)

assert.equal(new Set(names).size, names.length, 'skill names must be unique')
assert.ok(candidates.length >= 80, `expected >= 80 skills, received ${candidates.length}`)
for (const candidate of candidates) {
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `invalid name ${candidate.name}`)
  assert.ok(candidate.description.length > 0, `${candidate.name} needs a description`)
  assert.equal(candidate.provider, 'reverse-skill')
  assert.equal(candidate.source, 'custom')
  assert.equal(candidate.rank, 600)
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.equal(candidate.resourceBase.path, dirname(candidate.locator))
  assert.ok(candidate.locator.endsWith('SKILL.md'))
}

for (const expected of [
  'reverse-engineering', 'reverse-skill-router', 'ida-reverse', 'ghidra-reverse',
  'edr-bypass-re', 'pwn-chain', 'src-hunter', 'dsl-vm-reverse', 'ctf-sandbox-orchestrator',
  'competition-kerberos-delegation',
]) {
  assert.ok(names.includes(expected), `missing skill ${expected}`)
}

// The repository-root router wins the duplicate name over the Codex adapter copy.
const router = candidates.find(candidate => candidate.name === 'reverse-skill-router')
assert.ok(router.locator.endsWith(join('skills', 'SKILL.md')), `router came from ${router.locator}`)

// --- block scalars stay complete ---------------------------------------------
const edr = candidates.find(candidate => candidate.name === 'edr-bypass-re')
assert.match(edr.description, /Red team|EDR|Defender/u)
assert.ok(!edr.description.includes('\n'), 'descriptions are normalized to one line')
assert.match(edr.description, /Reflective DLL/u, 'trailing block-scalar line must survive')

// --- invocation policy --------------------------------------------------------
const reverseEngineering = candidates.find(candidate => candidate.name === 'reverse-engineering')
assert.deepEqual(reverseEngineering.invocation, { modelInvocable: true, userInvocable: false })

// --- lazy body loading --------------------------------------------------------
const loaded = await provider.get(reverseEngineering, {})
assert.ok(loaded.content.length > 1000, `body too short: ${loaded.content.length}`)
assert.ok(!loaded.content.startsWith('---'), 'frontmatter is stripped from the body')
assert.match(loaded.content, /^#\s/u)
assert.equal(loaded.name, 'reverse-engineering')
assert.equal(loaded.resourceBase.path, dirname(reverseEngineering.locator))

const loadedEdr = await provider.get(edr, {})
assert.match(loadedEdr.content, /EDR/u)
assert.ok(!loadedEdr.content.includes('description: |'), 'frontmatter never leaks into the body')

// --- extraRoots widens the catalog -------------------------------------------
const sole = capture()
registerSkillDir(sole.ctx, { providerName: 'reverse-skill', repoRoot, roots: ['skills'], extraRoots: [] })
const soleNames = (await sole.get().list({})).candidates.map(candidate => candidate.name)
assert.ok(soleNames.length < names.length, 'extraRoots must widen the catalog')
assert.ok(!soleNames.includes('ctf-sandbox-orchestrator'))

// --- the second bundle's own root -------------------------------------------
const ctf = capture()
const ctfSettings = registerSkillDir(ctf.ctx, {
  providerName: 'ctf-sandbox',
  repoRoot,
  roots: ['CTF-Sandbox-Orchestrator'],
})
const ctfCandidates = (await ctf.get().list({})).candidates
const ctfNames = ctfCandidates.map(candidate => candidate.name)
assert.equal(ctfSettings.providerName, 'ctf-sandbox')
assert.ok(ctfCandidates.length >= 40, `expected >= 40 CTF skills, received ${ctfCandidates.length}`)
assert.ok(ctfNames.includes('ctf-sandbox-orchestrator'), 'orchestrator entry missing')
assert.ok(ctfCandidates.every(candidate => candidate.provider === 'ctf-sandbox'))
assert.ok(ctfNames.every(name => !soleNames.includes(name)), 'the two bundles must not overlap')
const orchestrated = ctfCandidates.find(candidate => candidate.name === 'competition-kerberos-delegation')
assert.ok(orchestrated.resourceBase.path.includes('CTF-Sandbox-Orchestrator'))
const orchestratedBody = await ctf.get().get(orchestrated, {})
assert.ok(orchestratedBody.content.length > 100)

// --- include / exclude filters ------------------------------------------------
assert.throws(() => registerSkillDir(stubCtx(), { repoRoot, include: 'ida-reverse' }), /include must be a list/u)
assert.throws(() => registerSkillDir(stubCtx(), { repoRoot, include: ['Not-Kebab'] }), /kebab-case skill names/u)

const filtered = capture()
registerSkillDir(filtered.ctx, {
  providerName: 'reverse-skill',
  repoRoot,
  roots: ['skills'],
  include: ['reverse-engineering', 'ida-reverse', 'ghidra-reverse', 'dsl-vm-reverse'],
})
const filteredNames = (await filtered.get().list({})).candidates.map(candidate => candidate.name)
assert.deepEqual(filteredNames, ['dsl-vm-reverse', 'ghidra-reverse', 'ida-reverse', 'reverse-engineering'])

const excluded = capture()
registerSkillDir(excluded.ctx, {
  providerName: 'reverse-skill',
  repoRoot,
  roots: ['skills'],
  exclude: ['src-hunter', 'ctf-sandbox'],
})
const excludedNames = (await excluded.get().list({})).candidates.map(candidate => candidate.name)
assert.ok(!excludedNames.includes('src-hunter'))
assert.ok(!excludedNames.includes('ctf-sandbox'))
assert.equal(excludedNames.length, soleNames.length - 2, 'exclude drops exactly the named skills')

console.log(`OK  skills=${names.length} (skills/ + CTF) / ${soleNames.length} (skills/ only) / ${ctfNames.length} (CTF bundle)`)
console.log(`    include filter -> ${filteredNames.length} skills, exclude filter -> ${excludedNames.length} skills`)
console.log(`    reverse-engineering body=${loaded.content.length} chars, description=${reverseEngineering.description.length} chars`)
console.log(`    warnings=${warnings.length}`)
for (const warning of warnings.slice(0, 10)) console.log(`    warn: ${warning}`)

function stubCtx() {
  return { skills: { registerProvider: () => () => {} }, logger: { info() {}, warn() {} } }
}
