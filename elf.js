/**
 * ELF32 symbol table reader for the DSH mcu_debug plugin.
 *
 * The debug tools answer two questions constantly: "which function is this PC
 * in?" and "what address is main at?". Both are symbol-table lookups, so this
 * module parses .symtab straight out of the deployed image with node:fs and
 * nothing else. It is deliberately narrow: ELF32 little-endian, i.e. every
 * Cortex-M image we flash. ELF64 and big-endian images are rejected loudly
 * instead of being half-parsed.
 *
 * Every read is bounds-checked (a truncated download must never make the
 * debugger invent addresses), and loadSymbols keeps a stat-keyed cache so a
 * polling debugger does not re-read the ELF on every lookup.
 */
import * as fs from 'node:fs'

const SHT_SYMTAB = 2
const SHT_STRTAB = 3
const SHN_UNDEF = 0
const SHN_XINDEX = 0xffff
const STT_OBJECT = 1
const STT_FUNC = 2
const STT_SECTION = 3
const STT_FILE = 4

const MACHINES = {
  2: 'SPARC',
  3: 'x86',
  8: 'MIPS',
  20: 'PowerPC',
  21: 'PowerPC64',
  40: 'ARM',
  42: 'SuperH',
  43: 'SPARCv9',
  50: 'IA-64',
  62: 'x86-64',
  83: 'AVR',
  94: 'Xtensa',
  105: 'MSP430',
  183: 'AArch64',
  243: 'RISC-V',
}

const MALFORMED = 'truncated or malformed ELF'

/**
 * @typedef {object} Symbol
 * @property {string} name
 * @property {number} address raw st_value (Thumb functions keep bit 0 set)
 * @property {number} size st_size; 0 is valid for assembly labels
 * @property {'func'|'object'|'other'} kind
 * @property {'local'|'global'|'weak'|number} binding STB_* name, or the raw value
 */

/**
 * @typedef {object} ParsedElf
 * @property {string|undefined} path set by loadSymbols, undefined otherwise
 * @property {string} machine e.g. 'ARM'
 * @property {Symbol[]} symbols sorted by address, then name
 * @property {Map<string, Symbol>} byName first definition wins
 * @property {Symbol[]} funcs kind === 'func' && size > 0
 * @property {{startsAt: number, size: number}} text bounds of the .text section
 */

/** Little-endian, bounds-checked field reads; out-of-range means malformed. */
function u8(dv, offset) {
  if (offset < 0 || offset >= dv.byteLength) throw new Error(MALFORMED)
  return dv.getUint8(offset)
}

function u16(dv, offset) {
  if (offset < 0 || offset + 2 > dv.byteLength) throw new Error(MALFORMED)
  return dv.getUint16(offset, true)
}

function u32(dv, offset) {
  if (offset < 0 || offset + 4 > dv.byteLength) throw new Error(MALFORMED)
  return dv.getUint32(offset, true)
}

/**
 * Read a NUL-terminated string from a string table. A bad st_name is tolerated:
 * undefined is returned and the caller skips that single symbol.
 */
function readCString(bytes, base, size, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) return undefined
  const start = base + offset
  const end = base + size
  let stop = start
  while (stop < end && bytes[stop] !== 0) stop += 1
  if (stop === end) return undefined
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, stop - start).toString('utf8')
}

/**
 * Parse an ELF image. `path` is only used in diagnostics and in the result.
 * @param {Buffer|Uint8Array} input
 * @param {string|undefined} path
 * @returns {ParsedElf}
 */
