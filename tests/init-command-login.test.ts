import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginError } from "../src/auth/login.js";
import type * as LoginModule from "../src/auth/login.js";
import type * as TokenStoreModule from "../src/auth/tokenStore.js";

const bootstrapLoginToken = vi.fn();

vi.mock("../src/auth/login.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LoginModule>()),
  bootstrapLoginToken: (...args: unknown[]) => bootstrapLoginToken(...args),
}));
vi.mock("../src/auth/tokenStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TokenStoreModule>()),
  isSecureStorageAvailable: () => true,
}));

const { initCommand } = await import("../src/commands/init.js");

const directories: string[] = [];
let stderr = "";
let isTTY: boolean | undefined;

beforeEach(async () => {
  stderr = "";
  isTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  bootstrapLoginToken.mockReset();
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ct-init-login-"));
  directories.push(directory);
  return directory;
}

describe("ct init login bootstrap (#131)", () => {
  it("keeps the scaffold and reports when the guided login fails", async () => {
    const directory = await temporaryDirectory();
    bootstrapLoginToken.mockRejectedValue(new LoginError("No password given.", 0));

    await initCommand().parseAsync(
      [directory, "--host", "https://example.church.tools", "--env", "prod", "--no-git"],
      {
        from: "user",
      },
    );

    // The scaffold is written and stays written: re-running `ct init` here
    // would only hit "refusing to overwrite existing ct.config.ts".
    expect(await readFile(join(directory, "ct.config.ts"), "utf8")).toContain("export default");
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr).toContain("No password given.");
    expect(stderr).toContain("ct auth login --host https://example.church.tools");
  });

  it("falls through to the login hint when the user skips the guided login", async () => {
    const directory = await temporaryDirectory();
    bootstrapLoginToken.mockResolvedValue({ kind: "skipped", hint: "ct auth login" });

    await initCommand().parseAsync(
      [directory, "--host", "https://example.church.tools", "--env", "prod", "--no-git"],
      {
        from: "user",
      },
    );

    expect(stderr).toContain("ct auth login --host https://example.church.tools");
  });
});
