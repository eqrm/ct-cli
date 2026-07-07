# Phase 4 — Apply + Destroy + Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase 3 plan real — `ct apply` (idempotent create + update in dependency order) and `ct destroy --target` (explicit, protected deletion), with the Phase 4 guardrails.

**Architecture:** A shared `buildPlan` feeds both `plan` and `apply`. A field-agnostic `executePlan` walks the ordered plan, creating/updating via registry-declared write specs and reconciling group hierarchy through the parents endpoints, saving state after each action. `destroy` is a separate, explicit command with a `preventDestroy` config guard and typed confirmation. Every write passes a people-boundary guard; every apply/destroy writes a JSON backup first.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), commander, vitest, picocolors, node:readline. No new dependencies.

## Global Constraints

- ESM throughout: import local modules with `.js` specifiers (e.g. `../state/state.js`).
- CT ids can be `0` — never use truthiness for id presence; use explicit null/undefined checks.
- `apply` NEVER deletes. Deletion is exclusively `destroy`'s job.
- People/memberships are never touched (structural-only registry + `assertNotPeople` guard).
- Machine output → stdout (`out`); human messages → stderr (`info`/`warn`/`success`/`error`).
- Writes are non-idempotent: never blindly retried on 5xx/network (existing `fetchWithRetry` already enforces this; do not change it).
- Follow existing test style: vitest `describe/it/expect`, fakes over network.
- State snapshot for a group NEVER stores `parents` (hierarchy is diffed live), matching the adopt convention.

---

## File structure

- Create `src/engine/guard.ts` — `assertNotPeople(path)`.
- Create `src/engine/backup.ts` — `writeBackup(dir, host, actual, now?)`.
- Create `src/ui/prompt.ts` — `confirm`, `confirmTyped`.
- Create `src/engine/build.ts` — `buildPlan(client, state, desired)`.
- Create `src/engine/execute.ts` — `executePlan(plan, deps)`.
- Create `src/commands/apply.ts`, `src/commands/destroy.ts`.
- Modify `src/engine/types.ts` — add `preventDestroy?` to `DesiredResource`.
- Modify `src/config/context.ts` — add `preventDestroy?` to `ResourceInput`, extract it.
- Modify `src/resources/registry.ts` — add `collectionPath`, `updateMethod`; add new type entries.
- Modify `src/commands/plan.ts` — call `buildPlan`.
- Modify `src/commands/placeholders.ts` — drop apply/destroy stubs.
- Modify `src/index.ts` — register `apply`/`destroy`.
- Tests alongside in `tests/`.

---

## Task 1: `preventDestroy` lifecycle flag

**Files:**
- Modify: `src/engine/types.ts`
- Modify: `src/config/context.ts`
- Test: `tests/context.test.ts`

**Interfaces:**
- Produces: `DesiredResource.preventDestroy?: boolean`; `ResourceInput.preventDestroy?: boolean`. The flag is extracted before building `fields`, so it is never diffed or sent to the API.

- [ ] **Step 1: Write the failing test** — append to `tests/context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateConfig } from "../src/config/context.js";

describe("preventDestroy lifecycle flag", () => {
  it("is carried on the resource but kept out of managed fields", async () => {
    const resources = await evaluateConfig((ct) => {
      ct.group({ key: "kids_lead", name: "Kids Leitung", preventDestroy: true });
    });
    const group = resources.find((r) => r.key === "kids_lead")!;
    expect(group.preventDestroy).toBe(true);
    expect(group.fields).toEqual({ name: "Kids Leitung" });
  });

  it("defaults to undefined when not declared", async () => {
    const resources = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
    });
    expect(resources[0]!.preventDestroy).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/context.test.ts`
Expected: FAIL — `group.fields` still contains `preventDestroy`.

- [ ] **Step 3: Implement** — in `src/engine/types.ts`, add to `DesiredResource` (after `parents?`):

```ts
  /** Lifecycle flag: block `ct destroy` for this resource. Never diffed or sent to the API. */
  preventDestroy?: boolean;
```

In `src/config/context.ts`, add to `ResourceInput` (after `parents?`):

```ts
  /** Block `ct destroy` for this resource until the flag is removed. */
  preventDestroy?: boolean;
```

And change `toDesired` to extract it:

```ts
function toDesired(type: string, input: ResourceInput): DesiredResource {
  const { key, parent, parents, dependsOn = [], preventDestroy, ...fields } = input;
  if (!key || typeof key !== "string") {
    throw new Error(`${type} declaration is missing a string "key".`);
  }
  const declared = parents !== undefined || parent !== undefined;
  const parentKeys = declared ? [...new Set([...(parents ?? []), ...(parent ? [parent] : [])])] : undefined;
  const edges = [...dependsOn, ...(parentKeys ?? [])];
  return { type, key, fields, parent, parents: parentKeys, dependsOn: edges, preventDestroy };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/types.ts src/config/context.ts tests/context.test.ts
git commit -m "feat(config): preventDestroy lifecycle flag"
```

---

## Task 2: Registry write specs + new writable types

**Files:**
- Modify: `src/resources/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Produces: `AdoptableResource` gains `collectionPath: string` and `updateMethod: "PUT" | "PATCH"`. `itemPath(id)` still returns `\`${collectionPath}/${id}\``. New entries: `age-group`, `target-group`, `relationship-type`, `group-role`.

- [ ] **Step 1: Write the failing test** — append to `tests/registry.test.ts`:

```ts
import { describe as d2, it as i2, expect as e2 } from "vitest";
import { RESOURCES as R2 } from "../src/resources/registry.js";

d2("write specs", () => {
  i2("campus creates via POST /campuses and updates via PUT", () => {
    e2(R2.campus?.collectionPath).toBe("/campuses");
    e2(R2.campus?.updateMethod).toBe("PUT");
  });
  i2("group updates via PATCH", () => {
    e2(R2.group?.collectionPath).toBe("/groups");
    e2(R2.group?.updateMethod).toBe("PATCH");
  });
  i2("registers the new writable types with their collection paths", () => {
    e2(R2["age-group"]?.collectionPath).toBe("/group/agegroups");
    e2(R2["target-group"]?.collectionPath).toBe("/group/targetgroups");
    e2(R2["relationship-type"]?.collectionPath).toBe("/person/relationshiptypes");
    e2(R2["group-role"]?.collectionPath).toBe("/group/roles");
    e2(R2["age-group"]?.itemPath(3)).toBe("/group/agegroups/3");
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — `collectionPath`/`updateMethod` undefined; new types missing.

- [ ] **Step 3: Implement** — rewrite the interface, helper, and `RESOURCES` in `src/resources/registry.ts`. Replace the `AdoptableResource` interface, the `item` helper, and the `RESOURCES` object with:

```ts
export interface AdoptableResource {
  /** Collection path: `POST` here creates. */
  collectionPath: string;
  /** GET/PUT/PATCH/DELETE path for a single resource by id. */
  itemPath: (id: number) => string;
  /** Update verb: `group` is PATCH; every other type is PUT. */
  updateMethod: "PUT" | "PATCH";
  /** Stable logical key derived from the fetched resource. */
  deriveKey: (resource: Record<string, unknown>) => string;
  /** The subset of fields we manage — the desired-state baseline. */
  managedFields: (resource: Record<string, unknown>) => Record<string, unknown>;
}

/** Build a full spec, deriving `itemPath` from the collection path so each entry names its path once. */
function define(spec: Omit<AdoptableResource, "itemPath">): AdoptableResource {
  return { ...spec, itemPath: (id: number) => `${spec.collectionPath}/${id}` };
}
```

Delete the old `const item = ...` line. Then set `RESOURCES`:

```ts
export const RESOURCES: Record<string, AdoptableResource> = {
  campus: define({
    collectionPath: "/campuses",
    updateMethod: "PUT",
    deriveKey: (r) => slug(str(r, "shortName") || str(r, "name")),
    managedFields: (r) => ({ name: r.name, shortName: r.shortName }),
  }),
  group: define({
    collectionPath: "/groups",
    updateMethod: "PATCH",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({
      name: r.name,
      groupTypeId: fromInformation(r, "groupTypeId"),
      groupStatusId: fromInformation(r, "groupStatusId"),
    }),
  }),
  "group-type": define({
    collectionPath: "/group/grouptypes",
    updateMethod: "PUT",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated }),
  }),
  "age-group": define({
    collectionPath: "/group/agegroups",
    updateMethod: "PUT",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, sortKey: r.sortKey }),
  }),
  "target-group": define({
    collectionPath: "/group/targetgroups",
    updateMethod: "PUT",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, sortKey: r.sortKey }),
  }),
  "relationship-type": define({
    collectionPath: "/person/relationshiptypes",
    updateMethod: "PUT",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({
      name: r.name,
      degreeForward: r.degreeForward,
      degreeReverse: r.degreeReverse,
    }),
  }),
  "group-role": define({
    collectionPath: "/group/roles",
    updateMethod: "PUT",
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, groupTypeId: r.groupTypeId }),
  }),
};
```

> Managed-field sets for the four new types are provisional; live-verify with `ct get` in Task 11 and adjust this file + the registry test if the real fields differ.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS (existing itemPath tests still pass — `itemPath` behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/resources/registry.ts tests/registry.test.ts
git commit -m "feat(registry): write specs (collectionPath, updateMethod) + new writable types"
```

---

## Task 3: People-boundary guard

**Files:**
- Create: `src/engine/guard.ts`
- Test: `tests/guard.test.ts`

**Interfaces:**
- Produces: `assertNotPeople(path: string): void` — throws for any people/membership write path; returns silently for structural paths (including `/groups/{id}/parents/{id}`).

- [ ] **Step 1: Write the failing test** — create `tests/guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertNotPeople } from "../src/engine/guard.js";

describe("assertNotPeople", () => {
  it("throws for people and membership paths", () => {
    for (const p of [
      "/persons",
      "/persons/42",
      "/memberships/7",
      "/groups/3/members",
      "/groups/3/members/9",
      "/groups/3/memberships",
    ]) {
      expect(() => assertNotPeople(p), p).toThrow(/people|member/i);
    }
  });

  it("allows structural paths including hierarchy edges", () => {
    for (const p of [
      "/campuses",
      "/groups",
      "/groups/3",
      "/groups/3/parents/5",
      "/group/grouptypes/2",
      "/person/relationshiptypes/1",
    ]) {
      expect(() => assertNotPeople(p)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/engine/guard.ts`:

```ts
/**
 * Hard people boundary. The CLI manages the *structure* only — people and
 * memberships are never touched. This is belt-and-suspenders atop the
 * structural-only registry (the primary allowlist): every write in apply/destroy
 * passes its path through here first.
 *
 * Note `/person/relationshiptypes` is master data (relationship *types*), not a
 * person — the denylist matches `/persons` (plural), not `/person`.
 */
const FORBIDDEN: RegExp[] = [
  /^\/persons(\/|$)/,
  /^\/memberships(\/|$)/,
  /\/groups\/\d+\/members(hips)?(\/|$)/,
];

export function assertNotPeople(path: string): void {
  if (FORBIDDEN.some((re) => re.test(path))) {
    throw new Error(
      `Refusing to write to "${path}": people/memberships are never managed by this tool.`,
    );
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/guard.ts tests/guard.test.ts
git commit -m "feat(engine): assertNotPeople hard boundary guard"
```

---

## Task 4: Backup writer

