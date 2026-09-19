import { tool } from "ai";
import { z } from "zod";
import {
  getUserId,
  getLeagues,
  getRosters,
  getMatchups,
  getPlayersMap,
  getTrendingPlayers,
  getLeagueUsers,
  getPlayerStats,
  getPlayerProjections,
  getNFLState,
} from "./sleeper";
import { getPlayerNews, getNFLSchedule } from "./espn";
import { getStadiumWeather, getWeatherForGames } from "./weather";
import { getTradeValues } from "./fantasycalc";

// Hard-coded for now — your Sleeper username
const SLEEPER_USERNAME = "biglets";

export const getRosterTool = tool({
  description:
    "Get the user's fantasy football roster with player names, positions, injury status, starter/bench designation, this week's NFL opponent, weather conditions, and opponent defense-vs-position data (PPR points allowed to QB/RB/WR/TE). Weather is only included for notable conditions.",
  inputSchema: z.object({}),
  execute: async () => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const nflState = await getNFLState();
    const season = nflState.season || "2026";
    const currentWeek = nflState.week || 1;

    const [rosters, matchups, players, { opponents, games }] = await Promise.all([
      getRosters(league.league_id),
      getMatchups(league.league_id, currentWeek),
      getPlayersMap(),
      getNFLSchedule(),
    ]);

    // Build opponent team lookup: "@ KC" → "KC", "vs SEA" → "SEA"
    const oppTeamMap: Record<string, string> = {};
    for (const g of games) {
      oppTeamMap[g.home] = g.away;
      oppTeamMap[g.away] = g.home;
    }

    // Fetch DvP: defensive stats from recent weeks (fantasy points allowed by position)
    const dvpWeeks = Math.min(currentWeek - 1, 3);
    const dvpMap: Record<string, Record<string, number>> = {};

    if (dvpWeeks > 0) {
      const startW = Math.max(1, currentWeek - dvpWeeks);
      const weekNums = Array.from({ length: currentWeek - startW }, (_, i) => startW + i);
      const allStats = await Promise.all(
        weekNums.map((w) => getPlayerStats(season, w))
      );

      // Aggregate fantasy points allowed per position per team
      const teamTotals: Record<string, { qb: number; rb: number; wr: number; te: number; gp: number }> = {};

      for (const weekStats of allStats) {
        // DEF entries use team abbreviation as ID (e.g., "KC", "SF")
        for (const [id, stats] of Object.entries(weekStats)) {
          const s = stats as Record<string, number>;
          if (s.fan_pts_allow_qb !== undefined || s.fan_pts_allow_rb !== undefined) {
            if (!teamTotals[id]) teamTotals[id] = { qb: 0, rb: 0, wr: 0, te: 0, gp: 0 };
            teamTotals[id].qb += s.fan_pts_allow_qb || 0;
            teamTotals[id].rb += s.fan_pts_allow_rb || 0;
            teamTotals[id].wr += s.fan_pts_allow_wr || 0;
            teamTotals[id].te += s.fan_pts_allow_te || 0;
            teamTotals[id].gp += 1;
          }
        }
      }

      // Average per game and rank
      const positions = ["qb", "rb", "wr", "te"] as const;
      for (const pos of positions) {
        const ranked = Object.entries(teamTotals)
          .map(([team, t]) => ({ team, avg: t.gp > 0 ? Math.round((t[pos] / t.gp) * 10) / 10 : 0 }))
          .sort((a, b) => b.avg - a.avg); // most points allowed = worst defense = best matchup

        ranked.forEach((entry, i) => {
          if (!dvpMap[entry.team]) dvpMap[entry.team] = {};
          dvpMap[entry.team][pos] = i + 1; // rank 1 = allows most points (best matchup)
          dvpMap[entry.team][`${pos}_avg`] = entry.avg;
        });
      }
    }

    // Fetch weather for all outdoor games in parallel
    const weatherMap = await getWeatherForGames(games);

    const myRoster = rosters.find(
      (r: Record<string, unknown>) => r.owner_id === userId
    );
    if (!myRoster) return { error: "Roster not found" };

    // Use matchups endpoint for current week starters (rosters endpoint can be stale)
    const myMatchup = matchups.find(
      (m: Record<string, unknown>) => m.roster_id === myRoster.roster_id
    );
    const matchupStarters = (myMatchup?.starters || []) as string[];
    const starterIds = new Set(
      matchupStarters.length > 0 ? matchupStarters : (myRoster.starters || [])
    );

    const rosterPlayers = (myRoster.players || []).map((id: string) => {
      const p = players[id];
      if (!p) return { player_id: id, name: id, position: "DEF", team: id };
      const team = p.team || "";
      const weather = team ? weatherMap[team] : null;
      const oppTeam = team ? oppTeamMap[team] : undefined;
      const posKey = p.position?.toLowerCase();
      const dvp = oppTeam && posKey && dvpMap[oppTeam]
        ? {
            opp_rank_vs_pos: dvpMap[oppTeam][posKey],
            opp_ppg_allowed: dvpMap[oppTeam][`${posKey}_avg`],
          }
        : undefined;

      return {
        name: p.full_name || id,
        position: p.position,
        team,
        matchup: team ? opponents[team] || "BYE" : "BYE",
        injury_status: p.injury_status || "healthy",
        starter: starterIds.has(id),
        ...(weather ? { weather } : {}),
        ...(dvp ? { dvp: `${oppTeam} ranks #${dvp.opp_rank_vs_pos} vs ${p.position} (${dvp.opp_ppg_allowed} PPR pts/game allowed)` } : {}),
      };
    });

    return {
      league_name: league.name,
      season: league.season,
      week: league.settings?.leg || 1,
      record: `${myRoster.settings?.wins || 0}-${myRoster.settings?.losses || 0}`,
      roster_positions: league.roster_positions,
      players: rosterPlayers,
    };
  },
});

