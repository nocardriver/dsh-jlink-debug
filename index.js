/**
 * Host half: the `mcu_debug` and `mcu_flash` tools.
 *
 * `mcu_debug` runs over a persistent JLinkGDBServer session, so the core can be
 * halted, stepped, breakpointed and sampled repeatedly at sub-millisecond cost.
 * `mcu_flash` is separate because programming is destructive and needs the
 * probe released, which means the session has to be closed first.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import {
  describeDevice,
  findDevice,
  loadDeviceDatabase,
  readDeviceHistory,
  recordDeviceHistory,
  searchDevices,
} from './devices.js'
import { findSymbol, loadSymbols, nearestSymbol } from './elf.js'
import { loadDebugInfo } from './dwarf.js'
import { findJLink, perform } from './jlink.js'
import { ProbeSession } from './session.js'

export const inject = ['tools']

/** Must match package.json `name`: the settings panel and its route key off it. */
const PACKAGE_NAME = '@nocardriver/dsh-jlink-debug'
const CONFIG_PATH = '/jlink-debug/config'
const WORKSPACE_PATH = '/jlink-debug/workspace'
const DEVICES_PATH = '/jlink-debug/devices'

/**
 * The fields that describe the attached target rather than this machine. A chip
 * model, a transport and a clock belong to one board, so each workspace owns
 * its own values and the global config only supplies the fallback default.
 */
const TARGET_FIELDS = ['device', 'interface', 'speedKhz']

/**
 * Per-workspace values are stored beside the harness home, never inside the
 * workspace: a debug setting must not show up in the user's `git status`. The
 * Host may not carry a profile variable, so `DSH_HOME` is the usual base.
 */
const STATE_DIR = join(
  process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'jlink-debug',
)
const STATE_FILE = join(STATE_DIR, 'workspaces.json')

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
  'symbols', 'type', 'resolve',
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
  'read_memory — read a byte range; with a symbol it also decodes the DWARF type into named fields;',
  'write_memory — write hex bytes to RAM or peripheral space;',
  'breakpoint — set (default) or clear a hardware breakpoint at address;',
  'reset — reset the core and hold it at the reset vector;',
  'symbols — list or search names from the firmware .elf symbol table (objects carry their DWARF type);',
  'type — show a DWARF type layout: fields, offsets and enum values, for a type name or a variable;',
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
  'the symbol and DWARF type source for this session, so read_memory can decode struct fields and breakpoint can take names.',
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
  if (action === 'type') return { card: 'generic', title: `MCU type ${args?.name ?? '?'}`, kind: 'read' }
  if (action === 'resolve') return { card: 'generic', title: `MCU resolve ${args?.name ?? '?'}`, kind: 'read' }
  if (action === 'step') return { card: 'generic', title: `MCU step ${args?.count ?? 1}`, kind: 'execute' }
  if (action === 'registers') return { card: 'generic', title: 'MCU registers', kind: 'other' }
  if (action === 'reset') return { card: 'generic', title: 'MCU reset', kind: 'execute' }
  return { card: 'generic', title: `MCU ${action}`, kind: 'other' }
}

/**
 * Keep only what this file writes and understands. A hand-edited or
 * older-version file must not be able to inject values into a probe command.
 */
function normalizeWorkspaceEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entry = {}
  if (typeof raw.path === 'string' && raw.path !== '') entry.path = raw.path
  if (typeof raw.title === 'string') entry.title = raw.title
  if (typeof raw.device === 'string' && raw.device.trim() !== '') entry.device = raw.device.trim()
  if (raw.interface === 'SWD' || raw.interface === 'JTAG') entry.interface = raw.interface
  if (typeof raw.speedKhz === 'number' && Number.isFinite(raw.speedKhz)) entry.speedKhz = raw.speedKhz
  if (typeof raw.elfFile === 'string' && raw.elfFile !== '') entry.elfFile = raw.elfFile
  if (typeof raw.updatedAt === 'string') entry.updatedAt = raw.updatedAt
  return entry
}

