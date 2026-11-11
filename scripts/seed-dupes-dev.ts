/**
 * Seed (or remove) fictitious duplicate persons on a DEV ChurchTools instance for `ct dupes`.
 *
 *   CT_LIVE_WRITE_HOST=https://your-dev.church.tools npx tsx scripts/seed-dupes-dev.ts
 *   CT_LIVE_WRITE_HOST=https://your-dev.church.tools npx tsx scripts/seed-dupes-dev.ts --cleanup
 *
 * Refuses to run unless CT_LIVE_WRITE_HOST equals the authenticated host (same barrier as the live
 * write tests). Everything it creates is recognisable: persons have a first or last name starting
 * with `Zzd-`, groups are named `zz-dupes-*`. `--cleanup` deletes exactly those.
 *
 * Covers: every match class (exact, middlename, firsttoken, shortform, nameswap, diminutive, fuzzy),
 * the sex veto, a placeholder cluster, digits in names, a pair suppressed by a "Keine Dublette"
 * relationship, pairs where both persons carry an Optigem ID, one pair sharing a dynamic and a
 * static group (with conflicting member fields).
 */
import { CtApiError } from "../src/api/ctClient.js";
import { authedSession } from "../src/api/session.js";
import { loadActivePersons, resolveRelationshipTypes } from "../src/dupes/ct.js";

const PREFIX = "Zzd-";
const GROUP_PREFIX = "zz-dupes-";

interface Seed {
  firstName: string;
  lastName: string;
  email?: string;
  optigemId?: string;
  sexId?: number;
  birthday?: string;
}

const { client } = await authedSession();
const expected = process.env.CT_LIVE_WRITE_HOST?.trim();
if (!expected || client.host !== expected) {
  throw new Error("Set CT_LIVE_WRITE_HOST to exactly the authenticated (dev) host to allow writes.");
}

async function cleanup(): Promise<void> {
  const people = await loadAll();
  for (const p of people.filter((x) => isSeed(x))) {
    await client.request("DELETE", `/persons/${p.id}`);
  }
  const groups = await client.getAll<{ id: number; name: string }>("/groups");
  for (const g of groups.data.filter((x) => x.name.startsWith(GROUP_PREFIX))) {
    await client.request("DELETE", `/groups/${g.id}`);
  }
  console.log("cleanup done");
}

interface Raw {
  id: number;
  firstName: string;
  lastName: string;
}
async function loadAll(): Promise<Raw[]> {
  return (await client.getAll<Raw>("/persons")).data;
}
function isSeed(p: Raw): boolean {
  return p.firstName.startsWith(PREFIX) || p.lastName.startsWith(PREFIX);
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}
if ((await loadAll()).some(isSeed)) throw new Error("Seed data already present; run with --cleanup first.");

const md = await client.get<{
  campuses: Array<{ id: number }>;
  departments: Array<{ id: number }>;
  statuses: Array<{ id: number }>;
  sexes: Array<{ id: number }>;
  groupTypes: Array<{ id: number }>;
}>("/person/masterdata");
const base = {
  campusId: md.campuses[0]!.id,
  departmentIds: [md.departments[0]!.id],
  statusId: md.statuses[0]!.id,
  privacyPolicyAgreementTypeId: 3,
  privacyPolicyAgreementWhoId: 1,
  privacyPolicyAgreementDate: new Date().toISOString().slice(0, 10),
};
const [sexA, sexB] = [md.sexes[0]!.id, md.sexes[1]!.id];

async function create(s: Seed): Promise<number> {
  const body = { ...base, ...s };
  const created = await client.request<{ id: number }>("POST", "/persons?force=true", body);
  return created.id;
}

const ids: Record<string, [number, number]> = {};
let pairNo = 0;
async function pair(name: string, a: Seed, b: Seed): Promise<void> {
  // A shared birthday stands in for the contact data real duplicates have in common.
  pairNo++;
  const birthday = `1990-02-${String(pairNo).padStart(2, "0")}`;
  a = { birthday, ...a };
  b = { birthday, ...b };
  ids[name] = [await create(a), await create(b)];
}