export const getOpponentRosterTool = tool({
  description:
    "Get the opposing manager's roster for this week's fantasy matchup. Shows who you're playing against and their starters.",
  inputSchema: z.object({}),
  execute: async () => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const nflState = await getNFLState();
    const currentWeek = nflState.week || league.settings?.leg || 1;

    const [rosters, matchups, users, players] = await Promise.all([
      getRosters(league.league_id),
      getMatchups(league.league_id, currentWeek),
      getLeagueUsers(league.league_id),
      getPlayersMap(),
    ]);

    const myRoster = rosters.find(
      (r: Record<string, unknown>) => r.owner_id === userId
    );
    if (!myRoster) return { error: "Roster not found" };

    const myMatchup = matchups.find(
      (m: Record<string, unknown>) => m.roster_id === myRoster.roster_id
    );
    if (!myMatchup) return { error: "No matchup found for this week" };

    const opponentMatchup = matchups.find(
      (m: Record<string, unknown>) =>
        m.matchup_id === myMatchup.matchup_id &&
        m.roster_id !== myRoster.roster_id
    );
    if (!opponentMatchup) return { error: "Opponent not found" };

    const opponentRoster = rosters.find(
      (r: Record<string, unknown>) =>
        r.roster_id === opponentMatchup.roster_id
    );

    const userMap = Object.fromEntries(
      users.map((u: Record<string, unknown>) => [u.user_id, u.display_name])
    );

    const opponentName =
      userMap[opponentRoster?.owner_id as string] || "Unknown";

    const opponentSettings = opponentRoster?.settings as Record<string, number> | undefined;

    const starterIds = new Set(
      (opponentMatchup.starters || []) as string[]
    );

    const starters = ((opponentMatchup.starters || []) as string[]).map(
      (id: string) => {
        const p = players[id];
        return {
          name: p?.full_name || id,
          position: p?.position,
          team: p?.team,
          points: (opponentMatchup.players_points as Record<string, number>)?.[id] ?? null,
        };
      }
    );

    return {
      week: currentWeek,
      opponent: opponentName,
      opponent_record: `${opponentSettings?.wins || 0}-${opponentSettings?.losses || 0}`,
      my_points: myMatchup.points ?? 0,
      opponent_points: opponentMatchup.points ?? 0,
      starters,
    };
  },
});

