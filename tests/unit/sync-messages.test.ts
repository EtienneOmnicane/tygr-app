/**
 * Messages du bouton « Synchroniser mes comptes » (`messages-sync.ts`).
 *
 * Défaut corrigé (2026-07-13, incident « spinner puis rien ») : quand le sync n'avait
 * aucune connexion à traiter, l'action renvoyait `{ erreur: null, succes: null }` — RIEN à
 * l'écran. Diagnostic runtime : la base portait 2 connexions (SBM, MCB) que l'amont ne
 * renvoyait plus, et Omni-FI en portait 1 (Bank One) absente de la base → intersection
 * vide → 0 connexion traitée → silence total.
 *
 * L'invariant verrouillé ici : **aucun état ne peut plus être muet**, et tout signal porte
 * une ACTION. Les messages restent NON-ÉNUMÉRANTS (on compte les banques, on ne les nomme
 * jamais, aucun identifiant de connexion n'est exposé — règle 3).
 */
import { describe, expect, it } from "vitest";

import {
  messageAucuneConnexion,
  supplementsDesync,
} from "@/server/widget/messages-sync";

describe("supplementsDesync", () => {
  it("tout aligné → chaîne VIDE (l'appelant concatène sans condition)", () => {
    expect(supplementsDesync({ nonRattachees: 0, inutilisables: 0 })).toBe("");
  });

  it("banque connectée chez Omni-FI mais non rattachée → action « finaliser »", () => {
    const m = supplementsDesync({ nonRattachees: 1, inutilisables: 0 });
    expect(m).toContain("ne sont pas rattachées");
    expect(m).toContain("Connecter une banque");
  });

  it("banque locale qui ne répond plus → action « reconnecter »", () => {
    const m = supplementsDesync({ nonRattachees: 0, inutilisables: 2 });
    expect(m).toContain("ne répondent plus");
    expect(m).toContain("reconnectez-les");
  });

  it("les deux désyncs → les deux phrases, chacune avec son action", () => {
    const m = supplementsDesync({ nonRattachees: 1, inutilisables: 2 });
    expect(m).toContain("ne sont pas rattachées");
    expect(m).toContain("ne répondent plus");
  });
});

describe("messageAucuneConnexion — le silence est INTERDIT", () => {
  it("CAS RÉEL de l'incident (1 non rattachée + 2 absentes) → dit la cause ET l'action", () => {
    // L'état exact observé en base le 2026-07-13 : Bank One connectée chez Omni-FI mais
    // absente de `bank_connections` ; SBM + MCB en base mais introuvables côté amont.
    const m = messageAucuneConnexion({ nonRattachees: 1, inutilisables: 2 });
    expect(m).toContain("Aucune banque à synchroniser");
    expect(m).toContain("1 banque(s)");
    expect(m).toContain("2 banque(s)");
    expect(m).toContain("Connecter une banque");
  });

  it("aucune désync → message BANAL explicite, jamais le vide", () => {
    // Le cas « je n'ai simplement aucune banque » doit lui aussi PARLER : c'est le silence
    // qu'on corrige, pas seulement le cas exotique.
    const m = messageAucuneConnexion({ nonRattachees: 0, inutilisables: 0 });
    expect(m).toContain("Aucune banque connectée");
    expect(m.length).toBeGreaterThan(0);
  });

  it("ne renvoie JAMAIS une chaîne vide, quels que soient les compteurs", () => {
    for (const nonRattachees of [0, 1, 5]) {
      for (const inutilisables of [0, 1, 5]) {
        expect(
          messageAucuneConnexion({ nonRattachees, inutilisables }).trim().length,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("NON-ÉNUMÉRANT : aucun nom de banque ni identifiant de connexion", () => {
    const m = messageAucuneConnexion({ nonRattachees: 3, inutilisables: 4 });
    // Les valeurs réelles de l'incident : elles ne doivent JAMAIS pouvoir apparaître, la
    // fonction ne reçoit que des COMPTES.
    for (const fuite of ["Bank One", "State Bank", "Mauritius Commercial", "6a49e45c"]) {
      expect(m).not.toContain(fuite);
    }
  });
});
