import { waiverScout } from "@/lib/agents";
import { runAgent } from "../shared";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return runAgent(
    waiverScout,
    "waivers",
    "Scout the waiver wire. Find the best available pickups in my league and identify trending adds worth targeting.",
    body.message
  );
}
