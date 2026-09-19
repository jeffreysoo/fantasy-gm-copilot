import { registerOTel } from "@vercel/otel";
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";

export function register() {
  console.log("[instrumentation] VERCEL_OTEL_ENDPOINTS:", process.env.VERCEL_OTEL_ENDPOINTS);
  registerOTel("fantasy-gm-copilot");
  registerTelemetry(new OpenTelemetry());
  console.log("[instrumentation] Done.");
}
