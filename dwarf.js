/**
 * DWARF (.debug_info) reader for the DSH mcu_debug plugin.
 *
 * The symbol table answers "where is this variable" but says nothing about the
 * bytes living there. This module reads the debug info a firmware ELF already
 * carries, so `read_memory(symbol: ...)` can name struct fields and `type` can
 * print a C layout instead of a wall of hex.
 *
 * Scope: ELF32 little-endian (every Cortex-M image), DWARF 2-5, one linked
 * image (no .dwo/.dwp split debug). Only the parts needed for C data types are
 * decoded: type DIEs, globals with a static DW_OP_addr/DW_OP_addrx location and
 * their members. Local variables need location lists and frame bases, so they
 * are deliberately out of scope.
 *
 * The parser is bounds-checked at every read. A corrupt or truncated ELF must
 * never make the debugger invent field offsets; a bad CU is skipped with a
 * warning instead of taking the whole image down.
 */
import * as fs from 'node:fs'

const MALFORMED = 'truncated or malformed DWARF'

// DWARF tags (chapter 7.5).
const TAG = {
  arrayType: 0x01,
  classType: 0x02,
  enumerationType: 0x04,
  formalParameter: 0x05,
  lexicalBlock: 0x0b,
  member: 0x0d,
  pointerType: 0x0f,
  referenceType: 0x10,
  compileUnit: 0x11,
  structureType: 0x13,
  subroutineType: 0x15,
  typedef: 0x16,
  unionType: 0x17,
  unspecifiedParameters: 0x18,
  inheritance: 0x1c,
  ptrToMemberType: 0x1f,
  subrangeType: 0x21,
  baseType: 0x24,
  constType: 0x26,
  enumerator: 0x28,
  packedType: 0x2d,
  subprogram: 0x2e,
  variable: 0x34,
  volatileType: 0x35,
  restrictType: 0x37,
  unspecifiedType: 0x3b,
  rvalueReferenceType: 0x42,
  atomicType: 0x47,
}

// DWARF attributes (chapter 7.5.4).
const AT = {
  location: 0x02,
  name: 0x03,
  byteSize: 0x0b,
  bitOffset: 0x0c,
  bitSize: 0x0d,
  constValue: 0x1c,
  lowerBound: 0x22,
  upperBound: 0x2f,
  abstractOrigin: 0x31,
  count: 0x37,
  dataMemberLocation: 0x38,
  declFile: 0x3a,
  declLine: 0x3b,
  declaration: 0x3c,
  encoding: 0x3e,
  external: 0x3f,
  specification: 0x47,
  type: 0x49,
  dataBitOffset: 0x6b,
  strOffsetsBase: 0x72,
  addrBase: 0x73,
}

// DWARF forms (chapter 7.5.6).
const FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  refAddr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  refUdata: 0x15,
  indirect: 0x16,
  secOffset: 0x17,
  exprloc: 0x18,
  flagPresent: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  data16: 0x1e,
  lineStrp: 0x1f,
  refSig8: 0x20,
  implicitConst: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  strx1: 0x25,
  strx2: 0x26,
  strx3: 0x27,
  strx4: 0x28,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
}

// DWARF base type encodings (chapter 7.8).
const ATE = {
  address: 0x01,
  boolean: 0x02,
  complexFloat: 0x03,
  float: 0x04,
  signed: 0x05,
  signedChar: 0x06,
  unsigned: 0x07,
  unsignedChar: 0x08,
  imaginaryFloat: 0x09,
  packedDecimal: 0x0a,
  numericString: 0x0b,
  edited: 0x0c,
  signedFixed: 0x0d,
  unsignedFixed: 0x0e,
  decimalFloat: 0x0f,
  utf: 0x10,
  ucs: 0x11,
  ascii: 0x12,
}

const OP = {
  addr: 0x03,
  constu: 0x10,
  plusUconst: 0x23,
  addrx: 0xa1,
}

const SHN_XINDEX = 0xffff
const MACHINES = {
  2: 'SPARC', 3: 'x86', 8: 'MIPS', 20: 'PowerPC', 21: 'PowerPC64',
  40: 'ARM', 42: 'SuperH', 43: 'SPARCv9', 50: 'IA-64', 62: 'x86-64',
  83: 'AVR', 94: 'Xtensa', 105: 'MSP430', 183: 'AArch64', 243: 'RISC-V',
}

const textDecoder = new TextDecoder()

/** Bounds-checked little-endian cursor over a Uint8Array. */
class Cursor {
  constructor(bytes, position = 0) {
    this.bytes = bytes
    this.position = position
  }

  need(count) {
    if (count < 0 || this.position + count > this.bytes.length) {
      throw new Error(`${MALFORMED}: need ${count} bytes at 0x${this.position.toString(16)}`)
    }
  }

  u8() {
    this.need(1)
    return this.bytes[this.position++]
  }

  u16() {
    this.need(2)
    const value = this.bytes[this.position] | (this.bytes[this.position + 1] << 8)
    this.position += 2
    return value
  }

  u24() {
    this.need(3)
    const value = this.bytes[this.position]
      | (this.bytes[this.position + 1] << 8)
      | (this.bytes[this.position + 2] << 16)
    this.position += 3
    return value
  }

  u32() {
    this.need(4)
    const value = (this.bytes[this.position]
      | (this.bytes[this.position + 1] << 8)
      | (this.bytes[this.position + 2] << 16)
      | (this.bytes[this.position + 3] << 24)) >>> 0
    this.position += 4
    return value
  }

  u64() {
    const low = this.u32()
    const high = this.u32()
    return high * 0x100000000 + low
  }

