# cordis → MCP桥接器（cordis-mcp-bridge）实施计划

> 目标：**让 orbcat 能用上整个 cordis/dsh 插件生态，同时 orbcat 一克代码不变、10.6MB 不变。**
> 手段：在**外部** Node 进程里跑 cordis 插件树，用 MCP over stdio 把工具吐给 orbcat。
> orbcat 侧只改配置（`mcp.json` 加一条）+ 补一个缺失的 `cwd` 字段。

---

## 0. 为什么是「桥接」而不是「嵌入」

| | 内嵌 cordis 进 orbcat | **桥接（本计划）** |
|---|---|---|
| orbcat 体积 | 11MB → 150MB（要塞 Node runtime）❌ | **10.6MB 不变** ✅ |
| orbcat 改动 | 加 Node runtime、打包、ABI | **仅配置 + 补 `cwd` 字段** ✅ |
| 能用的插件 | 全部 | **全部**（Node 在外部跑） ✅ |
| 坏了怎么办 | 改 exe | **删一个 `.mjs`**，orbcat 毫发无损 ✅ |

**核心：重量在 orbcat 之外，耦合在 orbcat 之外。**做错只损失一个脚本，不损失 exe。

---

## 1. 已核实的事实（别再重查）

**orbcat 侧（已具备）**
- `mcp.rs`（120KB）已实现 MCP client，传输含 `Transport::Stdio` / `StdioSession::spawn` / 自动重连 + 握手。
- 配置字段：`transport`(auto/stdio/http) / `command` / `args` / `env` / `url` / `label` / `enabled`。
- ⚠️ **缺 `cwd`** —— stdio 拉起插件进程常要工作目录，桥接器需要它。**这是唯一的代码改动**。
- 工具命名空间：`mcp__<serverId>__<toolName>`（如 `mcp__bridge__send_meme`）。桥接器内部用 cordis 工具名即可，orbcat 自动加前缀。
- `clientInfo` 已上报 `{name:"orbcat", version}`。

**本机工具链**
- node **v22.22.2** ✅（另有 `D:\NODE.JS\node.exe`）
- npm **10.9.7** ✅ / pnpm ❌（dsh 用 pnpm，桥接器用 npm 即可，不强求一致）

**cordis 侧（认知修正，重要）**
- cordis **不是私有 fork**：**MIT 协议**、npm 公开（`@deepseek-ai/cordis@4.0.4`）、上游 `cordis` 4.0.0-rc.10（源自 Koishi，同作者Shigma）、**源码全量在 `deepseek-harness/vendor/cordis/src/`（9 模块）**、有 arXiv 论文。
- 本地 `tmp/dsh_src/.../node_modules/` **只有 22 个 dsh 官方插件包，没有 cordis 本体** → 需新装。
- cordis 核心 API（v4）：`new Context()` → `ctx.plugin(Plugin)` → `ctx.provide/inject` → `ctx.on/emit/waterfall` → `Fiber` 生命周期 → `ctx.effect()` 可逆副作用。**桥接器只需碰这几个。**

**dsh 生态（已勘察）**
- 官方包 242 个（`packages.md`），`dsh-mcp-client`（默认装）就是「连 MCP server、把工具注册到 `ctx.tools`」——**我们要做的是它的镜像（反向）**。
- 重能力全挂 MCP：`browser-use-playwright-mcp` / `chrome-devtools-mcp` / `computer-use-cua-driver-mcp` / `dsh-mcp-client` / `dsh-mcp-resources`。
- cordis 插件形态：函数`(ctx, config)` / 对象 `{name, Config, inject, apply}` / `Service` 子类。
- `dsh-meme` 是**第三方**写的（非官方 22 包内），不在 `packages.md`。

---

## 2. 架构

