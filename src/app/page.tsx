"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";

type Mode = "coordinator" | "lineup" | "waivers" | "trades";

interface RosterPlayer {
  player_id: string;
  name: string;
  position: string;
  team: string;
  matchup: string;
  injury_status: string | null;
  weather: string | null;
  starter: boolean;
  thumbnail: string;
}

interface RosterData {
  league_name: string;
  season: string;
  week: number;
  record: string;
  players: RosterPlayer[];
}

const ACTIONS: { mode: Mode; label: string; description: string }[] = [
  {
    mode: "lineup",
    label: "Check My Lineup",
    description: "Roster analysis, opponent matchup, projections, start/sit",
  },
  {
    mode: "waivers",
    label: "Scout Waivers",
    description: "Trending adds, best available free agents by position",
  },
  {
    mode: "trades",
    label: "Find a Trade",
    description: "Trade values, ownership check, specific offers",
  },
  {
    mode: "coordinator",
    label: "Full Game Plan",
    description: "All three agents — lineup, waivers, and trades combined",
  },
];

const POS_COLORS: Record<string, string> = {
  QB: "bg-red-500",
  RB: "bg-green-500",
  WR: "bg-blue-500",
  TE: "bg-orange-500",
  K: "bg-purple-500",
  DEF: "bg-zinc-500",
};

const INJURY_COLORS: Record<string, string> = {
  Out: "text-red-400",
  Doubtful: "text-red-400",
  Questionable: "text-yellow-400",
  Probable: "text-green-400",
  IR: "text-red-400",
};

// Custom markdown components styled to match Sleeper's UI
const markdownComponents: Components = {
  h1: ({ children }: { children?: ReactNode }) => (
    <div className="text-base font-bold text-white mb-3 pb-2 border-b border-zinc-700/50">
      {children}
    </div>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-5 mb-2">
      {children}
    </div>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <div className="text-sm font-semibold text-zinc-300 mt-3 mb-1">
      {children}
    </div>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-[13px] text-zinc-300 leading-relaxed mb-2">
      {children}
    </p>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <span className="font-semibold text-white">{children}</span>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <div className="flex flex-col gap-1 mb-3">{children}</div>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <div className="flex flex-col gap-1.5 mb-3">{children}</div>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <div className="flex gap-2 items-start rounded-lg bg-zinc-800/40 px-3 py-2">
      <span className="text-blue-400 mt-0.5 text-xs shrink-0">&#9654;</span>
      <span className="text-[13px] text-zinc-300 leading-snug">{children}</span>
    </div>
  ),
  hr: () => <div className="border-t border-zinc-800 my-4" />,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto mb-3 rounded-lg border border-zinc-800">
      <table className="w-full text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="bg-zinc-800/80 text-zinc-400 text-left">{children}</thead>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-3 py-1.5 font-medium">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-3 py-1.5 text-zinc-300 border-t border-zinc-800/50">
      {children}
    </td>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <div className="border-l-2 border-blue-500 pl-3 py-1 mb-2 bg-blue-500/5 rounded-r-lg">
      {children}
    </div>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <span className="text-blue-400 bg-blue-500/10 px-1 py-0.5 rounded text-[12px] font-mono">
      {children}
    </span>
  ),
};

