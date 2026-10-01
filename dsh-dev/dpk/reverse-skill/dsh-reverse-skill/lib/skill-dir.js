/**
 * Shared skill provider over `SKILL.md` directories: the engine behind the
 * `@local/dsh-reverse-skill` and `@local/dsh-ctf-sandbox` bundles.
 *
 * Discovery walks the configured repository roots for `SKILL.md` files, reads
 * each file's YAML frontmatter, and exposes one DSH skill per file; the skill's
 * own directory becomes its `resourceBase`, so relative links inside the body
 * (`references/…`, `../field-journal/…`, `../tool-index.md`) stay readable.
 * Bodies are loaded lazily by `get()`.
 *
 * The repository stays canonical: this package never copies or edits it, and
 * the load path is the `repoRoot` configuration value. It has no runtime
 * dependencies, so a profile that lacks the DSH source checkout can still load
 * it. Configuration is validated by {@link resolveSkillDirSettings} because the
 * bundles ship no schemastery `Config` schema.
 *
 * @module @local/dsh-reverse-skill/lib/skill-dir
 */

import { statSync } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Origin bucket for locally configured third-party skill sources. */
const DEFAULT_SOURCE = 'custom'
/**
 * Default precedence rank, deliberately the lowest in use (`BUNDLED_SKILL_RANK`):
 * a project or user skill with the same name wins over one from this bundle.
 */
const DEFAULT_RANK = 600
/** Repository-relative roots scanned when `config.roots` is absent. */
const DEFAULT_ROOTS = ['skills']
/** Head bytes read per `SKILL.md`; a truncated head falls back to a full read. */
const FRONTMATTER_HEAD_BYTES = 32 * 1024
/** Directory levels walked below each configured root. */
const MAX_SCAN_DEPTH = 4
/** Skill-name grammar shared with the DSH registry. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Directories never worth descending into while scanning. */
const PRUNED_DIRECTORIES = new Set(['node_modules', 'work'])

/**
 * Register a `SKILL.md`-directory provider on `ctx.skills`.
 * @param ctx - Context carrying the skill registry.
 * @param config - `providerName` plus `repoRoot` (required, absolute checkout
 * path), optional `roots`, `extraRoots`, `rank`, `source`, `include` (only these
 * skill names) and `exclude` (never these skill names).
 * @returns the resolved settings, for logging and self-checks.
 */
export function registerSkillDir(ctx, config = {}) {
  const settings = resolveSkillDirSettings(config)
  const provider = createSkillDirProvider(ctx, settings)
  ctx.skills.registerProvider(() => provider)
  ctx.logger?.info?.(
    `${settings.providerName}: serving ${settings.roots.length} root(s) of ${settings.root}`,
  )
  return settings
}

/** Validate and normalize the row's configuration, failing activation with a readable message. */
export function resolveSkillDirSettings(config = {}) {
  const label = typeof config.providerName === 'string' && config.providerName !== ''
    ? config.providerName
    : 'dsh-skill-dir'
  const repoRoot = config.repoRoot
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new Error(`${label}: config.repoRoot must be the absolute path of a skill checkout`)
  }
  if (!isAbsolute(repoRoot)) {
    throw new Error(`${label}: config.repoRoot must be absolute, received "${repoRoot}"`)
  }
  const root = resolve(repoRoot)
  try {
    if (!statSync(join(root, 'skills')).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(
      `${label}: ${root} has no skills/ directory; clone the skill repository there`,
    )
  }
  const roots = []
  for (const entry of [...toArray(config.roots ?? DEFAULT_ROOTS), ...toArray(config.extraRoots ?? [])]) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${label}: config.roots and config.extraRoots entries must be repo-relative directories`)
    }
    const absolute = resolve(root, entry)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`${label}: skill root "${entry}" escapes config.repoRoot`)
    }
    if (!roots.some(candidate => candidate.absolute === absolute)) {
      roots.push({ label: entry, absolute })
    }
  }
  if (roots.length === 0) throw new Error(`${label}: at least one skill root is required`)
  const rank = config.rank ?? DEFAULT_RANK
  if (typeof rank !== 'number' || !Number.isFinite(rank)) {
    throw new Error(`${label}: config.rank must be a finite number`)
  }
  const providerName = typeof config.providerName === 'string' && config.providerName !== ''
    ? config.providerName
    : 'dsh-skill-dir'
  return {
    root,
    roots,
    rank,
    providerName,
    source: config.source ?? DEFAULT_SOURCE,
    include: nameSet(config.include, `${label}: config.include`),
    exclude: nameSet(config.exclude, `${label}: config.exclude`),
  }
}

/** Normalize an optional list of skill names into a Set. */
function nameSet(value, subject) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${subject} must be a list of skill names`)
  const names = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !SKILL_NAME.test(entry)) {
      throw new Error(`${subject} entries must be kebab-case skill names, received ${JSON.stringify(entry)}`)
    }
    names.add(entry)
  }
  return names
}

