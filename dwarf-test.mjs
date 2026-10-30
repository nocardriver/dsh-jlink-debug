/**
 * DWARF regression test for the mcu_debug plugin.
 *
 * Run with the MotorTest tree checked out (the default path), or point
 * MOTORTEST at another build directory:
 *
 *   node dwarf-test.mjs
 *   MOTORTEST=C:\path\to\MotorTest node dwarf-test.mjs
 *
 * The test intentionally uses the project's own firmware because that is what
 * exercises real GCC/clang DWARF: clang's strx/addrx forms, GCC's
 * implicit_const attributes and CU-relative specification references.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadDebugInfo } from './dwarf.js'

const root = process.env.MOTORTEST ?? 'C:/Users/Forwork/Documents/XL_repo/MotorTest'
const atfeElf = join(root, 'build/ATfE-Debug/SingleMotorDriver_ATfE_Debug.elf')
const gccElf = join(root, 'build/Debug/SingleMotorDriver.elf')
const releaseElf = join(root, 'build/ATfE-Release/SingleMotorDriver_ATfE_Release.elf')

if (!existsSync(atfeElf)) {
  console.error(`skip: ${atfeElf} not found (set MOTORTEST)`)
  process.exit(0)
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`)
}

function memberOffsets(layout) {
  return Object.fromEntries((layout.members ?? []).map((member) => [member.name, member.offset]))
}

// ---------------------------------------------------------------- clang/ATfE
const atfe = await loadDebugInfo(atfeElf)
assert.equal(atfe.version, 5)
assert.ok(atfe.units.length > 10, 'expected many compilation units')
assert.deepEqual(atfe.warnings, [], 'clang DWARF must parse without warnings')

const sharedType = atfe.typeByName('foc_isr_shared_t')
assert.ok(sharedType, 'foc_isr_shared_t not found')
assert.equal(atfe.typeLabel(sharedType), 'foc_isr_shared_t')
assert.equal(atfe.sizeOf(sharedType), 72)

const sharedLayout = atfe.describeType(sharedType, { depth: 1 })
assert.equal(sharedLayout.kind, 'struct')
assert.deepEqual(memberOffsets(sharedLayout), {
  target_pos: 0,
  target_vel: 16,
  target_volt: 32,
  uq_out: 48,
  active_motor: 64,
  ready: 65,
  calc_cnt: 68,
})
assert.equal(sharedLayout.members.find((member) => member.name === 'target_pos').type, 'volatile float[4]')

const sharedVar = atfe.variable('foc_isr', 0x20001e90)
assert.ok(sharedVar, 'foc_isr variable not found at its symbol address')
assert.equal(atfe.typeLabel(sharedVar.type), 'foc_isr_shared_t')

const sharedBytes = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + 'FF0100009A2B3303',
  'hex',
)
assert.equal(sharedBytes.length, 72)
const sharedValue = atfe.decode(sharedVar.type, sharedBytes, { depth: 3 })
assert.deepEqual(sharedValue.target_pos, [0, 0, 0, 0])
assert.equal(sharedValue.active_motor, -1)
assert.equal(sharedValue.ready, 1)
assert.equal(sharedValue.calc_cnt, 0x03332b9a)

// Enum values and typedef names must survive the type table.
const statusType = atfe.typeByName('FOC_status_t')
assert.ok(statusType, 'FOC_status_t not found')
const statusLayout = atfe.describeType(statusType, { depth: 1 })
assert.equal(statusLayout.kind, 'enum')
assert.deepEqual(statusLayout.values, [
  { name: 'IDLE', value: 0 },
  { name: 'RUNNING', value: 1 },
  { name: 'LOCKED', value: 2 },
])

// A whole struct array: 4 x FOC_motor_dev, including nested PID structs.
const motorVar = atfe.variable('motor')
assert.ok(motorVar, 'motor not found')
assert.equal(atfe.typeLabel(motorVar.type), 'FOC_motor_dev[4]')
assert.equal(atfe.sizeOf(motorVar.type), 704)

const motors = Buffer.alloc(704)
const view = new DataView(motors.buffer, motors.byteOffset, motors.byteLength)
for (let index = 0; index < 4; index += 1) {
  const base = index * 176
  motors[base] = index + 1
  motors[base + 1] = 7
  motors[base + 2] = 0xff // -1
  view.setFloat32(base + 4, 1.5 + index, true)
  view.setUint32(base + 8, 0x20000204 + index * 4, true)
  view.setFloat32(base + 0x14, 0.25, true)
  view.setFloat32(base + 0x20, 0.014999, true)
  view.setFloat32(base + 0x24, 0.5, true)
  motors[base + 0xa8] = index % 3
  motors[base + 0xac] = 1
}
const motorValue = atfe.decode(motorVar.type, motors, { depth: 4 })
assert.equal(motorValue.length, 4)
assert.equal(motorValue[2].motor_id, 3)
assert.equal(motorValue[2].phase_dir, -1)
near(motorValue[2].zero_electric_Angle, 3.5, 'zero_electric_Angle')
assert.equal(motorValue[2].moving_angle_ptr, '0x2000020C')
near(motorValue[0].velocity_pid_data.Kp, 0.014999, 'Kp')
near(motorValue[0].velocity_pid_data.Ki, 0.5, 'Ki')
assert.deepEqual(motorValue[1].status, { value: 1, name: 'RUNNING' })
assert.equal(motorValue[3].is_initialized, 1)

// The symbol-to-type bridge used by `symbols` / `resolve`.
const fromSymbol = atfe.typeForSymbol({ name: 'foc_isr', address: 0x20001e91 })
assert.equal(fromSymbol.name, 'foc_isr_shared_t')
assert.equal(fromSymbol.size, 72)

// ---------------------------------------------------------------- GCC DWARF
if (existsSync(gccElf)) {
  const gcc = await loadDebugInfo(gccElf)
  assert.equal(gcc.version, 5)
  assert.deepEqual(gcc.warnings, [], 'GCC DWARF must parse without warnings')
  const type = gcc.typeByName('foc_isr_shared_t')
  assert.ok(type, 'GCC foc_isr_shared_t not found')
  assert.equal(gcc.sizeOf(type), 72)
  assert.equal(memberOffsets(gcc.describeType(type, { depth: 1 })).calc_cnt, 68)
  // GCC uses DW_AT_specification for definitions, so this also proves the
  // specification chain resolves name/type from the declaration DIE.
  assert.ok(gcc.variable('foc_isr'), 'GCC foc_isr variable not found')
}

// ------------------------------------------------------------ stripped image
if (existsSync(releaseElf)) {
  await assert.rejects(() => loadDebugInfo(releaseElf), /no \.debug_info section/)
}

console.log(
  `ok · ${atfe.units.length} units, ${atfe.typesByName.size} type names, `
  + `${atfe.variablesByName.size} variables, ${atfe.warnings.length} warnings`,
)
