/**
 * The J-Link device library, as the installed SEGGER software knows it.
 *
 * SEGGER does not ship the list as a plain file next to JLink.exe; the DLL
 * carries the database and J-Link Commander can export it:
 *
 *   ExpDevListXML <file>   every device and alias, with vendor and core
 *   ExpDevList    <file>   the base devices as CSV (fallback for older builds)
 *
 * The export costs about a second, so the parsed index is cached beside the
 * workspace state and rebuilt only when the J-Link installation changes.
 * Recent choices are kept separately, because they belong to this machine and
 * not to one workspace.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CACHE_FORMAT = 1
const CACHE_FILE = 'devices.json'
const HISTORY_FILE = 'history.json'
/** How many past choices the panel offers. */
const HISTORY_LIMIT = 12

/**
 * One Commander run that asks the DLL to write its device list to `fileName`
 * inside `cwd`.
 *
 * The path is deliberately relative. J-Link Commander does not strip quotes,
 * so an absolute path that contains a space (a user name with one, for
 * example) would silently fail; the working directory is passed to the
 * process instead, where quoting is the operating system's job.
 */
async function runExport(exe, command, cwd, fileName, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jlink-devices-'))
  const script = join(dir, 'export.jlink')
  try {
    await writeFile(script, `${command} ${fileName}\r\nExit\r\n`, 'ascii')
    return await new Promise((resolve, reject) => {
      const child = spawn(exe, ['-NoGui', '1', '-CommandFile', script], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let text = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`J-Link Commander timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve(text)
        else reject(error)
      }
      child.stdout.on('data', (chunk) => { text += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { text += chunk.toString('utf8') })
      child.on('error', (error) => finish(error))
      // J-Link Commander returns a non-zero code even on success, so the exit
      // code is not a verdict: the exported file is.
      child.on('close', () => finish())
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function attributes(text) {
  const out = {}
  const re = /([A-Za-z_][\w:.-]*)="([^"]*)"/g
  let match
  while ((match = re.exec(text)) !== null) out[match[1]] = match[2]
  return out
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, code) => {
    try {
      if (code[0] === '#') {
        const point = code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10)
        return String.fromCodePoint(point)
      }
      return ENTITIES[code] ?? whole
    } catch {
      return whole
    }
  })
}

/**
 * Parse the `ExpDevListXML` export.
 *
 * The document nests `<DeviceInfo>` (the base device, with its core) inside
 * `<VendorInfo>`, and lists selectable part numbers as `<AliasInfo>` children.
 * Both are names the commander accepts for `-device`, so both are entries.
 */
export function parseDeviceXml(text) {
  const entries = []
  const seen = new Set()
  let vendor = ''
  let device = ''
  let core = ''
  const re = /<(VendorInfo|DeviceInfo|AliasInfo)\b([^>]*?)\/?>/g
  let match
  while ((match = re.exec(text)) !== null) {
    const tag = match[1]
    const attrs = attributes(match[2])
    const name = decodeXml(attrs.Name ?? '').trim()
    if (tag === 'VendorInfo') {
      vendor = name
      device = ''
      core = ''
      continue
    }
    if (tag === 'DeviceInfo') {
      // The device is the context for its aliases even when an earlier vendor
      // already listed the same name.
      device = name
      core = decodeXml(attrs.Core ?? '').trim()
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      entries.push({ name, vendor, core, base: '' })
    } else if (name !== '' && device !== '' && !seen.has(name)) {
      seen.add(name)
      entries.push({ name, vendor, core, base: device })
    }
  }
  return entries
}

/** Parse the `ExpDevList` CSV export, the fallback for older commanders. */
export function parseDeviceCsv(text) {
  const entries = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/)
    if (match === null) continue
    const [, vendor, name, core] = match
    if (name === '' || name === 'Device' || seen.has(name)) continue
    seen.add(name)
    entries.push({ name, vendor, core, base: '' })
  }
  return entries
}

function jlinkVersion(text) {
  const match = String(text).match(/DLL version\s+(V[\w.]+)/i)
  return match === null ? '' : match[1]
}

/** Export and parse, preferring the XML (it also carries the aliases). */
async function exportDatabase(exe, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jlink-export-'))
  const xmlFile = join(dir, 'devices.xml')
  const csvFile = join(dir, 'devices.csv')
  try {
    let output = ''
    try {
      output = await runExport(exe, 'ExpDevListXML', dir, 'devices.xml', timeoutMs)
      if (existsSync(xmlFile)) {
        const entries = parseDeviceXml(await readFile(xmlFile, 'utf8'))
        if (entries.length > 0) return { entries, version: jlinkVersion(output) }
      }
    } catch {
      // Older commanders may not know ExpDevListXML; the CSV export is next.
    }
    output = await runExport(exe, 'ExpDevList', dir, 'devices.csv', timeoutMs)
    if (!existsSync(csvFile)) throw new Error('J-Link Commander did not write a device list')
    const entries = parseDeviceCsv(await readFile(csvFile, 'utf8'))
    if (entries.length === 0) throw new Error('the J-Link device list is empty')
    return { entries, version: jlinkVersion(output) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function hydrate(entries) {
  const devices = []
  const byName = new Map()
  for (const raw of entries) {
    const name = String(raw?.name ?? '').trim()
    if (name === '') continue
    const device = {
      name,
      vendor: String(raw?.vendor ?? '').trim(),
      core: String(raw?.core ?? '').trim(),
      base: String(raw?.base ?? '').trim(),
      lower: name.toLowerCase(),
    }
    device.hay = `${device.name} ${device.vendor} ${device.core} ${device.base}`.toLowerCase()
    devices.push(device)
    if (!byName.has(device.lower)) byName.set(device.lower, device)
  }
  return { devices, byName }
}

/**
 * What tells one device database from another: the commander path and the
 * files that carry the database. A J-Link update changes it, a restart does not.
 */
async function databaseKey(exe) {
  const root = dirname(exe)
  const parts = [exe.toLowerCase()]
  for (const file of [join(root, 'JLinkARM.dll'), join(root, 'JLink_x64.dll'), exe]) {
    try {
      const info = await stat(file)
      parts.push(`${file.toLowerCase()}:${info.size}:${Math.round(info.mtimeMs)}`)
    } catch {
      // Missing companion: the remaining files still identify the install.
    }
  }
  return parts.join('|')
}

async function readCache(file, key) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.format !== CACHE_FORMAT || parsed.key !== key) return undefined
    if (!Array.isArray(parsed.devices) || parsed.devices.length === 0) return undefined
    const entries = parsed.devices.map((row) => (Array.isArray(row)
      ? { name: row[0], vendor: row[1], core: row[2], base: row[3] }
      : row))
    const index = hydrate(entries)
    if (index.devices.length === 0) return undefined
    return {
      exe: String(parsed.exe ?? ''),
      jlink: String(parsed.jlink ?? ''),
      builtAt: String(parsed.builtAt ?? ''),
      key,
      total: index.devices.length,
      cached: true,
      ...index,
    }
  } catch {
    return undefined
  }
}

async function writeCache(file, database) {
  await mkdir(dirname(file), { recursive: true })
  const body = {
    format: CACHE_FORMAT,
    key: database.key,
    exe: database.exe,
    jlink: database.jlink,
    builtAt: database.builtAt,
    devices: database.devices.map((device) => [device.name, device.vendor, device.core, device.base]),
  }
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(body)}\n`, 'utf8')
  await rename(temp, file)
}

/** Per-process memo: a panel reopening must not re-export the database. */
const memory = new Map()
/** Concurrent first opens share one export instead of racing. */
const jobs = new Map()

/**
 * Load (or rebuild) the device database for this J-Link installation.
 *
 * @param {object} options
 * @param {string} options.exe absolute path to JLink.exe
 * @param {string} options.dir directory for the cache file
 * @param {boolean} [options.refresh] ignore both caches and export again
 * @param {number} [options.timeoutMs] hard deadline for the commander run
 */
export async function loadDeviceDatabase(options) {
  const { exe, dir, refresh = false, timeoutMs = 30000 } = options
  const key = await databaseKey(exe)
  const remembered = memory.get(exe)
  if (refresh !== true && remembered !== undefined && remembered.key === key) {
    return { ...remembered.database, cached: true }
  }
  const file = join(dir, CACHE_FILE)
  if (refresh !== true) {
    const cached = await readCache(file, key)
    if (cached !== undefined) {
      memory.set(exe, { key, database: cached })
      return cached
    }
  }
  let job = jobs.get(key)
  if (job === undefined) {
    job = (async () => {
      const built = await exportDatabase(exe, timeoutMs)
      const index = hydrate(built.entries)
      if (index.devices.length === 0) throw new Error('the J-Link device list is empty')
      const database = {
        exe,
        jlink: built.version,
        builtAt: new Date().toISOString(),
        key,
        total: index.devices.length,
        cached: false,
        ...index,
      }
      await writeCache(file, database).catch(() => {})
      return database
    })().finally(() => { jobs.delete(key) })
    jobs.set(key, job)
  }
  const database = await job
  memory.set(exe, { key, database })
  return database
}

/** Exact device (or alias) lookup, case-insensitive. */
export function findDevice(database, name) {
  if (database === undefined || database === null) return undefined
  const key = String(name ?? '').trim().toLowerCase()
  if (key === '') return undefined
  return database.byName.get(key)
}

/**
 * Rank the database against one query.
 *
 * Exact names come first, then prefixes, then substrings, then everything that
 * contains every whitespace-separated token in its name, vendor or core. That
 * last tier is what makes "stm32 h503" and "nrf 840" work.
 */
export function searchDevices(database, query, limit = 80) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '' || database === undefined || database === null) return { matched: 0, items: [] }
  const tokens = q.split(/\s+/)
  const scored = []
  for (const device of database.devices) {
    const name = device.lower
    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else {
      let all = true
      for (const token of tokens) {
        if (device.hay.includes(token) === false) {
          all = false
          break
        }
      }
      if (all === true) score = 3
    }
    if (score >= 0) scored.push({ device, score })
  }
  scored.sort((left, right) => left.score - right.score
    || left.device.name.length - right.device.name.length
    || (left.device.name < right.device.name ? -1 : left.device.name > right.device.name ? 1 : 0))
  return { matched: scored.length, items: scored.slice(0, Math.max(1, limit)).map((entry) => entry.device) }
}

/** What the panel shows for one device. */
export function describeDevice(device) {
  if (device === undefined || device === null) return undefined
  const out = { name: device.name }
  if (device.vendor !== '') out.vendor = device.vendor
  if (device.core !== '') out.core = device.core
  if (device.base !== '' && device.base !== device.name) out.base = device.base
  return out
}

// ------------------------------------------------------------------- history
//
// Choices are stored as names only. Vendor and core are resolved against the
// current database when the panel asks, so a J-Link update refreshes them.

let historyWrites = Promise.resolve()

export async function readDeviceHistory(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, HISTORY_FILE), 'utf8'))
    const list = Array.isArray(parsed?.devices) ? parsed.devices : []
    const seen = new Set()
    const out = []
    for (const raw of list) {
      const name = typeof raw === 'string' ? raw : raw?.name
      if (typeof name !== 'string' || name.trim() === '') continue
      const key = name.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: name.trim(), at: typeof raw?.at === 'string' ? raw.at : '' })
    }
    return out.slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

/** Move one choice to the front of the machine-wide history. */
export function recordDeviceHistory(dir, name) {
  const value = String(name ?? '').trim()
  if (value === '') return Promise.resolve()
  historyWrites = historyWrites.then(async () => {
    const current = await readDeviceHistory(dir)
    const key = value.toLowerCase()
    const next = [
      { name: value, at: new Date().toISOString() },
      ...current.filter((entry) => entry.name.toLowerCase() !== key),
    ].slice(0, HISTORY_LIMIT)
    await mkdir(dir, { recursive: true })
    const file = join(dir, HISTORY_FILE)
    const temp = `${file}.tmp`
    await writeFile(temp, `${JSON.stringify({ format: 1, devices: next }, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  }).catch(() => {})
  return historyWrites
}