function parseElf(input, path) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('parseElfSymbols expects a Buffer or Uint8Array')
  }
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)

  const isElf =
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  if (!isElf) throw new Error(`not an ELF file: ${path ?? '<buffer>'}`)
  if (bytes.length < 52) throw new Error(MALFORMED)

  if (bytes[4] !== 1) {
    const name = bytes[4] === 2 ? 'ELF64' : `class ${bytes[4]}`
    throw new Error(`unsupported ELF class: ${name} (only ELF32 is supported)`)
  }
  if (bytes[5] !== 1) {
    const name = bytes[5] === 2 ? 'big-endian' : `EI_DATA ${bytes[5]}`
    throw new Error(`unsupported ELF endianness: ${name} (only little-endian is supported)`)
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const machine = u16(dv, 18)
  const shoff = u32(dv, 32)
  const shentsize = u16(dv, 46)
  let shnum = u16(dv, 48)
  let shstrndx = u16(dv, 50)

  if (shoff === 0 || shentsize < 40) throw new Error(MALFORMED)

  // Extended numbering: e_shnum == 0 hides the real count in section 0's
  // sh_size, and e_shstrndx == SHN_XINDEX hides the real index in its sh_link.
  if (shnum === 0) shnum = u32(dv, shoff + 20)
  if (shstrndx === SHN_XINDEX) shstrndx = u32(dv, shoff + 24)
  if (shnum === 0 || shoff + shnum * shentsize > bytes.length) throw new Error(MALFORMED)

  /** Decode the fields of one section header that this module cares about. */
  const section = (index) => {
    if (index < 0 || index >= shnum) throw new Error(MALFORMED)
    const at = shoff + index * shentsize
    return {
      nameOffset: u32(dv, at),
      type: u32(dv, at + 4),
      addr: u32(dv, at + 12),
      offset: u32(dv, at + 16),
      size: u32(dv, at + 20),
      link: u32(dv, at + 24),
    }
  }

  // Section names need the section header string table (.shstrtab).
  let shstr = null
  if (shstrndx !== 0) {
    if (shstrndx >= shnum) throw new Error(MALFORMED)
    shstr = section(shstrndx)
    if (shstr.offset + shstr.size > bytes.length) throw new Error(MALFORMED)
  }
  const sectionName = (header) =>
    shstr ? readCString(bytes, shstr.offset, shstr.size, header.nameOffset) : undefined

  // Locate .symtab; its sh_link is the symbol string table (.strtab).
  let symtab = null
  for (let i = 0; i < shnum; i += 1) {
    const header = section(i)
    if (header.type === SHT_SYMTAB) {
      symtab = header
      break
    }
  }
  if (!symtab) throw new Error('ELF has no symbol table (.symtab)')

  const strtab = section(symtab.link)
  if (strtab.type !== SHT_STRTAB) throw new Error(MALFORMED)
  if (symtab.offset + symtab.size > bytes.length) throw new Error(MALFORMED)
  if (strtab.offset + strtab.size > bytes.length) throw new Error(MALFORMED)

  // One Elf32_Sym is 16 bytes: st_name, st_value, st_size, st_info, st_other,
  // st_shndx. st_other is not used, so it is never read.
  const symbols = []
  const byName = new Map()
  const count = Math.floor(symtab.size / 16)
  for (let i = 0; i < count; i += 1) {
    const at = symtab.offset + i * 16
    const nameOffset = u32(dv, at)
    const address = u32(dv, at + 4)
    const size = u32(dv, at + 8)
    const info = u8(dv, at + 12)
    const shndx = u16(dv, at + 14)
    const type = info & 0x0f
    const bind = info >> 4

    if (type === STT_SECTION || type === STT_FILE) continue
    if (shndx === SHN_UNDEF) continue

    const name = readCString(bytes, strtab.offset, strtab.size, nameOffset)
    if (!name) continue

    const symbol = {
      name,
      address,
      size,
      kind: type === STT_FUNC ? 'func' : type === STT_OBJECT ? 'object' : 'other',
      binding: bind === 0 ? 'local' : bind === 1 ? 'global' : bind === 2 ? 'weak' : bind,
    }
    symbols.push(symbol)
    if (!byName.has(name)) byName.set(name, symbol)
  }

  symbols.sort((a, b) => a.address - b.address || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const funcs = symbols.filter((symbol) => symbol.kind === 'func' && symbol.size > 0)

  // .text bounds are a cheap sanity check for callers ("is this PC in code?").
  let text = { startsAt: 0, size: 0 }
  for (let i = 0; i < shnum; i += 1) {
    const header = section(i)
    if (sectionName(header) === '.text') {
      text = { startsAt: header.addr, size: header.size }
      break
    }
  }

  return {
    path,
    machine: MACHINES[machine] ?? `unknown (0x${machine.toString(16)})`,
    symbols,
    byName,
    funcs,
    text,
  }
}

/**
 * Parse an ELF32 little-endian image's symbol table.
 *
 * Thumb function symbols keep the low bit set in `address` (the raw st_value,
 * unlike llvm-nm, which masks it), so a PC read from the core is one below the
 * symbol at an exact function entry. Zero-size functions (assembly labels) are
 * kept in `symbols` but are not part of `funcs`.
 *
 * @param {Buffer|Uint8Array} buffer raw file contents
 * @returns {ParsedElf}
 * @throws {Error} not an ELF file, unsupported class/endianness, or malformed input
 */
export function parseElfSymbols(buffer) {
  return parseElf(buffer, undefined)
}

/** Stat-keyed cache: resolved path -> { mtimeMs, size, parsed }. */
const cache = new Map()

/**
 * Load and parse an ELF file, reusing the cached parse while its mtime and size
 * are unchanged. The returned object is the same reference across cache hits.
 *
 * @param {string} filePath path to the ELF (relative paths are resolved)
 * @returns {Promise<ParsedElf>} parsed symbols with `path` set
 */
export async function loadSymbols(filePath) {
  const resolved = await fs.promises.realpath(filePath)
  const stat = await fs.promises.stat(resolved)
  const cached = cache.get(resolved)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed
  }

  const parsed = parseElf(await fs.promises.readFile(resolved), resolved)
  cache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
  return parsed
}

/**
 * Look up a symbol by name (defined, non-empty names only).
 *
 * @param {ParsedElf} parsed
 * @param {string} name
 * @returns {Symbol|undefined}
 */
export function findSymbol(parsed, name) {
  return parsed.byName.get(name)
}

/**
 * Find the function containing an address: the greatest funcs[] entry with
 * `address <= addr`, accepted only when `addr` is inside
 * `[address, address + size)`. A zero-size symbol matches only its exact start.
 *
 * @param {ParsedElf} parsed
 * @param {number} address
 * @returns {{symbol: Symbol, offset: number}|undefined}
 */
export function nearestSymbol(parsed, address) {
  // Comparing against a symbol whose st_value still carries the Thumb bit would
  // shift every offset by one and hide the first byte of each function, so the
  // comparison happens on the instruction addresses both sides really mean.
  const target = address & ~1
  const funcs = parsed.funcs
  let low = 0
  let high = funcs.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((funcs[mid].address & ~1) <= target) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (found < 0) return undefined

  const symbol = funcs[found]
  const offset = target - (symbol.address & ~1)
  const inside = symbol.size > 0 ? offset < symbol.size : offset === 0
  if (!inside) return undefined
  return { symbol, offset }
}
