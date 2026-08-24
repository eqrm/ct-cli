---
title: ChurchTools-Grundlagen (ct-cli)
sources: []
sources_exempt_reason: "Section index — links and framing only, no code behaviour to keep in sync."
reviewed: 2026-08-10
---

# ChurchTools-Grundlagen

These pages are the **generic ChurchTools reference**: how ChurchTools' own
permission model, dynamic groups, field definitions and reusable structure
patterns actually behave — independent of any one instance.

They were written while building [`ct-cli`](https://github.com/eqrm/ct-cli), a
structure-as-code CLI that reconciles a ChurchTools instance's scaffold from
versioned desired-state code. Much of what is written down here is not in the
official API documentation; it was established by probing live instances, and
each page marks explicitly what was **verified** and what is still an
**assumption**.

## Where each kind of documentation lives

| Layer                             | Repo                                             | Example                                                      |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| **Generic ChurchTools behaviour** | `ct-cli` `docs/handbuch/` (these pages)          | "A `group_type_role` grant reaches every group of that type" |
| **One instance's structure**      | that organisation's private config repo, `docs/` | "Which Bereiche exist here and why"                          |
| **Tool-specific how-tos**         | the relevant tool's own Handbuch                 | "How to run check-in"                                        |

## The pages

- **[Permissions](permissions.md)** — the `group_role`, `group_type_role` and
  person-`status` grant domains; what a `domainId` actually is per domain; scope
  resolution and the `-1` "all values" sentinel; which grants are yours versus
  the platform's system baseline.
- **[Dynamic groups](dynamic-groups.md)** — ChurchTools auto-groups: the
  ruleset/status model, the typed ChurchQuery DSL, how membership recompute is
  triggered, and how a captured ruleset is made portable across instances.
- **[Field definitions](field-definitions.md)** — the person master-data model,
  security levels, and person/group custom-field _definitions_: what is readable
  over REST, what is writable, and where the boundary to per-record values runs.
- **[Group member fields](group-member-fields.md)** — the field definitions a
  group asks its members for: why their identity is scoped by the owning group,
  how they are adopted portably (no ChurchTools ids), and why nothing is ever
  deleted just because it left the config.
- **[Blueprints](blueprints.md)** — describing a repeated structure (e.g. one
  campus's area scaffold) once and instantiating it per campus.

!!! note "Language"
These pages are English while the rest of the Handbuch is German. That is a
known, deliberate mismatch — they are placed here first and translated (or
relocated) by the follow-on content work; see
[ct-cli#89](https://github.com/eqrm/ct-cli/issues/89).