**Files:**
- Create: `src/engine/backup.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Produces: `writeBackup(dir: string, host: string, actual: Map<string, Record<string, unknown>>, now?: Date): Promise<string>` — returns the written file path. Creates `dir` if missing. Filename `ct-backup-<ISO with ':'→'-'>.json`. Content: `{ host, capturedAt, resources }`.

- [ ] **Step 1: Write the failing test** — create `tests/backup.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBackup } from "../src/engine/backup.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("writeBackup", () => {
  it("writes a timestamped JSON snapshot of actual resources", async () => {
    dir = await mkdtemp(join(tmpdir(), "ct-backup-test-"));
    const actual = new Map<string, Record<string, unknown>>([["mainz", { name: "Mainz" }]]);
    const now = new Date("2026-07-07T14:30:00.000Z");
    const path = await writeBackup(dir, "https://x.church.tools", actual, now);
    expect(path).toBe(join(dir, "ct-backup-2026-07-07T14-30-00.000Z.json"));
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({
      host: "https://x.church.tools",
      capturedAt: "2026-07-07T14:30:00.000Z",
      resources: { mainz: { name: "Mainz" } },
    });
  });

  it("creates the backup directory if it does not exist", async () => {
    const base = await mkdtemp(join(tmpdir(), "ct-backup-test-"));
    dir = base;
    const nested = join(base, "backups");
    const path = await writeBackup(nested, "h", new Map(), new Date("2026-01-01T00:00:00.000Z"));
    expect(await readFile(path, "utf8")).toContain('"resources": {}');
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/backup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/engine/backup.ts`:

```ts
/**
 * Automatic pre-write backup. Before any apply/destroy touches ChurchTools, the
 * current *actual* values of the managed resources are dumped to a timestamped
 * JSON file, so the affected area can be inspected/restored.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeBackup(
  dir: string,
  host: string,
  actual: Map<string, Record<string, unknown>>,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/:/g, "-");
  const path = join(dir, `ct-backup-${stamp}.json`);
  const payload = {
    host,
    capturedAt: now.toISOString(),
    resources: Object.fromEntries(actual),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/backup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/backup.ts tests/backup.test.ts
git commit -m "feat(engine): pre-write backup writer"
```

---

## Task 5: Confirmation prompts

**Files:**
- Create: `src/ui/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Produces:
  - `confirm(message: string, opts?: PromptOptions & { assumeYes?: boolean }): Promise<boolean>`
  - `confirmTyped(expected: string, opts?: PromptOptions & { force?: boolean }): Promise<boolean>`
  - `interface PromptOptions { isTTY?: boolean; ask?: (question: string) => Promise<string> }`
- Behaviour: `assumeYes`/`force` short-circuit `true`. Non-TTY without a bypass ⇒ `false`. Otherwise ask; `confirm` accepts `y`/`yes` (case-insensitive); `confirmTyped` requires an exact trimmed match.

- [ ] **Step 1: Write the failing test** — create `tests/prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { confirm, confirmTyped } from "../src/ui/prompt.js";

describe("confirm", () => {
  it("short-circuits true with assumeYes", async () => {
    expect(await confirm("go?", { assumeYes: true })).toBe(true);
  });
  it("returns false on a non-TTY without assumeYes", async () => {
    expect(await confirm("go?", { isTTY: false })).toBe(false);
  });
  it("accepts y/yes", async () => {
    expect(await confirm("go?", { isTTY: true, ask: async () => "y" })).toBe(true);
    expect(await confirm("go?", { isTTY: true, ask: async () => "Yes" })).toBe(true);
  });
  it("rejects anything else", async () => {
    expect(await confirm("go?", { isTTY: true, ask: async () => "" })).toBe(false);
    expect(await confirm("go?", { isTTY: true, ask: async () => "n" })).toBe(false);
  });
});

describe("confirmTyped", () => {
  it("short-circuits true with force", async () => {
    expect(await confirmTyped("old_team", { force: true })).toBe(true);
  });
  it("requires an exact match", async () => {
    expect(await confirmTyped("old_team", { isTTY: true, ask: async () => "old_team" })).toBe(true);
    expect(await confirmTyped("old_team", { isTTY: true, ask: async () => "nope" })).toBe(false);
  });
  it("returns false on a non-TTY without force", async () => {
    expect(await confirmTyped("x", { isTTY: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/ui/prompt.ts`:

```ts
/**
 * Interactive confirmation. Dependencies (`isTTY`, `ask`) are injectable so the
 * prompts are testable without a real terminal. In production they default to
 * the process's TTY state and a readline question on stdin.
 */
import { createInterface } from "node:readline";

export interface PromptOptions {
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
}

function realAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function ttyState(opts: PromptOptions): boolean {
  return opts.isTTY ?? Boolean(process.stdin.isTTY);
}

/** Yes/No confirmation. `assumeYes` skips the prompt (for `-y`/CI). */
export async function confirm(
  message: string,
  opts: PromptOptions & { assumeYes?: boolean } = {},
): Promise<boolean> {
  if (opts.assumeYes) {
    return true;
  }
  if (!ttyState(opts)) {
    return false;
  }
  const ask = opts.ask ?? realAsk;
  const answer = await ask(`${message} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** Require the user to type `expected` exactly. `force` skips the prompt. */
export async function confirmTyped(
  expected: string,
  opts: PromptOptions & { force?: boolean } = {},
): Promise<boolean> {
  if (opts.force) {
    return true;
  }
  if (!ttyState(opts)) {
    return false;
  }
  const ask = opts.ask ?? realAsk;
  const answer = await ask(`Type "${expected}" to confirm: `);
  return answer.trim() === expected;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/prompt.ts tests/prompt.test.ts
git commit -m "feat(ui): confirm + confirmTyped prompts"
```

---

## Task 6: Shared plan building (`buildPlan`)

**Files:**
- Create: `src/engine/build.ts`
- Modify: `src/commands/plan.ts`
- Test: `tests/build.test.ts`

**Interfaces:**
- Produces: `buildPlan(client, state, desired): Promise<BuildResult>` where
  - `client: Pick<CtClient, "get">`
  - `interface BuildResult { plan: Plan; actual: Map<string, Record<string, unknown>>; fetchErrors: string[] }`
- It fetches each managed resource's actual fields (concurrently), folds group hierarchy, and returns `computePlan(...)`. Emits the same per-resource `warn`s the old plan command did.

- [ ] **Step 1: Write the failing test** — create `tests/build.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPlan } from "../src/engine/build.js";
import { emptyState } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";

function fakeClient(byPath: Record<string, unknown>) {
  return {
    get: async <T>(path: string): Promise<T> => {
      if (!(path in byPath)) {
        const err = new Error(`404 ${path}`) as Error & { status?: number };
        // mimic CtApiError.status so buildPlan's 404 branch triggers
        (err as { status?: number }).status = 404;
        throw err;
      }
      return byPath[path] as T;
    },
  };
}

describe("buildPlan", () => {
  it("diffs desired against fetched actual and returns an ordered plan", async () => {
    const state = emptyState("https://x.church.tools");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz", shortName: "MZ" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const desired: DesiredResource[] = [
      { type: "campus", key: "mainz", fields: { name: "Mainz City", shortName: "MZ" }, dependsOn: [] },
    ];
    const client = fakeClient({ "/campuses/0": { name: "Mainz", shortName: "MZ" } });
    const { plan, actual, fetchErrors } = await buildPlan(client, state, desired);
    expect(fetchErrors).toEqual([]);
    expect(actual.get("mainz")).toEqual({ name: "Mainz", shortName: "MZ" });
    const item = plan.items.find((i) => i.key === "mainz")!;
    expect(item.action).toBe("update");
    expect(item.changes).toEqual([{ field: "name", from: "Mainz", to: "Mainz City" }]);
  });
});
```

> Note: `buildPlan` treats a thrown error with `status === 404` as "vanished". The real code uses `CtApiError`; this fake sets `.status` so the same branch fires. (Confirm the 404 branch checks `err instanceof CtApiError && err.status === 404` — keep that, and additionally accept a plain `{ status: 404 }` is NOT needed; instead the fake below throws a `CtApiError`.) **Replace the fake's throw with a real `CtApiError`:**

```ts
import { CtApiError } from "../src/api/ctClient.js";
// ...in fakeClient, on miss:
throw new CtApiError(`not found`, 404, null);
```

(Use the `CtApiError` version in the actual test file; the `.status` note above is just explanation.)

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/build.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/engine/build.ts` by lifting the fetch+hierarchy+computePlan logic out of `plan.ts`:

```ts
/**
 * Shared plan building: fetch the actual ChurchTools values of every managed
 * resource, fold group hierarchy into a `parents` set-field, and diff against
 * the desired config + state. Used by both `ct plan` and `ct apply`, so apply
 * fetches exactly once (its `actual` map is reused for the backup).
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, Plan } from "./types.js";
import { RESOURCES } from "../resources/registry.js";
import { computePlan } from "./plan.js";
import { parentIdsByGroupId, applyHierarchy, type HierarchyEntry } from "./hierarchy.js";
import { mapConcurrent } from "../util/concurrency.js";
import { warn } from "../ui.js";

/** How many managed resources to fetch from ChurchTools at once. */
const FETCH_CONCURRENCY = 8;

export interface BuildResult {
  plan: Plan;
  actual: Map<string, Record<string, unknown>>;
  fetchErrors: string[];
}

export async function buildPlan(
  client: Pick<CtClient, "get">,
  state: State,
  desired: DesiredResource[],
): Promise<BuildResult> {
  const actual = new Map<string, Record<string, unknown>>();
  const unresolved = new Set<string>();
  const fetchErrors: string[] = [];

  await mapConcurrent(Object.values(state.resources), FETCH_CONCURRENCY, async (managed) => {
    const spec = RESOURCES[managed.type];
    if (!spec) {
      unresolved.add(managed.key);
      warn(
        `No registry entry for managed type "${managed.type}" (${managed.type}.${managed.key} #${managed.id}) — cannot diff; leaving untouched.`,
      );
      return;
    }
    try {
      const raw = await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
      actual.set(managed.key, spec.managedFields(raw));
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      fetchErrors.push(`${managed.type}.${managed.key} (#${managed.id}): ${message}`);
      warn(`Failed to fetch ${managed.type}.${managed.key} (#${managed.id}): ${message}`);
    }
  });

  let parentIds = new Map<number, number[]>();
  const hasManagedGroups = Object.values(state.resources).some((m) => m.type === "group");
  if (hasManagedGroups) {
    try {
      const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
      parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fetchErrors.push(`group hierarchies: ${message}`);
      warn(`Failed to fetch group hierarchies: ${message}`);
    }
  }
  const desiredWithHierarchy = applyHierarchy(desired, state, actual, parentIds);
  const plan = computePlan(desiredWithHierarchy, state, actual, { unresolved });
  return { plan, actual, fetchErrors };
}
```

Now rewrite `src/commands/plan.ts` to use it (replace the whole action body's fetch/compute section). The new `plan.ts`:

```ts
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { renderPlan } from "../engine/render.js";
import { info, warn, out } from "../ui.js";

interface PlanOptions {
  config?: string;
  state?: string;
  json?: boolean;
}

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the diff between the desired-state config and ChurchTools (read-only)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--json", "emit the raw plan as JSON instead of the rendered diff")
    .action(async (opts: PlanOptions) => {
      const config = resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const desired = await loadConfig(configPath);
      const state = await loadState(resolveStatePath(opts.state), config.host);
      if (state.host !== config.host) {
        throw new Error(`State host (${state.host}) does not match CT_HOST (${config.host}).`);
      }

      const { client } = await authedSession();
      const { plan, fetchErrors } = await buildPlan(client, state, desired);
      if (opts.json) {
        out(plan);
      } else {
        info(`config: ${configPath} · state host: ${state.host}`);
        process.stdout.write(`${renderPlan(plan)}\n`);
      }
      if (fetchErrors.length > 0) {
        warn(
          `Plan is INCOMPLETE — ${fetchErrors.length} resource(s) could not be fetched; their diff is missing. Re-run to retry.`,
        );
        process.exitCode = 1;
      }
    });
}
```

- [ ] **Step 4: Run the whole suite, expect pass** (plan behaviour is unchanged; existing tests still pass)

Run: `npx vitest run tests/build.test.ts tests/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/build.ts src/commands/plan.ts tests/build.test.ts
git commit -m "refactor(engine): extract buildPlan; plan command reuses it"
```

---

## Task 7: The executor (`executePlan`)

**Files:**
- Create: `src/engine/execute.ts`
- Test: `tests/execute.test.ts`

**Interfaces:**
- Consumes: `RESOURCES` (Task 2), `assertNotPeople` (Task 3), `upsert`/`saveState` from `state.ts`, `Plan`/`PlanItem`/`FieldChange` from `types.ts`.
- Produces:
  - `interface ExecuteDeps { client: Pick<CtClient, "request">; state: State; statePath: string; now?: () => string; save?: (path: string, state: State) => Promise<void> }`
  - `interface ExecuteResult { created: string[]; updated: string[]; skippedDeletes: string[]; failed?: { key: string; message: string } }`
  - `executePlan(plan: Plan, deps: ExecuteDeps): Promise<ExecuteResult>`
- Behaviour: walks `plan.items` in order. `delete` → record in `skippedDeletes` and skip (apply never deletes). `no-op` → skip. `create` → POST collection, capture `id`, upsert+save, then apply parent edges. `update` → PUT/PATCH item (only if a non-`parents` field changed), refresh snapshot, save, then apply parent edges. Group `parents` are reconciled via `PUT`/`DELETE /groups/{id}/parents/{parentId}` (keys resolved to ids via state). Stops on first error, returning `failed`.

- [ ] **Step 1: Write the failing test** — create `tests/execute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan } from "../src/engine/types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      return (responses[key] ?? {}) as T;
    },
  };
  return { client, calls };
}

