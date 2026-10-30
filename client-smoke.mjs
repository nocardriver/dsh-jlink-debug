// Client smoke test: execute client.js against a tiny React stand-in, then
// render the tool cards and the sidebar tab with realistic Host documents.
// It catches typos and undefined references in the render paths; layout is
// still the browser's business.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- React stub
const instances = new Map()
const rendered = []
let current
let hookCursor = 0
let dirty = false
let queuedEffects = []

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const instance = current
    const index = hookCursor++
    if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(instance.hooks[index]) : next
      if (!Object.is(value, instance.hooks[index])) {
        instance.hooks[index] = value
        dirty = true
      }
    }
    return [instance.hooks[index], set]
  },
  useEffect(effect) {
    if (current.ranEffects !== true) queuedEffects.push(effect)
  },
  useRef(value) {
    const instance = current
    const index = hookCursor++
    if (!(index in instance.hooks)) instance.hooks[index] = { current: value }
    return instance.hooks[index]
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

const registrations = []
const pluginModule = { inject: [], apply() {} }
const loader = {
  load(spec) {
    const exported = spec.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    })
    pluginModule.inject = exported.inject
    pluginModule.apply = exported.apply
  },
}

// -------------------------------------------------------------- host fixtures
const workspaceDoc = {
  ok: true,
  workspace: { key: 'ws-1', path: 'C:\\Users\\Forwork\\Documents\\XL_repo\\MotorTest', title: 'MotorTest', source: 'workspace' },
  fields: [
    { key: 'device', kind: 'text', value: 'STM32G431CB', default: 'STM32H503CB', override: true },
    { key: 'interface', kind: 'select', options: ['SWD', 'JTAG'], value: 'SWD', default: 'SWD', override: false },
    { key: 'speedKhz', kind: 'number', min: 100, max: 50000, value: 4000, default: 4000, override: false },
  ],
  session: { open: true, state: 'running', probe: { core: 'Cortex-M4', device: 'STM32G431CB' }, connectsTo: 'STM32G431CB' },
  elf: { file: 'C:\\Users\\Forwork\\Documents\\XL_repo\\MotorTest\\build\\ATfE-Debug\\SingleMotorDriver_ATfE_Debug.elf', symbols: 1405, functions: 312 },
}

const watchDoc = {
  ok: true,
  configured: true,
  running: true,
  session: 'open',
  state: 'running',
  periodMs: 20,
  collected: 120,
  dropped: 1,
  startedAt: '2026-10-30T01:00:00.000Z',
  elapsedMs: 2400,
  times: [0, 20, 40, 60],
  points: ['uwTick', 'foc_isr.calc_cnt', 'motor[0].electric_angle'],
  items: [
    { name: 'uwTick', address: '0x200001A4', type: 'volatile uint32_t', size: 4, last: 703665, min: 698060, max: 703665, mean: 700000, distinct: 120, numeric: true, count: 120, samples: [698060, 700000, 701500, 703665] },
    { name: 'foc_isr.calc_cnt', address: '0x20001ED4', type: 'volatile uint32_t', size: 4, last: 5150613, min: 5109523, max: 5150613, mean: 5120000, distinct: 120, numeric: true, count: 120, samples: [5109523, 5120000, 5140000, 5150613] },
    { name: 'motor[0].electric_angle', address: '0x200002E4', type: 'float', size: 4, last: 0, min: 0, max: 0, mean: 0, distinct: 1, numeric: true, count: 120, samples: [0, 0, 0, 0] },
  ],
}

const fetchLog = []
const fetchStub = async (url, options = {}) => {
  const text = String(url)
  fetchLog.push(`${options.method ?? 'GET'} ${text}`)
  const document = text.includes('/jlink-debug/watch') ? watchDoc : workspaceDoc
  return { ok: true, status: 200, json: async () => document }
}

const context = {
  window: { __ModuleLoader__: loader },
  console,
  URL,
  URLSearchParams,
  fetch: fetchStub,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  location: { href: 'http://127.0.0.1:11678/' },
}
vm.createContext(context)
vm.runInContext(source, context, { filename: 'client.js' })

const tabs = { register() { return { dispose() {} } } }
const stubCtx = {
  locale: {
    register() {},
    bind() {
      return (key) => key
    },
  },
  effect(fn) {
    fn()
  },
  get() { return undefined },
  inject(_services, callback) {
    return callback({ ...stubCtx, get: (name) => (name === 'sidebarRightTabs' ? tabs : undefined) })
  },
  slots: {
    inject(_name, callback) {
      return callback()
    },
    register(spec, render) {
      registrations.push({ spec, render })
      return () => {}
    },
  },
}
pluginModule.apply(stubCtx)
console.log('slots:', registrations.map((entry) => `${entry.spec.name}/${entry.spec.key ?? entry.spec.id ?? ''}`).join(', '))

