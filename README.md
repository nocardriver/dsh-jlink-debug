# dsh-jlink-debug

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 SEGGER J-Link 调试插件：agent 可以自己连板子、下断点、单步、按**符号名**读写变量、烧固件，你在对话里看到的卡片和 agent 读到的是同一份数据。

不是"把 J-Link Commander 包一层"。human 用调试器是一步一步点，agent 用调试器是**大量廉价的连续读取**——所以这里做的是一件事：把每次操作的代价压到毫秒级，并且把地址翻译成人能看懂的名字。

```
你: 读一下 SystemCoreClock
agent → read_memory(symbol: "SystemCoreClock")
     ← 0x0EE6B280 = 250,000,000
```

结构体也一样，不用自己算偏移：

```
你: foc_isr 现在什么状态？
agent → read_memory(symbol: "foc_isr")
     ← { active_motor: -1, ready: 1, calc_cnt: 57915006, ... }
agent → type(name: "foc_isr_shared_t")
     ← 7 个字段：target_pos@0、active_motor@64、calc_cnt@68 ...
```

而且可以连续看，不用一次次问：

```
你: 采 2 秒电机角度，10 ms 一个点
agent → capture(symbols: ["motor[0].electric_angle"], samples: 200, periodMs: 10)
     ← 200 个点：min -3.14、max 3.14，曲线画在对话里
```

采样走探针的后台内存访问，**内核照常跑**，不会把 FOC 控制环停掉。

---

## 特性

- **持久调试会话**。一次连接，之后每次读写 1–8 ms，而不是每次 fork 一个 `JLink.exe`（约 250 ms 且拿不到 halt 状态）。
- **符号 + 类型解析**。直接解析固件 `.elf` 的 `.symtab` 和 DWARF 2–5，不依赖 `nm`/`objdump`/`readelf`。`read_memory(symbol: "foc_isr")` 直接给出 `active_motor: -1`、`calc_cnt: ...` 这样的字段值；`type` 打印结构体的字段名、偏移、大小和枚举值。`breakpoint(symbol: "FDCAN_RxLogTask")`、`read_memory(symbol: "uwTick")` 也照常可用。
- **watch / 持续采样**。`capture` 一次调用采一段轨迹，`watch` 让探针在后台按固定周期采样，右侧面板里直接画曲线。采样走 J-Link 的**后台内存访问**（MEM-AP），不停内核：实测 170 MHz 的 Cortex-M4 上连续 40 次读取，内核执行周期与墙钟时间之比不变（174 MHz 有效频率）。
- **PC 自动符号化**。`registers` 直接给 `PC=0x080082BC FDCAN_RxLogTask+0`。
- **按工作区的目标设置**。芯片型号、调试接口、时钟属于某一块板子，所以放在**右侧边栏 → J-Link** 面板里，每个工作区各存一份；`JLink.exe` 路径这类本机设置才留在全局设置页。
- **器件库里搜索，不用背型号**。MCU 字段直接搜 J-Link 内置器件表（型号、厂商、内核、别名），下拉里还保留这台机器最近 12 个选择。
- **对话内卡片**。寄存器网格、hexdump、符号表、烧录日志、watch 曲线都在对话里渲染。
- **连接不打扰目标**。attach 不复位内核；运行中的读内存走后台访问，不 halt 内核；只有写内存、读寄存器、单步这类必须停核的操作才临时 halt，做完恢复原来的运行状态。

## 环境要求

| 项 | 说明 |
|---|---|
| 操作系统 | Windows。J-Link 的安装路径发现按 `C:\Program Files\SEGGER` 写死，Linux/macOS 需要改 `jlink.js` 里的 `SEGGER_ROOTS` |
| SEGGER 软件 | 任意较新版本，需要 `JLink.exe` 与 `JLinkGDBServerCL.exe`。器件列表用 `ExpDevListXML` 导出；更老的版本会自动退回 `ExpDevList` 的 CSV |
| DeepSeek Harness | 在 0.2.1-rc.3 上开发与验证 |
| 硬件 | 任意 J-Link 探针 + 一块能连上的 MCU（本项目在 STM32G431CBU6 / Cortex-M4 与 STM32H503CBU6 / Cortex-M33 上调通） |

