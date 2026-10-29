// Exercises the attach-resumes path and the halt-window helpers (deadlock check).
import { ProbeSession } from './session.js'

const watchdog = setTimeout(() => {
  console.log('WATCHDOG: session hung (likely a serialization deadlock)')
  process.exit(1)
}, 60000)

const config = {
  device: 'STM32H503CB',
  interface: 'SWD',
  speedKhz: 4000,
  jlinkExe: 'C:\\Program Files\\SEGGER\\JLink_V952\\JLink.exe',
}

const timed = async (label, fn) => {
  const started = Date.now()
  try {
    const value = await fn()
    const text = value === undefined ? 'undefined' : JSON.stringify(value)
    console.log(`${label} (${Date.now() - started} ms): ${text.slice(0, 300)}`)
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

  await timed('registers while running', () => session.registers())
  console.log('  state after read:', session.state)

  await timed('read_memory while running', () => session.readMemory(0x08000000, 64))
  console.log('  state after read:', session.state)

  await timed('write_memory while running', () => session.writeMemory(0x20007f00, [1, 2, 3, 4]))
  console.log('  state after write:', session.state)

  await timed('halt', () => session.halt())
  console.log('  state after halt:', session.state)

  await timed('read while halted', () => session.readMemory(0x08000000, 16))
  console.log('  state after read (should stay halted):', session.state)

  await timed('step 2', () => session.step(2))
  await timed('registers', () => session.registers())

  await timed('resume', () => session.resume())
  console.log('  state after resume:', session.state)
} finally {
  await timed('close', () => session.close())
  clearTimeout(watchdog)
}
