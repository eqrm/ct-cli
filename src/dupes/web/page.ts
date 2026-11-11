/**
 * The single page of the `ct dupes review` browser UI, modelled on ChurchTools' "Dubletten
 * überprüfen" page and its "Welche Daten sollen übernommen werden?" dialog. Plain DOM, no
 * framework, no external requests. Every value from ChurchTools is inserted as text, never as
 * HTML. The API token comes from the URL fragment and is sent as a header.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dubletten überprüfen · ct dupes</title>
<style>
:root {
  --nav: #13284f; --bg: #eef2f7; --card: #fff; --line: #dfe4ec; --text: #1c2433; --muted: #66708a;
  --blue: #1f5fe0; --green: #0fb655; --green-bg: #dcf8e6; --red: #e8323c; --red-bg: #fde0e1;
  --cell: #f1f4f9; --yellow-bg: #fff6d6;
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Lato, sans-serif; color: var(--text); background: var(--bg); }
button { font: inherit; cursor: pointer; }
header { background: var(--nav); color: #fff; padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
header .brand { font-weight: 700; }
header .host { opacity: .75; font-size: 13px; }
header .spacer { flex: 1; }
header .who { font-size: 13px; opacity: .85; }
header button { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.4); border-radius: 6px; padding: 4px 12px; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 80px; }
h1 { font-size: 30px; margin: 0 0 24px; }
.search { width: 100%; padding: 10px 14px; border: 1px solid #c9d1de; border-radius: 6px; font: inherit; background: #fff; }
.tabs { display: flex; gap: 6px; margin: 28px 0 0; flex-wrap: wrap; align-items: flex-end; border-bottom: 1px solid var(--line); }
.tab { background: #fff; border: 1px solid var(--line); border-bottom: none; border-radius: 6px 6px 0 0; padding: 8px 14px; text-align: left; min-width: 90px; }
.tab b { display: block; font-size: 18px; }
.tab.on { background: var(--blue); color: #fff; border-color: var(--blue); }
.tiers { margin-left: auto; display: flex; gap: 4px; padding-bottom: 6px; }
.chip { border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 2px 10px; font-size: 13px; }
.chip.on { background: var(--text); color: #fff; border-color: var(--text); }
.pair { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 22px 28px 16px; margin-top: 18px; }
.pair .meta { font-size: 12px; color: var(--muted); margin-bottom: 10px; display: flex; gap: 10px; flex-wrap: wrap; }
.pair .meta .tier { font-weight: 700; color: var(--text); }
.people { display: grid; grid-template-columns: 1fr 60px 1fr; align-items: start; }
.person { border: 1px solid var(--line); border-radius: 8px; padding: 26px 12px 18px; text-align: center; position: relative; margin-top: 12px; }
.badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); color: #fff; font-weight: 700; font-size: 13px; padding: 3px 9px; border-radius: 4px; }
.badge.o { background: var(--green); } .badge.d { background: var(--red); }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: #93a0b5; color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.person .name { font-size: 19px; font-weight: 700; margin: 10px 0 12px; word-break: break-word; }
.facts { display: inline-flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.fact { background: var(--cell); border-radius: 4px; padding: 4px 9px; font-size: 13px; }
.fact span { display: block; color: var(--muted); font-size: 12px; }
.swap { background: none; border: none; color: var(--blue); font-size: 20px; margin-top: 40px; }
.actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.actions .grow { flex: 1; }
.btn { border: 1px solid #c4cdda; background: #fff; color: var(--blue); border-radius: 6px; padding: 6px 12px; font-weight: 600; font-size: 14px; }
.btn.red { color: var(--red); }
.btn.primary { background: var(--blue); color: #fff; border-color: var(--blue); }
.btn:disabled { opacity: .5; cursor: default; }
.state { font-size: 13px; font-weight: 700; }
.state.merged { color: var(--green); } .state.dismissed { color: var(--red); }
.empty { color: var(--muted); text-align: center; padding: 48px 0; }
.more { display: block; margin: 20px auto 0; }
/* dialog */
.overlay { position: fixed; inset: 0; background: rgba(20,30,50,.45); display: flex; align-items: stretch; justify-content: center; padding: 24px; z-index: 10; }
.dialog { background: #fff; border-radius: 8px; width: min(1440px, 100%); display: flex; flex-direction: column; overflow: hidden; }
.dialog > .top { padding: 10px 24px; border-bottom: 1px solid var(--line); font-size: 14px; color: var(--muted); display: flex; justify-content: space-between; align-items: center; }
.x { border: 1px solid var(--line); background: #fff; border-radius: 50%; width: 30px; height: 30px; }
.scroll { overflow: auto; flex: 1; padding: 20px 24px; }
.dialog h2 { font-size: 26px; margin: 0 0 18px; }
.cmp { border: 1px solid var(--line); border-radius: 8px; }
.cmp-head { display: grid; grid-template-columns: 22% 1fr 140px 1fr; gap: 0; padding: 16px; align-items: center; }
.cmp-head .swaplink { text-align: center; color: var(--blue); background: none; border: none; font-weight: 600; }
.grid { display: grid; grid-template-columns: 22% 1fr 44px 1fr 44px 1fr; }
.grid > div { padding: 12px 16px; border-top: 1px solid var(--line); min-height: 48px; display: flex; align-items: center; gap: 8px; word-break: break-word; }
.grid .hdr { font-weight: 700; position: sticky; top: -20px; background: #fff; z-index: 1; }
.grid .sec { grid-column: 1 / -1; font-size: 20px; font-weight: 700; padding-top: 22px; }
.grid .sub { grid-column: 1 / -1; font-weight: 700; background: #fafbfd; flex-wrap: wrap; }
.grid .note { color: #6b7280; margin-left: 4px; }
.grid .sub .plan { font-weight: 400; color: #7a5b00; background: var(--yellow-bg); border-radius: 4px; padding: 2px 8px; font-size: 13px; }
.grid .val { background: var(--cell); }
.grid .pick { cursor: pointer; }
.grid .pick:hover { outline: 2px solid #b7c8f2; outline-offset: -2px; }
.grid .chosen { background: var(--green-bg); }
.grid .lost { background: var(--red-bg); }
.grid .arrow { justify-content: center; padding: 4px; }
.arr { width: 40px; height: 40px; border: 2px solid transparent; border-radius: 8px; background: none; color: var(--text); font-size: 18px; cursor: pointer; }
.arr:hover { background: #eef0f4; }
.arr.on { border-color: #3a4456; background: #eef0f4; }
.grid .res { background: var(--cell); }
.grid .res .clear { margin-left: auto; border: none; background: none; color: var(--muted); font-size: 16px; }
.grid .res.cleared { color: var(--muted); font-style: italic; }
.grid .label { color: var(--text); }
.star { border: none; background: none; font-size: 17px; color: #9aa6b8; padding: 0; }
.star.on { color: #f0a400; }
.toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-weight: 400; font-size: 14px; }
.foot { border-top: 1px solid var(--line); padding: 12px 24px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.foot .pager { flex: 1; display: flex; justify-content: center; align-items: center; gap: 10px; }
.round { border: 1px solid #c4cdda; background: #fff; color: var(--blue); border-radius: 6px; width: 36px; height: 34px; }
.msg { margin: 0 0 14px; padding: 10px 14px; border-radius: 6px; }
.msg.ok { background: var(--green-bg); } .msg.err { background: var(--red-bg); }
.busy { opacity: .6; pointer-events: none; }
@media (max-width: 760px) {
  .people { grid-template-columns: 1fr; } .swap { margin: 8px auto 0; }
  .grid { grid-template-columns: 1fr 1fr; } .grid .arrow { display: none; }
  .cmp-head { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<header>
  <span class="brand">ct dupes</span><span class="host" id="host"></span>
  <span class="spacer"></span><span class="who" id="who"></span>
  <button id="quit" title="Server beenden und zurück ins Terminal">Beenden</button>
</header>
<main id="app"><p class="empty">Lade…</p></main>
<div id="layer"></div>
<script>
"use strict";
var TOKEN = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
var S = { list: null, tab: "open", tier: null, q: "", limit: 30, swapped: {}, dlg: null };

function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
  el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
}
function fill(el) {
  el.replaceChildren();
  for (var i = 1; i < arguments.length; i++) add(el, arguments[i]);
}
function api(path, body) {
  return fetch(path, {
    method: body ? "POST" : "GET",
    headers: Object.assign({ "X-Ct-Dupes-Token": TOKEN }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    });
  });
}
function fmtDate(s) { if (!s) return ""; var p = s.split("-"); return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : s; }
function initials(name) {
  var p = (name || "").trim().split(/\s+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function personCard(kind, p) {
  return h("div", { class: "person" },
    h("span", { class: "badge " + (kind === "o" ? "o" : "d") }, kind === "o" ? "Original" : "Duplikat"),
    h("span", { class: "avatar" }, initials(p.name)),
    h("div", { class: "name" }, p.name || "(ohne Namen)"),
    h("div", { class: "facts" },
      h("div", { class: "fact" }, h("span", null, "ID"), p.id),
      h("div", { class: "fact" }, h("span", null, "Erstellt am"), fmtDate(p.created) || "–"),
      h("div", { class: "fact" }, h("span", null, "Letzter Login"), fmtDate(p.login) || "Nie")));
}

/* ---------- list ---------- */
function filtered() {
  var q = S.q.toLowerCase();
  return S.list.candidates.filter(function (c) {
    if (c.state !== S.tab) return false;
    if (S.tier && c.tier !== S.tier) return false;
    if (q && (c.original.name + " " + c.duplicate.name + " " + c.original.id + " " + c.duplicate.id).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}
function sides(c) { return S.swapped[c.index] ? [c.duplicate, c.original] : [c.original, c.duplicate]; }
function renderList() {
  var app = document.getElementById("app");
  var all = S.list.candidates;
  var count = function (st) { return all.filter(function (c) { return c.state === st; }).length; };
  var list = filtered();
  var tab = function (st, label) {
    return h("button", { class: "tab" + (S.tab === st ? " on" : ""), onclick: function () { S.tab = st; S.limit = 30; renderList(); } },
      h("b", null, count(st)), label);
  };
  var chip = function (t, label) {
    return h("button", { class: "chip" + (S.tier === t ? " on" : ""), onclick: function () { S.tier = t; S.limit = 30; renderList(); } }, label);
  };
  var search = h("input", { class: "search", placeholder: "Suche (Name oder ID)", value: S.q,
    oninput: function (e) { S.q = e.target.value; S.limit = 30; renderList(); var s = document.querySelector(".search"); s.focus(); s.setSelectionRange(S.q.length, S.q.length); } });
  fill(app,
    h("h1", null, "Dubletten überprüfen"),
    search,
    h("div", { class: "tabs" }, tab("open", "Überprüfen"), tab("merged", "Zusammengeführt"), tab("dismissed", "Keine Dublette"),
      h("div", { class: "tiers" }, chip(null, "Alle"), chip("T1", "T1"), chip("T2", "T2"), chip("T3", "T3"))),
    list.length === 0 ? h("p", { class: "empty" }, "Keine Paare.") : null,
    list.slice(0, S.limit).map(pairCard),
    list.length > S.limit ? h("button", { class: "btn more", onclick: function () { S.limit += 30; renderList(); } }, "Weitere " + Math.min(30, list.length - S.limit) + " anzeigen") : null
  );
}
function pairCard(c) {
  var s = sides(c);
  var open = c.state === "open";
  return h("div", { class: "pair" },
    h("div", { class: "meta" }, h("span", { class: "tier" }, c.tier), h("span", null, "Score " + c.score), h("span", null, "Match: " + c.matchClass),
      h("span", null, "Quelle: " + (c.source === "ct" ? "ChurchTools" : c.source === "both" ? "ct dupes + ChurchTools" : "ct dupes")),
      !open ? h("span", { class: "state " + c.state }, c.state === "merged" ? "Zusammengeführt" : "Keine Dublette") : null),
    h("div", { class: "people" }, personCard("o", s[0]),
      h("div", { style: "text-align:center" }, open ? h("button", { class: "swap", title: "Original und Duplikat tauschen",
        onclick: function () { S.swapped[c.index] = !S.swapped[c.index]; renderList(); } }, "⇄") : null),
      personCard("d", s[1])),
    open ? h("div", { class: "actions" },
      h("button", { class: "btn red", onclick: function (e) { dismiss(c, e.target); } }, "Als \"Keine Dublette\" markieren"),
      h("span", { class: "grow" }),
      h("button", { class: "btn", onclick: function () { openDialog(c.index); } }, "Vergleichen und zusammenführen")) : null);
}
function dismiss(c, btn) {
  btn.disabled = true;
  api("/api/dismiss", { index: c.index }).then(function (r) {
    c.state = "dismissed"; renderList(); toast(r.messages[0], true);
  }, function (e) { btn.disabled = false; toast(e.message, false); });
}
function toast(text, ok) {
  var app = document.getElementById("app");
  var m = h("p", { class: "msg " + (ok ? "ok" : "err") }, text);
  app.insertBefore(m, app.children[1] || null);
  setTimeout(function () { m.remove(); }, 6000);
}

/* ---------- dialog ---------- */
function openList() { return filtered(); }
function openDialog(index) {
  S.dlg = { index: index, pair: null, msg: null, ok: true, identical: false, loading: true, done: false };
  renderDialog();
  load();
}
function load() {
  var d = S.dlg;
  d.loading = true; renderDialog();
  api("/api/pair", { index: d.index, swapped: !!S.swapped[d.index] }).then(function (r) {
    if (S.dlg !== d) return;
    d.loading = false;
    if (r.gone) { d.pair = null; d.msg = [r.message]; d.ok = false; d.done = true; refresh(); }
    else d.pair = r.pair;
    renderDialog();
  }, function (e) { if (S.dlg !== d) return; d.loading = false; d.msg = [e.message]; d.ok = false; renderDialog(); });
}
function refresh() { api("/api/list").then(function (l) { S.list = l; renderList(); }); }
function closeDialog() { S.dlg = null; document.getElementById("layer").replaceChildren(); renderList(); }
function step(delta) {
  var list = S.list.candidates.filter(function (c) { return c.state === "open" && (!S.tier || c.tier === S.tier); });
  var at = list.findIndex(function (c) { return c.index === S.dlg.index; });
  var next = list[at + delta] || (at < 0 ? list[0] : null);
  if (next) openDialog(next.index); else closeDialog();
}
function plan(g) {
  if (g.dynamic) return "Auto-Gruppe: Duplikat wird entfernt";
  var taken = g.items.filter(function (i) { return i.choice === "duplicate" && i.differs; }).map(function (i) { return i.label; });
  return taken.length === 0 ? "Mitgliedschaft des Originals bleibt, Duplikat wird entfernt"
    : "Original übernimmt " + taken.join(", ") + " vom Duplikat; Duplikat wird entfernt";
}
function resultText(f) { return f.choice === "original" ? f.original : f.choice === "duplicate" ? f.duplicate : ""; }
function conflicts(p) {
  return p.fields.filter(function (f) { return f.differs && f.original && f.duplicate; }).length +
    p.groups.reduce(function (n, g) { return n + g.items.filter(function (i) { return i.differs && i.original && i.duplicate; }).length; }, 0);
}
function arrow(show, on, title, glyph, onclick) {
  return h("div", { class: "arrow" }, show ? h("button", { class: "arr" + (on ? " on" : ""), title: title, onclick: onclick }, glyph) : null);
}
function valueRow(label, row, onPick, canClear) {
  var o = row.choice === "original", dsel = row.choice === "duplicate";
  var cells = [
    h("div", { class: "label" }, label),
    h("div", { class: "val pick" + (o ? " chosen" : row.differs && row.original ? " lost" : ""), title: "Wert des Originals übernehmen",
      onclick: function () { onPick("original"); } }, row.original),
    arrow(!!row.original, o, "Wert des Originals übernehmen", "→", function () { onPick("original"); }),
    h("div", { class: "res" + (row.choice === "none" ? " cleared" : "") }, row.choice === "none" ? "(leer)" : resultText(row),
      canClear && row.choice !== "none" ? h("button", { class: "clear", title: "Feld leeren", onclick: function () { onPick("none"); } }, "×") : null),
    arrow(!!row.duplicate, dsel, "Wert des Duplikats übernehmen", "←", function () { onPick("duplicate"); }),
    h("div", { class: "val pick" + (dsel ? " chosen" : row.differs && row.duplicate ? " lost" : ""), title: "Wert des Duplikats übernehmen",
      onclick: function () { onPick("duplicate"); } }, row.duplicate)
  ];
  return cells;
}
function renderDialog() {
  var d = S.dlg, layer = document.getElementById("layer");
  if (!d) { layer.replaceChildren(); return; }
  var p = d.pair;
  var list = S.list.candidates.filter(function (c) { return c.state === "open" && (!S.tier || c.tier === S.tier); });
  var at = list.findIndex(function (c) { return c.index === d.index; });
  var body = [];
  if (d.msg) body.push(h("div", { class: "msg " + (d.ok ? "ok" : "err") }, d.msg.map(function (m) { return h("div", null, m); })));
  if (d.loading) body.push(h("p", { class: "empty" }, "Lade Paar…"));
  if (p && !d.loading) {
    var g = [];
    var hdr = [
      h("div", { class: "hdr" }, (conflicts(p) === 1 ? "1 Konflikt" : conflicts(p) + " Konflikte") + " überprüfen"),
      h("div", { class: "hdr" }, "Original"), h("div", { class: "hdr" }),
      h("div", { class: "hdr" }, "Vorschlag für Zusammenführung"), h("div", { class: "hdr" }),
      h("div", { class: "hdr" }, "Duplikat", h("label", { class: "toggle" }, "Identische Felder",
        h("input", { type: "checkbox", checked: d.identical, onchange: function (e) { d.identical = e.target.checked; renderDialog(); } })))
    ];
    g.push(hdr);
    g.push(h("div", { class: "sec" }, "Sonstiges"));
    g.push(h("div", { class: "label" }, "Gruppen"), h("div", { class: "val" }, p.groupCounts.original + " Gruppen"), h("div"),
      h("div", { class: "res" }, (p.groupCounts.original + p.groupCounts.duplicate - p.groupCounts.both) + " Gruppen (davon " + p.groupCounts.both + " gemeinsam)"),
      h("div"), h("div", { class: "val" }, p.groupCounts.duplicate + " Gruppen"));
    var sections = ["Adresse", "Informationen", "Kategorie", "Bereich", "Finanzen"];
    sections.forEach(function (sec) {
      var rows = p.fields.filter(function (f) { return f.section === sec && (d.identical || f.differs); });
      var emails = sec === "Adresse" ? p.emails.filter(function (e) { return d.identical || !(e.inOriginal && e.inDuplicate); }) : [];
      if (rows.length === 0 && emails.length === 0) return;
      g.push(h("div", { class: "sec" }, sec === "Finanzen" ? "Finanzen (Optigem)" : sec));
      rows.forEach(function (f) {
        g.push(valueRow(f.label, f, function (side) { f.choice = side; d.msg = null; renderDialog(); }, true));
      });
      emails.forEach(function (e) {
        var star = h("button", { class: "star" + (e.isDefault ? " on" : ""), title: "Als Standard-Adresse setzen",
          onclick: function () { p.emails.forEach(function (x) { x.isDefault = x === e; }); e.include = true; renderDialog(); } }, e.isDefault ? "★" : "☆");
        var setInclude = function (on) {
          e.include = on;
          if (!on && e.isDefault) { e.isDefault = false; var n = p.emails.find(function (x) { return x.include; }); if (n) n.isDefault = true; }
          if (on && !p.emails.some(function (x) { return x.isDefault; })) e.isDefault = true;
          renderDialog();
        };
        var box = h("input", { type: "checkbox", checked: e.include, title: "Adresse übernehmen",
          onchange: function (ev) { setInclude(ev.target.checked); } });
        var flip = function () { setInclude(!e.include); };
        g.push(h("div", { class: "label" }, e.label, star),
          h("div", { class: "val" + (e.inOriginal ? (e.include ? " chosen" : " lost") : "") }, e.inOriginal ? e.address : ""),
          arrow(e.inOriginal, e.inOriginal && e.include, "Adresse übernehmen oder weglassen", "→", flip),
          h("div", { class: "res" + (e.include ? "" : " cleared") }, box, e.include ? e.address : "(nicht übernehmen)"),
          arrow(e.inDuplicate, !e.inOriginal && e.include, "Adresse übernehmen oder weglassen", "←", flip),
          h("div", { class: "val" + (e.inDuplicate ? (e.include ? " chosen" : " lost") : "") }, e.inDuplicate ? e.address : "",
            e.duplicateType ? h("span", { class: "note", title: "Typ beim Duplikat; übernommen wird der Typ des Originals" }, " (" + e.duplicateType + ")") : null));
      });
    });
    if (p.groups.length > 0) {
      g.push(h("div", { class: "sec" }, "Gemeinsame Gruppen"));
      p.groups.forEach(function (gr) {
        g.push(h("div", { class: "sub" }, gr.title + (gr.dynamic ? " (Auto-Gruppe)" : ""), h("span", { class: "plan" }, plan(gr))));
        gr.items.filter(function (i) { return d.identical || i.differs; }).forEach(function (i) {
          g.push(valueRow(i.label, i, function (side) { if (side === "none") return; i.choice = side; renderDialog(); }, false));
        });
      });
    }
    body.push(h("h2", null, "Welche Daten sollen übernommen werden?"),
      h("div", { class: "cmp" },
        h("div", { class: "cmp-head" }, h("div"), personCard("o", p.original),
          h("button", { class: "swaplink", onclick: function () { S.swapped[d.index] = !S.swapped[d.index]; d.msg = null; load(); } }, "⇄ Original und Duplikat tauschen"),
          personCard("d", p.duplicate)),
        h("div", { class: "grid" }, g)));
  }
  var canAct = p && !d.loading && !d.done;
  var old = layer.querySelector(".scroll");
  var keep = old && S.scrolled === d && !d.loading ? old.scrollTop : 0;
  S.scrolled = d;
  layer.replaceChildren(h("div", { class: "overlay", onclick: function (e) { if (e.target === e.currentTarget) closeDialog(); } },
    h("div", { class: "dialog" + (d.busy ? " busy" : "") },
      h("div", { class: "top" }, "Dubletten überprüfen", h("button", { class: "x", title: "Schließen", onclick: closeDialog }, "×")),
      h("div", { class: "scroll" }, body),
      h("div", { class: "foot" },
        h("button", { class: "btn", onclick: closeDialog }, "Abbrechen"),
        h("button", { class: "btn red", disabled: !canAct, onclick: dialogDismiss }, "Als \"Keine Dublette\" markieren"),
        h("div", { class: "pager" },
          h("button", { class: "round", title: "Vorheriges Paar", disabled: at <= 0, onclick: function () { step(-1); } }, "←"),
          at >= 0 ? "Seite " + (at + 1) + " von " + list.length : "",
          h("button", { class: "round", title: "Nächstes Paar (überspringen)", onclick: function () { step(1); } }, "→")),
        h("button", { class: "btn primary", disabled: !canAct, onclick: doMerge }, "Zusammenführen")))));
  layer.querySelector(".scroll").scrollTop = keep;
}
function dialogDismiss() {
  var d = S.dlg; d.busy = true; renderDialog();
  api("/api/dismiss", { index: d.index }).then(function (r) {
    d.busy = false; markState(d.index, "dismissed"); afterAction(r.messages, true);
  }, function (e) { d.busy = false; d.msg = [e.message]; d.ok = false; renderDialog(); });
}
function markState(index, st) { S.list.candidates[index].state = st; }
function afterAction(messages, ok) {
  var d = S.dlg;
  if (!ok) { d.msg = messages; d.ok = false; renderDialog(); return; }
  var from = d.index;
  var list = S.list.candidates.filter(function (c) { return c.state === "open" && (!S.tier || c.tier === S.tier); });
  var next = list.find(function (c) { return c.index > from; }) || list[0];
  if (!next) { closeDialog(); toast(messages.join(" "), true); return; }
  openDialog(next.index);
  S.dlg.msg = messages; S.dlg.ok = true;
}
function choices(p) {
  var fields = {}; p.fields.forEach(function (f) { fields[f.key] = f.choice; });
  var groups = {}; p.groups.forEach(function (g) { var m = {}; g.items.forEach(function (i) { m[i.key] = i.choice; }); groups[g.id] = m; });
  return { fields: fields, emails: p.emails.map(function (e) { return { index: e.index, include: e.include, isDefault: e.isDefault }; }), groups: groups };
}
function doMerge() {
  var d = S.dlg; d.busy = true; renderDialog();
  api("/api/merge", { index: d.index, swapped: !!S.swapped[d.index], choices: choices(d.pair) }).then(function (r) {
    d.busy = false;
    if (r.ok) markState(d.index, "merged");
    afterAction(r.messages, r.ok);
  }, function (e) { d.busy = false; d.msg = [e.message]; d.ok = false; renderDialog(); });
}

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && S.dlg) closeDialog();
});
document.getElementById("quit").addEventListener("click", function () {
  api("/api/quit", {}).finally(function () {
    document.getElementById("app").replaceChildren(h("p", { class: "empty" }, "Beendet. Dieses Fenster kann geschlossen werden."));
    document.getElementById("layer").replaceChildren();
  });
});
api("/api/list").then(function (l) {
  S.list = l;
  document.getElementById("host").textContent = l.host.replace(/^https?:\/\//, "") + (l.redacted ? " · redigiert" : "");
  document.getElementById("who").textContent = l.operator;
  renderList();
}, function (e) {
  document.getElementById("app").replaceChildren(h("p", { class: "empty" }, "Keine Verbindung: " + e.message));
});
</script>
</body>
</html>
`;
