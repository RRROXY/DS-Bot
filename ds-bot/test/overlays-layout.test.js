import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/overlays.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment', Component: class {},
  createContext: value => ({ value }), useContext: context => context.value,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }),
  useMemo: make => make(), useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, get) => get(), useId: () => 'id',
}
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => ({ react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': {} })[name],
  document: { body: {} }, window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  setTimeout, clearTimeout,
})
const { Overlays } = module.exports
const render = ({ viewport = 1280, width = 280, pref = 'open', track = 0, drawer = false, panel = {} } = {}) => Overlays({
  useRoster: select => select({ bots: [], byId: {}, roomsById: {} }),
  useUi: select => select({ newChat: 'new', exchange: ['a', 'b'], voice: 'a', leftDrawer: drawer, ...panel }),
  useSessions: select => select({ byId: {} }), useRegistry() {},
  useFrame: select => select({ viewport, sidebarWidth: width, collapsedWidth: track }),
  useSidebarPref: select => select(pref), actions: {},
})

// The DSH sidebar is collapsed underneath the Bot column, so its footer no longer
// tells an overlay where the conversation begins. Every pane uses the frame layout.
test('conversation overlays follow open, rail, hidden and floating Bot columns', () => {
  const cases = [
    [{}, 280],
    [{ width: 360 }, 360],
    [{ pref: 'rail' }, 88],
    [{ pref: 'hidden' }, 0],
    [{ pref: 'hidden', track: 56 }, 56],
    [{ viewport: 600, drawer: true }, 88],
    [{ viewport: 1000, panel: { details: 'a', view: 'browser', panelYield: true } }, 88],
  ]
  for (const [input, expected] of cases) {
    const panes = render(input).children.filter(node => ['NewChat', 'ExchangeDialog', 'VoiceMode'].includes(node?.type?.name))
    assert.equal(panes.length, 3)
    for (const pane of panes) assert.equal(pane.props.paneLeft, expected, `${pane.type.name}: ${JSON.stringify(input)}`)
    const newChat = panes.find(node => node.type.name === 'NewChat')
    assert.equal(newChat.type(newChat.props).props.style.left, expected)
  }
})
