/**
 * `registreSynchro` — le TON du message de synchro affiché sous le bouton du dashboard.
 *
 * Ce que ces tests verrouillent (revue PR #202, constat 2) : le dashboard affichait
 * « Comptes à jour. » en VERT, en dur, dès que `succes` était non nul — sans jamais lire son
 * contenu. Or `synchroniserConnexionsAction` est FAIL-SOFT : une banque morte laisse
 * `erreur` à `null` et écrit l'échec DANS `succes`. Le vert triomphal se posait donc
 * par-dessus une banque en `SCRAPER_ERROR`, un scrape encore en cours, ou un simple cooldown.
 *
 * L'invariant testé ici est le remplaçant de ce vert en dur : **le vert exige zéro réserve**.
 * Il est testable parce que la décision est PURE (le projet n'a pas de renderer React de
 * test — cf. CLAUDE.md) : c'est la seule preuve automatisable que le faux message de
 * victoire ne peut pas revenir.
 */
import { describe, it, expect } from "vitest";

import { registreSynchro } from "@/components/sync/registre-synchro";
import type { EtatFinalisation } from "@/app/(workspace)/banques/actions";

/** Synchro pleinement réussie : le SEUL cas qui mérite le vert. */
const SUCCES_PLEIN: EtatFinalisation = {
  erreur: null,
  succes: "Synchronisation effectuée — 2 banque(s) à jour, 5 compte(s) mis à jour.",
};

describe("registreSynchro — le vert exige ZÉRO réserve", () => {
  it("succès plein (aucune réserve) → `succes` : le seul cas vert", () => {
    expect(registreSynchro(SUCCES_PLEIN)).toBe("succes");
  });

  it("repos (action jamais lancée) → `muet`", () => {
    expect(registreSynchro(null)).toBe("muet");
  });

  it("erreur dure → `erreur` (prime sur tout)", () => {
    expect(
      registreSynchro({ erreur: "Synchronisation impossible.", succes: null }),
    ).toBe("erreur");
  });

  it("ni erreur ni succès (rien à dire dans ce canal) → `muet`", () => {
    // Le cas « aucune banque à synchroniser » passe par `info`, canal distinct.
    expect(
      registreSynchro({ erreur: null, succes: null, info: "Aucune banque à synchroniser." }),
    ).toBe("muet");
  });
});

describe("registreSynchro — chaque réserve INTERDIT le vert", () => {
  /**
   * LE test du constat 2. Une banque en échec DUR (SCRAPER_ERROR, 5xx, réseau) est traitée
   * en fail-soft : `erreur` reste `null` et `succes` porte la phrase d'échec. Avant, ce cas
   * rendait un vert « Comptes à jour. » — c'est-à-dire l'exact inverse de la vérité.
   */
  it("échec dur d'une banque (fail-soft) → `neutre`, JAMAIS `succes`", () => {
    const r = registreSynchro({
      ...SUCCES_PLEIN,
      succes:
        "Synchronisation effectuée — 1 banque(s) à jour, 2 compte(s) mis à jour." +
        " 1 banque(s) n'ont pas pu être synchronisées — réessayez plus tard.",
      echecs: 1,
    });
    expect(r).toBe("neutre");
    expect(r).not.toBe("succes");
  });

  it("scrape encore en cours (incomplet) → `neutre`", () => {
    expect(registreSynchro({ ...SUCCES_PLEIN, incomplet: true })).toBe("neutre");
  });

  it("réparation MFA demandée → `neutre`", () => {
    expect(
      registreSynchro({
        ...SUCCES_PLEIN,
        reparation: [{ connectionId: "cx-1", jobId: "job-1" }],
      }),
    ).toBe("neutre");
  });

  it("accès désaligné (à reconnecter) → `neutre`", () => {
    expect(
      registreSynchro({ ...SUCCES_PLEIN, aReconnecter: [{ connectionId: "cx-1" }] }),
    ).toBe("neutre");
  });

  it("CAS LIMITE — `echecs: 0` explicite n'est PAS une réserve (le vert reste dû)", () => {
    // Garde anti-régression : traiter la seule PRÉSENCE de la clé comme une réserve
    // ferait disparaître le vert pour toujours (bug silencieux, jamais détecté à l'œil).
    expect(registreSynchro({ ...SUCCES_PLEIN, echecs: 0 })).toBe("succes");
  });

  it("CAS LIMITE — listes VIDES ne sont pas des réserves (le vert reste dû)", () => {
    expect(
      registreSynchro({
        ...SUCCES_PLEIN,
        reparation: [],
        rateLimited: [],
        aReconnecter: [],
      }),
    ).toBe("succes");
  });

  it("réserves CUMULÉES (échec + incomplet) → `neutre`, une seule fois", () => {
    expect(
      registreSynchro({ ...SUCCES_PLEIN, echecs: 2, incomplet: true }),
    ).toBe("neutre");
  });
});

