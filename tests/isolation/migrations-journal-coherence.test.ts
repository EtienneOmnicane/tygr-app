/**
 * Garde de cohérence DISQUE ⇆ JOURNAL des migrations Drizzle.
 *
 * POURQUOI cette suite existe (le faux-vert qu'elle ferme) :
 * les ~21 suites d'isolation appliquent les migrations en lisant le DISQUE —
 * `readdirSync(drizzle/migrations).filter(.sql).sort()` — et JAMAIS le
 * `_journal.json`. La PRODUCTION, elle, applique les migrations via le runner
 * Drizzle, qui suit `_journal.json` (ses `entries[].tag`). Ces deux sources
 * peuvent diverger : un `.sql` présent sur disque mais ABSENT du journal serait
 * appliqué par les tests mais JAMAIS par la prod → les tests valideraient un
 * schéma que la prod n'a pas (faux-vert STRUCTUREL). C'est arrivé en vrai :
 * `0009_entity-write-scope.sql` (dette DB-MIGRATE3, cf. CLAUDE.md « Entités
 * multi-tenant » et « Provisioning ») — orphelin du journal, SUPERSEDED par
 * `0014_entity-write-scope-foral`.
 *
 * Ce test ASSERTE l'égalité des deux ensembles dans les DEUX sens :
 *   1. tout `.sql` sur disque a son entrée dans le journal (sinon = orphelin,
 *      type 0009 : appliqué par les tests, ignoré par la prod) ;
 *   2. toute entrée du journal a son `.sql` sur disque (sinon = référence morte :
 *      la prod tenterait d'appliquer un fichier manquant).
 *
 * EXCEPTION nommée : `0009` est un orphelin VOLONTAIRE et documenté (gardé sur
 * disque car lu PAR NOM par d'autres tests/runbooks, mais retiré du journal car
 * remplacé par 0014). Il vit dans ORPHELINS_AUTORISES ci-dessous. Tout AUTRE
 * orphelin futur (oubli de `db:generate`, fichier copié à la main, numéro
 * re-collisionné) fait ROUGIR ce test — c'est le but.
 *
 * Test PUR : aucune base, aucune connexion. Il compare deux listes de chaînes.
 * Il est rangé dans `tests/isolation/` car il protège un invariant d'isolation
 * tenant : « le schéma que les suites d'isolation testent == le schéma que la
 * prod applique ». Sans cette égalité, toutes les preuves d'isolation portent
 * potentiellement sur un schéma fictif.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");

/**
 * Orphelins TOLÉRÉS : `.sql` volontairement gardés sur disque mais retirés du
 * journal. Liste FERMÉE et COMMENTÉE — chaque entrée doit citer sa raison.
 * Ne JAMAIS y ajouter un fichier pour « faire passer le test » : un orphelin non
 * intentionnel est précisément la régression que cette suite traque.
 *
 * Le tag est SANS l'extension `.sql` (même forme que `entries[].tag`).
 */
const ORPHELINS_AUTORISES = new Set<string>([
  // DB-MIGRATE3 : 0009 posait `entity_scope` FOR SELECT, jugé insuffisant
  // (une PERMISSIVE s'OR'erait) puis remplacé par 0014 (FOR ALL). Le fichier
  // reste sur disque car référencé PAR NOM par d'autres suites/runbooks, mais
  // il a été retiré de `_journal.json` → la prod ne l'applique pas. Voir
  // CLAUDE.md, sections « Entités multi-tenant » et « Provisioning ».
  "0009_entity-write-scope",
]);

/** Structure minimale du `_journal.json` Drizzle (champs consommés ici). */
interface JournalEntry {
  idx: number;
  tag: string;
}
interface Journal {
  entries: JournalEntry[];
}

/** Tags des `.sql` présents sur disque (basename sans `.sql`), triés. */
function tagsSurDisque(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

/** Tags référencés par le journal (`entries[].tag`), triés. */
function tagsDuJournal(): string[] {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  return journal.entries.map((e) => e.tag).sort();
}

describe("Cohérence migrations disque ⇆ _journal.json", () => {
  it("trouve des migrations et un journal non vides (garde-fou méta)", () => {
    // Si le glob `.sql` ou le parsing du journal cassait, les assertions
    // d'égalité plus bas seraient vertes sur du vide (faux-vert du faux-vert).
    expect(tagsSurDisque().length).toBeGreaterThan(0);
    expect(tagsDuJournal().length).toBeGreaterThan(0);
  });

  it("tout .sql sur disque (hors orphelins autorisés) est référencé dans le journal", () => {
    const journal = new Set(tagsDuJournal());
    const orphelins = tagsSurDisque().filter(
      (tag) => !journal.has(tag) && !ORPHELINS_AUTORISES.has(tag),
    );

    expect(
      orphelins,
      orphelins.length > 0
        ? `Migration(s) ORPHELINE(s) : présentes dans drizzle/migrations/*.sql ` +
            `mais ABSENTES de _journal.json → appliquées par les tests, JAMAIS ` +
            `par la prod (faux-vert structurel, cf. dette 0009/DB-MIGRATE3). ` +
            `Fichier(s) : ${orphelins.map((t) => `${t}.sql`).join(", ")}. ` +
            `Corrige le journal (db:generate) ou, si l'orphelin est volontaire ` +
            `et documenté, ajoute-le à ORPHELINS_AUTORISES avec sa raison.`
        : undefined,
    ).toEqual([]);
  });

  it("toute entrée du journal a son .sql sur disque (pas de référence morte)", () => {
    const disque = new Set(tagsSurDisque());
    const mortes = tagsDuJournal().filter((tag) => !disque.has(tag));

    expect(
      mortes,
      mortes.length > 0
        ? `Référence(s) MORTE(s) : entrée(s) de _journal.json sans fichier .sql ` +
            `correspondant sur disque → la prod tenterait d'appliquer une ` +
            `migration introuvable. Tag(s) : ${mortes.join(", ")}. ` +
            `Restaure le(s) fichier(s) ${mortes
              .map((t) => `${t}.sql`)
              .join(", ")} ou retire l'entrée du journal.`
        : undefined,
    ).toEqual([]);
  });

  it("les orphelins autorisés existent toujours sur disque ET restent hors du journal", () => {
    // Empêche l'allowlist de pourrir : si 0009 finissait supprimé du disque ou
    // (re)injecté dans le journal, l'exception n'a plus lieu d'être et doit être
    // retirée de ORPHELINS_AUTORISES — sinon elle masquerait un vrai écart.
    const disque = new Set(tagsSurDisque());
    const journal = new Set(tagsDuJournal());
    for (const tag of ORPHELINS_AUTORISES) {
      expect(
        disque.has(tag),
        `ORPHELINS_AUTORISES référence ${tag}.sql, absent du disque : ` +
          `l'exception est caduque, retire-la de l'allowlist.`,
      ).toBe(true);
      expect(
        journal.has(tag),
        `${tag} est de retour dans _journal.json : ce n'est plus un orphelin, ` +
          `retire-le de ORPHELINS_AUTORISES (il doit redevenir vérifié).`,
      ).toBe(false);
    }
  });
});
