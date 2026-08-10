# Entwurf: Forenbeitrag „ChurchTools-Struktur als Code"

> **Status: Entwurf, noch nicht gepostet.** Vor dem Posten bitte die Checkliste
> ganz unten durchgehen — insbesondere die Frage, ob und wie das Repo verlinkt
> wird (es ist derzeit privat) und ob wirklich keine instanzspezifischen Daten
> im Text stehen.
>
> Zielgruppe: das ChurchTools-Forum (deutschsprachig, Du-Ansprache).
> Kategorie-Vorschlag: „Ideen & Austausch" / „Administration".

---

## Titel

**Unsere ChurchTools-Struktur liegt jetzt als Code im Git — mit `plan` und `apply` wie bei Terraform**

---

## Beitrag

Hallo zusammen,

wir verwalten unsere ChurchTools-Instanz seit einiger Zeit nicht mehr nur über
die Oberfläche, sondern beschreiben die **übergreifende Struktur** als Code in
einem Git-Repository und spielen sie über die API ab. Der Ansatz ist von
Terraform geklaut: erst `plan` (zeigt an, was sich ändern würde), dann `apply`
(führt genau das aus). Wir dachten, das ist interessant genug, um es hier zu
teilen — und wir haben ein paar Fragen, bei denen wir uns über Antworten aus
der Community oder von ChurchTools selbst freuen würden.

### Warum überhaupt?

Klicken funktioniert. Es funktioniert nur so lange gut, bis Fragen auftauchen,
die man durch Klicken nicht beantworten kann:

- **„Wer hat dieser Gruppe wann welche Rechte gegeben — und warum?"**
  In der Oberfläche: nicht rekonstruierbar. Als Code: `git log` und der
  Pull Request, in dem es besprochen wurde.
- **„Wir starten einen neuen Standort — bau das bitte genauso auf wie beim
  letzten Mal."**
  In der Oberfläche: eine Stunde Klicken und die Hoffnung, nichts vergessen zu
  haben. Als Code: dieselbe Funktion nochmal aufrufen, mit anderem Parameter.
- **„Können wir das vorher irgendwo gefahrlos ausprobieren?"**
  Mit einer zweiten (Test-)Instanz: dieselbe Konfiguration, anderes Ziel —
  erst dort testen, dann produktiv übernehmen.
- **„Hat da jemand von Hand etwas umgestellt?"**
  Der Plan vergleicht den Ist-Zustand mit dem zuletzt bekannten und meldet
  Abweichungen (Drift), auch wenn wir gerade gar nichts ändern wollen.
- **„Was passiert, wenn ich das jetzt mache?"**
  Genau das ist `plan`: eine Vorschau, bevor irgendetwas geschrieben wird.

### Wie sieht das konkret aus?

Die gewünschte Struktur steht in einer Datei. Ein Ausschnitt:

```ts
export default (ct) => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });

  ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupType: "ministry_team" });
  ct.group({
    key: "mainz_kids_lead",
    name: "Mainz · Kids Leitung",
    groupType: "ministry_team",
    parents: ["mainz_area"],
  });
  ct.group({
    key: "mainz_kids",
    name: "Mainz · Kids",
    groupType: "ministry_team",
    campus: "mainz",
    parents: ["mainz_kids_lead"],
  });
};
```

Wichtig dabei: **keine ChurchTools-IDs im Code.** `groupType: "ministry_team"`
wird beim Planen gegen die Stammdaten der Zielinstanz aufgelöst. Genau deshalb
läuft dieselbe Datei unverändert gegen Test- und Produktivinstanz, obwohl dort
alle IDs unterschiedlich sind.

Der Plan dazu:

```
  + campus.mainz
      name: "Mainz"
      shorty: "MZ"
  + group.mainz_kids_lead
      name: "Mainz · Kids Leitung"
      groupTypeId: 2
  ~ group.mainz_kids (#148)
      campusId: null -> 3

Drift detected (changed in ChurchTools since adoption):
  ! group.mainz_kids (#148): note = "bitte nicht loeschen" (last known "")

Plan: 2 to create, 1 to update, 0 to delete.
```

