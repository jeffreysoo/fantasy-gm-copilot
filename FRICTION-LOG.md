# Friction Log: Fantasy GM Copilot

**Project:** Multi-tool AI agent (Next.js 16 + Vercel AI SDK v7 + AI Gateway)  
**Build date:** September 2026  
**Machine:** macOS arm64, clean dev environment  

---

## 1. Setup & Toolchain

### 1.1 Clean-machine Node setup

| | |
|---|---|
| **Trying to do** | Scaffold a Next.js project on a fresh macOS arm64 machine with no Node, no Homebrew. |
| **Signal needed** | Clear error message pointing to the root cause (file permissions). |
| **Where I found it** | `npm install` threw `EACCES` errors buried in a wall of output. Root cause: `~/.npm` cache directory was owned by `root` from a prior system-level install. |
| **The answer** | Installed Node via `nvm`. Fixed the cache with `sudo chown -R $(whoami) ~/.npm`. For the initial scaffold, used `--cache /tmp/npm-cache` to bypass the poisoned cache entirely. |

**Observability takeaway:** The `EACCES` error is a classic "wrong signal" problem. The error points at the package being installed, not the cache directory that's actually broken. A first-time developer would think the package is corrupt, not that a hidden directory has wrong ownership.

---

### 1.2 npm vs pnpm mid-build switch

| | |
|---|---|
| **Trying to do** | Switch from npm to pnpm after scaffolding, to match Vercel's recommended toolchain. |
| **Signal needed** | Clear guidance on whether both lock files can coexist; what `approve-builds` does in non-interactive mode. |
| **Where I found it** | Trial and error. pnpm's `approve-builds` mechanism for native addons (esbuild, unrs-resolver) launched an interactive prompt that didn't work in non-TTY environments (piped shells, CI, Claude Code). It wrote placeholder values like `"set this to true or false"` into `pnpm-workspace.yaml`. |
| **The answer** | Manually edited `pnpm-workspace.yaml` to set `allowBuilds: esbuild: true` and `unrs-resolver: true`. Deleted `package-lock.json`. The non-TTY failure mode is silent -- no error, just broken config that causes builds to skip native compilation. |

**Observability takeaway:** The `approve-builds` placeholder values are a textbook "silent misconfiguration." In a CI/CD pipeline, this would produce a deploy that looks successful but ships without compiled native modules. No warning, no error -- just degraded performance or runtime crashes later.

---

### 1.3 Vercel CLI login issues

| | |
|---|---|
| **Trying to do** | Log in to Vercel CLI to link the project and deploy. |
| **Signal needed** | An error message from `npx vercel login` explaining why it wasn't working. |
| **Where I found it** | Nowhere. The command appeared to run but silently failed -- `npx` itself was hitting the same `EACCES` cache bug from 1.1, so the `vercel` binary never actually executed. No error output. |
| **The answer** | Used the project-local binary directly: `./node_modules/.bin/vercel login --oob`. The `--oob` flag is deprecated but still functional -- it provides a device-code URL for headless/SSH login. Without `--oob`, the CLI tries to open a browser, which doesn't work in headless environments. |

**Observability takeaway:** `npx` swallowing errors is dangerous. The user sees what looks like a successful command invocation (exit code 0, no stderr) but nothing actually happened. This is the worst kind of failure mode for developer tools: silent no-ops.

---

## 2. AI Gateway & SDK

### 2.1 Credit card wall on "free" tier

| | |
|---|---|
| **Trying to do** | Make the first AI Gateway API call using the advertised $5/month free credits. |
| **Signal needed** | A clear error explaining what's required to activate the free tier. |
| **Where I found it** | Every request returned HTTP 403: `"requires a valid credit card."` Docs say $5/mo free credits exist, but the Gateway enforces a payment method before any usage. |
| **The answer** | Added a credit card. Then hit a second wall: `"Free tier users do not have access to this model"` for Claude models (Anthropic via Gateway). Switched to `gpt-4o-mini`. Then hit HTTP 429 rate limiting on consecutive calls -- the free tier can't support a multi-step agent loop that makes 2-3 rapid API calls in sequence. |