export const getInjuriesTool = tool({
  description:
    "Get current injury information for the user's roster players. Includes Sleeper injury flags and ESPN news filtered to prioritize stories about the user's players and their teams.",
  inputSchema: z.object({}),
  execute: async () => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const [rosters, players, news] = await Promise.all([
      getRosters(league.league_id),
      getPlayersMap(),
      getPlayerNews(25),
    ]);

    const myRoster = rosters.find(
      (r: Record<string, unknown>) => r.owner_id === userId
    );
    if (!myRoster) return { error: "Roster not found" };

    // Build set of roster player names and team abbreviations for news filtering
    const rosterNames = new Set<string>();
    const rosterTeams = new Set<string>();
    for (const id of (myRoster.players || []) as string[]) {
      const p = players[id];
      if (p?.full_name) rosterNames.add(p.full_name.toLowerCase());
      if (p?.last_name) rosterNames.add(p.last_name.toLowerCase());
      if (p?.team) rosterTeams.add(p.team.toLowerCase());
    }

    const injured = (myRoster.players || [])
      .map((id: string) => players[id])
      .filter((p: Record<string, unknown> | undefined) => p && p.injury_status)
      .map((p: Record<string, unknown>) => ({
        name: p.full_name,
        position: p.position,
        team: p.team,
        injury_status: p.injury_status,
        injury_body_part: p.injury_body_part,
        injury_notes: p.injury_notes,
      }));

    // Split news: roster-relevant first, then general
    const relevant: { headline: string; description: string }[] = [];
    const general: { headline: string; description: string }[] = [];

    for (const n of news) {
      const text = `${n.headline} ${n.description || ""}`.toLowerCase();
      const isRelevant = [...rosterNames].some((name) => text.includes(name)) ||
        [...rosterTeams].some((team) => text.includes(team));

      const entry = {
        headline: n.headline,
        description: (n.description || "").slice(0, 150),
      };

      if (isRelevant) relevant.push(entry);
      else general.push(entry);
    }

    return {
      roster_injuries: injured.length ? injured : "No injured players on your roster",
      news_about_your_players: relevant.length ? relevant.slice(0, 5) : "No recent news about your players",
      other_nfl_news: general.slice(0, 3),
    };
  },
});

export const getTrendingTool = tool({
  description:
    "Get trending waiver wire adds and drops across all Sleeper leagues in the last 24 hours. Shows which players are being added/dropped most, indicating breakout candidates or declining value.",
  inputSchema: z.object({
    type: z
      .enum(["add", "drop"])
      .describe("Whether to get trending adds or drops")
      .default("add"),
  }),
  execute: async ({ type }) => {
    const [trending, players] = await Promise.all([
      getTrendingPlayers(type),
      getPlayersMap(),
    ]);

    return trending.map(
      (t: { player_id: string; count: number }, i: number) => {
        const p = players[t.player_id];
        return {
          rank: i + 1,
          name: p?.full_name || t.player_id,
          position: p?.position,
          team: p?.team,
          moves: t.count,
          injury_status: p?.injury_status || "healthy",
        };
      }
    );
  },
});

// --- New tools ---

