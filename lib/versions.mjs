/**
 * Version ordering over the dotted numeric versions dpk stores and compares.
 *
 * A tiny domain, kept in its own module because both the store (ranking a
 * package's ledger rows) and the upgrade planner (comparing available against
 * current) need exactly this one question answered.
 *
 * @module dpk/lib/versions
 */

/**
 * Order two dotted numeric versions. A `-prerelease` tail sorts below its
 * release; unparsable segments count as zero so a malformed version never
 * outranks a well-formed one by accident.
 */
export function compareVersions(a, b) {
  const split = value => {
    const withoutBuild = String(value).split('+', 1)[0]
    const [core, pre] = withoutBuild.split('-', 2)
    return { core: core.split('.').map(Number), pre: pre === undefined ? undefined : pre.split('.') }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i += 1) {
    const x = Number.isFinite(left.core[i]) ? left.core[i] : 0
    const y = Number.isFinite(right.core[i]) ? right.core[i] : 0
    if (x !== y) return x - y
  }
  if (left.pre === undefined && right.pre === undefined) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    if (left.pre[i] === undefined) return -1
    if (right.pre[i] === undefined) return 1
    const leftNumeric = /^\d+$/u.test(left.pre[i])
    const rightNumeric = /^\d+$/u.test(right.pre[i])
    if (leftNumeric && rightNumeric) {
      const difference = Number(left.pre[i]) - Number(right.pre[i])
      if (difference !== 0) return difference
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (left.pre[i] !== right.pre[i]) {
      return left.pre[i] < right.pre[i] ? -1 : 1
    }
  }
  return 0
}

/**
 * The newest entry per package name. Ledger order is insertion order, not
 * version order, so callers that want "what this package is now" must rank by
 * version instead of trusting the last row.
 */
export function latestByName(entries) {
  const latest = new Map()
  for (const entry of entries) {
    const current = latest.get(entry.name)
    if (current === undefined || compareVersions(entry.version, current.version) >= 0) latest.set(entry.name, entry)
  }
  return [...latest.values()]
}

/** The newest entry matching `name` or `name@version`, or undefined. */
export function latestEntry(entries, request) {
  const at = request.startsWith('@') ? request.indexOf('@', 1) : request.indexOf('@')
  const name = at === -1 ? request : request.slice(0, at)
  const version = at === -1 ? undefined : request.slice(at + 1)
  const matches = entries.filter(entry => entry.name === name && (version === undefined || entry.version === version))
  if (matches.length === 0) return undefined
  return matches.reduce((best, entry) => (compareVersions(entry.version, best.version) >= 0 ? entry : best))
}
