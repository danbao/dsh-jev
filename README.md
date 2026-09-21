# dsh-jev

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 **TypeSafe Jev / System One 决策工具**。

给 agent 一个 `jev_ask` 工具：传入一段 **state** 和一组 **typed questions**，拿回**结构化的判断**
（概率、选项、评分），而不是一段需要再解析的散文。

```text
jev_ask({
  state: "客户说我被重复扣款了，已经三天，很着急。",
  questions: [
    { id: "urgent",  type: "noul",   instructions: "这条消息是否表达紧迫性？" },
    { id: "team",    type: "choice", instructions: "应该由哪个团队处理？",
      options: ["billing", "technical", "sales"] },
    { id: "anger",   type: "score",  instructions: "客户有多不满？",
      levels: ["平静", "不满", "非常愤怒"] }
  ]
})
```

回答是**代码可以直接分支**的值：

```json
{
  "model": "typesafe/jev-1.13-20260917",
  "answers": [
    { "id": "urgent", "type": "noul",   "value": 0.95 },
    { "id": "team",   "type": "choice", "value": "billing",
      "confidence": 0.81, "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0 } },
    { "id": "anger",  "type": "score",  "value": 1.05,
      "confidence": 0.92, "probabilities": { "0": 0, "1": 0.95, "2": 0.05 },
      "legend": { "0": "平静", "1": "不满", "2": "非常愤怒" } }
  ],
  "usage": { "input_tokens": 318, "output_tokens": 34, "cost": 0.0000134 }
}
```

---

## 设计要点

