/**
 * Axe continu par granularité (L2) : `grilleBuckets` + étiquettes.
 *
 * Invariants prouvés (PLAN-graphs-fygr §9.1) :
 *  - MOIS : parité EXACTE avec `grilleMois` (même axe → jointure grille↔série sûre) ;
 *  - SEMAINE : chaque bucket est un LUNDI (= `date_trunc('week')` PG), espacé de 7 j,
 *    couvre [from, to] (le 1er lundi peut précéder `from`) ;
 *  - JOUR : un bucket par jour, bornes incluses ;
 *  - dégénérescences : from == to, from > to, entrée invalide.
 * Les étiquettes passent par `format-date` (source unique) — aucun nom de mois en dur.
 */
import { describe, expect, it } from "vitest";

import { grilleBuckets } from "@/components/charts/grille-buckets";
import { etiquetteBucket } from "@/components/charts/etiquette-bucket";
import { grilleMois } from "@/server/repositories/dashboard";

function jourSemaine(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=dim .. 1=lun .. 6=sam
}

describe("grilleBuckets — mois", () => {
  it("PARITÉ avec grilleMois sur la même fenêtre", () => {
    // grilleMois(3, "2026-03") = [2026-01, 2026-02, 2026-03]
    expect(grilleBuckets("mois", "2026-01-01", "2026-03-31")).toEqual(
      grilleMois(3, "2026-03"),
    );
    expect(grilleBuckets("mois", "2026-01-15", "2026-03-02")).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });

  it("traverse un changement d'année", () => {
    expect(grilleBuckets("mois", "2025-11-01", "2026-02-28")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("un seul mois quand from et to sont dans le même mois", () => {
    expect(grilleBuckets("mois", "2026-06-03", "2026-06-29")).toEqual(["2026-06"]);
  });
});

describe("grilleBuckets — jour", () => {
  it("un bucket par jour, bornes incluses", () => {
    expect(grilleBuckets("jour", "2026-01-01", "2026-01-03")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("fenêtre d'un seul jour → un bucket", () => {
    expect(grilleBuckets("jour", "2026-02-28", "2026-02-28")).toEqual([
      "2026-02-28",
    ]);
  });

  it("traverse une fin de mois (jours réels, pas de 30 février)", () => {
    expect(grilleBuckets("jour", "2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });
});

describe("grilleBuckets — semaine (lundi ISO)", () => {
  it("chaque bucket est un LUNDI, espacé de 7 jours, couvrant la fenêtre", () => {
    const g = grilleBuckets("semaine", "2026-01-14", "2026-02-05");
    expect(g.length).toBeGreaterThan(0);
    // Tous des lundis.
    for (const b of g) expect(jourSemaine(b)).toBe(1);
    // Le 1er lundi ≤ from (le bucket de PG pour une transaction en milieu de semaine).
    expect(g[0] <= "2026-01-14").toBe(true);
    // Espacement de 7 jours entre buckets consécutifs.
    for (let i = 1; i < g.length; i++) {
      const delta =
        (new Date(`${g[i]}T00:00:00Z`).getTime() -
          new Date(`${g[i - 1]}T00:00:00Z`).getTime()) /
        86_400_000;
      expect(delta).toBe(7);
    }
    // Le dernier bucket couvre `to` (dernier ≤ to, mais dernier+7 > to).
    const dernier = g[g.length - 1];
    expect(dernier <= "2026-02-05").toBe(true);
    const apres = new Date(`${dernier}T00:00:00Z`).getTime() + 7 * 86_400_000;
    expect(apres > new Date("2026-02-05T00:00:00Z").getTime()).toBe(true);
  });

  it("from == to (un jour) → l'unique lundi de sa semaine", () => {
    const g = grilleBuckets("semaine", "2026-01-14", "2026-01-14");
    expect(g).toHaveLength(1);
    expect(jourSemaine(g[0])).toBe(1);
    expect(g[0] <= "2026-01-14").toBe(true);
  });
});

describe("grilleBuckets — dégénérescences", () => {
  it("from > to → vide", () => {
    expect(grilleBuckets("jour", "2026-03-01", "2026-01-01")).toEqual([]);
  });
  it("entrée non ISO → vide (défensif)", () => {
    expect(grilleBuckets("mois", "pas-une-date", "2026-01-01")).toEqual([]);
  });
});

describe("etiquetteBucket — passe par format-date (source unique)", () => {
  it("mois → court « Juin 26 » / complet « Juin 2026 »", () => {
    expect(etiquetteBucket("mois", "2026-06")).toEqual({
      court: "Juin 26",
      complet: "Juin 2026",
    });
  });
  it("jour → « 11 juin » / « 11 juin 2026 »", () => {
    expect(etiquetteBucket("jour", "2026-06-11")).toEqual({
      court: "11 juin",
      complet: "11 juin 2026",
    });
  });
  it("semaine → préfixé « Sem. » / « Semaine du »", () => {
    expect(etiquetteBucket("semaine", "2026-06-08")).toEqual({
      court: "Sem. 8 juin",
      complet: "Semaine du 8 juin 2026",
    });
  });
});