// ------------------------------------------------------------------ rendering
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    const type = node.type
    let instance = instances.get(type)
    if (instance === undefined) {
      instance = { hooks: [], ranEffects: false }
      instances.set(type, instance)
    }
    rendered.push(type.name || 'anonymous')
    const previous = current
    const previousCursor = hookCursor
    current = instance
    hookCursor = 0
    let output
    try {
      output = type({ ...node.props, children: node.children })
    } finally {
      instance.ranEffects = true
      current = previous
      hookCursor = previousCursor
    }
    return expand(output)
  }
  return { ...node, children: (node.children ?? []).map(expand) }
}

const walkProps = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) walkProps(child, out); return out }
  out.push(String(node.type), node.props)
  for (const child of node.children ?? []) walkProps(child, out)
  return out
}
const markupOf = (node) => walkProps(node)
  .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
  .join('\n')

/** Render until no state change is pending (effects resolve their fetch next tick). */
async function settle(makeTree) {
  let tree
  for (let pass = 0; pass < 12; pass += 1) {
    dirty = false
    queuedEffects = []
    tree = expand(makeTree())
    const effects = [...queuedEffects]
    queuedEffects = []
    for (const effect of effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 8))
    if (dirty !== true && pass >= 2) break
  }
  return tree
}

const t = (key) => key
const card = registrations.find((entry) => entry.spec.key === 'mcu_debug')?.render
const panel = registrations.find((entry) => entry.spec.name === 'sidebar.right.pane.tab')?.render
if (card === undefined || panel === undefined) throw new Error('client registrations missing')

const cardDocument = (data, action) => ({
  phase: 'result',
  isError: false,
  args: { action },
  content: [{ type: 'text', text: JSON.stringify(data) }],
})

const statusResult = {
  ok: true,
  action: 'status',
  session: 'open',
  state: 'halted',
  probe: { core: 'Cortex-M4', device: 'STM32G431CB', serial: '601012593', vtref: '3.31' },
  breakpoints: [{ address: '0x080025C8', kind: 'hw' }],
  lastStop: { kind: 'breakpoint', address: '0x080025C8' },
  watch: { running: true, periodMs: 20, collected: 42, state: 'running', points: ['uwTick'] },
  elf: { file: 'C:\\x\\SingleMotorDriver.elf', symbols: 1405, functions: 312 },
  summary: 'Cortex-M4 · halted',
}

for (const [label, data, action, mustContain] of [
  ['watch_read', { ...watchDoc, action: 'watch_read' }, 'watch_read', ['uwTick', 'foc_isr.calc_cnt', 'polyline']],
  ['capture', { ...watchDoc, action: 'capture', running: false, stopReason: 'capture complete' }, 'capture', ['uwTick', 'capture complete']],
  ['watch start', { ok: true, action: 'watch', running: true, state: 'running', periodMs: 20, collected: 0, items: [{ name: 'uwTick', address: '0x200001A4', type: 'volatile uint32_t', size: 4 }], summary: 'watching 1 point' }, 'watch', ['0x200001A4']],
  ['status', statusResult, 'status', ['Cortex-M4', '0x080025C8']],
]) {
  const tree = await settle(() => card({ t, phase: 'result', block: cardDocument(data, action) }))
  const markup = markupOf(tree)
  const missing = mustContain.filter((needle) => !markup.includes(needle))
  console.log(`${label}: ${missing.length === 0 ? 'ok' : `MISSING ${missing.join(',')}`}`)
  if (missing.length > 0) throw new Error(`${label} did not render ${missing.join(', ')}`)
}

rendered.length = 0
const panelTree = await settle(() => panel({ sessionId: 'session-x', t }))
console.log('rendered components:', rendered.join(','))
const panelMarkup = markupOf(panelTree)
for (const needle of ['watch-panel', 'Live watch', 'uwTick', 'motor[0].electric_angle', 'polyline', 'STM32G431CB']) {
  if (!panelMarkup.includes(needle)) {
    console.log('--- watch-related markup ---')
    console.log(panelMarkup.split('\n').filter((line) => line.includes('watch')).slice(0, 40).join('\n'))
    throw new Error(`panel did not render ${needle}`)
  }
}
console.log('panel: ok, requests =', fetchLog.slice(0, 4).join(' | '))
console.log('client smoke test passed')






