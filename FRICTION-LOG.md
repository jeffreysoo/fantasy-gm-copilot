# Friction Log: Fantasy GM Copilot

**What I built:** A multi-agent AI app for Sleeper fantasy football leagues. Four AI agents — one for lineup advice, one for waiver wire pickups, one for trade proposals, and one coordinator that runs all three — pull data from 4 external sources and give you specific, stats-backed recommendations for your actual team. See the [README](README.md) for detailed product context, agent architecture, and tool breakdown.

**Stack:** Next.js 16, Vercel AI SDK v7, Vercel AI Gateway, Sleeper API, ESPN API, Open-Meteo (weather), FantasyCalc (trade values).

---

## Building

### Scoping the MVP

Once I defined the product — a read-only assistant that proposes lineup, waiver, and trade moves for your real Sleeper league — I used Claude Code in the terminal and the Vercel CLI to scaffold the app, write the agents, and iterate locally. The local development experience was smooth. I could run the app on my machine (`localhost`), trigger each agent, and see results quickly.

I chose 4 free, no-auth APIs as data sources: Sleeper for league and roster data, ESPN for injuries and NFL schedules, Open-Meteo for game-day weather, and FantasyCalc for trade values based on millions of real transactions. Each one was selected because it answered a specific question an agent needs: who's on my team, who's hurt, what's the weather at the stadium, and what's a player worth in a trade.

I deliberately picked 4 independent data sources — not just for the product, but because multi-dependency architectures are exactly what distributed tracing is built for. When something is slow, a good trace should immediately tell you whether the bottleneck is the AI model, Sleeper, ESPN, Open-Meteo, or FantasyCalc. The architecture serves the observability story.

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

### The env var UI let me save a value with no name

First deploy: the app crashed immediately. The root cause was absurd — the Vercel dashboard let me save an environment variable with a blank key name. The value was there, but the app couldn't find it because there was no key to look up. No validation error when I saved it.

**What worked well:** The deployment detail page showed "No outgoing requests" under External APIs. That absence was the most useful debugging signal — it proved the crash happened before the app tried to call any external service, immediately narrowing the problem to configuration.

### AI Gateway: three walls in a row

The AI Gateway advertises $5/month in free credits. I hit three blockers, each only discoverable after fixing the previous one:

1. Every request failed: "requires a valid credit card." Added a card.
2. Requests to Claude models failed: "Free tier users do not have access to this model." Switched to a cheaper model (`gpt-4o-mini`).
3. Rapid sequential requests failed with rate limiting (`429`). The free tier can't handle an agent making 2-3 API calls back to back.

The error messages for problems 1 and 2 were identical — a generic 403 with no distinction between "no payment method" and "this model isn't available on your plan." A structured error that says *what's wrong* and *what to do about it* would have made each step obvious.

### Rate limits forced architectural changes

The free-tier rate limits forced two workarounds that ended up shaping the app's architecture:

- **Forced parallel tool calling.** Instead of letting agents make 3-4 sequential API calls, I rewrote the instructions to say "call ALL THREE tools in a single parallel call. Do NOT call them one at a time." This cuts the number of API round-trips from 3-4 to exactly 2.
- **Spread models across providers.** I assigned different AI models to different agents — `gpt-4o-mini` for roster and trade, `gemini-2.5-flash` for waivers, `gpt-4o` for the coordinator's final synthesis. This wasn't a quality decision — it was a rate-limit survival strategy to avoid hitting any single provider's limits.

### Env var silently overwritten by a CLI command

After fixing the environment variable, it broke again. Running a Vercel CLI command to link the project (`vercel link`) silently replaced my API key with an authentication token. A working deploy suddenly started failing after what appeared to be a safe, read-only command.

---

## Observing

### What works on the free tier

- **Function metrics:** For each API route, I could see the status code, response time, and memory usage per request. Clicking into a specific request shows the function logs and how many external API calls it made. This was the workhorse — most of my debugging started here.
- **Terminal log viewer** (`vercel logs`): Shows print statement output from deployed functions. Combined with print statements I added to the agent code (which tool fired, step count, elapsed time), this was my primary debugging tool.
- **Deployment detail:** Shows a per-request count of outbound API calls. "18 external calls" vs "0 external calls" immediately tells you whether the agent ran but was slow, or never started at all.

### One API route hid all four agents

The app originally had one endpoint (`POST /api/chat`) with a parameter saying which agent to run. The monitoring dashboard showed all requests as the same route — no way to tell which agent was slow, which was hitting rate limits, or which was failing.

**Fix:** I split the app into four routes — one per agent (`/api/chat/lineup`, `/api/chat/waivers`, `/api/chat/trades`, `/api/chat/coordinator`). This was an architecture change driven entirely by the monitoring tool. The single-route design was cleaner code, but invisible to monitoring. Vercel's observability works at the route level — if your app doesn't match that model, you have to reshape it.

**What would have helped:** The ability to tag requests with custom labels (like `agent=roster-analyst`) that show up in the dashboard, without requiring separate routes.

### External API calls: count but no detail

The deployment detail shows how many outbound requests a function made, but the URLs are blank. Just `GET` repeated 18 times — no hostnames, no paths, no timing per call. The count is accurate, but the free tier doesn't show what those calls were to.

### CLI metrics: the schema says yes, the paywall says no

