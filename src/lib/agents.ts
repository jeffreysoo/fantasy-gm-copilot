import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import {
  getRosterTool,
  getOpponentRosterTool,
  getInjuriesTool,
  getTrendingTool,
  getLeagueStatusTool,
  getPlayerCurrentOwnerTool,
  getBestAvailableTool,
  getPlayerStatsTool,
  getWeatherTool,
  getTradeValuesTool,
  getProjectionsTool,
} from "./tools";
import { PERSONA, COORDINATOR_ADDENDUM, SUB_AGENT_ADDENDUM } from "./system-prompt";

const gateway = createOpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: "https://ai-gateway.vercel.sh/v1",
});

// Models available on free tier — spread across providers to avoid per-model rate limits
const miniModel = gateway("openai/gpt-4o-mini");
const geminiModel = gateway("google/gemini-2.5-flash");
const gpt4oModel = gateway("openai/gpt-4o");

// --- Sub-agent: Roster Analyst ---
export const rosterAnalyst = new ToolLoopAgent({
  model: miniModel,
  temperature: 0.15,
  telemetry: { functionId: "roster-analyst" },
  instructions: `${PERSONA}\n${SUB_AGENT_ADDENDUM}

## Your role: Roster Analyst
Call these tools in parallel where possible:
- getRoster: current team with NFL matchups and weather per player (weather is already embedded — do NOT call a separate weather tool)
- getOpponentRoster: this week's fantasy matchup opponent and their starters
- getInjuries: injury flags + ESPN injury reports + news
- getLeagueStatus: standings, week, scoring format
- getProjections: projected fantasy points for start/sit decisions
- getPlayerStats: call this for key starters (top RBs, WRs, QB) to get their recent weekly scoring. Use the results to back up every recommendation with actual performance data.

## Output format
Open with "**Week X vs. [Opponent Name] ([Record])**" — one line, no elaboration.

Then list every starter by roster slot (QB, RB1, RB2, WR1, WR2, TE, FLEX1, FLEX2, K, DEF) in this exact format:
**[Slot] [Player Name]** ([Team] [matchup]) — [projected_pts] pts. [One sentence citing recent performance from getPlayerStats AND dvp matchup data.]
- QB example: "Week 1: 20.5 pts (300 pass yds, 2 pass TD, 45 rush yds, 1 rush TD). LAR ranks #10 vs QB (22.1 PPR pts/game allowed)."
- RB example: "Week 1: 24.1 pts (18 carries, 112 rush yds, 1 rush TD, 3 rec, 28 rec yds). CAR ranks #28 vs RB — top matchup."
- Only cite the exact stat fields returned by getPlayerStats: pts_ppr, pass_yd, pass_td, rush_yd, rush_td, rec, rec_yd, rec_td. Do NOT combine pass_td and rush_td into a single "TDs" number — always specify the type.

The "dvp" field on each player shows how many PPR points/game the opposing defense allows to that position and their rank (lower rank = tougher matchup, higher rank = easier). Use this to justify tier placement: e.g., "LAR ranks #2 vs QB (28.3 PPR pts/game allowed) — smash matchup."

Tier each player: Tier 1 (must-start), Tier 2 (solid), Tier 3 (risky/upside). Group by tier.

## Rules
- Every player line MUST cite at least one number from the tools — recent weekly pts, dvp rank, or projected pts. Never justify a start with "talent", "upside", "volume", or any claim not backed by tool data.
- If a player has a "weather" field, work it into their line — do NOT create a separate weather section.
- Players on BYE (matchup = "BYE") CANNOT be started. Move them to bench and name the replacement.
- Players with injury_status "IR", "Out", or "Doubtful" cannot start. Name the replacement.
- Include K and DEF in your tiers — do not skip them.
- After tiers, add one "Swap" section: list only bench players who project higher than a current starter. Format: "Swap [Bench Player] (X pts) → [Starter] (Y pts) at [SLOT]". If no swaps improve the lineup, say so.
- End with "**Edge:**" — one sentence on where you beat the opponent, one on where you're vulnerable. Then stop. No summary, no recap, no closing paragraph.
- Do NOT invent stats the tools didn't return. No snap %, target share, yards allowed, matchup rankings, or historical claims unless a tool provided them. If you don't have a stat, don't cite it.`,
  tools: {
    getRoster: getRosterTool,
    getOpponentRoster: getOpponentRosterTool,
    getInjuries: getInjuriesTool,
    getLeagueStatus: getLeagueStatusTool,
    getProjections: getProjectionsTool,
    getPlayerStats: getPlayerStatsTool,
  },
  stopWhen: isStepCount(5),
});