```
┌─ orbcat.exe (10.6MB, Rust) ──────────────┐
│  mcp.rs (stdio) │tools.rs (mcp__bridge__*)│
└───────────────┬───────────────────────────┘
                │ JSON-RPC over stdio（已有实现，零改动）
┌───────────────▼───────────────────────────┐
│ bridge.mjs（外部 Node 进程）              │
│  ├─ MCP server：tools/list + tools/call   │
│  ├─ cordis Context：装插件树              │
│  └─ 适配：cordis ctx.tools ⇄ MCP          │
└───────────────┬───────────────────────────┘
┌───────────────▼───────────────────────────┐
│ cordis + N 个 dsh/第三方插件（node_modules）│
└───────────────────────────────────────────┘
```

---

## 3. 实施阶段

### 阶段 0：orbcat 补 `cwd` 字段（唯一的代码改动）
- `mcp.rs`：`StdioCfg` 加 `cwd: String`；`describe()` 展示时带上；`StdioSession::spawn` 透传给 `std::process::Command::current_dir`（空则不设）。
- 前端 `mcp.json` 编辑加 `cwd` 字段（设置 › MCP）。
- **验收**：不加这个也能跑（cwd 可选），但部分插件会因工作目录不对失败。**先做它，避免阶段 2 踩坑。**

### 阶段 1：装 cordis + 验证最小 cordis 跑通（纯 Node，不碰 orbcat）
- 在 `D:/workplace/悬浮小agent/sidecar/bridge/`（或 `tools/cordis-bridge/`）建 node 工程：`npm init -y` + `npm i @deepseek-ai/cordis @deepseek-ai/schemastery`。
- 写一个**最小 cordis 冒烟脚本**：起Context → provide一个假工具 → 触发事件，验证 cordis 生命周期在 node22 能跑。
- **验收**：脚本打印出工具名 + 事件触发成功。**此步不碰 orbcat，纯验证 cordis 可用。**

### 阶段 2：MCP 出口（桥接器内核）—— 关键一步
写 `bridge.mjs`，三件事：
1. 起 MCP server（stdio）：实现 `initialize` / `tools/list` / `tools/call`。手写或用轻量MCP SDK（评估：`@modelcontextprotocol/sdk`，**注意它也带 Node 依赖，但那是 bridge 侧的，不进orbcat**）。
2. 起 cordis `Context`，按一份 `plugins.yml/cordis.yml` 装插件（照抄 dsh `templates/mcp/` 的 config-only思路，但我们要装载**任意已装插件**）。
3. **适配器**：拦截 cordis 注册的工具（镜像 `dsh-mcp-client` 的 `ctx.tools` 注册），把工具清单喂给 MCP `tools/list`；`tools/call` 进来时转回 cordis 的 dispatch/emit。
- **验收**：`mcp.json` 加一条 `{"transport":"stdio","command":"node","args":[".../bridge.mjs"]}`，orbcat 重启后**工具列表里出现 `mcp__bridge__*`**。

### 阶段 3：接一个真实 dsh 插件（验证"生态通"）
- 从 `packages.md`挑一个**轻量、非交互**的官方包（如某个 tool 包），经 bridge 加载，看工具能否正常被 orbcat 调用。
- **验收**：orbcat 里实际调用该工具成功。**这一步证明"整个生态可用"，不是只跑通假工具。**

### 阶段 4：插件清单外置（可选，锦上添花）
- `bridge.yml`：cordis 要装哪些插件包（`packages.md` 里挑）+ 开关。不用重写 bridge 脚本。
- 顺手把 orbcat 里硬编码的 prompt 注入点评估外置（中期，见 §5）。

---

## 4. 关键风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| cordis 插件重度依赖 Node API（fs/child_process） | 高 | 这正是桥接的意义——**它们在 Node 里跑，跑得起**。orbcat 不受影响。 |
| cordis 版本 API 变动打碎 bridge | 中 | 桥接器只碰 5 个核心 API（plugin/provide/on/effect），不是整个 dsh 面；且 cordis MIT 公开、源码可读。**坏了只改 bridge。** |
| MCP SDK 又带一堆 Node 依赖 | 中 | 那是 **bridge 侧**体积，不进 orbcat。若嫌重可手写 JSON-RPC（stdio 就是 stdin/stdout 行分隔 JSON）。 |
| cordis 插件注册工具到 `ctx.tools` 的机制比预期复杂 | 中 | 阶段 2 先用假工具验证机制，再接真插件（阶段 3）。别一上来啃真插件。 |
| 孤儿 stdio 进程 | 低 | orbcat `StdioSession` 已有重连/握手；bridge 侧监听 stdin EOF 主动退出。 |