## 安装

先装这个插件自己的两个依赖（只用于 `Config` schema 校验）：

```bash
cd dsh-jlink-debug
pnpm install     # 或 npm install
```

> profile 安装的是**目录链接**，Node 会按真实路径解析 import，所以依赖必须落在插件目录自己的 `node_modules/` 里，装在别处不生效。

装不上（内网、镜像源没有）也可以把一个能用的 `node_modules/@deepseek-ai/{schemastery,cosmokit}` 直接拷进插件目录——它们只用来定义 `Config` schema，不参与调试逻辑。

然后让 DSH 里的 agent 把它装进 profile：

> 用 `plugin_manager` 安装 `C:\path\to\dsh-jlink-debug`（`install_bundle`，target 填这个目录的绝对路径）

装完：

- 改了 **Host 代码**（`index.js` / `jlink.js` / `session.js` / `watch.js` / `rsp.js` / `elf.js` / `dwarf.js`）→ 在插件管理里关掉再打开，或重启 DSH；
- 改了 **客户端代码**（`client.js` / `locale/*.json`）→ 浏览器按 F5。

## 配置

配置分两层：

### 工作区内：右侧边栏 → J-Link

芯片型号、调试接口、时钟是某一块板子的属性，所以按**工作区**保存：

1. 打开右侧边栏（对话右上角的侧栏按钮，或默认快捷键）。
2. 点标签栏末尾的 `+` 打开引导页，选 **J-Link 调试**；之后它就是一个常驻标签（布局按会话保存在浏览器里）。
3. 点 **MCU / 器件型号** 输入框：下拉里先是这台机器最近用过的型号，下面是 J-Link 器件库的搜索结果。输入任意片段即可过滤（大小写不敏感；空格分词，`stm32 h503` 和 `stm32h503` 都能搜到），每行带厂商和内核；`↑` / `↓` 选择、`Enter` 确认、`Esc` 关闭。库里没有的名字也可以直接输入。
4. 设置调试接口和时钟，点**保存**。
5. 往下是**实时观测**：输入符号或成员路径（`uwTick`、`motor[0].electric_angle`、`foc_isr.uq_out[1]`）回车加入观测点，选采样周期（10–500 ms），点**开始采样**。每行显示当前值、min/max 和实时曲线；**暂停/运行内核**按钮用来在断点停住后继续。采样在 Host 里进行，切走标签或刷新页面不会中断。

器件库来自已安装的 J-Link 软件：Host 让 `JLink.exe` 用 `ExpDevListXML` 把 DLL 内置的器件表导出来（本机 V9.52 是 27,959 个可选的器件名 / 别名），解析后缓存到 profile 目录下的 `jlink-debug/devices.json`。第一次打开面板约 1 秒，之后是一次查询；J-Link 升级后按 DLL 的修改时间自动重建，也可以点下拉底部的**重新读取**。搜不到时面板会提示"J-Link 器件库里没有这个型号"，但仍按你输入的值保存——自定义器件文件或器件包里的型号可以这样填。

最近选择的型号存在同目录的 `history.json` 里（最多 12 个，按机器共享，不按工作区）：保存工作区设置、agent 首次 `connect`、`mcu_flash` 成功都会记一笔。下拉打开时"最近使用"一直在，不受当前输入影响。

面板只对当前会话所属的工作区生效：换一个工作区，读到的就是那个工作区自己的值。每个字段旁标着 `默认`（跟随全局）或 `已覆盖`（本工作区自己的值）；**用全局默认**会清掉本工作区的覆盖。保存时如果探针正连在旧参数上，会先释放探针，下一次调用按新参数重新连接。

这些值存在 `~/.dsh/jlink-debug/workspaces.json`（Host 有 `DSH_PROFILE_DIR` 时优先放在 profile 目录下），不写进你的代码仓库。

### 本机级：设置 → J-Link 调试

只放和具体板子无关的东西：

