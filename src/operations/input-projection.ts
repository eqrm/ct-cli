import {
  getInputSnapshot,
  type GeneratedProcessConfig,
  type ProcessInputGenerator,
} from "../application/operations/input.js";
import { loadTrustedProcessGenerator } from "../server/generator.js";

export interface GeneratedInputSelection {
  digest: string;
  generator: ProcessInputGenerator;
  generated: GeneratedProcessConfig;
}

export async function generateSelectedInput(
  cwd: string,
  digest: string | undefined,
  generatorPath: string | undefined,
): Promise<GeneratedInputSelection | null> {
  if (!digest && !generatorPath) return null;
  if (!digest || !generatorPath) {
    throw new Error("--input-snapshot and --generator must be provided together.");
  }
  const generator = await loadTrustedProcessGenerator(generatorPath);
  const snapshot = (await getInputSnapshot(cwd, digest)).value;
  if (!generator.supportedSchemaVersions.includes(snapshot.schemaVersion)) {
    throw new Error(`Generator ${generator.id} does not support schema ${snapshot.schemaVersion}.`);
  }
  const validation = await generator.validate(snapshot);
  if (!validation.valid) {
    throw new Error(
      `Process input rejected by ${generator.id}: ${validation.errors
        .map((item) => `${item.path} ${item.message}`)
        .join(", ")}`,
    );
  }
  return { digest, generator, generated: await generator.generate(snapshot) };
}
