# @local/dsh-capability-policy — 设计、现状与需求对照

版本：2.0.0 · 支持 DSH `>=0.2.1-rc.5 <0.3.0-0`（接口按 0.2.2 的 `cordis_inspect_query` 目录核对）

---

## 一、为什么是「请求」，不是「工具分类」

初版的判断依据是工具名：一张「工具名 → 归属」的正则表，外加一张只读名单和一张「改状态但不驱动」的豁免名单。这三张表都不携带**这一下到底动了哪个面**的信息，于是每遇到一个语义相同、名字不同的工具就得补一行——`open_application` 被补进豁免，`windows focus` 没被补，事故就是这么发生的。

换掉的是判断依据，不是补表：**每次调用被读成一个请求**——它指名的目标（窗口句柄 / 页面元素 / 屏幕坐标）＋它要求的方式（只看 / 只指过去 / 驱动）。这个判断只依赖参数和调用方给出的目标，与工具叫什么无关；新插件不需要往任何表里加一行。

其余结论都是从这一点长出来的：

| 问题 | 结论 | 理由 |
|---|---|---|
| 「只看」「只是把面指出来」要不要占位 | 不要 | 占位会锁死它本该服务的降级路径（先看后动、先置前再点） |
| 没命中任何声明的工具怎么办 | 指名了目标就按目标仲裁；没指名就记账，不猜 | 猜错会让仲裁直接错，而不确定时不动正是本插件的存在理由 |
| 两个空间能不能同时驱动 | 只有能证明是不同面才共存 | 证不出就按同一面处理，保守方向是多拦一次而不是覆盖一次 |
| 事后怎么解释 | 每次状态变化一行审计 | 账本要是状态机事件流，否则出事只能靠回忆 |

**设计不变量：正确性只能由本插件单方面成立。**

不要求工具作者声明什么、不要求调用方额外配合、不要求上游改接口。任何「只要生态里大家都做 X 就好了」的方案都不是方案——那是把自己的正确性外包给别人。需要外部知识时的合法写法只有两种：

1. **部署方自己配置**（`rules.json` 的 `capabilities`）——责任与数据都在用户手里，可 review、可 diff、可回滚；
2. **本插件从自己的账本里观测出事实，再交给人确认**——观测是我们做的，确认由人负责，绝不自动生效。

这条不变量的意义在于挡住一类看起来优雅、实际是「等别人配合」的设计（例如"让自动化插件自报属于哪一层"）：它今天可测收益为零，却引入一个只有别人配合才成立的依赖。

---

## 二、需求与达成情况

| # | 需求（验收标准） | 状态 | 实现位置 / 说明 |
|---|---|---|---|
| 1 | **归属唯一**：同一目标面同一时刻只有一个归属方 | 达成 | `claims` + `evict`：接手时旧占用被显式结束并留痕；只有证不出不同才判同一面 |
| 2 | **冲突可仲裁**：分不出专一时查归属表；表里没写就问，不许猜 | 达成 | `claims.groups` 是归属表；`claims.conflict` 三态（`ask` / `deny` / `allow`） |
| 3 | **升层要证据**：一次一类、最多两次 | 达成 | 同一目标累计被拦或失败 `claims.maxAttempts` 次后拒绝换类，文案要求说出证据或问用户 |
| 4 | **触发可按住**：自带触发器的插件也要挡 | 部分达成 | 走工具调用的拦得住（`deny` 不受自动化范围限制）；插件自己起定时器直接动手的不经工具层 |
| 5 | **可审计**：每次拦或放留痕 | 达成 | JSONL 事件流：`allow / deny / ask / claim / release / startup`，含 `effect / owner / resource / holder / attempts` |
| 6 | **范围只限自动化** | 达成 | `scope.spaces`（受仲裁的空间）；`read`、`pwsh`、`univer_*`、`bilibili_extract` 等请求没有目标，不入账 |
| 7 | **不添乱**：不新增工具、规则可读可改 | 达成 | 零依赖、零工具；分类表与策略都在 `rules.json`（用户行可覆盖内置行） |
| 8 | **token 克制**：常驻只有一段提示词 | 达成 | 1,596 字符 / 约 443 token；仅在有人占面时追加一行现场占用（≤3 条） |

---

## 三、调度模型：请求 × 空间 × 方式

两个轴回答两个不同问题，必须分开：

