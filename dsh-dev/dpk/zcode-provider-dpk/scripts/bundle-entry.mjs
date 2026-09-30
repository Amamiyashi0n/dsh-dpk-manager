/**
 * Build step: keep the plain tsc entry as lib/index.unbundled.js, then emit a
 * self-contained lib/index.js with the vendored dsh-llm/schemastery inlined so
 * the host half imports with zero peer resolution on any installation.
 */
import { copyFileSync } from 'node:fs'
import { build } from 'esbuild'

copyFileSync('lib/index.js', 'lib/index.unbundled.js')
await build({
  entryPoints: ['lib/index.unbundled.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'lib/index.js',
  banner: { js: '/* zcode-provider bundled entry: inlines vendored dsh-llm and schemastery for zero-peer-resolution import; boundary discipline lives in src and unbundled modules */' },
})
console.log('bundled lib/index.js (self-contained entry)')
