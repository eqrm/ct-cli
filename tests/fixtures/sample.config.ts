import type { ConfigContext } from "../../src/config/context.js";

export default (ct: ConfigContext): void => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
  ct.group({ key: "kids_lead", name: "Kids Leitung", parent: "mainz" });
};