const noSave = async (_p: string, _s: State) => {};
const fixedNow = () => "2026-07-07T00:00:00.000Z";

describe("executePlan", () => {
  it("creates a resource, captures its id, and records it in state", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /campuses": { id: 5 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Zürich" },
            { field: "shortName", from: undefined, to: "ZH" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(result.created).toEqual(["zurich"]);
    expect(calls[0]).toEqual({ method: "POST", path: "/campuses", body: { name: "Zürich", shortName: "ZH" } });
    expect(state.resources.zurich).toMatchObject({ type: "campus", id: 5, key: "zurich", fields: { name: "Zürich", shortName: "ZH" } });
  });

  it("updates a group via PATCH with the full managed snapshot", async () => {
    const state = emptyState("h");
    state.resources.team = { type: "group", id: 9, key: "team", fields: { name: "Team", groupTypeId: 2, groupStatusId: 1 }, adoptedAt: "t", updatedAt: "t" };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        { type: "group", key: "team", id: 9, action: "update", changes: [{ field: "name", from: "Team", to: "Team A" }] },
      ],
    };
    const result = await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(result.updated).toEqual(["team"]);
    expect(calls[0]).toEqual({ method: "PATCH", path: "/groups/9", body: { name: "Team A", groupTypeId: 2, groupStatusId: 1 } });
    expect(state.resources.team!.fields).toEqual({ name: "Team A", groupTypeId: 2, groupStatusId: 1 });
  });

  it("reconciles hierarchy edges via PUT/DELETE and never stores parents in state", async () => {
    const state = emptyState("h");
    state.resources.parent = { type: "group", id: 1, key: "parent", fields: { name: "P" }, adoptedAt: "t", updatedAt: "t" };
    state.resources.child = { type: "group", id: 2, key: "child", fields: { name: "C" }, adoptedAt: "t", updatedAt: "t" };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        { type: "group", key: "child", id: 2, action: "update", changes: [{ field: "parents", from: [], to: ["parent"] }] },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(calls).toEqual([{ method: "PUT", path: "/groups/2/parents/1", body: undefined }]);
    expect(state.resources.child!.fields.parents).toBeUndefined();
  });

  it("skips deletes (apply never deletes)", async () => {
    const state = emptyState("h");
    state.resources.old = { type: "campus", id: 3, key: "old", fields: {}, adoptedAt: "t", updatedAt: "t" };
    const { client, calls } = recorder();
    const plan: Plan = { items: [{ type: "campus", key: "old", id: 3, action: "delete", changes: [] }] };
    const result = await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(result.skippedDeletes).toEqual(["old"]);
    expect(calls).toEqual([]);
    expect(state.resources.old).toBeDefined();
  });

  it("stops on the first write error and reports it", async () => {
    const state = emptyState("h");
    const client = {
      request: async () => {
        throw new Error("boom");
      },
    };
    const plan: Plan = {
      items: [{ type: "campus", key: "zurich", id: null, action: "create", changes: [{ field: "name", from: undefined, to: "Z" }] }],
    };
    const result = await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(result.failed).toEqual({ key: "zurich", message: "boom" });
    expect(result.created).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/execute.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/engine/execute.ts`:

```ts
/**
 * The executor: walk a computed plan and make it real. Field-agnostic — every
 * resource's write path/verb comes from the registry, so adding a type never
 * touches this file. State is saved after each successful action, so a crash
 * mid-apply leaves a consistent, resumable state file.
 *
 * apply NEVER deletes: delete items are recorded and skipped. Group hierarchy is
 * reconciled through the parents endpoints, not the group body.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import { upsert, saveState } from "../state/state.js";
import type { FieldChange, Plan } from "./types.js";
import { RESOURCES } from "../resources/registry.js";
import { assertNotPeople } from "./guard.js";

export interface ExecuteDeps {
  client: Pick<CtClient, "request">;
  state: State;
  statePath: string;
  now?: () => string;
  save?: (path: string, state: State) => Promise<void>;
}

export interface ExecuteResult {
  created: string[];
  updated: string[];
  skippedDeletes: string[];
  failed?: { key: string; message: string };
}

/** The managed field snapshot after a write: base ∪ changed fields, minus the hierarchy `parents` set-field. */
function snapshotFromChanges(base: Record<string, unknown>, changes: FieldChange[]): Record<string, unknown> {
  const snap = { ...base };
  for (const c of changes) {
    if (c.field !== "parents") {
      snap[c.field] = c.to;
    }
  }
  delete snap.parents;
  return snap;
}

function parentEdges(from: unknown, to: unknown): { added: string[]; removed: string[] } {
  const f = new Set(Array.isArray(from) ? (from as string[]) : []);
  const t = new Set(Array.isArray(to) ? (to as string[]) : []);
  return {
    added: [...t].filter((k) => !f.has(k)),
    removed: [...f].filter((k) => !t.has(k)),
  };
}

function resolveId(state: State, key: string): number {
  const managed = state.resources[key];
  if (!managed) {
    throw new Error(`Cannot resolve parent "${key}" — not under management yet.`);
  }
  return managed.id;
}

async function applyParentEdges(
  client: Pick<CtClient, "request">,
  state: State,
  childId: number,
  changes: FieldChange[],
): Promise<void> {
  const change = changes.find((c) => c.field === "parents");
  if (!change) {
    return;
  }
  const { added, removed } = parentEdges(change.from, change.to);
  for (const key of added) {
    const path = `/groups/${childId}/parents/${resolveId(state, key)}`;
    assertNotPeople(path);
    await client.request("PUT", path);
  }
  for (const key of removed) {
    const path = `/groups/${childId}/parents/${resolveId(state, key)}`;
    assertNotPeople(path);
    await client.request("DELETE", path);
  }
}

export async function executePlan(plan: Plan, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { client, state, statePath } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const save = deps.save ?? saveState;
  const created: string[] = [];
  const updated: string[] = [];
  const skippedDeletes: string[] = [];

  for (const item of plan.items) {
    if (item.action === "delete") {
      skippedDeletes.push(item.key);
      continue;
    }
    if (item.action === "no-op") {
      continue;
    }
    const spec = RESOURCES[item.type];
    if (!spec) {
      return { created, updated, skippedDeletes, failed: { key: item.key, message: `No write spec for type "${item.type}".` } };
    }

    try {
      if (item.action === "create") {
        const body = snapshotFromChanges({}, item.changes);
        assertNotPeople(spec.collectionPath);
        const res = await client.request<{ id: number }>("POST", spec.collectionPath, body);
        if (typeof res.id !== "number") {
          throw new Error(`create returned no numeric id (got ${JSON.stringify(res.id)})`);
        }
        upsert(state, { type: item.type, id: res.id, key: item.key, fields: body }, now());
        await save(statePath, state);
        await applyParentEdges(client, state, res.id, item.changes);
        created.push(item.key);
      } else {
        const id = item.id;
        if (id === null) {
          throw new Error("update item has no id");
        }
        const base = state.resources[item.key]?.fields ?? {};
        const snapshot = snapshotFromChanges(base, item.changes);
        const hasFieldChange = item.changes.some((c) => c.field !== "parents");
        if (hasFieldChange) {
          const path = spec.itemPath(id);
          assertNotPeople(path);
          await client.request(spec.updateMethod, path, snapshot);
        }
        upsert(state, { type: item.type, id, key: item.key, fields: snapshot }, now());
        await save(statePath, state);
        await applyParentEdges(client, state, id, item.changes);
        updated.push(item.key);
      }
    } catch (err) {
      return { created, updated, skippedDeletes, failed: { key: item.key, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  return { created, updated, skippedDeletes };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/execute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/execute.ts tests/execute.test.ts
git commit -m "feat(engine): executePlan — idempotent create/update + hierarchy edges"
```

---

## Task 8: `ct apply` command

**Files:**
- Create: `src/commands/apply.ts`
- Test: `tests/apply.test.ts` (backup-dir resolution unit)

**Interfaces:**
- Consumes: `buildPlan` (Task 6), `executePlan` (Task 7), `writeBackup` (Task 4), `confirm` (Task 5), `renderPlan`, `summarize`.
- Produces: `applyCommand(): Command`; exported helper `resolveBackupDir(explicit, statePath, env?): string` for testing.

- [ ] **Step 1: Write the failing test** — create `tests/apply.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveBackupDir } from "../src/commands/apply.js";

describe("resolveBackupDir", () => {
  it("prefers the explicit flag", () => {
    expect(resolveBackupDir("./out", "cfg/ct-state.json", {})).toBe("./out");
  });
  it("falls back to CT_BACKUP_DIR", () => {
    expect(resolveBackupDir(undefined, "cfg/ct-state.json", { CT_BACKUP_DIR: "/b" })).toBe("/b");
  });
  it("defaults to a backups/ dir beside the state file", () => {
    expect(resolveBackupDir(undefined, "cfg/ct-state.json", {})).toBe("cfg/backups");
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/commands/apply.ts`:

```ts
import { dirname, join } from "node:path";
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath, saveState } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { executePlan } from "../engine/execute.js";
import { writeBackup } from "../engine/backup.js";
import { renderPlan } from "../engine/render.js";
import { summarize } from "../engine/types.js";
import { confirm } from "../ui/prompt.js";
import { info, warn, success, error } from "../ui.js";

interface ApplyOptions {
  config?: string;
  state?: string;
  backupDir?: string;
  autoApprove?: boolean;
}

/** backups/ dir: explicit flag → CT_BACKUP_DIR → `backups/` beside the state file. */
export function resolveBackupDir(
  explicit: string | undefined,
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicit?.trim() || env.CT_BACKUP_DIR?.trim() || join(dirname(statePath), "backups");
}

export function applyCommand(): Command {
  return new Command("apply")
    .description("Apply the plan: idempotent create + update in dependency order (never deletes)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--backup-dir <path>", "directory for the pre-apply backup (or set CT_BACKUP_DIR)")
    .option("-y, --auto-approve", "skip the confirmation prompt")
    .action(async (opts: ApplyOptions) => {
      const config = resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const statePath = resolveStatePath(opts.state);
      const desired = await loadConfig(configPath);
      const state = await loadState(statePath, config.host);

      const { client } = await authedSession();
      const { plan, actual, fetchErrors } = await buildPlan(client, state, desired);

      if (fetchErrors.length > 0) {
        error(`Aborting: ${fetchErrors.length} resource(s) could not be fetched — the plan is incomplete. Re-run when resolved.`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${renderPlan(plan)}\n`);

      const deletes = plan.items.filter((i) => i.action === "delete");
      if (deletes.length > 0) {
        warn(`${deletes.length} resource(s) dropped from config will NOT be deleted by apply:`);
        for (const d of deletes) {
          info(`    ${d.type}.${d.key} (#${d.id}) — run: ct destroy --target ${d.key}`);
        }
      }

      const s = summarize(plan);
      const changeCount = s.create + s.update;
      if (changeCount === 0) {
        success("No changes to apply.");
        return;
      }

      const ok = await confirm(`Apply ${changeCount} change(s)?`, { assumeYes: opts.autoApprove });
      if (!ok) {
        warn("Aborted — no changes made.");
        process.exitCode = 1;
        return;
      }

      const backupPath = await writeBackup(resolveBackupDir(opts.backupDir, statePath), config.host, actual);
      info(`Backup written: ${backupPath}`);

      const result = await executePlan(plan, { client, state, statePath, save: saveState });
      success(`Applied: ${result.created.length} created, ${result.updated.length} updated.`);
      if (result.failed) {
        error(`Stopped at ${result.failed.key}: ${result.failed.message}. State saved up to this point — re-run to resume.`);
        process.exitCode = 1;
      }
    });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/apply.ts tests/apply.test.ts
git commit -m "feat(cli): ct apply — plan, confirm, backup, execute"
```

---

## Task 9: `ct destroy` command

**Files:**
- Create: `src/commands/destroy.ts`
- Test: `tests/destroy.test.ts` (target parsing + reverse ordering + preventDestroy set)

**Interfaces:**
- Consumes: `RESOURCES`, `assertNotPeople`, `confirmTyped`, `writeBackup`, `tierOf` from `engine/graph.js`, `saveState`.
- Produces: `destroyCommand(): Command`; exported helpers `parseTargets(raw: string[]): string[]` and `orderDestroy(state, keys): string[]`.

- [ ] **Step 1: Write the failing test** — create `tests/destroy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTargets, orderDestroy } from "../src/commands/destroy.js";
import { emptyState } from "../src/state/state.js";

describe("parseTargets", () => {
  it("splits commas, trims, and dedupes", () => {
    expect(parseTargets(["a,b", " c ", "a"])).toEqual(["a", "b", "c"]);
  });
});

describe("orderDestroy", () => {
  it("orders higher tiers first (reverse of apply): groups before campuses", () => {
    const state = emptyState("h");
    state.resources.mainz = { type: "campus", id: 0, key: "mainz", fields: {}, adoptedAt: "t", updatedAt: "t" };
    state.resources.team = { type: "group", id: 1, key: "team", fields: {}, adoptedAt: "t", updatedAt: "t" };
    expect(orderDestroy(state, ["mainz", "team"])).toEqual(["team", "mainz"]);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `npx vitest run tests/destroy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/commands/destroy.ts`:

```ts
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CtApiError } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath, saveState, type State } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { RESOURCES } from "../resources/registry.js";
import { assertNotPeople } from "../engine/guard.js";
import { tierOf } from "../engine/graph.js";
import { writeBackup } from "../engine/backup.js";
import { resolveBackupDir } from "./apply.js";
import { confirmTyped } from "../ui/prompt.js";
import { info, warn, success, error } from "../ui.js";

interface DestroyOptions {
  target?: string[];
  config?: string;
  state?: string;
  backupDir?: string;
  force?: boolean;
}

/** Flatten repeated/comma-separated `--target` values into a deduped key list. */
export function parseTargets(raw: string[]): string[] {
  const out: string[] = [];
  for (const chunk of raw) {
    for (const part of chunk.split(",")) {
      const key = part.trim();
      if (key && !out.includes(key)) {
        out.push(key);
      }
    }
  }
  return out;
}

/** Reverse dependency order: highest tier first (children/leaves before their base metadata). */
export function orderDestroy(state: State, keys: string[]): string[] {
  return [...keys].sort((a, b) => tierOf(state.resources[b]!.type) - tierOf(state.resources[a]!.type));
}

export function destroyCommand(): Command {
  return new Command("destroy")
    .description("Explicitly delete managed resources (protected; never implicit)")
    .requiredOption("--target <keys...>", "logical key(s) to destroy (repeatable or comma-separated)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--backup-dir <path>", "directory for the pre-destroy backup (or set CT_BACKUP_DIR)")
    .option("--force", "skip the typed confirmation (preventDestroy is still enforced)")
    .action(async (opts: DestroyOptions) => {
      const targets = parseTargets(opts.target ?? []);
      if (targets.length === 0) {
        throw new Error("No --target given. Destroy never deletes implicitly.");
      }

      const config = resolveConfig();
      const statePath = resolveStatePath(opts.state);
      const state = await loadState(statePath, config.host);

      for (const key of targets) {
        if (!state.resources[key]) {
          throw new Error(`"${key}" is not managed (not in the state file). Nothing to destroy.`);
        }
      }

      // preventDestroy guard: a target still declared with the flag is blocked.
      const desired = await loadConfig(resolveConfigPath(opts.config));
      const protectedKeys = new Set(desired.filter((d) => d.preventDestroy).map((d) => d.key));
      const blocked = targets.filter((k) => protectedKeys.has(k));
      if (blocked.length > 0) {
        throw new Error(`preventDestroy is set for: ${blocked.join(", ")}. Remove the flag in config first.`);
      }

      const ordered = orderDestroy(state, targets);
      const { client } = await authedSession();

      // Backup: fetch each target's current actual values (best-effort; 404 → empty).
      const actual = new Map<string, Record<string, unknown>>();
      for (const key of ordered) {
        const managed = state.resources[key]!;
        const spec = RESOURCES[managed.type];
        if (!spec) {
          continue;
        }
        try {
          const raw = await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
          actual.set(key, spec.managedFields(raw));
        } catch (err) {
          if (!(err instanceof CtApiError && err.status === 404)) {
            throw err;
          }
        }
      }
      const backupPath = await writeBackup(resolveBackupDir(opts.backupDir, statePath), config.host, actual);
      info(`Backup written: ${backupPath}`);

      warn(`About to DELETE: ${ordered.join(", ")}`);
      const expected = targets.length === 1 ? targets[0]! : "destroy";
      const ok = await confirmTyped(expected, { force: opts.force });
      if (!ok) {
        warn("Aborted — nothing deleted.");
        process.exitCode = 1;
        return;
      }

      for (const key of ordered) {
        const managed = state.resources[key]!;
        const spec = RESOURCES[managed.type];
        if (!spec) {
          error(`No write spec for type "${managed.type}" — skipping ${key}.`);
          continue;
        }
        const path = spec.itemPath(managed.id);
        assertNotPeople(path);
        await client.request("DELETE", path);
        delete state.resources[key];
        await saveState(statePath, state);
        success(`Destroyed ${managed.type}.${key} (#${managed.id})`);
      }
    });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/destroy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/destroy.ts tests/destroy.test.ts
git commit -m "feat(cli): ct destroy — explicit, protected, reverse-order deletion"
```

---

## Task 10: Wire commands + integration test + cleanup

**Files:**
- Modify: `src/index.ts`
- Modify: `src/commands/placeholders.ts`
- Test: `tests/cli.test.ts`, `tests/integration.test.ts`

**Interfaces:**
- Consumes: `applyCommand`, `destroyCommand`.
- Produces: `apply`/`destroy` registered on the program; `placeholders.ts` no longer lists them.

- [ ] **Step 1: Write the failing tests.** Append to `tests/cli.test.ts` a check that `apply`/`destroy` are real (have their options, not the "not implemented" stub). First inspect the existing `tests/cli.test.ts` to match its harness, then add:

```ts
import { describe as dCli, it as iCli, expect as eCli } from "vitest";
import { buildProgram } from "../src/index.js";

dCli("apply/destroy are wired", () => {
  iCli("registers apply with --auto-approve", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "apply")!;
    eCli(cmd.options.some((o) => o.long === "--auto-approve")).toBe(true);
  });
  iCli("registers destroy with required --target", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "destroy")!;
    eCli(cmd.options.some((o) => o.long === "--target")).toBe(true);
  });
});
```

Create `tests/integration.test.ts` — the DoD "apply then re-plan shows no drift" against a stateful fake client:

```ts
import { describe, it, expect } from "vitest";
import { buildPlan } from "../src/engine/build.js";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { DesiredResource } from "../src/engine/types.js";

/** A tiny in-memory ChurchTools: campuses store, supports GET/POST/PUT and hierarchy is empty. */
function fakeCt() {
  const campuses = new Map<number, Record<string, unknown>>([[0, { id: 0, name: "Mainz", shortName: "MZ" }]]);
  let nextId = 1;
  return {
    campuses,
    get: async <T>(path: string): Promise<T> => {
      const m = /^\/campuses\/(\d+)$/.exec(path);
      if (m) {
        const c = campuses.get(Number(m[1]));
        if (!c) throw new CtApiError("nf", 404, null);
        return c as T;
      }
      if (path === "/groups/hierarchies") return [] as T;
      throw new CtApiError("nf", 404, null);
    },
    request: async <T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> => {
      if (method === "POST" && path === "/campuses") {
        const id = nextId++;
        campuses.set(id, { id, ...body });
        return { id } as T;
      }
      const m = /^\/campuses\/(\d+)$/.exec(path);
      if (method === "PUT" && m) {
        campuses.set(Number(m[1]), { id: Number(m[1]), ...body });
        return {} as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const noSave = async (_p: string, _s: State) => {};

describe("apply → re-plan shows no drift", () => {
  it("creates a new campus and updates an adopted one, then plans clean", async () => {
    const client = fakeCt();
    const state = emptyState("h");
    // adopt the existing Mainz campus
    state.resources.mz = { type: "campus", id: 0, key: "mz", fields: { name: "Mainz", shortName: "MZ" }, adoptedAt: "t", updatedAt: "t" };

    const desired: DesiredResource[] = [
      { type: "campus", key: "mz", fields: { name: "Mainz City", shortName: "MZ" }, dependsOn: [] },
      { type: "campus", key: "zh", fields: { name: "Zürich", shortName: "ZH" }, dependsOn: [] },
    ];

    const first = await buildPlan(client, state, desired);
    expect(first.plan.items.filter((i) => i.action !== "no-op").length).toBe(2); // 1 update + 1 create

    const result = await executePlan(first.plan, { client, state, statePath: "s", save: noSave });
    expect(result.failed).toBeUndefined();
    expect(result.created).toEqual(["zh"]);
    expect(result.updated).toEqual(["mz"]);

    const second = await buildPlan(client, state, desired);
    expect(second.plan.items.every((i) => i.action === "no-op")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/cli.test.ts tests/integration.test.ts`
Expected: FAIL — apply/destroy are still stubs; integration import chain works but assertions on wiring fail.

- [ ] **Step 3: Implement.** In `src/commands/placeholders.ts`, empty the `PLANNED` array (both verbs now exist):

```ts
const PLANNED: Planned[] = [];
```

In `src/index.ts`, import and register the real commands:

```ts
import { applyCommand } from "./commands/apply.js";
import { destroyCommand } from "./commands/destroy.js";
```

and, after `program.addCommand(planCommand());`:

```ts
  program.addCommand(applyCommand());
  program.addCommand(destroyCommand());
```

(The `for (const cmd of plannedCommands())` loop stays — it just adds nothing now.)

- [ ] **Step 4: Run the whole suite, expect pass**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/commands/placeholders.ts tests/cli.test.ts tests/integration.test.ts
git commit -m "feat(cli): wire apply/destroy; drop placeholders; DoD integration test"
```

---

## Task 11: Docs, live-verify field sets, lint/typecheck/build

**Files:**
- Modify: `README.md`
- Modify: `src/resources/registry.ts` (only if live-verify shows different fields)

- [ ] **Step 1: Typecheck, lint, build, full test.**

Run: `npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`
Expected: all clean. Fix any issues.

- [ ] **Step 2: Live-verify the new type field sets** (requires a logged-in session against the test instance). For each new type, fetch one and confirm the managed fields exist and round-trip:

Run: `node dist/index.js get group/agegroups 2>/dev/null || node dist/index.js get age-group <id>`
(Use whatever `ct get` supports — inspect `src/commands/get.ts` first.) Adjust `managedFields`/`collectionPath` in `src/resources/registry.ts` and its test if the real payload differs. Re-run `npx vitest run tests/registry.test.ts`.

- [ ] **Step 3: Live-verify the DoD end-to-end** on the test instance: adopt a campus, edit its name in a config, `ct plan` (see the `~` diff), `ct apply` (confirm, backup written), `ct plan` again (no changes). Then test destroy-protection: set `preventDestroy` and confirm `ct destroy --target <key>` refuses.

- [ ] **Step 4: Update `README.md`** — add `apply` and `destroy` to the command list with the guardrails (confirmation, backup, never deletes on apply, `preventDestroy`, `--target`). Match the existing README section style.

- [ ] **Step 5: Commit**

```bash
git add README.md src/resources/registry.ts tests/registry.test.ts
git commit -m "docs(phase-4): README apply/destroy; live-verified field sets"
```

---

## Self-review notes

- **Spec coverage:** apply (T6–T8), destroy + preventDestroy (T1, T9), backup (T4, T8, T9), people boundary (T3, used in T7/T9), rate-limit/retry (existing — noted, no task), state-after-each (T7 saves; T9 saves), confirmation (T5, T8, T9), all writable types (T2), DoD integration (T10), live-verify (T11). No gaps.
- **Type consistency:** `ExecuteDeps`/`ExecuteResult`/`BuildResult`/`PromptOptions` names are used identically across tasks. `snapshotFromChanges` is the single field-merge helper. `resolveBackupDir` defined in T8, reused by T9.
- **Placeholder scan:** none — every code step is complete. The only deferred item is the *provisional field sets*, which are explicitly a live-verify step (T11) with a concrete verification command, not a plan gap.
- **Known limitation (documented):** `orderDestroy` uses reverse-tier order only (state doesn't store hierarchy edges), so deleting a parent group before its child within the same tier isn't auto-ordered; acceptable for Phase 4 and noted.