---

## 5. 中期联动（跟这次桥接无关，但同一方向）

桥接解决"**别人的插件**"，orbcat 自己还有一批能力硬编码在 Rust 里（`build_system_prompt` / `image_replies_prompt` / `memes::prompt_section` / `tools::all_tool_specs`）。外置成JSON 能让"改一句话不重编"。**先做桥接（阶段1-3），外置另起一轮。**

---

## 6. 明确的非目标

- ❌ 不内嵌 Node runtime 进 orbcat（护城河，10.6MB 不能动）
- ❌ 不追 cordis 私有面（cordis 是 MIT公开，够了）
- ❌ 不为"插件人数"做决策（那是用户量问题，不是机制问题；桥接只是**接上生态**，不保证别人来写）

---

## 验收标准（Definition of Done）

- [ ] orbcat 仍是 10.6MB，**无新增 Rust 依赖、无 Node 运行时**
- [ ] `mcp.json` 加一条即在orbcat 工具列表看到 `mcp__bridge__*`
- [ ] orbcat 能实际调用一个真实 dsh 官方插件的工具并成功
- [ ] 删掉 `bridge.mjs` / 改坏 bridge，orbcat 能正常启动（其他 MCP server 不受影响）

---

## 评审补记（2026-10-08，实际查证后修正）

**总评：方向对，批准按此执行。** 桥接优于嵌入的判断成立——复用 `mcp.rs` 现成 MCP client，orbcat 零协议开发、零权限系统接线（MCP 工具天然走现有权限三路）。以下为查证后的修正与补充：

### 已核实 ✅
- `@deepseek-ai/cordis@4.0.4` 在 npm 公开（`npm view` 实查）。
- `mcp.rs` 确实**无 `cwd` 字段**、也**无 `tools/list_changed` 处理**（grep 实查）。

### 修正 A：「能用上整个生态」要打折
`ctx.tools` **不是 cordis 原生 API，是 dsh-host 提供的服务**。bridge 必须自己 `provide` 一个 `tools` 服务，API 面照抄 `dsh-tools`（本地 tmp/dsh_src 有 lib 源码可对照）——这是阶段 2 的真实工作量，不是"拦截"一下就行。
由此推论（cordis 语义：缺注入服务→插件静默不激活，不报错）：
- **能用的**：MCP bundle（纯配置）+ 只依赖 `tools`/`config` 的工具类插件。
- **不能用的**：`inject: ['systemPrompt']` / `agent` / `session` 类插件——MCP 没有"往 orbcat 系统提示词注入内容"的通道。它们不会报错，只是永远不激活，属预期行为。
- 阶段 3 挑插件时，先看它 `static inject` 数组里有什么，只挑 `tools`/`config` 域内的。

### 修正 B（2026-10-09 二次修正：vendor 方案作废，npm 精确 pin 可行）
~~别 `npm i @deepseek-ai/dsh-*`，要 vendor~~ —— **该结论是 `latest` 标签造成的假象**。`npm view @deepseek-ai/dsh-tools version` 只显示 latest 标签（0.0.1-rc.1），但完整版本列表里 **0.2.0-rc.2 全系都在 npm**（`versions --json` 实查：dsh-tools / dsh-system-prompt / dsh-scope 等全部有 0.2.0-rc.2）。
正确做法：`npm i --save-exact @deepseek-ai/dsh-tools@0.2.0-rc.2 @deepseek-ai/dsh-system-prompt@0.2.0-rc.2`，npm 自动解析全部依赖闭包（19 个 @deepseek-ai 包，含 dsh-tools 运行时 import 的 dsh-llm/dsh-sandbox/dsh-brand/dsh-util-values/dsh-scope 等），bridge 的 node_modules 合计约 11MB（@deepseek-ai 部分 3.1MB）。**开源也不再需要再分发 DeepSeek 代码**——依赖走 npm，license 由各包携带。vendor 手拷仅在 npm 断供时兜底。已实测装通并跑通服务链冒烟。