- **owner**（谁在动手）：`app` / `page` / `native` / `pixel` / `capture` / `system`
- **effect**（这一下对目标面做了什么）：`observe` / `select` / `act`

**只有 `act` 占位。** `observe` 只读；`select` 只是把面指出来（聚焦、置前、恢复、切标签），不改它的内容——它恰恰是下一个驱动方需要的前置条件，所以不能让它把面占掉。这条区分就是那次事故的根因修复：`open_application` 与 `windows focus` 做的是同一件事，所以它们是同一种 effect。

### 3.1 判断机制：调度器只问「请求要动哪个资源」

这个插件是**调度器**，不是自动化插件：它不判断某个工具是不是自动化工具、也不猜某个动作会不会改变界面——那是工具自己的知识。它只回答两个问题，而这两个问题就足以做出完整的准入决定：

| 问题 | 答案从哪来 |
|---|---|
| 这次请求要动**哪个资源** | 参数里指名的东西：窗口标识、元素定位符、坐标；都没有 ⇒ 没有可仲裁的对象 |
| 以什么**方式**动 | 声明表（已知请求形状）；未声明即 `act` |

```
request = { target?, mode }
target  : window:<hwnd> | document:<url|selector> | point
mode    : observe（只看） | select（只指过去） | act（驱动）
```

`target` 只能由三种语法给出——这不是清单，是「指一个界面」的全部语法。**说不出来，就没有目标。**

未声明的请求因此只有两种命运，都可判定、都可审计：

1. **指名了目标** → 按那个空间进入仲裁（`inferred: true` 标明「凭目标而非声明」）；
2. **没指名目标** → `decision: unarbitrable`，不占位、不拦，记一行账（每工具每次加载一行）。

> 本插件**不做语义推断**：不认原语、不认动作词、不读 schema 枚举、不按工具记忆性质。那是在替自动化插件回答「这一下是不是在驱动界面」，猜错会让仲裁直接错；调度器本来不需要这个问题。

**完备性主张**（可证明，不依赖枚举）：

> 凡说出目标的请求，一定进入仲裁；凡没说目标的请求，一定被记为 `unarbitrable`。

前者靠三种目标语法（封闭），后者靠记账（无遗漏）。没有任何请求会静默通过。

### 3.2 空间与互斥

资源按**空间**归类，因为互斥关系是空间的性质，不是工具的性质：

| 空间 | 资源键 | 说明 |
|---|---|---|
| `app` | 应用对象（无通用键） | 应用自己的语义对象 |
| `page` | `url` / 定位符 | 浏览上下文里的元素 |
| `native` | `hwnd` / 窗口标识 | 一个 OS 窗口 |
| `pixel` | **无键** | 一个点说不出它在哪个窗口里 |
| `system` | 设置项 | 不是屏幕表面，不参与互斥 |
| `capture` | — | 观察者的名字，不是空间；永不占位 |

互斥矩阵是**推导出来的**：`app`/`page`/`native`/`pixel` 两两互斥（它们可能指同一个物理面），`system` 不参与。`claims.groups` 默认就是这份闭包，只有新增自定义空间时才需要改。

`pixel` 无键是整套设计的关键：两个不同的坐标**不能**被证明为不同资源——否则「用坐标点击」就能绕开任何窗口占用，事故当场复现。

### 3.3 出货声明表

按顺序匹配，先命中先用。声明行负责**方式**（observe / select / act），不负责覆盖面——覆盖由目标语法保证。

| 类 | effect | 工具 / 动作 |
|---|---|---|
| `capture` | observe | 名字含 `screenshot`、`read_image`、`video_*`（`video_search` 除外）、`ocr*`、`capture*`、`record*`、`storyboard` |
| `app` | act | `wechat*`、`qq_*`、`wecom*`、`notion*`、`email_*` |
| `page` | act | `ego_*`、`browser_*`、`playwright`、`*cdp*`、`chrome_*`、`page_*`、`tab_*`、`dom_*` |
| `page` | observe | `ego_wait*`；`ego_(help|doctor|status|page_info|read_element|snapshot|captcha)`；`ego_tabs(list)` |
| `page` | select | `ego_tabs(switch|open)` |
| `native` | observe | `ui_elements`；`windows(list)` |
| `native` | select | `windows(focus|restore)`；`open_application` |
| `native` | act | `windows(maximize|minimize|close|tidy)` |
| `pixel` | observe | `computer(screenshot|zoom|cursor_position|wait)`；`computer_batch` 全是上面这些时 |
| `pixel` | act | 其余 `computer*`；`switch_display(index)`；`screen_*`、`mouse_*`、`keyboard_*` |
| `pixel` | observe | `switch_display()`（不带 `index` 即列显示器） |
| `system` | act | `system_*`、`service_*`、`registry*`、`power_*` |

