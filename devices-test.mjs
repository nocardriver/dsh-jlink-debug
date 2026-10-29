// Exercises the J-Link device database: export, parse, cache, search, history.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDevice, loadDeviceDatabase, readDeviceHistory, recordDeviceHistory, searchDevices } from './devices.js'
import { findJLink } from './jlink.js'

const exe = process.argv[2] ?? (await findJLink())
if (exe === undefined) {
  console.log('J-Link not found; pass the path to JLink.exe as the first argument')
  process.exit(1)
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-jlink-devices-test-'))
try {
  let started = Date.now()
  const first = await loadDeviceDatabase({ exe, dir })
  console.log(`export: ${first.total} devices from ${first.jlink || 'J-Link'} in ${Date.now() - started} ms`)
  started = Date.now()
  const second = await loadDeviceDatabase({ exe, dir })
  console.log(`cache: ${Date.now() - started} ms (cached=${second.cached})`)

  for (const query of ['stm32h503', 'stm32 h503', 'nrf52840', 'rp2040']) {
    const found = searchDevices(second, query, 5)
    console.log(`search "${query}": ${found.matched} matches · ${found.items.map((device) => device.name).join(', ')}`)
  }

  const exact = findDevice(second, 'STM32H503CB')
  console.log(`exact STM32H503CB: ${exact === undefined ? 'missing' : `${exact.vendor} / ${exact.core}`}`)

  await recordDeviceHistory(dir, 'STM32H503CB')
  await recordDeviceHistory(dir, 'stm32h503cb')
  await recordDeviceHistory(dir, 'N32G430C8')
  console.log('history:', (await readDeviceHistory(dir)).map((entry) => entry.name).join(' > '))
} finally {
  await rm(dir, { recursive: true, force: true })
}
