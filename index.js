/**
 * Host half: the `mcu_debug` and `mcu_flash` tools.
 *
 * `mcu_debug` runs over a persistent JLinkGDBServer session, so the core can be
 * halted, stepped, breakpointed and sampled repeatedly at sub-millisecond cost.
 * `mcu_flash` is separate because programming is destructive and needs the
 * probe released, which means the session has to be closed first.
 */
import Schema from '@deepseek-ai/schemastery'
import { findSymbol, loadSymbols, nearestSymbol } from './elf.js'
import { findJLink, perform } from './jlink.js'
import { ProbeSession } from './session.js'

export const inject = ['tools']

/** Must match package.json `name`: the settings panel and its route key off it. */
const PACKAGE_NAME = '@nocardriver/dsh-jlink-debug'
const CONFIG_PATH = '/jlink-debug/config'

const DEFAULTS = {
  device: 'STM32H503CB',
  interface: 'SWD',
  speedKhz: 4000,
  maxReadBytes: 4096,
  timeoutMs: 25000,
  idleCloseMs: 120000,
  jlinkExe: undefined,
  gdbServerExe: undefined,
}

/**
 * The connection options, projected by the Harness into an editable form on
 * this bundle's page in Settings → Plugins. Keeping them in `Config` rather
 * than in plugin-private state is what makes one value serve the tool, the
 * form, and `cordis.patch.yml` at the same time.
 */
export const Config = Schema.object({
  device: Schema.string()
    .default('STM32H503CB')
    .description(
      'J-Link device name, spelled exactly as the J-Link device database spells it '
      + '(e.g. STM32H503CB, STM32F407VG, nRF52840_xxAA). A wrong name fails at connect time.',
    ),
  interface: Schema.union([Schema.const('SWD'), Schema.const('JTAG')])
    .default('SWD')
    .description('Debug transport: SWD uses two wires, JTAG five.'),
  speedKhz: Schema.natural()
    .min(100)
    .max(50000)
    .default(4000)
    .description(
      'SWD/JTAG clock in kHz. 4000 is reliable on STM32H5 with short wires; '
      + 'lower it to 1000-2000 for long cables or a breadboard.',
    ),
  idleCloseMs: Schema.natural()
    .max(86400000)
    .default(120000)
    .description(
      'Release the probe after this much idle time so Ozone, Keil or JLink.exe can use it. '
      + '0 keeps the session open until the plugin unloads.',
    ),
  maxReadBytes: Schema.natural()
    .min(16)
    .max(65536)
    .default(4096)
    .description('Upper bound for one read_memory call.'),
  jlinkExe: Schema.string()
    .default('')
    .description('Absolute path to JLink.exe. Empty auto-detects the newest install under SEGGER.'),
  gdbServerExe: Schema.string()
    .default('')
    .description('Absolute path to JLinkGDBServerCL.exe. Empty auto-detects it beside JLink.exe.'),
}).description('How the agent attaches to the target over SEGGER J-Link.')

const ACTIONS = [
  'status', 'connect', 'disconnect', 'halt', 'resume', 'step',
  'registers', 'read_memory', 'write_memory', 'breakpoint', 'reset',
  'symbols', 'resolve',
]

const DESCRIPTION = [
  'Debug a microcontroller over SEGGER J-Link (SWD/JTAG) with a persistent debug session.',
  'Actions:',
  'status — probe identity, core, run state and current breakpoints;',
  'connect — attach the debug session; the core keeps running unless halt is set;',
  'disconnect — release the probe so Ozone/Keil or JLink.exe can use it;',
  'halt — stop the core and report why it stopped;',
  'resume — let the core run (it stops again on a breakpoint);',
  'step — advance N instructions (count, default 1) and stay halted;',
  'registers — core registers r0-r12, sp, lr, pc, xpsr plus the active exception;',
  'read_memory — read a byte range;',
  'write_memory — write hex bytes to RAM or peripheral space;',
  'breakpoint — set (default) or clear a hardware breakpoint at address;',
  'reset — reset the core and hold it at the reset vector;',
  'symbols — list or search names from the firmware .elf symbol table;',
  'resolve — turn one symbol name into its address.',
  'read_memory, write_memory and breakpoint also accept `symbol` instead of `address`,',
  'and a read whose length is omitted reads the whole symbol (up to maxReadBytes).',
  'Pass `file` (the .elf you built) on any call to name symbols; mcu_flash sets it too.',
  'Reads halt the core only for the duration of the call and restore its previous run state.',
].join(' ')