  /** Unsigned LEB128. */
  uleb() {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = this.u8()
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
      // A 64-bit ULEB128 is legal (DW_AT_const_value often carries one), so the
      // limit is 10 bytes, not the 7 that fit a JS safe integer.
      if (shift > 63) throw new Error(`${MALFORMED}: over-long ULEB128 at 0x${this.position.toString(16)}`)
    }
  }

  /** Signed LEB128. */
  sleb() {
    let value = 0
    let shift = 0
    let byte
    do {
      byte = this.u8()
      value += (byte & 0x7f) * 2 ** shift
      shift += 7
      if (shift > 63) throw new Error(`${MALFORMED}: over-long SLEB128 at 0x${this.position.toString(16)}`)
    } while ((byte & 0x80) !== 0)
    if ((byte & 0x40) !== 0) value -= 2 ** shift
    return value
  }

  cstring() {
    const start = this.position
    let end = start
    while (end < this.bytes.length && this.bytes[end] !== 0) end += 1
    if (end >= this.bytes.length) {
      throw new Error(`${MALFORMED}: unterminated string at 0x${start.toString(16)}`)
    }
    this.position = end + 1
    return textDecoder.decode(this.bytes.subarray(start, end))
  }

  slice(count) {
    this.need(count)
    const value = this.bytes.subarray(this.position, this.position + count)
    this.position += count
    return value
  }
}

function readCStringAt(bytes, offset) {
  if (!(bytes instanceof Uint8Array) || offset < 0 || offset >= bytes.length) {
    throw new Error(`${MALFORMED}: string offset 0x${offset.toString(16)} is outside its section`)
  }
  let end = offset
  while (end < bytes.length && bytes[end] !== 0) end += 1
  if (end >= bytes.length) throw new Error(`${MALFORMED}: unterminated string at 0x${offset.toString(16)}`)
  return textDecoder.decode(bytes.subarray(offset, end))
}

/**
 * Read the ELF section table. Kept separate from elf.js because that module is
 * a tightly scoped symbol-table parser; this one also needs to hand out section
 * byte ranges.
 */
function readElfSections(input, path) {
  if (!(input instanceof Uint8Array)) throw new TypeError('expected a Buffer or Uint8Array')
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  const label = path ?? '<buffer>'
  if (
    bytes.length < 52
    || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46
  ) {
    throw new Error(`not an ELF file: ${label}`)
  }
  if (bytes[4] !== 1) throw new Error(`unsupported ELF class in ${label} (only ELF32 is supported)`)
  if (bytes[5] !== 1) throw new Error(`unsupported ELF endianness in ${label} (only little-endian is supported)`)

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const machine = dv.getUint16(18, true)
  const shoff = dv.getUint32(32, true)
  const shentsize = dv.getUint16(46, true)
  let shnum = dv.getUint16(48, true)
  let shstrndx = dv.getUint16(50, true)
  if (shoff === 0 || shentsize < 40) throw new Error(`${MALFORMED}: no section table`)

  if (shnum === 0) shnum = dv.getUint32(shoff + 20, true)
  if (shstrndx === SHN_XINDEX) shstrndx = dv.getUint32(shoff + 24, true)
  if (shnum === 0 || shoff + shnum * shentsize > bytes.length) {
    throw new Error(`${MALFORMED}: section table is outside the file`)
  }

  const header = (index) => {
    if (index < 0 || index >= shnum) throw new Error(`${MALFORMED}: section index ${index}`)
    const at = shoff + index * shentsize
    return {
      nameOffset: dv.getUint32(at, true),
      type: dv.getUint32(at + 4, true),
      addr: dv.getUint32(at + 12, true),
      offset: dv.getUint32(at + 16, true),
      size: dv.getUint32(at + 20, true),
      link: dv.getUint32(at + 24, true),
    }
  }

  let shstr = null
  if (shstrndx !== 0) {
    shstr = header(shstrndx)
    if (shstr.offset + shstr.size > bytes.length) throw new Error(`${MALFORMED}: section name table`)
  }

  const sections = new Map()
  for (let index = 0; index < shnum; index += 1) {
    const entry = header(index)
    if (entry.offset + entry.size > bytes.length) {
      throw new Error(`${MALFORMED}: section ${index} is outside the file`)
    }
    if (shstr === null) continue
    const name = readCStringAt(bytes, shstr.offset + entry.nameOffset)
    if (name === '') continue
    sections.set(name, {
      name,
      type: entry.type,
      address: entry.addr,
      offset: entry.offset,
      size: entry.size,
      link: entry.link,
      bytes: bytes.subarray(entry.offset, entry.offset + entry.size),
    })
  }

  return { path, machine: MACHINES[machine] ?? `unknown (0x${machine.toString(16)})`, sections }
}

function sectionOf(elf, name, required) {
  const section = elf.sections.get(name)
  if (section !== undefined) return section.bytes
  if (required) throw new Error(`ELF has no ${name} section (was the image built with -g?)`)
  return undefined
}

function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value) {
  return typeof value === 'string' ? value : undefined
}

