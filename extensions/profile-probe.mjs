import { writeFileSync } from "node:fs";

export default function profileProbe(pi) {
  pi.on("session_start", (_event, ctx) => {
    const output = process.env.PI_HARNESS_PROBE_OUTPUT;
    if (!output) {
      ctx.shutdown();
      throw new Error("PI_HARNESS_PROBE_OUTPUT is required by the doctor-only profile probe.");
    }
    const commands = pi
      .getCommands()
      .map((command) => command?.name)
      .filter((name) => typeof name === "string")
      .sort();
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          profile: process.env.PI_HARNESS_PROFILE,
          agentDir: process.env.PI_CODING_AGENT_DIR,
          tools: [...pi.getActiveTools()].sort(),
          commands,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    ctx.shutdown();
  });
}
