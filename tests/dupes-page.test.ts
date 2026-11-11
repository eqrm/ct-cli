import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../src/dupes/web/page.js";

// No DOM library is a dependency, so these check the inline script's structure and syntax.
const script = /<script>([\s\S]*)<\/script>/.exec(PAGE_HTML)?.[1] ?? "";

describe("ct dupes review page script", () => {
  it("is syntactically valid", () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });

  it("keeps the token in sessionStorage and explains a rejected token", () => {
    expect(script).toContain('sessionStorage.setItem("ctDupesToken"');
    expect(script).toContain('sessionStorage.getItem("ctDupesToken")');
    expect(script).toContain("history.replaceState");
    expect(script).toContain("r.status === 403");
    expect(script).toContain("erneut öffnen");
  });

  it("never dereferences S.dlg after a request and blocks closing while busy", () => {
    const merge = script.slice(script.indexOf("function dialogDismiss"), script.indexOf("function choices"));
    expect(merge).not.toMatch(/var d = S\.dlg;\s*\n\s*if \(!ok\)/);
    expect(merge).toContain("function afterAction(d, messages, ok)");
    expect(merge).toContain("if (S.dlg !== d)");
    expect(script).toContain("function requestClose() { if (!isBusy()) closeDialog(); }");
    expect(script).not.toMatch(/onclick: closeDialog/);
    expect(script).toContain('e.key === "Escape" && S.dlg) requestClose()');
  });

  it("labels every cell for the narrow one-column layout", () => {
    const narrow = PAGE_HTML.slice(PAGE_HTML.indexOf("@media (max-width: 760px)"));
    expect(narrow).toContain("attr(data-cap)");
    expect(narrow).toContain(".gap");
    expect(narrow).toContain("grid-template-columns: minmax(0, 1fr)");
    for (const cap of ["Original", "Ergebnis", "Duplikat"]) expect(script).toContain(`"data-cap": "${cap}"`);
    expect(script).not.toMatch(/h\("div"\), h\("div", \{ class: "res"/);
  });

  it("keeps the search input persistent, handles composition and pages through the filtered list", () => {
    expect(script).toContain("compositionstart");
    expect(script).toContain("compositionend");
    expect(script).toContain("function pagerList(keep)");
    expect(script).not.toMatch(
      /h\("input", \{ class: "search"[\s\S]{0,200}renderList\(\)[\s\S]{0,20}\}\);\s*\n\s*fill\(app/,
    );
    const render = script.slice(script.indexOf("function renderList"), script.indexOf("function pairCard"));
    expect(render).not.toContain("search");
    expect(script.slice(script.indexOf("function step"), script.indexOf("function plan"))).toContain(
      "pagerList(",
    );
  });
});
