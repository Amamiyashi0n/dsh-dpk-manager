import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sections = [
  { id: 'identity', title: '身份提示词' },
  { id: 'agent', title: 'Agent 主提示词' },
  { id: 'runtime', title: '运行时提示词模板' },
]
const file = resolve(root, 'client.js')
const source = await readFile(file, 'utf8')
const replacement = `const PROMPT_LAYERS = /* DSH_PROMPT_LAYERS */ ${JSON.stringify(sections, null, 2)}`
const marker = /const PROMPT_LAYERS = \/\* DSH_PROMPT_LAYERS \*\/ \[[\s\S]*?\n\s*\]/
if (!marker.test(source)) throw new Error('client prompt marker not found')
await writeFile(file, source.replace(marker, replacement), 'utf8')
