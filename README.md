# dsh-jev

**TypeSafe Jev (System One) decision tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

Gives the agent a `jev_ask` tool: send a **state** and a set of **typed questions**, get back
**structured judgments** — probabilities, a chosen option, a rubric score — instead of prose that
still has to be parsed.

```text
jev_ask({
  state: "Customer says they were charged twice, three days ago, and is upset.",
  questions: [
    { id: "urgent", type: "noul",   instructions: "Does this express urgency?" },
    { id: "team",   type: "choice", instructions: "Which team should handle this?",
      options: ["billing", "technical", "sales"] },
    { id: "anger",  type: "score",  instructions: "How upset is the customer?",
      levels: ["Calm", "Frustrated", "Very angry"] }
  ]
})
```

The answers are values your code can branch on:

```json
{
  "model": "typesafe/jev-1.13-20260917",
  "answers": [
    { "id": "urgent", "type": "noul",   "value": 0.95 },
    { "id": "team",   "type": "choice", "value": "billing",
      "confidence": 0.81, "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0 } },
    { "id": "anger",  "type": "score",  "value": 1.05,
      "confidence": 0.92, "probabilities": { "0": 0, "1": 0.95, "2": 0.05 },
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" } }
  ],
  "usage": { "input_tokens": 318, "output_tokens": 34, "cost": 0.0000134 }
}
```

English | [中文说明](./README.zh-CN.md)

---

## Design notes