function PlayerCard({
  player,
  compact,
}: {
  player: RosterPlayer;
  compact?: boolean;
}) {
  const posColor = POS_COLORS[player.position] || "bg-zinc-600";
  const injuryColor = player.injury_status
    ? INJURY_COLORS[player.injury_status] || "text-yellow-400"
    : "";

  return (
    <div
      className={`flex items-center gap-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 transition-colors ${compact ? "p-1.5" : "p-2"}`}
    >
      <img
        src={player.thumbnail}
        alt={player.name}
        className={`rounded-full bg-zinc-700 object-cover ${compact ? "w-8 h-8" : "w-10 h-10"}`}
        onError={(e) => {
          (e.target as HTMLImageElement).src =
            "https://sleepercdn.com/images/v2/icons/player_default.webp";
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${posColor} text-white`}
          >
            {player.position}
          </span>
          <span
            className={`font-medium truncate ${compact ? "text-xs" : "text-sm"}`}
          >
            {player.name}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-xs text-zinc-400">{player.team}</span>
          <span className="text-xs text-zinc-500">{player.matchup}</span>
          {player.injury_status && (
            <span className={`text-[10px] font-medium ${injuryColor}`}>
              {player.injury_status}
            </span>
          )}
          {player.weather && (
            <span className="text-[10px] font-medium text-cyan-400">
              {player.weather}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Full roster view for lineup analysis — starters and bench with labels */
function InlineRoster({ roster }: { roster: RosterData }) {
  const starters = roster.players.filter((p) => p.starter);
  const bench = roster.players.filter((p) => !p.starter);

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-sm font-bold text-white">
          Week {roster.week}
        </span>
        <span className="text-xs text-zinc-500">
          {roster.league_name} &middot; {roster.record}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-3">
        {starters.map((p) => (
          <PlayerCard key={p.player_id} player={p} />
        ))}
      </div>
      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide mb-1.5">
        Bench
      </div>
      <div className="grid grid-cols-2 gap-1">
        {bench.map((p) => (
          <PlayerCard key={p.player_id} player={p} compact />
        ))}
      </div>
    </div>
  );
}

/** Compact roster strip for waivers/trades — just names so the user has context */
function RosterStrip({ roster }: { roster: RosterData }) {
  const starters = roster.players.filter((p) => p.starter);
  const bench = roster.players.filter((p) => !p.starter);

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs font-bold text-white">
          Your Roster — Week {roster.week}
        </span>
        <span className="text-[10px] text-zinc-500">
          {roster.league_name} &middot; {roster.record}
        </span>
      </div>
      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide mb-1">
        Starters
      </div>
      <div className="grid grid-cols-3 gap-1 mb-2">
        {starters.map((p) => (
          <PlayerCard key={p.player_id} player={p} compact />
        ))}
      </div>
      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide mb-1">
        Bench
      </div>
      <div className="grid grid-cols-3 gap-1">
        {bench.map((p) => (
          <PlayerCard key={p.player_id} player={p} compact />
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const [response, setResponse] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    steps: number;
    elapsed: number;
    mode: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeMode, setActiveMode] = useState<Mode | null>(null);
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRoster = useCallback(() => {
    setRosterLoading(true);
    fetch("/api/roster")
      .then((r) => r.json())
      .then((data) => {
        if (!data.error) setRoster(data);
      })
      .catch(() => {})
      .finally(() => setRosterLoading(false));
  }, []);

  useEffect(() => {
    fetchRoster();
  }, [fetchRoster]);

  // Clean up countdown on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  function startCountdown(seconds: number) {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setRetryCountdown(seconds);
    countdownRef.current = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev === null || prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          countdownRef.current = null;
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function runAgent(mode: Mode, message?: string) {
    setLoading(true);
    setActiveMode(mode);
    setResponse(null);
    setMeta(null);
    setRetryCountdown(null);
    if (countdownRef.current) clearInterval(countdownRef.current);
    // Refresh roster in parallel with agent call so tiles are fresh
    fetchRoster();
    try {
      const res = await fetch(`/api/chat/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message ? { message } : {}),
      });
      const data = await res.json();

      if (res.status === 429) {
        const retryAfter =
          data.retryAfter ||
          parseInt(res.headers.get("Retry-After") || "", 10) ||
          120;
        startCountdown(retryAfter);
      }

      setResponse(data.response || data.error);
      if (data.stepsUsed) {
        setMeta({
          steps: data.stepsUsed,
          elapsed: data.elapsedMs,
          mode: data.mode,
        });
      }
    } catch (err) {
      setResponse(`Error: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  const MODE_TITLES: Record<string, string> = {
    lineup: "Lineup Analysis",
    waivers: "Waiver Report",
    trades: "Trade Finder",
    coordinator: "Game Plan",
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6 pt-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Fantasy GM Copilot</h1>
        <p className="text-zinc-400 text-sm mb-8">
          AI agent for Sleeper fantasy leagues
        </p>

        <div className="grid grid-cols-2 gap-2 mb-6">
          {ACTIONS.map(({ mode, label, description }) => (
            <button
              key={mode}
              onClick={() => runAgent(mode)}
              disabled={loading}
              className={`text-left p-3 rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                activeMode === mode && loading
                  ? "border-blue-500 bg-blue-950"
                  : activeMode === mode && response
                    ? "border-blue-500/50 bg-zinc-900"
                    : "border-zinc-800 bg-zinc-900 hover:border-zinc-600 hover:bg-zinc-800"
              }`}
            >
              <div className="font-medium text-sm">{label}</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                {description}
              </div>
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-zinc-400 mb-4">
            <div className="w-4 h-4 border-2 border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
            Running {activeMode} agent...
          </div>
        )}

        {retryCountdown !== null && (
          <div className="flex items-center gap-3 mb-4 px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <span className="text-yellow-400 text-sm">Rate limited</span>
            <span className="text-yellow-300 text-sm font-mono">
              {Math.floor(retryCountdown / 60)}:{String(retryCountdown % 60).padStart(2, "0")}
            </span>
            <button
              onClick={() => activeMode && runAgent(activeMode)}
              disabled={loading || retryCountdown > 0}
              className="ml-auto text-xs text-yellow-400 hover:text-yellow-300 disabled:opacity-30"
            >
              Retry
            </button>
          </div>
        )}

        {meta && (
          <div className="flex gap-3 text-xs text-zinc-500 mb-3">
            <span>{meta.mode}</span>
            <span>{meta.steps} steps</span>
            <span>{(meta.elapsed / 1000).toFixed(1)}s</span>
          </div>
        )}

        {response && !retryCountdown && (
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
            <div className="px-4 py-2.5 bg-zinc-800/50 border-b border-zinc-800">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                {MODE_TITLES[activeMode || "simple"] || "Analysis"}
              </span>
            </div>
            <div className="p-4">
              {/* Roster tiles — full for lineup, compact for waivers/trades/coordinator */}
              {roster &&
                !rosterLoading &&
                (activeMode === "lineup" ? (
                  <InlineRoster roster={roster} />
                ) : activeMode === "waivers" ||
                  activeMode === "trades" ||
                  activeMode === "coordinator" ? (
                  <RosterStrip roster={roster} />
                ) : null)}
              <Markdown components={markdownComponents}>{response}</Markdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
