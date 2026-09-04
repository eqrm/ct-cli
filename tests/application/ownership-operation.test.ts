import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkOwnership } from "../../src/application/operations/ownership.js";
import { RESOURCES } from "../../src/resources/registry.js";

const host = "https://example.church.tools";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(
  root: string,
  name: string,
  state: { resources?: Record<string, unknown>; externals?: Record<string, unknown> },
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "ct.envs.json"),
    JSON.stringify({ environments: { prod: { host, state: "ct-state.prod.json" } } }),
  );
  await writeFile(
    join(directory, "ct-state.prod.json"),
    JSON.stringify({ version: 2, host, resources: state.resources ?? {}, externals: state.externals ?? {} }),
  );
}

function managed(key: string, id: number) {
  return {
    type: "group",
    key,
    id,
    fields: { name: "Shared", groupTypeId: 2 },
    adoptedAt: "t",
    updatedAt: "t",
  };
}

function external(key: string, id: number, owner?: string) {
  return {
    type: "group",
    key,
    id,
    ...(owner ? { owner } : {}),
    identity: { name: "Shared", groupTypeId: 2 },
    boundAt: "t",
  };
}

describe("checkOwnership", () => {
  it("analyses every registry type through the same generic identity contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "ct-ownership-"));
    roots.push(root);
    const ownerResources: Record<string, unknown> = {};
    const consumerExternals: Record<string, unknown> = {};
    let id = 1;
    for (const [type, spec] of Object.entries(RESOURCES)) {
      const key = type.replaceAll("-", "_");
      const fields = { name: `Shared ${type}`, groupTypeId: 2 };
      ownerResources[key] = {
        type,
        key,
        id,
        fields,
        adoptedAt: "t",
        updatedAt: "t",
      };
      consumerExternals[key] = {
        type,
        key,
        id,
        owner: "master",
        identity: spec.external.identity(fields),
        boundAt: "t",
      };
      id += 1;
    }
    await project(root, "master", { resources: ownerResources });
    await project(root, "consumer", { externals: consumerExternals });
    const result = await checkOwnership({ root, environment: "prod" });
    expect(result.value.conflicts).toBe(0);
    expect(result.value.findings.filter((finding) => finding.reason === "OWNERSHIP_OK")).toHaveLength(
      Object.keys(RESOURCES).length,
    );
  });

  it("reports one visible owner plus read-only consumers as ok", async () => {
    const root = await mkdtemp(join(tmpdir(), "ct-ownership-"));
    roots.push(root);
    await project(root, "master", { resources: { shared: managed("shared", 7) } });
    await project(root, "consumer", { externals: { shared: external("shared", 7, "master") } });
    const result = await checkOwnership({ root, environment: "prod" });
    expect(result.value.conflicts).toBe(0);
    expect(result.value.findings).toContainEqual(expect.objectContaining({ reason: "OWNERSHIP_OK" }));
  });

  it("detects duplicate owners and key mismatches with rekey remediation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ct-ownership-"));
    roots.push(root);
    await project(root, "owner-a", { resources: { shared: managed("shared", 7) } });
    await project(root, "owner-b", { resources: { alias: managed("alias", 7) } });
    const result = await checkOwnership({ root, environment: "prod" });
    expect(result.value.findings.map((finding) => finding.reason)).toEqual(
      expect.arrayContaining(["DUPLICATE_OWNER", "KEY_MISMATCH"]),
    );
    expect(
      result.value.findings.find((finding) => finding.reason === "KEY_MISMATCH")?.remediation?.[0],
    ).toContain("ct state rekey group alias shared --env prod");
    expect(
      result.value.findings.find((finding) => finding.reason === "DUPLICATE_OWNER")?.remediation?.[0],
    ).toContain("ct unadopt group alias --env prod");
  });

  it("does not search ignored build or node_modules directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "ct-ownership-"));
    roots.push(root);
    await project(root, "visible", { resources: { shared: managed("shared", 7) } });
    await project(join(root, "node_modules"), "hidden", { resources: { alias: managed("alias", 7) } });
    const result = await checkOwnership({ root, environment: "prod" });
    expect(result.value.projects.map((item) => item.name)).toEqual(["visible"]);
  });
});
