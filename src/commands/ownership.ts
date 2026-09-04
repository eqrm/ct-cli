import { Command } from "commander";
import { checkOwnership } from "../application/operations/ownership.js";
import { info, success, warn } from "../ui.js";

export function ownershipCommand(): Command {
  const command = new Command("ownership").description("Analyse ownership within an explicit directory tree");
  command
    .command("check")
    .description("Check managed/external ownership claims without contacting ChurchTools")
    .argument("<root>", "complete coordination-scope directory for this invocation")
    .requiredOption("-e, --env <name>", "environment name to inspect in every discovered ct project")
    .action(async (root: string, opts: { env: string }) => {
      const result = await checkOwnership({ root, environment: opts.env });
      info(
        `Inspected ${result.value.projects.length} ct project(s) across ${result.value.hosts.length} host(s) below ${result.value.root}.`,
      );
      for (const finding of result.value.findings) {
        const line = `[${finding.reason}] ${finding.message}`;
        if (finding.severity === "ok") success(line);
        else warn(line);
        finding.remediation?.forEach((step, index) => info(`  ${index + 1}. ${step}`));
      }
      info("Scope guarantee applies only below the explicit root; projects outside it remain unknowable.");
      if (result.value.conflicts > 0) process.exitCode = 1;
    });
  return command;
}
