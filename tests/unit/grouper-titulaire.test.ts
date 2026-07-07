/**
 * Tests unitaires du helper PUR `grouperParTitulaire` (D3, PLAN-bandeau-
 * titulaire-accordeon.md L2) : tri locale fr, bucket « Non regroupé » en
 * dernier, conservation totale (display-only, règle 2), homonymie
 * désambiguïsée par holderId, mono-groupe.
 */
import { describe, expect, it } from "vitest";

import {
  basculerGroupe,
  etatSelectionGroupe,
  grouperParTitulaire,
} from "@/lib/grouper-titulaire";
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

  it("S3 : « Account Holder » (générique) relégué APRÈS les nommés, AVANT « Non regroupé »", () => {
    const groupes = grouperParTitulaire([
      compte("c1", "h-gen", "Account Holder"),
      compte("c2", "h-zeta", "Zeta Ltd"),
      compte("c3", null, null),
      compte("c4", "h-air", "AIRPORT HOTEL"),
      compte("c5", "h-gen", "Account Holder"),
    ]);
    expect(groupes.map((g) => g.holderName)).toEqual([
      "AIRPORT HOTEL",
      "Zeta Ltd",
      "Account Holder",
      null,
    ]);
    // Le générique reste un groupe PROPRE : libellé intact + compteur exact.
    const gen = groupes[2];
    expect(gen.holderId).toBe("h-gen");
    expect(gen.comptes.map((c) => c.bankAccountId)).toEqual(["c1", "c5"]);
  });

  it("S3 : la détection du générique est insensible à la casse et aux espaces", () => {
    const groupes = grouperParTitulaire([
      compte("c1", "h-gen1", "  ACCOUNT HOLDER  "),
      compte("c2", "h-gen2", "account holder"),
      compte("c3", "h-reel", "Beta SA"),
    ]);
    // Les deux variantes du placeholder sont reléguées après « Beta SA »
    // (l'ordre INTERNE entre variantes de casse relève du collator, pas du contrat).
    expect(groupes[0].holderId).toBe("h-reel");
    expect(groupes.slice(1).map((g) => g.holderId).sort()).toEqual([
      "h-gen1",
      "h-gen2",
    ]);
  });

  it("S3 : le générique SEUL reste 1 groupe propre (repli plat au consommateur, comme tout mono-groupe)", () => {
    const mono = grouperParTitulaire([
      compte("c1", "h-gen", "Account Holder"),
      compte("c2", "h-gen", "Account Holder"),
    ]);
    expect(mono).toHaveLength(1);
    expect(mono[0].holderName).toBe("Account Holder");
    expect(mono[0].comptes).toHaveLength(2);
  });

  it("S3 : conservation totale préservée avec générique + nommés + non regroupé", () => {
    const entree = [
      compte("c1", "h-gen", "Account Holder"),
      compte("c2", "h1", "Alpha"),
      compte("c3", null, null),
      compte("c4", "h-gen", "Account Holder"),
    ];
    const ressortis = grouperParTitulaire(entree).flatMap((g) =>
      g.comptes.map((c) => c.bankAccountId),
    );
    expect(ressortis.sort()).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("etatSelectionGroupe (S2 — tri-état)", () => {
  const groupe = [
    compte("c1", "h1", "Alpha"),
    compte("c2", "h1", "Alpha"),
    compte("c3", "h1", "Alpha"),
  ];

  it("aucun / partiel / tous selon la sélection courante", () => {
    expect(etatSelectionGroupe(groupe, new Set())).toBe("aucun");
    expect(etatSelectionGroupe(groupe, new Set(["c1"]))).toBe("partiel");
    expect(etatSelectionGroupe(groupe, new Set(["c1", "c2"]))).toBe("partiel");
    expect(etatSelectionGroupe(groupe, new Set(["c1", "c2", "c3"]))).toBe("tous");
    // Des ids ÉTRANGERS au groupe ne comptent pas.
    expect(etatSelectionGroupe(groupe, new Set(["x1", "x2", "x3"]))).toBe("aucun");
  });

  it("cas limite : groupe vide → « aucun », jamais « tous »", () => {
    expect(etatSelectionGroupe([], new Set(["c1"]))).toBe("aucun");
  });
});

describe("basculerGroupe (S2 — tout cocher / tout décocher)", () => {
  const groupe = [compte("c1", "h1", "Alpha"), compte("c2", "h1", "Alpha")];

  it("aucun → tous, partiel → tous, tous → aucun", () => {
    expect(basculerGroupe(new Set(), groupe)).toEqual(new Set(["c1", "c2"]));
    expect(basculerGroupe(new Set(["c1"]), groupe)).toEqual(new Set(["c1", "c2"]));
    expect(basculerGroupe(new Set(["c1", "c2"]), groupe)).toEqual(new Set());
  });

  it("display-only (règle 2) : n'ajoute JAMAIS un id hors du groupe, préserve les autres cochés", () => {
    const avant = new Set(["autre-groupe"]);
    const apres = basculerGroupe(avant, groupe);
    // Les cochés des AUTRES groupes survivent ; seuls c1/c2 sont ajoutés.
    expect(apres).toEqual(new Set(["autre-groupe", "c1", "c2"]));
    // Et le décochage de CE groupe ne touche pas les autres.
    expect(basculerGroupe(apres, groupe)).toEqual(new Set(["autre-groupe"]));
  });

  it("immutabilité : l'entrée n'est jamais mutée ; groupe vide → copie inchangée", () => {
    const avant = new Set(["c1"]);
    const apres = basculerGroupe(avant, groupe);
    expect(avant).toEqual(new Set(["c1"])); // intact
    expect(apres).not.toBe(avant); // nouveau Set
    const copie = basculerGroupe(avant, []);
    expect(copie).toEqual(avant);
    expect(copie).not.toBe(avant);
  });
});