function hex(value, width = 8) {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`
}

/**
 * Parse a firmware image's DWARF into a queryable type table.
 *
 * The returned object is intentionally small: `typeByName`, `variable`,
 * `describeType`, `sizeOf`, `typeLabel`, `decode` and `decodeVariable` are the
 * only surface the tool layer needs.
 */
export class DwarfInfo {
  constructor({ path, machine, info, abbrev, strings, lineStrings, strOffsets, addresses }) {
    this.path = path
    this.machine = machine
    this.infoBytes = info
    this.abbrevBytes = abbrev
    this.stringBytes = strings
    this.lineStringBytes = lineStrings
    this.strOffsetsBytes = strOffsets
    this.addrBytes = addresses

    this.units = []
    this.dies = new Map()
    this.typesByName = new Map()
    this.variablesByName = new Map()
    this.version = 0
    this.warnings = []

    this.abbrevCache = new Map()
    this.sizeCache = new Map()
    this.sizing = new Set()

    this.strOffsetsView = strOffsets === undefined ? undefined
      : new DataView(strOffsets.buffer, strOffsets.byteOffset, strOffsets.byteLength)
    this.addrView = addresses === undefined ? undefined
      : new DataView(addresses.buffer, addresses.byteOffset, addresses.byteLength)
  }

  parse() {
    const cursor = new Cursor(this.infoBytes)
    while (cursor.position < this.infoBytes.length) {
      const start = cursor.position
      if (cursor.bytes.length - start < 4) break
      const length = cursor.u32()
      if (length === 0) break // padding between units
      if (length === 0xffffffff) throw new Error('DWARF64 is not supported (ELF32 only)')
      const end = cursor.position + length
      if (end > this.infoBytes.length) {
        throw new Error(`${MALFORMED}: unit at 0x${start.toString(16)} extends past .debug_info`)
      }
      try {
        this.parseUnit(cursor, start, end)
      } catch (error) {
        this.warnings.push(`unit at 0x${start.toString(16)}: ${error.message}`)
        // Drop whichever DIEs the failed unit managed to register.
        for (const offset of [...this.dies.keys()]) {
          if (offset >= start && offset < end) this.dies.delete(offset)
        }
      }
      cursor.position = end
    }

    if (this.units.length === 0) {
      throw new Error(this.warnings[0] ?? 'ELF has DWARF sections but no readable compilation units')
    }
    this.buildIndex()
  }

  parseUnit(cursor, start, end) {
    const version = cursor.u16()
    if (version < 2 || version > 5) throw new Error(`unsupported DWARF version ${version}`)
    const cu = {
      start,
      end,
      version,
      unitType: 0x01,
      addrSize: 4,
      abbrevOffset: 0,
      strOffsetsBase: 8,
      addrBase: 8,
      children: [],
      name: '',
    }

    if (version >= 5) {
      cu.unitType = cursor.u8()
      cu.addrSize = cursor.u8()
      cu.abbrevOffset = cursor.u32()
      if (cu.unitType === 0x02 || cu.unitType === 0x06) {
        cursor.u64() // type signature
        cursor.u32() // type offset
      } else if (cu.unitType === 0x04 || cu.unitType === 0x05) {
        cursor.u64() // dwo id
      }
    } else {
      cu.abbrevOffset = cursor.u32()
      cu.addrSize = cursor.u8()
    }

    const abbrevs = this.abbrevTable(cu.abbrevOffset)
    const stack = []
    while (cursor.position < end) {
      const offset = cursor.position
      const code = cursor.uleb()
      if (code === 0) {
        if (stack.length > 0) stack.pop()
        else break
        continue
      }
      const abbrev = abbrevs.get(code)
      if (abbrev === undefined) {
        throw new Error(`unknown abbreviation code ${code} at 0x${offset.toString(16)}`)
      }

      const attrs = {}
      for (const spec of abbrev.attributes) {
        const value = this.readForm(cursor, spec.form, cu, spec.implicitConst)
        attrs[spec.name] = value
        if (spec.name === AT.strOffsetsBase && typeof value === 'number') cu.strOffsetsBase = value
        if (spec.name === AT.addrBase && typeof value === 'number') cu.addrBase = value
      }

      const die = {
        offset,
        tag: abbrev.tag,
        attrs,
        children: [],
        parent: stack.length === 0 ? null : stack[stack.length - 1],
        cu,
      }
      this.dies.set(offset, die)
      if (die.parent === null) cu.children.push(die)
      else die.parent.children.push(die)
      if (abbrev.hasChildren) stack.push(die)
    }

    if (cu.children.length > 0) cu.name = stringOf(cu.children[0].attrs[AT.name]) ?? ''
    this.units.push(cu)
    this.version = Math.max(this.version, version)
  }

  abbrevTable(offset) {
    const cached = this.abbrevCache.get(offset)
    if (cached !== undefined) return cached
    if (offset >= this.abbrevBytes.length) throw new Error(`${MALFORMED}: abbreviation offset 0x${offset.toString(16)}`)

    const cursor = new Cursor(this.abbrevBytes, offset)
    const table = new Map()
    for (;;) {
      const code = cursor.uleb()
      if (code === 0) break
      const tag = cursor.uleb()
      const hasChildren = cursor.u8() !== 0
      const attributes = []
      for (;;) {
        const name = cursor.uleb()
        const form = cursor.uleb()
        if (name === 0 && form === 0) break
        let implicitConst
        if (form === FORM.implicitConst) implicitConst = cursor.sleb()
        attributes.push({ name, form, implicitConst })
      }
      table.set(code, { tag, hasChildren, attributes })
    }
    this.abbrevCache.set(offset, table)
    return table
  }

  readForm(cursor, form, cu, implicitConst) {
    switch (form) {
      case FORM.addr: return cu.addrSize === 8 ? cursor.u64() : cursor.u32()
      case FORM.block2: return cursor.slice(cursor.u16())
      case FORM.block4: return cursor.slice(cursor.u32())
      case FORM.data2: return cursor.u16()
      case FORM.data4: return cursor.u32()
      case FORM.data8: return cursor.u64()
      case FORM.string: return cursor.cstring()
      case FORM.block: return cursor.slice(cursor.uleb())
      case FORM.block1: return cursor.slice(cursor.u8())
      case FORM.data1: return cursor.u8()
      case FORM.flag: return cursor.u8() !== 0
      case FORM.sdata: return cursor.sleb()
      case FORM.strp: return this.stringAt(this.stringBytes, cursor.u32())
      case FORM.udata: return cursor.uleb()
      case FORM.refAddr: return cursor.u32()
      case FORM.ref1: return cu.start + cursor.u8()
      case FORM.ref2: return cu.start + cursor.u16()
      case FORM.ref4: return cu.start + cursor.u32()
      case FORM.ref8: return cu.start + cursor.u64()
      case FORM.refUdata: return cu.start + cursor.uleb()
      case FORM.indirect: return this.readForm(cursor, cursor.uleb(), cu, implicitConst)
      case FORM.secOffset: return cursor.u32()
      case FORM.exprloc: return cursor.slice(cursor.uleb())
      case FORM.flagPresent: return true
      case FORM.strx: return this.stringFromStrOffsets(cu, cursor.uleb())
      case FORM.addrx: return this.addressFromAddr(cu, cursor.uleb())
      case FORM.data16: return cursor.slice(16)
      case FORM.lineStrp: return this.stringAt(this.lineStringBytes, cursor.u32())
      case FORM.refSig8: return cursor.u64()
      case FORM.implicitConst: return implicitConst
      case FORM.loclistx: return cursor.uleb()
      case FORM.rnglistx: return cursor.uleb()
      case FORM.strx1: return this.stringFromStrOffsets(cu, cursor.u8())
      case FORM.strx2: return this.stringFromStrOffsets(cu, cursor.u16())
      case FORM.strx3: return this.stringFromStrOffsets(cu, cursor.u24())
      case FORM.strx4: return this.stringFromStrOffsets(cu, cursor.u32())
      case FORM.addrx1: return this.addressFromAddr(cu, cursor.u8())
      case FORM.addrx2: return this.addressFromAddr(cu, cursor.u16())
      case FORM.addrx3: return this.addressFromAddr(cu, cursor.u24())
      case FORM.addrx4: return this.addressFromAddr(cu, cursor.u32())
      default:
        throw new Error(`unsupported DWARF form 0x${form.toString(16)}`)
    }
  }

  stringAt(section, offset) {
    if (section === undefined) throw new Error('DWARF needs .debug_str but the ELF has none')
    return readCStringAt(section, offset)
  }

  stringFromStrOffsets(cu, index) {
    if (this.strOffsetsView === undefined) {
      throw new Error('DWARF uses DW_FORM_strx but the ELF has no .debug_str_offsets')
    }
    const at = cu.strOffsetsBase + index * 4
    if (at + 4 > this.strOffsetsView.byteLength) {
      throw new Error(`${MALFORMED}: string index ${index} is outside .debug_str_offsets`)
    }
    return this.stringAt(this.stringBytes, this.strOffsetsView.getUint32(at, true))
  }

  addressFromAddr(cu, index) {
    if (this.addrView === undefined) {
      throw new Error('DWARF uses DW_FORM_addrx but the ELF has no .debug_addr')
    }
    const at = cu.addrBase + index * cu.addrSize
    if (at + cu.addrSize > this.addrView.byteLength) {
      throw new Error(`${MALFORMED}: address index ${index} is outside .debug_addr`)
    }
    return cu.addrSize === 8
      ? Number(this.addrView.getBigUint64(at, true))
      : this.addrView.getUint32(at, true)
  }

  buildIndex() {
    const add = (map, key, value) => {
      const list = map.get(key)
      if (list === undefined) map.set(key, [value])
      else list.push(value)
    }

    for (const die of this.dies.values()) {
      const name = stringOf(die.attrs[AT.name])
      switch (die.tag) {
        case TAG.typedef:
        case TAG.structureType:
        case TAG.unionType:
        case TAG.classType:
        case TAG.enumerationType:
        case TAG.baseType:
        case TAG.subroutineType:
          if (name !== undefined) add(this.typesByName, name, die)
          break
        case TAG.variable: {
          if (die.attrs[AT.declaration] === true && die.attrs[AT.location] === undefined) break
          const info = this.variableInfo(die)
          if (info === undefined) break
          add(this.variablesByName, info.name, info)
          break
        }
        default:
          break
      }
    }
  }

  /** Resolve a variable DIE through DW_AT_specification when the definition omits name/type. */
  variableInfo(die) {
    let source = die
    let name
    let typeRef
    let declaration = false
    const seen = new Set()
    for (let depth = 0; depth < 8; depth += 1) {
      name ??= stringOf(source.attrs[AT.name])
      typeRef ??= numberOf(source.attrs[AT.type])
      if (source.attrs[AT.declaration] === true) declaration = true
      const next = numberOf(source.attrs[AT.specification])
        ?? numberOf(source.attrs[AT.abstractOrigin])
      if (next === undefined || seen.has(next)) break
      seen.add(next)
      const parent = this.dies.get(next)
      if (parent === undefined) break
      source = parent
    }
    if (name === undefined || typeRef === undefined) return undefined
    if (declaration && die.attrs[AT.location] === undefined) return undefined
    const type = this.dies.get(typeRef)
    if (type === undefined) return undefined
    return {
      name,
      die,
      type,
      address: this.locationAddress(die.cu, die.attrs[AT.location]),
    }
  }

  /** Decode a global's constant location expression: DW_OP_addr / DW_OP_addrx only. */
  locationAddress(cu, location) {
    if (!(location instanceof Uint8Array) || location.length === 0) return undefined
    const cursor = new Cursor(location)
    const op = cursor.u8()
    if (op === OP.addr) return cu.addrSize === 8 ? cursor.u64() : cursor.u32()
    if (op === OP.addrx) return this.addressFromAddr(cu, cursor.uleb())
    return undefined
  }

  /** First DIE for a type name, preferring a complete typedef/definition. */
  typeByName(name) {
    const cleaned = name.trim().replace(/^(struct|union|enum|class)\s+/, '')
    let candidates = this.typesByName.get(cleaned) ?? []
    if (candidates.length === 0) {
      for (const [key, list] of this.typesByName) {
        if (key.toLowerCase() === cleaned.toLowerCase()) {
          candidates = list
          break
        }
      }
    }
    if (candidates.length === 0) return undefined
    return this.pickType(candidates)
  }

  pickType(candidates) {
    const complete = (die) => die.attrs[AT.declaration] !== true
      && (numberOf(die.attrs[AT.byteSize]) !== undefined || die.children.length > 0)
    const resolved = (die) => complete(die)
      || (die.tag === TAG.typedef && complete(this.typeRef(die)))
    return candidates.find((die) => die.tag === TAG.typedef && resolved(die))
      ?? candidates.find((die) => complete(die))
      ?? candidates[0]
  }

  /** Find a global variable (definition with a static address) by name. */
  variable(name, address) {
    const list = this.variablesByName.get(name)
    if (list === undefined || list.length === 0) return undefined
    if (address !== undefined) {
      const exact = list.find((entry) => entry.address === address)
      if (exact !== undefined) return exact
    }
    return list.find((entry) => entry.address !== undefined) ?? list[0]
  }

  variableFor(symbol) {
    return this.variable(symbol.name, symbol.address & ~1)
  }

  typeForSymbol(symbol) {
    const entry = this.variableFor(symbol)
    if (entry === undefined) return undefined
    return {
      variable: entry,
      type: entry.type,
      name: this.typeLabel(entry.type),
      size: this.sizeOf(entry.type),
    }
  }

  typeRef(die, attribute = AT.type) {
    if (die === undefined) return undefined
    const offset = numberOf(die.attrs[attribute])
    if (offset === undefined) return undefined
    return this.dies.get(offset)
  }

  /** Strip typedefs and qualifiers to the DIE that owns the layout. */
  coreType(die) {
    let current = die
    const seen = new Set()
    while (current !== undefined && !seen.has(current.offset)) {
      seen.add(current.offset)
      if (
        current.tag !== TAG.typedef
        && current.tag !== TAG.constType
        && current.tag !== TAG.volatileType
        && current.tag !== TAG.restrictType
        && current.tag !== TAG.atomicType
        && current.tag !== TAG.packedType
      ) {
        return current
      }
      current = this.typeRef(current)
    }
    return current
  }

  arrayShape(die) {
    const dimensions = []
    let count = 1
    const subranges = die.children.filter((child) => child.tag === TAG.subrangeType)
    if (subranges.length === 0) return { dimensions: [undefined], count: undefined }
    for (const subrange of subranges) {
      const declared = numberOf(subrange.attrs[AT.count])
      const upper = numberOf(subrange.attrs[AT.upperBound])
      const lower = numberOf(subrange.attrs[AT.lowerBound]) ?? 0
      let length = declared
      if (length === undefined && upper !== undefined) length = upper - lower + 1
      dimensions.push(length)
      if (length === undefined) count = undefined
      else if (count !== undefined) count *= length
    }
    return { dimensions, count }
  }

  sizeOf(die) {
    if (die === undefined) return undefined
    const cached = this.sizeCache.get(die.offset)
    if (cached !== undefined) return cached
    if (this.sizing.has(die.offset)) return undefined
    this.sizing.add(die.offset)
    let size = numberOf(die.attrs[AT.byteSize])
    if (size === undefined) {
      switch (die.tag) {
        case TAG.typedef:
        case TAG.constType:
        case TAG.volatileType:
        case TAG.restrictType:
        case TAG.atomicType:
        case TAG.packedType:
          size = this.sizeOf(this.typeRef(die))
          break
        case TAG.pointerType:
        case TAG.referenceType:
        case TAG.rvalueReferenceType:
        case TAG.ptrToMemberType:
          size = die.cu.addrSize
          break
        case TAG.arrayType: {
          const element = this.sizeOf(this.typeRef(die))
          const { count } = this.arrayShape(die)
          if (element !== undefined && count !== undefined) size = element * count
          break
        }
        case TAG.enumerationType:
          size = this.sizeOf(this.typeRef(die)) ?? 4
          break
        case TAG.subroutineType:
          size = die.cu.addrSize
          break
        case TAG.unspecifiedType:
          size = undefined
          break
        default:
          break
      }
    }
    this.sizing.delete(die.offset)
    if (size !== undefined) this.sizeCache.set(die.offset, size)
    return size
  }

  /** Human-readable C-ish type name. Never expands struct bodies. */
  typeLabel(die, guard = new Set()) {
    if (die === undefined) return 'void'
    if (guard.has(die.offset)) return '...'
    guard.add(die.offset)
    try {
      const name = stringOf(die.attrs[AT.name])
      switch (die.tag) {
        case TAG.typedef:
          return name ?? this.typeLabel(this.typeRef(die), guard)
        case TAG.baseType:
          return name ?? 'unknown'
        case TAG.structureType:
        case TAG.classType:
          return name === undefined ? 'struct <anonymous>' : `struct ${name}`
        case TAG.unionType:
          return name === undefined ? 'union <anonymous>' : `union ${name}`
        case TAG.enumerationType:
          return name === undefined ? 'enum <anonymous>' : `enum ${name}`
        case TAG.pointerType: {
          const target = this.typeRef(die)
          if (target !== undefined && this.coreType(target)?.tag === TAG.subroutineType) {
            return this.callableLabel(target, guard)
          }
          return `${this.typeLabel(target, guard)} *`
        }
        case TAG.referenceType:
          return `${this.typeLabel(this.typeRef(die), guard)} &`
        case TAG.rvalueReferenceType:
          return `${this.typeLabel(this.typeRef(die), guard)} &&`
        case TAG.constType:
          return `const ${this.typeLabel(this.typeRef(die), guard)}`
        case TAG.volatileType:
          return `volatile ${this.typeLabel(this.typeRef(die), guard)}`
        case TAG.restrictType:
          return `restrict ${this.typeLabel(this.typeRef(die), guard)}`
        case TAG.atomicType:
          return `_Atomic(${this.typeLabel(this.typeRef(die), guard)})`
        case TAG.packedType:
          return this.typeLabel(this.typeRef(die), guard)
        case TAG.arrayType: {
          const element = this.typeLabel(this.typeRef(die), guard)
          const { dimensions } = this.arrayShape(die)
          const suffix = dimensions.map((length) => `[${length === undefined ? '' : length}]`).join('')
          return `${element}${suffix}`
        }
        case TAG.subroutineType:
          return this.callableLabel(die, guard)
        case TAG.unspecifiedType:
          return 'void'
        case TAG.ptrToMemberType:
          return `${this.typeLabel(this.typeRef(die), guard)} <member>`
        default:
          return name ?? `DWARF type 0x${die.tag.toString(16)}`
      }
    } finally {
      guard.delete(die.offset)
    }
  }

  callableLabel(die, guard = new Set()) {
    const returns = this.typeLabel(this.typeRef(die), guard)
    const parameters = die.children
      .filter((child) => child.tag === TAG.formalParameter)
      .map((child) => this.typeLabel(this.typeRef(child), guard))
    if (die.children.some((child) => child.tag === TAG.unspecifiedParameters)) parameters.push('...')
    return `${returns} (*)(${parameters.join(', ')})`
  }

  memberOffset(member) {
    const raw = member.attrs[AT.dataMemberLocation]
    if (typeof raw === 'number') return raw
    if (raw instanceof Uint8Array && raw.length > 0) {
      const cursor = new Cursor(raw)
      const op = cursor.u8()
      if (op === OP.plusUconst || op === OP.constu) return cursor.uleb()
    }
    return 0
  }

  enumValues(die) {
    return die.children
      .filter((child) => child.tag === TAG.enumerator)
      .map((child) => ({
        name: stringOf(child.attrs[AT.name]) ?? '<anonymous>',
        value: numberOf(child.attrs[AT.constValue]) ?? 0,
      }))
  }

  encodingName(die) {
    const encoding = numberOf(die.attrs[AT.encoding])
    switch (encoding) {
      case ATE.address: return 'address'
      case ATE.boolean: return 'bool'
      case ATE.complexFloat: return 'complex'
      case ATE.float: return 'float'
      case ATE.signed: return 'signed'
      case ATE.signedChar: return 'signed char'
      case ATE.unsigned: return 'unsigned'
      case ATE.unsignedChar: return 'unsigned char'
      case ATE.packedDecimal: return 'packed decimal'
      case ATE.numericString: return 'numeric string'
      case ATE.signedFixed: return 'signed fixed'
      case ATE.unsignedFixed: return 'unsigned fixed'
      case ATE.decimalFloat: return 'decimal float'
      case ATE.utf: return 'UTF'
      case ATE.ucs: return 'UCS'
      case ATE.ascii: return 'ASCII'
      default: return undefined
    }
  }

  /**
   * Expand one type into a JSON-safe layout tree.
   *
   * depth 1 prints the top level only; depth 2 also expands nested structs,
   * unions and array elements by one level. Bodies are bounded by maxNodes so a
   * pathological type cannot flood a tool result.
   */
  describeType(die, { depth = 2, maxNodes = 600 } = {}) {
    const budget = { remaining: maxNodes, truncated: false }
    const node = this.typeNode(die, Math.max(1, Math.min(depth, 6)), budget)
    if (budget.truncated) node.truncated = true
    return node
  }

  typeNode(die, depth, budget) {
    if (die === undefined) return { kind: 'void', name: 'void' }
    if (budget.remaining <= 0) {
      budget.truncated = true
      return { kind: this.kindName(die), name: this.typeLabel(die) }
    }
    budget.remaining -= 1

    const core = this.coreType(die)
    if (core === undefined) return { kind: 'unknown', name: this.typeLabel(die) }
    const name = this.typeLabel(die)
    const size = this.sizeOf(die)
    const base = () => {
      const node = { kind: this.kindName(die), name }
      if (size !== undefined) node.size = size
      return node
    }

    switch (core.tag) {
      case TAG.baseType: {
        const node = base()
        const encoding = this.encodingName(core)
        if (encoding !== undefined) node.encoding = encoding
        return node
      }
      case TAG.structureType:
      case TAG.classType:
      case TAG.unionType: {
        const node = base()
        node.kind = core.tag === TAG.unionType ? 'union' : 'struct'
        if (depth > 0) {
          node.members = core.children
            .filter((child) => child.tag === TAG.member)
            .map((member) => this.memberNode(member, depth, budget))
        }
        return node
      }
      case TAG.enumerationType: {
        const node = base()
        node.kind = 'enum'
        node.values = this.enumValues(core)
        const underlying = this.typeLabel(this.typeRef(core))
        if (underlying !== 'void') node.underlying = underlying
        return node
      }
      case TAG.pointerType:
      case TAG.referenceType:
      case TAG.rvalueReferenceType:
      case TAG.ptrToMemberType: {
        const node = base()
        node.kind = 'pointer'
        node.target = this.typeLabel(this.typeRef(core))
        return node
      }
      case TAG.arrayType: {
        const node = base()
        node.kind = 'array'
        const { dimensions, count } = this.arrayShape(core)
        node.dimensions = dimensions
        if (count !== undefined) node.count = count
        node.element = this.typeLabel(this.typeRef(core))
        if (depth > 1) node.elementType = this.typeNode(this.typeRef(core), depth - 1, budget)
        return node
      }
      case TAG.subroutineType: {
        const node = base()
        node.kind = 'function'
        node.returns = this.typeLabel(this.typeRef(core))
        node.parameters = core.children
          .filter((child) => child.tag === TAG.formalParameter)
          .map((child) => {
            const parameter = { type: this.typeLabel(this.typeRef(child)) }
            const parameterName = stringOf(child.attrs[AT.name])
            if (parameterName !== undefined) parameter.name = parameterName
            return parameter
          })
        return node
      }
      default:
        return base()
    }
  }

  memberNode(member, depth, budget) {
    const type = this.typeRef(member)
    const node = {
      name: stringOf(member.attrs[AT.name]) ?? '<anonymous>',
      offset: this.memberOffset(member),
    }
    if (type !== undefined) {
      node.type = this.typeLabel(type)
      const size = this.sizeOf(type)
      if (size !== undefined) node.size = size
    }
    const bitSize = numberOf(member.attrs[AT.bitSize])
    if (bitSize !== undefined) {
      node.bitSize = bitSize
      const bitOffset = numberOf(member.attrs[AT.dataBitOffset])
      if (bitOffset !== undefined) node.bitOffset = bitOffset
    }
    if (depth > 1 && type !== undefined) {
      const core = this.coreType(type)
      if (core !== undefined && (
        core.tag === TAG.structureType
        || core.tag === TAG.unionType
        || core.tag === TAG.classType
        || core.tag === TAG.enumerationType
      )) {
        node.detail = this.typeNode(type, depth - 1, budget)
      }
    }
    return node
  }

  kindName(die) {
    switch (die.tag) {
      case TAG.structureType:
      case TAG.classType: return 'struct'
      case TAG.unionType: return 'union'
      case TAG.enumerationType: return 'enum'
      case TAG.baseType: return 'base'
      case TAG.pointerType:
      case TAG.referenceType:
      case TAG.rvalueReferenceType:
      case TAG.ptrToMemberType: return 'pointer'
      case TAG.arrayType: return 'array'
      case TAG.subroutineType: return 'function'
      case TAG.typedef: return 'typedef'
      case TAG.unspecifiedType: return 'void'
      default: return 'other'
    }
  }

  /**
   * Decode an object of `die` from `bytes`.
   *
   * Pointers are rendered as addresses, not chased: following them would need
   * target memory reads and is left to a separate call.
   */
  decode(die, bytes, { depth = 4, maxArray = 64 } = {}) {
    const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
    return this.decodeNode(die, view, 0, Math.max(1, Math.min(depth, 12)), maxArray, new Set())
  }

  decodeVariable(variable, bytes, options) {
    if (variable === undefined || variable.type === undefined) return undefined
    return {
      type: this.typeLabel(variable.type),
      size: this.sizeOf(variable.type),
      value: this.decode(variable.type, bytes, options),
    }
  }

  decodeNode(die, bytes, offset, depth, maxArray, active) {
    if (die === undefined) return null
    const core = this.coreType(die)
    if (core === undefined) return null
    if (active.has(core.offset)) return '<recursive>'
    if (core.tag === TAG.structureType || core.tag === TAG.classType || core.tag === TAG.unionType) {
      if (depth <= 0) return `<${this.typeLabel(die)}>`
      active.add(core.offset)
      try {
        const value = {}
        for (const member of core.children) {
          if (member.tag !== TAG.member) continue
          const type = this.typeRef(member)
          if (type === undefined) continue
          const name = stringOf(member.attrs[AT.name])
          const bitSize = numberOf(member.attrs[AT.bitSize])
          if (bitSize !== undefined) {
            const bitOffset = numberOf(member.attrs[AT.dataBitOffset])
            if (bitOffset !== undefined) {
              const field = this.readBits(bytes, offset * 8 + bitOffset, bitSize)
              if (name === undefined) value[`<anonymous@${bitOffset}>`] = field
              else value[name] = field
            }
            continue
          }
          const fieldOffset = offset + this.memberOffset(member)
          const field = this.decodeNode(type, bytes, fieldOffset, depth - 1, maxArray, active)
          if (name === undefined) {
            if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
              Object.assign(value, field)
            }
            continue
          }
          value[name] = field
        }
        return value
      } finally {
        active.delete(core.offset)
      }
    }

    switch (core.tag) {
      case TAG.baseType: return this.decodeBase(core, bytes, offset)
      case TAG.enumerationType: return this.decodeEnum(core, bytes, offset)
      case TAG.pointerType:
      case TAG.referenceType:
      case TAG.rvalueReferenceType:
      case TAG.ptrToMemberType: {
        if (offset + core.cu.addrSize > bytes.length) return '<out of range>'
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const address = core.cu.addrSize === 8
          ? Number(view.getBigUint64(offset, true))
          : view.getUint32(offset, true)
        return hex(address)
      }
      case TAG.arrayType:
        return this.decodeArray(core, bytes, offset, depth, maxArray, active)
      case TAG.subroutineType: {
        if (offset + core.cu.addrSize > bytes.length) return '<out of range>'
        return hex(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .getUint32(offset, true))
      }
      default:
        return `<${this.typeLabel(die)}>`
    }
  }

  decodeBase(die, bytes, offset) {
    const size = this.sizeOf(die) ?? 4
    if (offset + size > bytes.length) return '<out of range>'
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const encoding = numberOf(die.attrs[AT.encoding])
    const name = stringOf(die.attrs[AT.name]) ?? ''

    if (encoding === ATE.float || name === 'float' || name === 'double') {
      if (size === 4) return finiteFloat(view.getFloat32(offset, true))
      if (size === 8) return finiteFloat(view.getFloat64(offset, true))
      return hex(readUnsigned(bytes, offset, size), size * 2)
    }
    if (encoding === ATE.boolean || name === '_Bool' || name === 'bool') {
      return readUnsigned(bytes, offset, size) !== 0
    }
    if (encoding === ATE.address) {
      return hex(readUnsigned(bytes, offset, size), size * 2)
    }

    const signed = encoding === ATE.signed
      || encoding === ATE.signedChar
      || encoding === ATE.signedFixed
    return signed ? readSigned(bytes, offset, size) : readUnsigned(bytes, offset, size)
  }

  decodeEnum(die, bytes, offset) {
    const size = this.sizeOf(die) ?? 4
    if (offset + size > bytes.length) return '<out of range>'
    const values = this.enumValues(die)
    const signed = values.some((entry) => entry.value < 0)
    const value = signed ? readSigned(bytes, offset, size) : readUnsigned(bytes, offset, size)
    const match = values.find((entry) => entry.value === value)
    return match === undefined ? value : { value, name: match.name }
  }

  decodeArray(die, bytes, offset, depth, maxArray, active) {
    const element = this.typeRef(die)
    const elementSize = this.sizeOf(element)
    const { count } = this.arrayShape(die)
    if (element === undefined || elementSize === undefined || elementSize === 0 || count === undefined) {
      return []
    }
    const available = Math.max(0, Math.floor((bytes.length - offset) / elementSize))
    const total = Math.min(count, available)

    if (elementSize === 1 && total > 0) {
      const slice = bytes.subarray(offset, offset + total)
      const nul = slice.indexOf(0)
      const text = nul >= 0 ? slice.subarray(0, nul) : slice
      if (text.length > 0 && text.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
        return textDecoder.decode(text)
      }
    }

    const values = []
    const limit = Math.min(total, maxArray)
    for (let index = 0; index < limit; index += 1) {
      values.push(this.decodeNode(element, bytes, offset + index * elementSize, depth - 1, maxArray, active))
    }
    if (total > limit) values.push(`<${total - limit} more>`)
    return values
  }

  readBits(bytes, bitOffset, bitSize) {
    if (bitSize <= 0 || bitSize > 53) return undefined
    const firstByte = Math.floor(bitOffset / 8)
    const shift = bitOffset % 8
    const byteCount = Math.ceil((shift + bitSize) / 8)
    if (firstByte + byteCount > bytes.length) return '<out of range>'
    let raw = 0n
    for (let index = byteCount - 1; index >= 0; index -= 1) {
      raw = (raw << 8n) | BigInt(bytes[firstByte + index])
    }
    const mask = (1n << BigInt(bitSize)) - 1n
    return Number((raw >> BigInt(shift)) & mask)
  }

  summary() {
    return {
      version: this.version,
      units: this.units.length,
      types: this.typesByName.size,
      variables: this.variablesByName.size,
      warnings: this.warnings.slice(0, 3),
    }
  }
}

function finiteFloat(value) {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Inf'
  if (value === -Infinity) return '-Inf'
  return value
}

function readUnsigned(bytes, offset, size) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (size) {
    case 1: return view.getUint8(offset)
    case 2: return view.getUint16(offset, true)
    case 4: return view.getUint32(offset, true)
    case 8: {
      const value = view.getBigUint64(offset, true)
      return value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : `0x${value.toString(16).toUpperCase()}`
    }
    default: return 0
  }
}

function readSigned(bytes, offset, size) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (size) {
    case 1: return view.getInt8(offset)
    case 2: return view.getInt16(offset, true)
    case 4: return view.getInt32(offset, true)
    case 8: {
      const value = view.getBigInt64(offset, true)
      return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(value)
        : value.toString()
    }
    default: return 0
  }
}

/**
 * Parse DWARF out of an in-memory ELF image.
 * @param {Buffer|Uint8Array} input
 * @param {string|undefined} path only used in diagnostics
 * @returns {DwarfInfo}
 */
export function parseDebugInfo(input, path) {
  const elf = readElfSections(input, path)
  const info = sectionOf(elf, '.debug_info', true)
  const abbrev = sectionOf(elf, '.debug_abbrev', true)
  const dwarf = new DwarfInfo({
    path,
    machine: elf.machine,
    info,
    abbrev,
    strings: sectionOf(elf, '.debug_str', false),
    lineStrings: sectionOf(elf, '.debug_line_str', false),
    strOffsets: sectionOf(elf, '.debug_str_offsets', false),
    addresses: sectionOf(elf, '.debug_addr', false),
  })
  dwarf.parse()
  return dwarf
}

/** Stat-keyed cache: resolved path -> { mtimeMs, size, info }. */
const cache = new Map()

/**
 * Load and parse the DWARF of an ELF, reusing the cached parse while mtime and
 * size are unchanged. Throws a clear error for stripped images.
 *
 * @param {string} filePath
 * @returns {Promise<DwarfInfo>}
 */
export async function loadDebugInfo(filePath) {
  const resolved = await fs.promises.realpath(filePath)
  const stat = await fs.promises.stat(resolved)
  const cached = cache.get(resolved)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.info
  }

  const buffer = await fs.promises.readFile(resolved)
  const info = parseDebugInfo(buffer, resolved)
  cache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, info })
  return info
}