### 补充 C：三条工程铁律（阶段 2 写 bridge.mjs 时）
1. **stdout 只准走 JSON-RPC**——所有日志/报错全走 stderr。bridge 里一个裸 `console.log` 就打崩 stdio 帧，这是 MCP stdio 头号坑。
2. 插件工具抛异常 → 捕获后转 MCP `isError: true` 响应，绝不让异常炸掉 JSON-RPC 主循环。
3. orbcat 端不处理 `tools/list_changed`（已核实）——动态增删的工具要**重连才出现**。v1 按"改插件清单→重启生效"设计，不做热更新，省一层复杂度。

### 补充 D：阶段 0 可以更轻
`cwd` 字段值得加（对其他 stdio server 也有用），但**不必阻塞**：bridge.mjs 启动时对自己 `process.chdir(__dirname)` 即可绕开工作目录问题 → 严格说 orbcat 可以做到真·零代码改动。cwd 降级为"顺手补"，不再拦在阶段 0。

### 补充 E：22 包全量抽样（2026-10-08，lib/index.js 逐包实查）

服务名 → 提供者（`extends Service` + `super(ctx, "名")` 实查）：
`systemPrompt`←dsh-system-prompt（**无注入依赖，自洽**）｜`tools`←dsh-tools（仅注入 systemPrompt）｜`sandboxPolicy`←dsh-sandbox-policy｜`ptcRuntime`←dsh-ptc-runtime｜`planMode`←dsh-plan-mode｜`approval`←dsh-user-approval｜`agentPresets`←dsh-agent-preset-registry。
`subagents`/`workflowEngine`/`sessionProjections`/`llm`/`sessions`/`fs`/`subprocess` 等 **提供者在 harness 核心**（不在 22 包内，vendor 不到）。

| 判定 | 包 | 依据（static inject） |
|---|---|---|
| ✅ 直接激活 | dsh-system-prompt、dsh-tools（服务本体） | 自洽服务链，vendor 即用 |
| ✅ 直接激活 | dsh-agent-tool-presentation | `["tools"]` |
| ✅ 直接激活 | dsh-persona | `["systemPrompt"]`（段落进不了 orbcat 提示词，无害累积） |
| ⚠️ 差一脚 | dsh-tool-workflow、dsh-tool-ralph | 缺 `workflowEngine`（harness 核心） |
| ⚠️ 差一脚 | dsh-tool-subagent、dsh-plan-mode、dsh-sandbox-policy、dsh-workflow-ptc、dsh-ptc-runtime-node | 缺 `subagents`/`sessionProjections`/`fs`/`subprocess` |
| ❌ 结构性出局 | dsh-web-app、dsh-client-ui-*×4 | UI 域（Slots/模块加载器） |
| ❌ 结构性出局 | dsh-agent-preset(-registry)、dsh-experimental-auto-review、dsh-user-approval、dsh-fs-observation-policy | 缺 `loader`/`llm`/`sessions` 等 host 服务 |

**结论：可行，且比原计划更省。** 关键发现：`tools` + `systemPrompt` 两个服务**不用自己写 shim——直接 vendor 官方实现**（dsh-system-prompt 无依赖、dsh-tools 只依赖前者），服务链自洽，注册/校验/HMR 语义 100% 保真。`@deepseek-ai/schemastery@3.18.4` 在 npm（实查）。MCP 适配的真实工作量收窄为两件事：① 工具参数 schema 是 schemastery 风格（`required: true` 内联在属性上）→ 转 MCP 标准输入 schema（顶层 required 数组），一个小转换函数；② `tools/call` 执行路径要么走 ToolRuntime 公共入口要么直接调 definition.execute + `output.render()`，阶段 2 定。

### 补充 F：第三方插件抽样（2026-10-08，用户要求改抽第三方；5 样本实查）