const FLASH_DESCRIPTION = [
  'Program a firmware image into flash over SEGGER J-Link, verify it and start the core.',
  'Accepts an .elf, .hex or .bin file. Any open debug session is closed first, because the',
  'probe can only be owned by one process, and reopened afterwards. An .elf also becomes',
  'the symbol source for this session, so read_memory and breakpoint can take names.',
].join(' ')

function toNumber(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof n !== 'number' || Number.isNaN(n)) throw new Error(`${name} must be a number`)
  return n
}

function hex8(value) {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * Tool results must be lossless JSON, so an optional field has to be absent
 * rather than present-and-undefined. Every result is passed through here.
 */
function present(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out
}

function parseHexBytes(text) {
  const cleaned = String(text ?? '').replace(/[^0-9a-fA-F]/g, '')
  if (cleaned.length === 0) throw new Error('bytes must be a hex string such as "deadbeef"')
  if (cleaned.length % 2 !== 0) throw new Error('bytes must contain an even number of hex digits')
  const out = []
  for (let i = 0; i < cleaned.length; i += 2) out.push(parseInt(cleaned.slice(i, i + 2), 16))
  return out
}

/** Shape a byte buffer the way the conversation card renders it. */
function formatMemory(address, bytes) {
  const rows = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.slice(offset, offset + 16)
    rows.push({
      address: hex8(address + offset),
      hex: slice.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      ascii: slice.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join(''),
    })
  }
  return {
    address: hex8(address),
    length: bytes.length,
    hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
    rows,
  }
}

function describeCall(args) {
  const action = typeof args?.action === 'string' ? args.action : 'status'
  const where = typeof args?.symbol === 'string' && args.symbol !== ''
    ? args.symbol
    : args?.address
  if (action === 'read_memory') {
    const size = args?.length === undefined ? '' : ` (${args.length} B)`
    return { card: 'generic', title: `MCU read ${where ?? '?'}${size}`, kind: 'read' }
  }
  if (action === 'write_memory') return { card: 'generic', title: `MCU write ${where ?? 'memory'}`, kind: 'edit' }
  if (action === 'breakpoint') return { card: 'generic', title: `MCU breakpoint ${args?.clear === true ? 'clear' : 'set'} ${where ?? ''}`.trim(), kind: 'other' }
  if (action === 'symbols') return { card: 'generic', title: args?.query ? `MCU symbols "${args.query}"` : 'MCU symbols', kind: 'read' }
  if (action === 'resolve') return { card: 'generic', title: `MCU resolve ${args?.name ?? '?'}`, kind: 'read' }
  if (action === 'step') return { card: 'generic', title: `MCU step ${args?.count ?? 1}`, kind: 'execute' }
  if (action === 'registers') return { card: 'generic', title: 'MCU registers', kind: 'other' }
  if (action === 'reset') return { card: 'generic', title: 'MCU reset', kind: 'execute' }
  return { card: 'generic', title: `MCU ${action}`, kind: 'other' }
}

