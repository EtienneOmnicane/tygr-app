/**
 * Tests unitaires du GROUPEMENT qui alimente l'accordéon `CompteSelecteur`
 * (/transactions, C2 — PLAN-transactions-selecteur-entites.md).
 *
 * Le composant lui-même est du rendu pur, validé au Visual QA (pas de renderer
 * React de test au projet — choix tracé CLAUDE.md §MFA/§dette). Ce qui EST testable
 * en isolation, et ce dont dépend directement le composant, c'est :
 *   1. la COMPATIBILITÉ STRUCTURELLE du contrat `CompteFiltre` (accountName +
 *      institutionName + titulaire) avec le groupement générique `grouperParTitulaire`
 *      (`CompteTitulable`) — le sélecteur passe `CompteFiltre[]` directement ;
 *   2. le REPLI mono-groupe (`groupes.length < 2` → liste plate) que le composant
 *      applique comme décision de VUE — même repli que le dashboard ;
 *   3. la conservation totale + le bucket « Non regroupé » en dernier, garants que
 *      AUCUN compte sélectionnable ne disparaît (le sélecteur ne doit jamais masquer
 *      un compte — le périmètre de sécurité vit dans la RLS, pas ici).
 *
 * Ces cas complètent `grouper-titulaire.test.ts` (qui exerce le type serveur
 * `CompteConnecte`) en prouvant l'usage via le type CLIENT `CompteFiltre`.
 */
import { describe, expect, it } from "vitest";

import { grouperParTitulaire } from "@/lib/grouper-titulaire";
import type { CompteFiltre } from "@/components/transactions/transactions-toolbar";

/** Fabrique un `CompteFiltre` minimal (le sélecteur ne groupe que sur le titulaire). */
function compte(
  bankAccountId: string,
  holderId: string | null,
  holderName: string | null,
  institutionName: string | null = null,
): CompteFiltre {
  return {
    bankAccountId,
    accountName: `Compte ${bankAccountId}`,
    institutionName,
    holderId,
    holderName,
  };
}

describe("CompteSelecteur — groupement (CompteFiltre)", () => {
  it("chemin heureux : ≥2 titulaires → accordéon, groupes triés fr, comptes préservés", () => {
    const groupes = grouperParTitulaire([
      compte("c1", "h-zeta", "Zeta Ltd", "Bank One"),
      compte("c2", "h-alpha", "Alpha SA", "MCB"),
      compte("c3", "h-zeta", "Zeta Ltd", "Bank One"),
    ]);
    expect(groupes.length).toBeGreaterThanOrEqual(2);
    expect(groupes.map((g) => g.holderName)).toEqual(["Alpha SA", "Zeta Ltd"]);
    // Les deux comptes du même titulaire restent groupés, dans l'ordre reçu.
    const zeta = groupes.find((g) => g.holderId === "h-zeta");
    expect(zeta?.comptes.map((c) => c.bankAccountId)).toEqual(["c1", "c3"]);
    // Le sous-libellé (institution) reste porté par chaque compte (rendu par le composant).
    expect(zeta?.comptes[0].institutionName).toBe("Bank One");
  });

  it("cas limite — repli mono-groupe : un seul titulaire → < 2 groupes (liste plate)", () => {
    // 87 comptes d'Etienne répartis sur 1 titulaire = 1 groupe → le composant
    // rend la LISTE PLATE (pas d'accordéon à un volet). C'est la reproduction du
    // symptôme « banque noyée » : la sélection reste directe, sans niveau superflu.
    const groupes = grouperParTitulaire([
      compte("c1", "h1", "Omnicane Ltd"),
      compte("c2", "h1", "Omnicane Ltd"),
      compte("c3", "h1", "Omnicane Ltd"),
    ]);
    expect(groupes.length).toBe(1); // < 2 ⇒ le composant bascule en liste plate
  });

  it("cas limite — tous sans titulaire exploitable → un seul bucket « Non regroupé » (< 2)", () => {
    const groupes = grouperParTitulaire([
      compte("c1", null, null),
      compte("c2", "h1", "   "), // nom blanc → non exploitable (D7)
      compte("c3", "h2", null), // id sans nom → non exploitable
    ]);
    expect(groupes.length).toBe(1);
    expect(groupes[0].holderId).toBeNull();
    expect(groupes[0].comptes.map((c) => c.bankAccountId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("conservation totale : aucun compte sélectionnable n'est masqué (bucket null en dernier)", () => {
    const entree = [
      compte("c1", "h1", "Alpha"),
      compte("c2", null, null),
      compte("c3", "h2", "Beta"),
      compte("c4", "h1", "Alpha"),
    ];
    const groupes = grouperParTitulaire(entree);
    const ressortis = groupes
      .flatMap((g) => g.comptes.map((c) => c.bankAccountId))
      .sort();
    expect(ressortis).toEqual(["c1", "c2", "c3", "c4"]);
    // « Non regroupé » (holderId null) TOUJOURS en dernier.
    expect(groupes[groupes.length - 1].holderId).toBeNull();
  });
});
