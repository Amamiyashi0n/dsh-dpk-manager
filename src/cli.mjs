#!/usr/bin/env node

/**
 * The standalone `dpk` command installed by npm.
 *
 * This is deliberately a thin adapter: command execution remains in
 * `lib/cli.mjs`, so the npm binary, Host tool and Web Remote keep one action
 * implementation. The standalone entry point is primarily useful for local
 * package authors who need to build and verify `.dpk` archives.
 *
 * @module dpk/cli
 */

import { DPK_ACTIONS, DpkActionError, runDpkAction } from './lib/cli.mjs'
import { DPK_GENERATOR } from './lib/dpk-manifest.mjs'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const COMMAND_OPTIONS = new Set([
  'all', 'created-at', 'deep', 'directory', 'file', 'generator', 'home', 'name',
  'no-deep', 'op', 'output', 'profile', 'reinstall', 'timestamp', 'to', 'verb', 'via',
])

const BOOLEAN_OPTIONS = new Set(['all', 'deep', 'no-deep', 'reinstall'])

const HELP = `Usage: dpk <command> [value] [options]

Commands:
  build <directory>       Validate a DSH package and write a .dpk archive
  verify <file>            Validate a .dpk archive before installation
  show <file>              Print a .dpk manifest
  install <file>           Install a local .dpk into a DSH profile
  remove <name>            Remove a package from a DSH profile
  purge <name>             Delete a package's managed data volumes
  list                     List packages in the local DPK store
  autoremove               Collect unreferenced local package copies
  export <name>|all        Export app volumes
  snap <name>|all          Snapshot app and data volumes
  import <file>            Import a data file or .dpks archive
  pkg <op> <file>          Inspect or adjust a data file

Build options:
  -o, --output <path>      Archive path or output directory
  --created-at <value>     Manifest timestamp, or "now"
  --timestamp <value>      ZIP entry timestamp

Common options:
  --home <path>            DSH home for profile/store actions
  --profile <name>         Target profile
  --json                   Print the action result as JSON
  -h, --help               Show this help
  -v, --version            Show the installed dpk version

Key-value syntax used by the in-session tool is also accepted, for example:
  dpk build directory=./my-plugin output=./dist/
`

function usageError(message) {
  return new DpkActionError(`${message}\nRun \`dpk --help\` for usage.`)
}

function canonicalOptionName(raw) {
  const name = raw.replace(/^--?/, '')
  if (name === 'o') return 'output'
  if (name === 'd') return 'directory'
  if (name === 'f') return 'file'
  if (name === 'h' || name === 'v') return name
  return name
}

function parseBoolean(value, key) {
  if (value === undefined) return true
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw usageError(`--${key} expects true or false`)
}

function setOption(args, key, value) {
  if (!COMMAND_OPTIONS.has(key)) throw usageError(`unknown option: --${key}`)
  if (BOOLEAN_OPTIONS.has(key)) {
    const boolean = parseBoolean(value, key)
    if (key === 'no-deep') args.deep = !boolean
    else args[key] = boolean
    if (key === 'no-deep') delete args['no-deep']
    return
  }
  if (value === undefined || value === '') throw usageError(`--${key} needs a value`)
  const target = key === 'created-at' ? 'createdAt' : key
  args[target] = value
}

function parseKeyValue(token) {
  const equals = token.indexOf('=')
  if (equals < 1) return undefined
  const rawKey = token.slice(0, equals)
  const value = token.slice(equals + 1)
  const key = rawKey.replace(/^--?/, '')
  if (key === 'created-at') return ['created-at', value]
  return [key, value]
}

/**
 * Parse the small command syntax used by the npm binary.
 * @param {string[]} argv
 * @returns {{ action: string, args: Record<string, unknown>, context: Record<string, unknown>, json: boolean }}
 */
export function parseCliArgs(argv) {
  if (argv.length === 0) throw usageError('a command is required')
  if (argv[0] === '--help' || argv[0] === '-h') return { help: true }
  if (argv[0] === '--version' || argv[0] === '-v') return { version: true }
  const [action, ...tokens] = argv
  if (!DPK_ACTIONS.includes(action)) throw usageError(`unknown command: ${action}`)

  const args = {}
  const context = {}
  const positionals = []
  let json = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--help' || token === '-h') return { help: true }
    if (token === '--version' || token === '-v') return { version: true }
    if (token === '--json') {
      json = true
      continue
    }

    const pair = parseKeyValue(token)
    if (pair !== undefined) {
      const [key, value] = pair
      if (key === 'home') context.home = value
      else if (key === 'profile') context.profile = value
      else setOption(args, key, value)
      continue
    }

    if (token.startsWith('-')) {
      const rawKey = canonicalOptionName(token)
      if (rawKey === 'h' || rawKey === 'v') continue
      let value
      if (!BOOLEAN_OPTIONS.has(rawKey)) {
        value = tokens[index + 1]
        if (value === undefined || value.startsWith('-')) throw usageError(`--${rawKey} needs a value`)
        index += 1
      }
      if (rawKey === 'home') context.home = value
      else if (rawKey === 'profile') context.profile = value
      else setOption(args, rawKey, value)
      continue
    }
    positionals.push(token)
  }

  const positionalKey = action === 'build'
    ? 'directory'
    : action === 'verify' || action === 'install' || action === 'import'
      ? 'file'
      : action === 'remove' || action === 'purge' || action === 'export' || action === 'snap'
        ? 'name'
        : action === 'pkg'
          ? 'op'
          : undefined
  if (action === 'show' && positionals.length > 0 && args.file === undefined && args.name === undefined) {
    const value = positionals.shift()
    if (value.endsWith('.dpk') || value.includes('/') || value.includes('\\') || existsSync(value)) args.file = value
    else args.name = value
  } else if (positionalKey !== undefined && positionals.length > 0 && args[positionalKey] === undefined) {
    args[positionalKey] = positionals.shift()
  }
  if ((action === 'export' || action === 'snap') && args.name === 'all') {
    delete args.name
    args.all = true
  }
  if (action === 'pkg' && args.op !== undefined && args.file === undefined && positionals.length > 0) {
    args.file = positionals.shift()
  }
  if (positionals.length > 0) throw usageError(`unexpected argument: ${positionals[0]}`)

  if (action === 'install' && args.via !== undefined) context.installMode = args.via
  return { action, args, context, json }
}

function printResult(result, json) {
  process.stdout.write(json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.text}\n`)
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv)
  if (parsed.help === true) {
    process.stdout.write(HELP)
    return 0
  }
  if (parsed.version === true) {
    process.stdout.write(`${DPK_GENERATOR.slice('dpk/'.length)}\n`)
    return 0
  }
  const result = await runDpkAction(parsed.action, parsed.args, parsed.context)
  printResult(result, parsed.json)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`dpk: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
