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

### 3.1 Debugging the first deploy — env var misconfiguration

| | |
|---|---|
| **Trying to do** | Deploy to Vercel and make the first successful AI agent call. |
| **Signal needed** | A clear error linking the 500 to the missing environment variable. |
| **Where I found it** | The deployment detail page showed `POST /api/chat` → 500, and under External APIs: "No outgoing requests." That second signal was the most useful — it proved the failure happened *before* any API call, narrowing the cause to config/env. The function logs showed: `OpenAI API key is missing`. |
| **The answer** | The Vercel env var UI allowed saving a variable with a **blank key name** — only the value was entered. No validation error, no warning. The env var existed in the dashboard but had no name, so `process.env.AI_GATEWAY_API_KEY` was `undefined` at runtime. Fixed by editing the variable to add the key name, then redeploying. |

**Observability takeaway:** The "No outgoing requests" signal in the deployment detail was genuinely helpful — it narrowed the search space immediately. But there's no "here's why this function failed" drill-down that shows which env vars were available to the function. A view connecting "function errored → env vars it tried to read → which ones were undefined" would have made this a 30-second fix instead of a 10-minute investigation.

---

### 3.2 CLI metrics — everything requires Observability Plus

| | |
|---|---|
| **Trying to do** | Query function invocation counts, AI Gateway usage, and external API metrics from the Vercel CLI. |
| **Signal needed** | Metrics data, or at minimum a clear indication of what's available on the free tier. |
| **Where I found it** | Every `vercel metrics` query returned: `Error: Observability Plus is required for this query.` Even basic counts without `--group-by` are paywalled. The only CLI observability that works on the free tier is `vercel logs`. |
| **The answer** | The Vercel dashboard (web UI) provides some free-tier visibility that the CLI doesn't — basic charts for functions, external APIs, etc. But programmatic access to any metric requires the paid add-on. |

**Observability takeaway:** The CLI `vercel metrics schema` command happily lists 95 available metrics with all their dimensions and aggregations — but none of them are queryable on the free tier. This is misleading. The schema implies availability; the paywall only appears when you try to query. A `--plan hobby` filter on the schema output, or a note like "requires Plus" next to each metric, would set expectations correctly.

---

### 3.3 External APIs section — data without detail

| | |
|---|---|
| **Trying to do** | Understand which external API calls `/api/roster` was making and how long each took. |
| **Signal needed** | Request URLs and durations for each outbound call. |
| **Where I found it** | The deployment detail page showed 18 GET requests under External APIs — but with **blank URLs**. Just `GET` repeated 18 times with no hostnames, paths, or durations per call. |
| **The answer** | The data exists (Vercel clearly intercepts outbound fetches to count them), but the free tier doesn't expose the details. To debug "which API call is slow," you'd need to add your own logging or upgrade to see the `requestHostname` and `requestPath` dimensions. |

**Observability takeaway:** Showing the count of external calls without the URLs is tantalizing but not actionable. It's like a doctor saying "you have 18 symptoms" without naming any of them. The information creates a question it can't answer.

---

### 3.4 Single route hides agent-level behavior

| | |
|---|---|
| **Trying to do** | Determine which AI agent (lineup, waivers, trades, coordinator) was causing rate limits and slowness. |
| **Signal needed** | Per-agent metrics — duration, error rate, token usage, model calls. |
| **Where I found it** | Observability → Functions showed only `POST /api/chat` as a single route. All four agents were behind one endpoint, so there was no way to see "the lineup agent takes 6s but the trade agent takes 12s" or "waivers is the one getting rate-limited." |
| **The answer** | Split the single `/api/chat` endpoint into four separate routes: `/api/chat/lineup`, `/api/chat/waivers`, `/api/chat/trades`, `/api/chat/coordinator`. Each maps to one agent. Now Vercel's per-route observability naturally segments them. This is an application architecture change driven entirely by observability needs. |

**Observability takeaway:** Vercel's observability is fundamentally **route-level**. For traditional REST APIs where each route maps to one behavior, this works well. For AI agent apps where a single orchestrator endpoint delegates to multiple agents, it's blind. The fix was straightforward (split routes), but it's worth noting that the observability tool shaped the application architecture — not the other way around. The `mode` parameter approach was cleaner code, but invisible to monitoring.

