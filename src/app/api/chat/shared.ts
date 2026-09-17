export async function runAgent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: { generate: (opts: { prompt: string }) => Promise<any> },
  mode: string,
  prompt: string,
  userMessage?: string
) {
  try {
    const startTime = Date.now();
    const { text, steps } = await agent.generate({
      prompt: userMessage || prompt,
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
