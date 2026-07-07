/**
 * Tests unitaires du helper PUR `grouperParTitulaire` (D3, PLAN-bandeau-
 * titulaire-accordeon.md L2) : tri locale fr, bucket « Non regroupé » en
 * dernier, conservation totale (display-only, règle 2), homonymie
 * désambiguïsée par holderId, mono-groupe.
 */
import { describe, expect, it } from "vitest";

import { grouperParTitulaire } from "@/lib/grouper-titulaire";
import type { CompteConnecte } from "@/server/repositories/dashboard";

/** Fabrique un CompteConnecte minimal (les champs hors groupement sont neutres). */
function compte(
  id: string,
  holderId: string | null | undefined,
  holderName: string | null | undefined,
): CompteConnecte {
  return {
    bankAccountId: id,
    accountName: `Compte ${id}`,
    institutionName: null,
    currency: "MUR",
    currentBalance: null,
    lastSyncedAt: null,
    holderId,
    holderName,
  };
}

describe("grouperParTitulaire", () => {
  it("chemin heureux : groupes triés fr, comptes dans l'ordre reçu, bucket null en DERNIER", () => {
    const groupes = grouperParTitulaire([
      compte("c1", "h-zeta", "Zeta Ltd"),
      compte("c2", null, null),
      compte("c3", "h-eta", "Éta Holdings"), // accent : « É » trie comme « E » (avant Z)
      compte("c4", "h-zeta", "Zeta Ltd"),
    ]);
    expect(groupes.map((g) => g.holderName)).toEqual([
      "Éta Holdings",
      "Zeta Ltd",
      null,
    ]);
    expect(groupes[1].comptes.map((c) => c.bankAccountId)).toEqual(["c1", "c4"]);
    expect(groupes[2].holderId).toBeNull();
    expect(groupes[2].comptes.map((c) => c.bankAccountId)).toEqual(["c2"]);
  });

  it("display-only (règle 2) : chaque compte ressort EXACTEMENT une fois", () => {
    const entree = [
      compte("c1", "h1", "Alpha"),
      compte("c2", "h2", "Beta"),
      compte("c3", null, null),
      compte("c4", "h1", "Alpha"),
    ];
    const groupes = grouperParTitulaire(entree);
    const ressortis = groupes.flatMap((g) => g.comptes.map((c) => c.bankAccountId));
    expect(ressortis.sort()).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("homonymie : deux titulaires de MÊME nom restent DEUX groupes (clé holderId), ordre déterministe", () => {
    const groupes = grouperParTitulaire([
      compte("c1", "h-b", "Omnicane"),
      compte("c2", "h-a", "Omnicane"),
    ]);
    expect(groupes).toHaveLength(2);
    // Égalité de nom → départage par holderId (h-a avant h-b).
    expect(groupes.map((g) => g.holderId)).toEqual(["h-a", "h-b"]);
  });

  it("titulaire NON exploitable (id sans nom, nom blanc, champs absents) → bucket « Non regroupé »", () => {
    const orphelin: CompteConnecte = {
      bankAccountId: "c-legacy",
      accountName: "Compte legacy",
      institutionName: null,
      currency: "MUR",
      currentBalance: null,
      lastSyncedAt: null,
      // holderId / holderName ABSENTS (consommateur pré-L1 / fixture) — optionnels D1.
    };
    const groupes = grouperParTitulaire([
      compte("c1", "h-sans-nom", null), // party sans PartyName
      compte("c2", "h-blanc", "   "), // nom blanc = pas affichable (D7)
      orphelin,
      compte("c3", "h1", "Alpha"),
    ]);
    expect(groupes).toHaveLength(2);
    expect(groupes[0].holderName).toBe("Alpha");
    expect(groupes[1].holderId).toBeNull();
    expect(groupes[1].comptes.map((c) => c.bankAccountId)).toEqual([
      "c1",
      "c2",
      "c-legacy",
    ]);
  });

  it("cas limites : entrée vide → [] ; mono-groupe → 1 groupe (le repli plat est au consommateur)", () => {
    expect(grouperParTitulaire([])).toEqual([]);
    const mono = grouperParTitulaire([
      compte("c1", "h1", "Alpha"),
      compte("c2", "h1", "Alpha"),
    ]);
    expect(mono).toHaveLength(1);
    expect(mono[0].comptes).toHaveLength(2);
  });
});