- **No vendor SDK.** The plugin calls `POST /v1/systemone` with plain `fetch`. OpenRouter and
  TypeSafe serve the *same request/response contract*, so switching backends means changing a base
  URL, a key, and a model id — the
  [OpenRouter docs](https://openrouter.ai/docs/guides/community/typesafe-sdk) state that the SDK
  simply appends `/v1/systemone` to the base URL. Dropping the SDK leaves the plugin's dependency
  surface at the harness itself.
- **OpenRouter by default.** One OpenRouter key is enough; `backend: typesafe` switches to the
  official endpoint.
- **The API key is resolved per call and never cached.** Order: a literal `apiKey` → the
  `credentials` service → the process environment. A rotated key needs no restart. When the
  credentials service is absent the resolver falls back to the environment, which matters because
  some desktop profiles return `undefined` from `ctx.get('credentials')`.
- **A missing key does not block plugin load.** Load logs one warning; the real error happens on the
  first `jev_ask` call, as an error the model can act on. This lets a profile install the plugin
  before the key exists.
- **Strict validation at both boundaries.** Outgoing questions are checked (Choice ≤255 options,
  Score 2–10 levels, non-empty instructions); incoming answers are checked (every question answered,
  no option that was never offered, distribution sums to one, type matches). A violation fails the
  **whole** call — a judgment is never half-read. **A Noul answer never carries a `confidence`**:
  the API does not provide one and this plugin will not invent one.
- **Retries are classified.** Only 429 / 529 / 5xx / timeout / connection failures retry with
  backoff (honouring `Retry-After`); 401/403/404/422 fail immediately. A whole-call `budgetMs` covers
  every attempt and its backoff; `timeoutMs` bounds one attempt.

## Non-goals (deliberately out of scope for v1)

- **No decision layer.** The plugin does not bind `agent/pre-step`, `tools/pre-execute`, or
  `agent/request`; it does no tool narrowing, no pre-execution gate, no model routing. When that
  layer fails it is a *permissions* problem, whereas a `jev_ask` failure is just a failed tool call.
  Adding it should be a separate layer rather than something folded into this tool.
- **No automatic skill loading, no harness loop changes, no approval caching, no dashboard.**
- **No browser configuration card.** Configuration lives in `cordis.yml` / the dsh settings document;
  the key lives in the credentials service.

## Install

```sh
cd /path/to/dsh-jev
npm install
npm run build          # dsh loads from dist/, so build before installing

dsh plugin --profile <name> add /path/to/dsh-jev
dsh --profile <name> --dump-config    # expect the "# == dsh-jev" layer and the jev row
```

Development mode (no profile install, override with `--patch`):

```sh
npm run dev            # tsc --watch
dsh web --patch ./cordis.patch.yml
```

## Configuration

The minimal setup is one key:

```sh
export OPENROUTER_API_KEY=sk-or-...
```

Everything else has a default. Override the row's `config` to change it — every field is documented
in [`cordis.yml`](./cordis.yml):

```yaml
- id: jev
  name: 'dsh-jev'
  config:
    backend: typesafe            # openrouter (default) | typesafe
    apiKeyEnv: TYPESAFE_API_KEY  # credential reference (an environment variable name)
    model: jev-latest            # omit to use the per-backend default
    timeoutMs: 20000
    budgetMs: 45000
    maxRetries: 1
```

| Field | Default | Meaning |
|---|---|---|
| `backend` | `openrouter` | `openrouter` \| `typesafe` |
| `apiKeyEnv` | per backend | Credential reference; `openrouter` → `OPENROUTER_API_KEY`, `typesafe` → `TYPESAFE_API_KEY` |
| `apiKey` | — | Literal key (`role('secret')`). **Discouraged**; prefer `apiKeyEnv` |
| `baseURL` | per backend | Override for a self-hosted gateway or proxy |
| `model` | per backend | `openrouter` → `jev-1.13`; `typesafe` → `jev-latest` |
| `timeoutMs` / `budgetMs` | 20000 / 45000 | Per-attempt timeout / whole-call budget (including retry backoff) |
| `maxRetries` | 1 | Retries after the first attempt |
| `maxQuestions` | 64 | Maximum questions per call |
| `maxStateChars` | 96000 | Character limit on the serialized `state` |
| `maxInstructionChars` | 8000 | Character limit on one instruction |
| `appName` / `appUrl` | `dsh-jev` / — | OpenRouter attribution headers `X-Title` / `HTTP-Referer` |
| `logRequests` | true | Structured log line per evaluation |

A settings write is **rejected** when `timeoutMs > budgetMs` or `baseURL` is not a valid URL, so the
settings document and the running plugin never disagree.

### Model ids across the two backends

| | OpenRouter | TypeSafe direct |
|---|---|---|
| Alias | `jev-latest` → `~typesafe/jev-latest` | `jev-latest` |
| Version | `jev-1.13` → `typesafe/jev-1.13` | `jev-1.13.0` |
| Pinned | `typesafe/jev-1.13-20260917` | same style |
| Extra fields | response carries `id`, `provider`, `usage.cost` | none |

## Tool contract

`jev_ask(state | state_json, questions[])`

- `state` — the text to evaluate. **Everything sent is evaluated**, so include only what the
  questions need.
- `state_json` — structured state as a JSON string (records, chat logs, application state). Takes
  precedence over `state` when both are given.
- `questions[]`:
  - `id` (required, unique) — answers come back under this id.
  - `type` (required) — `noul` | `choice` | `score`.
  - `instructions` (required) — one **atomic** question.
  - `options` (required for `choice`) — the options to choose between.
  - `levels` (required for `score`) — 2–10 levels, lowest first.
  - `true_meaning` / `false_meaning` (optional, `noul`) — what yes and no mean.

Service-side hard limits, enforced locally so a bad request never costs a round trip: at most **255**
Choice options, **2–10** Score levels, and a 64k context per request (`state` plus the longest
question ≤32k).

### Usage guidance

- **Ask atomic questions.** Instead of "rate this pitch", ask about market size, technical
  feasibility, and differentiation separately, then weight them with your own formula — changing a
  coefficient then means changing code, not a prompt.
- **Batch questions.** Questions in one request are evaluated independently and in parallel, so
  asking many at once barely costs more latency.
- **Set your own thresholds.** The probabilities exist so your code can branch; a `choice` answer
  being the highest-probability option does not make it certain — look at `confidence`.
- **Never present a Noul as a risk percentage.** It is the probability of a yes/no statement.

## Layout

```
src/
  index.ts              plugin: registers jev_ask and the settings section
  config.ts             schemastery config and defaults
  credentials.ts        key resolution (credentials service -> environment)
  tool.ts               the jev_ask tool definition and answer formatting
  systemone/
    types.ts            System One wire types
    errors.ts           error classification (which codes are retryable)
    questions.ts        local question/state validation and builders
    validate.ts         strict boundary validation of the reply
    client.ts           fetch client: retries, budget, timeout, attribution headers
tests/                  78 tests, every one injecting fetch; nothing touches the network
```

## Tests and verification

```sh
npm run typecheck   # src + tests, strict (noUncheckedIndexedAccess and friends)
npm test            # 78 tests (builds first, via pretest)
npm run build
```

One test is genuinely end to end: it mounts the real `ToolRuntime` on a real Cordis context,
registers this plugin, and calls `jev_ask` through the registry — argument validation, output-schema
validation, and content rendering are all real, with only `fetch` stubbed.

### Verified against (2026-09-21)

| Source | Version / result |
|---|---|
| DSH | `0.1.6-alpha.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| `@deepseek-ai/schemastery` | `3.18.2` |
| DSH interfaces used | `defineTool` / `ctx.tools.register`, `ctx.settings.installSection`, `credentials.credentialRef` + `resolve`/`describe`, `z.string().role('credential-ref' / 'secret')` |
| [TypeSafe API reference](https://docs.typesafe.ai/api) | `POST /v1/systemone`, `{state, model, questions}` → `{model, answers, usage}`; Choice ≤255, Score 2–10, 64k context |
| [OpenRouter System One](https://openrouter.ai/docs/guides/community/typesafe-sdk) | base URL `https://openrouter.ai/api` + `/v1/systemone`; model mapping rules; extra `id`/`provider`/`usage.cost` |

## Known limitations

- Only the `systemone` endpoint is implemented. The TypeSafe SDK's `client.models.list()` fails
  against OpenRouter (it returns OpenRouter's model shape), so this plugin **does not list models**.
- A Score answer's `legend` prefers the service's own wording and falls back to the caller's
  `levels` text when the service omits it.
- Probability distributions are allowed 1% rounding drift, to avoid rejecting a valid answer over
  float rounding.
- There is no live end-to-end test: neither CI nor the local suite carries a real API key. A real
  call needs your own key.
- Jev handles non-English content but is most accurate in English (TypeSafe's own guidance); watch
  `confidence` when working across languages.

## License

MIT
