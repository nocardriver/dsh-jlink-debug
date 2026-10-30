// Tool-path regression without DSH: mount the plugin in a stub Cordis context
// and drive mcu_debug's watch actions through their real execute().
import { mkdirSync, rmSync } from 'node:fs'

const ELF = 'C:\\Users\\Forwork\\Documents\\XL_repo\\MotorTest\\build\\ATfE-Debug\\SingleMotorDriver_ATfE_Debug.elf'
const PROFILE = 'C:\\Users\\Forwork\\Documents\\XL_repo\\dsh-jlink-debug\\.tmp-test-profile'
mkdirSync(PROFILE, { recursive: true })
// The plugin resolves its state directory when the module loads, so the
// throwaway profile has to be in place before the import.
process.env.DSH_PROFILE_DIR = PROFILE
process.env.DSH_HOME = PROFILE
const { apply } = await import('./index.js')

const tools = new Map()
const workspaces = [{ id: 'ws-test', path: process.cwd(), title: 'test', sessionIds: ['test-session'] }]
const ctx = {
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    if (name === 'sessions') return { get: () => ({ header: { cwd: process.cwd() } }) }
    return undefined
  },
  inject(_services, callback) { return callback(ctx) },
  effect(fn) { fn() },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => {}
    },
  },
}

apply(ctx, {
  device: 'STM32G431CB',
  interface: 'SWD',
  speedKhz: 4000,
  jlinkExe: 'C:\\Program Files\\SEGGER\\JLink_V952\\JLink.exe',
  idleCloseMs: 0,
  maxReadBytes: 4096,
})
console.log('tools:', [...tools.keys()].join(', '))

const call = async (args) => {
  const started = Date.now()
  try {
    const value = await tools.get('mcu_debug').execute(args, { agent: { id: 'test-session' }, signal: undefined })
    const payload = value?.value ?? value
    console.log(`\n== ${args.action} (${Date.now() - started} ms) ==`)
    console.log(String(payload?.summary ?? '').slice(0, 300))
    return payload
  } catch (error) {
    console.log(`\n== ${args.action} FAILED (${Date.now() - started} ms) ==`)
    console.log(error.stack)
    return undefined
  }
}

try {
  await call({ action: 'connect', file: ELF })
  const capture = await call({
    action: 'capture',
    file: ELF,
    symbols: ['uwTick', 'foc_isr.calc_cnt', 'motor[0].velocity_pid_data.Kp', 'foc_runtime.busy'],
    samples: 60,
    periodMs: 20,
    resume: true,
  })
  console.log('capture items:', capture?.items?.map((item) => `${item.name} last=${item.last} distinct=${item.distinct}`).join(' | '))
  console.log('capture samples per item:', capture?.items?.[0]?.samples?.length, 'times:', capture?.times?.length)

  const watch = await call({ action: 'watch', symbols: ['foc_isr.calc_cnt', 'foc_runtime.busy'], periodMs: 20, resume: true })
  console.log('watch running:', watch?.running, 'points:', watch?.points?.join(', '))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const read = await call({ action: 'watch_read', samples: 10 })
  console.log('watch_read collected:', read?.collected, 'kept:', read?.items?.[0]?.samples?.length, 'state:', read?.state)
  const status = await call({ action: 'status' })
  console.log('status watch:', JSON.stringify(status?.watch))
  await call({ action: 'watch_stop' })

  const halted = await call({ action: 'halt' })
  console.log('halted state:', halted?.state, 'stop:', JSON.stringify(halted?.stop))
  const flat = await call({ action: 'capture', symbols: ['uwTick'], samples: 5, periodMs: 10 })
  console.log('capture while halted distinct:', flat?.items?.[0]?.distinct, 'summary:', flat?.summary)
  await call({ action: 'resume' })
  const resumed = await call({ action: 'capture', symbols: ['uwTick'], samples: 5, periodMs: 10 })
  console.log('capture after resume distinct:', resumed?.items?.[0]?.distinct)

  const bad = await call({ action: 'watch', symbols: ['no_such_symbol_xyz'] })
  console.log('bad symbol error surfaced:', bad === undefined)
  const badPath = await call({ action: 'watch', symbols: ['motor[0].not_a_member'] })
  console.log('bad path error surfaced:', badPath === undefined)
} finally {
  try { await tools.get('mcu_debug').execute({ action: 'disconnect' }, { agent: { id: 'test-session' } }) } catch {}
  rmSync(PROFILE, { recursive: true, force: true })
  console.log('\ndone')
}
