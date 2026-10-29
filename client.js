/**
 * Client half: renders the `mcu_debug` tool call as a register / hexdump card.
 *
 * The card reads only durable tool-call data, so it needs no Client→Host RPC:
 * what the agent saw is exactly what the user sees. Sections are chosen from
 * the shape of the result, never from the requested action, so a missing or
 * differently shaped argument block can never blank the card body.
 */
window.__ModuleLoader__.load({
  id: '@nocardriver/dsh-jlink-debug',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

    const EN = {
      'debug.title': 'MCU',
      'status.title': 'Target status',
      'registers.title': 'Core registers',
      'read_memory.title': 'Memory',
      'reset.title': 'Reset',
      'flash.title': 'Flash',
      'symbols.title': 'Symbols',
      'resolve.title': 'Resolve',
      'field.core': 'Core',
      'field.device': 'Device',
      'field.serial': 'Probe',
      'field.vtref': 'VTref',
      'field.speed': 'Speed',
      'field.state': 'State',
      'state.running': 'running',
      'state.halted': 'halted',
      'field.address': 'Address',
      'field.bytes': 'Bytes',
      'field.ascii': 'ASCII',
      'field.exception': 'Exception',
      'field.symbol': 'Symbol',
      'field.name': 'Name',
      'field.size': 'Size',
      'field.kind': 'Kind',
      'field.file': 'Image',
      'field.symbols': 'symbols',
      'field.functions': 'functions',
      'field.candidates': 'Candidates',
      'hint.running': 'Querying the probe…',
      'panel.nav': 'J-Link Debug',
      'panel.tab': 'J-Link',
      'panel.guide.description': 'Device, transport and clock for this workspace',
      'panel.title': 'Target connection',
      'panel.intro': 'These values belong to this workspace only. The agent attaches with them, and a different workspace keeps its own board.',
      'panel.workspace': 'Workspace',
      'panel.directory': 'unregistered folder',
      'panel.save': 'Save',
      'panel.refresh': 'Refresh',
      'panel.saving': 'Saving…',
      'panel.saved': 'Saved for this workspace.',
      'panel.pending': 'Saved, waiting for the plugin to restart…',
      'panel.saveFailed': 'The new values did not take effect.',
      'panel.loadFailed': 'Cannot reach the plugin host route.',
      'panel.noSession': 'Open a session first: the panel follows the workspace that session belongs to.',
      'panel.reset': 'Use defaults',
      'panel.resetDone': 'Workspace values cleared; the global defaults apply again.',
      'panel.default': 'default',
      'panel.override': 'workspace',
      'panel.status': 'Session',
      'panel.session.open': 'attached',
      'panel.session.closed': 'probe released',
      'panel.symbols': 'Symbols',
      'panel.field.device': 'MCU / device',
      'panel.field.interface': 'Transport',
      'panel.field.speedKhz': 'Clock (kHz)',
      'panel.field.idleCloseMs': 'Release when idle (ms)',
      'panel.field.maxReadBytes': 'Max bytes per read',
      'panel.field.jlinkExe': 'JLink.exe',
      'panel.field.gdbServerExe': 'JLinkGDBServerCL.exe',
      'panel.hint.device': 'Search the J-Link device library, or type an exact name. Recent choices are one click away.',
      'panel.hint.interface': 'SWD uses two wires, JTAG five. Must match the wiring on the board.',
      'panel.hint.speedKhz': '4000 is safe on short wires; drop to 1000-2000 for a breadboard.',
      'panel.hint.idleCloseMs': '0 keeps the probe until the plugin unloads.',
      'panel.hint.jlinkExe': 'Empty auto-detects the newest SEGGER install.',
      'panel.hint.gdbServerExe': 'Empty auto-detects beside JLink.exe.',
      'panel.global.title': 'J-Link runtime',
      'panel.global.intro': 'Machine-level settings. The chip, transport and clock belong to a workspace, so they moved to the J-Link panel in the right sidebar.',
      'panel.global.hint': 'Target settings live in the right sidebar: open it, add the J-Link tab from the guide, and set the chip, transport and clock for that workspace.',
      'picker.search': 'Search device…',
      'picker.recent': 'Recent',
      'picker.matches': 'Matches',
      'picker.loading': 'Reading the J-Link device library…',
      'picker.none': 'No device matches',
      'picker.pressEnter': 'Press Enter to use “{0}” as typed.',
      'picker.hintEmpty': 'Type a chip name to search {0} devices.',
      'picker.devices': '{0} devices',
      'picker.library': 'J-Link library',
      'picker.reload': 'Reload',
      'picker.failed': 'Device list unavailable',
      'picker.unknown': 'Not in the J-Link library: connecting fails unless a custom device is installed.',
      'picker.alias': 'alias of {0}',
    }

    const ZH = {
      'debug.title': '单片机调试',
      'status.title': '目标状态',
      'registers.title': '内核寄存器',
      'read_memory.title': '内存',
      'reset.title': '复位',
      'flash.title': '烧录',
      'symbols.title': '符号',
      'resolve.title': '符号解析',
      'field.core': '内核',
      'field.device': '器件',
      'field.serial': '探针',
      'field.vtref': 'VTref',
      'field.speed': '速率',
      'field.state': '状态',
      'state.running': '运行中',
      'state.halted': '已停止',
      'field.address': '地址',
      'field.bytes': '字节',
      'field.ascii': 'ASCII',
      'field.exception': '异常',
      'field.symbol': '符号',
      'field.name': '名称',
      'field.size': '大小',
      'field.kind': '类型',
      'field.file': '镜像',
      'field.symbols': '个符号',
      'field.functions': '个函数',
      'field.candidates': '候选',
      'hint.running': '正在查询探针…',
      'panel.nav': 'J-Link 调试',
      'panel.tab': 'J-Link',
      'panel.guide.description': '当前工作区的器件、接口与时钟',
      'panel.title': '目标连接',
      'panel.intro': '只对当前工作区生效。Agent 用这些值连接目标，换个工作区就换自己的板子。',
      'panel.workspace': '工作区',
      'panel.directory': '未注册的目录',
      'panel.save': '保存',
      'panel.refresh': '刷新',
      'panel.saving': '保存中…',
      'panel.saved': '已保存到当前工作区。',
      'panel.pending': '已提交，等待插件重启…',
      'panel.saveFailed': '新值没有生效。',
      'panel.loadFailed': '无法连接插件的 Host 路由。',
      'panel.noSession': '请先打开一个会话：这个面板跟随会话所属的工作区。',
      'panel.reset': '用全局默认',
      'panel.resetDone': '已清除工作区设置，改用全局默认。',
      'panel.default': '默认',
      'panel.override': '已覆盖',
      'panel.status': '会话',
      'panel.session.open': '已连接',
      'panel.session.closed': '探针已释放',
      'panel.symbols': '符号',
      'panel.field.device': 'MCU / 器件型号',
      'panel.field.interface': '调试接口',
      'panel.field.speedKhz': '时钟（kHz）',
      'panel.field.idleCloseMs': '空闲后释放（ms）',
      'panel.field.maxReadBytes': '单次读取上限',
      'panel.field.jlinkExe': 'JLink.exe',
      'panel.field.gdbServerExe': 'JLinkGDBServerCL.exe',
      'panel.hint.device': 'J-Link 器件库里的一模一样的名字，例如 STM32H503CB。',
      'panel.hint.interface': 'SWD 两线、JTAG 五线，必须和板子上的接法一致。',
      'panel.hint.speedKhz': '短线 4000 可靠；面包板建议降到 1000–2000。',
      'panel.hint.idleCloseMs': '0 表示插件卸载前一直占着探针。',
      'panel.hint.jlinkExe': '留空则自动找最新的 SEGGER 安装。',
      'panel.hint.gdbServerExe': '留空则在 JLink.exe 旁边自动找。',
      'panel.global.title': 'J-Link 运行设置',
      'panel.global.intro': '本机级别的设置。芯片型号、调试接口和时钟按工作区区分，已经移到右侧边栏的 J-Link 面板。',
      'panel.global.hint': '目标设置现在在右侧边栏：打开它，从引导页添加 J-Link 标签，就可以为这个工作区设置芯片、接口和时钟。',
      'picker.search': '搜索器件型号…',
      'picker.recent': '最近使用',
      'picker.matches': '搜索结果',
      'picker.loading': '正在读取 J-Link 器件库…',
      'picker.none': '没有匹配的器件',
      'picker.pressEnter': '按回车直接使用「{0}」。',
      'picker.hintEmpty': '输入型号搜索 {0} 个器件。',
      'picker.devices': '{0} 个器件',
      'picker.library': 'J-Link 器件库',
      'picker.reload': '重新读取',
      'picker.failed': '器件库不可用',
      'picker.unknown': 'J-Link 器件库里没有这个型号：除非装了自定义器件，否则连接会失败。',
      'picker.alias': '别名：{0}',
    }

    /** `{0}`-style substitution for the few labels that carry a count or name. */
    function fill(text, ...values) {
      return String(text).replace(/\{(\d+)\}/g, (whole, index) => {
        const value = values[Number(index)]
        return value === undefined ? whole : String(value)
      })
    }

    const REG_ORDER = [
      'PC', 'SP(R13)', 'R14(LR)', 'XPSR',
      'R0', 'R1', 'R2', 'R3',
      'R4', 'R5', 'R6', 'R7',
      'R8', 'R9', 'R10', 'R11',
      'R12', 'MSP', 'PSP', 'CONTROL',
      'PRIMASK', 'FAULTMASK', 'BASEPRI', 'MSPLIM', 'PSPLIM',
    ]

    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 12.5,
        color: 'var(--dsw-alias-label-primary)',
      },
      head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      title: { fontWeight: 600, fontSize: 13 },
      summary: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '3px 14px' },
      field: { display: 'flex', gap: 6, minWidth: 0 },
      fieldLabel: { color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' },
      fieldValue: { fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      mono: { fontFamily: MONO, fontSize: 11.5, lineHeight: '18px', whiteSpace: 'pre' },
      row: { display: 'flex', gap: 14, alignItems: 'baseline' },
      note: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 11.5, lineHeight: '16px' },
      err: {
        color: 'var(--dsw-alias-state-error-primary)',
        fontFamily: MONO,
        fontSize: 11.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      hexdump: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '6px 8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        overflowX: 'auto',
      },
    }

    function pill(text, color) {
      return h('span', {
        key: 'pill',
        style: {
          marginLeft: 'auto',
          fontSize: 11,
          lineHeight: '16px',
          padding: '0 8px',
          borderRadius: 999,
          border: '1px solid ' + color,
          color,
        },
      }, text)
    }

    function haltedOf(data) {
      if (data === null || typeof data !== 'object') return undefined
      if (data.state === 'halted') return true
      if (data.state === 'running') return false
      const legacy = data.target
      if (legacy !== null && typeof legacy === 'object' && typeof legacy.halted === 'boolean') return legacy.halted
      return undefined
    }

    function statePill(t, halted) {
      if (halted === true) return pill(t('state.halted'), 'var(--dsw-alias-state-warn-primary)')
      if (halted === false) return pill(t('state.running'), 'var(--dsw-alias-state-success-primary)')
      return null
    }

    function fields(t, entries) {
      const kept = entries.filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
      if (kept.length === 0) return null
      return h('div', { style: S.grid }, kept.map(([label, value]) => h('div', { key: label, style: S.field },
        h('span', { style: S.fieldLabel }, label),
        h('span', { style: S.fieldValue, title: String(value) }, String(value)))))
    }

    function registerGrid(registers) {
      if (registers === null || typeof registers !== 'object') return null
      const seen = new Set(REG_ORDER)
      const extra = Object.keys(registers).filter((name) => !seen.has(name))
      const names = REG_ORDER.filter((name) => registers[name] !== undefined).concat(extra)
      if (names.length === 0) return null
      return h('div', { style: S.grid }, names.map((name) => h('div', { key: name, style: S.field },
        h('span', { style: S.fieldLabel }, name),
        h('span', { style: S.fieldValue }, '0x' + registers[name]))))
    }

    function hexdump(t, memory) {
      if (memory === null || typeof memory !== 'object' || !Array.isArray(memory.rows)) return null
      if (memory.rows.length === 0) return null
      const head = h('div', { key: 'head', style: { ...S.row, color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } },
        h('span', { style: { ...S.mono, flex: '0 0 auto' } }, t('field.address')),
        h('span', { style: { ...S.mono, flex: '0 0 auto' } }, t('field.bytes')),
        h('span', { style: S.mono }, t('field.ascii')))
      const rows = memory.rows.map((row, index) => h('div', { key: index, style: S.row },
        h('span', { style: { ...S.mono, flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } }, row.address),
        h('span', { style: { ...S.mono, flex: '0 0 auto' } }, String(row.hex ?? '').padEnd(47, ' ')),
        h('span', { style: { ...S.mono, color: 'var(--dsw-alias-label-secondary)' } }, String(row.ascii ?? ''))))
      return h('div', { style: S.hexdump }, [head, ...rows])
    }

    function logLines(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return null
      return h('div', { style: { ...S.hexdump, display: 'flex', flexDirection: 'column' } },
        lines.map((line, index) => h('span', { key: index, style: S.mono }, String(line))))
    }

    /** Symbol rows shared by `symbols` results and `resolve` suggestions. */
    function symbolTable(t, entries) {
      if (!Array.isArray(entries) || entries.length === 0) return null
      const cell = (text, width, muted) => h('span', {
        style: {
          ...S.mono,
          flex: width === undefined ? '1 1 auto' : `0 0 ${width}px`,
          ...(muted === true ? { color: 'var(--dsw-alias-label-secondary)' } : {}),
        },
      }, text)
      const head = h('div', { key: 'head', style: { ...S.row, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
        cell(t('field.address'), 92, false),
        cell(t('field.size'), 44, false),
        cell(t('field.name'), undefined, false),
        cell(t('field.kind'), 52, false))
      const rows = entries.map((entry, index) => h('div', { key: index, style: S.row },
        cell(String(entry?.address ?? ''), 92, true),
        cell(entry?.size === 0 || entry?.size === undefined ? '—' : String(entry.size), 44, true),
        cell(String(entry?.name ?? ''), undefined, false),
        cell(String(entry?.kind ?? ''), 52, true)))
      return h('div', { style: { ...S.hexdump, display: 'flex', flexDirection: 'column' } }, [head, ...rows])
    }

    /** One line naming the image the symbols came from. */
    function elfLine(t, elf) {
      if (elf === null || typeof elf !== 'object') return null
      const parts = []
      if (typeof elf.file === 'string' && elf.file !== '') {
        const segments = elf.file.split(/[\\/]/)
        parts.push(segments[segments.length - 1])
      }
      if (typeof elf.symbols === 'number' && elf.symbols > 0) {
        parts.push(elf.symbols + ' ' + t('field.symbols'))
      }
      if (typeof elf.functions === 'number' && elf.functions > 0) {
        parts.push(elf.functions + ' ' + t('field.functions'))
      }
      if (typeof elf.error === 'string' && elf.error !== '') parts.push(elf.error)
      if (parts.length === 0) return null
      return h('div', { key: 'elf', style: S.summary }, t('field.file') + ': ' + parts.join(' · '))
    }

    /** Read the call arguments from whichever shape the current stage exposes. */
    function readArgs(block) {
      if (block === null || typeof block !== 'object') return {}
      const direct = block.args !== null && typeof block.args === 'object' && !Array.isArray(block.args)
        ? block.args
        : undefined
      // The decoded arguments are preferred; a bare argsRaw is the fallback.
      if (direct !== undefined && typeof direct.action === 'string') return direct
      const call = block.call
      const raw = call !== null && typeof call === 'object' && typeof call.argsRaw === 'string'
        ? call.argsRaw
        : (typeof block.argsRaw === 'string' ? block.argsRaw : undefined)
      if (raw !== undefined && raw.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.action === 'string') return parsed
        } catch {
          // fall through to the decoded argument block
        }
      }
      return direct ?? {}
    }

    function parsePayload(block) {
      const parts = Array.isArray(block?.content) ? block.content : []
      const text = parts
        .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const trimmed = text.trim()
      if (trimmed.startsWith('{')) {
        try {
          return { data: JSON.parse(trimmed), text }
        } catch {
          // fall through to raw text
        }
      }
      return { data: undefined, text }
    }

    function inferAction(args, data) {
      if (args !== null && typeof args === 'object' && typeof args.action === 'string' && args.action !== '') {
        return args.action
      }
      if (data !== null && typeof data === 'object') {
        if (data.registers !== undefined) return 'registers'
        if (data.memory !== undefined) return 'read_memory'
        if (Array.isArray(data.log)) return 'flash'
      }
      return 'status'
    }

    function callTitle(t, action) {
      const key = action + '.title'
      const title = t(key)
      if (title === key || title === '') return t('debug.title')
      return title
    }

    function intent(args) {
      if (args === null || typeof args !== 'object') return ''
      if (args.action === 'read_memory' || args.action === 'write_memory' || args.action === 'breakpoint') {
        const where = typeof args.symbol === 'string' && args.symbol !== '' ? args.symbol : args.address
        return where === undefined ? '' : String(where)
      }
      if (args.action === 'symbols' && typeof args.query === 'string' && args.query !== '') {
        return '"' + args.query + '"'
      }
      if (args.action === 'resolve' && typeof args.name === 'string') return args.name
      if (args.action === 'flash' && typeof args.file === 'string') {
        const parts = args.file.split(/[\\/]/)
        return parts[parts.length - 1]
      }
      return ''
    }

    function Card(props) {
      const t = props.t
      const settled = props.phase === 'result'
      const block = props.block
      const args = readArgs(block)
      const isError = settled === true && block.isError === true
      const payload = settled === true ? parsePayload(block) : undefined
      const data = payload?.data
      const action = inferAction(args, data)
      const subtitle = settled === true
        ? (isError ? '' : String(data?.summary ?? intent(args)))
        : t('hint.running')

      const children = [h('div', { key: 'head', style: S.head },
        h('span', { style: S.title }, callTitle(t, action)),
        h('span', { style: S.summary }, subtitle),
        settled === true && data !== undefined ? statePill(t, haltedOf(data)) : null)]

      if (settled !== true) {
        children.push(h('div', { key: 'pending', style: S.summary }, intent(args)))
        return h('div', { style: S.card }, children)
      }

      if (isError === true) {
        children.push(h('div', { key: 'err', style: S.err }, String(payload?.text ?? '')))
        return h('div', { style: S.card }, children)
      }

      if (data === undefined) {
        children.push(h('div', { key: 'raw', style: S.mono }, String(payload?.text ?? '')))
        return h('div', { style: S.card }, children)
      }

      const probe = data.probe
      if (probe !== null && typeof probe === 'object') {
        children.push(h('div', { key: 'probe' }, fields(t, [
          [t('field.core'), probe.core],
          [t('field.device'), probe.device],
          [t('field.serial'), probe.serial],
          [t('field.vtref'), probe.vtref === undefined ? undefined : String(probe.vtref) + ' V'],
          [t('field.speed'), probe.speedKhz === undefined ? undefined : String(probe.speedKhz) + ' kHz'],
        ])))
      }

      const registers = registerGrid(data.registers)
      if (registers !== null) {
        children.push(h('div', { key: 'regs' }, registers))
        if (data.ipsr !== undefined && data.ipsr !== null) {
          children.push(h('div', { key: 'ipsr', style: S.summary },
            t('field.exception') + ': ' + String(data.ipsr.name) + ' (' + String(data.ipsr.value) + ')'))
        }
      }

      if (data.pcSymbol !== null && typeof data.pcSymbol === 'object' && typeof data.pcSymbol.name === 'string') {
        children.push(h('div', { key: 'pcsym', style: { ...S.summary, fontFamily: MONO } },
          'PC → ' + data.pcSymbol.name + '+' + String(data.pcSymbol.offset)))
      }

      const elf = elfLine(t, data.elf)
      if (elf !== null) children.push(elf)

      const symbol = data.symbol
      if (symbol !== null && typeof symbol === 'object' && typeof symbol.name === 'string') {
        children.push(h('div', { key: 'symbol', style: { ...S.summary, fontFamily: MONO } },
          String(symbol.name) + '  ' + String(symbol.address ?? '')
          + (symbol.size > 0 ? '  (' + symbol.size + ' B)' : '')))
      }

      const memory = hexdump(t, data.memory)
      if (memory !== null) children.push(h('div', { key: 'mem' }, memory))

      const log = logLines(data.log)
      if (log !== null) children.push(h('div', { key: 'log' }, log))

      const written = data.written
      if (written !== null && typeof written === 'object') {
        children.push(h('div', { key: 'written', style: S.mono },
          String(written.address) + '  ' + String(written.length) + ' B  ' + String(written.bytes ?? '')))
      }

      if (Array.isArray(data.breakpoints) && data.breakpoints.length > 0) {
        children.push(h('div', { key: 'bps', style: { ...S.hexdump, display: 'flex', flexDirection: 'column' } },
          data.breakpoints.map((bp, index) => h('span', { key: index, style: S.mono },
            String(bp.address) + '  ' + String(bp.kind)))))
      }

      const symbols = symbolTable(t, data.symbols ?? data.candidates)
      if (symbols !== null) {
        if (data.found === false) {
          children.push(h('div', { key: 'miss', style: S.note }, t('field.candidates')))
        }
        children.push(h('div', { key: 'syms' }, symbols))
      }

      if (typeof data.output === 'string' && data.output !== '') {
        children.push(h('div', { key: 'out', style: S.summary }, data.output))
      }

      const warnings = probe?.warnings
      if (Array.isArray(warnings) && warnings.length > 0 && action === 'status') {
        children.push(h('div', { key: 'warn', style: S.note }, String(warnings[0])))
      }

      return h('div', { style: S.card }, children)
    }

    // ------------------------------------------------------------- settings page
    //
    // This plugin's own connection form. The schema-driven form the Harness
    // projects was not reachable in this build, so the page ships with the
    // plugin: the Host publishes `/jlink-debug/config`, and this file owns every
    // label and control. Field kinds and limits come from the Host so the two
    // sides cannot disagree about what is editable.

    const P = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720, padding: '2px 2px 24px' },
      title: { fontSize: 15, fontWeight: 600 },
      intro: { fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)', marginTop: -6 },
      form: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '4px 0',
      },
      row: { display: 'flex', gap: 16, padding: '10px 14px', alignItems: 'flex-start' },
      rowBorder: { borderTop: '1px solid var(--dsw-alias-border-l1)' },
      label: {
        flex: '0 0 190px',
        fontSize: 12.5,
        lineHeight: '30px',
        color: 'var(--dsw-alias-label-primary)',
      },
      control: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: 30,
        padding: '0 8px',
        fontSize: 12.5,
        fontFamily: MONO,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        outline: 'none',
      },
      hint: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      actions: { display: 'flex', gap: 8, alignItems: 'center' },
      button: {
        height: 30,
        padding: '0 14px',
        fontSize: 12.5,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primary: {
        height: 30,
        padding: '0 16px',
        fontSize: 12.5,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-inverse, #fff)',
        cursor: 'pointer',
        fontWeight: 600,
      },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      good: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
      bad: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      status: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 18px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '10px 14px',
      },
      mono: { fontFamily: MONO },
    }

    /** Same-origin URL of the Host route, honouring a mounted base path. */
    function configEndpoint() {
      try {
        const base = new URL('.', location.href)
        return new URL('jlink-debug/config', base).toString()
      } catch {
        return '/jlink-debug/config'
      }
    }

    async function readConfig() {
      const response = await fetch(configEndpoint(), { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      return response.json()
    }

    function draftOf(fields) {
      const draft = {}
      for (const field of fields) {
        draft[field.key] = field.value === undefined || field.value === null ? '' : String(field.value)
      }
      return draft
    }

    function sameValues(fields, draft) {
      return fields.every((field) => String(field.value ?? '') === String(draft[field.key] ?? ''))
    }

    /**
     * The settings page. Loads the Host's current configuration, edits a local
     * draft, and saves through the Host route — which validates with the plugin's
     * own schema and writes through the Loader's config editor.
     */
    function SettingsPanel(props) {
      const t = props.t
      const [phase, setPhase] = React.useState('loading')
      const [fields, setFields] = React.useState([])
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(undefined)
      const [note, setNote] = React.useState(undefined)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const load = React.useCallback(async () => {
        setPhase('loading')
        try {
          const data = await readConfig()
          if (mounted.current !== true) return
          setFields(Array.isArray(data.fields) ? data.fields : [])
          setDraft(draftOf(Array.isArray(data.fields) ? data.fields : []))
          setStatus(data)
          setPhase('ready')
        } catch (error) {
          if (mounted.current !== true) return
          setPhase('error')
          setNote(String(error?.message ?? error))
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const change = (key, value) => {
        setDraft((current) => ({ ...current, [key]: value }))
        setNote(undefined)
      }

      const save = async () => {
        setPhase('saving')
        setNote(t('panel.saving'))
        try {
          const response = await fetch(configEndpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: draft }),
          })
          const body = await response.json().catch(() => ({}))
          if (response.ok !== true || body.ok !== true) {
            throw new Error(body.error ?? ('HTTP ' + String(response.status)))
          }
          // The write restarts the plugin, so the saved values only appear once
          // the replacement instance serves the route again.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            if (mounted.current !== true) return
            const data = await readConfig().catch(() => undefined)
            if (data === undefined) continue
            const next = Array.isArray(data.fields) ? data.fields : []
            if (sameValues(next, draft) === true) {
              setFields(next)
              setStatus(data)
              setPhase('ready')
              setNote(t('panel.saved'))
              return
            }
          }
          setPhase('ready')
          setNote(t('panel.saveFailed'))
        } catch (error) {
          if (mounted.current !== true) return
          setPhase('ready')
          setNote(String(error?.message ?? error))
        }
      }

      const children = [
        h('div', { key: 'title', style: P.title }, t('panel.global.title')),
        h('div', { key: 'intro', style: P.intro }, t('panel.global.intro')),
      ]

      if (phase === 'error') {
        children.push(h('div', { key: 'err', style: P.bad },
          t('panel.loadFailed') + ' ' + String(note ?? '')))
        children.push(h('div', { key: 'retry', style: P.actions },
          h('button', { type: 'button', style: P.button, onClick: () => { void load() } }, t('panel.refresh'))))
        return h('div', { style: P.page }, children)
      }

      if (fields.length > 0) {
        const rows = fields.map((field, index) => {
          const hint = t('panel.hint.' + field.key)
          const hintText = hint === 'panel.hint.' + field.key ? undefined : hint
          const shared = {
            id: 'jlink-' + field.key,
            value: draft[field.key] === undefined ? '' : draft[field.key],
            onChange: (event) => change(field.key, event.target.value),
            style: P.input,
            disabled: phase === 'saving',
          }
          return h('div', { key: field.key, style: index === 0 ? P.row : { ...P.row, ...P.rowBorder } },
            h('label', { htmlFor: shared.id, style: P.label }, t('panel.field.' + field.key)),
            h('div', { style: P.control },
              field.kind === 'select'
                ? h('select', shared, (field.options ?? []).map((option) =>
                  h('option', { key: option, value: option }, option)))
                : h('input', {
                    ...shared,
                    type: field.kind === 'number' ? 'number' : 'text',
                    min: field.min,
                    max: field.max,
                    spellCheck: false,
                  }),
              hintText === undefined ? null : h('div', { style: P.hint }, hintText)))
        })
        children.push(h('div', { key: 'form', style: P.form }, rows))
      }

      children.push(h('div', { key: 'actions', style: P.actions },
        h('button', {
          key: 'save',
          type: 'button',
          style: { ...P.primary, opacity: phase === 'saving' ? 0.6 : 1 },
          disabled: phase === 'saving' || fields.length === 0,
          onClick: () => { void save() },
        }, phase === 'saving' ? t('panel.saving') : t('panel.save')),
        h('button', {
          key: 'refresh',
          type: 'button',
          style: P.button,
          disabled: phase === 'saving',
          onClick: () => { void load() },
        }, t('panel.refresh')),
        note === undefined ? null : h('span', {
          key: 'note',
          style: note === t('panel.saved') ? P.good : P.note,
        }, note)))

      children.push(h('div', { key: 'moved', style: P.hint }, t('panel.global.hint')))

      if (status !== undefined) {
        const elf = status.elf ?? {}
        const sessionText = status.session === 'open'
          ? t('panel.session.open') + (status.targetState === undefined ? '' : ' · ' + String(status.targetState))
          : t('panel.session.closed')
        const symbolText = elf.file === undefined || elf.file === ''
          ? '—'
          : (String(elf.symbols ?? 0) + ' / ' + String(elf.functions ?? 0))
        children.push(h('div', { key: 'status', style: P.status },
          h('span', { key: 's' }, t('panel.status') + ': ' + sessionText),
          h('span', { key: 'e' }, t('panel.symbols') + ': ' + symbolText),
          elf.file === undefined || elf.file === ''
            ? null
            : h('span', { key: 'f', style: P.mono, title: String(elf.file) },
                String(elf.file).split(/[\\/]/).pop())))
      }

      return h('div', { style: P.page }, children)
    }

    // ------------------------------------------------------ right sidebar tab
    //
    // The target belongs to a workspace, not to the whole application, so its
    // form lives in the right sidebar beside the conversation that drives it.
    // The right column owns tab types and navigation; this plugin contributes
    // one type and registers its body under that type's own id.

    /** Tab type id: the registry key, and the body/title slot key. */
    const TAB_TYPE_ID = '@nocardriver/dsh-jlink-debug/panel'
    /** The kind a guide row opens and `openTab` addresses. */
    const TAB_KIND = 'jlink-debug'

    /** Narrow-column styling: label above control, no fixed label column. */
    const R = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '12px 12px 24px',
        minWidth: 0,
        color: 'var(--dsw-alias-label-primary)',
      },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      title: { fontSize: 13, fontWeight: 600 },
      intro: { fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' },
      workspaceRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      workspaceName: {
        fontSize: 12,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      labelRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      tag: {
        fontSize: 10.5,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: 30,
        padding: '0 8px',
        fontSize: 12.5,
        fontFamily: MONO,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        outline: 'none',
      },
      hint: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      button: {
        height: 30,
        padding: '0 12px',
        fontSize: 12.5,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primary: {
        height: 30,
        padding: '0 14px',
        fontSize: 12.5,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-inverse, #fff)',
        cursor: 'pointer',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      status: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      mono: { fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      good: { fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-state-success-primary)' },
      bad: {
        fontSize: 12,
        lineHeight: '17px',
        color: 'var(--dsw-alias-state-error-primary)',
        wordBreak: 'break-word',
      },
      note: {
        fontSize: 12,
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-word',
      },
    }

    /** A chip glyph for the guide card and the tab title. */
    function JLinkIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('rect', { key: 'chip', x: 4.6, y: 4.6, width: 6.8, height: 6.8, rx: 1.3 }),
        h('path', {
          key: 'pins',
          d: 'M6.3 1.6v3M9.7 1.6v3M6.3 11.4v3M9.7 11.4v3M1.6 6.3h3M1.6 9.7h3M11.4 6.3h3M11.4 9.7h3',
        }),
        h('circle', { key: 'dot', cx: 8, cy: 8, r: 1.1, fill: 'currentColor', stroke: 'none' }))
    }

    /** Same-origin URL of one Host route, honouring a mounted base path. */
    function hostEndpoint(path) {
      try {
        return new URL(path, new URL('.', location.href)).toString()
      } catch {
        return '/' + path
      }
    }

    function workspaceEndpoint(sessionId) {
      const base = hostEndpoint('jlink-debug/workspace')
      return sessionId === '' ? base : base + '?session=' + encodeURIComponent(sessionId)
    }

    /** Turn a Host state document into the editable draft. */
    function draftFromState(state) {
      const draft = {}
      for (const field of Array.isArray(state?.fields) ? state.fields : []) {
        draft[field.key] = field.value === undefined || field.value === null ? '' : String(field.value)
      }
      return draft
    }

    // --------------------------------------------------------- device picker
    //
    // Asking the user to spell a J-Link device name from memory is the one
    // place this panel demanded knowledge of a database. The picker searches
    // the list the installed SEGGER software carries, and keeps the machine's
    // recent choices one click away. A name the library does not know is still
    // accepted: custom device files exist, and the Host already accepts them.

    const D = {
      wrap: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      box: { position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0 },
      input: { ...R.input, padding: '0 26px 0 8px' },
      chevron: {
        position: 'absolute',
        right: 6,
        top: 0,
        bottom: 0,
        width: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        pointerEvents: 'none',
      },
      status: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      statusOk: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-state-success-primary)' },
      statusBad: {
        fontSize: 11.5,
        lineHeight: '16px',
        color: 'var(--dsw-alias-state-warn-primary)',
        wordBreak: 'break-word',
      },
      menu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        zIndex: 30,
        maxHeight: 280,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-overlay)',
        padding: '4px 0',
      },
      section: {
        padding: '6px 10px 2px',
        fontSize: 10.5,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      row: {
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: '5px 10px',
        cursor: 'pointer',
        borderLeft: '2px solid transparent',
      },
      rowOn: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderLeftColor: 'var(--dsw-alias-brand-primary)',
      },
      name: {
        fontFamily: MONO,
        fontSize: 12.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      meta: {
        fontSize: 10.5,
        lineHeight: '14px',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      note: { padding: '8px 10px', fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      foot: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 2,
        padding: '5px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        position: 'sticky',
        bottom: 0,
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      footText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      link: {
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    }

    function Chevron() {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M2.5 4.5 6 8l3.5-3.5' }))
    }

    /** `vendor · core`, plus the base device when this is an alias. */
    function deviceMeta(t, device) {
      const parts = []
      if (typeof device?.vendor === 'string' && device.vendor !== '') parts.push(device.vendor)
      if (typeof device?.core === 'string' && device.core !== '') parts.push(device.core)
      if (typeof device?.base === 'string' && device.base !== '') parts.push(fill(t('picker.alias'), device.base))
      return parts.join(' · ')
    }

    /**
     * The searchable device field.
     *
     * It owns no persisted state: the draft value stays in the parent, so a
     * name typed by hand saves exactly like one picked from the list.
     */
    function DevicePicker(props) {
      const t = props.t
      const value = typeof props.value === 'string' ? props.value : ''
      const disabled = props.disabled === true
      const [open, setOpen] = React.useState(false)
      const [focused, setFocused] = React.useState(false)
      const [typed, setTyped] = React.useState(false)
      const [response, setResponse] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [cursor, setCursor] = React.useState(0)
      const seq = React.useRef(0)
      const alive = React.useRef(true)
      const listRef = React.useRef(null)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const endpoint = (query, refresh) => hostEndpoint('jlink-debug/devices')
        + '?q=' + encodeURIComponent(query)
        + '&limit=60'
        + (refresh === true ? '&refresh=1' : '')

      const load = async (query, refresh) => {
        const id = ++seq.current
        if (alive.current === true) setBusy(true)
        try {
          const reply = await fetch(endpoint(query, refresh), { cache: 'no-store' })
          const data = await reply.json().catch(() => ({}))
          if (id !== seq.current || alive.current !== true) return
          if (reply.ok !== true || data.ok !== true) {
            throw new Error(data.error ?? ('HTTP ' + String(reply.status)))
          }
          setResponse({ query, data })
          setFailure(undefined)
          setCursor(0)
        } catch (error) {
          if (id !== seq.current || alive.current !== true) return
          setFailure(String(error?.message ?? error))
        } finally {
          if (id === seq.current && alive.current === true) setBusy(false)
        }
      }

      // Search as the draft changes, including the initial value the Host
      // loaded: that is what tells the panel whether the saved name is real.
      React.useEffect(() => {
        const query = value.trim()
        const timer = setTimeout(() => { void load(query, false) }, 160)
        return () => clearTimeout(timer)
      }, [value])

      const query = value.trim()
      const data = response !== undefined && response.query === query ? response.data : undefined
      const available = data?.available === true
      const exact = data?.exact ?? null
      const total = Number(data?.total ?? 0)
      const matchedTotal = Number(data?.matched ?? 0)
      const history = Array.isArray(data?.history) ? data.history : []
      const matches = Array.isArray(data?.devices) ? data.devices : []
      // Opening the field shows what was used before; typing narrows the
      // library instead, so the two lists never compete for attention. A name
      // already offered under "Recent" is not repeated under "Matches".
      const showHistory = typed !== true || query === ''
      const recent = history
        .filter((device) => device !== null && typeof device === 'object' && typeof device.name === 'string')
        .slice(0, showHistory ? 6 : 0)
      const historyNames = new Set(recent.map((device) => device.name.toLowerCase()))
      const visibleMatches = matches.filter((device) => !historyNames.has(String(device.name).toLowerCase()))
      const rows = [...recent, ...visibleMatches]

      const choose = (name) => {
        props.onChange(name)
        setOpen(false)
        setCursor(0)
      }

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          if (open !== true) {
            setOpen(true)
            return
          }
          if (rows.length > 0) setCursor((index) => (index + 1) % rows.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          if (open !== true) {
            setOpen(true)
            return
          }
          if (rows.length > 0) setCursor((index) => (index - 1 + rows.length) % rows.length)
          return
        }
        if (event.key === 'Enter') {
          if (open === true && rows[cursor] !== undefined) {
            event.preventDefault()
            choose(rows[cursor].name)
          } else {
            setOpen(false)
          }
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
        }
      }

      // Keep the highlighted row inside the menu without measuring rows.
      React.useEffect(() => {
        if (open !== true) return
        const list = listRef.current
        if (list === null || typeof list.querySelector !== 'function') return
        const row = list.querySelector('[data-selected="true"]')
        if (row !== null && typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ block: 'nearest' })
        }
      }, [open, cursor, response])

      let status = null
      if (failure !== undefined) {
        status = h('div', { style: D.statusBad }, t('picker.failed') + ' · ' + failure)
      } else if (data !== undefined && data.available === false) {
        status = h('div', { style: D.statusBad }, t('picker.failed') + ' · ' + String(data.error ?? ''))
      } else if (available === true && query !== '') {
        // A half-typed name is not a mistake yet; only say "unknown" once the
        // field is left and the value would be the one saved.
        status = exact !== null
          ? h('div', { style: D.statusOk }, '✓ ' + (deviceMeta(t, exact) || String(exact.name)))
          : focused === true
            ? null
            : h('div', { style: D.statusBad }, t('picker.unknown'))
      }

      const row = (device, index) => h('div', {
        key: 'row-' + String(device.name) + '-' + String(index),
        role: 'option',
        'aria-selected': index === cursor,
        'data-selected': index === cursor ? 'true' : 'false',
        style: index === cursor ? { ...D.row, ...D.rowOn } : D.row,
        onMouseDown: (event) => {
          event.preventDefault()
          choose(device.name)
        },
        onMouseEnter: () => setCursor(index),
      },
        h('span', { style: D.name, title: String(device.name) }, String(device.name)),
        deviceMeta(t, device) === ''
          ? null
          : h('span', { style: D.meta }, deviceMeta(t, device)))

      const menu = open !== true ? null : h('div', {
        style: D.menu,
        ref: listRef,
        role: 'listbox',
        id: String(props.id) + '-list',
      }, [
        failure !== undefined
          ? h('div', { key: 'broken', style: D.note }, t('picker.failed') + ': ' + failure)
          : data !== undefined && data.available === false
            ? h('div', { key: 'broken', style: D.note }, String(data.error ?? t('picker.failed')))
            : null,
        data === undefined && failure === undefined
          ? h('div', { key: 'busy', style: D.note }, t('picker.loading'))
          : null,
        recent.length === 0
          ? null
          : h('div', { key: 'recent-head', style: D.section }, t('picker.recent')),
        ...recent.map((device, index) => row(device, index)),
        matches.length === 0
          ? null
          : visibleMatches.length === 0
            ? null
            : h('div', { key: 'match-head', style: D.section },
                t('picker.matches') + (matchedTotal > 0 ? ' · ' + matchedTotal.toLocaleString() : '')),
        ...visibleMatches.map((device, index) => row(device, recent.length + index)),
        available === true && busy !== true && query !== '' && matches.length === 0
          ? h('div', { key: 'none', style: D.note },
              t('picker.none') + ' · ' + fill(t('picker.pressEnter'), query))
          : null,
        available === true && query === '' && recent.length === 0
          ? h('div', { key: 'empty', style: D.note }, fill(t('picker.hintEmpty'), total.toLocaleString()))
          : null,
        h('div', { key: 'foot', style: D.foot },
          h('span', { style: D.footText },
            available === true
              ? fill(t('picker.devices'), total.toLocaleString()) + (data?.jlink ? ' · ' + String(data.jlink) : '')
              : t('picker.library')),
          h('button', {
            type: 'button',
            style: D.link,
            disabled,
            onMouseDown: (event) => {
              event.preventDefault()
              void load(query, true)
            },
          }, t('picker.reload'))),
      ])

      return h('div', { style: D.wrap },
        h('div', { style: D.box },
          h('input', {
            id: props.id,
            type: 'text',
            value,
            placeholder: props.placeholder === undefined || props.placeholder === ''
              ? t('picker.search')
              : props.placeholder,
            disabled,
            spellCheck: false,
            autoComplete: 'off',
            role: 'combobox',
            'aria-expanded': open === true,
            'aria-autocomplete': 'list',
            'aria-controls': String(props.id) + '-list',
            style: D.input,
            onChange: (event) => {
              props.onChange(event.target.value)
              setTyped(true)
              setOpen(true)
            },
            onFocus: () => {
              setFocused(true)
              setTyped(false)
              setOpen(true)
            },
            onClick: () => setOpen(true),
            onBlur: () => {
              setFocused(false)
              window.setTimeout(() => setOpen(false), 120)
            },
            onKeyDown,
          }),
          h('span', { style: D.chevron }, h(Chevron, null)),
          menu),
        status)
    }

    /**
     * The workspace's target form. It follows the session that owns the tab:
     * the Host resolves that session to a workspace and answers with the
     * effective values plus which of them override the global default.
     */
    function TargetPanel(props) {
      const t = props.t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [phase, setPhase] = React.useState('loading')
      const [state, setState] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [note, setNote] = React.useState(undefined)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const adopt = React.useCallback((data) => {
        setState(data)
        setDraft(draftFromState(data))
        setPhase('ready')
      }, [])

      const load = React.useCallback(async () => {
        if (sessionId === '') {
          setPhase('error')
          setNote(t('panel.noSession'))
          return
        }
        setPhase('loading')
        try {
          const response = await fetch(workspaceEndpoint(sessionId), { cache: 'no-store' })
          const data = await response.json().catch(() => ({}))
          if (response.ok !== true || data.ok !== true) {
            throw new Error(data.error ?? ('HTTP ' + String(response.status)))
          }
          if (alive.current !== true) return
          adopt(data)
        } catch (error) {
          if (alive.current !== true) return
          setPhase('error')
          setNote(String(error?.message ?? error))
        }
      }, [adopt, sessionId, t])

      React.useEffect(() => { void load() }, [load])

      const submit = async (body, success) => {
        setPhase('saving')
        setNote(undefined)
        try {
          const response = await fetch(workspaceEndpoint(sessionId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, ...body }),
          })
          const data = await response.json().catch(() => ({}))
          if (response.ok !== true || data.ok !== true) {
            throw new Error(data.error ?? ('HTTP ' + String(response.status)))
          }
          if (alive.current !== true) return
          adopt(data)
          setNote(success)
        } catch (error) {
          if (alive.current !== true) return
          setPhase('ready')
          setNote(String(error?.message ?? error))
        }
      }

      const children = [
        h('div', { key: 'title', style: R.title }, t('panel.title')),
        h('div', { key: 'intro', style: R.intro }, t('panel.intro')),
      ]

      if (phase === 'error') {
        children.push(h('div', { key: 'err', style: R.bad }, String(note ?? t('panel.loadFailed'))))
        children.push(h('div', { key: 'retry', style: R.actions },
          h('button', { type: 'button', style: R.button, onClick: () => { void load() } }, t('panel.refresh'))))
        return h('div', { style: R.page }, children)
      }

      const workspace = state?.workspace
      if (workspace !== undefined) {
        children.push(h('div', { key: 'ws', style: R.workspaceRow },
          h('span', { key: 'label', style: R.tag }, t('panel.workspace')),
          h('span', { key: 'name', style: R.workspaceName, title: workspace.path },
            String(workspace.title || workspace.path || t('panel.directory'))),
          workspace.source === 'directory'
            ? h('span', { key: 'src', style: R.tag }, t('panel.directory'))
            : null))
      }

      const fields = Array.isArray(state?.fields) ? state.fields : []
      if (phase === 'loading' && fields.length === 0) {
        children.push(h('div', { key: 'loading', style: R.intro }, t('hint.running')))
        return h('div', { style: R.page }, children)
      }

      const rows = fields.map((field) => {
        const hintKey = 'panel.hint.' + field.key
        const hint = t(hintKey)
        const control = {
          id: 'jlink-ws-' + field.key,
          value: draft[field.key] === undefined ? '' : draft[field.key],
          onChange: (event) => {
            const value = event.target.value
            setDraft((current) => ({ ...current, [field.key]: value }))
            setNote(undefined)
          },
          style: R.input,
          disabled: phase === 'saving',
          placeholder: field.default === undefined ? '' : String(field.default),
          spellCheck: false,
        }
        const isDevice = field.key === 'device'
        return h('div', { key: field.key, style: R.field },
          h('div', { key: 'label', style: R.labelRow },
            h('label', { htmlFor: control.id }, t('panel.field.' + field.key)),
            h('span', { style: R.tag }, t(field.override ? 'panel.override' : 'panel.default'))),
          isDevice
            ? h(DevicePicker, {
                id: control.id,
                value: control.value,
                placeholder: control.placeholder,
                disabled: control.disabled,
                t,
                onChange: (value) => {
                  setDraft((current) => ({ ...current, device: value }))
                  setNote(undefined)
                },
              })
            : field.kind === 'select'
              ? h('select', control, (field.options ?? []).map((option) =>
                h('option', { key: option, value: option }, option)))
              : h('input', {
                  ...control,
                  type: field.kind === 'number' ? 'number' : 'text',
                  min: field.min,
                  max: field.max,
                }),
          hint === hintKey ? null : h('div', { key: 'hint', style: R.hint }, hint))
      })

      if (rows.length > 0) children.push(h('div', { key: 'form', style: R.card }, rows))

      children.push(h('div', { key: 'actions', style: R.actions },
        h('button', {
          key: 'save',
          type: 'button',
          style: { ...R.primary, opacity: phase === 'saving' ? 0.6 : 1 },
          disabled: phase === 'saving' || rows.length === 0,
          onClick: () => { void submit({ patch: draft }, t('panel.saved')) },
        }, phase === 'saving' ? t('panel.saving') : t('panel.save')),
        h('button', {
          key: 'reset',
          type: 'button',
          style: R.button,
          disabled: phase === 'saving',
          onClick: () => { void submit({ reset: true }, t('panel.resetDone')) },
        }, t('panel.reset')),
        h('button', {
          key: 'refresh',
          type: 'button',
          style: R.button,
          disabled: phase === 'saving',
          onClick: () => { void load() },
        }, t('panel.refresh'))))

      if (note !== undefined) {
        const positive = note === t('panel.saved') || note === t('panel.resetDone')
        children.push(h('div', { key: 'note', style: positive ? R.good : R.note }, note))
      }

      if (state !== undefined) {
        const info = state.session ?? { open: false }
        const sessionText = info.open === true
          ? t('panel.session.open') + (info.state === undefined ? '' : ' · ' + String(info.state))
          : t('panel.session.closed')
        const elf = state.elf ?? {}
        const hasImage = typeof elf.file === 'string' && elf.file !== ''
        children.push(h('div', { key: 'status', style: R.status },
          h('span', { key: 's' }, t('panel.status') + ': ' + sessionText),
          h('span', { key: 'e' }, t('panel.symbols') + ': '
            + (hasImage ? String(elf.symbols ?? 0) + ' / ' + String(elf.functions ?? 0) : '—')),
          hasImage
            ? h('span', { key: 'f', style: R.mono, title: elf.file },
                String(elf.file).split(/[\\/]/).pop())
            : null))
      }

      return h('div', { style: R.page }, children)
    }

    /**
     * Register the target form as a native right-sidebar tab type.
     *
     * The native seat declares `sidebar.right.pane.tab` before it provides
     * `sidebarRightTabs`, so the service has to be awaited through `ctx.inject`
     * instead of read while the slot declaration is being handled.
     */
    function registerRightSidebarTab(ctx, t) {
      return ctx.inject(['sidebarRightTabs'], (scoped) => {
        const tabs = scoped.get('sidebarRightTabs')
        if (tabs === undefined) return undefined
        const disposers = []
        const release = () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              // Already released.
            }
          }
        }
        try {
          disposers.push(tabs.register({
            id: TAB_TYPE_ID,
            kind: TAB_KIND,
            title: () => t('panel.tab'),
            guide: [{
              id: TAB_KIND,
              order: 40,
              title: () => t('panel.nav'),
              description: () => t('panel.guide.description'),
              icon: (iconProps) => h(JLinkIcon, {
                size: iconProps !== null && typeof iconProps === 'object' && typeof iconProps.size === 'number'
                  ? iconProps.size
                  : 16,
              }),
            }],
          }))
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID },
            (props) => h(TargetPanel, { ...props, t }),
          )))
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: TAB_TYPE_ID },
            () => h('span', { style: { whiteSpace: 'nowrap' } }, t('panel.tab')),
          )))
        } catch (error) {
          release()
          throw error
        }
        return release
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let translate
        try {
          ctx.locale.register('mcuDebug', 'en', EN)
          ctx.locale.register('mcuDebug', 'zh', ZH)
          translate = ctx.locale.bind('mcuDebug')
        } catch {
          translate = undefined
        }
        const t = (key) => {
          if (typeof translate === 'function') {
            try {
              const value = translate(key)
              if (typeof value === 'string' && value !== key && value !== '') return value
            } catch {
              // fall through to the bundled English dictionary
            }
          }
          return EN[key] ?? key
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: 'mcu_debug' },
          (props) => h(Card, { ...props, t }),
        ))
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: 'mcu_flash' },
          (props) => h(Card, { ...props, t }),
        ))
        // Machine-level settings: the probe binaries and the tool limits.
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'jlink-debug', order: 55, label: () => t('panel.nav') },
          () => h(SettingsPanel, { t }),
        ))
        // Per-workspace target settings: a native tab in the right sidebar.
        const seat = registerRightSidebarTab(ctx, t)
        ctx.effect(() => () => {
          if (seat !== undefined && typeof seat.dispose === 'function') seat.dispose()
        }, 'jlink-debug-right-tab')
      },
    }
  },
})