---

### 3.5 Agent Runs, Functions, External APIs — three views, no links

| | |
|---|---|
| **Trying to do** | Follow one user click end-to-end: button press → function invocation → AI Gateway calls → tool calls → external API calls → response. |
| **Signal needed** | A trace waterfall connecting all layers for a single request. |
| **Where I found it** | The three observability sections (Functions, Agent Runs/AI Gateway, External APIs) exist as silos. Functions shows duration and status. AI Gateway shows model calls and tokens. External APIs shows outbound HTTP calls. But there's no way to say "this specific POST to /api/chat/lineup triggered these 4 AI Gateway calls and these 8 external API calls." |
| **The answer** | On the free tier, the connection must be inferred from timestamps and `console.log` output. The `@vercel/otel` package is installed but it's unclear what traces it produces or where to view them without Observability Plus. |

**Observability takeaway:** For an AI agent app, the ideal trace would look like: `POST /api/chat/lineup` → `rosterAnalyst.generate()` → `Step 0: getRoster tool` → `GET api.sleeper.app/...` (200, 400ms) + `GET api.open-meteo.com/...` (200, 150ms) → `AI Gateway: gpt-4o-mini` (200, 2.1s) → `Step 1: response` → total 6.2s. Instead, you get three disconnected views of the same request. The distributed tracing story is there in principle (`@vercel/otel`, span propagation) but the free-tier dashboard doesn't stitch it together.

---

## 4. Native Observability vs External Tools

### 4.1 What's visible out of the box vs what requires custom instrumentation

| Layer | Free tier visibility | What's missing |
|---|---|---|
| **Functions** | Route name, status code, duration, memory usage. Basic charts in dashboard. | Per-request detail requires clicking into individual invocations. No CLI access to metrics. |
| **AI Gateway** | Request count (maybe — showed "no data" in CLI for 24h window). Dashboard may show more. | Token usage per model, cost breakdown, rate limit proximity — all require Plus or showed no data. |
| **External APIs** | Count of outbound calls per invocation. | URLs, durations per call, error rates per upstream — blank in the deployment detail view. |
| **Agent Runs** | Available in sidebar but unclear what's visible on free tier. | Couldn't determine if agent step traces are free-tier or Plus-only. |
| **Logs** | `vercel logs` works. Console output from functions is visible. | No structured logging. The `console.log` statements in the agent code are the only runtime signal. |

### 4.2 What I reached for outside Vercel

- **`console.log` in agent code**: The most reliable observability signal. The agent code logs step counts, tool names, and elapsed time on every run. This shows up in `vercel logs` and is the primary way I debugged agent behavior.
- **Vercel CLI `vercel logs`**: Used to confirm the env var fix worked and to read agent step output. This was the only CLI observability tool that worked on the free tier.
- **`curl` against GitHub API**: Used to test the GitHub token when the MCP server failed — verified the token worked before looking at the MCP config.
- **Browser DevTools**: Network tab to see request/response timing and status codes. Faster feedback loop than the Vercel dashboard for "did this request succeed."

### 4.3 What would have saved time

1. **Env var validation at deploy time**: "Your function reads `AI_GATEWAY_API_KEY` but no env var with that name is configured" — this could be static analysis.
2. **Rate limit dashboard**: A real-time gauge showing "you've used 8/10 requests this minute" for the AI Gateway free tier.
3. **Request-level trace linking**: Click a function invocation → see all AI Gateway calls and external API calls it triggered, in a waterfall.
4. **App-level dimensions on metrics**: Let users tag requests with custom attributes (like `mode=lineup`) that show up in the observability UI without requiring route splitting.

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

## 6. Prompt Engineering & Agent Behavior

### 6.1 Hallucination whack-a-mole — no tooling, just reading output

| | |
|---|---|
| **Trying to do** | Get agents to only cite data from tool results, not fabricate stats. |
| **Signal needed** | A way to compare "what the tool returned" vs "what the model cited in its response" — essentially output validation against tool call results. |
| **Where I found it** | Manual reading. Every iteration required running the agent, reading the output, spotting a fabricated stat, then adding another line to the system prompt banning that specific behavior. Examples: the model invented snap percentages, target shares, yards-per-carry-allowed stats, and combined pass TDs + rush TDs into a single "TDs" number that made the data look wrong. |
| **The answer** | Accumulated 7+ explicit anti-hallucination rules in the system prompt, including a banned-words list of 40+ AI slop terms. Each rule was a reaction to a specific observed failure. No systematic way to detect these — just human review of agent output. |

