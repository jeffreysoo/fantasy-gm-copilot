# Fantasy GM Copilot

An AI agent that reads your real Sleeper fantasy roster, checks live injuries, weather, matchup data, waiver trends, and trade values, then proposes specific lineup, waiver, and trade moves you approve.

## Why this exists

Fantasy football advice is broken in three ways:

**LLMs don't know your team.** ChatGPT and Claude can talk about football, but their training data is months old. They don't know who's on your roster, who's injured this week, or who's available on your waiver wire. Ask "should I start Corum or Warren?" and you get generic analysis that ignores your league's scoring format, your record, and your matchup.

**Online recommendations ignore your context.** FantasyPros rankings, ESPN articles, and podcast advice rank players in a vacuum. They don't know you're 1-4 and need upside plays, or that the best waiver add is already rostered in your league, or that the trade target you want is owned by the one manager who never trades.

**Tools that solve this cost money.** FantasyPros Coach AI ($9-12/mo), RotoBot ($80/year), Scoutcast ($6/mo) — they sync your league but still fall short on the hardest problem: proposing trades that account for who owns what in your specific league and whether the deal is fair.

Fantasy GM Copilot connects directly to your Sleeper league, pulls real-time data from four sources, and reasons across all of it to give you specific, actionable recommendations with the numbers to back them up.

## Competitor landscape

| Tool | Price | Knows your roster | Proposes league-specific trades | Real-time data | Multi-source reasoning |
|---|---|---|---|---|---|
| **FantasyPros Coach AI** | $9-12/mo | Yes (sync) | No | Yes | No |
| **RotoBot AI** | $80/year | Yes (sync) | Grades trades, doesn't propose | Yes | Limited |
| **Scoutcast.ai** | $6/mo | Yes (sync) | No | Yes | No |
| **ESPN (watsonx)** | Free | ESPN only | No | Yes | No |
| **ChatGPT / Claude** | Free-$20/mo | No | No | No (stale training data) | No |
| **Fantasy GM Copilot** | Free | Yes (Sleeper API) | Yes (checks ownership + trade values) | Yes (4 live sources) | Yes |

### Where competitors fall short

**No leaguemate awareness.** None of them look at other managers' rosters to propose trades you could actually send. FantasyPros tells you "trade for Ja'Marr Chase" without checking who in your league owns him or what it would cost.

**Reactive, not proactive.** You ask the question, they answer it. They don't surface opportunities on their own — like "Manager X is 1-4 and stacked at RB, here's a trade to send before someone else does."

**Single-source reasoning.** Each tool pulls from one data feed. None cross-reference waiver trends against trade values against weather against your standings to produce a recommendation that accounts for all of it.

## How it works

A multi-agent system where specialist agents handle different domains. A coordinator agent synthesizes their findings into one game plan.

### Architecture

```
User clicks one of 4 actions:
  "Check My Lineup" → Roster Analyst (direct)
  "Scout Waivers"   → Waiver Scout (direct)
  "Find a Trade"    → Trade Analyst (direct)
  "Full Game Plan"  → Coordinator → all 3 sub-agents in parallel

Coordinator (gpt-4o-mini → gpt-4o via prepareStep)
├── Roster Analyst (gpt-4o-mini, temp 0.15, max 5 steps)
│   getRoster, getOpponentRoster, getInjuries, getLeagueStatus,
│   getProjections, getPlayerStats
│
├── Waiver Scout (gemini-2.5-flash, temp 0.15, max 4 steps)
│   getRoster, getTrending, getBestAvailable
│
└── Trade Analyst (gpt-4o-mini, temp 0.15, max 6 steps)
    getTradeValues, getRoster, getPlayerCurrentOwner, getPlayerStats

Simple Agent (gpt-4o-mini, all 11 tools, max 6 steps)
  → Used for free-form follow-up questions via text input
```

The coordinator uses `prepareStep` to run a cheap model (gpt-4o-mini) for tool dispatch and a stronger model (gpt-4o) for final synthesis. Sub-agents run in parallel and use different models to spread across provider rate limits on the free tier.

Temperature is set to 0.15 across all agents — low enough that recommendations stay consistent across repeated runs, high enough that phrasing varies naturally.

### Data sources

| Source | What it provides | Auth required |
|---|---|---|
| **Sleeper API** | Rosters, standings, matchups, player data, trending adds/drops, weekly stats, projections | None |
| **ESPN API** | NFL schedule (real matchups per team), injury/player news | None |
| **Open-Meteo** | Stadium weather for outdoor games (wind, rain, temperature) at actual game time | None |
| **FantasyCalc** | Trade values derived from millions of real trades | None |

### 11 tools

| Tool | Source | What the agent gets |
|---|---|---|
| `getRoster` | Sleeper + ESPN + Open-Meteo | Starters (from matchups endpoint for current week accuracy), bench, injury flags, NFL matchups per player, weather for outdoor games, DvP rankings |
| `getOpponentRoster` | Sleeper | This week's fantasy opponent — their starters with points scored |
| `getInjuries` | Sleeper + ESPN | Injury status per roster player + ESPN news filtered to your players and teams |
| `getLeagueStatus` | Sleeper | Standings, current week, playoff config, scoring type |
| `getProjections` | Sleeper | Projected fantasy points per roster player for start/sit decisions |
| `getPlayerStats` | Sleeper | Weekly fantasy points and box score stats (pass/rush/rec yards, TDs) across recent weeks |
| `getTrending` | Sleeper | Most-added and most-dropped players across all Sleeper leagues |
| `getBestAvailable` | Sleeper + FantasyCalc | Free agents in your league ranked by trade value, filtered by position |
| `getPlayerCurrentOwner` | Sleeper | Who in your league owns a specific player (critical for trade proposals) |
| `getWeather` | Open-Meteo | Game-day conditions for a specific stadium |
| `getTradeValues` | FantasyCalc | Market trade values for players, cached 24 hours |

