# dsh-jlink-debug

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 SEGGER J-Link 调试插件：agent 可以自己连板子、下断点、单步、按**符号名**读写变量、烧固件，你在对话里看到的卡片和 agent 读到的是同一份数据。

不是"把 J-Link Commander 包一层"。human 用调试器是一步一步点，agent 用调试器是**大量廉价的连续读取**——所以这里做的是一件事：把每次操作的代价压到毫秒级，并且把地址翻译成人能看懂的名字。

```
你: 读一下 SystemCoreClock
agent → read_memory(symbol: "SystemCoreClock")
     ← 0x20000000 = 0x0EE6B280 = 250,000,000
```

---

## 特性

- **持久调试会话**。一次连接，之后每次读写 1–8 ms，而不是每次 fork 一个 `JLink.exe`（约 250 ms 且拿不到 halt 状态）。
- **符号解析**。直接解析固件 `.elf` 的 `.symtab`，不用 `nm`/`objdump`/DWARF 工具链。可以 `breakpoint(symbol: "FDCAN_RxLogTask")`、`read_memory(symbol: "uwTick")`、省略长度时自动读整个变量。
- **PC 自动符号化**。`registers` 直接给 `PC=0x080082BC FDCAN_RxLogTask+0`。
- **可视化配置面板**。设置里一页表单，配器件型号、接口、速率等，不用手改 YAML。
- **对话内卡片**。寄存器网格、hexdump、符号表、烧录日志都在对话里渲染。
- **连接不打扰目标**。attach 不复位内核；读内存只 halt 那一小会儿，读完恢复原来的运行状态。

## 环境要求

| 项 | 说明 |
|---|---|
| 操作系统 | Windows。J-Link 的安装路径发现按 `C:\Program Files\SEGGER` 写死，Linux/macOS 需要改 `jlink.js` 里的 `SEGGER_ROOTS` |
| SEGGER 软件 | 任意较新版本，需要 `JLink.exe` 与 `JLinkGDBServerCL.exe` |
| DeepSeek Harness | 在 0.2.1-rc.3 上开发与验证 |
| 硬件 | 任意 J-Link 探针 + 一块能连上的 MCU（本项目在 STM32H503CBU6 / Cortex-M33 上调通） |

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

- 改了 **Host 代码**（`index.js` / `jlink.js` / `session.js` / `rsp.js` / `elf.js`）→ 在插件管理里关掉再打开，或重启 DSH；
- 改了 **客户端代码**（`client.js` / `locale/*.json`）→ 浏览器按 F5。

## 配置

**设置 → J-Link 调试**（左侧导航最下面），改完点保存。保存会重写这个插件的配置并重载它，所以正在进行的调试会话会断开。

| 字段 | 说明 | 默认 |
|---|---|---|
| MCU / 器件型号 | J-Link 器件库里一模一样的名字，如 `STM32H503CB` | `STM32H503CB` |
| 调试接口 | `SWD` 或 `JTAG`（下拉框） | `SWD` |
| 时钟（kHz） | SWD/JTAG 时钟，100–50000 | `4000` |
| 空闲后释放（ms） | 空闲这么久就把探针让出来给 Ozone/Keil；`0` 表示一直占着 | `120000` |
| 单次读取上限 | `read_memory` 一次最多读多少字节 | `4096` |
| JLink.exe | 绝对路径；留空自动找最新的 SEGGER 安装 | 空 |
| JLinkGDBServerCL.exe | 绝对路径；留空在 `JLink.exe` 旁边找 | 空 |

也可以直接改 `cordis.patch.yml`（这是本插件自带的默认值）：

```yaml
- insert:
    - id: jlink-debug
      name: '@nocardriver/dsh-jlink-debug'
      config:
        device: STM32H503CB
        interface: SWD
        speedKhz: 4000
        maxReadBytes: 512
```

## 工具

### `mcu_debug`

| action | 作用 |
|---|---|
| `status` | 探针身份、内核、运行状态、断点列表、当前镜像的符号数 |
| `connect` | 建立持久会话；默认让内核保持运行（`halt: true` 则连上即停） |
| `disconnect` | 释放探针，Ozone/Keil/JLink.exe 可以接手 |
| `halt` | 停住内核并报告停下来的原因 |
| `resume` | 继续运行，遇到断点再停 |
| `step` | 前进 N 条指令并保持 halt |
| `registers` | r0–r12、sp、lr、pc、xpsr，附带当前异常号和 `PC` 的函数名 |
| `read_memory` | 读一段内存 |
| `write_memory` | 写十六进制字节到 RAM 或外设空间 |
| `breakpoint` | 设置（默认）/ 清除硬件断点 |
| `reset` | 复位内核并停在复位向量 |
| `symbols` | 从固件 `.elf` 里列出 / 搜索符号 |
| `resolve` | 把一个符号名变成地址，查不到时给候选 |

公共参数：

