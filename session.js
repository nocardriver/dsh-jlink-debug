/**
 * Persistent debug session over JLinkGDBServerCL + GDB RSP.
 *
 * One server process owns the probe for the whole session, which is what makes
 * real run control possible: the core can stay halted, step, hit breakpoints and
 * be sampled repeatedly at sub-millisecond cost. The commander transport in
 * jlink.js could not do that because every call tore the session down.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import net from 'node:net'
import { connectRsp, decodeHexBytes, encodeMonitor, parseStopReply } from './rsp.js'

const CPUID_ADDRESS = 0xe000ed00
// Debug Halting Control and Status Register: bit 17 says the core is halted
// right now, even when the GDB server was never told about the stop.
const DHCSR = 0xe000edf0
const DHCSR_S_HALT = 1 << 17
const MONITOR_TIMEOUT_MS = 3000
// Background reads through the AHB-AP. A monitor packet is serviced while the
// target keeps running; one packet carries at most this many 32-bit words so a
// long read stays a bounded request.
const AHB_TIMEOUT_MS = 2500
const AHB_WORDS_PER_PACKET = 64
// Flash Patch and Breakpoint unit. Comparators live in the debug power domain,
// so a core reset does not clear them: one left armed by an earlier debugger
// pins the core forever at its address, and `z1` cannot remove it because a
// fresh GDB server has no record of it.
const FPB_CTRL = 0xe0002000
const FPB_COMP = 0xe0002008

// GDB server banner reports the device but not the core; CPUID does.
const CORE_PARTS = {
  0xc60: 'Cortex-M0+',
  0xc23: 'Cortex-M3',
  0xc24: 'Cortex-M4',
  0xc27: 'Cortex-M7',
  0xd1e: 'Cortex-M52',
  0xd20: 'Cortex-M23',
  0xd21: 'Cortex-M33',
  0xd22: 'Cortex-M55',
  0xd23: 'Cortex-M85',
}

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`
}

/** Little-endian 32-bit word at `index` of a `g` reply. */
function wordAt(bytes, index) {
  return (bytes[index * 4] | (bytes[index * 4 + 1] << 8) | (bytes[index * 4 + 2] << 16) | (bytes[index * 4 + 3] << 24)) >>> 0
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Resolve the GDB server executable that sits beside JLink.exe. */
export function resolveGdbServer(config) {
  if (typeof config.gdbServerExe === 'string' && config.gdbServerExe !== '') return config.gdbServerExe
  if (typeof config.jlinkExe !== 'string') return undefined
  const candidate = join(dirname(config.jlinkExe), 'JLinkGDBServerCL.exe')
  return existsSync(candidate) ? candidate : undefined
}

export class ProbeSession {
  #chain = Promise.resolve()
  #child
  #rsp
  #stdout = ''
  #probe
  #identity
  /** 'on'/'off' once a background read has told us whether `ReadMemAP` works. */
  #ahb
  #ahbError

  constructor(config) {
    this.config = config
    this.state = 'closed'
    this.lastStop = undefined
    this.breakpoints = new Map()
    this.idleSince = undefined
  }

  #serialize(task) {
    const result = this.#chain.then(() => task())
    this.#chain = result.then(() => undefined, () => undefined)
    return result
  }

  get probe() {
    return this.#probe
  }

  get isOpen() {
    return this.state === 'running' || this.state === 'halted'
  }

  /**
   * Spawn the server and attach RSP. Idempotent.
   * The server halts the core to attach; unless `halt` is requested the core is
   * released immediately so attaching never freezes a running system.
   */
  open(options = {}) {
    return this.#serialize(async () => {
      if (this.isOpen) return this.describe()
      const exe = resolveGdbServer(this.config)
      if (exe === undefined) throw new Error('JLinkGDBServerCL.exe not found; set `gdbServerExe` in the plugin config')
      const port = await freePort()
      this.#stdout = ''
      this.#child = spawn(exe, [
        '-device', this.config.device,
        '-if', this.config.interface,
        '-speed', String(this.config.speedKhz),
        '-port', String(port),
        '-swoport', String(port + 1),
        '-telnetport', String(port + 2),
        '-nogui',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.#child.stdout.on('data', (chunk) => { this.#stdout += chunk.toString('utf8') })
      this.#child.stderr.on('data', (chunk) => { this.#stdout += chunk.toString('utf8') })
      this.#child.on('exit', () => {
        this.state = 'closed'
        this.#rsp?.close()
      })

      await this.#waitForListening()
      this.#rsp = await connectRsp({ port, timeoutMs: 10000 })
      await this.#rsp.request('qSupported:multiprocess+;xmlRegisters=arm')
      this.state = 'halted'
      this.lastStop = parseStopReply(await this.#rsp.request('?')) ?? { kind: 'signal', signal: 5 }
      this.#identity = await this.#identifyCore()
      // Recover a target left pinned by a previous session's comparator.
      this.state = 'halted'
      await this.#disarmAllComparators()
      if (options.halt !== true) await this.#resumeCore()
      this.idleSince = undefined
      return this.describe()
    })
  }

  async #waitForListening() {
    const deadline = Date.now() + (this.config.connectTimeoutMs ?? 20000)
    while (Date.now() < deadline) {
      if (/Listening on TCP\/IP port/i.test(this.#stdout)) return
      const failure = this.#stdout.match(/^(?:Could not|Cannot|ERROR|Failed|Unknown device)[^\n]*/im)
      if (failure !== null) throw new Error(failure[0].trim())
      if (this.#child.exitCode !== null) {
        throw new Error(`J-Link GDB server exited with code ${this.#child.exitCode}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('J-Link GDB server did not start listening in time')
  }

  describe() {
    const probe = parseProbeBanner(this.#stdout)
    if (this.#identity?.core !== undefined) probe.core = this.#identity.core
    if (this.#identity?.cpuid !== undefined) probe.cpuid = this.#identity.cpuid
    this.#probe = probe
    return {
      session: this.isOpen ? 'open' : 'closed',
      state: this.state,
      probe,
      breakpoints: [...this.breakpoints.entries()].map(([address, kind]) => ({ address: hex(address), kind })),
    }
  }

  /** Identify the core from CPUID; the GDB banner does not name it. */
  async #identifyCore() {
    try {
      const reply = await this.#rsp.request(`m${CPUID_ADDRESS.toString(16)},4`)
      if (!/^[0-9a-fA-F]{8}$/.test(reply)) return undefined
      const value = wordAt(decodeHexBytes(reply), 0)
      return {
        cpuid: `0x${value.toString(16).toUpperCase().padStart(8, '0')}`,
        core: CORE_PARTS[(value >>> 4) & 0xfff],
      }
    } catch {
      return undefined
    }
  }

  /** Number of code comparators the FPB implements, or 0 when it is absent. */
  async #comparatorCount() {
    const ctrl = wordAt(decodeHexBytes(await this.#send(`m${FPB_CTRL.toString(16)},4`)), 0)
    return (ctrl >>> 4) & 0xf
  }

  /**
   * Zero every armed comparator. Called on attach, on clear and on release.
   * `z1` alone is not enough: it returns OK even when the comparator stays armed
   * because the core is sitting on it, and a stale comparator pins the core at
   * its address so every continue returns instantly without executing anything.
   */
  async #disarmAllComparators() {
    try {
      const count = await this.#comparatorCount()
      for (let i = 0; i < count; i += 1) {
        const address = FPB_COMP + i * 4
        const value = wordAt(decodeHexBytes(await this.#send(`m${address.toString(16)},4`)), 0)
        if (value !== 0) await this.#send(`M${address.toString(16)},4:00000000`)
      }
    } catch {
      // No FPB on this core, or no access to it: nothing to clean up.
    }
  }

  close() {
    return this.#serialize(async () => {
      if (!this.isOpen) return { session: 'closed' }
      try {
        // Leave the target running, but without a breakpoint the probe would
        // stop on: clear them first so `go` below really starts the firmware.
        if (this.state === 'running') await this.#haltCore().catch(() => {})
        for (const [address, kind] of this.breakpoints) {
          await this.#rsp?.request(`${kind === 'sw' ? 'z0' : 'z1'},${address.toString(16)},2`, 1000).catch(() => {})
        }
        await this.#disarmAllComparators()
        await this.#monitor('go', 1500).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 150))
      } catch {
        // teardown continues regardless
      }
      this.#rsp?.close()
      this.#rsp = undefined
      this.#child?.kill()
      this.#child = undefined
      this.state = 'closed'
      this.breakpoints.clear()
      return { session: 'closed' }
    })
  }

  /**
   * Start the core running. Returns immediately; a stop surfaces on refresh().
   */
  resume() {
    return this.#serialize(async () => {
      // A silent breakpoint stop leaves `state` stale, so ask the core first:
      // otherwise "resume" after a hit would be a no-op that claims success.
      if (this.state === 'running') await this.#refreshState()
      return this.#resumeCore()
    })
  }

  /** Stop the core and report why it stopped. */
  halt() {
    return this.#serialize(() => this.#haltCore())
  }

  // RSP is request/reply except for monitor packets, which the server services
  // even while the core runs. `#send` is for ordinary packets and refuses to
  // run while the target is running; `#monitor` is safe in both states.
  #send(body, timeoutMs) {
    if (this.state === 'running') {
      throw new Error(`internal: refusing to send "${body.slice(0, 16)}" while the core is running`)
    }
    return this.#rsp.request(body, timeoutMs)
  }

  /** Run one J-Link monitor command and return its text output. */
  async #monitor(command, timeoutMs = MONITOR_TIMEOUT_MS) {
    if (this.#rsp === undefined) throw new Error('no open session; call connect first')
    const reply = await this.#rsp.request(`qRcmd,${encodeMonitor(command)}`, timeoutMs)
    const text = monitorText(reply)
    if (/^ERROR:/i.test(text.trim())) throw new Error(`${command}: ${text.trim()}`)
    return text
  }

  async #resumeCore() {
    if (!this.isOpen) throw new Error('no open session; call connect first')
    if (this.state === 'running') return { state: 'running' }
    // A hardware breakpoint the core is already sitting on would fire again the
    // instant it resumes, so step over it first, the way a real debugger does.
    if (this.breakpoints.size > 0) {
      const bytes = decodeHexBytes(await this.#send('g'))
      const pc = wordAt(bytes, 15)
      if (this.breakpoints.has(pc)) await this.#send('s', 10000)
    }
    // `monitor go` returns immediately and, unlike `c`, leaves no packet pending
    // that would impede the background reads a watch needs. The price is that a
    // breakpoint stop is silent; refresh() finds it through DHCSR.
    await this.#monitor('go', MONITOR_TIMEOUT_MS)
    this.state = 'running'
    this.lastStop = undefined
    return { state: 'running' }
  }

  async #haltCore() {
    if (!this.isOpen) throw new Error('no open session; call connect first')
    if (this.state !== 'running') return { state: this.state, stop: this.lastStop }
    // The server may still believe the core runs after it stopped on a hardware
    // breakpoint, so sync through `halt` instead of sending an interrupt.
    await this.#monitor('halt', MONITOR_TIMEOUT_MS)
    this.state = 'halted'
    this.lastStop = await this.#inferStop()
    return { state: this.state, stop: this.lastStop }
  }

  /** PC and the reason the core stopped, read while it is halted. */
  async #inferStop() {
    try {
      const bytes = decodeHexBytes(await this.#send('g'))
      if (bytes.length < 68) return { kind: 'halt' }
      const pc = wordAt(bytes, 15)
      if (this.breakpoints.has(pc)) return { kind: 'breakpoint', address: hex(pc), fields: { pc: hex(pc) } }
      return { kind: 'halt', fields: { pc: hex(pc) } }
    } catch {
      return { kind: 'halt' }
    }
  }

  /**
   * Detect a stop the server never reported.
   *
   * `monitor go` has no stop reply, so a breakpoint hit leaves the core halted
   * while this session still believes it runs. DHCSR.S_HALT is the truth and
   * costs one 4-byte background read. When it says halted, one `monitor halt`
   * brings the server in sync, after which the registers are real.
   */
  refresh() {
    return this.#serialize(() => this.#refreshState())
  }

  /** The body of refresh, for callers already inside a serialized task. */
  async #refreshState() {
    if (!this.isOpen || this.state !== 'running') return { state: this.state, stop: this.lastStop }
    const dhcsr = await this.#ahbWord(DHCSR)
    if (dhcsr === undefined || (dhcsr & DHCSR_S_HALT) === 0) return { state: 'running' }
    await this.#monitor('halt', MONITOR_TIMEOUT_MS).catch(() => {})
    this.state = 'halted'
    this.lastStop = await this.#inferStop()
    return { state: this.state, stop: this.lastStop }
  }

  /** One 32-bit read over the AHB-AP, or undefined when that is unavailable. */
  async #ahbWord(address) {
    const bytes = await this.#ahbRead(address, 4)
    if (bytes === undefined || bytes.length < 4) return undefined
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
  }

  /** Step one instruction, or several. Leaves the core halted. */
  step(count = 1) {
    return this.#serialize(async () => {
      if (!this.isOpen) throw new Error('no open session; call connect first')
      if (this.state === 'running') await this.#haltCore()
      let stop
      for (let i = 0; i < Math.max(1, Math.min(count, 1000)); i += 1) {
        stop = parseStopReply(await this.#send('s', 10000)) ?? { kind: 'unknown' }
        this.lastStop = stop
      }
      return { state: this.state, stop }
    })
  }

  /** Run `task` with the core halted, restoring the previous run state. */
  async #withHalt(task) {
    const wasRunning = this.state === 'running'
    if (wasRunning) await this.#haltCore()
    try {
      return await task()
    } finally {
      if (wasRunning && this.isOpen) await this.#resumeCore().catch(() => {})
    }
  }

  readMemory(address, length) {
    return this.#serialize(async () => {
      if (!this.isOpen) throw new Error('no open session; call connect first')
      // While the core runs, memory is read through the MEM-AP: the probe does
      // the access on the bus and the CPU keeps executing. Only if that channel
      // is unavailable does this fall back to the old halt-read-resume window.
      if (this.state === 'running') {
        const bytes = await this.#ahbRead(address, length)
        if (bytes !== undefined) {
          return { state: this.state, address, length: bytes.length, bytes, background: true }
        }
      }
      return this.#withHalt(async () => {
        const bytes = await this.#readHalted(address, length)
        return { state: this.state, address, length: bytes.length, bytes }
      })
    })
  }

  /** The classic `m` read: requires the core stopped. */
  async #readHalted(address, length) {
    const bytes = []
    const packetBudget = Math.min(this.#packetBytes(), 1000)
    while (bytes.length < length) {
      const remaining = length - bytes.length
      const chunk = Math.min(remaining, packetBudget)
      const reply = await this.#send(`m${(address + bytes.length).toString(16)},${chunk.toString(16)}`)
      if (!/^[0-9a-fA-F]+$/.test(reply)) throw new Error(rspFailure(reply, 'read memory'))
      const decoded = decodeHexBytes(reply)
      if (decoded.length === 0) break
      bytes.push(...decoded)
    }
    return bytes
  }

  /**
   * Read memory without touching the run state.
   *
   * This is the sampling primitive: when the core runs, `qRcmd ReadMemAP` is
   * serviced while the continue is still outstanding, so a watch costs the
   * target nothing but a few AHB-AP transactions. When the core is stopped the
   * regular `m` packet is used. Returns raw bytes; the caller owns decoding.
   */
  readSnapshot(address, length) {
    return this.#serialize(async () => {
      if (!this.isOpen) throw new Error('no open session; call connect first')
      if (this.state === 'running') {
        const bytes = await this.#ahbRead(address, length)
        if (bytes !== undefined) return bytes
        return this.#withHalt(() => this.#readHalted(address, length))
      }
      return this.#readHalted(address, length)
    })
  }

  /**
   * Read through the AHB-AP without stopping the core, one monitor command per
   * 256-byte window. Returns undefined when this build of the GDB server does
   * not answer `ReadMemAP`; throws when the probe answers with an error.
   */
  async #ahbRead(address, length) {
    if (this.#ahb === 'off' || this.#rsp === undefined) return undefined
    const out = []
    while (out.length < length) {
      const remaining = length - out.length
      const at = address + out.length
      // `& ~3` yields a signed 32-bit value for PPB addresses, which would be
      // formatted as a negative number and rejected by the probe.
      const start = (at & ~3) >>> 0
      const skip = at - start
      const words = Math.min(Math.ceil((skip + remaining) / 4), AHB_WORDS_PER_PACKET)
      const command = `ReadMemAP 0x0,0x${start.toString(16)},${words},0`
      let text
      try {
        text = monitorText(await this.#rsp.request(`qRcmd,${encodeMonitor(command)}`, AHB_TIMEOUT_MS))
      } catch (error) {
        // A timeout means the probe is busy, not that the command is missing.
        this.#ahbError = error.message
        return undefined
      }
      const match = text.match(/O\.K\.:\s*((?:0[xX][0-9a-fA-F]+[,\s]*)+)/)
      if (match === null) {
        if (/unsupported|unknown command/i.test(text) || text.trim() === '') this.#ahb = 'off'
        this.#ahbError = text.trim().slice(0, 120) || 'empty monitor reply'
        return undefined
      }
      if (this.#ahb === undefined) this.#ahb = 'on'
      const packet = []
      for (const part of match[1].split(',')) {
        const value = Number.parseInt(part.trim().replace(/^0[xX]/, ''), 16)
        if (!Number.isFinite(value)) continue
        for (let i = 0; i < 4; i += 1) packet.push((value >>> (i * 8)) & 0xff)
      }
      const take = Math.min(remaining, Math.max(0, packet.length - skip))
      if (take === 0) break
      out.push(...packet.slice(skip, skip + take))
    }
    return out
  }

  /** Whether background (non-halting) reads are in use. */
  get backgroundReads() {
    return this.#ahb !== 'off'
  }

  /** Diagnostics for why a background read did or did not work. */
  get backgroundStatus() {
    return { enabled: this.#ahb !== 'off', probed: this.#ahb, error: this.#ahbError }
  }

  writeMemory(address, bytes) {
    return this.#serialize(() => this.#withHalt(async () => {
      const hexBytes = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
      const reply = await this.#send(`M${address.toString(16)},${bytes.length.toString(16)}:${hexBytes}`)
      if (reply !== 'OK') throw new Error(rspFailure(reply, 'write memory'))
      return { state: this.state, address, length: bytes.length }
    }))
  }

  registers() {
    return this.#serialize(() => this.#withHalt(async () => {
      const bytes = decodeHexBytes(await this.#send('g'))
      if (bytes.length < 68) throw new Error(`unexpected register block of ${bytes.length} bytes`)
      const word = (index) => (bytes[index * 4] | (bytes[index * 4 + 1] << 8) | (bytes[index * 4 + 2] << 16) | (bytes[index * 4 + 3] << 24)) >>> 0
      const registers = {}
      for (let i = 0; i <= 12; i += 1) registers[`R${i}`] = hex(word(i), 8).slice(2)
      registers['SP(R13)'] = hex(word(13), 8).slice(2)
      registers['R14(LR)'] = hex(word(14), 8).slice(2)
      registers.PC = hex(word(15), 8).slice(2)
      registers.XPSR = hex(word(16), 8).slice(2)
      const xpsr = word(16)
      const ipsrValue = xpsr & 0x1ff
      return {
        state: this.state,
        registers,
        ipsr: { value: ipsrValue, name: ipsrValue === 0 ? 'NoException' : `Exception ${ipsrValue}` },
      }
    }))
  }

  setBreakpoint(address, kind = 'hw') {
    return this.#serialize(() => this.#withHalt(async () => {
      if (!this.isOpen) throw new Error('no open session; call connect first')
      const reply = await this.#send(`${kind === 'sw' ? 'Z0' : 'Z1'},${address.toString(16)},2`)
      if (reply !== 'OK') throw new Error(rspFailure(reply, 'set breakpoint'))
      this.breakpoints.set(address, kind)
      return { breakpoints: this.#breakpointList() }
    }))
  }

  clearBreakpoint(address) {
    return this.#serialize(() => this.#withHalt(async () => {
      if (!this.isOpen) throw new Error('no open session; call connect first')
      const kind = this.breakpoints.get(address) ?? 'hw'
      const reply = await this.#send(`${kind === 'sw' ? 'z0' : 'z1'},${address.toString(16)},2`)
      if (reply !== 'OK') throw new Error(rspFailure(reply, 'clear breakpoint'))
      // `z1` reports OK even when the comparator stays armed because the core is
      // halted on it, so sweep the FPB directly rather than trusting the reply.
      await this.#disarmAllComparators()
      this.breakpoints.delete(address)
      return { breakpoints: this.#breakpointList() }
    }))
  }

  #breakpointList() {
    return [...this.breakpoints.entries()].map(([address, kind]) => ({ address: hex(address), kind }))
  }

  listBreakpoints() {
    return this.#serialize(async () => ({ breakpoints: this.#breakpointList() }))
  }

  reset() {
    return this.#serialize(async () => {
      if (!this.isOpen) throw new Error('no open session; call connect first')
      if (this.state === 'running') await this.#haltCore()
      const reply = await this.#send(`qRcmd,${encodeMonitor('reset')}`, 10000)
      const text = /^[0-9a-fA-F]+$/.test(reply) ? Buffer.from(reply, 'hex').toString('latin1') : reply
      this.state = 'halted'
      this.lastStop = { kind: 'reset' }
      return { state: this.state, output: text.trim() }
    })
  }

  #packetBytes() {
    const match = this.#stdout.match(/PacketSize=([0-9a-fA-F]+)/)
    if (match === null) return 512
    // Leave headroom for the packet framing and the address prefix.
    return Math.max(64, Math.floor(parseInt(match[1], 16) / 2) - 64)
  }
}