Bis hierhin wurde noch nichts geschrieben. Erst `apply` führt genau diese
Liste aus — in Abhängigkeitsreihenfolge, also z. B. der Standort vor den
Gruppen, die ihn referenzieren.

### Was wird verwaltet — und was ausdrücklich nicht

**Verwaltet wird das Gerüst:** Standorte, die strukturellen,
rechtetragenden Gruppen, Gruppenhierarchien, Gruppentypen und Rollen,
Berechtigungen sowie Automatikgruppen (dynamische Gruppen inklusive ihrer
Filterregeln).

**Ausdrücklich nicht verwaltet werden Personen und Mitgliedschaften.** Das ist
keine „kommt später"-Einschränkung, sondern eine Grenze im Code: es gibt keinen
Pfad, über den das Werkzeug Personendaten schreiben könnte. Wer Struktur
automatisiert, soll damit nicht versehentlich Menschen aus Gruppen werfen.

Und: **eine Ressource ist nur dann verwaltet, wenn sie ausdrücklich deklariert
oder bewusst übernommen wurde.** Die anderen paar hundert operativen Gruppen
einer Instanz sind für das Werkzeug unsichtbar — sie werden nie angezeigt, nie
geändert und nie zum Löschen vorgeschlagen. Das war uns wichtiger als
Vollständigkeit.

### Leitplanken

Ein Werkzeug, das gegen die produktive Gemeinde-Datenbank schreibt, braucht
mehr als guten Willen:

- `plan` ist der Normalfall, `apply` muss man explizit wollen — mit Rückfrage.
- `apply` **löscht nie**. Wer etwas aus der Konfiguration entfernt, bekommt einen
  Hinweis, keine Löschung. Löschen ist ein eigener Befehl, mit Ziel-Angabe und
  getippter Bestätigung; einzelne Deklarationen lassen sich zusätzlich gegen
  Löschung sperren.
- Vor jedem Schreibvorgang wird der betroffene Bereich als JSON gesichert.
- Geschützte Umgebungen (z. B. die Produktivinstanz) verlangen **immer** die
  getippte Bestätigung des Umgebungsnamens — auch im automatisierten Lauf.
- Jede Zustandsdatei ist an ihren Host gebunden. Eine Test-Zustandsdatei gegen
  die Produktivinstanz zu verwenden, wird verweigert, statt Unsinn anzurichten.
- Der Zugangstoken liegt im Schlüsselbund bzw. in einem CI-Secret, nie im Repo.

### Test → Produktiv

Wir haben eine zweite ChurchTools-Instanz zum Proben. Der Ablauf ist immer
derselbe: Änderung gegen die Testinstanz planen und anwenden, dort prüfen, dass
ein erneuter Plan sauber leer ist, und erst dann gegen die Produktivinstanz
planen und — nach Bestätigung — anwenden. Beide Instanzen haben ihre eigene
Zustandsdatei, beide liegen im Git.

Der Plan zeigt im Kopf die Zielumgebung **und** deren ChurchTools-Version an.
Das klingt nach Kleinigkeit, ist aber der Moment, in dem man merkt, dass Test-
und Produktivinstanz gerade auf unterschiedlichen Versionen laufen — bevor man
etwas überträgt.

### Was uns unterwegs überrascht hat

Zwei Dinge, die vielleicht auch für andere interessant sind, unabhängig davon,
ob ihr so ein Werkzeug einsetzt:

**1. Rechte kommen über zwei unabhängige Wege an eine Gruppe.**
Es gibt Rechte, die an der Rolle *innerhalb einer konkreten Gruppe* hängen, und
Rechte, die an der Rolle *eines ganzen Gruppentyps* hängen. Die Maske
„Berechtigungen verwalten" an einer Gruppe zeigt nur den ersten Weg. Eine Gruppe
kann also völlig unberechtigt aussehen, während die Rechte über den Gruppentyp
vollständig vorhanden und wirksam sind. Das hat bei uns mehr als einmal für
Verwirrung gesorgt, bis wir es verstanden hatten.