| 参数 | 用于 | 说明 |
|---|---|---|
| `address` | 读/写/断点 | 十六进制或十进制地址，与 `symbol` 二选一 |
| `symbol` | 读/写/断点 | 符号名，自动处理 Thumb 位 |
| `length` | 读 | 省略时用该符号自身的大小，再不然 64 |
| `bytes` | 写 | 如 `"deadbeef"` 或 `"DE AD BE EF"` |
| `count` | 单步 | 默认 1 |
| `clear` | 断点 | `true` 表示清除 |
| `halt` | connect | `true` 表示连上就停 |
| `query` / `kind` / `limit` | symbols | 子串过滤 / `func`、`object`、`any` / 返回条数 |
| `name` | resolve | 要解析的符号名 |
| `file` | 任意 | 这个 `.elf` 的绝对路径，本次会话记住 |

### `mcu_flash`

烧录 `.elf` / `.hex` / `.bin`，校验并启动内核。烧录需要独占探针，所以会先关掉调试会话、烧完再自动恢复。烧的是 `.elf` 时它同时成为符号源。

## 符号是怎么接上的

不指定任何配置。符号源头按这个顺序确定：

1. `mcu_flash` 烧了什么镜像，就用它的符号（最常用，天然正确）；
2. 任何一次调用传了 `file`，就用那个 `.elf`，并在本次会话里记住；
3. 都没有的话，涉及符号的调用会明确告诉你"要么烧一次，要么传 `file`"，普通寄存器读取则只是失去 PC 注释，不会报错。

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

## 实现要点

这几个坑花的时间比功能本身多，写下来免得下次重踩。

**两种传输。** `status` 和烧录走 `JLink.exe -CommandFile`（一次性进程，简单、够快）。真正的调试走 `JLinkGDBServerCL.exe` 加一个手写的 GDB Remote Serial Protocol 客户端（`rsp.js`），因为这是唯一能跨进程保持 halt / 断点状态的通道。

**halt 不跨进程。** `JLink.exe qc` 退出时会清掉 `DHCSR` 的 `C_DEBUGEN`/`C_HALT`，所以"用 Commander 下 halt 再退出"是留不住状态的——这也是必须有持久会话的根本原因。

**RSP 不可重入。** `c` 一旦发出就挂在那里等停止，之后任何包都会排在它后面并可能错位消费回复。`session.js` 里的不变量是：除了 `c` 本身，任何包只能在芯片停止时发出。

**FPB 比较器会钉死芯片。** 硬件断点比较器在调试电源域，不随内核复位清除。上一个进程留下的比较器会让新进程每次 `c` 都在几毫秒内返回、PC 却一个字节都不动，而 `z1` 查不到记录还照样回 OK。解法是在开会话、清断点、关会话时整体写零扫一遍 `FP_CTRL`/`FP_COMP`——顺带成了自愈机制：调试器崩了留下的烂摊子，下次连接自动恢复。

**attach 不能复位。** 连上去就复位会把一个正在跑的系统停回起点，所以 `open()` 默认让内核继续运行（实测连接前后 PC/SP/LR 完全一致），读取也只是 halt 当前这一次调用。

**Thumb 位。** ARM 的 `st_value` 对 Thumb 函数保留 bit 0（`main` 存 `0x080083E5`，`llvm-nm` 显示 `0x080083E4`）。所有对外地址都做 `& ~1`，`nearestSymbol` 也按偶数地址比较，否则每个函数的偏移都会多 1。

## 文件结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：两个工具、`Config` schema、设置页的 HTTP 路由 |
| `jlink.js` | `JLink.exe` 命令行传输：身份/寄存器/内存/复位/烧录，以及安装路径发现 |
| `session.js` | 持久会话：拉起 `JLinkGDBServerCL.exe`、halt/resume/step、断点、内存、FPB 清扫 |
| `rsp.js` | 最小 GDB RSP 客户端（包分帧、ack、无超时的 `c`、`qRcmd`） |
| `elf.js` | ELF32 小端符号表解析器，按 mtime 缓存，无第三方依赖 |
| `client.js` | 客户端半边：对话卡片 + 设置页 |
| `cordis.patch.yml` | 插件行与默认配置 |
| `locale/*.json` | `meta.title` / `meta.description` |
| `smoke.mjs` | 开发用的连通性冒烟脚本 |
| `session-test.mjs` | 开发用的会话回归脚本 |

## 已知限制

- **没有 DWARF**，所以只有"名字 + 地址 + 大小"，拿不到结构体字段名和类型。读一个结构体得到的是整块字节。
- **只支持 ELF32 小端**（Cortex-M 全系如此）；ELF64 会明确报错而不是半解析。
- **读取仍会短暂 halt**（现在 ~8 ms，对高实时性的控制环仍有扰动）。
- **没有 watch / 持续采样**，每次调用是一次快照。
- **没有 RTT**。
- **一个探针同时只能被一个进程占用**，所以 `mcu_flash` 会打断会话。
- 设置页目前只做配置，不能在页面上直接连接/断开。

## 开发

```bash
node smoke.mjs        # 探针能不能找到、能不能连
node session-test.mjs # 持久会话回归：halt/step/断点/内存/复位
```

改了 Host 代码之后重载插件最快的方式，是在插件管理里关掉再打开——不用重启 DSH。

## License

MIT