export function apply(ctx, config = {}) {
  // The config form cannot express "unset", so an empty text field arrives as
  // ''. Treat it as absent; otherwise `jlinkExe: ''` would disable auto-detect.
  const given = {}
  for (const [key, value] of Object.entries(config)) {
    if (value === '' || value === undefined || value === null) continue
    given[key] = value
  }
  const resolved = { ...DEFAULTS, ...given }
  /** The config as loaded, before runtime discovery fills anything in. */
  const baseline = { ...resolved }
  const session = new ProbeSession(resolved)
  let pendingExe
  let idleTimer
  /** Parsed .elf symbol table, or undefined while no usable image is configured. */
  let symbols
  /** Why the last symbol load failed; kept so `status` can explain an empty lookup. */
  let symbolsError

  const resolveExe = async () => {
    if (resolved.jlinkExe !== undefined) return resolved.jlinkExe
    pendingExe ??= findJLink()
    const exe = await pendingExe
    if (exe === undefined) {
      pendingExe = undefined
      throw new Error('SEGGER J-Link not found. Install the J-Link software or set `jlinkExe` in this plugin\'s config.')
    }
    resolved.jlinkExe = exe
    session.config.jlinkExe = exe
    return exe
  }

  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (!(resolved.idleCloseMs > 0)) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      session.close().catch(() => {})
    }, resolved.idleCloseMs)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  const commanderConfig = async () => {
    const exe = await resolveExe()
    return { ...resolved, jlinkExe: exe }
  }

  /**
   * Load the symbol table for the image this session is working with.
   *
   * `required` separates the two callers: a plain register read silently loses
   * its PC annotation when no image is known, while an explicit
   * `symbols`/`resolve` call must say why it has nothing to look up. The image
   * arrives from `mcu_flash`, or from a `file` argument on any call — the agent
   * knows best which build it just made.
   */
  const loadSymbolTable = async (required) => {
    const source = resolved.elfFile
    if (!source) {
      if (required) {
        throw new Error(
          'no firmware image for symbol lookup: flash an .elf with mcu_flash, '
          + 'or pass `file` with the .elf you built',
        )
      }
      return undefined
    }
    try {
      symbols = await loadSymbols(source)
      symbolsError = undefined
    } catch (error) {
      symbols = undefined
      symbolsError = `${source}: ${error.message}`
      if (required) throw new Error(`cannot read symbols from ${symbolsError}`)
    }
    return symbols
  }

  /** ARM Thumb keeps bit 0 set in st_value; the probe wants the even address. */
  const evenAddress = (value) => value & ~1

  /**
   * Resolve which address an action should touch, accepting `symbol` or
   * `address` but never both. The symbol is returned too so a caller can borrow
   * its size as the default length.
   */
  const targetAddress = async (args, action) => {
    const name = typeof args?.symbol === 'string' ? args.symbol.trim() : ''
    const address = toNumber(args?.address, 'address')
    if (name === '') {
      if (address === undefined) throw new Error(`${action} needs an address or a symbol`)
      return { address, symbol: undefined }
    }
    if (address !== undefined) throw new Error('pass either address or symbol, not both')
    const table = await loadSymbolTable(true)
    const symbol = findSymbol(table, name)
    if (symbol === undefined) throw new Error(`unknown symbol: ${name}`)
    return { address: evenAddress(symbol.address), symbol }
  }

  /** Name the function containing this PC, when a symbol table is loaded. */
  const annotatePc = (registers) => {
    if (symbols === undefined || registers === undefined) return undefined
    const pc = Number.parseInt(String(registers.PC ?? ''), 16)
    if (!Number.isFinite(pc)) return undefined
    const near = nearestSymbol(symbols, pc)
    if (near === undefined) return undefined
    return { name: near.symbol.name, offset: near.offset }
  }

  /** A compact, JSON-safe view of one symbol for tool results. */
  const describeSymbol = (symbol) => ({
    name: symbol.name,
    address: hex8(evenAddress(symbol.address)),
    size: symbol.size,
    kind: symbol.kind,
  })

  /** What symbol lookups currently answer from; shown by `status`. */
  const elfSummary = () => present({
    file: resolved.elfFile ?? '',
    symbols: symbols === undefined ? 0 : symbols.symbols.length,
    functions: symbols === undefined ? 0 : symbols.funcs.length,
    error: symbolsError,
  })

  function stopName(stop) {
    if (stop === undefined || stop === null) return 'unknown'
    if (stop.kind === 'reset') return 'reset'
    if (stop.kind === 'signal') return `signal ${stop.signal}`
    if (stop.kind === 'exit') return `exit ${stop.code}`
    return String(stop.kind)
  }

  async function runDebugAction(action, args) {
    // Any call may point at a build with `file`. The session keeps it, so the
    // agent decides which image the symbols come from and states it once.
    if (typeof args?.file === 'string' && args.file.trim() !== '') resolved.elfFile = args.file.trim()
    if (action === 'status') {
      // `status` is the cheap poll, so it is also the right place to warm the
      // symbol cache: a failed load stays reported instead of breaking status.
      if (resolved.elfFile !== undefined && symbols === undefined) await loadSymbolTable(false)
      const elf = elfSummary()
      if (session.isOpen) {
        const info = session.describe()
        return {
          ok: true,
          action,
          session: 'open',
          state: info.state,
          probe: info.probe,
          breakpoints: info.breakpoints,
          lastStop: session.lastStop,
          elf,
          summary: `${info.probe?.core ?? 'target'} · ${info.state}`,
        }
      }
      const result = await perform(await commanderConfig(), 'status', {}, { halted: undefined })
      if (result.ok !== true) throw new Error(result.error ?? 'status failed')
      return {
        ok: true,
        action,
        session: 'closed',
        probe: result.probe,
        state: result.target?.halted === true ? 'halted' : 'running',
        elf,
        summary: result.summary,
      }
    }

    if (action === 'connect') {
      const info = await session.open({ halt: args?.halt === true })
      return { ok: true, action, session: 'open', state: info.state, probe: info.probe, summary: `attached · ${info.state}` }
    }

    if (action === 'disconnect') {
      await session.close()
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      return { ok: true, action, session: 'closed', summary: 'probe released' }
    }

    // Symbol lookup reads the image on the host, so it needs no probe at all.
    if (action === 'symbols') {
      const table = await loadSymbolTable(true)
      const query = String(args?.query ?? '').trim()
      const kind = String(args?.kind ?? 'any').trim()
      if (kind !== 'any' && kind !== 'func' && kind !== 'object') {
        throw new Error('kind must be "func", "object" or "any"')
      }
      const limit = Math.min(Math.max(toNumber(args?.limit, 'limit') ?? 40, 1), 500)
      const needle = query.toLowerCase()
      const matches = table.symbols.filter((symbol) =>
        (kind === 'any' || symbol.kind === kind)
        && (needle === '' || symbol.name.toLowerCase().includes(needle)))
      const shown = matches.slice(0, limit).map(describeSymbol)
      return {
        ok: true,
        action,
        source: table.path,
        machine: table.machine,
        total: table.symbols.length,
        matched: matches.length,
        truncated: matches.length > shown.length,
        symbols: shown,
        summary: `${matches.length} of ${table.symbols.length} symbols`
          + (kind === 'any' ? '' : ` (${kind}s)`)
          + (query === '' ? '' : ` matching "${query}"`),
      }
    }

    if (action === 'resolve') {
      const table = await loadSymbolTable(true)
      const name = String(args?.name ?? '').trim()
      if (name === '') throw new Error('resolve needs `name`')
      const symbol = findSymbol(table, name)
      if (symbol !== undefined) {
        return {
          ok: true,
          action,
          source: table.path,
          found: true,
          symbol: describeSymbol(symbol),
          summary: `${symbol.name} = ${hex8(evenAddress(symbol.address))}${symbol.size > 0 ? ` (${symbol.size} B)` : ''}`,
        }
      }
      const needle = name.toLowerCase()
      const candidates = table.symbols
        .filter((entry) => entry.name.toLowerCase().includes(needle))
        .slice(0, 8)
        .map(describeSymbol)
      return {
        ok: true,
        action,
        source: table.path,
        found: false,
        candidates,
        summary: candidates.length === 0
          ? `no symbol matches "${name}"`
          : `"${name}" is not a symbol; did you mean ${candidates.map((entry) => entry.name).join(', ')}?`,
      }
    }

    if (!session.isOpen) {
      throw new Error('no open debug session; call mcu_debug with action "connect" first')
    }

    if (action === 'halt') {
      const result = await session.halt()
      return { ok: true, action, state: result.state, stop: result.stop, summary: `halted · ${stopName(result.stop)}` }
    }

    if (action === 'resume') {
      const result = await session.resume()
      return { ok: true, action, state: result.state, summary: 'core running' }
    }

    if (action === 'step') {
      const count = toNumber(args?.count, 'count') ?? 1
      const result = await session.step(count)
      const regs = await session.registers()
      const pcSymbol = annotatePc(regs.registers)
      return {
        ok: true,
        action,
        state: result.state,
        stop: result.stop,
        registers: regs.registers,
        ipsr: regs.ipsr,
        pcSymbol,
        summary: `stepped ${count} · PC=${hex8(parseInt(regs.registers.PC, 16))}${pcSymbol === undefined ? '' : ` ${pcSymbol.name}+${pcSymbol.offset}`}`,
      }
    }

    if (action === 'registers') {
      const result = await session.registers()
      const pcSymbol = annotatePc(result.registers)
      return {
        ok: true,
        action,
        state: result.state,
        registers: result.registers,
        ipsr: result.ipsr,
        pcSymbol,
        summary: `PC=${hex8(parseInt(result.registers.PC, 16))}`
          + (pcSymbol === undefined ? '' : ` ${pcSymbol.name}+${pcSymbol.offset}`)
          + ` · IPSR=${result.ipsr.value} (${result.ipsr.name})`,
      }
    }

    if (action === 'read_memory') {
      const target = await targetAddress(args, action)
      // A symbol's own size is the useful default: reading a struct usually
      // means "all of it", and the caller rarely knows the byte count.
      const fallback = target.symbol !== undefined && target.symbol.size > 0 ? target.symbol.size : 64
      const length = Math.max(1, Math.min(toNumber(args?.length, 'length') ?? fallback, resolved.maxReadBytes))
      const result = await session.readMemory(target.address, length)
      return {
        ok: true,
        action,
        state: result.state,
        memory: formatMemory(target.address, result.bytes),
        symbol: target.symbol === undefined ? undefined : describeSymbol(target.symbol),
        summary: `read ${result.bytes.length} bytes at ${hex8(target.address)}`
          + (target.symbol === undefined ? '' : ` (${target.symbol.name})`),
      }
    }

    if (action === 'write_memory') {
      const target = await targetAddress(args, action)
      const bytes = parseHexBytes(args?.bytes)
      const result = await session.writeMemory(target.address, bytes)
      return {
        ok: true,
        action,
        state: result.state,
        symbol: target.symbol === undefined ? undefined : describeSymbol(target.symbol),
        written: {
          address: hex8(target.address),
          length: bytes.length,
          bytes: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
        },
        summary: `wrote ${bytes.length} bytes at ${hex8(target.address)}`
          + (target.symbol === undefined ? '' : ` (${target.symbol.name})`),
      }
    }

    if (action === 'breakpoint') {
      const target = await targetAddress(args, action)
      const result = args?.clear === true
        ? await session.clearBreakpoint(target.address)
        : await session.setBreakpoint(target.address, 'hw')
      return {
        ok: true,
        action,
        state: session.state,
        breakpoints: result.breakpoints,
        symbol: target.symbol === undefined ? undefined : describeSymbol(target.symbol),
        summary: `${args?.clear === true ? 'cleared' : 'set'} breakpoint at ${hex8(target.address)}`
          + (target.symbol === undefined ? '' : ` (${target.symbol.name})`),
      }
    }

    if (action === 'reset') {
      const result = await session.reset()
      return {
        ok: true,
        action,
        state: result.state,
        output: result.output,
        summary: 'reset applied, core held at the reset vector',
      }
    }

    throw new Error(`unhandled action: ${action}`)
  }

  const debugTool = {
    name: 'mcu_debug',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'What to do with the target.' },
        address: {
          type: 'string',
          description: 'Target address, hex or decimal, for read_memory, write_memory and breakpoint. Mutually exclusive with symbol.',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name from the firmware .elf, used instead of address for read_memory, write_memory and breakpoint.',
        },
        length: {
          type: 'integer',
          minimum: 1,
          maximum: 4096,
          description: 'Bytes to read for read_memory. Defaults to the symbol size, else 64.',
        },
        query: {
          type: 'string',
          description: 'For symbols: case-insensitive substring filter. Empty lists every symbol.',
        },
        kind: {
          type: 'string',
          enum: ['any', 'func', 'object'],
          description: 'For symbols: keep only functions or only data objects. Defaults to any.',
        },
        file: {
          type: 'string',
          description: 'Absolute path to the firmware .elf for symbol names. Any action accepts it, and the session keeps the last one; mcu_flash sets it too.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'For symbols: how many matches to return. Defaults to 40.',
        },
        name: {
          type: 'string',
          description: 'For resolve: the exact symbol name to turn into an address.',
        },
        bytes: {
          type: 'string',
          description: 'Hex payload for write_memory, such as "deadbeef" or "DE AD BE EF".',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Instructions to advance for step. Defaults to 1.',
        },
        clear: {
          type: 'boolean',
          description: 'For breakpoint: true removes the breakpoint instead of setting it.',
        },
        halt: {
          type: 'boolean',
          description: 'For connect: true leaves the core halted instead of resuming it.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    timeoutMs: 120000,
    presentCall(args) {
      return describeCall(args)
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '')
      if (!ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`)
      if (exec.signal?.aborted) throw new Error('cancelled before dispatch')
      await resolveExe()
      try {
        return present(await runDebugAction(action, args))
      } finally {
        armIdle()
      }
    },
  }

  const flashTool = {
    name: 'mcu_flash',
    description: FLASH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute path to the .elf/.hex/.bin to program.',
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    timeoutMs: 180000,
    presentCall(args) {
      const name = String(args?.file ?? '').split(/[\\/]/).pop() ?? 'firmware'
      return { card: 'generic', title: `MCU flash ${name}`, kind: 'execute' }
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('cancelled before dispatch')
      const config = await commanderConfig()
      const wasOpen = session.isOpen
      if (wasOpen) await session.close()
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      try {
        const result = await perform(config, 'flash', { file: args?.file }, { halted: undefined })
        if (result.ok !== true) throw new Error(result.error ?? 'flash failed')
        // The image just programmed is the one the core runs, so it becomes the
        // session's symbol source — no separate setting to keep in sync.
        if (typeof result.file === 'string' && result.file.toLowerCase().endsWith('.elf')) {
          resolved.elfFile = result.file
          await loadSymbolTable(false)
        }
        return present({
          ok: true,
          action: 'flash',
          file: result.file,
          log: result.log,
          probe: result.probe,
          sessionRestarted: wasOpen,
          elf: elfSummary(),
          summary: result.summary,
        })
      } finally {
        if (wasOpen) {
          await session.open().catch(() => {})
          armIdle()
        }
      }
    },
  }

  // ------------------------------------------------------------------- panel
  //
  // The plugin's own settings page reads and writes the same Config the tools
  // use. The page lives in the browser, so the Host publishes one small JSON
  // route for it: the client owns the copy, this side owns the rules. Saving
  // goes through the Loader's config editor, the only writer that keeps
  // cordis.patch.yml, the running plugin and the panel in agreement.
  //
  // This exists because a schema-driven form was not enough: the bundle page
  // showed no editable form, so the plugin ships its own page instead of
  // depending on where a particular Harness build renders one.

  /** Field order and control kind for the panel; all labels live in the client. */
  const PANEL_FIELDS = [
    { key: 'device', kind: 'text' },
    { key: 'interface', kind: 'select', options: ['SWD', 'JTAG'] },
    { key: 'speedKhz', kind: 'number', min: 100, max: 50000 },
    { key: 'idleCloseMs', kind: 'number', min: 0, max: 86400000 },
    { key: 'maxReadBytes', kind: 'number', min: 16, max: 65536 },
    { key: 'jlinkExe', kind: 'text' },
    { key: 'gdbServerExe', kind: 'text' },
  ]

  const panelState = () => present({
    fields: PANEL_FIELDS.map((field) => present({
      ...field,
      value: field.kind === 'number'
        ? Number(resolved[field.key] ?? DEFAULTS[field.key] ?? 0)
        : String(resolved[field.key] ?? ''),
    })),
    session: session.isOpen ? 'open' : 'closed',
    targetState: session.isOpen ? session.state : undefined,
    probe: session.isOpen ? session.describe().probe : undefined,
    elf: elfSummary(),
  })

  /**
   * Validate a partial patch through the same schema the Loader validates with,
   * so the panel can never write a value the plugin would refuse to activate.
   */
  const validatedPatch = (patch) => {
    const merged = { ...baseline }
    for (const field of PANEL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field.key)) continue
      merged[field.key] = field.kind === 'number' ? Number(patch[field.key]) : patch[field.key]
    }
    const next = Config(merged)
    const out = {}
    for (const field of PANEL_FIELDS) {
      out[field.key] = field.kind === 'number' ? Number(next[field.key]) : String(next[field.key] ?? '')
    }
    return out
  }

  /** Locate this plugin's own Loader entry across the shapes a profile can use. */
  const findEntry = (editor) => {
    const entries = editor.entries()
    return entries.find((entry) => entry?.name === PACKAGE_NAME)
      ?? entries.find((entry) => String(entry?.patchId ?? '') === 'jlink-debug')
      ?? entries.find((entry) => String(entry?.id ?? '').includes('jlink-debug'))
  }

  /**
   * Persist a complete config through the Loader. Deferred by the caller: the
   * write reloads this very plugin, so the HTTP response must go out first.
   */
  const persistConfig = async (next) => {
    const editor = ctx.get('configEditor')
    if (editor !== undefined && typeof editor.edit === 'function') {
      const entry = findEntry(editor)
      if (entry === undefined) throw new Error('this plugin is not addressable in the profile patch')
      await editor.edit(entry, () => next)
      return
    }
    const settings = ctx.get('settings')
    if (settings !== undefined && typeof settings.update === 'function') {
      await settings.update('include:jlink-debug', next)
      return
    }
    throw new Error('this Harness exposes neither configEditor nor settings')
  }

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const readJsonBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 65536) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8').trim()
    return text === '' ? {} : JSON.parse(text)
  }

  const handleConfigRoute = async (req, res) => {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, panelState())
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const patch = body?.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('expected { "patch": { ... } }')
        }
        const next = validatedPatch(patch)
        sendJson(res, 200, { ok: true, scheduled: true, expected: next })
        // After the response: the write disposes the instance that owns this socket.
        setTimeout(() => { persistConfig(next).catch(() => {}) }, 30)
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** Publish the panel's data channel when this composition serves the Web UI. */
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: handleConfigRoute,
    }), 'jlink-debug-config-route')
  }

  ctx.effect(() => () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    session.close().catch(() => {})
  }, 'mcu-debug-session')
  ctx.effect(() => ctx.tools.register(debugTool), 'mcu-debug')
  ctx.effect(() => ctx.tools.register(flashTool), 'mcu-debug-flash')
}
