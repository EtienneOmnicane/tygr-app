/**
 * Tests de la résolution du NOM DE BANQUE dans les signaux de désynchronisation.
 *
 * L'enjeu n'est pas cosmétique : les identifiants d'`EtatFinalisation` sont des UUID
 * AMONT (Omni-FI) tandis que la liste de l'écran est indexée par notre UUID INTERNE.
 * Les deux se ressemblent et ne correspondent JAMAIS — une jointure sur la mauvaise clé
 * ne lève aucune erreur, elle retombe silencieusement sur le repli anonyme. C'est
 * exactement ce que le premier test verrouille.
 */
import { describe, expect, it } from "vitest";

import {
  enumererNoms,
  nommerToutes,
  resoudreNomsBanques,
  type ConnexionNommable,
} from "@/components/banques/noms-banques";

/** Liste d'écran type : la clé de jointure est `omnifiConnectionId`, PAS l'UUID interne. */
const CONNEXIONS: ConnexionNommable[] = [
  { omnifiConnectionId: "omnifi-cx-1", institutionName: "Absa Internet Banking" },
  { omnifiConnectionId: "omnifi-cx-2", institutionName: "MCB Juice" },
  // Connexion antérieure à la colonne `institution_name` (nullable, dette DASH-INST1).
  { omnifiConnectionId: "omnifi-cx-3", institutionName: null },
];

describe("resoudreNomsBanques", () => {
  it("résout sur l'identifiant AMONT (chemin heureux)", () => {
    expect(resoudreNomsBanques(["omnifi-cx-1"], CONNEXIONS)).toEqual([
      "Absa Internet Banking",
    ]);
  });

  it("préserve l'ORDRE des identifiants reçus, pas celui de la liste", () => {
    expect(
      resoudreNomsBanques(["omnifi-cx-2", "omnifi-cx-1"], CONNEXIONS),
    ).toEqual(["MCB Juice", "Absa Internet Banking"]);
  });

  it("ne résout RIEN sur un UUID interne — la mauvaise clé ne doit pas matcher par accident", () => {
    // Le piège du lot : `EtatFinalisation` porte l'id amont, la liste porte l'id interne.
    // Si un jour quelqu'un rebranche la jointure sur `connectionId`, ce test tombe.
    const interne = ["11111111-2222-3333-4444-555555555555"];
    expect(resoudreNomsBanques(interne, CONNEXIONS)).toEqual([]);
  });

  it("OMET une connexion sans nom (null) plutôt que de produire un trou", () => {
    expect(resoudreNomsBanques(["omnifi-cx-3"], CONNEXIONS)).toEqual([]);
  });

  it("OMET un nom vide ou blanc (donnée amont dégradée)", () => {
    const blanc: ConnexionNommable[] = [
      { omnifiConnectionId: "cx", institutionName: "   " },
    ];
    expect(resoudreNomsBanques(["cx"], blanc)).toEqual([]);
  });

  it("rend un tableau vide sur des entrées vides (cas limite)", () => {
    expect(resoudreNomsBanques([], CONNEXIONS)).toEqual([]);
    expect(resoudreNomsBanques(["omnifi-cx-1"], [])).toEqual([]);
  });
});

describe("enumererNoms", () => {
  it("écrit une phrase, pas une liste CSV", () => {
    expect(enumererNoms([])).toBe("");
    expect(enumererNoms(["Absa"])).toBe("Absa");
    expect(enumererNoms(["Absa", "MCB"])).toBe("Absa et MCB");
    expect(enumererNoms(["Absa", "MCB", "SBM"])).toBe("Absa, MCB et SBM");
  });
});

describe("nommerToutes", () => {
  it("nomme quand TOUTES les banques sont résolues (chemin heureux)", () => {
    expect(nommerToutes(["omnifi-cx-1", "omnifi-cx-2"], CONNEXIONS)).toBe(
      "Absa Internet Banking et MCB Juice",
    );
  });

  it("rend null dès qu'UNE banque n'est pas résoluble (tout ou rien)", () => {
    // Nommer partiellement (« Absa et 1 autre banque ») ferait croire que la seconde est
    // d'une autre nature, alors qu'elle est juste antérieure à la colonne.
    expect(nommerToutes(["omnifi-cx-1", "omnifi-cx-3"], CONNEXIONS)).toBeNull();
  });

  it("rend null quand rien n'est résoluble (chemin d'échec → repli anonyme)", () => {
    expect(nommerToutes(["inconnue"], CONNEXIONS)).toBeNull();
    expect(nommerToutes(["inconnue-1", "inconnue-2"], [])).toBeNull();
  });

  it("rend null sur une liste vide — il n'y a alors aucune phrase à écrire (cas limite)", () => {
    expect(nommerToutes([], CONNEXIONS)).toBeNull();
  });
});