The Vercel CLI has a command that lists 95 available metrics you can query (`vercel metrics schema`). Every actual query returns: "Observability Plus is required." The schema doesn't indicate which metrics require a paid plan — it shows the full catalog as if it's all available, then blocks you when you try to use it.

### Agent Runs: the biggest gap

The dashboard has an "Agent Runs" section in the observability sidebar. I spent the most time here trying to make it work. I configured the telemetry pipeline (OpenTelemetry via `@vercel/otel` and `@ai-sdk/otel`), set telemetry IDs on every agent, deployed, triggered multiple successful agent runs, and waited.

Result: "No data." No error message, no setup instructions, no documentation link, no indication of whether it's a configuration issue, a plan restriction, or a timing problem.

After diagnostic logging, I found the root cause: the environment variable that provisions Vercel's telemetry collector (`VERCEL_OTEL_ENDPOINTS`) isn't set on the free plan. The telemetry data is being generated correctly, but there's no collector to receive it — the data goes nowhere.

**The bigger observation:** Agent Runs either requires Vercel's agent framework (eve) or a paid plan (or both). The platform steers you toward eve by making observability a framework feature rather than a platform feature. If you use eve, you get Agent Runs. If you use the AI SDK directly (which Vercel also maintains), you get function logs. This isn't documented anywhere — you discover it after hours of configuring telemetry that silently does nothing.

A single line in the empty state — "Agent Runs requires eve or a Pro plan" — would save significant debugging time and let developers make this framework decision up front.

### Three views, no connections between them

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

Instead, you get three disconnected views of the same request. The tracing infrastructure exists — the platform has telemetry support and span propagation — but the free-tier dashboard doesn't stitch them together.

---

## Learnings and What I Would Do Next

### What I did: AI SDK v7 with many small tools

I chose the AI SDK v7 with many small, independent tools per agent deliberately — to maximize the surface area for observability friction. Four agents, 11 tools, 4 external APIs, each tool independently callable. This architecture creates exactly the kind of multi-step, multi-dependency failures that stress-test an observability platform: agents calling the wrong tools, skipping required tools, making redundant calls, hitting rate limits mid-loop.

A cleaner architecture with fewer, smarter tools would have mostly just worked — and produced a thinner friction log.

### What I learned: the debugging revealed a design principle

The only way to see what agents were actually doing on the free tier was print statements (`console.log`) piped through the terminal log viewer (`vercel logs`). Agent Runs didn't work on the free plan, the dashboard only shows route-level metrics, and external API calls showed count but no detail. I was reconstructing agent behavior — which tools fired, in what order, what they returned — from manual log output.

That manual debugging is what made the pattern visible. Every rule I added to the agent's instructions was the same shape: compensating for a tool design problem at the prompt layer.

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

If I were building this for production rather than a friction log, I'd start with Vercel's agent framework (eve). Eve would have nudged toward the "fat tools, thin agents" pattern from the start — not because it forces better tool design, but because its built-in observability removes the need to engineer for debuggability. With the AI SDK, I needed many independent tool calls to create debugging surface area because the platform couldn't show me what was happening otherwise. With eve, the traces come for free, so you can skip straight to engineering for correctness.

| | AI SDK v7 (what I used) | Eve (what I'd use next) |
|---|---|---|
| **Level** | Low-level, full control | Higher-level, convention-driven |
| **Portability** | Framework-agnostic, runs anywhere | Vercel-native, deeper platform lock-in |
| **Agent structure** | Manual — you wire agents, tools, and routes yourself | File-based — agents are folders, tools are files, sub-agents are subdirectories |
| **Observability** | Do-it-yourself — route splitting, print statements, manual log review | Built-in — Agent Runs trace waterfall works out of the box |
| **Error handling** | Manual — if a sub-agent fails, the coordinator doesn't know | Durable workflows — automatic retries and step-level resumability |
| **Natural gravity** | Many small tools, because nothing pushes you toward composing them | Fewer composed tools, because you can see what's happening without manufacturing surface area |
| **Best for** | Prototyping, friction logs, portable agents | Production multi-agent systems scaling to more agents |

**The tradeoff:** Eve deepens lock-in to Vercel-specific infrastructure (Workflows, Sandbox), and sub-agent calls become asynchronous — changing the user experience from a single synchronous response to potentially polling for completion. The AI SDK is framework-agnostic and runs anywhere. For a 4-agent system, that portability matters. For a production app scaling to more agents, eve's conventions pay for themselves.

---

## What I'd want as a PM

1. **Environment variable validation at deploy time.** "Your function reads `AI_GATEWAY_API_KEY` but no variable with that name is configured." The code and the variable list are both available at build time — this is static analysis.
2. **Rate limit visibility.** A gauge showing "8/10 requests used this minute" for the AI Gateway. The rate limit error comes with no warning and minimal information about when the limit resets.
3. **Agent Runs empty state that explains itself.** "Requires eve framework" or "Requires Pro plan" — anything other than "No data."
4. **Request-level trace linking.** Click a function call, see all downstream calls — model, tools, external APIs — in a single waterfall view. The data exists across three separate views. Connecting them is the product gap.
5. **Custom metric labels.** Let users tag function calls with attributes like `agent=roster-analyst` that show up in the dashboard. This would make the route-splitting workaround unnecessary for multi-agent apps.
6. **Grounding checks for AI output.** Automatically compare numbers cited in the model's response against numbers in the tool call results. The structured data is already in the system — the check is: does the output contain values that don't appear in any tool result?
