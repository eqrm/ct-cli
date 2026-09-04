import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  createInputSnapshot,
  getInputSnapshot,
  listInputSnapshots,
  validateProcessInput,
  type ProcessInputDocument,
} from "../application/operations/input.js";
import { out } from "../ui.js";
import { loadTrustedProcessGenerator } from "../server/generator.js";

async function readDocument(path: string): Promise<ProcessInputDocument> {
  let raw: string;
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    raw = await readFile(path, "utf8");
  }
  return JSON.parse(raw) as ProcessInputDocument;
}

export function inputCommand(): Command {
  const command = new Command("input").description("Validate and store versioned process input snapshots");
  command
    .command("validate")
    .argument("<file>", "JSON input document, or - for stdin")
    .option("--generator <path>", "also validate with this trusted local generator module")
    .action(async (file: string, opts: { generator?: string }) => {
      const document = await readDocument(file);
      let result = validateProcessInput(document);
      if (result.valid && opts.generator) {
        const generator = await loadTrustedProcessGenerator(opts.generator);
        const generated = await generator.validate(document);
        result = { ...result, ...generated };
      }
      out(result);
      if (!result.valid) process.exitCode = 1;
    });
  command
    .command("snapshot")
    .argument("<file>", "JSON input document, or - for stdin")
    .option("--no-persist", "validate and digest without writing an immutable snapshot")
    .action(async (file: string, opts: { persist?: boolean }) => {
      out(await createInputSnapshot({ ...(await readDocument(file)), persist: opts.persist }));
    });
  command
    .command("list")
    .description("List immutable process input snapshots")
    .action(async () => out(await listInputSnapshots(process.cwd())));
  command
    .command("get")
    .argument("<digest>", "SHA-256 snapshot digest")
    .action(async (digest: string) => out(await getInputSnapshot(process.cwd(), digest)));
  return command;
}
