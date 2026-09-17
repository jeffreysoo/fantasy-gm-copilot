import { rosterAnalyst } from "@/lib/agents";
import { runAgent } from "../shared";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return runAgent(
    rosterAnalyst,
    "lineup",
    "Analyze my current roster and recommend the optimal lineup for this week. Flag any injury or weather risks with contingency plans.",
    body.message
  );
}
