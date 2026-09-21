# Fantasy GM Copilot

AI-powered fantasy football assistant for pre-game prep. Connects to your real Sleeper league and proposes specific lineup, waiver, and trade moves backed by live data.

Fantasy football is a game where you draft and manage a roster of real NFL players. You score points based on their actual game performance each week, competing against other managers in your league. The key decisions — who to start, who to pick up, who to trade — are what this tool helps with.

## Why this project

I built this with three constraints:

1. **Free tier only.** No paid APIs, no Pro plan. Every data source is free and unauthenticated. Every deployment runs on Vercel's hobby tier.
2. **Maximize observability surface area.** Four agents, 11 tools, 4 external APIs — deliberately over-decomposed to stress-test Vercel's monitoring at the route, function, and external-call level.
3. **Solve a real problem I have.** I play in a competitive fantasy football league. The purpose is to find a competitive edge from the generic advice players use.

## The gap

Fantasy advice today falls into two buckets: generic rankings that ignore your league, or AI chatbots trained on last season's data that hallucinate current stats.

The hardest problem is trades. Every tool can tell you *who* to trade for. None of them check who in your league actually owns that player, whether you have a fair trade chip, or which managers are desperate enough to deal. That requires cross-referencing your roster, every other manager's roster, market trade values, and league standings. Nobody does this.

## What we built

Four agents, each with a specific job:

- **Lineup** — start/sit tiers backed by projections, recent stats, injuries, and weather
- **Waivers** — free agent pickups matched to your roster's weak spots
- **Trades** — ownership-verified trade proposals with value math for both sides
- **Coordinator** — runs all three in parallel, synthesizes one action plan

The agents are read-only. They propose moves. You execute.

## The differentiator: trades that actually work

The trade agent scans every roster in your league, identifies your weakest position, finds upgrade targets owned by other managers, checks market trade values, and returns candidates you can actually send.

This is the feature no competitor ships. FantasyPros, RotoBot, and Scoutcast all stop at "trade for this player" without checking if that trade is possible in your league.

## MVP decisions

| Category | Shipped | Future iterations |
|---|---|---|
| **Scope** | One league (my own), Sleeper only, weekly analysis | Any Sleeper account via league ID, ESPN leagues |
| **Data** | 4 free APIs: Sleeper, ESPN, Open-Meteo, FantasyCalc | Paid sources (snap counts, target shares, red zone data) |
| **Implementation** | Vercel AI SDK v7 ([details](FRICTION-LOG.md#learnings-and-what-i-would-do-next)) | Eve framework ([why](FRICTION-LOG.md#three-views-no-connections--and-why-id-use-eve-next)) |
| **UX** | Read-only, 4 agents with single-action buttons | Chat interface, streaming responses |
| **Mode** | Pre-game — weekly prep before lineups lock | In-game — real-time recommendations based on live scoring |

**Read-only by design.** An agent that touches real assets should confirm, not act unilaterally.

## What's next

**Better data, better recommendations.** Snap counts and target shares to catch rising players before projections update. Red zone usage to separate sustainable scorers from TD-dependent ones. Boom/bust advice based on standings — a 1-4 team needs ceiling plays, not safe floors.

**Proactive trades.** Roster-need matching across the league ("Manager X is 1-4 and stacked at RB but weak at WR — send this before someone else does"). 2-for-1 package deals.

**In-game recommendations.** Real-time monitoring of live scoring to suggest mid-game adjustments — "your RB has 2 points at halftime, swap in your boom/bust flex for higher upside."

**Chat interface.** Replace single-action buttons with a conversational UI. Streaming responses so you see the agent working in real time.

## Links

- [Friction log](FRICTION-LOG.md) — full build/deploy/observe walkthrough and architectural decisions
- **Stack:** Next.js 16, Vercel AI SDK v7, Vercel AI Gateway, TypeScript
