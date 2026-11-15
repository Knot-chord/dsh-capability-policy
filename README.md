# dsh-capability-policy

DeepSeek Harness 插件：把自动化工具按「在哪个面上动手」分成五类，同一目标一回合只放一个动手类进来，每次拦放写一行审计。

![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.5%20%3C0.3.0-blue)
![CI](https://github.com/Knot-chord/dsh-capability-policy/actions/workflows/ci.yml/badge.svg)
![tests](https://img.shields.io/badge/tests-96%20passed-green)
![version](https://img.shields.io/badge/version-1.0.0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

## 痛点

装了多个能操作界面的插件之后，同一件事往往有好几条路：

- 让 agent 打开 Chrome 点个按钮：浏览器插件可以走 DOM，桌面工具可以按坐标点，截图工具还能照着重放一遍；
- 让 agent 在微信发条消息：应用专用工具能发，桌面可访问性树能点，像素模拟也能点。

**没有闸门时会发生什么**：

- 两个类同时动同一个窗口，抢焦点、互相覆盖；
- 模型选错一次就白烧几轮 token；
- 真出了问题去翻日志，也说不清当时为什么走了那条路。

## 它怎么解决

给每个目标记一个「当前由哪一类在动」：

- 同一回合只认一个动手类；
- 只读的调用（截图、读图、列窗口）不占位置；
- 真要换类，按配置决定是问你、直接拒，还是只记账；
- 每一次放行或拒绝，都落一行审计。

分类怎么划、按什么顺序选、一次调用经过哪些判断，集中在下面的[原理](#原理)一节。

## 它不管什么

- **不做**：文件工具、平台 API、美化或纯功能插件——没有「动手」语义的一律不碰。
- **管不到**：插件自己起定时器、不经工具调用就动手的行为。工具层看得见调用，看不见背后的自治逻辑。

## 给谁用

- 同时装了**浏览器 / 桌面 / 像素 / 应用专用**工具中的两个以上；
- 需要事后回答「这次为什么用像素而不是 DOM」；
- 想让自动化只在授权范围内动手——写、发、删这类操作不该悄悄发生。

## 安装

```sh
dsh plugin --profile desktop add github:Knot-chord/dsh-capability-policy
# 锁版本
dsh plugin --profile desktop add "github:Knot-chord/dsh-capability-policy#v1.0.0"
```

装完重载 profile 或重启，插件列表出现 `capability-policy` 即可。自测：`node test/policy.test.mjs`（96 项，零依赖）。

### 装完先验三件事

| # | 做法 | 期望 |
|---|---|---|
| 1 | 先 `windows list`，再 `computer` 的等待动作 | 两次都放行（只读不占位） |
| 2 | 先 `computer` 动手，再 `windows minimize` | 直接拒绝，理由带 `claims.conflict is "deny"` |
| 3 | 查审计文件 | 上面两条各有记录，含 `owner` / `mode` / `decision` / `reason` |

审计位置：`$DSH_PROFILE_DIR/capability-policy/audit.jsonl`。

没有该变量时用 `%LOCALAPPDATA%\dsh-capability-policy\audit.jsonl`；不会写进包目录。

## 原理

不关心实现细节可以跳过本节，不影响使用。

### 分类

按「在哪个面上动手」划分，不按媒介类型（视频、图片、音频）划分。

| 类 | 判定 | 典型工具 |
|---|---|---|
| `app` | 应用自己的语义驱动 | 应用专用工具 |
| `page` | 页面 DOM / CDP | ego_*、browser_* |
| `native` | 桌面可访问性树 | windows、ui_elements |
| `pixel` | 坐标、鼠标、键盘 | computer 的点击与键入 |
| `system` | 改系统状态 | 设置、服务、注册表 |

`capture`（截图、OCR、读图）是只读类：不占目标，也不参与互斥。

### 选择顺序

```text
0 目标    说出目标实例（路径 / URL / 句柄 / 系统项），说不出就不调
1 资格    必须能「完成」这次操作；只能做一半不算合格
2 层级    只留最专的一类：app > page > native > pixel > system
3 授权    改状态先要授权；有可逆路径就优先可逆
4 状态    本轮失败过的出局；没新证据不许重试
5 成本    最便宜的取证：文本先于图像，一次先于多次
```

### 实际发生什么

以桌面上的三次调用为例：

1. `computer` 点一下——没有别的类占用这个窗口，放行，记下「pixel 正在动它」。
2. `windows minimize`——发现 pixel 已经占着，按 `claims.conflict` 拒绝（或询问），写审计。
3. `windows list`——只读，不参与占用，照常放行。

第 2 步拒绝时返回的就是这段文本：

```text
native cannot take this target this turn: pixel:computer holds it and claims.conflict is "deny".
Ask the user to authorize the switch, or set claims.conflict to ask.
```

审计里对应的一行：

```json
{"tool":"windows","owner":"native","mode":"act","decision":"deny","source":"claims","resource":"264138","reason":"pixel:computer (attempts 0)"}
```

## 配置

规则在包内 `rules.json`，hydrate 读一次。

| 字段 | 作用 | 默认 |
|---|---|---|
| `scope.automationOwners` | 受管的类 | 六类全部 |
| `claims.enabled` | 是否启用资源占用 | `true` |
| `claims.conflict` | 冲突裁决：`ask` / `deny` / `allow` | `ask` |
| `claims.groups` | 互斥的类组合，任意一组同时含两类即互斥 | 六个两两组合 |
| `claims.maxAttempts` | 同回合几次「失败换类」，到顶后直接拒绝 | `2`（`0` = 不限） |
| `claims.readOnly[]` / `claims.exempt[]` | 追加只读工具 / 会改状态但不驱动目标面的工具 | 内置常见项 |
| `deny[]` / `ask[]` | 静态拒绝 / 请求确认（正则） | 空 |
| `agents[]` | 按会话 id 或 `prefix` 做白名单 | 空 |
| `owners` | 覆盖内置的类匹配正则 | 内置表 |
| `audit.enabled` / `audit.file` / `audit.maxBytes` | 开关、路径、轮转上限 | `true` / 回退链 / 4 MiB |

> [!WARNING]
> **写错就起不来**：JSON 语法错、正则写坏、组里出现未知类别都会在 hydrate 时抛错并指出具体规则——不会带着半套 deny 静默运行。

> [!IMPORTANT]
> **改完规则要重载**：`index.js` 会热加载，`rules.json` 不会。改完把插件行关掉再打开（或重启），否则跑的是旧规则。

## 兼容性

- **声明**：DSH `>=0.2.1-rc.5 <0.3.0-0`（`engines.dsh`），Node `>=20`。
- **实测**：`0.2.1-rc.5`（独立 `DSH_HOME` 沙盒，waterfall 与 guard 两阶段）、`0.2.2-rc.3`（日常使用）。
- 只核过类型、没实机跑过的版本不写进声明。DSH 升级后先确认这四个接口没变形：`tools.guard`、`tools/pre-execute`、`tools/result`、`systemPrompt.section`。

版本之间确实变过东西：`ToolGuard` 的返回类型到 `0.2.2-rc.3` 才允许对象，之前只认字符串。

本插件的 backstop 因此只返回理由字符串；结构化错误码由 `tools/pre-execute` 那条路径给出。

设计与验证细节见 [SPEC.md](SPEC.md)。

## token 预算

常驻只有一段提示词：1,460 字符（约 406 token）。规则与审计不进上下文，也不新增任何工具。

## 局限

- 只管工具调用路径；插件绕过工具直接动手就拦不住。
- 跨会话只在「同族且键相同」时互斥：页面 URL 与窗口句柄指向同一窗口却无法互证。
- 占用粒度是资源不是工具：同类两个工具之间不互斥。
- 「两次失败后拒绝换类」按会话计次，不是按资源计次。
- 没有 `Config`：以 `link:` 安装时拿不到 `schemastery`，设置页没有可编辑字段，改规则要动 `rules.json` 再重载。

## 变更

### 1.0.0

首个公开版本。

- 五类动手归属，外加只读的 `capture`
- 资源级占用，冲突三态裁决（`ask` / `deny` / `allow`）
- 失败释放占用，换类次数有上限
- `deny` / `ask` / 会话白名单
- JSONL 审计：落点回退、按体积轮转
- 配置写错拒绝启动，不静默降级

支持 DSH `>=0.2.1-rc.5 <0.3.0-0`（下界为实测版本）。

## License

MIT。设计灵感来自 `dsh-find-plugins` 的 `rank.js` 与 `dsh-plugin-resolver` 的 `catalog.js`，吸收原则，未复用常数与权重。
