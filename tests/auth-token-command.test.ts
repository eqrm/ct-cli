/**
 * `ct auth token` — a credential helper for the OpenTofu provider (#179).
 *
 * The provider declares `token` as required, so the tier-0 cutover meant writing a personal
 * ChurchTools login token to local disk: permanent, unscopable, and an admin credential on prod.
 * What this command emits instead is the SESSION that token buys — the one credential in the system
 * that expires and can be revoked (`ct auth logout`), so a copy that leaks into a `tofu` debug log
 * dies in hours rather than never.
 *
 * The contract under test is the one a `credential_process`-style consumer depends on:
 * the credential on stdout and NOTHING else there, everything human on stderr, and an empty stdout
 * plus a non-zero exit when nothing resolves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as TokenStore from "../src/auth/tokenStore.js";

const authedSession = vi.fn();
const LOGIN_TOKEN = "permanent-login-token-xyz";
const readToken = vi.fn(async () => LOGIN_TOKEN);
vi.mock("../src/api/session.js", () => ({ authedSession }));
vi.mock("../src/auth/tokenStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TokenStore>()),
  readToken,
}));

const { authCommand } = await import("../src/commands/auth.js");

const HOST = "https://mychurch.church.tools";
const originalHost = process.env.CT_HOST;
let stdout: string[];
let stderr: string[];

function session(overrides: Partial<{ cookie: string; source: "cache" | "handshake" }> = {}): void {
  authedSession.mockResolvedValue({
    me: { id: 1 },
    client: {
      sessionCredential: () => ({
        cookie: overrides.cookie ?? "ChurchTools_mychurch=abc",
        csrfToken: "csrf-1",
        obtainedAt: Date.parse("2026-09-21T00:00:00.000Z"),
        source: overrides.source ?? "cache",
      }),
    },
  });
}

async function run(args: string[]): Promise<void> {
  await authCommand().parseAsync(["token", ...args], { from: "user" });
}

beforeEach(() => {
  process.env.CT_HOST = HOST;
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  // A terminal is refused on purpose; every test below is the piped case unless it says otherwise.
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  process.exitCode = 0;
  readToken.mockResolvedValue(LOGIN_TOKEN);
  session();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
});

describe("ct auth token", () => {
  it("puts the session on stdout and nothing else there", async () => {
    await run([]);
    expect(stdout).toHaveLength(1);
    const payload = JSON.parse(stdout[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      host: HOST,
      cookie: "ChurchTools_mychurch=abc",
      csrfToken: "csrf-1",
      source: "cache",
    });
    // The reuse ceiling, so a consumer can cache it rather than call ct on every single request.
    expect(payload.expiresAt).toBe("2026-09-21T12:00:00.000Z");
    // The permanent credential is never part of the answer.
    expect(stdout[0]).not.toContain(LOGIN_TOKEN);
  });

  it("emits the bare cookie under --raw, so command substitution is safe", async () => {
    await run(["--raw"]);
    expect(stdout).toEqual(["ChurchTools_mychurch=abc\n"]);
    // Progress belongs on stderr: `$(ct auth token --raw)` must capture the credential alone.
    expect(stderr.join("")).toContain(HOST);
    expect(stderr.join("")).not.toContain("ChurchTools_mychurch=abc");
  });

  it("writes nothing to stdout and exits non-zero when no credential resolves", async () => {
    readToken.mockResolvedValue(null as never);
    await run([]);
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(1);
    // The remedy, not just the refusal — this is the case a helper hits most often.
    expect(stderr.join("")).toMatch(/ct auth login/);
  });

  it("refuses a terminal, where the credential would stay in the scrollback", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    await run([]);
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toMatch(/Refusing to print a credential to a terminal/);
  });

  it("prints to a terminal when explicitly asked", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    await run(["--allow-tty", "--raw"]);
    expect(stdout).toEqual(["ChurchTools_mychurch=abc\n"]);
    expect(process.exitCode).toBe(0);
  });

  it("says whether a login handshake was spent", async () => {
    session({ source: "handshake" });
    await run(["--raw"]);
    expect(stderr.join("")).toMatch(/fresh login handshake/);
  });
});

/**
 * The envelope is read by `data "external"` (terraform-provider-churchtools), which requires EVERY
 * value in the JSON object to be a string. A single `null` fails inside the external provider with
 * a message about JSON types that names neither this command nor the field — so the one credential
 * helper in the system breaks in the least diagnosable way available.
 */
describe('ct auth token — an envelope `data "external"` can consume', () => {
  it("reports no environment as an empty string, never null", async () => {
    await run([]);
    const parsed = JSON.parse(stdout[0]!) as Record<string, unknown>;
    expect(parsed.environment).toBe("");
  });

  it("emits an object whose values are all strings", async () => {
    await run([]);
    const parsed = JSON.parse(stdout[0]!) as Record<string, unknown>;
    const nonStrings = Object.entries(parsed).filter(([, value]) => typeof value !== "string");
    expect(nonStrings).toEqual([]);
  });
});
