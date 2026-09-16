// FantasyCalc API — free, no auth
// Trade values derived from millions of real fantasy trades

const FANTASYCALC_BASE = "https://api.fantasycalc.com/values/current";

export interface TradeValue {
  name: string;
  position: string;
  team: string;
  value: number;
  overallRank: number;
  positionRank: number;
}

let cachedValues: TradeValue[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function getTradeValues(
  options: { numTeams?: number; ppr?: number; numQbs?: number } = {}
): Promise<TradeValue[]> {
  const now = Date.now();
  if (cachedValues && now - cacheTimestamp < CACHE_TTL) {
    return cachedValues;
  }

  const { numTeams = 8, ppr = 1, numQbs = 1 } = options;
  const res = await fetch(
    `${FANTASYCALC_BASE}?isDynasty=false&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`
  );
  if (!res.ok) throw new Error(`FantasyCalc API: ${res.status}`);

  const data = await res.json();
  cachedValues = data.map(
    (entry: Record<string, unknown>, i: number) => {
      const player = entry.player as Record<string, unknown>;
      return {
        name: player?.name || "Unknown",
        position: player?.position || "?",
        team: player?.maybeTeam || player?.team || "FA",
        value: entry.value as number,
        overallRank: i + 1,
        positionRank: entry.positionRank as number,
      };
    }
  );
  cacheTimestamp = now;
  return cachedValues!;
}

export async function getPlayerTradeValue(
  playerName: string,
  options?: { numTeams?: number; ppr?: number; numQbs?: number }
): Promise<TradeValue | null> {
  const values = await getTradeValues(options);
  const normalized = playerName.toLowerCase();
  return (
    values.find((v) => v.name.toLowerCase().includes(normalized)) || null
  );
}