/** Whether a discovered skill name passes the provider's include/exclude filters. */
function selected(settings, name) {
  if (settings.include !== undefined && !settings.include.has(name)) return false
  if (settings.exclude !== undefined && settings.exclude.has(name)) return false
  return true
}

/** Build the provider; discovery is per-call so edits to the checkout appear without a restart. */
export function createSkillDirProvider(ctx, settings) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${settings.providerName}: ${message}`)
    } catch {
      // A logger failure must never break discovery.
    }
  }
  return {
    name: settings.providerName,
    async list(options = {}) {
      const signal = options.signal
      const candidates = []
      const seen = new Map()
      let complete = true
      for (const root of settings.roots) {
        signal?.throwIfAborted()
        const scan = await collectSkillFiles(root.absolute, signal, warn)
        if (!scan.complete) complete = false
        for (const file of scan.files) {
          signal?.throwIfAborted()
          const candidate = await readCandidate(file, settings, signal, warn)
          if (candidate === undefined) continue
          if (!selected(settings, candidate.name)) continue
          const previous = seen.get(candidate.name)
          if (previous !== undefined) {
            warn(`duplicate skill "${candidate.name}" at ${file} ignored; keeping ${previous}`)
            continue
          }
          seen.set(candidate.name, file)
          candidates.push(candidate)
        }
      }
      candidates.sort((left, right) => left.name.localeCompare(right.name))
      return { candidates, complete }
    },
    async get(candidate, options = {}) {
      const raw = await readFile(candidate.locator, { encoding: 'utf8', signal: options.signal })
      const parsed = parseFrontmatter(raw)
      if (parsed === undefined) {
        throw new Error(`${settings.providerName}: ${candidate.locator} has no YAML frontmatter`)
      }
      const { rank: _rank, locator: _locator, ...summary } = candidate
      return { ...summary, content: parsed.body.trim() }
    },
  }
}

/** Walk one root for `SKILL.md` files, reporting whether the walk was complete. */
async function collectSkillFiles(directory, signal, warn) {
  const files = []
  const queue = [{ directory, depth: 0 }]
  let complete = true
  while (queue.length > 0) {
    const current = queue.shift()
    signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(current.directory, { withFileTypes: true })
    } catch (error) {
      complete = false
      warn(`cannot read ${current.directory}: ${errorText(error)}`)
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(current.directory, entry.name)
      if (entry.isDirectory()) {
        if (current.depth >= MAX_SCAN_DEPTH || PRUNED_DIRECTORIES.has(entry.name)) continue
        queue.push({ directory: path, depth: current.depth + 1 })
        continue
      }
      if (entry.isFile() && entry.name === 'SKILL.md') files.push(path)
    }
  }
  files.sort()
  return { files, complete }
}

/** Read one `SKILL.md` head and turn it into a registry candidate, or skip it with a warning. */
async function readCandidate(path, settings, signal, warn) {
  let head
  try {
    head = await readHead(path, FRONTMATTER_HEAD_BYTES, signal)
  } catch (error) {
    signal?.throwIfAborted()
    warn(`cannot read ${path}: ${errorText(error)}`)
    return undefined
  }
  let parsed = parseFrontmatter(head.text)
  if (parsed === undefined && head.truncated) {
    try {
      parsed = parseFrontmatter(await readFile(path, { encoding: 'utf8', signal }))
    } catch (error) {
      signal?.throwIfAborted()
      warn(`cannot read ${path}: ${errorText(error)}`)
      return undefined
    }
  }
  if (parsed === undefined) {
    warn(`${path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const skillName = scalar(parsed.data.name)
  const description = normalizeWhitespace(scalar(parsed.data.description))
  if (skillName === undefined || !SKILL_NAME.test(skillName)) {
    warn(`${path} ignored: frontmatter needs a kebab-case name`)
    return undefined
  }
  if (description === undefined) {
    warn(`${path} ignored: frontmatter needs a description`)
    return undefined
  }
  const whenToUse = normalizeWhitespace(scalar(parsed.data.whenToUse))
  return {
    name: skillName,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: invocationOf(parsed.data),
    source: settings.source,
    provider: settings.providerName,
    resourceBase: { kind: 'directory', path: dirname(path) },
    rank: settings.rank,
    locator: path,
    path,
  }
}