两条通用规则让这张表不必逐工具堆砌：

1. **族内封闭**：一个 `^ego_` 行覆盖整个 ego 族，新发布的 ego 工具默认是 `act`（fail closed），不会静默落到 `other` 而绕过闸门。
2. **批处理取最强元素**：`computer_batch({actions:[…]})` 的 effect 是其中最强的一档。纯截图批次是 observe，截图+点击批次是 act。早期版本里同一个 `computer` 截图不占位、`computer_batch` 纯截图却占位，就是缺这条规则。

`effect` 之外，表还允许 `cases`（有序、先命中先用）按工具名或动作细化，`when.tool` / `when.actions` / `when.present` / `when.absent` 四种子条件可与门（AND）组合。

---

## 四、占用模型

```
pre-execute ──┬─ 静态规则 deny/ask/会话白名单 ──────────────→ 拒绝/询问
              ├─ 冲突检查（找占用方，读预算） ─────────────→ 拒绝/询问（ask 批准后继续）
              └─ 取占用（act 且受管） ───────────────────────→ 放行
tools/execute ── 结束争用方（transfer 审计）+ 确认占用 ───→ 真正派发
tools/result ── 失败 → 释放该 owner 在该面的占用 + 记一次尝试
agent/turn-stopping ── 清该会话全部占用与预算（source=turn）
agent/disposed ────── 同上（source=dispose，被中止的回合不会留占用）
TTL（默认 30 分钟） ── 兜底清理，聚合成一行（source=ttl）
```

为什么占用要分两处：`pre-execute` 里取占用是为了**让同一批（同一 step 的多个 tool call）中的第二个调用看得到第一个**；`tools/execute` 里再确认一次，是因为 `ask` 的批准发生在 waterfall 之外——早期版本的 `ask` 分支直接 `return`，批准后派发的调用从未建立占用，于是「同意切换」永远换不过去，下一次还要再问一遍。

**交接是显式的。** `allow` 模式或批准后的切换会 `evict` 争用方的 claim 并写一行 `decision=release, source=transfer`，账本因此能回答「哪个空间把面交给了谁」。早期版本是静默覆盖：新的驱动方拿到键，旧的记录消失，事后无法还原。

**资源身份**：`page` 用 `origin+pathname`（丢 query/hash）；`native`/`pixel` 用 `hwnd / handle / windowId / title / name`；`system` 用 `item / setting / name`；`app` 无键空间。缺键按「未知」处理。

**判定**：`relation(a,b)` 返回 `same / distinct / unknown`。跨族、缺键都是 `unknown`，由调用方决定含义：

- `unknown` 一律按同一面处理——**与谁在问无关**。争用是面的属性：父会话正驱动某个窗口时，子会话不能自顾自再驱动它（`claims.conflict` 决定是拒绝、询问还是记账接管）。
- 只有能证明是不同面（同空间、双方都有键、键不同）才并行。

---

## 五、冲突裁决与重试预算

- 互斥由 `claims.groups` 决定（默认六个两两组合）；同一会话内同类调用是同一个驱动方，不与自己争用，其余一律按面处理。
- `claims.conflict`：
  - `ask`（默认）→ 询问，带 en/zh 双语理由；无审批应答者时由运行时退化为拒绝；
  - `deny` → 直接拒绝，理由里带占用方与**被占资源键**，并说明怎么解除；
  - `allow` → 只记账，新类接管所有权，**不消耗预算**（它本来就是观察模式）。
- `claims.maxAttempts`：同一目标累计被拦或失败 N 次后，换类直接拒绝，文案要求「结束回合问用户，或给出占用方失败的证据」。

**预算的作用域永远不比闸门能证明的身份更细。** 这曾经是一个真实漏洞：预算原本记在占用方的资源键上，于是调用方只要换个名字去够同一个面（导航到新 URL、用标题而不是句柄去点、干脆不写句柄），计数就归零，`maxAttempts` 形同虚设。现在只有两种情况：

