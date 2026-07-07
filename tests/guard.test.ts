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
