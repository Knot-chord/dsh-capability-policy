# dsh-capability-policy

DeepSeek Harness 插件：一个**调度器**。每次工具调用被当成一个请求——先看它要动哪个资源（窗口 / 文档元素 / 一个点），再看它用哪种方式动（只看 / 只指过去 / 真正驱动）；同一资源同一回合只发一张租约给驱动方，只读取证与置前从不占位，每次拦放、占用、交接、释放都写一行审计。

![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.5%20%3C0.3.0-blue)
![CI](https://github.com/Knot-chord/dsh-capability-policy/actions/workflows/ci.yml/badge.svg)
![tests](https://img.shields.io/badge/tests-277%20passed-green)
![version](https://img.shields.io/badge/version-2.0.0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

## 痛点

装了多个能操作界面的插件之后，同一件事往往有好几条路：

- 打开 Chrome 点个按钮：浏览器插件走 DOM，桌面工具走可访问性树，像素模拟按坐标点；
- 在微信发条消息：应用专用工具能发，可访问性树能点，像素模拟也能点。

**同一个面被三种语法指着**（URL / 窗口句柄 / 坐标），于是出现三类故障——注意前两类方向相反，闸门只在两个方向都不过界时才有用：

| 故障 | 现场表现 |
|---|---|
| **没人拦** | 两个驱动方（比如浏览器插件和桌面工具）同时上手：抢焦点、互相覆盖。一个刚算好的坐标，被另一个挪了窗口就失效了 |
| **拦得太粗** | 连「置前」「取证」也算占用。初版就是这样栽的：`windows focus` 占住窗口，随后一整回合的点击与网页自动化全被拒，2.5 分钟里撞了 6 次墙 |
| **事后说不清** | 翻日志讲不出「当时谁占着、这一步为什么被拒、后来又是谁把面交出去的」——初版的账本连「那一步是 focus 还是 maximize」都没记 |

前两类决定了这个东西必须是**调度器**而不是更严的名单：它要发租约，也要分得清「驱动」和「只是把面指出来」。

## 它怎么解决

**每次调用是一个请求：先定目标，再定方式。** 只有「驱动」才拿租约；同一资源同一回合只发给一个驱动方。

| 方式 | 含义 | 拿租约吗 | 例子 |
|---|---|---|---|
| `observe` | 只读，采集证据 | 否 | 截图、`windows list`、`ego_snapshot`、`ui_elements` |
| `select` | 只把面指出来，不改它 | 否 | `windows focus`、`open_application`、`ego_tabs switch` |
| `act` | 真正驱动这个面 | **是** | 点击、键入、`ego_click`、`windows maximize` |

- 只读取证永远不占位，否则「先看后动」的降级路径会被自己的取证动作锁死；
- 只指过去也不占位，否则「把窗口切到前台再点」这条最基本的桌面流程根本走不通（初版正是栽在这里）；
- 真要换手，按 `claims.conflict` 决定是问你、直接拒，还是只记账；同一目标被拦太多次就升级为「别再换手了，说出证据来」。

## 它不管什么

- **不仲裁**：没有指名目标的请求。文件工具、搜索、平台 API、纯功能插件都属此类——它们没有可授予的资源，插件只记一行 `unarbitrable`，不猜它们是不是在动界面。
- **管不到**：插件自己起定时器、不经工具调用就动手的行为；以及经由 shell 间接操作界面（`pwsh` 里调 Win32）——工具层只看到一条命令字符串。

## 给谁用

- 同时装了**浏览器 / 桌面 / 像素 / 应用专用**工具中的两个以上；
- 需要事后回答「这次为什么用像素而不是 DOM」；
- 想让自动化只在授权范围内动手——写、发、删这类操作不该悄悄发生。

## 安装

```sh
dsh plugin --profile desktop add github:Knot-chord/dsh-capability-policy
# 锁版本
dsh plugin --profile desktop add "github:Knot-chord/dsh-capability-policy#v2.0.0"
```

装完重载 profile 或重启，插件列表出现 `capability-policy` 即可。自测：`node test/policy.test.mjs`（277 项，零依赖）。

### 装完先验三件事

| # | 做法 | 期望 |
|---|---|---|
| 1 | 先 `windows list`，再 `computer` 的等待动作 | 两次都放行（只读不占位） |
| 2 | `windows focus` 之后 `computer` 点击 | **放行**（置前不占位） |
| 3 | `windows maximize` 之后 `computer` 点击 | 拒绝，理由带占用方与键（最大化改了面，仍占位） |

审计位置：`<profile>/capability-policy/audit.jsonl`（插件由自身安装位置反推 profile，不依赖环境变量）。

## 原理

不关心实现细节可以跳过本节。

### 请求模型

判定**不看工具叫什么，也不猜它是什么**——那是自动化插件自己的知识。调度器只问两件事：

| 问题 | 从哪来 |
|---|---|
| 这次请求要动**哪个资源** | 参数里指名的：窗口标识（`hwnd`/`windowId`…）、元素定位符（`selector`/`ref`…）、坐标（`coordinate`/`x`+`y`） |
| 以什么**方式**动 | 声明表（已知请求形状）；未声明即 `act` |

```
request = { target?, mode }
target : window / document / point        （都没有 ⇒ 没有可仲裁的对象）
mode   : observe（只看） / select（只指过去） / act（驱动）
```

所以一个从没见过的 `adb_tap {x, y}` 会被直接按 `pixel` 仲裁，**不需要任何表行**；而一个没给目标的请求（`{action: "click"}`）不会被猜成任何东西，只记一行 `unarbitrable`。

**完备性主张（可证明）**：说出目标的请求一定进入仲裁；没说目标的请求一定记为 `unarbitrable`。前者靠三种目标语法（封闭），后者靠记账（无遗漏），没有任何请求会静默通过。

互斥矩阵不是手写清单，而是**空间重叠事实的闭包**：`app`/`page`/`native`/`pixel` 都可能指同一个物理面，所以两两互斥；`system` 不是屏幕表面，不参与。

声明表因此只负责**方式**（只读、置前、无目标脚本），不负责覆盖面。完整契约见 [SPEC.md](SPEC.md) 第三节。

### 选择顺序（写进常驻提示词）

```text
0 目标    说出目标实例（路径 / URL / 句柄 / 系统项），说不出就不调
1 资格    必须能「完成」这次操作；只能做一半不算合格
2 层级    只留最具体的空间：app > page > native > pixel
3 授权    改状态先要授权；有可逆路径就优先可逆
4 状态    本轮失败过的出局；没新证据不许重试
5 成本    最便宜的取证：文本先于图像，一次先于多次
```

### 实际发生什么

以桌面上的三次调用为例：

1. `computer` 点一下——没有别的类占这个窗口，放行，记下「pixel 正在动它」。
2. `windows minimize`——发现 pixel 已经占着，按 `claims.conflict` 拒绝（或询问），写审计。
3. `windows list`——只读，不参与占用，照常放行。

第 2 步拒绝时返回的就是这段文本：

```text
native on 264138 cannot take this target this turn: pixel:computer on 264138 holds it and claims.conflict is "deny".
Ask the user to authorize the switch, or set claims.conflict to ask.
```

审计里对应的两行（一次所有权变化 + 一次裁决）：

```json
{"tool":"computer","owner":"pixel","effect":"act","mode":"act","decision":"claim","source":"dispatch","resource":"264138"}
{"tool":"windows","owner":"native","effect":"act","mode":"act","decision":"deny","source":"claims","holder":"pixel:computer","held":"264138","attempts":1,"scope":"s:desktop:264138"}
```

### 交接

`allow` 模式、或 `ask` 被批准后的换手，会把旧租约**显式结束**并写一行 `decision=release, source=transfer`。账本因此能回答「哪个空间把面交给了谁」，而不是静默覆盖、事后无法还原。

### 换手预算

同一目标累计被拦或失败 `claims.maxAttempts` 次后，再换手直接拒绝，要求「结束回合问用户，或给出占用方失败的证据」。失败与争用共用一份预算——初版只给失败计数，事故里连撞六次墙、每行都写着 `attempts 0`。

预算记在**闸门能证明的那个面**上：两面可证相同就按面记（两个确实不同的窗口不共用计数），证不出就按会话记——否则调用方只要换个名字去够同一个面（导航到新 URL、用标题代替句柄）就能把计数重置。**用户批准的切换会退还这一次**：问人不是调用方在自行重试。

## 配置

规则优先从 `<profile>/capability-policy/rules.json` 读，其次包内 `rules.json`（升级会覆盖包内那份）。

| 字段 | 作用 | 默认 |
|---|---|---|
| `scope.spaces` | 受仲裁的空间（不是工具类） | 六个空间全部 |
| `capabilities[]` | 声明表：已知请求形状 → 空间 + 方式（前置，可覆盖内置行） | `[]` |
| `claims.enabled` | 是否启用租约 | `true` |
| `claims.conflict` | 争用裁决：`ask` / `deny` / `allow` | `ask` |
| `claims.groups` | 互斥关系（默认由空间重叠推导） | 六个两两组合 |
| `claims.maxAttempts` | 同一目标几次被拦/失败后拒绝换手 | `2`（`0` = 不限） |
| `claims.ttlMinutes` | 占用兜底过期 | `30` |
| `deny[]` / `ask[]` | 静态拒绝 / 请求确认（正则） | 空 |
| `agents[]` | 按会话 id 或 `prefix` 做名单 | 空 |
| `audit.enabled` / `audit.file` / `audit.maxBytes` | 开关、落点、轮转上限 | `true` / state 目录 / 4 MiB |
| `watch` | 规则文件改动后自动重读 | `true` |

> [!TIP]
> **改完规则不用重载**：`watch: true` 时插件每 2 秒检查一次规则文件，改动后立即生效，并在账本写一行 `config-reloaded`；写坏了会保留上一份好配置并写一行 `config-rejected`（附具体问题）。想彻底关掉就设 `watch: false`。

> [!NOTE]
> **设置页有一个字段**：`rulesFile`（规则文件路径）。schema 只描述规则**放在哪里**，不描述规则内容、也不描述「要不要热重载」——后者是规则文件自己的 `watch`。每一项都只有一个地方能改，不会出现设置页与 JSON 说两套话。若某个安装没把 `schemastery` 暴露给插件，插件照常工作，只是设置页没有字段。

> [!WARNING]
> **写错就起不来**：未知键、拼错、坏正则、未知空间、`capture` 不是 `observe`、空互斥组，都会在 hydrate 时抛错并列出全部问题——不会带着半套 deny 静默运行。旧键同样报错并给出替代：`owners` / `selection` / `claims.readOnly` / `claims.exempt` 对应到 `capabilities`，`scope.automationOwners` 改名为 `scope.spaces`。

## 兼容性

- **声明**：DSH `>=0.2.1-rc.5 <0.3.0-0`（`engines.dsh`），Node `>=20`。
- **实测**：`0.2.2`（`cordis_inspect_query` 逐条核对 `tools/pre-execute`、`tools/execute`、`tools/result`、`agent/turn-stopping`、`agent/disposed` 的签名与类型）。
- `tools/execute` 若不存在或未触发，只会丢失「`ask` 获批后的接管」与「获批退还预算」，检查与占位仍由 `pre-execute` 完成——降级不倒。

## token 预算

常驻只有一段提示词：1,596 字符（约 443 token），另有**只在该回合真的有人占着面时**才追加一行现场占用（最多三条，例如 `desktop:1050872 by windows (native)`），用于免掉「先撞一次墙才知道被占」的浪费。空闲时不追加。规则与审计不进上下文，也不新增任何工具。

## 局限

- 只管工具调用路径；插件绕过工具直接动手就拦不住。
- **没说出目标的请求不仲裁**：只按焦点动作的调用（某个 `rdp_type {text}`）、只给 `url` 的调用、经 shell 的间接操作，都没有可授予的资源，落 `unarbitrable` 记账而不拦。声明一行就能纳入。
- **跨族身份不可互证**：页面 URL 与窗口句柄指向同一窗口，插件证明不了它们不同，于是全局一律按同一面处理——包括跨会话与子代理。保守方向（宁可多拦），拒绝理由会提示「显式给出 url / hwnd」。靠标题去猜不行——猜错的方向恰好是危险的。
- 因此 `page` 的 URL 键不影响裁决，只影响审计可读性与「可证时」的预算粒度；**但升级不再依赖它**，换 URL 重置计数这条路已封死。
- 占用粒度是资源不是工具：**同一会话内**同类两个工具之间不互斥（它们是一个驱动方）；不同会话即使同类，在证不出不同的面上也会争用。
- `ask` 在无审批应答者时退化为拒绝；那条路径上插件看不到「其实被拒了」，所以预算不累积——此时 `deny` 模式语义更完整。
- 热重载是 2 秒轮询，不是 inotify；改动后最多等一个周期。
- 审计只保留一份历史（`.1`）。

## 版本

当前版本 2.0.0。每个版本改了什么见 [Releases](https://github.com/Knot-chord/dsh-capability-policy/releases)；这里只描述现在这个版本。

## License

MIT。设计灵感来自 `dsh-find-plugins` 的 `rank.js` 与 `dsh-plugin-resolver` 的 `catalog.js`，吸收原则，未复用常数与权重。