| 关系 | 预算作用域 | 理由 |
|---|---|---|
| 两面可证相同（同族同键） | `s:<family>:<key>` | 两个确实不同的窗口不应该共用计数 |
| 其余（跨族、缺键 → 证不出） | `u`（本会话本回合一格） | 闸门既然把它们当同一面，计数也必须当同一面 |

失败同时记入两个作用域：它对自己的面是确凿的（供日后可证的冲突使用），对「别人可能也在够同一面」则一无所知（供日后证不出的冲突使用）。

**被批准的询问会退还这一次。** 问用户不是调用方在自行重试，人说了「可以」就不该吃掉那份「别再试了」的预算。实现上：`ask` 时记住这次花费（按 `callId`），`tools/execute` 触发即说明批准了，此时退还；被拒绝的询问不退款，照常计次。

**拒绝文案会解释判断本身。** 当两侧证不出不同（跨族、缺键），理由会按**缺口在哪一侧**给建议：占用方没点明目标（用坐标动手）时说「它没点明，两者无法区分，请用同一类做完」；调用方没给目标时说「请显式给出 url / hwnd」。否则一个确实瞄着另一个窗口的调用方只会把拒绝当成 bug。

---

## 六、配置

规则文件优先级：`<state>/rules.json`（state = `<profile>/capability-policy`）→ 包内 `rules.json`。包内那份在升级时会被替换，长期修改应放 state 目录。

| 键 | 作用 | 默认 |
|---|---|---|
| `scope.spaces` | 受仲裁的空间（不是工具类） | 六个空间全部 |
| `capabilities[]` | 分类表覆盖/扩展，**排在出货表之前** | `[]`（用出货表） |
| `claims.enabled` | 是否启用占用 | `true` |
| `claims.conflict` | `ask` / `deny` / `allow` | `ask` |
| `claims.maxAttempts` | 同一目标几次被拦/失败后拒绝换类（`0` = 不限） | `2` |
| `claims.ttlMinutes` | 占用兜底过期 | `30` |
| `claims.groups` | 互斥的类组合；不含 `capture` | 六个两两组合 |
| `deny[]` / `ask[]` | 静态拒绝 / 请求确认（正则；`args` 匹配 `JSON.stringify(arguments)`） | 空 |
| `agents[]` | 按会话 id 或 `prefix` 做白名单/黑名单 | 空 |
| `audit.enabled` / `file` / `maxBytes` | 开关、落点、轮转上限（相对路径落在 state 目录） | `true` / state 目录 / 4 MiB |
| `watch` | 规则文件改动后自动重读 | `true` |

**校验原则**：结构化错误一律拒绝启动并列出全部问题。包括未知顶层键、拼错的键、旧版已移除的键（`owners`、`selection`、`claims.readOnly`、`claims.exempt`，都带迁移提示）、坏正则、未知类别、`capture` 不是 `observe`、空互斥组、同源重复分类行。静默降级是策略插件最不该有的行为。

### 热重载

`watch: true` 时用 `fs.watchFile` 轮询规则文件（2 秒），改动后重新解析：

- **成功** → 原子换上新配置，账本写一行 `decision=config-reloaded`（含新摘要）。**在线占用不丢**：调策略不该把已经动了的手松开。
- **失败** → 保留正在跑的那份配置，写一行 `decision=config-rejected` 并附上具体问题。半写完的一条正则不能让整个 profile 变成无策略运行。

审计账本路径若随新配置改变，写入器会跟着换；返回的 disposer 会停掉轮询。用 `rowConfig.rulesFile` 直接指定的文件同样受 `watch` 管。

### 设置页（Config）

`schemastery` 实际上是 profile 里被提升安装的依赖（`<profile>/node_modules/schemastery`），此前「零依赖拿不到它」的判断从未验证过，是错的。2.1 起用 `createRequire` + `try/catch` 取它：

- 取到 → 暴露一个设置页字段：`rulesFile`（规则文件路径，留空走默认回退）；
- 取不到（严格安装不暴露 peer）→ 没有 schema，插件照常工作，只是设置页无字段。

schema 只描述**规则放在哪里**，不描述规则内容，也不描述「要不要热重载」——后者是规则文件自己的 `watch`。这样任何一项都只有一个地方能改，不会出现「设置页说 A、JSON 说 B」。没有 schema 的安装里，`watch` 仍由规则文件控制，因为那是文件自己的属性。

---

## 七、两处刻意的取舍