生态现状：GitHub 引用 `@deepseek-ai/dsh-tools` 的代码 **3.36 万条**，第三方已成体系（dsh-ccg、DSH-taskboard、dsh-lsp-actions、Perfect-Web-Clone、dsh-meme 等）。`@deepseek-ai` 全 scope 服务包（dsh-fs/subprocess/subagent/settings/skill-filesystem…）均在 npm（多为 0.0.1-rc.1 旧版，vendor 优先策略不变）。

| 第三方插件 | inject（实查） | 判定 |
|---|---|---|
| Perfect-Web-Clone | `['tools']`，7×defineTool，deps 仅 cordis+dsh-tools | ✅ 零 shim 直接激活 |
| dsh-ccg | `['tools']`（入口与子插件两处） | ✅ 激活无门槛；但运行时 import dsh-subagent/subagent/settings/skill-filesystem → 模块必须可解析 |
| DSH-taskboard | 无（apply 直挂；dsh-agent/goal/workspace 全为 import type 类型擦除；存储自带 sqlite） | ✅ 大概率直接激活 |
| dsh-lsp-actions | `['tools','fs','subprocess']` | ⚠️ 需挂 dsh-fs/dsh-subprocess 服务包（npm 有，但第三方面向 0.2.x、npm 是 rc.1 → 版本缺口实测） |
| dsh-meme (npm@0.1.47) | `['tools','webServer','agentDefaultModel','attachments']`（另有 client.js UI 域） | ⚠️ 三服务需 stub；搜图类工具能用，web/QQ 发图通道降级 |

第三方抽样修正三件事：
1. **注册面收敛**：5/5 工具类插件全部走 `defineTool` + `ctx.tools.register`——桥的适配点是单一的，不是发散的。
2. **有两道坎，不只 inject**：① inject 数组卡激活；② **运行时 import 的 dsh 包必须能模块解析**（import 失败=加载即崩，比服务不激活更硬）。第三方普遍把 dsh 包当 peer → bridge 的 node_modules 必须备齐整个 `@deepseek-ai` scope（vendor 22 包 + npm 补缺）。
3. **import type 是生态习惯**（类型擦除、运行时零负担），对 bridge 是利好。

结论修订：bridge 实际射程比官方包抽样的估计**更宽**（纯工具第三方插件零 shim 激活），但 dsh-meme 这类全功能插件要按 stub 清单逐个补，不存在"纯 tools 域"一条线划清的边界。
### 补充 G：阶段3适配实测（2026-10-09，Perfect-Web-Clone 全绿）

样本：ericshang98/Perfect-Web-Clone（纯 tools 域第三方插件，7 个 pwc_* 工具）。装载三级验收全过：
① **装载激活**：`{name, inject, apply}` 对象形态 `ctx.plugin()` → 7/7 工具注册（`inject:['tools']` 门控通过；`ctx.get('skills')` 软依赖缺失自动跳过，符合预期）。
② **协议暴露**：MCP tools/list 列出全部 7 个 + inputSchema 标准。
③ **错误透传**：pwc CLI 未安装时，插件自己的安装指引消息原样以 isError 送达客户端（桥不吞错、不崩、后续调用正常）。

两个适配级发现（都是桥的核心职责，已固化为 `compat/`）：
1. **装载形态**：cordis 对函数导出会 `new` 调用（`new apply`）——插件必须以 `{name, inject, apply}` 对象形态装载，不能用命名空间对象直塞。
2. **API 断层**：插件面向的 dsh-tools API 与 rc.2/alpha 不一致（`defineTool` 无 `output` 字段两版都 throw）。解法 = Node 官方 `module.register()` ESM resolve hook：只拦 parentURL 在 plugins/ 下的 `@deepseek-ai/dsh-tools`，重定向到 compat 包装模块（`export *` 透传 + 本地 defineTool 覆盖，缺 output 补默认 schema 与 JSON 序列化渲染）。服务链本体零改动。

### 补充 H：真兼容路线打通（2026-10-09 下午，服务层 12 服务 + 三插件矩阵）

**推翻"服务提供者 vendor 不到"的结论**：harness 服务层实现全量在 npm（0.2.0-rc.2，latest 标签假象第二次被识破）。`npm i --save-exact` 直接装真服务。

