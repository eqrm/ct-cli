import { describe, it, expect } from "vitest";
import {
  checkEnvAuth,
  checkAllEnvAuth,
  renderEnvAuth,
  allEnvsAuthenticated,
  describeIdentity,
  type StatusDeps,
} from "../src/auth/status.js";
import type { EnvProfile } from "../src/env/envs.js";
import { CtApiError } from "../src/api/ctClient.js";

const dev: EnvProfile = {
  name: "dev",
  host: "https://mychurch-dev.church.tools",
  statePath: "ct-state.dev.json",
  protected: false,
};
const prod: EnvProfile = {
  name: "prod",
  host: "https://mychurch.church.tools",
  statePath: "ct-state.prod.json",
  protected: true,
  tokenEnv: "CT_PROD_TOKEN",
};

const ME = { id: 42, firstName: "Ada", lastName: "Lovelace" };

/** Deps with nothing stored, nothing in the environment, and a whoami that must not be called. */
function deps(overrides: StatusDeps = {}): StatusDeps {
  return {
    env: {},
    readStored: async () => null,
    readDefaultHost: async () => null,
    whoami: async () => {
      throw new Error("whoami should not be called without a token");
    },
    ...overrides,
  };
}

describe("checkEnvAuth token resolution (#117)", () => {
  it("reports no token when neither the environment nor the Keychain has one", async () => {
    const status = await checkEnvAuth(dev, deps());
    expect(status).toEqual({ name: "dev", host: dev.host, source: { kind: "none" } });
  });

  it("uses the host-keyed stored credentials", async () => {
    const seen: string[] = [];
    const status = await checkEnvAuth(
      dev,
      deps({
        readStored: async (host) => {
          seen.push(host);
          return { host, token: "stored-token" };
        },
        whoami: async (host, token) => {
          expect(host).toBe(dev.host);
          expect(token).toBe("stored-token");
          return ME;
        },
      }),
    );
    // The token is looked up for THIS env's host — never the default login's.
    expect(seen).toEqual([dev.host]);
    expect(status.source).toEqual({ kind: "stored" });
    expect(status.identity).toEqual(ME);
  });

  it("prefers the profile's tokenEnv over the Keychain (the CI path)", async () => {
    const status = await checkEnvAuth(
      prod,
      deps({
        env: { CT_PROD_TOKEN: "ci-token" },
        readStored: async () => ({ host: prod.host, token: "stored-token" }),
        whoami: async (_host, token) => {
          expect(token).toBe("ci-token");
          return ME;
        },
      }),
    );
    expect(status.source).toEqual({ kind: "env", variable: "CT_PROD_TOKEN" });
  });

  it("falls back to CT_LOGINTOKEN for the host that token is bound to (CT_HOST)", async () => {
    const status = await checkEnvAuth(
      prod,
      deps({
        env: { CT_LOGINTOKEN: "ambient", CT_HOST: `${prod.host}/` },
        whoami: async (host, token) => {
          expect(host).toBe(prod.host);
          expect(token).toBe("ambient");
          return ME;
        },
      }),
    );
    expect(status.source).toEqual({ kind: "env", variable: "CT_LOGINTOKEN" });
  });

  it("falls back to CT_LOGINTOKEN for the stored default login's host", async () => {
    const status = await checkEnvAuth(
      prod,
      deps({
        env: { CT_LOGINTOKEN: "ambient" },
        readDefaultHost: async () => prod.host,
        whoami: async (_host, token) => {
          expect(token).toBe("ambient");
          return ME;
        },
      }),
    );
    expect(status.source).toEqual({ kind: "env", variable: "CT_LOGINTOKEN" });
  });

  it("never sends an ambient CT_LOGINTOKEN to a host it is not bound to", async () => {
    // `--all` walks every host in ct.envs.json; fanning one instance's token out to
    // all of them would post it — as a login_token= query param — into every other
    // instance's access log, and report a green line for an unconfigured env.
    const status = await checkEnvAuth(
      dev,
      deps({
        env: { CT_LOGINTOKEN: "prod-token" },
        readDefaultHost: async () => prod.host,
      }),
    );
    expect(status.source).toEqual({ kind: "none" });
    expect(status.identity).toBeUndefined();
  });

  it("still prefers a profile tokenEnv naming CT_LOGINTOKEN, whatever the default host", async () => {
    const status = await checkEnvAuth(
      { ...dev, tokenEnv: "CT_LOGINTOKEN" },
      deps({
        env: { CT_LOGINTOKEN: "explicit" },
        readDefaultHost: async () => prod.host,
        whoami: async (_host, token) => {
          expect(token).toBe("explicit");
          return ME;
        },
      }),
    );
    expect(status.source).toEqual({ kind: "env", variable: "CT_LOGINTOKEN" });
  });

  it("reports a rejected token as that env's error rather than throwing", async () => {
    const status = await checkEnvAuth(
      dev,
      deps({
        env: { CT_LOGINTOKEN: "expired" },
        readDefaultHost: async () => dev.host,
        whoami: async () => {
          throw new Error("whoami failed (HTTP 401)");
        },
      }),
    );
    expect(status.identity).toBeUndefined();
    expect(status.error).toBe("whoami failed (HTTP 401)");
  });

  it("surfaces the HTTP status a real CtApiError carries, not just its message", async () => {
    // CtClient.authenticate throws CtApiError("Login failed (whoami)", status) — the
    // status is on the error, so err.message alone renders 401, 403 and 500 alike.
    const status = await checkEnvAuth(
      dev,
      deps({
        readStored: async (host) => ({ host, token: "expired" }),
        whoami: async () => {
          throw new CtApiError("Login failed (whoami)", 401, null);
        },
      }),
    );
    expect(status.error).toContain("HTTP 401");
  });

  it("reports a credential store that throws instead of aborting the sweep", async () => {
    const statuses = await checkAllEnvAuth(
      [dev, prod],
      deps({
        env: { CT_PROD_TOKEN: "ci-token" },
        readStored: async () => {
          throw new Error("keychain locked");
        },
        whoami: async () => ME,
      }),
    );
    expect(statuses[0]!.error).toBe("keychain locked");
    expect(statuses[1]!.identity).toEqual(ME);
  });
});

