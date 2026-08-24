import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/index.js";

describe("ct program", () => {
  it("registers the core command surface", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining(["auth", "get", "adopt", "report", "plan", "apply", "destroy", "completion"]),
    );
  });

  it("exposes auth subcommands", () => {
    const auth = buildProgram().commands.find((c) => c.name() === "auth");
    const subs = auth?.commands.map((c) => c.name()) ?? [];
    expect(subs).toEqual(expect.arrayContaining(["login", "status", "logout"]));
  });

  it("registers apply with --auto-approve", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "apply")!;
    expect(cmd.options.some((o) => o.long === "--auto-approve")).toBe(true);
  });

  it("registers destroy with a required --target", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "destroy")!;
    expect(cmd.options.some((o) => o.long === "--target")).toBe(true);
  });

  it("registers --env on the state/host-touching commands (#22)", () => {
    for (const name of ["plan", "apply", "destroy"]) {
      const cmd = buildProgram().commands.find((c) => c.name() === name)!;
      expect(cmd.options.some((o) => o.long === "--env")).toBe(true);
    }
  });

  it("registers --env on auth status and auth logout (#117)", () => {
    const auth = buildProgram().commands.find((c) => c.name() === "auth")!;
    for (const name of ["status", "logout"]) {
      const sub = auth.commands.find((c) => c.name() === name)!;
      expect(sub.options.some((o) => o.long === "--env" && o.short === "-e")).toBe(true);
    }
  });

  it("registers --all on auth status as the every-environment preflight (#117)", () => {
    const auth = buildProgram().commands.find((c) => c.name() === "auth")!;
    const status = auth.commands.find((c) => c.name() === "status")!;
    expect(status.options.some((o) => o.long === "--all")).toBe(true);
  });

  it("reports a real version, not the 0.0.0 literal (#116)", () => {
    expect(buildProgram().version()).not.toBe("0.0.0");
  });

  it("registers --confirm-env on apply and destroy (protected-env CI path, #22)", () => {
    for (const name of ["apply", "destroy"]) {
      const cmd = buildProgram().commands.find((c) => c.name() === name)!;
      expect(cmd.options.some((o) => o.long === "--confirm-env")).toBe(true);
    }
  });

  it("offers one-pass subject and object permission report options", () => {
    const report = buildProgram().commands.find((c) => c.name() === "report")!;
    const permissions = report.commands.find((c) => c.name() === "permissions")!;
    const options = permissions.options.map((o) => o.long);
    expect(options).toEqual(expect.arrayContaining(["--by-subject", "--by-object", "--by-both"]));
    expect(options).not.toContain("--by");
    expect(options).not.toContain("--output");
  });
});
