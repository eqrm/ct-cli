import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/index.js";

describe("ct program", () => {
  it("registers the core command surface", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining(["init", "auth", "get", "adopt", "plan", "apply", "destroy"]),
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

  it("registers the process init template and environment protection options", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "init")!;
    expect(cmd.options.some((o) => o.long === "--template")).toBe(true);
    expect(cmd.options.some((o) => o.long === "--protected")).toBe(true);
    expect(cmd.options.some((o) => o.long === "--no-git")).toBe(true);
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

  it("registers --confirm-env on apply and destroy (protected-env CI path, #22)", () => {
    for (const name of ["apply", "destroy"]) {
      const cmd = buildProgram().commands.find((c) => c.name() === name)!;
      expect(cmd.options.some((o) => o.long === "--confirm-env")).toBe(true);
    }
  });
});