| 字段 | 说明 | 默认 |
|---|---|---|
| 空闲后释放（ms） | 空闲这么久就把探针让出来给 Ozone/Keil；`0` 表示一直占着 | `120000` |
| 单次读取上限 | `read_memory` 一次最多读多少字节 | `4096` |
| JLink.exe | 绝对路径；留空自动找最新的 SEGGER 安装 | 空 |
| JLinkGDBServerCL.exe | 绝对路径；留空在 `JLink.exe` 旁边找 | 空 |

保存会重写这个插件的配置并重载它，正在进行的调试会话会断开。

`Cordis` 的 `Config` 里仍保留 `device` / `interface` / `speedKhz`，它们只作为**工作区没有覆盖时的默认值**。可以直接改 `cordis.patch.yml` 来改这些默认值：

```yaml
- insert:
    - id: jlink-debug
      name: '@nocardriver/dsh-jlink-debug'
      config:
        device: STM32H503CB
        interface: SWD
        speedKhz: 4000
        maxReadBytes: 1024
```

## 工具

### `mcu_debug`

| action | 作用 |
|---|---|
| `status` | 探针身份、内核、运行状态、断点列表、当前镜像的符号数和 DWARF 类型数 |
| `connect` | 建立持久会话；默认让内核保持运行（`halt: true` 则连上即停） |
| `disconnect` | 释放探针，Ozone/Keil/JLink.exe 可以接手 |
| `halt` | 停住内核并报告停下来的原因 |
| `resume` | 继续运行，遇到断点再停 |
| `step` | 前进 N 条指令并保持 halt |
| `registers` | r0–r12、sp、lr、pc、xpsr，附带当前异常号和 `PC` 的函数名 |
| `read_memory` | 读一段内存；用 `symbol` 时按 DWARF 类型解码成字段值 |
| `write_memory` | 写十六进制字节到 RAM 或外设空间 |
| `breakpoint` | 设置（默认）/ 清除硬件断点 |
| `reset` | 复位内核并停在复位向量 |
| `symbols` | 从固件 `.elf` 里列出 / 搜索符号，对象附带 DWARF 类型名；`query` 也匹配类型名 |
| `type` | 打印一个类型或变量的布局：字段名、偏移、大小、枚举值 |
| `resolve` | 把一个符号名变成地址，查不到时给候选 |
| `watch` | 开始后台持续采样：`symbols` + `periodMs`，返回解析出的地址/类型 |
| `watch_read` | 读最近的样本和 min/max/mean；`waitMs` 等到够 `samples` 个点再返回 |
| `watch_stop` | 停止采样并返回最终统计 |
| `capture` | 一次调用采 `samples` 个点后返回完整轨迹（适合 agent 直接要一段波形） |

公共参数：

| 参数 | 用于 | 说明 |
|---|---|---|
| `address` | 读/写/断点 | 十六进制或十进制地址，与 `symbol` 二选一 |
| `symbol` | 读/写/断点 | 符号名，自动处理 Thumb 位 |
| `length` | 读 | 省略时用该符号自身的大小，再不然 64；小于类型大小时只解码读到的前缀 |
| `bytes` | 写 | 如 `"deadbeef"` 或 `"DE AD BE EF"` |
| `count` | 单步 | 默认 1 |
| `clear` | 断点 | `true` 表示清除 |
| `halt` | connect | `true` 表示连上就停 |
| `query` / `kind` / `limit` | symbols | 子串过滤（也匹配类型名）/ `func`、`object`、`any` / 返回条数 |
| `name` | type / resolve | `type` 要查的类型名或变量名；`resolve` 要解析的符号名 |
| `depth` | type / 读 | 展开多少层嵌套结构体/数组；`type` 默认 2，读默认 4 |
| `file` | 任意 | 这个 `.elf` 的绝对路径，记到当前工作区 |
| `symbols` | watch / capture | 观测点：符号名或成员路径，如 `motor[0].electric_angle`、`foc_isr.uq_out[1]`；最多 24 个 |
| `periodMs` | watch / capture | 采样周期（5–5000 ms），默认 20 |
| `samples` | watch_read / capture | watch_read 返回多少个点（默认 60）；capture 采多少个点（默认 100） |
| `waitMs` | watch_read | 最多等多久攒够 `samples` 个点，默认 0 |
| `resume` | watch / capture | 内核停着时先恢复运行，否则样本不会变化 |