describe("checkAllEnvAuth", () => {
  it("checks every env, so one broken instance does not hide the others", async () => {
    const statuses = await checkAllEnvAuth(
      [dev, prod],
      deps({
        env: { CT_PROD_TOKEN: "ci-token" },
        whoami: async (host) => {
          if (host === dev.host) {
            throw new Error("connect ECONNREFUSED");
          }
          return ME;
        },
        readStored: async (host) => ({ host, token: "stored-token" }),
      }),
    );
    expect(statuses.map((s) => s.name)).toEqual(["dev", "prod"]);
    expect(statuses[0]!.error).toBe("connect ECONNREFUSED");
    expect(statuses[1]!.identity).toEqual(ME);
    expect(allEnvsAuthenticated(statuses)).toBe(false);
  });
});

describe("renderEnvAuth", () => {
  it("renders one aligned line per env with the token's provenance", () => {
    const lines = renderEnvAuth([
      { name: "dev", host: dev.host, source: { kind: "stored" }, identity: ME },
      { name: "prod", host: prod.host, source: { kind: "none" } },
      {
        name: "stage",
        host: "https://s.church.tools",
        source: { kind: "env", variable: "CT_PROD_TOKEN" },
        error: "whoami failed (HTTP 401)",
      },
    ]);
    expect(lines).toEqual([
      "dev    https://mychurch-dev.church.tools  ✓ Ada Lovelace (#42) via Keychain",
      "prod   https://mychurch.church.tools      ✗ no token",
      "stage  https://s.church.tools             ✗ whoami failed (HTTP 401) via $CT_PROD_TOKEN",
    ]);
  });

  it("never prints the token itself", () => {
    const line = renderEnvAuth([
      { name: "dev", host: dev.host, source: { kind: "stored" }, identity: ME },
    ]).join("\n");
    expect(line).not.toContain("token=");
  });
});

describe("describeIdentity", () => {
  it("degrades to the bare person id when the instance returns no name", () => {
    expect(describeIdentity({ id: 7 })).toBe("#7");
    expect(describeIdentity({ id: 7, lastName: "Lovelace" })).toBe("Lovelace (#7)");
  });
});