**服务面 2 → 12**：systemPrompt / llm / sessions / sessionProjections / agents / agentDefaultModel / skills / fs / subprocess / webServer(stub) / attachments(本地存储) / tools。全部实测激活（`services.mjs`）。

**三插件装载矩阵（全部激活）**：
| 插件 | inject | 结果 |
|---|---|---|
| perfect-web-clone | tools | 7 工具 + 门禁数据修复（见下） |
| lsp-actions（npm@0.5.11） | tools, fs, subprocess | **8 个 lsp_* 工具激活**——npm 真 fs/subprocess 服务喂活 |
| dsh-expression（dsh-meme npm@0.1.47） | tools, webServer, agentDefaultModel, attachments | send_meme/learn_meme 激活；路由/管理面板全走通 |

**适配过程钉死的五个规则（全部已固化）**：
1. 服务包间 peer 链在 `--legacy-peer-deps` 下不自动装 → 用"import 报错→补装→重试"循环收敛（本次 3 轮：dsh-http-proxy 等）。
2. `cordis effect(fn)` 返回值必须满足 disposer 合约（function/promise/generator/null）——stub 的 register 返回对象会炸出 "Invalid effect"，返回 disposer 即合规。cordis 4 的 effect 与 0.1.x 普通函数语义兼容，无需垫片。
3. 对象形态装载时 apply 的 config 参数必须桥侧补默认 `{}` 并喂插件清单 config——dsh loader 的 schemastery 填默认行为桥要手动复刻（lsp-actions 顶层 max* 字段）。
4. 插件 `console.log` 打 stdout 会污染 MCP 帧 → 桥启动时全局重定向 stderr。
5. stdout 出现非 JSON 行时 test-client 崩溃——已由第 4 条根治。

**exit-code 门禁数据修复（用户"vibe 改写插件代码"思路的第一个实战）**：`pwc_fingerprints` 命中门禁时 exit 1 + stdout 合法 JSON（ok:false + total/by_pattern/files），原 runPwc 直接 reject → 报告判定 🔴 数据丢失。桥适配副本改 3 行（exit≠0 但 stdout 可 parse 出带 ok 字段的 JSON → resolve），实测 `total=2, patterns=shopify,original\.css` 完整送达 structuredContent。**结论：个别插件的特异 bug，改插件副本 3 行 > 桥侧通用启发式**——改写发生在桥管理的 plugins/ 副本上（标记 [bridge-adapted]），上游修复后可回退。

**对 40 分报告的最终更新**：① skills 注册已通（剩送达通道=instructions/prompts，P0）；③ 已修；⑤ 服务面 12/20（剩余绑 harness 深层语义：agent 会话流、llm 真调用）。三个实测样本全部激活且工具可达。

### 补充 I：skills 送达三通道全通（2026-10-09 傍晚，"最后一跳"桥侧完成）

注册环节早已通（skills 服务真激活），本轮补齐**送达 agent** 的三条协议内通道：
1. **initialize `instructions`**：握手响应带 skills 摘要（名字+描述+"用 bridge_skills_read 读全文"），支持它的客户端拼进系统提示。注意 SkillRegistry.snapshot() 是 async 且默认不含 content，全文走 `await ctx.skills.get(name)`。
2. **bridge_skills_list / bridge_skills_read 工具**：走 dsh-tools 正常注册，任何 MCP 客户端零门槛可用（实测读出 pwc 的 10756 字符剧本全文）。
3. **prompts 能力**：prompts/list（每 skill 一条）+ prompts/get（返回全文 messages）。协议完备性，客户端不用也无碍。

selftest 扩至 9 PASS（20 工具在清单）。

**orbcat 侧剩余一环**（下一轮）：mcp.rs 的 `initialize()` 现在只取 serverInfo/name，丢弃 `instructions`（mcp.rs:707）。接入方案走 capability_index 同款缓存文件模式：StdioSession 加字段 → 快照拉取时写入 `<data_dir>/mcp_instructions.txt` → agent.rs 组装 system prompt 的 MCP 段落时读入拼接（mcp.rs ~40 行 + agent.rs ~10 行 + 单测，cargo build dev 37s）。
