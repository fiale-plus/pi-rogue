import { measurePiDedicatedModes } from "./measurement.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  requireEnv("PORTKEY_BASE_URL");
  requireEnv("PORTKEY_API_KEY");

  const report = await measurePiDedicatedModes({
    env: process.env,
    profile: process.env.PI_ROGUE_PROFILE?.trim() || "local-smart",
    role: process.env.PI_ROGUE_ROLE?.trim() || "smart",
    request: {
      profile: process.env.PI_ROGUE_REQUEST_PROFILE?.trim() || "local-first-economy",
      taskKind: process.env.PI_ROGUE_TASK_KIND?.trim() || "manual_portkey_measurement",
      rawInputTokensApprox: Number(process.env.RAW_INPUT_TOKENS ?? 82_000),
      forwardedInputTokensApprox: Number(process.env.FORWARDED_INPUT_TOKENS ?? 2_400),
      expectedOutputTokensApprox: Number(process.env.EXPECTED_OUTPUT_TOKENS ?? 900),
      contextPolicy: process.env.PI_ROGUE_CONTEXT_POLICY?.trim() || "typed_lens",
      candidateAssets: ["local.qwen35", "remote.cheap", "remote.premium", "subscription.smart"],
    },
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
