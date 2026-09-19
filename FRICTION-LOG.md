# Friction Log: Fantasy GM Copilot

**What I built:** A multi-agent AI app for Sleeper fantasy football leagues. Four AI agents — one for lineup advice, one for waiver wire pickups, one for trade proposals, and one coordinator that runs all three — pull data from 4 external sources and give you specific, stats-backed recommendations for your actual team. See the [README](README.md) for detailed product context, agent architecture, and tool breakdown.

**Stack:** Next.js 16, Vercel AI SDK v7, Vercel AI Gateway, Sleeper API, ESPN API, Open-Meteo (weather), FantasyCalc (trade values).

---

## Building

### Scoping the MVP

A read-only assistant that proposes lineup, waiver, and trade moves for your real Sleeper league. Four agents, 4 free APIs (Sleeper, ESPN, Open-Meteo, FantasyCalc), scaffolded with Claude Code and the Vercel CLI. I deliberately picked 4 independent data sources because multi-dependency architectures are exactly what distributed tracing is built for — the architecture serves the observability story.

### The AI SDK broke silently between versions

The biggest friction point during the build. I started with the documented pattern for making an AI agent call tools in a loop — give the model a list of tools and tell it how many steps it can take (`generateText` with `maxSteps`). It compiled, ran, and returned a response. But the agent completed after one step and called zero tools.

No error. No warning. No deprecation notice. The old parameter (`maxSteps`) is still accepted by the code — it just doesn't do anything anymore. In version 7 of the SDK, you need a completely new approach: a dedicated agent class (`ToolLoopAgent`) that explicitly manages the tool-calling loop.

I lost about 45 minutes debugging this. A warning message saying "this parameter no longer works, use the new class instead" would have saved the entire detour.

**The upside:** The new agent class is actually better. It lets you swap models between steps — I used a cheaper model (`gpt-4o-mini`) for the tool-calling phase and a stronger model (`gpt-4o`) for writing the final recommendation. Cheap for grunt work, expensive for synthesis. That wasn't possible with the old approach.

### Hallucination debugging surfaced a deeper problem

Getting the agents to only cite real data was the most time-consuming part of the build — and the most interesting from a product perspective.

Every iteration was the same loop: run the agent, read the output, spot a fabricated stat, add another rule to the instructions. The model invented snap count percentages, target shares, and combined different types of touchdowns into a single misleading number. I ended up with 7+ rules specifically banning fabricated stats and a list of 40+ banned phrases.

The data is right there — the tool returns structured data (JSON), and the agent's output cites numbers from that data — but nothing automatically checks whether the cited numbers actually match. A check that flags "the agent said 22 carries, but the data said 18" is a solvable problem when the source data is structured.

I also had to fix agents calling tools they shouldn't and skipping tools they should. The roster tool already includes weather data in its response, but the agent called a separate weather tool anyway — wasting an API call. The trade agent proposed trades for players who were free agents because it skipped the tool that checks who owns a player (`getPlayerCurrentOwner`). Each fix was a rule added to the prompt: "do NOT call a separate weather tool," "CRITICAL — check ownership for EVERY player."

The only way I could see this happening was by adding print statements to the code (`console.log`) and reading them through Vercel's log viewer in the terminal (`vercel logs`). There was no visual trace or dashboard that showed me which tools the agent called or in what order.