function rspFailure(reply, what) {
  if (reply === undefined || reply === '') return `${what} failed: empty reply`
  if (reply.startsWith('E')) return `${what} failed: target returned ${reply}`
  return `${what} failed: unexpected reply "${reply.slice(0, 40)}"`
}

/**
 * Decode a monitor reply. The GDB server sends a command's text output as the
 * hex-encoded reply body, while an unsolicited/empty packet arrives verbatim.
 */
export function monitorText(reply) {
  if (typeof reply !== 'string' || reply === '') return ''
  if (reply.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(reply)) {
    return Buffer.from(reply, 'hex').toString('latin1')
  }
  return reply
}

/** Parse the probe identity out of the server banner. */
export function parseProbeBanner(text) {
  const info = {}
  const grab = (re, key) => {
    const m = text.match(re)
    if (m !== null) info[key] = m[1].trim()
  }
  grab(/Firmware:\s*(.+)/, 'firmware')
  grab(/Hardware version:\s*(.+)/, 'hardware')
  grab(/S\/N:\s*(\d+)/, 'serial')
  grab(/VTref\s*=\s*([\d.]+)\s*V/, 'vtref')
  grab(/Found\s+(Cortex-\S+ r\d+p\d+),/, 'core')
  grab(/Device "([^"]+)" selected/, 'device')
  grab(/Target device:\s*(\S+)/, 'device')
  grab(/DPIDR:\s*(0x[0-9A-Fa-f]+)/, 'dpidr')
  grab(/CPUID register:\s*(0x[0-9A-Fa-f]+)/, 'cpuid')
  const warnings = text.split(/\r?\n/).filter((line) => /WARNING:/.test(line)).map((line) => line.trim())
  if (warnings.length > 0) info.warnings = warnings
  return info
}