**Observability takeaway:** Three distinct failure modes stacked on top of each other (no card -> wrong model -> rate limit), each only discoverable after fixing the previous one. The 403 error message doesn't distinguish between "no payment method" and "model not available on your plan." A developer debugging this would benefit enormously from structured error responses that include `error_code`, `required_action`, and `docs_url`.

---

### 2.2 AI SDK v7 breaking change -- `generateText` no longer loops

| | |
|---|---|
| **Trying to do** | Build a multi-step tool-calling agent using `generateText` with `maxSteps: 6` (the documented v4/v5 pattern). |
| **Signal needed** | A deprecation warning, runtime error, or migration guide explaining that `maxSteps` no longer drives tool-call loops in v7. |
| **Where I found it** | Nowhere during development. `generateText` with `maxSteps` compiled, ran, and returned a 200 response -- but silently completed after 1 step. No tools were called. No warning logged. The response was just the model's text without any tool-augmented data. |
| **The answer** | AI SDK v7 replaced the implicit tool loop in `generateText` with an explicit `ToolLoopAgent` class and `isStepCount()` stop condition. The migration required changing from: `generateText({ model, tools, maxSteps: 6 })` to: `new ToolLoopAgent({ model, tools, stopWhen: isStepCount(4) })` followed by `agent.generate({ prompt })`. No compile-time or runtime signal pointed to this change. |

**Observability takeaway:** This is the single most impactful friction point in the build. A breaking behavioral change with no signal at any layer -- no TypeScript error, no console warning, no HTTP error. The API surface looks identical but the semantics changed completely. For an observability product, this is exactly the kind of regression that distributed tracing should catch: "this span used to have 3 child tool-call spans; now it has 0."

---

### 2.3 Responses API vs Chat Completions red herring

| | |
|---|---|
| **Trying to do** | Debug why the agent wasn't calling tools (symptom from 2.2 above). |
| **Signal needed** | Clarity on whether the AI Gateway supports the OpenAI Responses API (`/v1/responses`) vs Chat Completions (`/v1/chat/completions`), and whether that was causing the tool-call failure. |
| **Where I found it** | The AI SDK defaults to the Responses API. Tried `useResponsesAPI: false` on the provider to force Chat Completions. Same behavior -- still no tool calls. |
| **The answer** | The API format was a red herring. The real issue was the v7 `generateText` behavioral change (2.2). Both Responses API and Chat Completions work fine through the Gateway. Time spent debugging: ~30 minutes on the wrong hypothesis. |

**Observability takeaway:** When multiple things change at once (SDK version + API provider + API format), it's extremely hard to isolate the root cause. Request-level traces that show the actual HTTP payload sent to the upstream model would have immediately revealed that tool definitions were present in the request but the SDK wasn't re-prompting after the first response.

---

### 2.4 Free tier rate limiting workaround

| | |
|---|---|
| **Trying to do** | Run the full agent loop (roster + injuries + trending data) without hitting 429s. |
| **Signal needed** | Rate limit headers (`X-RateLimit-Remaining`, `Retry-After`) or dashboard visibility into quota usage. |
| **Where I found it** | The 429 responses included minimal information. No visibility into how close to the limit I was before hitting it, or when the window resets. |
| **The answer** | Redesigned the agent prompt to force parallel tool calling: all 3 tools in 1 step, then a final response in step 2. This reduced API calls from 3-4 (sequential tool loop) to exactly 2. Combined with spacing test runs ~60 seconds apart. The system prompt now includes: `"Call ALL THREE tools in a single parallel tool call. Do NOT call them one at a time."` |

**Observability takeaway:** The workaround is a prompt-engineering hack to stay under rate limits. It works, but it's fragile -- if the model decides to call tools sequentially anyway, the whole thing breaks. Real-time rate limit visibility (remaining calls, window reset time) in the Gateway dashboard or response headers would make this manageable instead of trial-and-error.

---

### 2.5 ESPN User-Agent gotcha

