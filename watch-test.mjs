// Watch engine regression: resolve real firmware symbols, sample without
// halting, and verify the values actually move.
import { ProbeSession } from './session.js'
import { Watcher } from './watch.js'
import { findSymbol, loadSymbols } from './elf.js'
import { loadDebugInfo } from './dwarf.js'

const ELF = 'C:\\Users\\Forwork\\Documents\\XL_repo\\MotorTest\\build\\ATfE-Debug\\SingleMotorDriver_ATfE_Debug.elf'
const config = {
  device: 'STM32G431CB',
  interface: 'SWD',
  speedKhz: 4000,
  jlinkExe: 'C:\\Program Files\\SEGGER\\JLink_V952\\JLink.exe',
  connectTimeoutMs: 20000,
}

const expressions = [
  'uwTick',
  'foc_isr.calc_cnt',
  'motor[0].electric_angle',
  'motor[0].velocity_pid_data.Kp',
  'foc_runtime.busy',
]

const table = await loadSymbols(ELF)
const debug = await loadDebugInfo(ELF)
const items = expressions.map((name) => {
  const resolved = debug.resolveExpression(name)
  if (resolved === undefined) throw new Error(`cannot resolve ${name}`)
  return {
    name,
    address: resolved.address,
    size: resolved.size,
    type: resolved.type,
    decode: (bytes) => debug.decode(resolved.die, bytes, { depth: 2 }),
  }
})
console.log('items:', items.map((item) => `${item.name} @0x${item.address.toString(16)} ${item.type}`).join('\n       '))
console.log('uwTick symbol:', findSymbol(table, 'uwTick')?.address.toString(16))

const session = new ProbeSession(config)
const watcher = new Watcher(session)
try {
  await session.open()
  console.log('session:', session.state)
  watcher.start(items, { periodMs: 10, capacity: 256 })
  const immediate = watcher.snapshot({ limit: 10 })
  console.log('snapshot before the first tick:', immediate.items[0].samples.length, 'samples,',
    immediate.times.length, 'timestamps (both must be 0)')
  const waited = await watcher.waitFor(100, 5000)
  const snapshot = watcher.snapshot({ limit: 100 })
  watcher.stop('test done')
  console.log('waited:', JSON.stringify(waited), 'collected:', snapshot.collected, 'dropped:', snapshot.dropped)
  for (const item of snapshot.items) {
    const series = item.samples
    console.log(`  ${item.name.padEnd(34)} last=${JSON.stringify(item.last)} min=${item.min} max=${item.max} mean=${item.mean?.toFixed?.(3)} distinct=${item.distinct} n=${item.samples.length}`)
    if (series.length > 6) console.log(`      first: ${series.slice(0, 6).join(', ')}`)
  }
  console.log('state after watch:', session.state, 'background:', JSON.stringify(session.backgroundStatus))
  console.log('20 ms tick cost sample:', snapshot.times.slice(0, 6).map((t) => t.toFixed(0)).join(', '))
} catch (error) {
  console.log('FAILED:', error.stack)
} finally {
  watcher.stop('cleanup')
  await session.close()
  console.log('closed')
}