export const getLeagueStatusTool = tool({
  description:
    "Get league standings, current week, playoff configuration, and scoring settings. Essential context for making roster decisions.",
  inputSchema: z.object({}),
  execute: async () => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const [rosters, users, nflState] = await Promise.all([
      getRosters(league.league_id),
      getLeagueUsers(league.league_id),
      getNFLState(),
    ]);

    const userMap = Object.fromEntries(
      users.map((u: Record<string, unknown>) => [u.user_id, u.display_name])
    );

    const standings = rosters
      .map((r: Record<string, unknown>) => {
        const settings = r.settings as Record<string, number>;
        return {
          owner: userMap[r.owner_id as string] || "Unknown",
          owner_id: r.owner_id,
          roster_id: r.roster_id,
          wins: settings?.wins || 0,
          losses: settings?.losses || 0,
          ties: settings?.ties || 0,
          points_for: settings?.fpts || 0,
          points_against: settings?.fpts_against || 0,
          is_me: r.owner_id === userId,
        };
      })
      .sort(
        (a: Record<string, number>, b: Record<string, number>) =>
          b.wins - a.wins || b.points_for - a.points_for
      );

    return {
      league_name: league.name,
      season: league.season,
      current_week: nflState.week || league.settings?.leg || 1,
      nfl_season_status: nflState.season_type,
      num_teams: league.settings?.num_teams,
      playoff_teams: league.settings?.playoff_teams,
      playoff_week_start: league.settings?.playoff_week_start,
      scoring_type: league.scoring_settings?.rec === 1 ? "Full PPR" : league.scoring_settings?.rec === 0.5 ? "Half PPR" : "Standard",
      roster_positions: league.roster_positions,
      standings,
    };
  },
});

export const getPlayerCurrentOwnerTool = tool({
  description:
    "Find which team in the league currently owns a specific player. Critical for proposing realistic trades.",
  inputSchema: z.object({
    playerName: z.string().describe("The player name to search for (e.g. 'Patrick Mahomes')"),
  }),
  execute: async ({ playerName }) => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const [rosters, users, players] = await Promise.all([
      getRosters(league.league_id),
      getLeagueUsers(league.league_id),
      getPlayersMap(),
    ]);

    const normalized = playerName.toLowerCase();
    const playerEntry = Object.entries(players).find(
      ([, p]) => (p as unknown as Record<string, unknown>).full_name?.toString().toLowerCase().includes(normalized)
    );
    if (!playerEntry) return { error: `Player "${playerName}" not found` };

    const [playerId, playerData] = playerEntry;
    const p = playerData as unknown as Record<string, unknown>;

    const userMap = Object.fromEntries(
      users.map((u: Record<string, unknown>) => [u.user_id, u.display_name])
    );

    for (const roster of rosters) {
      const r = roster as unknown as Record<string, unknown>;
      const rosterPlayers = r.players as string[];
      if (rosterPlayers?.includes(playerId)) {
        return {
          player: p.full_name,
          position: p.position,
          team: p.team,
          owned_by: userMap[r.owner_id as string] || "Unknown",
          is_me: r.owner_id === userId,
          roster_id: r.roster_id,
        };
      }
    }

    return {
      player: p.full_name,
      position: p.position,
      team: p.team,
      owned_by: null,
      available: true,
      note: "This player is a free agent in your league",
    };
  },
});

export const getBestAvailableTool = tool({
  description:
    "Get the best available free agents at a specific position in your league. Shows unrostered players ranked by trade value.",
  inputSchema: z.object({
    position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).describe("Position to search"),
    limit: z.number().default(10).describe("Number of results to return"),
  }),
  execute: async ({ position, limit }) => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const [rosters, players, tradeValues] = await Promise.all([
      getRosters(league.league_id),
      getPlayersMap(),
      getTradeValues({ numTeams: league.settings?.num_teams || 8 }),
    ]);

    // Collect all rostered player IDs
    const rosteredIds = new Set<string>();
    for (const r of rosters) {
      const rosterPlayers = (r as unknown as Record<string, unknown>).players as string[];
      if (rosterPlayers) rosterPlayers.forEach((id: string) => rosteredIds.add(id));
    }

    // Build trade value lookup by name
    const valueByName = Object.fromEntries(
      tradeValues.map((tv) => [tv.name.toLowerCase(), tv])
    );

    // Find unrostered players at position with trade values
    const available = Object.entries(players)
      .filter(([id, p]) => {
        const player = p as unknown as Record<string, unknown>;
        return (
          !rosteredIds.has(id) &&
          player.position === position &&
          player.team &&
          player.status === "Active"
        );
      })
      .map(([id, p]) => {
        const player = p as unknown as Record<string, unknown>;
        const name = (player.full_name as string) || id;
        const tv = valueByName[name.toLowerCase()];
        return {
          name,
          team: player.team,
          injury_status: player.injury_status || "healthy",
          trade_value: tv?.value || 0,
          overall_rank: tv?.overallRank || 999,
        };
      })
      .sort((a, b) => b.trade_value - a.trade_value)
      .slice(0, limit);

    return { position, available };
  },
});