**1. `minimize / maximize / close / tidy` 仍然占位，只有 `focus / restore` 归为 `select`。**

- `minimize` 让面消失、`maximize` 改变几何，这两件都会让**已经算好的坐标失效**，正是像素类与桌面类互斥要防的破坏；
- `focus / restore` 只是把面指出来，是下一个驱动方的前置条件，占位没有意义。

**2. 点击之后再「导航到新页面」会被拒，这不是缺陷。**

`computer` 点击成功之后，pixel 已经合法占住了那个面；page 再进来就是一次真实的换手。想走通这种流程，用 `claims.conflict: "ask"`（让人来批）或 `"allow"`（只记账）——而不是放宽判断。

---

## 八、代码结构

| 文件 | 只做一件事 | 不依赖 |
|---|---|---|
| `lib/paths.js` | 由插件自身位置反推 profile → 单一 state 目录 | 其它 lib |
| `lib/util.js` | 两个谓词 | — |
| `lib/capability.js` | 分类表、`explainCall`、资源身份、`relation`、唯一冲突规则 | util |
| `lib/ledger.js` | 占用与预算的内存状态，返回「发生了什么」，不审计、不读配置 | capability |
| `lib/audit.js` | JSONL 写入与轮转，失败不阻塞派发 | — |
| `lib/rules.js` | 原始规则 → 冻结配置；`evaluateStaticRules` | capability / paths / util |
| `index.js` | 只做接线：提示词、guard、四条 hook | 全部 |

依赖方向单向，没有环。`index.js` 不含任何分类或冲突判断——它只把纯决策翻译成 `PreToolDecision` 并记账。

导出面：`apply`、`inject`、`PROMPT`、`DEFAULTS`、`DEFAULT_CAPABILITIES`、`OWNERS`、`EFFECTS`、`UNATTRIBUTED`、`resolveConfig`、`loadConfig`、`evaluateStaticRules`、`explainCall`、`classifyTool`、`findConflict`、`findConflicts`。`classifyTool(name, args, config)` 只返回空间名（便捷函数）。

---

## 九、依赖的接口契约

| 接口 | 用途 | 关键点 |
|---|---|---|
| `systemPrompt.section({ name, order, text })` | 注入策略段 | 只注入一段 |
| `tools.guard(fn)` | 同步 deny 兜底 | **总是注册**（热重载可能新增 deny 规则）；返回字符串（0.2.1–0.2.2 唯一通用返回类型） |
| `tools/pre-execute(exec, next)` | 检查 + 取占用 | 返回 `allow / deny / ask`；`deny.info.code` 携带错误码 |
| `tools/execute(exec, next)` | **提交点**：交接 + 确认占用 + 退还获批的预算 | 只对已放行（含 ask 获批）的调用触发 |
| `tools/result(exec, result)` | 失败释放；未归属调用在此就地回收 | `result.isError`；`exec.agent` 缺失时按 `@unattributed` 处理 |
| `agent/turn-stopping(payload)` | 回合清理 | `payload.agent.id` |
| `agent/disposed(payload)` | 中止清理 | 被中止的回合不会走 turn-stopping |

`check-and-take` 必须是**一段没有 `await` 的同步代码**：这是「同一批里两个争用调用不会都通过」的全部依据。往里插一个 `await` 就重新打开了竞态。

错误码：`capability_policy_denied`（静态规则 / 会话名单）、`capability_policy_conflict`（冲突被拒）、`capability_policy_exhausted`（本回合该目标的换类预算已用尽）。

---

## 十、审计

每次加载第一行是 `decision=startup`，自证四件事：账本落点、规则来源与摘要、受管空间与互斥组规模、当前裁决模式。账本分家、不知道哪本在写，就是因为没有任何一行写下来。若发现旧版 `%LOCALAPPDATA%\dsh-capability-policy\audit.jsonl` 仍存在，会在这一行里以 `previousLedger` 标出。

决策词表（一行只说一件事）：

