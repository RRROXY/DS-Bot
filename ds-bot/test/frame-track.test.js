import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundle = await build({
  stdin: { contents: "export { sidebarTrackWidth } from './src/client/frame-watch.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom'],
})

test('an off-canvas sidebar reserves no track even though its drawer keeps its full width', () => {
  let column = { position: 'static', getBoundingClientRect: () => ({ width: 280, x: 0 }) }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: () => ({}),
    document: { querySelector: () => column },
    getComputedStyle: element => ({ position: element.position }),
  })
  const { sidebarTrackWidth } = module.exports
  assert.equal(sidebarTrackWidth(), 280)
  column = { position: 'absolute', getBoundingClientRect: () => ({ width: 280, x: -280 }) }
  assert.equal(sidebarTrackWidth(), 0)
  column.position = 'fixed'
  assert.equal(sidebarTrackWidth(), 0)
  column = null
  assert.equal(sidebarTrackWidth(), null)
})
