import {
  getUserId,
  getLeagues,
  getRosters,
  getMatchups,
  getPlayersMap,
  getNFLState,
} from "@/lib/sleeper";
import { getNFLSchedule } from "@/lib/espn";
import { getWeatherForGames } from "@/lib/weather";

const SLEEPER_USERNAME = "biglets";

export async function GET() {
  try {
    const userId = await getUserId(SLEEPER_USERNAME);
    const leagues = await getLeagues(userId);
    if (!leagues.length)
      return Response.json({ error: "No leagues found" }, { status: 404 });

    const league = leagues[0];
    const [rosters, players, nflState, { opponents, games }] =
      await Promise.all([
        getRosters(league.league_id),
        getPlayersMap(),
        getNFLState(),
        getNFLSchedule(),
      ]);

    const weatherMap = await getWeatherForGames(games);
    const currentWeek = nflState.week || 1;

    const myRoster = rosters.find(
      (r: Record<string, unknown>) => r.owner_id === userId
    );
    if (!myRoster)
      return Response.json({ error: "Roster not found" }, { status: 404 });

    // Use matchups endpoint for current week starters (rosters endpoint has stale data)
    const matchups = await getMatchups(league.league_id, currentWeek);
    const myMatchup = matchups.find(
      (m: Record<string, unknown>) => m.roster_id === myRoster.roster_id
    );
    const matchupStarters = (myMatchup?.starters || []) as string[];
    const starterIds = new Set(
      matchupStarters.length > 0 ? matchupStarters : (myRoster.starters || [])
    );

    const rosterPlayers = (myRoster.players || []).map((id: string) => {
      const p = players[id];
      const team = p?.team || "";
      return {
        player_id: id,
        name: p?.full_name || id,
        position: p?.position || "DEF",
        team,
        matchup: team ? opponents[team] || "BYE" : "BYE",
        injury_status: p?.injury_status || null,
        weather: team ? weatherMap[team] || null : null,
        starter: starterIds.has(id),
        thumbnail: `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`,
      };
    });

    return Response.json({
      league_name: league.name,
      season: league.season,
      week: currentWeek,
      record: `${myRoster.settings?.wins || 0}-${myRoster.settings?.losses || 0}`,
      roster_positions: league.roster_positions,
      players: rosterPlayers,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