| | |
|---|---|
| **Trying to do** | Fetch NFL injury news from ESPN's public API. |
| **Signal needed** | An error message or documentation explaining the UA restriction. |
| **Where I found it** | HTTP 403 on every request. Tested with `curl` -- default `curl` UA worked; browser-style UA got blocked. |
| **The answer** | ESPN's API silently blocks requests with browser-like `User-Agent` strings. Set a custom UA header: `"User-Agent": "fantasy-gm-copilot/1.0"` in the fetch call. This is baked into `src/lib/espn.ts`. |

**Observability takeaway:** Third-party API behavior is opaque by definition. An external dependency health dashboard that tracks response codes per upstream would surface this instantly -- "ESPN endpoint went from 100% 200s to 100% 403s when we changed our HTTP client."

---

## 3. Observability & Tracing

_To be completed after instrumenting with `@vercel/otel` and evaluating trace output in Vercel's dashboard._

Planned areas of investigation:
- Trace propagation through the agent loop (does each tool call get its own span?)
- Visibility into AI Gateway latency vs upstream model latency
- Error attribution: when a tool fails, does the trace show which step and which tool?
- Cold start impact on serverless function traces

---

## 4. Native Observability vs External Tools

_To be completed after comparing Vercel's built-in observability with external alternatives._

Planned comparisons:
- Vercel dashboard traces vs raw OpenTelemetry export
- AI Gateway metrics vs self-instrumented LLM call tracking
- What's visible out of the box vs what requires custom spans

---

## 5. Architecture Decisions

### 5.1 Data source selection — what to add, what to skip

| | |
|---|---|
| **Trying to do** | Evaluate third-party APIs to make the agent's recommendations more sophisticated beyond Sleeper + ESPN. |
| **Signal needed** | Which free APIs provide high-signal data without eating the build budget on auth plumbing or quota management. |
| **Where I found it** | Tested The Odds API, Open-Meteo, FantasyCalc, FantasyPros, SportsDataIO, SharpAPI, nfl_data_py. |
| **The answer** | Added **Open-Meteo** (weather — zero auth, one fetch per game, high impact for start/sit) and **FantasyCalc** (trade values from real trades — zero auth, makes trade recs credible). Skipped The Odds API (500 credits drains in ~85 calls), SportsDataIO (free = last season only), nfl_data_py (Python, not REST), FantasyPros (free tier may gate key endpoints). |

**Decisions:**
- **9 total tools** across 4 data sources (Sleeper, ESPN, Open-Meteo, FantasyCalc) — rich observability surface with multiple independent dependencies to trace.
- **4 new Sleeper tools:** `getLeagueStatus`, `getPlayerCurrentOwner`, `getBestAvailable`, `getPlayerStats` — fills gaps in the agent's reasoning (can't propose trades without knowing who owns the player; can't suggest waivers without knowing who's actually available in the league).
- **2 new external tools:** `getWeather` (Open-Meteo), `getTradeValues` (FantasyCalc).
- Each new external dependency is a new span in traces, a new failure domain, and a new point of comparison for the observability story.

**Observability takeaway:** Deliberately choosing 4 independent upstream dependencies creates the exact multi-dependency failure surface that distributed tracing is built for. When the agent is slow, the trace immediately shows whether it's the model, Sleeper, ESPN, Open-Meteo, or FantasyCalc. This isn't an accident — it's the architecture serving the observability narrative.

---

## Summary of Signal Gaps

| Friction Point | Root Cause | Signal That Would Have Helped |
|---|---|---|
| npm cache EACCES | Wrong directory ownership | Error message naming the directory, not the package |
| pnpm approve-builds | Non-TTY fallback writes garbage | Non-zero exit code or stderr warning |
| npx silent failure | npx swallows downstream errors | Exit code propagation, stderr passthrough |
| Gateway 403 | Credit card required despite "free tier" | Structured error with `required_action` field |
| SDK v7 tool loop | Behavioral breaking change, no signal | Deprecation warning on `maxSteps` with tools |
| Rate limiting | No pre-429 visibility | `X-RateLimit-Remaining` headers, dashboard gauge |
| ESPN UA block | Third-party silent rejection | Upstream health tracking per dependency |
