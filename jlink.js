/**
 * J-Link transport for the DSH mcu_debug plugin.
 *
 * Phase 0 transport: one `JLink.exe -CommandFile` process per operation.
 * Measured ~250 ms warm per call on a J-Link V9.40 / STM32H503, which is good
 * enough for agent-driven inspection; a persistent JLinkGDBServer + RSP client
 * can replace `runCommander`/`perform` later without touching the tool layer.
 *
 * Read actions are non-destructive: they learn the true halt state from DHCSR
 * before touching it and restore the previous state afterwards.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SEGGER_ROOTS = [
  'C:\\Program Files\\SEGGER',
  'C:\\Program Files (x86)\\SEGGER',
]

const DHCSR = 0xe000edf0

/** Locate the newest JLink.exe under the SEGGER install roots. */
export async function findJLink() {
  const found = []
  for (const root of SEGGER_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const exe = join(root, entry.name, 'JLink.exe')
      if (existsSync(exe)) found.push(exe)
    }
  }
  found.sort()
  return found.at(-1)
}

/**
 * Run one J-Link Commander script and return its combined console output.
 * @param exe absolute path to JLink.exe
 * @param script commander commands, newline separated
 * @param timeoutMs hard kill deadline
 */
export async function runCommander(exe, script, timeoutMs = 25000, cwd) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jlink-'))
  const file = join(dir, 'cmd.jlink')
  try {
    await writeFile(file, script, 'utf8')
    return await new Promise((resolve, reject) => {
      const child = spawn(exe, ['-NoGui', '1', '-CommandFile', file], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`J-Link commander timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      child.stdout.on('data', (c) => { out += c.toString('utf8') })
      child.stderr.on('data', (c) => { err += c.toString('utf8') })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: out, stderr: err })
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Extract the first fatal diagnostic from commander output, if any. */
export function findError(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(ERROR|Error):/.test(line)) return line
    if (/^(Could not|Cannot)\s+(find|connect|read|write|access|open)/i.test(line)) return line
    if (/^Failed to (connect|read|write|open)/i.test(line)) return line
    if (/^No J-Link found/i.test(line)) return line
  }
  return undefined
}

/** Parse probe/target identity out of the connect banner. */
export function parseConnect(text) {
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
  grab(/Selecting (\d+) kHz/, 'speedKhz')
  grab(/DPIDR:\s*(0x[0-9A-Fa-f]+)/, 'dpidr')
  grab(/CPUID register:\s*(0x[0-9A-Fa-f]+)/, 'cpuid')
  const warnings = text.split(/\r?\n/).filter((l) => /WARNING:/.test(l)).map((l) => l.trim())
  if (warnings.length > 0) info.warnings = warnings
  return info
}

const REG_RE = /^([A-Za-z][A-Za-z0-9()]*)\s*=\s*([0-9A-Fa-f]{1,8})\b/

/** Parse the `regs` block into name -> hex string, plus the decoded IPSR. */
export function parseRegisters(text) {
  const registers = {}
  let ipsr
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('VTref') || line.startsWith('J-Link>')) continue
    // A memory dump line (E000EDF0 = 01 00 08 00) must not read as a register.
    if (/^[0-9A-Fa-f]{8}\s*=/.test(line)) continue
    if (line.startsWith('XPSR')) {
      const m = line.match(/XPSR\s*=\s*([0-9A-Fa-f]{8})/)
      if (m !== null) registers.XPSR = m[1].toUpperCase()
      const ip = line.match(/IPSR\s*=\s*([0-9A-Fa-f]+)(?:\s*\(([^)]+)\))?/)
      if (ip !== null) {
        const value = parseInt(ip[1], 16)
        ipsr = { value, name: ip[2] ?? (value === 0 ? 'Thread' : `Exception ${value}`) }
      }
      continue
    }
    for (const part of line.split(',')) {
      const m = part.trim().match(REG_RE)
      if (m === null) continue
      const name = m[1]
      if (name === 'CycleCnt' || name === 'APSR' || name === 'EPSR') continue
      // The FPU bank is noise where unused; keep the model payload small.
      if (name.startsWith('FPS') || name === 'FPSCR') continue
      registers[name] = m[2].toUpperCase().padStart(8, '0')
    }
  }
  return { registers, ipsr }
}

/**
 * Parse `mem` output restricted to one address window. Inter-byte gaps in the
 * hex column are ambiguous, so bytes come from the head of each line only,
 * capped at what that line can legally hold; the ASCII column is recomputed.
 */
export function parseMemory(text, address, length) {
  const end = address + length
  const byAddress = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^([0-9A-Fa-f]{8})\s*=\s*(.*)$/)
    if (m === null) continue
    const base = parseInt(m[1], 16)
    if (base < address || base >= end) continue
    const rest = m[2]
    const offset = base - address
    const want = Math.min(16, length - offset)
    const row = []
    let i = 0
    while (row.length < want && i < rest.length) {
      const pair = rest.slice(i, i + 2)
      if (!/^[0-9A-Fa-f]{2}$/.test(pair)) break
      row.push(parseInt(pair, 16))
      i += 2
      while (rest[i] === ' ') i += 1
    }
    if (row.length > 0) byAddress.set(base, row)
  }
  const bytes = []
  const rows = []
  for (const base of [...byAddress.keys()].sort((a, b) => a - b)) {
    const row = byAddress.get(base)
    bytes.push(...row)
    rows.push({
      address: `0x${base.toString(16).toUpperCase().padStart(8, '0')}`,
      hex: row.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      ascii: row.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join(''),
    })
  }
  return {
    address: `0x${address.toString(16).toUpperCase().padStart(8, '0')}`,
    length: bytes.length,
    hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
    rows,
  }
}

/** Decode DHCSR from little-endian memory bytes: bit0 C_DEBUGEN, bit1 C_HALT. */
export function decodeDhcsr(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 4) return undefined
  const value = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  return {
    value: `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
    debugEnabled: (value & 1) === 1,
    halted: (value & 2) === 2,
  }
}

const PRELUDE = (config) => [
  `si ${config.interface}`,
  `speed ${config.speedKhz}`,
  `device ${config.device}`,
  'connect',
]

function asNumber(value, name) {
  const n = typeof value === 'string' ? Number.parseInt(value, 0) : value
  if (typeof n !== 'number' || Number.isNaN(n)) throw new Error(`${name} must be a number`)
  return n
}

/** Replay backspaces and drop control bytes so a console line is readable. */
export function stripTerminalNoise(line) {
  let out = ''
  for (const ch of line) {
    if (ch === '\b') {
      out = out.slice(0, -1)
      continue
    }
    if (ch === '\r' || ch === '\n' || ch < ' ') continue
    out += ch
  }
  return out.trim()
}

async function run(exe, script, timeoutMs) {
  const { stdout, stderr } = await runCommander(exe, script, timeoutMs)
  const text = stdout + stderr
  return { text, error: findError(text) }
}

/**
 * Execute one debug action against the connected probe.
 * @param config resolved plugin config
 * @param action action name
 * @param params action parameters
 * @param state mutable session view: { halted }
 */
export async function perform(config, action, params = {}, state = { halted: undefined }) {
  const exe = config.jlinkExe
  if (exe === undefined) throw new Error('J-Link installation not found; set jlinkExe')
  const timeoutMs = config.timeoutMs ?? 25000

  if (action === 'status') {
    const { text, error } = await run(exe, [...PRELUDE(config), `mem 0x${DHCSR.toString(16)},4`, 'qc'].join('\n'), timeoutMs)
    if (error !== undefined) return { ok: false, action, error }
    const probe = parseConnect(text)
    const target = decodeDhcsr(parseMemory(text, DHCSR, 4).hex.match(/../g)?.map((h) => parseInt(h, 16)))
    if (target !== undefined) state.halted = target.halted
    return {
      ok: true,
      action,
      probe,
      target,
      summary: `${probe.core ?? 'target'} · ${target === undefined ? 'state unknown' : target.halted ? 'HALTED' : 'running'}`,
    }
  }

  if (action === 'halt' || action === 'resume' || action === 'step') {
    // The one-process-per-operation transport drops the halt on disconnect:
    // J-Link clears C_DEBUGEN/C_HALT in OnDisconnectTarget, so a halt cannot
    // survive between calls. Real stop/step needs a persistent session.
    return {
      ok: false,
      action,
      error: `"${action}" needs a persistent debug session and is not available in this build. Reading registers or memory halts the core only for the duration of that single call.`,
    }
  }

  if (action === 'reset') {
    const { text, error } = await run(exe, [...PRELUDE(config), 'r', 'qc'].join('\n'), timeoutMs)
    if (error !== undefined) return { ok: false, action, error }
    state.halted = false
    return {
      ok: true,
      action,
      target: { halted: false },
      summary: 'reset applied, core running from the reset vector',
    }
  }

  if (action === 'registers' || action === 'read_memory') {
    const resumeAfter = state.halted !== true
    const ops = []
    if (action === 'registers') ops.push('regs')
    let address = 0
    let length = 0
    if (action === 'read_memory') {
      address = asNumber(params.address, 'address')
      length = Math.max(1, Math.min(asNumber(params.length ?? 64, 'length'), config.maxReadBytes ?? 512))
      ops.push(`mem 0x${address.toString(16)},${length}`)
    }
    const script = [
      ...PRELUDE(config),
      `mem 0x${DHCSR.toString(16)},4`,
      'halt',
      ...ops,
      ...(resumeAfter ? ['go'] : []),
      'qc',
    ].join('\n')
    const { text, error } = await run(exe, script, timeoutMs)
    if (error !== undefined) return { ok: false, action, error }
    const observed = decodeDhcsr(parseMemory(text, DHCSR, 4).hex.match(/../g)?.map((h) => parseInt(h, 16)))
    state.halted = !resumeAfter
    // If the target was already halted before this call, the trailing `go`
    // resumed it by mistake: put it back.
    if (observed?.halted === true && resumeAfter) {
      await run(exe, [...PRELUDE(config), 'halt', 'qc'].join('\n'), timeoutMs)
      state.halted = true
    }
    if (action === 'registers') {
      const { registers, ipsr } = parseRegisters(text)
      return {
        ok: true,
        action,
        registers,
        ipsr,
        target: { halted: state.halted },
        summary: `PC=0x${registers.PC ?? '????????'}${ipsr === undefined ? '' : ` · IPSR=${ipsr.value} (${ipsr.name})`}`,
      }
    }
    const memory = parseMemory(text, address, length)
    return {
      ok: true,
      action,
      target: { halted: state.halted },
      memory,
      summary: `read ${memory.length} bytes at ${memory.address}`,
    }
  }

  if (action === 'flash') {
    const file = String(params.file ?? '')
    if (file === '') throw new Error('file is required for flash')
    if (!existsSync(file)) throw new Error(`firmware not found: ${file}`)
    const script = [...PRELUDE(config), 'halt', `loadfile "${file}"`, 'r', 'g', 'qc'].join('\n')
    const { text, error } = await run(exe, script, timeoutMs)
    if (error !== undefined) return { ok: false, action, error }
    state.halted = false
    const log = text
      .split(/\r?\n/)
      .filter((l) => /Downloading|programmed|Verifying|O\.K\.|Reset/i.test(l))
      .map(stripTerminalNoise)
      .filter((l) => l !== '')
      .slice(0, 8)
    return {
      ok: true,
      action,
      probe: parseConnect(text),
      file,
      target: { halted: false },
      log,
      summary: `flashed ${file.split(/[\\/]/).pop()} and started the core`,
    }
  }

  throw new Error(`unknown action: ${action}`)
}
