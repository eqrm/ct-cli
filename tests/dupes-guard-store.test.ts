import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeErrorText } from "../src/commands/dupes.js";
import { CtApiError } from "../src/api/ctClient.js";
import { agentMarkers, assertHumanSession, needsGuard, type GuardInput } from "../src/dupes/guard.js";
import { makeRedactor } from "../src/dupes/redact.js";
import { DupesStore, hostSlug } from "../src/dupes/store.js";

const prod = { protected: true } as const;
const dev = { protected: false } as const;
const human = (over: Partial<GuardInput> = {}): GuardInput => ({
  profile: prod,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  env: {},
  ancestors: () => ["zsh", "login"],
  ...over,
});

describe("personal-data guard", () => {
  it("lets a human at a terminal through", () => {
    expect(() => assertHumanSession(human())).not.toThrow();
  });

  it.each([
    ["stdin is not a TTY", { stdinIsTTY: false }],
    ["stdout is not a TTY", { stdoutIsTTY: false }],
    ["CLAUDECODE is set", { env: { CLAUDECODE: "1" } }],
    ["a CLAUDE_CODE_ variable is set", { env: { CLAUDE_CODE_ENTRYPOINT: "cli" } }],
    ["AI_AGENT is set", { env: { AI_AGENT: "claude" } }],
    ["an ancestor process is the agent CLI", { ancestors: () => ["zsh", "claude"] }],
  ])("refuses a protected env when %s", (_name, over) => {
    expect(() => assertHumanSession(human(over as Partial<GuardInput>))).toThrow(
      "This command is not available in this session.",
    );
  });

  it("refuses with a neutral message that names no marker", () => {
    try {
      assertHumanSession(human({ env: { CLAUDECODE: "1" } }));
    } catch (e) {
      expect((e as Error).message).not.toMatch(/claude|agent|tty/i);
    }
  });

  it("treats no --env and read-only gateway envs as protected", () => {
    expect(needsGuard(null)).toBe(true);
    expect(needsGuard({ protected: false, gateway: { url: "https://x", region: "r", profile: "p" } })).toBe(
      true,
    );
    expect(() => assertHumanSession(human({ profile: null, stdinIsTTY: false }))).toThrow();
  });

  it("leaves an explicitly unprotected env alone", () => {
    expect(() =>
      assertHumanSession(human({ profile: dev, stdinIsTTY: false, env: { CLAUDECODE: "1" } })),
    ).not.toThrow();
  });

  it("detects agent markers in the environment", () => {
    expect(agentMarkers({ CLAUDECODE: "1", PATH: "/bin" })).toEqual(["CLAUDECODE"]);
  });
});

describe("redaction", () => {
  const r = makeRedactor(true, "secret");
  it("gives stable pseudonyms that hide the value", () => {
    expect(r.id(4711)).toBe(r.id(4711));
    expect(r.id(4711)).not.toContain("4711");
    expect(r.value("Erika")).toBe(r.value("Erika"));
    expect(r.value("Erika")).not.toBe(r.value("Anna"));
    expect(r.value("Erika")).not.toContain("Erika");
    expect(r.value("")).toBe("");
  });
  it("is keyed: another secret gives other pseudonyms", () => {
    expect(makeRedactor(true, "other").id(1)).not.toBe(r.id(1));
  });
  it("passes values through when disabled", () => {
    const off = makeRedactor(false, "");
    expect(off.id(7)).toBe("7");
    expect(off.value("Erika")).toBe("Erika");
  });
  it("masks digit runs in error text", () => {
    expect(r.text("failed for 4711")).toBe("failed for #");
  });
});

describe("error text", () => {
  it("never echoes a response body or request path", () => {
    const err = new CtApiError("GET /persons/4711 failed", 500, { message: "Erika Muster" });
    const text = safeErrorText(err, makeRedactor(false, ""));
    expect(text).toBe("ChurchTools request failed (HTTP 500).");
  });
});

describe("local store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const env = (): NodeJS.ProcessEnv => {
    const d = mkdtempSync(join(tmpdir(), "ct-dupes-"));
    dirs.push(d);
    return { CT_DUPES_DIR: d };
  };

  it("slugs hosts", () => {
    expect(hostSlug("https://Example.church.tools/")).toBe("example-church-tools");
  });

  it("writes dirs 0700 and files 0600", () => {
    const store = new DupesStore("https://example.church.tools", env());
    store.audit({ action: "x" });
    store.redactSecret();
    const path = store.writeExport("a.csv", "x");
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.exportDir).mode & 0o777).toBe(0o700);
    expect(statSync(store.auditPath).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.readAudit()[0]).toMatchObject({ action: "x" });
  });

  it("refuses to live inside a git work tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "ct-dupes-repo-"));
    dirs.push(repo);
    // `.git` as a plain directory is enough for the check.
    mkdirSync(join(repo, ".git"));
    expect(() => new DupesStore("https://example.church.tools", { CT_DUPES_DIR: join(repo, "x") })).toThrow(
      /repository/,
    );
  });

  it("uses Application Support on macOS and XDG elsewhere", () => {
    const mac = new DupesStore("https://a.example", {}, "darwin");
    expect(mac.dir).toContain(join("Library", "Application Support", "ct-cli", "dupes", "a-example"));
    const lin = new DupesStore("https://a.example", { XDG_DATA_HOME: "/tmp/xdg-test" }, "linux");
    expect(lin.dir).toBe(join("/tmp/xdg-test", "ct-cli", "dupes", "a-example"));
  });
});