| decision | 何时 | 附带字段 |
|---|---|---|
| `startup` / `config-reloaded` / `config-rejected` | 加载、热重载成功、热重载被拒 | `ledger` `rules` `rulesDigest` `capabilities` `conflict` `maxAttempts` `ttlMinutes` `watch`；被拒时另有 `reason` |
| `allow` / `deny` / `ask` | 派发裁决，`source` 说明原因（`policy` / `claims` / `deny-rule` / `ask-rule` / `agent-deny` / `agent-allowlist`）；由同步兜底拒绝的行带 `via: "guard"` | `owner` `effect` `mode` `resource`；冲突行另有 `holder` `held` `attempts` `scope` |
| `claim` | 取得所有权（仅在状态变化时写） | 获批路径带 `refunded: true` |
| `release` | 所有权结束，`source` = `failure` / `transfer` / `turn` / `dispose` / `call` / `ttl` | `owner` `tool` `resource`；TTL 行聚合为一条，带 `count` `resources` |
| `turn-end` | 一个回合结束且该回合有过审计活动 | `turn` `released` `budgets`；这是把账本按「回合」切分的唯一依据 |

`mode` 保留粗粒度 `read` / `act` 以兼容旧查询，`effect` 才是精确分类。

两条记账契约：

- **拦截必须留痕，两条路径都算。** 实测排序是 `tools/pre-execute` 先跑、`tools.guard` 在后：正常管线里由瀑布拒绝并记账；guard 只兜住**绕过瀑布**的派发路径，而在那些路径上没有任何别的东西会写行。同一调用被两条路径都看到时只记一行（按 exec 身份去重）。
- **账本必须能按回合切分。** 核心不变量是「同一回合、同一面、一个归属方」，没有 `turn-end` 就无法判断两行是否同一回合——而这正是任何一次拒绝被追问时的第一个问题。

---

## 十一、测试

`node test/policy.test.mjs`，零依赖，277 项断言。覆盖：提示词预算与契约、真实工具名的完整分类、用户行覆盖、三种 effect 的占位行为（含事故回归）、批处理最强元素、资源身份与归一化、三种裁决、批准后的接管、交接审计、失败释放（含「截图失败不得释放点击」）、预算（冲突计数、按目标隔离、换名字不能重置、`0` 不限、`allow` 不计、获批退还、未获批照计）、跨会话、未归属调用就地回收、同一 tick 并发只放行一个、回合/dispose/TTL 三种回收、startup 行、规则热重载（成功 / 被拒 / `watch:false`）、轮转、静态规则与两路径一致性、配置校验、路径回退。

---

## 十二、已知局限

- 只管工具调用路径；插件自己定时动手、直接写库、调服务，这里拦不住。
- **跨族身份不可互证**：`page` 的 URL 与桌面句柄指向同一窗口，插件无法证明它们不同，于是全局一律按同一面处理（含跨会话与子代理）。这是保守方向（宁可多拦），代价是确实瞄着另一个窗口的调用会被拦下——所以拒绝理由会提示「显式给出 url / hwnd」。要真正互证，需要运行时提供「这个页面在哪个窗口」的映射，插件层做不到，也不打算靠标题猜测（猜错的方向恰好是危险的）。
- **没说出目标的请求**（例如某个 `rdp_type {text}`，或只按焦点动作的调用）落进 `decision=unarbitrable`——记录但不拦。这不是分类失败，而是请求不完整：没有可授予的对象。声明一行即可纳入。
- **`url` 不是目标语法**：一个 URL 说不出「在哪个浏览上下文里」，所以 `web_fetch {url}` 与「把浏览器导航到某页」在请求层面不可区分。后者靠声明覆盖，前者记为 `unarbitrable` 并标 `suspect: "url"`。
- **推断可能过严**：一个带 `hwnd` 的只读断言工具会被判成 `native:act` 并占位。方向是安全的（多余占位），用一行 `capabilities` 声明为 `observe` 即可消除。
- 因为上一条，`page` 的键（URL）无法影响裁决；它的真实用途是审计可读性与「可证时」的预算粒度。**但预算升级不再依赖它**：证不出同面时预算落在会话作用域，靠换 URL 重置计数这条路已经封死。
- `app` 族没有键空间，所有 app 调用共用一格（全局）。
- `ask` 在无审批应答者时退化为拒绝；获批的询问会退还预算，但「退化成的拒绝」插件看不到（运行时在 waterfall 之后才决定），所以那条路径上预算不会累积——此时 `deny` 模式语义更完整。
- `allow` 模式下同一批并发调用会互相抢交接（各自 execute 时接管一次），这是观察模式的固有表现。
- 审计按体积轮转，只保留一份历史（`.1`）。
- 热重载是轮询（2 秒），不是 inotify 级即时；改动后最多等一个轮询周期。

---