**2. Es gibt eine instanzweite Ebene: Rechte am Personenstatus.**
Rechte lassen sich auch an einen Personenstatus hängen — sie gelten dann für
alle Personen mit diesem Status. Das ist der saubere Weg für „das dürfen alle",
statt Rechte einzeln pro Person zu vergeben.

### Fragen in die Runde

- Macht das noch jemand? Wir haben im Forum wenig zu strukturierter,
  versionierter Verwaltung der ChurchTools-Struktur gefunden — ich lasse mich
  gerne auf bestehende Ansätze hinweisen, bevor wir weiter parallel arbeiten.
- Wie geht ihr mit dem Zusammenspiel von Gruppenrollen- und
  Gruppentypenrollen-Rechten um? Habt ihr eine Konvention, die das im Alltag
  durchschaubar hält?
- Und eine Frage an ChurchTools direkt: Die API-Endpunkte für Berechtigungen
  und dynamische Gruppen sind in der Doku als vorläufig markiert. Wir stützen
  uns darauf. Gibt es dazu eine Einschätzung — was ist als stabil gedacht, und
  wo müssen wir mit Änderungen rechnen?

Über Rückmeldungen freue ich mich — auch über kritische. Wenn Interesse
besteht, schreibe ich gerne mehr zu einzelnen Teilen (dynamische Gruppen als
Code, das Berechtigungsmodell, oder wie wir eine bestehende Instanz Schritt für
Schritt übernommen haben, statt alles auf einmal).

Viele Grüße

---

## Checkliste vor dem Posten

- [ ] **Repo-Verlinkung entscheiden.** `eqrm/ct-cli` ist derzeit **privat**. Ein
      Link ins Leere ist schlechter als kein Link. Optionen: (a) ohne Link
      posten und bei Interesse nachliefern, (b) das Tool vorher öffentlich
      machen, (c) auf eine kurze öffentliche Beschreibung verlinken. Der Entwurf
      ist bewusst so geschrieben, dass er **ohne** Link funktioniert.
- [ ] **Gegenlesen lassen** — von einem Menschen, nicht von Claude.
- [ ] **Keine instanzspezifischen Daten**: der Entwurf nennt bewusst keine
      echten Gruppen-IDs, Personen, internen Gruppennamen oder Hostnamen. Vor
      dem Posten nochmal prüfen, falls Beispiele ergänzt wurden. Die IDs im
      Plan-Beispiel (`#148`, `groupTypeId: 2`, `campusId: 3`) sind erfunden.
- [ ] **Kategorie und Titel** an die Forensystematik anpassen.
- [ ] Nach dem Posten: Thread-Link in [#91](https://github.com/eqrm/ct-cli/issues/91)
      und [#92](https://github.com/eqrm/ct-cli/issues/92) hinterlegen.

## Bewusst nicht in diesem Beitrag

Dieser Entwurf ist der **allgemeine** Beitrag („warum Struktur als Code").
Die tiefe, technische Diskussion des Personenstatus-Rechtebereichs — inklusive
der drei konkreten Rückfragen an ChurchTools zu `dataId: -1`, `GET /statuses`
und den schreibbaren Domains — ist ein **eigener** Beitrag und wird in
[#91](https://github.com/eqrm/ct-cli/issues/91) getrackt. Beides in einen
Beitrag zu packen würde beide Anliegen schwächen: der erste will Interesse
wecken, der zweite will präzise Antworten.

Die beiden Absätze unter „Was uns unterwegs überrascht hat" sind die bewusst
verkürzte, für ein allgemeines Publikum geschriebene Fassung — sie behaupten
nur, was wir an einer laufenden Instanz nachgeprüft haben, und keine
API-Details.