This debugging surfaced the key architectural insight of the project — see [Learnings and What I Would Do Next](#learnings-and-what-i-would-do-next) below.

---

## Deploying

### AI Gateway: three walls in a row

The AI Gateway advertises $5/month in free credits. I hit three blockers, each only discoverable after fixing the previous one:

1. Every request failed: "requires a valid credit card." Added a card.
2. Requests to Claude models failed: "Free tier users do not have access to this model." Switched to a cheaper model (`gpt-4o-mini`).
3. Rapid sequential requests failed with rate limiting (`429`). The free tier can't handle an agent making 2-3 API calls back to back.

### Rate limits forced architectural changes

The free-tier rate limits forced two workarounds that ended up shaping the app's architecture:

- **Forced parallel tool calling.** Instead of letting agents make 3-4 sequential API calls, I rewrote the instructions to say "call ALL THREE tools in a single parallel call. Do NOT call them one at a time." This cuts the number of API round-trips from 3-4 to exactly 2.
- **Spread models across providers.** I assigned different AI models to different agents — `gpt-4o-mini` for roster and trade, `gemini-2.5-flash` for waivers, `gpt-4o` for the coordinator's final synthesis. This wasn't a quality decision — it was a rate-limit survival strategy to avoid hitting any single provider's limits.

---

## Observing

### What works on the free tier

The free tier gives you enough to know *what* happened, but not *why*:

- **Function metrics:** Status code, response time, and memory usage per request. Clicking into a request shows function logs and outbound API call count. This was the workhorse — most debugging started here.
- **Terminal log viewer** (`vercel logs`): Print statement output from deployed functions. Combined with `console.log` statements I added to the agent code (which tool fired, step count, elapsed time), this was my primary debugging tool.
- **Deployment detail:** Per-request count of outbound API calls. "18 external calls" vs "0 external calls" immediately tells you whether the agent ran but was slow, or never started at all.
- **External API call counts by hostname:** I could see 40 calls to Open-Meteo, 28 to Sleeper, 4 to ESPN. The breakdown is useful — FantasyCalc not appearing confirmed the roster endpoint doesn't use trade values, validating the tool-to-API mapping.

This is enough to triage. You can tell if something is broken, slow, or not running at all. For a solo developer or a prototype, it covers the basics.

### What the free-tier metrics reveal (and where they stop)

With just 4 invocations on a single route, the dashboard surfaced real problems:

![Observability dashboard for /api/roster showing 4 invocations, external API calls, and compute metrics](/docs/observability-roster-route.png)

Two numbers stood out: **75% cold start rate** — 3 of 4 requests booted from scratch, meaning first requests take 8-10 seconds with 70+ API calls and a model call stacked on top. And **19.4% CPU throttle** — nearly 1 in 5 requests got slowed down because the roster endpoint makes ~72 outbound requests in a single function. The 40 Open-Meteo calls (weather for every stadium) could be batched or cached per game day, which would cut the call count and likely reduce the throttling.

But every deeper question — which of the 72 calls is slowest, how much CPU time is API calls vs. processing, what's the Time to First Byte — hits a paywall or a missing link between views.

### Insights from debugging

#### One API route hid all four agents

The app originally had one endpoint (`POST /api/chat`) with a parameter saying which agent to run. The monitoring dashboard showed all requests as the same route — no way to tell which agent was slow or failing.

**Fix:** I split into four routes — one per agent (`/api/chat/lineup`, `/api/chat/waivers`, `/api/chat/trades`, `/api/chat/coordinator`). This was an architecture change driven entirely by the monitoring tool. Vercel's observability works at the route level — if your app doesn't match that model, you have to reshape it.

#### Dead route, invisible waste

After a product change — removing the roster display from the landing page — the `/api/roster` route was still being called on every page load via a leftover `useEffect`. Each call makes ~72 outbound API requests (40 to Open-Meteo for weather, 28 to Sleeper for player data, 4 to ESPN for injuries). None of this data was being shown to the user.

The dashboard surfaced the symptom — I could see the route making dozens of external calls — but couldn't tell the calls were wasteful because the External APIs view shows count without detail. It took cross-referencing function metrics with the actual production UI to realize the route was doing real work that served no purpose.

#### Agent Runs: the biggest gap

The dashboard has an "Agent Runs" section in the observability sidebar. I configured the telemetry pipeline (OpenTelemetry via `@vercel/otel` and `@ai-sdk/otel`), set telemetry IDs on every agent, deployed, and triggered multiple successful agent runs.

Result: "No data." No error message, no setup instructions, no indication of whether it's a configuration issue or a plan restriction.

After diagnostic logging, I found the root cause: the environment variable that provisions Vercel's telemetry collector (`VERCEL_OTEL_ENDPOINTS`) isn't set on the free plan. The telemetry data is generated correctly, but there's no collector to receive it — the data goes nowhere.

### The tiering makes business sense — the friction is discovering it

The free-vs-paid line is well-placed. Free tier gives you **triage**: *Is it working? Is it slow? Is it calling the right things?* Status codes, response times, call counts, cold start rates. This covers the debugging loop for solo developers and prototypes — and it's what I used for 90% of my debugging.

Pro tier gives you **diagnosis**: Once you know *something* is slow, you need to know *which part*. Per-hostname latency, Time to First Byte, error rates by external dependency, the full metrics catalog. This is where the platform earns revenue — when you're running production traffic and the cost of not knowing is real.

That split makes sense. The friction isn't the paywall — it's investing time in configuration before discovering the paywall:

- The CLI lists 95 available metrics (`vercel metrics schema`), then blocks every query with "Observability Plus is required." The schema should indicate which metrics require a paid plan — showing the full catalog as if it's available, then blocking at query time, wastes debugging cycles.
- Agent Runs shows an empty state with no explanation — not "requires Pro" or "requires eve," just "No data." I spent hours configuring the telemetry pipeline (OpenTelemetry, `@vercel/otel`, `@ai-sdk/otel`, telemetry IDs on every agent) before discovering the collector endpoint isn't provisioned on the free plan. A single line in the empty state would have saved that entire detour.
- External API call counts show the hostname but lock latency and error rates behind a Pro icon. The count alone tells you the *shape* of the request — the locked metrics tell you the *health*. This one is actually well-communicated: the lock icon sets expectations clearly.

### Three views, no connections — and why I'd use eve next

Function metrics, AI Gateway, and External APIs exist as separate views. I can see that a request to `/api/chat/lineup` took 6.2 seconds, that the AI Gateway handled a model call, and that there were 8 outbound API requests. But there's no way to connect them: "this specific function call triggered these model calls and these external requests."

The ideal view would be a single trace:

```
POST /api/chat/lineup (6.2s)
  └─ rosterAnalyst.generate()
       ├─ Step 0: getRoster → GET api.sleeper.app (200, 400ms)
       │          getInjuries → GET site.api.espn.com (200, 300ms)
       │          getProjections → GET api.sleeper.app (200, 250ms)
       ├─ AI Gateway: gpt-4o-mini (200, 2.1s, 1,847 tokens)
       └─ Step 1: response (1.2s)
```

Instead, you get three disconnected views. The tracing infrastructure exists — the platform has telemetry support and span propagation — but the dashboard doesn't stitch them together.

This is the main reason I'd use Vercel's eve framework if I were rebuilding this for production. With the AI SDK, I had to manufacture my own observability — splitting routes so agents show up separately in the dashboard, adding print statements to reconstruct which tools fired, manually cross-referencing three views to debug a single request. Eve's Agent Runs trace waterfall gives you the connected view out of the box: one trace per agent run, with every tool call, model call, and sub-agent visible in a single timeline.

---

## Learnings and What I Would Do Next

### What I did: AI SDK v7 with many small tools

I chose the AI SDK v7 with many small, independent tools per agent deliberately — to maximize the surface area for observability friction. Four agents, 11 tools, 4 external APIs, each tool independently callable. This architecture creates exactly the kind of multi-step, multi-dependency failures that stress-test an observability platform: agents calling the wrong tools, skipping required tools, making redundant calls, hitting rate limits mid-loop.

A cleaner architecture with fewer, smarter tools would have mostly just worked — and produced a thinner friction log.

### What I learned: the debugging revealed a design principle

The manual debugging described above is what made the pattern visible. Every rule I added to the agent's instructions was the same shape: compensating for a tool design problem at the prompt layer.

| Rule I added to the prompt | Actual root cause |
|---|---|
| "CRITICAL — check who owns the player for EVERY trade target" | Ownership verification was a separate tool the agent could skip |
| "do NOT call a separate weather tool" | Weather data was already included in the roster tool, but a standalone weather tool was also available |
| "Only recommend players confirmed as free agents" | The agent had to manually cross-reference trending player data against league availability |

The principle: **if the agent skipping a step produces a wrong result (not just a suboptimal one), that step belongs in the tool — not the instructions.** Prompt-level rules are a symptom of correctness concerns living in the wrong layer.

### What I changed: fat tools, thin agents

This insight led to the `findTradeTargets` refactor. Instead of giving the trade agent 4 separate tools and hoping it calls them in the right order, I built one composite tool that scans all league rosters, verifies ownership, calculates trade values, and returns pre-verified trade candidates in a single call. The agent's job went from "discover + validate + explain" to just "explain."

**Before:** 4 tools, 6 steps, agent manages dependencies, prompt rules enforce correctness.
**After:** 2 tools, 4 steps, tool enforces correctness, agent makes judgment calls.

The rule is simple:
- **Tools** answer "what are the facts?" — they gather, combine, and validate data from multiple sources. Ownership verification, weather deduplication, and availability filtering all belong here.
- **Agents** answer "what should I do?" — they interpret the facts and make recommendations. Tier players, select trades, explain reasoning. Pure judgment.

### What I would do next: migrate to eve

If I were building this for production rather than a friction log, I'd start with eve. As described in the observability section, the AI SDK forced me to manufacture my own debugging surface area. Eve's built-in traces would have let me skip straight to engineering for correctness — and would have nudged toward the "fat tools, thin agents" pattern from the start. The tradeoff is lock-in to Vercel-specific infrastructure, but for a multi-agent app where the hardest problem is debugging across agents, built-in observability pays for itself.

---

## What I'd want as a PM

1. **Environment variable validation at deploy time.** "Your function reads `AI_GATEWAY_API_KEY` but no variable with that name is configured." The code and the variable list are both available at build time — this is static analysis.
2. **Rate limit visibility.** A gauge showing "8/10 requests used this minute" for the AI Gateway. The rate limit error comes with no warning and minimal information about when the limit resets.
3. **Request-level trace linking.** Click a function call, see all downstream calls — model, tools, external APIs — in a single waterfall view. The data exists across three separate views. Connecting them is the product gap.
