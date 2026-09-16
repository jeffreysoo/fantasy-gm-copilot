// Sleeper API client + cached players map
// The players map is ~5MB — we cache it in memory and refresh at most once per hour.

const SLEEPER_BASE = "https://api.sleeper.app/v1";

export interface SleeperPlayer {
  player_id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  injury_body_part: string | null;
  injury_notes: string | null;
  injury_start_date: string | null;
  depth_chart_order: number | null;
  status: string;
  age: number | null;
  fantasy_positions: string[] | null;
}

type PlayersMap = Record<string, SleeperPlayer>;

let cachedPlayers: PlayersMap | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — Sleeper docs: call at most once per day (~5MB response)

export async function getPlayersMap(): Promise<PlayersMap> {
  const now = Date.now();
  if (cachedPlayers && now - cacheTimestamp < CACHE_TTL) {
    return cachedPlayers;
  }
  const res = await fetch(`${SLEEPER_BASE}/players/nfl`);
  if (!res.ok) throw new Error(`Sleeper players API: ${res.status}`);
  cachedPlayers = await res.json();
  cacheTimestamp = now;
  return cachedPlayers!;
}

export async function getUserId(username: string): Promise<string> {
  const res = await fetch(`${SLEEPER_BASE}/user/${username}`);
  if (!res.ok) throw new Error(`Sleeper user API: ${res.status}`);
  const user = await res.json();
  if (!user) throw new Error(`User "${username}" not found`);
  return user.user_id;
}

export async function getLeagues(userId: string, season?: string) {
  if (!season) {
    const state = await getNFLState();
    season = state.season || "2026";
  }
  const res = await fetch(`${SLEEPER_BASE}/user/${userId}/leagues/nfl/${season}`);
  if (!res.ok) throw new Error(`Sleeper leagues API: ${res.status}`);
  return res.json();
}

export async function getRosters(leagueId: string) {
  const res = await fetch(`${SLEEPER_BASE}/league/${leagueId}/rosters`);
  if (!res.ok) throw new Error(`Sleeper rosters API: ${res.status}`);
  return res.json();
}

export async function getMatchups(leagueId: string, week: number) {
  const res = await fetch(`${SLEEPER_BASE}/league/${leagueId}/matchups/${week}`);
  if (!res.ok) throw new Error(`Sleeper matchups API: ${res.status}`);
  return res.json();
}

export async function getTrendingPlayers(type: "add" | "drop", hours: number = 24) {
  const res = await fetch(`${SLEEPER_BASE}/players/nfl/trending/${type}?lookback_hours=${hours}&limit=15`);
  if (!res.ok) throw new Error(`Sleeper trending API: ${res.status}`);
  return res.json();
}

export async function getLeagueUsers(leagueId: string) {
  const res = await fetch(`${SLEEPER_BASE}/league/${leagueId}/users`);
  if (!res.ok) throw new Error(`Sleeper users API: ${res.status}`);
  return res.json();
}

export async function getPlayerStats(season: string, week: number) {
  const res = await fetch(`${SLEEPER_BASE}/stats/nfl/regular/${season}/${week}`);
  if (!res.ok) throw new Error(`Sleeper stats API: ${res.status}`);
  return res.json();
}

export async function getPlayerProjections(season: string, week: number) {
  const res = await fetch(`${SLEEPER_BASE}/projections/nfl/regular/${season}/${week}`);
  if (!res.ok) throw new Error(`Sleeper projections API: ${res.status}`);
  return res.json();
}

export async function getNFLState() {
  const res = await fetch(`${SLEEPER_BASE}/state/nfl`);
  if (!res.ok) throw new Error(`Sleeper state API: ${res.status}`);
  return res.json();
}