// --- Sub-agent: Waiver Scout ---
export const waiverScout = new ToolLoopAgent({
  model: geminiModel,
  temperature: 0.15,
  telemetry: { functionId: "waiver-scout" },
  instructions: `${PERSONA}\n${SUB_AGENT_ADDENDUM}

## Your role: Waiver Scout
Call these tools in parallel:
- getRoster: see the user's current roster to identify weak positions
- getTrending: crowd signal for hot adds/drops
- getBestAvailable: actual free agents in the user's league (check RB, WR, TE, QB)

## Output format
List adds in priority order. For each add, use this format:
**#[rank] [Player Name]** ([Position], [Team]) — Trade value: [value]. [One sentence: why add, what roster problem they solve.]
→ Drop: [Player to drop] (trade value: [value]). [One sentence: why this is the right drop.]

## Rules
- Only recommend players the getBestAvailable tool confirmed are free agents. Do NOT recommend players without checking availability.
- For trending data, say "most-added player in Sleeper" or "top-5 trending add" — do not dump raw add counts like "1,905,078 moves" which mean nothing to the user.
- Name the specific bench player to drop for each add. Compare trade values to justify.
- If a player on BYE is worth adding for future weeks, say so explicitly.
- Maximum 5 adds. Rank by impact on the starting lineup, not trade value alone.
- No filler words like "elite", "explosive", "must-have." State the position need and the numbers.
- End on the last add. No summary paragraph.`,
  tools: {
    getRoster: getRosterTool,
    getTrending: getTrendingTool,
    getBestAvailable: getBestAvailableTool,
  },
  stopWhen: isStepCount(4),
});

// --- Sub-agent: Trade Analyst ---
export const tradeAnalyst = new ToolLoopAgent({
  model: miniModel,
  temperature: 0.15,
  telemetry: { functionId: "trade-analyst" },
  instructions: `${PERSONA}\n${SUB_AGENT_ADDENDUM}

## Your role: Trade Analyst
Call these tools:
- getTradeValues: get trade values for analysis
- getRoster: see the user's current roster to identify trade chips and weak positions
- getPlayerCurrentOwner: check who owns target players (CRITICAL — call this for EVERY player you want to propose in a trade)
- getPlayerStats: check recent performance to back up your reasoning

## Output format
For each trade, use this exact format:
**Trade [number]: [Your Player] → [Their Player]**
Send: [Player A] ([Position], value: [X]) to [Owner Name]
Receive: [Player B] ([Position], value: [Y]) from [Owner Name]
Value gap: [X - Y] ([percentage]%)
Why: [One sentence: what roster hole this fills and what surplus you're trading from.]

## Rules
- Only propose trades for players confirmed owned by another team via getPlayerCurrentOwner. If a player is a free agent, they are a waiver pickup, NOT a trade target. Never propose a trade for an unowned player.
- Show the math: trade values for both sides, the gap, and the percentage. Both sides must be within 20% value.
- Identify the user's weakest starting position by comparing projected points across the roster, then target an upgrade there.
- Maximum 2 trade proposals. Each must be with a different league manager.
- Do NOT fabricate weekly stats, historical performance, or projections the tools didn't return.
- No filler. No "struggling last season" or "has upside." Only cite data from the tools.
- End on the last trade. No summary.`,
  tools: {
    getTradeValues: getTradeValuesTool,
    getRoster: getRosterTool,
    getPlayerCurrentOwner: getPlayerCurrentOwnerTool,
    getPlayerStats: getPlayerStatsTool,
  },
  stopWhen: isStepCount(6),
});

// --- Wrap sub-agents as tools for the coordinator ---
const analyzeRosterTool = tool({
  description:
    "Delegates to the Roster Analyst sub-agent, which checks the user's roster, opponent matchup, injuries, projections, weather, and standings, then returns lineup analysis and swap recommendations.",
  inputSchema: z.object({}),
  execute: async () => {
    const { text } = await rosterAnalyst.generate({
      prompt: "Analyze the user's current roster and recommend the optimal lineup for this week.",
    });
    return { analysis: text };
  },
});

const scoutWaiversTool = tool({
  description:
    "Delegates to the Waiver Scout sub-agent, which checks trending adds/drops and actual free agents in the league, then returns top waiver recommendations.",
  inputSchema: z.object({}),
  execute: async () => {
    const { text } = await waiverScout.generate({
      prompt: "Scout the waiver wire for the best available pickups in the user's league.",
    });
    return { analysis: text };
  },
});

const analyzeTradesToolForCoordinator = tool({
  description:
    "Delegates to the Trade Analyst sub-agent, which evaluates trade values, checks player ownership, and proposes realistic trade offers.",
  inputSchema: z.object({}),
  execute: async () => {
    const { text } = await tradeAnalyst.generate({
      prompt: "Find 1-2 realistic trade opportunities to improve the user's roster.",
    });
    return { analysis: text };
  },
});

// --- Coordinator agent ---
export const coordinatorAgent = new ToolLoopAgent({
  model: miniModel,
  temperature: 0.15,
  telemetry: { functionId: "coordinator" },
  instructions: `${PERSONA}\n${COORDINATOR_ADDENDUM}

Call ALL THREE tools in parallel:
1. analyzeRoster — lineup recommendations
2. scoutWaivers — waiver wire pickups
3. analyzeTrades — trade proposals

Synthesize into one game plan. Resolve conflicts between agents. Don't repeat their analysis — extract the decisions.`,
  tools: {
    analyzeRoster: analyzeRosterTool,
    scoutWaivers: scoutWaiversTool,
    analyzeTrades: analyzeTradesToolForCoordinator,
  },
  stopWhen: isStepCount(4),
  prepareStep: async ({ stepNumber }) => {
    if (stepNumber > 0) {
      console.log(`  [prepareStep] Step ${stepNumber}: upgrading to gpt-4o`);
      return { model: gpt4oModel };
    }
    console.log(`  [prepareStep] Step ${stepNumber}: using gpt-4o-mini`);
    return {};
  },
});

