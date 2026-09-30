/**
 * Build step: keep the plain tsc entry as lib/index.unbundled.js, then emit a
 * self-contained lib/index.js with the vendored dsh-llm/schemastery inlined so
 * the host half imports with zero peer resolution on any installation.
 *
 * dsh-llm resolves to the local DeepSeek Harness checkout's build: the app's
 * runtime expects that generation's adapter base class (prepareCall); the
 * registry's 0.0.1-rc.1 predates it.
 */
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const REPO_LLM = fileURLToPath(new URL('../../../deepseek-harness/packages/llm/llm/lib/index.js', import.meta.url))

const repoLlm = {
  name: 'repo-dsh-llm',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-llm$/ }, () => ({ path: REPO_LLM }))
  },
}

copyFileSync('lib/index.js', 'lib/index.unbundled.js')
await build({
  entryPoints: ['lib/index.unbundled.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'lib/index.js',
  plugins: [repoLlm],
  banner: { js: '/* zcode-provider bundled entry: inlines vendored dsh-llm and schemastery for zero-peer-resolution import; boundary discipline lives in src and unbundled modules */' },
})
console.log('bundled lib/index.js (self-contained entry, dsh-llm from harness checkout)')
