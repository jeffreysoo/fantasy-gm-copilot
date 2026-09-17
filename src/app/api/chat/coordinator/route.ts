import { coordinatorAgent } from "@/lib/agents";
import { runAgent } from "../shared";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return runAgent(
    coordinatorAgent,
    "coordinator",
    "Analyze my roster and deliver this week's full game plan: lineup, waivers, and trades.",
    body.message
  );
}
