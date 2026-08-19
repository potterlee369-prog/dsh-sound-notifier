// Build script: esbuild bundles the host entry and the client entry
// (CSS imported as text and injected at materialization, matching the
// harness's own client bundles), then tsc emits declaration files.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
})

// The client bundle must match the harness's lazy-CJS module contract: a
// classic script that registers a factory with window.__ModuleLoader__.load,
// whose factory receives the module table's require and RETURNS its exports.
// esbuild's cjs output plus a banner/footer wrapper reproduces that shape.
const wrapPrefix = `window.__ModuleLoader__.load({
  id: "dsh-sound-notifier",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
`
const wrapSuffix = `    return module.exports;
  },
});
`

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text' },
  banner: { js: wrapPrefix },
  footer: { js: wrapSuffix },
  logLevel: 'info',
})

execFileSync(process.execPath, [resolve(here, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
  stdio: 'inherit',
})
console.log('build done')
