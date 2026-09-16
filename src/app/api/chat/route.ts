import {
  coordinatorAgent,
  rosterAnalyst,
  waiverScout,
  tradeAnalyst,
} from "@/lib/agents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AGENTS: Record<string, { agent: { generate: (opts: { prompt: string }) => Promise<any> }; prompt: string }> = {
  coordinator: {
    agent: coordinatorAgent,
    prompt: "Analyze my roster and deliver this week's full game plan: lineup, waivers, and trades.",
  },
  lineup: {
    agent: rosterAnalyst,
    prompt: "Analyze my current roster and recommend the optimal lineup for this week. Flag any injury or weather risks with contingency plans.",
  },
  waivers: {
    agent: waiverScout,
    prompt: "Scout the waiver wire. Find the best available pickups in my league and identify trending adds worth targeting.",
  },
  trades: {
    agent: tradeAnalyst,
    prompt: "Find 1-2 realistic trade opportunities to improve my roster. Check who owns the players and make sure the values are fair.",
  },
};

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode = body.mode || "simple";
  const userMessage = body.message;

  const config = AGENTS[mode];
  if (!config) {
    return Response.json({ error: `Unknown mode: ${mode}` }, { status: 400 });
  }

  try {
    const startTime = Date.now();
    const { text, steps } = await config.agent.generate({
      prompt: userMessage || config.prompt,
    });
    const elapsed = Date.now() - startTime;

    console.log(`[${mode}] Done in ${elapsed}ms, ${steps.length} steps`);
    for (const [i, step] of steps.entries()) {
      console.log(
        `  Step ${i}: ${step.toolCalls.length} tool calls, finishReason=${step.finishReason}`
      );
      for (const tc of step.toolCalls) {
        console.log(`    → ${tc.toolName}`);
      }
    }

    return Response.json({
      response: text,
      stepsUsed: steps.length,
      elapsedMs: elapsed,
      mode,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isRateLimit =
      message.includes("rate-limited") || message.includes("429");
    console.error(`[${mode}] Error:`, message.slice(0, 200));

    // Extract retry-after seconds from the error message if present
    let retryAfter: number | null = null;
    if (isRateLimit) {
      const retryMatch = message.match(/retry.?after[:\s]*(\d+)/i);
      if (retryMatch) retryAfter = parseInt(retryMatch[1], 10);
    }

    const retryMsg = retryAfter
      ? `Rate limited. Try again in ${retryAfter} seconds.`
      : "Rate limited by AI Gateway free tier. Try again in a couple minutes.";

    const headers: Record<string, string> = {};
    if (retryAfter) headers["Retry-After"] = String(retryAfter);

    return Response.json(
      {
        error: isRateLimit ? retryMsg : `Agent error: ${message.slice(0, 200)}`,
        retryAfter,
        mode,
      },
      { status: isRateLimit ? 429 : 500, headers }
    );
  }
}
