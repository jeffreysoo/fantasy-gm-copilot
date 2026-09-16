// Open-Meteo API — free, no auth
// Returns weather forecast for a stadium at game time

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

// NFL stadium coordinates (outdoor stadiums only — dome games skip weather)
const STADIUMS: Record<string, { lat: number; lon: number; dome: boolean }> = {
  ARI: { lat: 33.5276, lon: -112.2626, dome: true },
  ATL: { lat: 33.7554, lon: -84.401, dome: true },
  BAL: { lat: 39.278, lon: -76.6227, dome: false },
  BUF: { lat: 42.7738, lon: -78.787, dome: false },
  CAR: { lat: 35.2258, lon: -80.8528, dome: false },
  CHI: { lat: 41.8623, lon: -87.6167, dome: false },
  CIN: { lat: 39.0955, lon: -84.516, dome: false },
  CLE: { lat: 41.506, lon: -81.6995, dome: false },
  DAL: { lat: 32.7473, lon: -97.0945, dome: true },
  DEN: { lat: 39.7439, lon: -105.02, dome: false },
  DET: { lat: 42.34, lon: -83.0456, dome: true },
  GB: { lat: 44.5013, lon: -88.0622, dome: false },
  HOU: { lat: 29.6847, lon: -95.4107, dome: true },
  IND: { lat: 39.7601, lon: -86.1639, dome: true },
  JAX: { lat: 30.3239, lon: -81.6373, dome: false },
  KC: { lat: 39.0489, lon: -94.484, dome: false },
  LAC: { lat: 33.9535, lon: -118.3392, dome: true },
  LAR: { lat: 33.9535, lon: -118.3392, dome: true },
  LV: { lat: 36.0909, lon: -115.1833, dome: true },
  MIA: { lat: 25.958, lon: -80.2389, dome: false },
  MIN: { lat: 44.9736, lon: -93.2575, dome: true },
  NE: { lat: 42.0909, lon: -71.2643, dome: false },
  NO: { lat: 29.9511, lon: -90.0812, dome: true },
  NYG: { lat: 40.8128, lon: -74.0742, dome: false },
  NYJ: { lat: 40.8128, lon: -74.0742, dome: false },
  PHI: { lat: 39.9008, lon: -75.1675, dome: false },
  PIT: { lat: 40.4468, lon: -80.0158, dome: false },
  SEA: { lat: 47.5952, lon: -122.3316, dome: false },
  SF: { lat: 37.4033, lon: -121.9694, dome: false },
  TB: { lat: 27.9759, lon: -82.5033, dome: false },
  TEN: { lat: 36.1665, lon: -86.7713, dome: false },
  WAS: { lat: 38.9076, lon: -76.8645, dome: false },
};

export interface GameWeather {
  team: string;
  dome: boolean;
  gameDate?: string;
  temperature_f?: number;
  wind_mph?: number;
  precipitation_mm?: number;
  conditions: string;
}

/** Check if a stadium is a dome */
export function isDome(team: string): boolean {
  return STADIUMS[team]?.dome ?? false;
}

export async function getStadiumWeather(
  team: string,
  gameDate?: string
): Promise<GameWeather> {
  const stadium = STADIUMS[team];
  if (!stadium) return { team, dome: false, conditions: "Unknown stadium" };
  if (stadium.dome) return { team, dome: true, conditions: "Dome — weather irrelevant" };

  // Use provided game date, or fall back to next Sunday
  if (!gameDate) {
    const now = new Date();
    const day = now.getDay();
    const daysUntilSunday = day === 0 ? 0 : 7 - day;
    const gameDay = new Date(now);
    gameDay.setDate(gameDay.getDate() + daysUntilSunday);
    gameDate = gameDay.toISOString().split("T")[0];
  }

  const res = await fetch(
    `${OPEN_METEO_BASE}?latitude=${stadium.lat}&longitude=${stadium.lon}&hourly=temperature_2m,windspeed_10m,precipitation&start_date=${gameDate}&end_date=${gameDate}&temperature_unit=fahrenheit&windspeed_unit=mph`
  );
  if (!res.ok) return { team, dome: false, conditions: `API error: ${res.status}` };

  const data = await res.json();
  const hour = data.hourly;
  // Use 1pm local as a rough game-time approximation
  const idx = 13;
  const temp = hour?.temperature_2m?.[idx];
  const wind = hour?.windspeed_10m?.[idx];
  const precip = hour?.precipitation?.[idx];

  let conditions = "Clear";
  if (precip > 0.5) conditions = "Rain expected";
  if (wind > 15) conditions = conditions === "Rain expected" ? "Rain + high winds" : "High winds";
  if (temp < 35) conditions += (conditions === "Clear" ? "" : ", ") + "cold";

  return {
    team,
    dome: false,
    gameDate,
    temperature_f: Math.round(temp),
    wind_mph: Math.round(wind),
    precipitation_mm: Math.round(precip * 10) / 10,
    conditions,
  };
}

/**
 * Given a list of NFL games (home/away pairs from ESPN schedule),
 * fetch weather for all outdoor home stadiums in parallel.
 * Returns a map: team abbreviation → weather summary string (or null if dome/mild).
 * Both home AND away teams get the same weather since they play in the same stadium.
 */
export async function getWeatherForGames(
  games: { home: string; away: string; date?: string }[]
): Promise<Record<string, string | null>> {
  const outdoorGames = games.filter((g) => !isDome(g.home));

  const results = await Promise.allSettled(
    outdoorGames.map((g) => {
      // Extract YYYY-MM-DD from the ESPN ISO date string
      const gameDate = g.date ? g.date.split("T")[0] : undefined;
      return getStadiumWeather(g.home, gameDate);
    })
  );

  const weatherMap: Record<string, string | null> = {};

  for (let i = 0; i < outdoorGames.length; i++) {
    const game = outdoorGames[i];
    const result = results[i];

    // Skip failed fetches gracefully
    if (result.status === "rejected") {
      weatherMap[game.home] = null;
      weatherMap[game.away] = null;
      continue;
    }

    const w = result.value;

    // Only flag weather that actually matters for fantasy
    if (w.conditions === "Clear") {
      weatherMap[game.home] = null;
      weatherMap[game.away] = null;
      continue;
    }

    const summary = `${w.conditions} (${w.temperature_f}°F, ${w.wind_mph}mph wind)`;
    weatherMap[game.home] = summary;
    weatherMap[game.away] = summary;
  }

  return weatherMap;
}