export const getPlayerStatsTool = tool({
  description:
    "Get a player's weekly fantasy points and stats for the current season. Useful for identifying trends, slumps, and breakout performances.",
  inputSchema: z.object({
    playerName: z.string().describe("The player name to look up"),
  }),
  execute: async ({ playerName }) => {
    const [players, nflState] = await Promise.all([
      getPlayersMap(),
      getNFLState(),
    ]);
    const currentWeek = nflState.week || 1;
    const season = nflState.season || "2026";

    const normalized = playerName.toLowerCase();
    const playerEntry = Object.entries(players).find(
      ([, p]) => (p as unknown as Record<string, unknown>).full_name?.toString().toLowerCase().includes(normalized)
    );
    if (!playerEntry) return { error: `Player "${playerName}" not found` };

    const [playerId, playerData] = playerEntry;
    const p = playerData as unknown as Record<string, unknown>;

    // Fetch stats for recent weeks in parallel
    const weeksToFetch = Math.min(currentWeek - 1, 6);
    const startWeek = Math.max(1, currentWeek - weeksToFetch);
    const weekNumbers = Array.from(
      { length: currentWeek - startWeek },
      (_, i) => startWeek + i
    );

    const allStats = await Promise.all(
      weekNumbers.map((w) => getPlayerStats(season, w))
    );

    const weeklyStats = weekNumbers
      .map((w, i) => {
        const playerStats = allStats[i][playerId];
        if (!playerStats) return null;
        return {
          week: w,
          pts_ppr: playerStats.pts_ppr || 0,
          pass_yd: playerStats.pass_yd,
          pass_td: playerStats.pass_td,
          rush_yd: playerStats.rush_yd,
          rush_td: playerStats.rush_td,
          rec: playerStats.rec,
          rec_yd: playerStats.rec_yd,
          rec_td: playerStats.rec_td,
        };
      })
      .filter(Boolean);

    return {
      player: p.full_name,
      position: p.position,
      team: p.team,
      weekly_stats: weeklyStats.length ? weeklyStats : "No stats available yet",
    };
  },
});

export const getProjectionsTool = tool({
  description:
    "Get projected fantasy points for the user's roster players for the current week. Useful for start/sit decisions and identifying expected value.",
  inputSchema: z.object({}),
  execute: async () => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const [rosters, players, nflState] = await Promise.all([
      getRosters(league.league_id),
      getPlayersMap(),
      getNFLState(),
    ]);

    const myRoster = rosters.find(
      (r: Record<string, unknown>) => r.owner_id === userId
    );
    if (!myRoster) return { error: "Roster not found" };

    const currentWeek = nflState.week || 1;
    const projections = await getPlayerProjections(
      nflState.season || "2026",
      currentWeek
    );

    const starterIds = new Set(myRoster.starters || []);

    const rosterProjections = (myRoster.players || [])
      .map((id: string) => {
        const p = players[id];
        const proj = projections[id];
        const pts = proj?.pts_ppr ?? proj?.pts_std ?? null;
        if (pts === null) return null;
        return {
          name: p?.full_name || id,
          position: p?.position,
          team: p?.team,
          starter: starterIds.has(id),
          projected_pts: Math.round(pts * 10) / 10,
        };
      })
      .filter((p: { projected_pts: number } | null): p is { name: string; position: string | undefined; team: string | null | undefined; starter: boolean; projected_pts: number } => p !== null)
      .sort((a: { projected_pts: number }, b: { projected_pts: number }) => b.projected_pts - a.projected_pts);

    return {
      week: currentWeek,
      projections: rosterProjections.length
        ? rosterProjections
        : "No projections available for this week",
    };
  },
});