**Observability takeaway:** This is the biggest gap in AI agent observability. There is no automated way to verify that the model's text output is grounded in the tool results it received. A "grounding score" or "citation check" that compares numbers in the output text against numbers in the tool call results would catch most of these. For example: if the model says "Robinson had 22 carries" but `getPlayerStats` returned `rush_att: 18`, that's a detectable hallucination. This is a solvable problem with structured tool results — the data is right there in the trace.

---

### 6.2 Agent calling tools it shouldn't — or not calling tools it should

| | |
|---|---|
| **Trying to do** | Get agents to call the right tools, in the right order, the right number of times. |
| **Signal needed** | Tool call traces with annotations — "expected: getRoster, getInjuries, getProjections in parallel" vs "actual: getRoster, then getWeather (redundant), then getInjuries (sequential)." |
| **Where I found it** | Console logs showing step-by-step tool calls. Spotted issues: (1) The roster tool already embeds weather data, but the agent was also calling the standalone `getWeather` tool — wasting an API call and a step. (2) The trade agent wasn't calling `getPlayerCurrentOwner` before proposing trades, leading to trades for free agents. (3) Tools were called sequentially when they could be parallel, burning rate limit quota. |
| **The answer** | Added explicit instructions: "weather is already embedded — do NOT call a separate weather tool," "CRITICAL — call getPlayerCurrentOwner for EVERY player you want to propose," "Call ALL THREE tools in a single parallel tool call." Each was a prompt-level fix for a behavioral bug. |

**Observability takeaway:** The `console.log` statements in the agent code (step count, tool names, finish reason) were the only way to debug this. These are essentially hand-rolled traces. A proper agent trace view would show: expected tool call pattern vs actual, redundant calls, sequential-vs-parallel execution, and which steps consumed the most tokens. The Agent Runs section in Vercel observability should provide this — but it's unclear what's visible on the free tier and whether it captures tool-call-level detail or just LLM request counts.

---

### 6.3 Output format drift — no schema enforcement

| | |
|---|---|
| **Trying to do** | Get consistent output formatting across agent runs — same tier structure, same player line format, same section ordering. |
| **Signal needed** | Output schema validation or at minimum a diff between runs showing format drift. |
| **Where I found it** | Manual comparison of outputs. The model would sometimes: add a summary paragraph at the end (banned in prompt), skip K and DEF from tier rankings, use filler adjectives instead of numbers, or invent a new section heading not in the template. |
| **The answer** | Added increasingly specific formatting rules: "Include K and DEF in your tiers — do not skip them," "End on the last concrete point. No summary, no recap, no closing paragraph," exact per-line format templates like `**[Slot] [Player Name]** ([Team] [matchup]) — [projected_pts] pts.` |

**Observability takeaway:** Every prompt rule is a past failure encoded as text. There's no way to know if the rules are being followed without reading the output. Structured output (JSON schema) would solve the format problem, but the trade-off is losing the natural language analysis that makes the agent useful. A middle ground: post-generation validation that checks "does the output contain a Tier 1/2/3 section? Does every player line include a number? Is there a paragraph after the last recommendation?" This could run as a lightweight check before returning the response.

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
| Env var blank key name | UI allowed saving value without key | Validation error on save; env var audit at deploy time |
| CLI metrics paywall | All metrics require Observability Plus | `vercel metrics schema` should indicate plan requirements |
| External API URLs blank | Free tier hides request details | Show hostnames at minimum — the data is already captured |
| Single route hides agents | Observability is route-level only | Custom attribute/tag support on metrics dimensions |
| No cross-section linking | Functions, AI Gateway, External APIs are siloed | Request-level trace waterfall connecting all layers |
| Model fabricates stats | No grounding check on output | Compare output numbers against tool call results |
| Redundant/missing tool calls | No expected-vs-actual tool pattern view | Agent trace showing tool call graph per step |
| Output format drift | No schema enforcement on free-text output | Post-generation validation or structured output |