### Key data accuracy decisions

- **Starters come from `/matchups/{week}`**, not `/rosters`. The rosters endpoint returns stale starter data from the previous week. This was a critical bug fix — IR players were showing as starters.
- **DvP (Defense vs Position) rankings** are calculated from Sleeper's defensive stats across recent weeks, showing how many PPR points/game each defense allows per position.
- **Weather uses actual game dates** from the ESPN schedule, not a hardcoded "next Sunday." Covers TNF, MNF, and London games.
- **Player stats require type-specific citations** — the prompt enforces "2 pass TD, 1 rush TD" instead of "3 TDs" to prevent miscounting.
- **Players map is cached 24 hours** per Sleeper's docs (5MB response, intended to be called at most once per day).
- **Season year is derived from `nflState.season`**, not hardcoded.

### Anti-hallucination measures

The agents are prompt-engineered to avoid fabricating data:

- Every player recommendation must cite at least one number from the tools (projected pts, weekly stats, DvP rank). No justifying starts with "talent," "upside," or "volume."
- Fabricated stats are explicitly banned: snap %, target share, yards-per-carry allowed, and matchup rankings unless a tool returned them.
- Mid-game swap suggestions are blocked — the system prompt includes league rules about starter lock at kickoff.
- Free agents cannot be proposed as trade targets — the trade analyst must verify ownership via `getPlayerCurrentOwner` for every player.
- Banned word list prevents AI-typical language: "elite," "explosive," "emerging," "pivotal," "game changer," etc.

## UI

Single-column layout with 4 action buttons and a free-text input for follow-up questions.

- **Check My Lineup**: Shows full roster with Sleeper-style player tiles (thumbnail, position badge, team, matchup, injury status, weather), then the agent's tiered analysis below.
- **Scout Waivers / Find a Trade / Full Game Plan**: Shows a compact roster strip for context, then the agent's recommendations.
- **Rate limit handling**: When the AI Gateway returns a 429, the UI shows a countdown timer (from the `Retry-After` header or a 120s default) with a retry button that enables at 0:00.

Player tiles use Sleeper CDN thumbnails (`sleepercdn.com/content/nfl/players/thumb/{player_id}.jpg`) with position-colored badges, injury status coloring, and weather indicators.

## MVP decisions

### What shipped

- One league, one week, read-only. The agent proposes moves. The human executes them.
- 3 specialist agents + 1 coordinator + 1 single-agent mode (for follow-up questions).
- 11 tools across 4 independent data sources.
- Tiered recommendations (Tier 1/2/3) with stats-backed justifications.
- Model switching via `prepareStep` — cheap model dispatches tools, stronger model synthesizes.
- Sleeper-styled UI with player tiles, inline roster display, and custom markdown rendering.
- Rate limit countdown timer with `Retry-After` support.

### What we cut

| Decision | Reasoning |
|---|---|
| **No write operations** (set lineup, submit trade, claim waiver) | An agent that touches real assets should propose and confirm, not act unilaterally. Product judgment, not a technical limitation. |
| **No multi-league** | Adds complexity without improving recommendation quality. |
| **No streaming responses** | High-impact UX improvement but medium effort. Agent calls are non-streaming `generate()`. |
| **No social-sentiment scraping** | High effort, low signal-to-noise for weekly decisions. |
| **No Odds API** | 500 credits/month drains in ~85 calls. ESPN + Open-Meteo cover the need. |

### How we chose the data sources

Evaluated 8 APIs. Selected 4 based on: free with no auth, high signal for agent reasoning, and each adds an independent failure domain for the observability story. Rejected SportsDataIO (free tier is last season only), The Odds API (quota too restrictive), nfl_data_py (Python library, not a REST API), SharpAPI (redundant with The Odds API).

## What's next

### Agents
- Proactive opportunity detection — "Manager X is 1-4 with RB depth, send this trade now"
- Position-specific reasoning (QB decisions differ from RB/WR)
- Risk tolerance based on standings (1-4 teams need boom, 4-1 teams need floor)

### UI
- Streaming responses as the agent works
- Approve/reject per recommendation
- Trace viewer: which tools fired, latency per tool, model per step

### Observability
- `@vercel/otel` tracing with spans per tool call and agent step
- Induced incident (ESPN 403, Sleeper timeout) with full trace walkthrough
- External tool comparison (Langfuse or Braintrust) on the same traffic
- Per-request cost tracking across the multi-agent loop

## Tech stack

- **Framework:** Next.js 16 (App Router)
- **AI SDK:** Vercel AI SDK v7 (`ToolLoopAgent`, `prepareStep`, sub-agents as tools)
- **Gateway:** Vercel AI Gateway (model routing, rate limiting, cost tracking)
- **Models:** `openai/gpt-4o-mini`, `google/gemini-2.5-flash`, `openai/gpt-4o`
- **Language:** TypeScript
- **Package manager:** pnpm

## Setup

```bash
git clone <repo-url>
cd fantasy-gm-copilot
pnpm install

# Add your AI Gateway key
echo "AI_GATEWAY_API_KEY=vck_your_key_here" > .env.local

# Run
pnpm dev
```

Open `http://localhost:3000`. Click any of the four action buttons or type a question.