- **不依赖任何厂商 SDK。** 直接用 `fetch` 调 `POST /v1/systemone`。OpenRouter 与 TypeSafe 官方
  实现的是**同一套请求/响应契约**，所以切换后端只是换 baseURL、密钥和 model 写法——
  [OpenRouter 文档](https://openrouter.ai/docs/guides/community/typesafe-sdk)明确说明 SDK 会把
  `/v1/systemone` 拼到 base URL 后面。省掉 SDK 依赖后，插件的依赖面只有 dsh 本身。
- **默认走 OpenRouter。** 一个 OpenRouter key 就能用；`backend: typesafe` 可切到官方端点。
- **密钥按调用解析，绝不缓存。** 解析顺序：`apiKey` 字面量 → `credentials` 服务 →
  进程环境。轮换密钥不需要重启。`credentials` 服务缺失时自动降级到环境变量
  （某些桌面 profile 上 `ctx.get('credentials')` 确实返回 undefined）。
- **缺密钥不阻塞插件加载。** 加载时只记一条 warn，真正报错发生在第一次 `jev_ask`，
  并且是模型可见的可操作错误。这样 profile 先装插件、后配密钥也能正常工作。
- **边界严格校验。** 发送前校验问题（Choice ≤255 选项、Score 2–10 级、指令非空）；
  收到回复后校验答案（每个问题都有答案、不得出现没被提供的选项、概率和为 1、类型匹配）。
  校验失败一律**整体失败**，绝不半读一个判断。**Noul 答案一定不带 `confidence`**——
  API 本身不给，本插件也不会替你编一个。
- **重试与分类。** 只有 429 / 529 / 5xx / 超时 / 连接失败会退避重试（尊重 `Retry-After`）；
  401/403/404/422 立即失败。整通调用有 `budgetMs` 预算，单次尝试有 `timeoutMs`。

## 非目标（v1 刻意不做）

- **不做决策层。** 不绑定 `agent/pre-step`、`tools/pre-execute`、`agent/request`，
  不做工具收窄、调用前门禁、模型路由。这条路失败了会是**权限问题**，
  而 `jev_ask` 失败了只是一个工具报错。要加也应该是独立的一层，而不是塞进这个工具。
- **不自动加载 skill、不改 DSH 循环、不缓存审批、不做 dashboard。**
- **没有浏览器配置卡片。** 配置走 `cordis.yml` / dsh settings 文档；密钥走 credentials 服务。

## 安装

```sh
cd /path/to/dsh-jev
npm install
npm run build          # dsh 从 dist/ 加载，安装前必须先构建

dsh plugin --profile <name> add /path/to/dsh-jev
dsh --profile <name> --dump-config    # 应能看到 "# == dsh-jev" 层与 jev 行
```

开发模式（不装进 profile，直接 `--patch` 覆盖）：

```sh
npm run dev            # tsc --watch
dsh web --patch ./cordis.patch.yml
```

## 配置

最小配置：只需要一个密钥。

```sh
export OPENROUTER_API_KEY=sk-or-...
```

其余全部有默认值；要改就覆盖 `config` 行（全部字段见 [`cordis.yml`](./cordis.yml)）：

```yaml
- id: jev
  name: 'dsh-jev'
  config:
    backend: typesafe            # openrouter（默认）| typesafe
    apiKeyEnv: TYPESAFE_API_KEY  # 凭据引用（环境变量名）
    model: jev-latest            # 留空按 backend 取默认
    timeoutMs: 20000
    budgetMs: 45000
    maxRetries: 1
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `openrouter` | `openrouter` \| `typesafe` |
| `apiKeyEnv` | 按 backend | 凭据引用；`openrouter` → `OPENROUTER_API_KEY`，`typesafe` → `TYPESAFE_API_KEY` |
| `apiKey` | — | 字面密钥（`role('secret')`）；**不推荐**，优先用 `apiKeyEnv` |
| `baseURL` | 按 backend | 自建网关/代理时覆盖 |
| `model` | 按 backend | `openrouter` → `jev-1.13`；`typesafe` → `jev-latest` |
| `timeoutMs` / `budgetMs` | 20000 / 45000 | 单次尝试超时 / 整通预算（含重试退避） |
| `maxRetries` | 1 | 首次失败后的重试次数 |
| `maxQuestions` | 64 | 单次调用最多问题数 |
| `maxStateChars` | 96000 | `state` 序列化后的字符上限 |
| `maxInstructionChars` | 8000 | 单条指令的字符上限 |
| `appName` / `appUrl` | `dsh-jev` / — | OpenRouter 归因头 `X-Title` / `HTTP-Referer` |
| `logRequests` | true | 每次调用的结构化日志 |

`timeoutMs > budgetMs` 或 `baseURL` 不是合法 URL 时，settings 写入会被**拒绝**，
避免"文档说改了、运行时没改"。

### 模型 id 两种后端的差别

| | OpenRouter | TypeSafe 官方 |
|---|---|---|
| 别名 | `jev-latest` → `~typesafe/jev-latest` | `jev-latest` |
| 版本 | `jev-1.13` → `typesafe/jev-1.13` | `jev-1.13.0` |
| 钉版本 | `typesafe/jev-1.13-20260917` | 同上风格 |
| 额外字段 | 响应含 `id`、`provider`、`usage.cost` | 无 |

## 工具契约

`jev_ask(state | state_json, questions[])`

- `state`：要评估的文本。**发出去的都是要评估的**，只放问题需要的内容。
- `state_json`：结构化 state 的 JSON 字符串（记录、聊天日志、应用状态）；两者都给时以它为准。
- `questions[]`：
  - `id`（必填，唯一）：答案按它回传。
  - `type`（必填）：`noul` | `choice` | `score`。
  - `instructions`（必填）：一个**原子**问题。
  - `options`（`choice` 必填）：候选选项。
  - `levels`（`score` 必填）：2–10 个等级，从低到高。
  - `true_meaning` / `false_meaning`（`noul` 可选）：说明"是/否"各是什么意思。

服务端硬约束（本地就会拦下来，不会白花一次往返）：Choice 最多 **255** 个选项，
Score 只能 **2–10** 级，单次请求上下文 64k（`state` + 最长问题 ≤32k）。

### 用法建议

- **问原子问题。** 不要问"给这个 pitch 打分"，而是分别问市场规模、技术可行性、差异化，
  再用你自己的公式加权——权重变了改代码，而不是改 prompt。
- **一次问多个。** 同一请求内的问题彼此独立、并行评估，所以批量问几乎不增加延迟。
- **自己设阈值。** 概率是给你分支用的；`choice` 命中了最高概率并不等于确定，看 `confidence`。
- **别把 Noul 当风险百分比展示。** 它是 yes/no 的概率。

## 项目结构

```
src/
  index.ts              插件：注册 jev_ask + settings 段
  config.ts             schemastery 配置与默认值
  credentials.ts        密钥解析（credentials → 环境变量）
  tool.ts               jev_ask 工具定义与答案格式化
  systemone/
    types.ts            System One 线路类型
    errors.ts           错误分类（哪些可重试）
    questions.ts        本地问题/状态校验 + 构造器
    validate.ts         回复的边界校验（严格）
    client.ts           fetch 客户端：重试、预算、超时、归因头
tests/                  71 个测试，全部注入 fetch，不触网
```

## 测试与验证

```sh
npm run typecheck   # src + tests，严格模式（noUncheckedIndexedAccess 等）
npm test            # 71 个测试
npm run build
```

测试里包含一个**真的端到端**用例：在真实 Cordis Context 上挂载真实的 `ToolRuntime`，
注册插件，再通过 registry 调 `jev_ask`——参数校验、输出 schema 校验、内容渲染全都是真的，
只有 `fetch` 是 stub。

### 已核对的上游（2026-09-21）

| 来源 | 版本/结论 |
|---|---|
| DSH | `0.1.6-alpha.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| `@deepseek-ai/schemastery` | `3.18.2` |
| 用到的 DSH 接口 | `defineTool` / `ctx.tools.register`、`ctx.settings.installSection`、`credentials.credentialRef` + `resolve`/`describe`、`z.string().role('credential-ref'/'secret')` |
| [TypeSafe API 参考](https://docs.typesafe.ai/api) | `POST /v1/systemone`，`{state, model, questions}` → `{model, answers, usage}`；Choice ≤255、Score 2–10、context 64k |
| [OpenRouter System One](https://openrouter.ai/docs/guides/community/typesafe-sdk) | base URL `https://openrouter.ai/api` + `/v1/systemone`；模型映射规则；额外 `id`/`provider`/`usage.cost` |

## 已知限制

- 只实现了 `systemone` 一个端点。TypeSafe SDK 的 `client.models.list()` 在 OpenRouter 上会失败
  （它返回的是 OpenRouter 的模型形状），所以本插件**不提供模型列举**。
- `score` 的 `legend` 优先用服务返回的；服务没给时用调用方传的 `levels` 文案兜底。
- 概率和只允许 1% 的舍入漂移；这是为了避免服务端浮点舍入造成误判。
- 没有 live 端到端测试：CI 与本地测试都不带真实密钥，真实调用需要你自己配 key。
- 非英语内容 Jev 也能处理但准确率不如英语（TypeSafe 自己的说明），跨语言使用时请看 `confidence`。

## 许可

MIT