/** Compare Windows paths the way the filesystem does: case-insensitively. */
function foldPath(value) {
  return String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Whether `child` is `parent` itself or sits below it. */
function pathContains(parent, child) {
  const outer = foldPath(parent)
  const inner = foldPath(child)
  if (outer === '' || inner === '') return false
  return inner === outer || inner.startsWith(`${outer}\\`)
}

/** The effective target: the workspace's values over the global defaults. */
function targetFor(defaults, entry) {
  return {
    device: entry?.device ?? defaults.device,
    interface: entry?.interface ?? defaults.interface,
    speedKhz: entry?.speedKhz ?? defaults.speedKhz,
  }
}

function targetSignature(target) {
  return `${target.device}|${target.interface}|${target.speedKhz}`
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
  /** Parsed .elf symbol table, and the image it was parsed from. */
  let symbols
  let symbolsSource
  /** Why the last symbol load failed; kept so `status` can explain an empty lookup. */
  let symbolsError
  /** Parsed DWARF type table for the same image (absent on stripped builds). */
  let dwarf
  let dwarfSource
  let dwarfError
  /** The workspace and target the current call, and the live session, belong to. */
  let active

  // ------------------------------------------------------------ workspace state
  //
  // Target settings are per workspace: one probe is shared, but each project
  // has its own board, transport and clock. They live in one JSON file beside
  // the profile, so the tools, the right-sidebar panel and a restart all read
  // the same values.

  let store
  let storeWrites = Promise.resolve()

  const readStore = async () => {
    if (store !== undefined) return store
    try {
      const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
      const workspaces = {}
      for (const [key, value] of Object.entries(parsed?.workspaces ?? {})) {
        const entry = normalizeWorkspaceEntry(value)
        if (entry !== undefined) workspaces[key] = entry
      }
      store = { version: 1, workspaces }
    } catch {
      // Absent, unreadable or corrupt: start empty rather than fail the call.
      store = { version: 1, workspaces: {} }
    }
    return store
  }

  const readWorkspace = async (key) => (await readStore()).workspaces[key]

  /** Queue a durable write; a failed write must not fail the current call. */
  const writeWorkspace = (key, entry) => {
    storeWrites = storeWrites.then(async () => {
      const state = await readStore()
      if (entry === undefined) {
        delete state.workspaces[key]
      } else {
        state.workspaces[key] = normalizeWorkspaceEntry({
          ...entry,
          updatedAt: new Date().toISOString(),
        })
      }
      await mkdir(STATE_DIR, { recursive: true })
      const temp = `${STATE_FILE}.tmp`
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temp, STATE_FILE)
    }).catch(() => {})
    return storeWrites
  }

  /**
   * Which workspace a session belongs to. The registry's session index is
   * authoritative; a session that changed its working directory falls back to
   * the deepest registered directory containing it, and an unregistered
   * directory keeps its settings under `cwd:`+path.
   */
  const resolveWorkspace = (sessionId) => {
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    const cwd = sessionId === undefined ? undefined : sessions?.get(sessionId)?.header?.cwd
    if (registry !== undefined && typeof registry.list === 'function') {
      const workspaces = registry.list()
      if (sessionId !== undefined) {
        const owner = workspaces.find((entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId))
        if (owner !== undefined) {
          return { key: owner.id, path: owner.path, title: owner.title, source: 'workspace' }
        }
      }
      if (typeof cwd === 'string') {
        const holder = workspaces
          .filter((entry) => pathContains(entry.path, cwd))
          .sort((left, right) => right.path.length - left.path.length)[0]
        if (holder !== undefined) {
          return { key: holder.id, path: holder.path, title: holder.title, source: 'workspace' }
        }
      }
    }
    if (typeof cwd === 'string' && cwd !== '') {
      return { key: `cwd:${foldPath(cwd)}`, path: cwd, title: basename(cwd), source: 'directory' }
    }
    return { key: 'default', path: '', title: '', source: 'default' }
  }

  /**
   * Point this call — and the live session — at the caller's workspace.
   *
   * A probe can only serve one target, so moving to another workspace or
   * another board releases the session; the next `connect` attaches with the
   * values the panel just saved.
   */
  const activate = async (sessionId) => {
    const workspace = resolveWorkspace(sessionId)
    const entry = await readWorkspace(workspace.key)
    const target = targetFor(baseline, entry)
    const signature = targetSignature(target)
    const moved = active === undefined
      || active.workspace.key !== workspace.key
      || active.signature !== signature
    if (moved && active !== undefined) {
      if (session.isOpen) await session.close().catch(() => {})
      symbols = undefined
      symbolsSource = undefined
      symbolsError = undefined
      dwarf = undefined
      dwarfSource = undefined
      dwarfError = undefined
    }
    session.config = { ...resolved, ...target }
    active = { workspace, target, signature, elfFile: entry?.elfFile }
    return active
  }

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
    // The commander must attach to the same board the session would.
    return { ...resolved, ...(active?.target ?? {}), jlinkExe: exe }
  }

  /**
   * Load the symbol table for the image this workspace is working with.
   *
   * `required` separates the two callers: a plain register read silently loses
   * its PC annotation when no image is known, while an explicit
   * `symbols`/`resolve` call must say why it has nothing to look up. The image
   * arrives from `mcu_flash`, or from a `file` argument on any call — the agent
   * knows best which build it just made.
   */
  const loadSymbolTable = async (required) => {
    const source = active?.elfFile
    if (!source) {
      if (required) {
        throw new Error(
          'no firmware image for symbol lookup: flash an .elf with mcu_flash, '
          + 'or pass `file` with the .elf you built',
        )
      }
      return undefined
    }
    if (symbols !== undefined && symbolsSource === source) return symbols
    try {
      symbols = await loadSymbols(source)
      symbolsSource = source
      symbolsError = undefined
    } catch (error) {
      symbols = undefined
      symbolsSource = undefined
      symbolsError = `${source}: ${error.message}`
      if (required) throw new Error(`cannot read symbols from ${symbolsError}`)
    }
    return symbols
  }

  /** A symbol table only annotates the image the current workspace points at. */
  const liveSymbols = () => (symbolsSource === active?.elfFile ? symbols : undefined)

  /**
   * Load the DWARF type table for the same image as the symbols.
   *
   * DWARF is optional: a stripped Release build must still get names, addresses
   * and raw bytes. `required` is therefore false for `symbols`/`read_memory`
   * and true only for the explicit `type` action.
   */
  const loadDebugTable = async (required) => {
    const source = active?.elfFile
    if (!source) {
      if (required) {
        throw new Error(
          'no firmware image for type lookup: flash an .elf with mcu_flash, '
          + 'or pass `file` with the .elf you built',
        )
      }
      return undefined
    }
    if (dwarf !== undefined && dwarfSource === source) return dwarf
    try {
      dwarf = await loadDebugInfo(source)
      dwarfSource = source
      dwarfError = undefined
    } catch (error) {
      dwarf = undefined
      dwarfSource = undefined
      dwarfError = `${source}: ${error.message}`
      if (required) throw new Error(`cannot read DWARF from ${dwarfError}`)
    }
    return dwarf
  }

  /** DWARF annotations belong to the live image, exactly like symbols. */
  const liveDebug = () => (dwarfSource === active?.elfFile ? dwarf : undefined)

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
    const table = liveSymbols()
    if (table === undefined || registers === undefined) return undefined
    const pc = Number.parseInt(String(registers.PC ?? ''), 16)
    if (!Number.isFinite(pc)) return undefined
    const near = nearestSymbol(table, pc)
    if (near === undefined) return undefined
    return { name: near.symbol.name, offset: near.offset }
  }

  /** A compact, JSON-safe view of one symbol for tool results. */
  const describeSymbol = (symbol) => {
    const described = {
      name: symbol.name,
      address: hex8(evenAddress(symbol.address)),
      size: symbol.size,
      kind: symbol.kind,
    }
    // Objects are the only entries DWARF can describe; functions keep their
    // signature out of this compact view (use `type` for a named type).
    if (symbol.kind === 'object') {
      const info = liveDebug()?.typeForSymbol(symbol)
      if (info !== undefined) {
        described.type = info.name
        if (info.size !== undefined) described.typeSize = info.size
      }
    }
    return described
  }

  /** What symbol lookups currently answer from; shown by `status`. */
  const elfSummary = () => {
    const table = liveSymbols()
    const debug = liveDebug()
    const summary = {
      file: active?.elfFile ?? '',
      symbols: table === undefined ? 0 : table.symbols.length,
      functions: table === undefined ? 0 : table.funcs.length,
      error: symbolsError,
    }
    if (debug !== undefined) summary.dwarf = debug.summary()
    else if (dwarfError !== undefined) summary.dwarfError = dwarfError
    return present(summary)
  }

  function stopName(stop) {
    if (stop === undefined || stop === null) return 'unknown'
    if (stop.kind === 'reset') return 'reset'
    if (stop.kind === 'signal') return `signal ${stop.signal}`
    if (stop.kind === 'exit') return `exit ${stop.code}`
    return String(stop.kind)
  }

  async function runDebugAction(action, args) {
    // Any call may point at a build with `file`. The workspace keeps it, so the
    // agent decides which image the symbols come from and states it once.
    if (typeof args?.file === 'string' && args.file.trim() !== '' && active !== undefined) {
      const file = args.file.trim()
      const entry = await readWorkspace(active.workspace.key) ?? {}
      active.elfFile = file
      await writeWorkspace(active.workspace.key, {
        ...entry,
        path: active.workspace.path,
        title: active.workspace.title,
        elfFile: file,
      })
    }
    const origin = present({
      workspace: active?.workspace,
      config: active?.target,
    })
    if (action === 'status') {
      // `status` is the cheap poll, so it is also the right place to warm the
      // symbol cache: a failed load stays reported instead of breaking status.
      if (active?.elfFile !== undefined && liveSymbols() === undefined) await loadSymbolTable(false)
      if (active?.elfFile !== undefined && liveDebug() === undefined) await loadDebugTable(false)
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
          ...origin,
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
        ...origin,
        summary: result.summary,
      }
    }

    if (action === 'connect') {
      const info = await session.open({ halt: args?.halt === true })
      void recordDeviceHistory(STATE_DIR, session.config.device)
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
      await loadDebugTable(false)
      const query = String(args?.query ?? '').trim()
      const kind = String(args?.kind ?? 'any').trim()
      if (kind !== 'any' && kind !== 'func' && kind !== 'object') {
        throw new Error('kind must be "func", "object" or "any"')
      }
      const limit = Math.min(Math.max(toNumber(args?.limit, 'limit') ?? 40, 1), 500)
      const needle = query.toLowerCase()
      const matches = table.symbols.filter((symbol) => {
        if (kind !== 'any' && symbol.kind !== kind) return false
        if (needle === '') return true
        if (symbol.name.toLowerCase().includes(needle)) return true
        // Searching a type name should find the variables of that type, which
        // is how an agent gets from "FOC_motor_dev" to `motor` without a scan.
        const type = liveDebug()?.typeForSymbol(symbol)
        return type !== undefined && type.name.toLowerCase().includes(needle)
      })
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
      await loadDebugTable(false)
      const name = String(args?.name ?? '').trim()
      if (name === '') throw new Error('resolve needs `name`')
      const symbol = findSymbol(table, name)
      if (symbol !== undefined) {
        const described = describeSymbol(symbol)
        return {
          ok: true,
          action,
          source: table.path,
          found: true,
          symbol: described,
          summary: `${symbol.name} = ${hex8(evenAddress(symbol.address))}`
            + (symbol.size > 0 ? ` (${symbol.size} B)` : '')
            + (described.type === undefined ? '' : ` · ${described.type}`),
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

    // Type lookup is host-only too; no probe is needed.
    if (action === 'type') {
      const debug = await loadDebugTable(true)
      const name = String(args?.name ?? '').trim()
      if (name === '') throw new Error('type needs `name` (a type name or a variable symbol)')
      const depth = Math.min(Math.max(toNumber(args?.depth, 'depth') ?? 2, 1), 6)
      let die = debug.typeByName(name)
      let target = 'type'
      if (die === undefined) {
        const variable = debug.variable(name)
        if (variable !== undefined) {
          die = variable.type
          target = 'variable'
        }
      }
      if (die === undefined) {
        const needle = name.toLowerCase()
        const candidates = [...new Set([
          ...debug.typesByName.keys(),
          ...debug.variablesByName.keys(),
        ])].filter((entry) => entry.toLowerCase().includes(needle)).slice(0, 8)
        return {
          ok: true,
          action,
          source: debug.path,
          found: false,
          candidates,
          summary: candidates.length === 0
            ? `no DWARF type or variable matches "${name}"`
            : `"${name}" is not a type or variable; did you mean ${candidates.join(', ')}?`,
        }
      }

      const layout = debug.describeType(die, { depth })
      const parts = [layout.name ?? name, layout.kind]
      if (layout.size !== undefined) parts.push(`${layout.size} B`)
      if (Array.isArray(layout.members)) parts.push(`${layout.members.length} fields`)
      if (Array.isArray(layout.values)) parts.push(`${layout.values.length} values`)
      return {
        ok: true,
        action,
        source: debug.path,
        found: true,
        target,
        type: layout,
        summary: parts.filter((part) => part !== undefined && part !== '').join(' · '),
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

      // Decode the raw bytes through DWARF when the image carries types. A
      // short read is left undecoded rather than reporting half a struct.
      let value
      let valueType
      let valueSize
      let valueNote
      let valuePartial
      const debug = target.symbol === undefined ? undefined : await loadDebugTable(false)
      if (target.symbol !== undefined && debug !== undefined) {
        const variable = debug.variableFor(target.symbol)
        if (variable !== undefined) {
          const declared = debug.sizeOf(variable.type)
          if (declared !== undefined) {
            valueType = debug.typeLabel(variable.type)
            valueSize = declared
            const depth = Math.min(Math.max(toNumber(args?.depth, 'depth') ?? 4, 1), 8)
            value = debug.decode(variable.type, result.bytes, { depth })
            if (result.bytes.length < declared) {
              valuePartial = true
              valueNote = `decoded the values that fit in the first ${result.bytes.length} of ${declared} bytes; `
                + `pass length=${declared} (and raise Max read bytes if needed) for the full value`
            }
          }
        }
      }

      return {
        ok: true,
        action,
        state: result.state,
        memory: formatMemory(target.address, result.bytes),
        symbol: target.symbol === undefined ? undefined : describeSymbol(target.symbol),
        value,
        valueType,
        valueSize,
        valuePartial,
        valueNote,
        summary: `read ${result.bytes.length} bytes at ${hex8(target.address)}`
          + (target.symbol === undefined ? '' : ` (${target.symbol.name})`)
          + (value === undefined ? '' : ` · ${valueType}`),
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
          description: 'For resolve: the exact symbol name. For type: a type name or the name of a variable whose type should be shown.',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description: 'For type and decoded read_memory: how many nesting levels of structs/arrays to expand. Defaults to 2 for type and 4 for reads.',
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
      // This call belongs to a workspace, and that workspace owns the target.
      await activate(exec.agent?.id)
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
      await resolveExe()
      await activate(exec.agent?.id)
      const config = await commanderConfig()
      const wasOpen = session.isOpen
      if (wasOpen) await session.close()
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      try {
        const result = await perform(config, 'flash', { file: args?.file }, { halted: undefined })
        if (result.ok !== true) throw new Error(result.error ?? 'flash failed')
        void recordDeviceHistory(STATE_DIR, config.device)
        // The image just programmed is the one the core runs, so it becomes the
        // workspace's symbol source — no separate setting to keep in sync.
        if (typeof result.file === 'string' && result.file.toLowerCase().endsWith('.elf')) {
          const entry = await readWorkspace(active.workspace.key) ?? {}
          active.elfFile = result.file
          await writeWorkspace(active.workspace.key, {
            ...entry,
            path: active.workspace.path,
            title: active.workspace.title,
            elfFile: result.file,
          })
          await loadSymbolTable(false)
          await loadDebugTable(false)
        }
        return present({
          ok: true,
          action: 'flash',
          file: result.file,
          log: result.log,
          probe: result.probe,
          sessionRestarted: wasOpen,
          workspace: active.workspace,
          config: active.target,
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

  /** Field order and control kind for the global panel; all labels live in the client. */
  const PANEL_FIELDS = [
    { key: 'idleCloseMs', kind: 'number', min: 0, max: 86400000 },
    { key: 'maxReadBytes', kind: 'number', min: 16, max: 65536 },
    { key: 'jlinkExe', kind: 'text' },
    { key: 'gdbServerExe', kind: 'text' },
  ]

  /** Field order and control kind for the right-sidebar target panel. */
  const TARGET_PANEL_FIELDS = [
    { key: 'device', kind: 'text' },
    { key: 'interface', kind: 'select', options: ['SWD', 'JTAG'] },
    { key: 'speedKhz', kind: 'number', min: 100, max: 50000 },
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
   * The right-sidebar panel's state: which workspace the calling session
   * belongs to, its effective target, and whether each value overrides the
   * global default.
   */
  const workspacePanelState = async (sessionId) => {
    const workspace = resolveWorkspace(sessionId)
    const entry = await readWorkspace(workspace.key)
    const target = targetFor(baseline, entry)
    const table = active !== undefined && active.workspace.key === workspace.key ? liveSymbols() : undefined
    return present({
      ok: true,
      workspace,
      fields: TARGET_PANEL_FIELDS.map((field) => present({
        key: field.key,
        kind: field.kind,
        options: field.options,
        min: field.min,
        max: field.max,
        value: target[field.key],
        default: baseline[field.key],
        override: entry?.[field.key] !== undefined,
      })),
      session: session.isOpen
        ? present({
            open: true,
            state: session.state,
            probe: session.describe().probe,
            connectsTo: session.config.device,
          })
        : { open: false },
      elf: present({
        file: entry?.elfFile ?? '',
        symbols: table === undefined ? 0 : table.symbols.length,
        functions: table === undefined ? 0 : table.funcs.length,
      }),
    })
  }

  const handleWorkspaceRoute = async (req, res) => {
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        sendJson(res, 200, await workspacePanelState(url.searchParams.get('session') ?? undefined))
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const sessionId = typeof body?.session === 'string' && body.session.trim() !== ''
          ? body.session.trim()
          : undefined
        const workspace = resolveWorkspace(sessionId)
        const current = await readWorkspace(workspace.key) ?? {}
        const next = { ...current, path: workspace.path, title: workspace.title }
        if (body?.reset === true) {
          for (const field of TARGET_FIELDS) delete next[field]
        } else {
          const patch = body?.patch ?? {}
          const candidate = targetFor(baseline, current)
          for (const field of TARGET_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
            candidate[field] = field === 'speedKhz' ? Number(patch[field]) : patch[field]
          }
          if (typeof candidate.device !== 'string' || candidate.device.trim() === '') {
            throw new Error('device must be a J-Link device name such as STM32H503CB')
          }
          candidate.device = candidate.device.trim()
          // The same schema the Loader validates with, so the panel can never
          // save a value the plugin would refuse to activate.
          const validated = Config({ ...baseline, ...candidate })
          const defaults = targetFor(baseline, undefined)
          for (const field of TARGET_FIELDS) {
            // Store only a real difference from the default, so an unchanged
            // value keeps following a later change to the global default.
            if (validated[field] === defaults[field]) delete next[field]
            else next[field] = validated[field]
          }
        }
        // Drop the record entirely once it carries nothing: an empty entry
        // would otherwise outlive the overrides it used to hold.
        const keep = TARGET_FIELDS.some((field) => next[field] !== undefined) || next.elfFile !== undefined
        await writeWorkspace(workspace.key, keep ? next : undefined)
        const target = targetFor(baseline, next)
        // Remember an explicit choice; clearing the overrides is not one. The
        // write is awaited so the next dropdown open already lists it.
        if (body?.reset !== true && typeof body?.patch?.device === 'string' && body.patch.device.trim() !== '') {
          await recordDeviceHistory(STATE_DIR, target.device)
        }
        const signature = targetSignature(target)
        if (session.isOpen && active?.workspace.key === workspace.key && active.signature !== signature) {
          // Saving a different board releases the probe; the next call attaches.
          await session.close().catch(() => {})
          symbols = undefined
          symbolsSource = undefined
          symbolsError = undefined
        }
        if (active?.workspace.key === workspace.key) {
          active = { ...active, target, signature, elfFile: next.elfFile }
          session.config = { ...resolved, ...target }
        }
        sendJson(res, 200, await workspacePanelState(sessionId))
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /**
   * The J-Link device library, for the sidebar picker.
   *
   * SEGGER ships no plain list file; `devices.js` asks J-Link Commander to
   * export the DLL's internal database and caches the parsed index beside the
   * workspace state. The first request costs about a second, every later one
   * is a lookup. `refresh=1` is the panel's explicit "re-read the library".
   */
  const handleDevicesRoute = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const query = url.searchParams.get('q') ?? ''
      const asked = Number(url.searchParams.get('limit') ?? 80)
      const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 300) : 80
      const refresh = url.searchParams.get('refresh') === '1'
      const past = await readDeviceHistory(STATE_DIR)
      const history = (database) => past.map((entry) => {
        const found = findDevice(database, entry.name)
        return present({
          ...describeDevice(found),
          // Prefer the spelling the library uses, so a lower-case choice from
          // an older config still shows as the canonical name.
          name: found === undefined ? entry.name : found.name,
          at: entry.at,
        })
      })
      let database
      try {
        const exe = await resolveExe()
        database = await loadDeviceDatabase({
          exe,
          dir: STATE_DIR,
          refresh,
          timeoutMs: resolved.timeoutMs,
        })
      } catch (error) {
        // A missing or broken J-Link install must not break the panel: it still
        // accepts a name typed by hand, so the answer stays a normal document.
        sendJson(res, 200, present({
          ok: true,
          available: false,
          error: String(error?.message ?? error),
          history: history(undefined),
        }))
        return
      }
      const exact = findDevice(database, query)
      const found = searchDevices(database, query, limit)
      sendJson(res, 200, present({
        ok: true,
        available: true,
        source: database.exe,
        jlink: database.jlink,
        builtAt: database.builtAt,
        cached: database.cached === true,
        total: database.total,
        matched: found.matched,
        devices: found.items.map(describeDevice),
        exact: exact === undefined ? null : describeDevice(exact),
        history: history(database),
      }))
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /**
   * Validate a partial patch through the same schema the Loader validates with,
   * so the panel can never write a value the plugin would refuse to activate.
   *
   * The Loader replaces the whole row config, so the result must stay complete:
   * it starts from what the row already configured and keeps the target
   * defaults this page no longer edits.
   */
  const validatedPatch = (patch) => {
    const merged = { ...baseline }
    for (const field of PANEL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field.key)) continue
      merged[field.key] = field.kind === 'number' ? Number(patch[field.key]) : patch[field.key]
    }
    const next = Config(merged)
    const out = { ...given }
    for (const field of PANEL_FIELDS) {
      out[field.key] = field.kind === 'number' ? Number(next[field.key]) : String(next[field.key] ?? '')
    }
    for (const field of TARGET_FIELDS) out[field] = next[field]
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

  // Publish the panels' data channels when this composition serves the Web UI.
  //
  // The Web host mounts after this plugin on a cold start, so the service is
  // awaited through `ctx.inject` rather than read once: a one-shot `ctx.get`
  // finds it absent, silently registers nothing, and both panels then answer
  // HTTP 404 until the plugin happens to be reloaded.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    const disposeConfig = webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: handleConfigRoute,
    })
    const disposeWorkspace = webServer.register({
      kind: 'exact',
      path: WORKSPACE_PATH,
      handler: handleWorkspaceRoute,
    })
    const disposeDevices = webServer.register({
      kind: 'exact',
      path: DEVICES_PATH,
      handler: handleDevicesRoute,
    })
    return () => {
      disposeDevices()
      disposeWorkspace()
      disposeConfig()
    }
  })

  ctx.effect(() => () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    session.close().catch(() => {})
  }, 'mcu-debug-session')
  ctx.effect(() => ctx.tools.register(debugTool), 'mcu-debug')
  ctx.effect(() => ctx.tools.register(flashTool), 'mcu-debug-flash')
}