export const getWeatherTool = tool({
  description:
    "Get weather conditions for an NFL team's stadium. High winds, rain, or extreme cold can significantly impact passing games and kicker performance.",
  inputSchema: z.object({
    team: z.string().describe("NFL team abbreviation (e.g. 'CHI', 'GB', 'NE')"),
  }),
  execute: async ({ team }) => {
    return getStadiumWeather(team.toUpperCase());
  },
});

export const getTradeValuesTool = tool({
  description:
    "Get current trade values for fantasy players based on real trade data from millions of leagues. Use this to propose fair trades and evaluate trade offers.",
  inputSchema: z.object({
    playerNames: z
      .array(z.string())
      .describe("List of player names to get trade values for")
      .default([]),
    topN: z
      .number()
      .describe("If no names provided, return the top N most valuable players")
      .default(20),
  }),
  execute: async ({ playerNames, topN }) => {
    const values = await getTradeValues();

    if (playerNames.length > 0) {
      return playerNames.map((name) => {
        const normalized = name.toLowerCase();
        const match = values.find((v) =>
          v.name.toLowerCase().includes(normalized)
        );
        return match || { name, value: 0, note: "Player not found in trade values" };
      });
    }

    return values.slice(0, topN);
  },
});

export const findTradeTargetsTool = tool({
  description:
    "Scans all league rosters to find realistic trade opportunities. Returns your roster's weak positions, other managers' surplus players at those positions, and pre-calculated trade value comparisons. Every result is ownership-verified — no free agents, no guessing.",
  inputSchema: z.object({
    maxValueGapPercent: z
      .number()
      .describe("Maximum allowed trade value gap percentage between sides")
      .default(25),
  }),
  execute: async ({ maxValueGapPercent }) => {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length) return { error: "No leagues found" };

    const league = leagues[0];
    const nflState = await getNFLState();
    const currentWeek = nflState.week || 1;

    const [rosters, users, players, tradeValuesList, projections] = await Promise.all([
      getRosters(league.league_id),
      getLeagueUsers(league.league_id),
      getPlayersMap(),
      getTradeValues({ numTeams: league.settings?.num_teams || 8 }),
      getPlayerProjections(nflState.season || "2026", currentWeek),
    ]);

    const userMap = Object.fromEntries(
      users.map((u: Record<string, unknown>) => [u.user_id, u.display_name])
    );

    // Trade value lookup by player name
    const valueByName: Record<string, number> = {};
    for (const tv of tradeValuesList) {
      valueByName[tv.name.toLowerCase()] = tv.value;
    }

    const getPlayerValue = (name: string): number =>
      valueByName[name.toLowerCase()] || 0;

    // Find my roster
    const myRoster = rosters.find(
      (r: Record<string, unknown>) => r.owner_id === userId
    );
    if (!myRoster) return { error: "Roster not found" };

    const mySettings = myRoster.settings as Record<string, number> | undefined;

    // Build my roster with projections and trade values
    const starterPositions = ["QB", "RB", "WR", "TE"];
    const myPlayers = ((myRoster.players || []) as string[]).map((id: string) => {
      const p = players[id];
      if (!p) return null;
      const proj = projections[id];
      return {
        player_id: id,
        name: p.full_name || id,
        position: p.position,
        team: p.team,
        starter: ((myRoster.starters || []) as string[]).includes(id),
        projected_pts: proj?.pts_ppr ?? proj?.pts_std ?? 0,
        trade_value: getPlayerValue(p.full_name || ""),
        injury_status: p.injury_status || "healthy",
      };
    }).filter(Boolean) as Array<{
      player_id: string; name: string; position: string;
      team: string | null; starter: boolean; projected_pts: number;
      trade_value: number; injury_status: string;
    }>;

    // Identify weak positions: lowest projected starter at each position
    const myStartersByPos: Record<string, typeof myPlayers> = {};
    for (const p of myPlayers) {
      if (p.starter && starterPositions.includes(p.position)) {
        if (!myStartersByPos[p.position]) myStartersByPos[p.position] = [];
        myStartersByPos[p.position].push(p);
      }
    }

    const weakPositions = starterPositions
      .map((pos) => {
        const starters = myStartersByPos[pos] || [];
        if (!starters.length) return { position: pos, weakest_starter: null, projected_pts: 0 };
        const weakest = starters.sort((a, b) => a.projected_pts - b.projected_pts)[0];
        return { position: pos, weakest_starter: weakest.name, projected_pts: weakest.projected_pts, trade_value: weakest.trade_value };
      })
      .sort((a, b) => a.projected_pts - b.projected_pts);

    // My tradeable bench players (surplus): bench players with trade value
    const myBench = myPlayers
      .filter((p) => !p.starter && p.trade_value > 0 && starterPositions.includes(p.position))
      .sort((a, b) => b.trade_value - a.trade_value);

    // Scan all other rosters for trade candidates
    const tradeCandidates: Array<{
      target_player: string;
      target_position: string;
      target_team: string | null;
      target_value: number;
      target_projected_pts: number;
      owned_by: string;
      owner_record: string;
      owner_roster_id: number;
      // Best trade chip from my bench
      send_player: string;
      send_position: string;
      send_value: number;
      value_gap: number;
      value_gap_percent: number;
    }> = [];

    for (const roster of rosters) {
      const r = roster as unknown as Record<string, unknown>;
      if (r.owner_id === userId) continue;

      const rSettings = r.settings as Record<string, number> | undefined;
      const ownerName = userMap[r.owner_id as string] || "Unknown";
      const ownerRecord = `${rSettings?.wins || 0}-${rSettings?.losses || 0}`;
      const rosterPlayers = (r.players || []) as string[];
      const rosterStarters = new Set((r.starters || []) as string[]);

      for (const pid of rosterPlayers) {
        const p = players[pid];
        if (!p || !p.full_name || !starterPositions.includes(p.position)) continue;

        const targetValue = getPlayerValue(p.full_name);
        if (targetValue <= 0) continue;

        const proj = projections[pid];
        const targetProjPts = proj?.pts_ppr ?? proj?.pts_std ?? 0;

        // Is this player at one of my weak positions and better than my starter?
        const myWeakAtPos = weakPositions.find((w) => w.position === p.position);
        if (!myWeakAtPos || targetProjPts <= myWeakAtPos.projected_pts) continue;

        // Find the best trade chip from my bench that's within value range
        for (const chip of myBench) {
          const gap = Math.abs(targetValue - chip.trade_value);
          const gapPercent = targetValue > 0 ? Math.round((gap / targetValue) * 100) : 100;

          if (gapPercent <= maxValueGapPercent) {
            tradeCandidates.push({
              target_player: p.full_name,
              target_position: p.position,
              target_team: p.team,
              target_value: targetValue,
              target_projected_pts: Math.round(targetProjPts * 10) / 10,
              owned_by: ownerName,
              owner_record: ownerRecord,
              owner_roster_id: r.roster_id as number,
              send_player: chip.name,
              send_position: chip.position,
              send_value: chip.trade_value,
              value_gap: targetValue - chip.trade_value,
              value_gap_percent: gapPercent,
            });
            break; // best chip per target
          }
        }
      }
    }

    // Sort by upgrade potential (projected pts gain)
    tradeCandidates.sort((a, b) => b.target_projected_pts - a.target_projected_pts);

    return {
      my_record: `${mySettings?.wins || 0}-${mySettings?.losses || 0}`,
      weak_positions: weakPositions,
      my_tradeable_bench: myBench.map((p) => ({
        name: p.name,
        position: p.position,
        trade_value: p.trade_value,
      })),
      trade_candidates: tradeCandidates.slice(0, 8),
      note: "All candidates are ownership-verified. Every target is rostered by the named manager.",
    };
  },
});