### 持续采样（watch / capture）

[SEGGER 的 HSS](https://kb.segger.com/J-Link_High-Speed_Sampling) 说明 Cortex-M 支持“后台内存访问”：探针通过 AHB-AP 读内存，CPU 继续跑。J-Link GDB Server 的 `ReadMemAP` monitor 命令正好能利用它，而且**在 `c` 还挂着的时候也会回包**——这个插件就是用这条通道做 watch 的。

```
你: 采 2 秒 motor[0].electric_angle 和 foc_isr.calc_cnt，10 ms 一个点
agent → capture(symbols: ["motor[0].electric_angle", "foc_isr.calc_cnt"], samples: 200, periodMs: 10)
     ← items[0]: last 1.57, min -3.14, max 3.14, samples: [...]
```

```
你: 一直盯着 foc_isr.calc_cnt，我看的时候再读
agent → watch(symbols: ["foc_isr.calc_cnt"], periodMs: 20, resume: true)
agent → watch_read(samples: 100, waitMs: 3000)     # 攒够 100 个点
agent → watch_stop()
```

规则：

- 采样**不停内核**。实测 STM32G431 @170 MHz：40 次后台读取耗时 84 ms，期间内核执行了 14.4 M 个周期（≈170 MHz），有效频率与空闲时一致。
- 读的是**表达式**，不是整个结构体。`motor[0].velocity_pid_data.Kp` 只读 4 字节；成员路径按 DWARF 解析，位域和不存在的成员会明确报错，不会退化成读整个结构体。
- 相邻地址自动合并成一次读取（间隔 ≤16 B，单次 ≤512 B），所以结构体里几个字段只花一次 monitor 往返。
- 每个观测点保留最近 8192 个样本（`watch`）或本次 capture 的点数；`watch_read` 返回 min/max/mean/distinct 和最近的样本。
- 在右侧边栏的 J-Link 面板里也能直接加观测点、选周期、看实时曲线；面板只是轮询 Host 路由，关掉面板或刷新页面都不会中断采样。
- 内核停着（断点/手动 halt）时照样能采，只是样本不变；结果里会标 `target halted`。`resume: true` 会先恢复运行。
- 断点在 `monitor go` 下是静默停机（没有 stop 回包），watch 每秒读一次 `DHCSR.S_HALT` 发现它，状态会变成 `halted`。
- 运行中的 watch 会一直占着探针（"空闲后释放" 对它不生效），这样曲线不会在你看的时候断掉；点**停止**、`watch_stop`、`disconnect` 或烧录才会释放。

### `mcu_flash`

烧录 `.elf` / `.hex` / `.bin`，校验并启动内核。烧录需要独占探针，所以会先关掉调试会话、烧完再自动恢复。烧的是 `.elf` 时它同时成为符号源。

## 符号是怎么接上的

符号源头按这个顺序确定，并且记在**当前工作区**上：

1. `mcu_flash` 烧了什么镜像，就用它的符号（最常用，天然正确）；
2. 任何一次调用传了 `file`，就用那个 `.elf`，并存到这个工作区；
3. 都没有的话，涉及符号的调用会明确告诉你"要么烧一次，要么传 `file`"，普通寄存器读取则只是失去 PC 注释，不会报错。

换工作区不会继承上一个工作区的镜像，所以两个工程来回切时 `PC` 的注释不会串。

## 结构体怎么读

`type` 和 `read_memory` 的类型信息来自同一个 ELF 的 DWARF（`.debug_info`），和符号表一起按 ELF 的 mtime 缓存：

```
type(name: "FOC_motor_dev")
→ 22 个字段：motor_id@0、velocity_pid_data@32、status@168 ...

read_memory(symbol: "foc_isr")
→ value: { target_pos: [0,0,0,0], ..., active_motor: -1, ready: 1, calc_cnt: 53685146 }

symbols(query: "foc_isr_shared_t", kind: "object")
→ foc_isr  0x20001E90  72 B  object · foc_isr_shared_t
```

规则：

- 支持 DWARF 2–5、ELF32 小端，覆盖 Arm GCC / clang（ATfE）的常见输出；不依赖外部 `readelf`/`dwarfdump`。
- 只解码**有静态地址的全局/文件级变量**。局部变量需要位置列表和 frame base，暂不支持。
- 指针只显示地址，不自动追（避免一次读取变成不可控的指针链）；要读指针目标，用 `resolve` 找到符号或直接 `read_memory(address: ...)`。
- `char[]` 和可打印的单字节数组按字符串显示，其余数组按数字数组；数组最多展开 64 个元素，超出部分标 `<N more>`。
- `read_memory` 默认读整个符号。符号比“单次读取上限”大时只解码读到的前缀，结果里 `valuePartial: true`；把上限调大即可读全（例如 `FOC_motor_dev[4]` 是 704 B）。
- 镜像 strip 掉 DWARF（常见 Release）时，符号/地址/原始字节仍然可用，`type` 会明确报 `.debug_info` 缺失，不会退回半解析。

## 实测

STM32H503CBU6（Cortex-M33 r0p4）+ J-Link，655 个符号 / 312 个函数 / 50 个全局对象：

| 操作 | 每命令一进程 | 持久会话 |
|---|---|---|
| 读寄存器 | ~260 ms | **5–8 ms** |
| 读 256 B | ~260 ms | **2 ms** |
| halt | 不可用 | **0–6 ms** |
| 单步 ×3 | 不可用 | **16 ms** |
| 设/清断点 | 不可用 | **0–1 ms** |
| 写内存 | 不可用 | **1 ms** |
| 建立会话 | — | 259 ms（一次性） |
| 复位 | 73 ms | 73 ms（两边都是目标自身复位主导） |
| 释放 | — | 3–9 ms |

本机用 MotorTest 的 ATfE-Debug 镜像（71 个 CU / 289 个类型名 / 834 个变量）实测：DWARF 首次解析约 40 ms，之后按 ELF mtime 缓存；读 704 B 的 `motor[4]` 并解码 4 个 `FOC_motor_dev`（每个含 3 个 PID 子结构）仍是一次探针读取。

后台采样（STM32G431CB @170 MHz，MotorTest 运行中）：

| 操作 | 结果 |
|---|---|
| 单次后台读 4 B（`ReadMemAP`） | 2–3 ms（host 往返，目标零耗时） |
| 40 次后台读期间内核执行周期 | 14.43 M ≈ 174 MHz 有效频率（对照空闲 169.8 MHz） |
| 10 ms 周期、5 个观测点（3 次合并读） | 每 tick 约 7–9 ms，偶有丢点 |
| 20 ms 周期 | 稳定，2 秒内 100 个点 |

## 实现要点

这几个坑花的时间比功能本身多，写下来免得下次重踩。

**两种传输。** `status` 和烧录走 `JLink.exe -CommandFile`（一次性进程，简单、够快）。真正的调试走 `JLinkGDBServerCL.exe` 加一个手写的 GDB Remote Serial Protocol 客户端（`rsp.js`），因为这是唯一能跨进程保持 halt / 断点状态的通道。

**halt 不跨进程。** `JLink.exe qc` 退出时会清掉 `DHCSR` 的 `C_DEBUGEN`/`C_HALT`，所以"用 Commander 下 halt 再退出"是留不住状态的——这也是必须有持久会话的根本原因。

**RSP 不可重入，但 monitor 包例外。** `c` 一旦发出就挂在那里等停止，普通包（`m`/`g`/`Z1`/`s`）排在它后面，回复会错位——所以 `#send` 在运行态直接拒绝发包。

**`c` 会毁掉后台读。** 直觉做法是发 `c` 让内核跑、再穿插 `qRcmd ReadMemAP` 采样；J-Link GDB Server 确实会在 `c` 挂着时回 monitor 包，但每回一个包它都会**临时 halt 内核**再继续：实测 40 次读期间内核只执行了 31 MHz 的等效周期（应为 170 MHz），等于一直在停。所以运行控制整体换成 `monitor go` / `monitor halt`：两者立即回 `OK`，没有挂起包，后台读才是真不停核（174 MHz）。

**代价：断点停机没有回包。** GDB 的 `T05` 是 `c` 的回包；改用 `monitor go` 后内核停在断点处，server 并不知情。`refresh()` 因此读 `DHCSR.S_HALT`（0xE000EDF0 bit 17）判断，发现停机后再发一次 `monitor halt` 让 server 同步，之后 `g` 才是真寄存器。`status` 和运行中的 watch 每秒各查一次。

**`Buffer.map` 不是数组 `map`。** `encodeHexBytes(Buffer.from(text))` 会走 `TypedArray.prototype.map`，回调返回的 `"6d"` 被强转成字节，得到一个坏包；`reset` 的 monitor 命令因此一直没生效。改成 `Array.from(bytes, …)`。

**FPB 比较器会钉死芯片。** 硬件断点比较器在调试电源域，不随内核复位清除。上一个进程留下的比较器会让新进程每次 `c` 都在几毫秒内返回、PC 却一个字节都不动，而 `z1` 查不到记录还照样回 OK。解法是在开会话、清断点、关会话时整体写零扫一遍 `FP_CTRL`/`FP_COMP`——顺带成了自愈机制：调试器崩了留下的烂摊子，下次连接自动恢复。

**attach 不能复位。** 连上去就复位会把一个正在跑的系统停回起点，所以 `open()` 默认让内核继续运行（实测连接前后 PC/SP/LR 完全一致）。运行中的读也不再 halt：`readMemory` 走 MEM-AP；只有写内存、读寄存器、单步这类必须停核的操作才用 halt 窗口。

**冷启动时 `webServer` 还不存在。** 插件行比 Web 服务先挂载，启动时 `ctx.get('webServer')` 拿到的是 `undefined`，一次性的判断会静默跳过路由注册，结果工具能用、两个面板却全是 HTTP 404（要先手动重载插件才恢复）。路由必须走 `ctx.inject(['webServer'], ...)`，等服务出现再注册。

**器件表不在文件里。** 新版 J-Link 安装目录里没有 `JLinkDevices.xml`，器件库在 DLL 内部；`JLink.exe` 的 `ExpDevListXML <文件名>` 是能拿到全表的入口（`ExpDevList` 只给基础器件，没有别名）。命令里的路径不能带空格——Commander 不剥引号，实测带空格会静默不写文件——所以导出时把子进程的工作目录设成临时目录、只传相对文件名。也验证过 GDB server 占着探针时导出仍然成功：Commander 先执行脚本命令，之后才去连探针。

**Thumb 位。** ARM 的 `st_value` 对 Thumb 函数保留 bit 0（`main` 存 `0x080083E5`，`llvm-nm` 显示 `0x080083E4`）。所有对外地址都做 `& ~1`，`nearestSymbol` 也按偶数地址比较，否则每个函数的偏移都会多 1。

## 文件结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：两个工具、`Config` schema、工作区设置的读写与四条 HTTP 路由（config / workspace / devices / watch） |
| `devices.js` | J-Link 器件库：`ExpDevListXML` 导出与解析、按安装缓存、搜索、最近选择 |
| `jlink.js` | `JLink.exe` 命令行传输：身份/寄存器/内存/复位/烧录，以及安装路径发现 |
| `session.js` | 持久会话：拉起 `JLinkGDBServerCL.exe`、monitor 运行控制、halt/resume/step、断点、后台 MEM-AP 读、FPB 清扫 |
| `watch.js` | watch 引擎：观测点合并成读窗口、按周期采样、环形缓冲、统计、`waitFor` |
| `rsp.js` | 最小 GDB RSP 客户端（包分帧、ack、`qRcmd`、事件回调、`DSH_JLINK_RSP_TRACE=1` 包日志） |
| `elf.js` | ELF32 小端符号表解析器，按 mtime 缓存，无第三方依赖 |
| `dwarf.js` | ELF32 小端 DWARF 2–5 解析器：类型布局、全局变量地址、成员路径解析、按类型解码内存，无第三方依赖 |
| `client.js` | 客户端半边：对话卡片（hexdump、解码后的字段树、类型布局表、watch 曲线）+ 右侧边栏的 J-Link 标签（器件搜索下拉 + 实时观测）+ 全局设置页 |
| `cordis.patch.yml` | 插件行与默认配置 |
| `locale/*.json` | `meta.title` / `meta.description` |
| `smoke.mjs` | 开发用的连通性冒烟脚本 |
| `session-test.mjs` | 开发用的会话回归：attach、后台读不扰动、halt/step/断点检测/复位/释放 |
| `watch-test.mjs` | 开发用的 watch 回归：DWARF 路径、采样、统计、trace 内容 |
| `tool-test.mjs` | 开发用的工具回归：在 stub Cordis 里挂载插件，跑 connect/capture/watch/status/halt |
| `client-smoke.mjs` | 客户端渲染冒烟：用 stub React 渲染卡片与面板，检查关键内容 |
| `devices-test.mjs` | 开发用的器件库脚本：导出、解析、缓存、搜索、历史 |
| `dwarf-test.mjs` | 开发用的 DWARF 脚本：解析 ATfE/GCC 两种 ELF、字段偏移、按类型解码、strip 镜像报错 |

## 已知限制

- **DWARF 解析只覆盖 C 的全局/文件级变量**：局部变量、内联实例、位置列表不在范围内；`type` 查询类型本身不受影响。
- **只支持 ELF32 小端 / DWARF32**（Cortex-M 全系如此）；ELF64、DWARF64 会明确报错而不是半解析。split DWARF（`.dwo`/`.dwp`）也不支持。
- **指针不自动追**：解码结果是地址字符串。要读 `motor[0].moving_angle_ptr` 指向的值，先用 `resolve` 查它指向的符号，或按地址再读一次。
- **解码输出有上限**：数组最多 64 个元素；`read_memory` 超过“单次读取上限”的符号只解码前缀。
- **写内存、读寄存器、单步仍会短暂 halt**（读内存已改为后台访问，不再停核）。
- **watch 的每个观测点只画数值**：结构体/字符串能显示当前值，但不进曲线；要画哪个字段就写成员路径。
- **后台读依赖 GDB Server 的 `ReadMemAP`**。老版本（或个别器件）不认这条 monitor 命令时会退回“halt—读—恢复”，watch 仍能用但会扰动目标；`status` 的 `backgroundReads` 可以看出来。
- **静默停机靠 DHCSR 发现**：`monitor go` 下断点没有停止回包，`refresh()` 每秒读一次 `DHCSR.S_HALT`；Cortex-M0/M0+ 没有 DHCSR 的 S_HALT 位时，断点后的状态要等下一次 `halt`/`registers` 才更新。
- **没有 RTT**。
- **一个探针同时只能被一个进程占用**，所以 `mcu_flash` 会打断会话；工作区之间切换目标也会释放探针。
- **符号源按工作区记忆**：`mcu_flash` 烧过哪个 `.elf`，这个工作区之后就用它的符号，不会串到别的工程。
- 设置页和右侧面板只做配置与观测，agent 的 `mcu_debug` 负责连接/断点/烧录这类操作；面板的 watch 区可以开始/停止采样、恢复/暂停内核，但不设置断点。

## 开发

```bash
node smoke.mjs        # 探针能不能找到、能不能连
node session-test.mjs # 会话回归：后台读、halt/step/断点检测/复位（可用 JLINK_TEST_DEVICE 换器件）
node watch-test.mjs   # watch：DWARF 路径解析 + 真实采样 + 统计
node tool-test.mjs    # 工具面：stub Cordis 里挂载插件，跑 capture/watch/watch_read/status
node client-smoke.mjs # 客户端渲染：卡片和面板在 stub React 下渲染
node devices-test.mjs # 器件库：导出耗时、解析条数、搜索排名、历史读写
node dwarf-test.mjs   # DWARF：解析、字段偏移、解码、strip 镜像报错
```

排查协议问题时设 `DSH_JLINK_RSP_TRACE=1`，`rsp.js` 会把每个收发包打到控制台。

改了 Host 代码之后重载插件最快的方式，是在插件管理里关掉再打开——不用重启 DSH。

## License

MIT
