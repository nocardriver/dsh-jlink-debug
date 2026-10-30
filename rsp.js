/**
 * Minimal GDB Remote Serial Protocol client.
 *
 * Speaks to a locally spawned JLinkGDBServerCL over TCP. Only the packets this
 * plugin needs are implemented: run control, memory, registers, breakpoints and
 * monitor commands. Everything is ASCII; binary `X`/`vFlash` packets are not
 * used because flashing goes through JLink.exe instead.
 */
import net from 'node:net'

const ACK = '+'
const NAK = '-'
/** Set DSH_JLINK_RSP_TRACE=1 to log every packet on the console. */
const TRACE = process.env.DSH_JLINK_RSP_TRACE === '1'
const trace = (arrow, text) => {
  if (TRACE) console.log(`rsp ${arrow} ${JSON.stringify(String(text).slice(0, 160))}`)
}

function checksum(text) {
  let sum = 0
  for (let i = 0; i < text.length; i += 1) sum = (sum + text.charCodeAt(i)) & 0xff
  return sum.toString(16).padStart(2, '0')
}

export class RspConnection {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.pending = []
    this.events = []
    this.listeners = new Set()
    this.closed = false
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#failAll(new Error('RSP connection closed')))
    socket.on('error', (error) => this.#failAll(error))
  }

  #failAll(error) {
    this.closed = true
    const waiting = this.pending
    this.pending = []
    for (const entry of waiting) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  #onData(chunk) {
    this.buffer += chunk.toString('latin1')
    for (;;) {
      const dollar = this.buffer.indexOf('$')
      if (dollar < 0) {
        // Only acknowledgements arrived; nothing to dispatch.
        this.buffer = ''
        return
      }
      const hash = this.buffer.indexOf('#', dollar)
      if (hash < 0) return
      if (this.buffer.length < hash + 3) return
      const body = this.buffer.slice(dollar + 1, hash)
      const sum = this.buffer.slice(hash + 1, hash + 3).toLowerCase()
      this.buffer = this.buffer.slice(hash + 3)
      const valid = checksum(body) === sum
      this.socket.write(valid ? ACK : NAK)
      if (valid) this.#dispatch(body)
    }
  }

  /**
   * Hand one incoming packet to the oldest request that is waiting for it.
   *
   * This plugin never leaves a packet outstanding: run control is `monitor go`
   * and `monitor halt`, both of which answer immediately, and background reads
   * are monitor packets too. So every reply belongs to a request in order; a
   * packet nobody waits for is an unsolicited stop notification and is kept as
   * an event rather than being mistaken for a reply.
   */
  #dispatch(body) {
    trace('<<', body)
    const entry = this.pending.shift()
    if (entry !== undefined) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.resolve(body)
      return
    }
    this.events.push(body)
    for (const listener of this.listeners) {
      try {
        listener(body)
      } catch {
        // a listener must never break the protocol loop
      }
    }
  }

  /**
   * Send one packet and resolve with its reply.
   * `timeoutMs <= 0` means no timeout, for a packet that only answers later.
   */
  request(body, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('RSP connection closed'))
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          const index = this.pending.indexOf(entry)
          if (index >= 0) this.pending.splice(index, 1)
          reject(new Error(`RSP timeout for ${body.slice(0, 40)}`))
        }, timeoutMs)
        : undefined
      const entry = { resolve, reject, timer }
      this.pending.push(entry)
      trace('>>', body)
      this.socket.write(`$${body}#${checksum(body)}`)
    })
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.closed = true
    this.socket.destroy()
  }
}

/**
 * Open an RSP connection to an already listening server.
 * @param options.port TCP port of the GDB server
 */
export function connectRsp({ port, host = '127.0.0.1', timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`RSP connect to ${host}:${port} timed out`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(new RspConnection(socket))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Parse a `T`/`S` stop reply into a signal number and key/value info. */
export function parseStopReply(reply) {
  if (typeof reply !== 'string' || reply.length === 0) return undefined
  if (reply.startsWith('W') || reply.startsWith('X')) {
    return { kind: 'exit', code: parseInt(reply.slice(1, 3), 16) }
  }
  if (reply[0] !== 'S' && reply[0] !== 'T') return undefined
  const signal = parseInt(reply.slice(1, 3), 16)
  const fields = {}
  for (const part of reply.slice(3).split(';')) {
    if (part === '') continue
    const index = part.indexOf(':')
    if (index < 0) fields[part] = true
    else fields[part.slice(0, index)] = part.slice(index + 1)
  }
  return { kind: 'signal', signal, fields }
}

/** Decode the hex payload of an `m` reply into bytes. */
export function decodeHexBytes(hex) {
  if (typeof hex !== 'string') return []
  const out = []
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

/** Encode bytes as the hex payload an `M` packet expects. */
export function encodeHexBytes(bytes) {
  // Buffer/TypedArray.map coerces the callback result back into a byte, which
  // would turn "6d" into 0. Array.from is what keeps the hex strings intact.
  return Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
}

/** Encode a monitor command for `qRcmd`. */
export function encodeMonitor(command) {
  return encodeHexBytes(Buffer.from(command, 'latin1'))
}
