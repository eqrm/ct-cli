import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The session cache lives in the macOS Keychain (never a file — see sessionStore.ts).
// Mock the platform and the `security` spawn so we can model what is stored.
const execFileMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn(() => "darwin"));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:os", () => ({ platform: platformMock }));

import {
  readSession,
  storeSession,
  clearSession,
  tokenFingerprint,
  SESSION_MAX_AGE_MS,
} from "../src/auth/sessionStore.js";
import { clearCredentials, storeCredentials, resetKeychainCache } from "../src/auth/tokenStore.js";

const HOST = "https://mychurch.church.tools";
const OTHER = "https://other.church.tools";

let store: Map<string, string>;

/** Model a keychain as account → stored blob; wire the `security` CLI mock to read/write it. */
function mockKeychain(): void {
  execFileMock.mockImplementation((_cmd: string, args: string[], cb: (e: unknown, v: unknown) => void) => {
    const sub = args[0];
    const account = args[args.indexOf("-a") + 1]!;
    if (sub === "find-generic-password") {
      const val = store.get(account);
      if (val === undefined) return cb(new Error("not found"), null);
      return cb(null, { stdout: val, stderr: "" });
    }
    if (sub === "add-generic-password") {
      store.set(account, args[args.indexOf("-w") + 1]!);
      return cb(null, { stdout: "", stderr: "" });
    }
    if (sub === "delete-generic-password") {
      store.delete(account);
      return cb(null, { stdout: "", stderr: "" });
    }
    return cb(new Error(`unexpected security subcommand ${sub}`), null);
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  platformMock.mockReturnValue("darwin");
  store = new Map();
  mockKeychain();
  resetKeychainCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session store (#145)", () => {
  it("round-trips a session for a host", async () => {
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    expect(await readSession(HOST, "tok")).toMatchObject({
      host: HOST,
      cookie: "ct=abc",
      csrfToken: "csrf",
    });
  });

  it("keeps the session under its own account, not the credential account", async () => {
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    expect([...store.keys()]).toEqual([`session:${HOST}`]);
    expect(store.has(HOST)).toBe(false);
    expect(store.has("credentials")).toBe(false);
  });

  it("stores only a hash of the login token, never the token itself", async () => {
    await storeSession(HOST, "s3cret-token", { cookie: "ct=abc", csrfToken: "csrf" });
    const blob = store.get(`session:${HOST}`)!;
    expect(blob).not.toContain("s3cret-token");
    expect(blob).toContain(tokenFingerprint("s3cret-token"));
  });

  it("never returns host A's session for host B (#30)", async () => {
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    expect(await readSession(OTHER, "tok")).toBeNull();
  });

  it("refuses a blob whose stored host does not match the requested one", async () => {
    // A tampered / mis-keyed entry: right account, wrong host inside.
    store.set(
      `session:${HOST}`,
      JSON.stringify({
        host: OTHER,
        cookie: "ct=abc",
        csrfToken: "csrf",
        obtainedAt: Date.now(),
        tokenHash: tokenFingerprint("tok"),
      }),
    );
    expect(await readSession(HOST, "tok")).toBeNull();
  });

  it("does not reuse a session bought with a different token", async () => {
    await storeSession(HOST, "tok-a", { cookie: "ct=abc", csrfToken: "csrf" });
    expect(await readSession(HOST, "tok-b")).toBeNull();
    expect(await readSession(HOST, "tok-a")).not.toBeNull();
  });

  it("ages a session out, and rejects one timestamped in the future", async () => {
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_MAX_AGE_MS + 1000);
    expect(await readSession(HOST, "tok")).toBeNull();

    vi.setSystemTime(Date.now() - 2 * SESSION_MAX_AGE_MS); // clock moved backwards
    expect(await readSession(HOST, "tok")).toBeNull();
  });

  it("treats a corrupt blob as no session rather than throwing", async () => {
    store.set(`session:${HOST}`, "not json at all");
    expect(await readSession(HOST, "tok")).toBeNull();
  });

  it("stores nothing and reads nothing on a platform without a keychain", async () => {
    platformMock.mockReturnValue("linux");
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    expect(store.size).toBe(0); // no plaintext cookie on disk anywhere
    expect(await readSession(HOST, "tok")).toBeNull();
  });

  it("clearSession removes only that host's session", async () => {
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    await storeSession(OTHER, "tok", { cookie: "ct=xyz", csrfToken: "csrf" });
    await clearSession(HOST);
    expect(await readSession(HOST, "tok")).toBeNull();
    expect(await readSession(OTHER, "tok")).not.toBeNull();
  });
});

describe("logout clears the cached session along with the token", () => {
  it("`ct auth logout` (no --env) drops the default host's session", async () => {
    await storeCredentials({ host: HOST, token: "tok" });
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });

    await clearCredentials();

    expect(await readSession(HOST, "tok")).toBeNull();
    expect(store.has(HOST)).toBe(false);
  });

  it("`ct auth logout --env <name>` drops that host's session and leaves the others", async () => {
    await storeCredentials({ host: HOST, token: "tok" });
    await storeCredentials({ host: OTHER, token: "tok2" });
    await storeSession(HOST, "tok", { cookie: "ct=abc", csrfToken: "csrf" });
    await storeSession(OTHER, "tok2", { cookie: "ct=xyz", csrfToken: "csrf" });

    await clearCredentials(HOST);

    expect(await readSession(HOST, "tok")).toBeNull();
    expect(await readSession(OTHER, "tok2")).not.toBeNull();
  });
});