describe("registreSynchro — le cooldown N'EST PAS une réserve", () => {
  /**
   * Contre-intuitif, donc verrouillé par un test. Sous cooldown on ne re-déclenche pas de
   * scrape, mais la branche RATE_LIMITED ne fait PAS `continue` : les soldes sont
   * re-persistés et les transactions ré-ingérées. Les données SONT à jour.
   *
   * Deux raisons de ne pas en faire une réserve :
   *  1. le serveur compte déjà ces banques comme « à jour » (`banquesOk`, actions.ts) — un
   *     ton gris sur un texte « 1 banque à jour » ferait diverger DEUX sources de vérité,
   *     soit exactement la classe de bug que cette PR élimine ;
   *  2. depuis le correctif du 2ᵉ clic, un job qui tourne ENCORE sous cooldown ressort en
   *     INCOMPLET — un RATE_LIMITED résiduel signifie que le dernier scrape est TERMINÉ.
   *     En faire une réserve rendrait le vert inatteignable pour toute banque lente.
   */
  it("cooldown seul (données relues et complètes) → `succes`", () => {
    expect(
      registreSynchro({
        ...SUCCES_PLEIN,
        rateLimited: [{ connectionId: "cx-1", nextSyncAt: "2026-07-13T12:00:00Z" }],
      }),
    ).toBe("succes");
  });

  it("cooldown + job encore en cours (incomplet) → `neutre` : c'est `incomplet` qui parle", () => {
    // Le cas réel du 2ᵉ clic sur une banque lente : le cooldown est actif ET le scrape court.
    // La réserve vient du job, jamais du cooldown.
    expect(
      registreSynchro({
        ...SUCCES_PLEIN,
        incomplet: true,
        rateLimited: [{ connectionId: "cx-1", nextSyncAt: "2026-07-13T12:00:00Z" }],
      }),
    ).toBe("neutre");
  });
});

/**
 * Le registre est juste — encore faut-il que les PRODUCTEURS l'alimentent. C'est le trou que
 * la PR prétend fermer : chaque Server Action qui rend un `EtatFinalisation` doit publier ses
 * réserves en SIGNAL, pas seulement dans la phrase (un champ optionnel omis ne casse aucun
 * typecheck — il est ignoré en silence).
 */
describe("producteurs — un échec doit TOUJOURS interdire le vert", () => {
  it("réparation MFA dont le scrape a PLANTÉ → `echecs: 1` ⇒ `neutre`, jamais « Connexion rétablie » en vert", () => {
    // `resynchroniserConnexionApresReparationAction` sur un job FAILED : les comptes sont
    // rattachés (ils le sont AVANT le job), donc le message reste positif — mais la
    // récupération des transactions a échoué. Sans `echecs`, zéro réserve ⇒ vert.
    const r = registreSynchro({
      erreur: null,
      succes:
        "Connexion rétablie — 2 compte(s) mis à jour." +
        " En revanche, la récupération des transactions a échoué — réessayez plus tard.",
      echecs: 1,
    });
    expect(r).toBe("neutre");
    expect(r).not.toBe("succes");
  });

  it("finalisation drop-in PARTIELLE (≥1 connexion non finalisée) → `neutre`", () => {
    // `finaliserConnexionDropinAction` : `complet: false` pilote la redirection, mais c'est
    // `echecs` qui interdit le vert. Publier l'un sans l'autre laissait passer la fausse
    // victoire.
    expect(
      registreSynchro({
        erreur: null,
        succes:
          "Connexion établie — 3 compte(s) rattaché(s) sur 1 banque(s)." +
          " 1 connexion(s) n'ont pas pu être finalisées.",
        complet: false,
        echecs: 1,
      }),
    ).toBe("neutre");
  });

  it("finalisation drop-in COMPLÈTE → `succes` (le vert reste dû quand tout va bien)", () => {
    expect(
      registreSynchro({
        erreur: null,
        succes: "Connexion établie — 3 compte(s) rattaché(s) sur 1 banque(s).",
        complet: true,
      }),
    ).toBe("succes");
  });
});
