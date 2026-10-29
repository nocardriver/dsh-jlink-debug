import { findJLink, perform } from "./jlink.js"
const exe = await findJLink()
const config = { jlinkExe: exe, device: "STM32H503CB", interface: "SWD", speedKhz: 4000, timeoutMs: 30000, maxReadBytes: 512 }
const state = { halted: undefined }
const run = async (action, params) => {
  const t = Date.now()
  try { const r = await perform(config, action, params, state); console.log(`--- ${action} (${Date.now()-t}ms) halted=${state.halted} ---`); console.log(JSON.stringify(r).slice(0, 600)) }
  catch (e) { console.log(`--- ${action} FAILED ---`, e.message) }
}
await run("status")
await run("read_memory", { address: 0x08000000, length: 20 })
await run("registers")
await run("halt")
await run("status")
await run("read_memory", { address: 0xE000ED00, length: 12 })
await run("resume")
await run("status")
