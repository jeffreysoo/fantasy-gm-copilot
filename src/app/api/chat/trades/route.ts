import { tradeAnalyst } from "@/lib/agents";
import { runAgent } from "../shared";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return runAgent(
    tradeAnalyst,
    "trades",
    "Find 1-2 realistic trade opportunities to improve my roster. Check who owns the players and make sure the values are fair.",
    body.message
  );
}
