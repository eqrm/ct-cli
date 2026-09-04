# Writing the config

The desired state lives in a config file (default `ct.config.ts`) that
default-exports a function receiving the DSL:

```ts
export default (ct) => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
  // Reference master data BY NAME, not by hardcoded id: `groupType: "…"` resolves to the
  // per-host group-type id at plan time, so this config is portable across instances (#20).
  ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupType: "ministry_team" });
  // Hierarchy is opt-in and multi-parent: `parents` are managed group keys, each declared
  // in this config. Omit it to leave a group's hierarchy unmanaged; edges to unmanaged
  // groups stay invisible. (`parent:` is unrelated — an ordering hint only, not hierarchy.)
  ct.group({
    key: "mainz_kids_lead",
    name: "Mainz · Kids Leitung",
    groupType: "ministry_team",
    parents: ["mainz_area"],
  });
  // Assign a group to a campus BY KEY: `campus: "mainz"` links to the campus above even though
  // it is created in the same apply (its id is filled in at apply time). The numeric escape
  // hatch still works — `campusId: 3` (or `campusId: null` to clear) targets an existing id.
  ct.group({
    key: "mainz_kids",
    name: "Mainz · Kids",
    groupType: "ministry_team",
    campus: "mainz",
    parents: ["mainz_kids_lead"],
  });
};
```

Every declaration carries a **`key`** — the logical name, unique across the whole
config. It is what the state file maps to a ChurchTools id, what other
declarations reference, and what shows up in `ct plan` output. ChurchTools ids
never appear in the config unless you deliberately put them there.

## Portable references (#20)

Logical fields (`campus`/`groupType` on a group, `groupType` on a permission)
and the inline `ref.*` helper compile to id-free sentinels that a per-host
resolver maps to real ChurchTools ids at plan time — sourced from resources this
tool manages, then from live master-data catalogs matched by name. So one config
file plans and applies unchanged against different instances (ids differ per
host).

An unresolvable name fails the plan with a clear error naming the reference and
where it was used. Raw numeric ids remain a valid escape hatch everywhere; see
[`examples/portable.config.ts`](https://github.com/eqrm/ct-cli/blob/main/examples/portable.config.ts)
for a zero-numeric-id config.

For a group's lifecycle status, prefer the stable technical name, for example
`status: "active"`. ct resolves it through
`/person/masterdata.groupStatuses`. Numeric `groupStatusId` remains supported as
a backward-compatible escape hatch. This catalog is distinct from
`/group/memberstatus` (membership statuses) and `/statuses` (person statuses).

## Campus assignment

`campusId` is a managed group field: `ct plan` shows a campus assign/move/clear
as a normal field update, and `ct adopt group <id>` captures it. Which group
fields are managed vs. deliberately left to the CT UI is recorded in
[`group-field-decisions.md`](group-field-decisions.md).

## Same-named groups (#75)

ChurchTools guards group creation by NAME, not by this tool's logical key —
`POST /groups` 400s (`forbidden.duplicate.group`) if a group with that name
already exists, even when the two are legitimately distinct (e.g. an archived and
an active "Kids Elternabend 2026" event signup). Opt in per-declaration to create
it anyway:

```ts
ct.group({ key: "kids_2026_b", name: "Kids Elternabend 2026", groupTypeId: 2, allowDuplicateName: true });
```

`allowDuplicateName` sends CT's `force: true` on the CREATE request only — it is
never a managed field (not diffed, not in state, not touched on update, and
never adopted). **Never set it as a default**; it exists for the rare
intentional-duplicate case. If a create 400s on this guard without the flag set,
`ct apply`'s stop message explains the likely cause (an unmanaged existing group
that should be adopted with `ct adopt group <id> --key <key>`) and the opt-in as
the alternative.

## Output conventions

Machine-readable output goes to **stdout** (pipe/`jq` it); human status lines go
to **stderr**. So `ct plan --json | jq` and `ct get groups > groups.json` are
always safe, whatever warnings the run prints.

## Going further

- [Permissions](handbuch/permissions.md) — `ct.groupRole`, `ct.groupTypeRole`, `ct.status`
- [Dynamic groups](handbuch/dynamic-groups.md) — the `dynamic` block and the typed query DSL
- [Blueprints](handbuch/blueprints.md) — one function per repeated structure, instantiated per campus
- [Environments](environments.md) — one config, several instances
