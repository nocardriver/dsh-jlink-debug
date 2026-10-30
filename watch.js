/**
 * Background watch sampler.
 *
 * Sampling rides on the session's MEM-AP reads (`readSnapshot`), so a watch
 * never halts the core: the probe performs the bus access while the firmware
 * keeps executing. Values are kept in a small ring buffer per watch item, and
 * the tool action and the sidebar panel both read snapshots out of it.
 *
 * The plan step groups nearby addresses into spans so one read serves several
 * watches: a struct member and its neighbour cost one MONITOR packet, not two.
 */

const MIN_PERIOD_MS = 5
const MAX_PERIOD_MS = 5000
const DEFAULT_PERIOD_MS = 20
const DEFAULT_CAPACITY = 8192
const MAX_CAPACITY = 65536
/** Merge two watch addresses into one read when the gap is at most this. */
const SPAN_GAP = 16
/** Never read more than this in one span, so a sparse set stays cheap. */
const SPAN_MAX = 512

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A finite number a chart can draw, or undefined for structs/strings/etc. */
export function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

/**
 * Group watch items into contiguous read spans.
 * @param {Array<{address:number,size:number}>} items
 * @returns {Array<{start:number,length:number,members:Array<{index:number,offset:number,size:number}>}>}
 */
export function planSpans(items) {
  const order = items
    .map((item, index) => ({ index, address: item.address, size: Math.max(1, item.size ?? 4) }))
    .sort((left, right) => left.address - right.address)
  const spans = []
  for (const entry of order) {
    const last = spans[spans.length - 1]
    const end = entry.address + entry.size
    if (
      last !== undefined
      && entry.address >= last.start
      && entry.address - (last.start + last.length) <= SPAN_GAP
      && end - last.start <= SPAN_MAX
    ) {
      const offset = entry.address - last.start
      last.members.push({ index: entry.index, offset, size: entry.size })
      last.length = Math.max(last.length, offset + entry.size)
      continue
    }
    spans.push({
      start: entry.address,
      length: entry.size,
      members: [{ index: entry.index, offset: 0, size: entry.size }],
    })
  }
  return spans
}

export class Watcher {
  #session
  #items = []
  #spans = []
  #periodMs = DEFAULT_PERIOD_MS
  #capacity = DEFAULT_CAPACITY
  #samples = []
  #times = new Float64Array(DEFAULT_CAPACITY)
  #startedAt
  #index = 0
  #count = 0
  #running = false
  #generation = 0
  #error
  #failures = 0
  #stopReason
  #ticks = 0
  #dropped = 0

  constructor(session) {
    this.#session = session
  }

  get running() {
    return this.#running
  }

  get periodMs() {
    return this.#periodMs
  }

  get count() {
    return this.#count
  }

  get items() {
    return this.#items
  }

