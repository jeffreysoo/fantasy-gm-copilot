// ESPN API client for player news/injuries
// Gotcha: browser User-Agent gets 403, plain UA gets 200

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

export interface ESPNNews {
  headline: string;
  description: string;
  published: string;
  links?: { web?: { href?: string } };
}

export async function getPlayerNews(limit: number = 20): Promise<ESPNNews[]> {
  const res = await fetch(`${ESPN_BASE}/news?limit=${limit}`, {
    headers: { "User-Agent": "fantasy-gm-copilot/1.0" },
  });
  if (!res.ok) throw new Error(`ESPN news API: ${res.status}`);
  const data = await res.json();
  return (data.articles || []).map((a: Record<string, unknown>) => ({
    headline: a.headline,
    description: a.description,
    published: a.published,
    links: a.links,
  }));
}

export interface NFLGame {
  home: string;
  away: string;
  date: string;
  status: string;
}

/**
 * Get the current week's NFL schedule from ESPN.
 * Returns a list of games and a lookup map: team abbreviation → opponent abbreviation.
 */
export async function getNFLSchedule(): Promise<{
  games: NFLGame[];
  opponents: Record<string, string>;
}> {
  const res = await fetch(
    "https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=football&league=nfl",
    { headers: { "User-Agent": "fantasy-gm-copilot/1.0" } }
  );
  if (!res.ok) throw new Error(`ESPN schedule API: ${res.status}`);
  const data = await res.json();

  const events =
    data?.sports?.[0]?.leagues?.[0]?.events || [];

  const games: NFLGame[] = [];
  const opponents: Record<string, string> = {};

  for (const e of events) {
    const comps = e.competitors || [];
    if (comps.length < 2) continue;
    const home = comps[0]?.abbreviation;
    const away = comps[1]?.abbreviation;
    if (!home || !away) continue;

    games.push({
      home,
      away,
      date: e.date || "",
      status: e.status || "",
    });

    // WSH → "vs PHI", PHI → "@ WSH"
    opponents[home] = `vs ${away}`;
    opponents[away] = `@ ${home}`;
  }

  return { games, opponents };
}
