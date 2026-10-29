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
      'panel.title': 'J-Link connection',
      'panel.intro': 'How the agent reaches the target. Saving rewrites this plugin\'s configuration and restarts it, so an open debug session ends.',
      'panel.save': 'Save',
      'panel.refresh': 'Refresh',
      'panel.saving': 'Saving…',
      'panel.saved': 'Saved and applied.',
      'panel.pending': 'Saved, waiting for the plugin to restart…',
      'panel.saveFailed': 'The new values did not take effect.',
      'panel.loadFailed': 'Cannot reach the plugin host route.',
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
      'panel.hint.device': 'Exact J-Link device name, e.g. STM32H503CB.',
      'panel.hint.speedKhz': '4000 is safe on short wires; drop to 1000-2000 for a breadboard.',
      'panel.hint.idleCloseMs': '0 keeps the probe until the plugin unloads.',
      'panel.hint.jlinkExe': 'Empty auto-detects the newest SEGGER install.',
      'panel.hint.gdbServerExe': 'Empty auto-detects beside JLink.exe.',
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
      'panel.title': 'J-Link 连接',
      'panel.intro': 'Agent 连接目标的方式。保存会重写这个插件的配置并重启它，正在进行的调试会话会结束。',
      'panel.save': '保存',
      'panel.refresh': '刷新',
      'panel.saving': '保存中…',
      'panel.saved': '已保存并生效。',
      'panel.pending': '已提交，等待插件重启…',
      'panel.saveFailed': '新值没有生效。',
      'panel.loadFailed': '无法连接插件的 Host 路由。',
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
      'panel.hint.speedKhz': '短线 4000 可靠；面包板建议降到 1000–2000。',
      'panel.hint.idleCloseMs': '0 表示插件卸载前一直占着探针。',
      'panel.hint.jlinkExe': '留空则自动找最新的 SEGGER 安装。',
      'panel.hint.gdbServerExe': '留空则在 JLink.exe 旁边自动找。',
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
        h('div', { key: 'title', style: P.title }, t('panel.title')),
        h('div', { key: 'intro', style: P.intro }, t('panel.intro')),
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
        // The connection form: its own row in Settings, where a user looks for
        // plugin configuration.
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'jlink-debug', order: 55, label: () => t('panel.nav') },
          () => h(SettingsPanel, { t }),
        ))
      },
    }
  },
})
