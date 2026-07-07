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
