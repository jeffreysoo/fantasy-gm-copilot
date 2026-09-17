import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel("fantasy-gm-copilot");
}
