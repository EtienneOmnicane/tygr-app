/**
 * Prédicat « catégorie OBIE exploitable » — source unique TS + SQL
 * (`src/lib/categorie-obie-vide.mjs`).
 *
 * Deux familles de preuves :
 *  1. NON-RÉGRESSION du prédicat lui-même (les sentinelles amont, dans toutes leurs
 *     graphies) + CONTRE-PREUVE (les vraies catégories restent exploitables) — un
 *     prédicat trop large casserait les 606 lignes réellement classées.
 *  2. ANTI-DIVERGENCE : le SQL est DÉRIVÉ de la constante, jamais recopié. C'est le
 *     défaut qui a motivé ce module — le script de backfill tenait une copie SQL
 *     figée sur "uncategorized" alors que le TS connaissait aussi "unclassified".
 *     Ces tests échouent si quelqu'un ré-écrit une sentinelle en dur dans le SQL.
 */
import { describe, expect, it } from "vitest";

import {
  CATEGORIES_OBIE_VIDES,
  categorieAutoValide,
  predicatSqlCategorieExploitable,
  sentinellesPourParametreSql,
} from "@/lib/categorie-obie-vide.mjs";

describe("categorieAutoValide — sentinelles amont (non-régression)", () => {
  it("rejette l'absence de valeur", () => {
    expect(categorieAutoValide(null)).toBe(false);
    expect(categorieAutoValide(undefined)).toBe(false);
    expect(categorieAutoValide("")).toBe(false);
    expect(categorieAutoValide("   ")).toBe(false);
  });

  it("rejette 'Uncategorized' (graphie documentée) dans toutes ses casses", () => {
    expect(categorieAutoValide("Uncategorized")).toBe(false);
    expect(categorieAutoValide("uncategorized")).toBe(false);
    expect(categorieAutoValide("  UNCATEGORIZED ")).toBe(false);
  });

  it("rejette 'UNCLASSIFIED' (graphie RÉELLEMENT émise, #243) dans toutes ses casses", () => {
    expect(categorieAutoValide("UNCLASSIFIED")).toBe(false);
    expect(categorieAutoValide("unclassified")).toBe(false);
    expect(categorieAutoValide("Unclassified")).toBe(false);
    expect(categorieAutoValide("  UNCLASSIFIED ")).toBe(false);
  });

  it("rejette une sentinelle entourée de blancs NON-espace (parité avec btrim SQL)", () => {
    // `String.trim()` retire \t\n\r\v\f, `btrim(x)` par défaut NON. Le module passe
    // une liste de blancs explicite à btrim pour que les deux moteurs s'accordent :
    // sans elle, cette valeur serait « vide » côté TS et « exploitable » côté SQL.
    expect(categorieAutoValide("\tUNCLASSIFIED")).toBe(false);
    expect(categorieAutoValide("UNCLASSIFIED\n")).toBe(false);
  });

  it("CONTRE-PREUVE : les vraies catégories de l'inventaire restent exploitables", () => {
    // Inventaire base 2026-07-21 — un prédicat trop large les neutraliserait à tort.
    expect(categorieAutoValide("UTILITIES")).toBe(true);
    expect(categorieAutoValide("BANKING_AND_FINANCE")).toBe(true);
    expect(categorieAutoValide("INTER_ACCOUNT_TRANSFER")).toBe(true);
    // Et des catégories quelconques hors inventaire.
    expect(categorieAutoValide("Income")).toBe(true);
    expect(categorieAutoValide("business expenses")).toBe(true);
    expect(categorieAutoValide("  Transport  ")).toBe(true);
  });

  it("ne confond pas une catégorie qui CONTIENT une sentinelle avec la sentinelle", () => {
    // Comparaison d'égalité stricte, jamais un LIKE / includes.
    expect(categorieAutoValide("UNCLASSIFIED_FEES")).toBe(true);
    expect(categorieAutoValide("PRE_UNCATEGORIZED")).toBe(true);
  });
});

describe("predicatSqlCategorieExploitable — dérivation, pas recopie", () => {
  const sql = predicatSqlCategorieExploitable("primary_category", 1);

  it("n'écrit AUCUNE sentinelle en dur dans le SQL (anti-divergence)", () => {
    // Le défaut historique : la liste vivait en clair dans la chaîne SQL du script,
    // et n'a pas suivi l'ajout de "unclassified". Elle ne doit plus y figurer.
    for (const sentinelle of CATEGORIES_OBIE_VIDES) {
      expect(sql.toLowerCase()).not.toContain(sentinelle);
    }
  });

  it("passe la liste en PARAMÈTRE LIÉ (aucune interpolation de valeur)", () => {
    expect(sql).toContain("$1::text[]");
    // La valeur de $1 est le text[] COMPLET — un seul paramètre, pas un par
    // sentinelle (la suite isolation a payé la confusion : Postgres rejette
    // « supplies 2 parameters, but prepared statement requires 1 »).
    expect(sentinellesPourParametreSql()).toEqual([...CATEGORIES_OBIE_VIDES]);
    expect(sql.match(/\$\d+/g)).toEqual(["$1"]);
  });

  it("porte les mêmes composantes que le prédicat TS", () => {
    expect(sql).toContain("IS NOT NULL");
    expect(sql).toContain("lower(");
    expect(sql).toContain("btrim(");
    expect(sql).toContain("<> ALL(");
  });

  it("respecte l'indice de paramètre demandé (composable dans une requête)", () => {
    expect(predicatSqlCategorieExploitable("primary_category", 3)).toContain("$3::text[]");
  });

  it("la liste est FIGÉE (une sentinelle ne s'ajoute pas au runtime)", () => {
    expect(Object.isFrozen(CATEGORIES_OBIE_VIDES)).toBe(true);
    // Le paramètre est une COPIE : le muter ne contamine pas la source.
    const params = sentinellesPourParametreSql();
    params.push("bidon");
    expect(sentinellesPourParametreSql()).toEqual([...CATEGORIES_OBIE_VIDES]);
  });
});