  /**
   * (Re)start sampling.
   * @param {Array<{name:string,address:number,size:number,type?:string,decode:Function}>} items
   * @param {{periodMs?:number,capacity?:number}} options
   */
  start(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('watch needs at least one symbol')
    this.stop('restart')
    const period = Number(options.periodMs ?? DEFAULT_PERIOD_MS)
    this.#periodMs = Math.min(MAX_PERIOD_MS, Math.max(MIN_PERIOD_MS, Math.round(Number.isFinite(period) ? period : DEFAULT_PERIOD_MS)))
    const capacity = Math.min(MAX_CAPACITY, Math.max(64, Math.round(options.capacity ?? DEFAULT_CAPACITY)))
    this.#capacity = capacity
    this.#items = items.map((item) => ({
      name: item.name,
      address: item.address,
      size: Math.max(1, item.size ?? 4),
      type: item.type,
      decode: item.decode,
      last: undefined,
      lastError: undefined,
    }))
    this.#samples = this.#items.map(() => new Float64Array(capacity))
    this.#times = new Float64Array(capacity)
    this.#index = 0
    this.#count = 0
    this.#ticks = 0
    this.#dropped = 0
    this.#failures = 0
    this.#error = undefined
    this.#stopReason = undefined
    this.#startedAt = Date.now()
    this.#spans = planSpans(this.#items)
    this.#running = true
    const generation = ++this.#generation
    void this.#loop(generation)
    return this.status()
  }

  stop(reason = 'stopped') {
    if (!this.#running && this.#stopReason !== undefined) return this.status()
    this.#running = false
    this.#generation += 1
    if (this.#startedAt !== undefined) this.#stopReason = reason
    return this.status()
  }

  /** Reset the ring buffers but keep sampling with the same items. */
  clear() {
    if (this.#items.length === 0) return this.status()
    this.#samples = this.#samples.map(() => new Float64Array(this.#capacity))
    this.#times = new Float64Array(this.#capacity)
    this.#index = 0
    this.#count = 0
    this.#dropped = 0
    this.#startedAt = Date.now()
    return this.status()
  }

  status() {
    return {
      running: this.#running,
      periodMs: this.#periodMs,
      capacity: this.#capacity,
      collected: this.#count,
      dropped: this.#dropped,
      state: this.#session.state,
      startedAt: this.#startedAt === undefined ? undefined : new Date(this.#startedAt).toISOString(),
      elapsedMs: this.#startedAt === undefined ? 0 : Date.now() - this.#startedAt,
      error: this.#error,
      stopReason: this.#stopReason,
      points: this.#items.map((item) => item.name),
      items: this.#items.map((item, index) => ({
        name: item.name,
        address: `0x${(item.address >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
        type: item.type,
        size: item.size,
        last: jsonSafe(item.last),
        error: item.lastError,
        ...statistics(this.#series(index)),
      })),
    }
  }

  /**
   * Ring-buffer contents, oldest first.
   * @param {{limit?:number}} options limit keeps only the newest N samples
   */
  snapshot({ limit } = {}) {
    const count = this.#count
    const keep = count === 0
      ? 0
      : Math.max(1, Math.min(count, Math.round(limit ?? count)))
    const start = (this.#index - keep + this.#capacity) % this.#capacity
    const times = []
    for (let i = 0; i < keep; i += 1) times.push(this.#times[(start + i) % this.#capacity])
    const items = this.#items.map((item, index) => {
      const series = this.#series(index)
      const kept = series.slice(series.length - keep)
      return {
        name: item.name,
        address: `0x${(item.address >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
        type: item.type,
        size: item.size,
        last: jsonSafe(item.last),
        error: item.lastError,
        ...statistics(series),
        samples: kept.map((value) => (Number.isNaN(value) ? null : value)),
      }
    })
    return {
      ...this.status(),
      times,
      items,
    }
  }

  /** Resolve once at least `count` samples exist (or sampling stops). */
  waitFor(count, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      const check = () => {
        if (this.#count >= count || !this.#running || Date.now() >= deadline) {
          clearInterval(timer)
          resolve({ collected: this.#count, running: this.#running, timedOut: this.#count < count && this.#running })
          return
        }
      }
      const timer = setInterval(check, 10)
      check()
    })
  }

  async #loop(generation) {
    while (this.#running && generation === this.#generation) {
      const started = Date.now()
      try {
        const values = await this.#sample()
        if (generation !== this.#generation) return
        this.#push(values, started)
        this.#failures = 0
        this.#error = undefined
      } catch (error) {
        this.#error = String(error?.message ?? error)
        this.#failures += 1
        if (!this.#session.isOpen || this.#failures >= 10) {
          this.#running = false
          this.#stopReason = this.#session.isOpen ? 'sampling failed' : 'session closed'
          return
        }
      }
      this.#ticks += 1
      // A breakpoint hit is silent under monitor run control; DHCSR is the only
      // way to learn about it, and the panel should say so.
      if (this.#ticks % Math.max(1, Math.round(1000 / this.#periodMs)) === 0) {
        await this.#session.refresh().catch(() => {})
      }
      const spent = Date.now() - started
      if (this.#periodMs > spent) await sleep(this.#periodMs - spent)
      else this.#dropped += 1
    }
  }

  async #sample() {
    const values = new Array(this.#items.length)
    for (const span of this.#spans) {
      const bytes = await this.#session.readSnapshot(span.start, span.length)
      for (const member of span.members) {
        const item = this.#items[member.index]
        const slice = bytes.slice(member.offset, member.offset + member.size)
        if (slice.length < member.size) {
          item.lastError = `short read: ${slice.length} of ${member.size} bytes at 0x${(span.start + member.offset).toString(16)}`
          continue
        }
        try {
          values[member.index] = item.decode(slice)
          item.lastError = undefined
        } catch (error) {
          item.lastError = String(error?.message ?? error)
        }
      }
    }
    return values
  }

  #push(values, startedAt) {
    const slot = this.#index
    this.#times[slot] = startedAt - this.#startedAt
    for (let i = 0; i < this.#items.length; i += 1) {
      const item = this.#items[i]
      const value = values[i]
      item.last = value
      const numeric = numericValue(value)
      this.#samples[i][slot] = numeric === undefined ? Number.NaN : numeric
    }
    this.#index = (slot + 1) % this.#capacity
    this.#count = Math.min(this.#count + 1, this.#capacity)
  }

  #series(index) {
    const out = new Array(this.#count)
    const start = (this.#index - this.#count + this.#capacity) % this.#capacity
    for (let i = 0; i < this.#count; i += 1) out[i] = this.#samples[index][(start + i) % this.#capacity]
    return out
  }
}

function statistics(series) {
  let min
  let max
  let sum = 0
  let count = 0
  for (const value of series) {
    if (!Number.isFinite(value)) continue
    count += 1
    sum += value
    if (min === undefined || value < min) min = value
    if (max === undefined || value > max) max = value
  }
  return {
    numeric: count > 0,
    count,
    min,
    max,
    mean: count === 0 ? undefined : sum / count,
    distinct: new Set(series.filter((value) => Number.isFinite(value))).size,
  }
}

/** Keep tool results JSON-safe: no undefined, no cycles from decoded structs. */
function jsonSafe(value) {
  if (value === undefined || value === null) return value
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return Number(value)
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}