const mail = (n: string): string => `${n}@example.invalid`;
await pair(
  "exact",
  { firstName: "Erika", lastName: `${PREFIX}Alpha`, email: mail("zzd-alpha") },
  { firstName: "Erika", lastName: `${PREFIX}Alpha` },
);
await pair(
  "middlename",
  { firstName: "Anna Marie", lastName: `${PREFIX}Beta` },
  { firstName: "Anna", lastName: `${PREFIX}Beta` },
);
await pair(
  "fuzzy",
  { firstName: "Naomi", lastName: `${PREFIX}Gamma` },
  { firstName: "Nomi", lastName: `${PREFIX}Gamma` },
);
await pair(
  "shortform",
  { firstName: "Christine", lastName: `${PREFIX}Delta` },
  { firstName: "Tine", lastName: `${PREFIX}Delta` },
);
await pair(
  "nameswap",
  { firstName: "Erika", lastName: `${PREFIX}Epsilon` },
  { firstName: `${PREFIX}Epsilon`, lastName: "Erika" },
);
await pair(
  "diminutive",
  { firstName: "Ursula", lastName: `${PREFIX}Zeta` },
  { firstName: "Ursi", lastName: `${PREFIX}Zeta` },
);
await pair(
  "firsttoken",
  { firstName: "Maria Luise", lastName: `${PREFIX}Eta` },
  { firstName: "Maria Anna", lastName: `${PREFIX}Eta` },
);
await pair(
  "sex-veto",
  { firstName: "Andreas", lastName: `${PREFIX}Theta`, sexId: sexA },
  { firstName: "Andrea", lastName: `${PREFIX}Theta`, sexId: sexB },
);
await pair(
  "digits",
  { firstName: "Gruppe1", lastName: `${PREFIX}Kappa` },
  { firstName: "Gruppe2", lastName: `${PREFIX}Kappa` },
);
await pair(
  "suppressed",
  { firstName: "Lena", lastName: `${PREFIX}Lambda`, email: mail("zzd-lambda") },
  { firstName: "Lena", lastName: `${PREFIX}Lambda`, email: mail("zzd-lambda") },
);
for (let i = 0; i < 4; i++) await create({ firstName: "Gast", lastName: `${PREFIX}Iota` });
await pair(
  "optigem-different",
  { firstName: "Mia", lastName: `${PREFIX}My`, optigemId: "ZZD-1001", email: mail("zzd-my") },
  { firstName: "Mia", lastName: `${PREFIX}My`, optigemId: "ZZD-1002" },
);
await pair(
  "optigem-same",
  { firstName: "Noah", lastName: `${PREFIX}Ny`, optigemId: "ZZD-2001" },
  { firstName: "Noah", lastName: `${PREFIX}Ny`, optigemId: "ZZD-2001" },
);

// Relationship that must suppress the pair.
const types = await resolveRelationshipTypes(client);
await client.request("POST", `/persons/${ids["suppressed"]![0]}/relationships`, {
  otherPersonId: ids["suppressed"]![1],
  relationshipTypeId: types.noDuplicate,
});

// Shared groups for the first Optigem pair: one dynamic, one static with conflicting member fields.
const groupType = md.groupTypes[0]!.id;
const newGroup = async (name: string): Promise<number> =>
  (
    await client.request<{ id: number }>("POST", "/groups", {
      name: `${GROUP_PREFIX}${name}`,
      groupTypeId: groupType,
      groupStatusId: 1,
      force: true,
    })
  ).id;
const dynamicGroup = await newGroup("dynamic");
const staticGroup = await newGroup("static");
// A ruleset that matches nobody makes the group dynamic; membership is never refreshed here.
await client.request("PUT", `/dynamicgroups/${dynamicGroup}/ruleset`, {
  dynamicGroupRuleSet: [
    {
      description: "zz-dupes seed",
      shorty: "zz-dupes",
      personIdFieldName: "person.id",
      importance: 0,
      query: {
        method: "ChurchQuery",
        params: {
          groupBy: ["person.id"],
          filter: { "==": [{ var: "person.id" }, -1] },
          primaryEntityAlias: "person",
          responseFields: ["person.id"],
        },
      },
      process: {
        groupOnly: { active: { handleMembership: { groupMemberStatus: "none" } } },
        queryResultOnly: { none: { handleMembership: { groupMemberStatus: "active" } } },
        groupAndQueryResult: {},
      },
    },
  ],
});
// Only groups with an active status count as dynamic (they are what GET /dynamicgroups lists).
await client.request("PUT", `/dynamicgroups/${dynamicGroup}/status`, { dynamicGroupStatus: "active" });
const field = async (name: string, type: string): Promise<number> =>
  (
    await client.request<{ id: number }>("POST", `/groups/${staticGroup}/memberfields/group`, {
      name,
      fieldTypeCode: type,
      securityLevel: 1,
      useInRegistrationForm: false,
      requiredInRegistrationForm: false,
    })
  ).id;
const paid = await field("Paid", "checkbox");
const tribe = await field("Tribe", "text");
const [p1, p2] = ids["optigem-different"]!;
for (const g of [dynamicGroup, staticGroup]) {
  for (const p of [p1, p2]) {
    try {
      await client.request("PUT", `/groups/${g}/members/${p}`, {});
    } catch (err) {
      console.log(
        `could not add a seed person to a group (HTTP ${err instanceof CtApiError ? err.status : "?"})`,
      );
    }
  }
}
await client.request("PATCH", `/groups/${staticGroup}/members/${p1}`, {
  fields: { [paid]: true, [tribe]: "Alpha" },
});
await client.request("PATCH", `/groups/${staticGroup}/members/${p2}`, { fields: { [tribe]: "Beta" } });

const active = await loadActivePersons(client, "optigemId");
console.log(
  `seeded; ${active.filter((p) => p.firstName.startsWith(PREFIX) || p.lastName.startsWith(PREFIX)).length} seed persons active`,
);
console.log(JSON.stringify(ids));
