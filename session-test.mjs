// Session regression: attach without reset, background reads that keep the core
// executing, halt/resume, step, breakpoint stop detection, reset and release.
//
// The device name must match the board on the probe. Adjust it here (or set
// JLink device in the plugin panel and copy it) before running against a
// different target.
import { ProbeSession } from './session.js'
import { findSymbol, loadSymbols } from './elf.js'

const DEVICE = process.env.JLINK_TEST_DEVICE ?? 'STM32G431CB'
const ELF = process.env.JLINK_TEST_ELF
  ?? 'C:\\Users\\Forwork\\Documents\\XL_repo\\MotorTest\\build\\ATfE-Debug\\SingleMotorDriver_ATfE_Debug.elf'

const watchdog = setTimeout(() => {
  console.log('WATCHDOG: session hung (likely a serialization deadlock)')
  process.exit(1)
}, 120000)

const config = {
  device: DEVICE,
  interface: 'SWD',
  speedKhz: 4000,
  jlinkExe: 'C:\\Program Files\\SEGGER\\JLink_V952\\JLink.exe',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Number(process.hrtime.bigint()) / 1e6
const word = (bytes) => (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0

const timed = async (label, fn) => {
  const started = Date.now()
  try {
    const value = await fn()
    console.log(`${label} (${Date.now() - started} ms): ${JSON.stringify(value).slice(0, 200)}`)
    return value
  } catch (error) {
    console.log(`${label} FAILED (${Date.now() - started} ms): ${error.message}`)
    return undefined
  }
}

const session = new ProbeSession(config)
try {
  await timed('open (resumes)', () => session.open())
  console.log('  state after open:', session.state)

  // Background reads must not stop the core: compare executed cycles with wall
  // time across a burst of reads, and watch a free-running counter advance.
  const tick0 = word(await session.readSnapshot(0x200001a4, 4))
  const cycles0 = word(await session.readSnapshot(0xe0001004, 4))
  const wallStart = now()
  for (let i = 0; i < 40; i += 1) await session.readSnapshot(0xe0001004, 4)
  const wall = now() - wallStart
  const cycles1 = word(await session.readSnapshot(0xe0001004, 4))
  const tick1 = word(await session.readSnapshot(0x200001a4, 4))
  console.log(`  background: 40 reads in ${wall.toFixed(1)} ms, ${((cycles1 - cycles0) >>> 0)} cycles `
    + `(${(((cycles1 - cycles0) >>> 0) / wall / 1000).toFixed(1)} MHz effective), uwTick ${tick0} -> ${tick1}`)
  console.log('  background status:', JSON.stringify(session.backgroundStatus))

  const memory = await timed('readMemory while running', () => session.readMemory(0x08000000, 32))
  console.log('  state after read (must stay running):', session.state, 'background:', memory?.background)

  await timed('registers while running', () => session.registers())
  console.log('  state after registers (halt window):', session.state)

  await timed('write_memory', () => session.writeMemory(0x20007f00, [1, 2, 3, 4]))
  console.log('  state after write:', session.state)

  await timed('halt', () => session.halt())
  console.log('  state after halt:', session.state)

  await timed('read while halted', () => session.readMemory(0x08000000, 16))

  await timed('step 2', () => session.step(2))
  await timed('registers', () => session.registers())

  if (ELF !== '') {
    const table = await loadSymbols(ELF)
    const target = findSymbol(table, 'HAL_IncTick')
    if (target !== undefined) {
      const bp = target.address & ~1
      await timed(`breakpoint ${target.name}`, () => session.setBreakpoint(bp))
      await timed('resume', () => session.resume())
      let refreshed
      for (let i = 0; i < 100; i += 1) {
        refreshed = await session.refresh()
        if (refreshed.state === 'halted') break
        await sleep(5)
      }
      console.log(`  breakpoint detected: ${JSON.stringify(refreshed)}`)
      const registers = await session.registers()
      console.log(`  PC at hit: 0x${registers.registers.PC} (expected 0x${bp.toString(16)})`)
      await timed('clear breakpoint', () => session.clearBreakpoint(bp))

      // A silent hit leaves `state` saying running while the core sits on the
      // breakpoint. resume() has to notice that and step over it, or the button
      // in the panel would do nothing. The watch point stays armed, so only
      // about one millisecond of code runs before it stops again — enough for
      // uwTick to advance by one.
      await timed('re-arm breakpoint', () => session.setBreakpoint(bp))
      await timed('resume with the breakpoint armed', () => session.resume())
      await sleep(80)
      const tickBefore = word(await session.readSnapshot(0x200001a4, 4))
      console.log('  state after silent hit (stale by design):', session.state)
      await timed('resume after silent hit', () => session.resume())
      await sleep(60)
      const tickAfter = word(await session.readSnapshot(0x200001a4, 4))
      console.log(`  uwTick ${tickBefore} -> ${tickAfter}: ${tickAfter > tickBefore ? 'resumed' : 'NOT resumed'}`)
      await timed('clear breakpoint', () => session.clearBreakpoint(bp))
    }
  }

  await timed('reset', () => session.reset())
  await timed('registers after reset', () => session.registers())
  await timed('resume after reset', () => session.resume())
  await sleep(100)
  console.log('  state after reset+resume:', session.state)
} finally {
  await timed('close', () => session.close())
  clearTimeout(watchdog)
}