/** Read at most `bytes` from the head of a file. */
async function readHead(path, bytes, signal) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(bytes)
    const result = await handle.read(buffer, 0, bytes, 0)
    signal?.throwIfAborted()
    return { text: buffer.subarray(0, result.bytesRead).toString('utf8'), truncated: result.bytesRead === bytes }
  } finally {
    await handle.close()
  }
}

/**
 * Parse the leading `---` frontmatter block with the small YAML subset these
 * files use: plain and quoted scalars, `|`/`>` block scalars, plain-scalar
 * continuation lines, and one level of nested mapping (`metadata`).
 * @returns `{ data, body }`, or undefined when no closing fence exists.
 */
function parseFrontmatter(raw) {
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return undefined
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) return undefined
  const block = lines.slice(1, closing)
  const data = {}
  let index = 0
  while (index < block.length) {
    const line = block[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (match === null) {
      index += 1
      continue
    }
    const key = match[1]
    const rest = match[2].trim()
    index += 1
    if (rest === '') {
      const nested = {}
      let sawEntry = false
      while (index < block.length && /^\s+\S/.test(block[index])) {
        const entry = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(block[index])
        if (entry !== null) {
          nested[entry[1]] = unquote(entry[2])
          sawEntry = true
        }
        index += 1
      }
      if (sawEntry) data[key] = nested
      continue
    }
    if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
      const folded = rest.startsWith('>')
      const collected = []
      let indent
      while (index < block.length) {
        const current = block[index]
        if (current.trim() === '') {
          collected.push('')
          index += 1
          continue
        }
        const width = current.length - current.trimStart().length
        if (indent === undefined) {
          if (width === 0) break
          indent = width
        } else if (width < indent) break
        collected.push(current.slice(indent))
        index += 1
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      data[key] = collected.join(folded ? ' ' : '\n')
      continue
    }
    let value = rest
    while (index < block.length && /^\s+\S/.test(block[index]) && !/^\s*[-#]/.test(block[index])) {
      value += ` ${block[index].trim()}`
      index += 1
    }
    data[key] = unquote(value)
  }
  return { data, body: lines.slice(closing + 1).join('\n') }
}

/** Resolve the invocation policy, including the repository's `metadata.user-invocable` form. */
function invocationOf(data) {
  const metadata = typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}
  const disableModelInvocation = booleanValue(data['disable-model-invocation'])
  const userInvocable = booleanValue(data['user-invocable']) ?? booleanValue(metadata['user-invocable'])
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** Read a scalar value, ignoring nested mappings. */
function scalar(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Collapse YAML block-scalar line breaks into one display line. */
function normalizeWhitespace(value) {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length === 0 ? undefined : normalized
}

/** Strip one layer of YAML quoting and resolve the escapes a frontmatter value may use. */
function unquote(value) {
  const text = value.trim()
  if (text.length < 2) return text
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nrt])/g, (_match, escaped) => {
      if (escaped === 'n') return '\n'
      if (escaped === 't') return '\t'
      if (escaped === 'r') return '\r'
      return escaped
    })
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  return text
}

/** Read the YAML boolean spellings a frontmatter may carry. */
function booleanValue(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value !== 'string') return undefined
  switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
      return true
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}

/** Normalize one configuration field into a list. */
function toArray(value) {
  return Array.isArray(value) ? value : [value]
}

/** Render an unknown thrown value for a log line. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
