/**
 * Tests du drapeau d'arrivée « une banque vient d'être connectée ».
 *
 * L'enjeu : l'invite « lancez une première synchronisation » ne doit JAMAIS se réafficher
 * au-dessus d'un dashboard déjà synchronisé. Le défaut corrigé (cross-review 8/10) venait
 * du bouton Précédent, qui restaure l'URL verbatim alors que l'état React, lui, est
 * reparti de zéro. La correction fait du drapeau un JETON À USAGE UNIQUE, consommé de
 * l'historique — c'est `urlSansDrapeauConnexion` qui produit l'URL de substitution, et
 * son piège n'est pas de retirer le drapeau mais de PRÉSERVER le reste.
 */
import { describe, expect, it } from "vitest";

import {
  drapeauConnexionArme,
  nudgeEstVisible,
  urlSansDrapeauConnexion,
} from "@/components/sync/drapeau-connexion";

describe("drapeauConnexionArme — fail-safe par égalité stricte", () => {
  it("arme sur la valeur exacte (chemin heureux)", () => {
    expect(drapeauConnexionArme("etablie")).toBe(true);
  });

  it("n'arme sur RIEN d'autre", () => {
    expect(drapeauConnexionArme(undefined)).toBe(false);
    expect(drapeauConnexionArme("")).toBe(false);
    expect(drapeauConnexionArme("Etablie")).toBe(false);
    expect(drapeauConnexionArme("etablie ")).toBe(false);
    expect(drapeauConnexionArme("1")).toBe(false);
  });

  it("n'arme pas sur un paramètre RÉPÉTÉ (arrive en tableau)", () => {
    expect(drapeauConnexionArme(["etablie", "etablie"])).toBe(false);
    expect(drapeauConnexionArme(["etablie"])).toBe(false);
  });
});

describe("urlSansDrapeauConnexion — consommation du jeton", () => {
  it("retire le drapeau et rend le pathname nu quand il était seul", () => {
    expect(urlSansDrapeauConnexion("/", "?connexion=etablie")).toBe("/");
  });

  it("PRÉSERVE la période — la régression que ce module doit éviter", () => {
    // Une version naïve (« remplacer par le pathname nu ») ferait sauter la fenêtre
    // choisie au moment précis où l'utilisateur arrive sur son dashboard.
    const url = urlSansDrapeauConnexion(
      "/",
      "?periode=3m&connexion=etablie&du=2026-03-03&au=2026-04-17",
    );
    expect(url).not.toBeNull();
    const params = new URLSearchParams(url!.split("?")[1]);
    expect(params.get("periode")).toBe("3m");
    expect(params.get("du")).toBe("2026-03-03");
    expect(params.get("au")).toBe("2026-04-17");
    expect(params.has("connexion")).toBe(false);
  });

  it("rend null quand il n'y a rien à consommer → l'appelant ne touche PAS à l'historique", () => {
    // C'est ce qui rend l'opération idempotente, y compris sous le double-montage des
    // effets en développement (le 2e passage ne trouve plus le drapeau).
    expect(urlSansDrapeauConnexion("/", "")).toBeNull();
    expect(urlSansDrapeauConnexion("/", "?periode=3m")).toBeNull();
  });

  it("retire TOUTES les occurrences d'un drapeau répété (cas limite)", () => {
    expect(
      urlSansDrapeauConnexion("/", "?connexion=etablie&connexion=etablie"),
    ).toBe("/");
  });

  it("consomme le drapeau même sur une valeur non reconnue — sinon il resterait collé à l'URL", () => {
    expect(urlSansDrapeauConnexion("/", "?connexion=nimporte&periode=6m")).toBe(
      "/?periode=6m",
    );
  });
});

describe("nudgeEstVisible", () => {
  it("s'arme au PREMIER passage légitime — le chemin qui doit continuer de marcher", () => {
    expect(nudgeEstVisible({ arme: true, enCours: false, aUnRetour: false })).toBe(
      true,
    );
  });

  it("ne s'arme pas sans drapeau (cas du RETOUR ARRIÈRE, jeton déjà consommé)", () => {
    // Après consommation, l'entrée d'historique ne porte plus le drapeau : la page se
    // re-rend avec `arme: false`. C'est ça qui tue la réapparition.
    expect(
      nudgeEstVisible({ arme: false, enCours: false, aUnRetour: false }),
    ).toBe(false);
  });

  it("s'efface pendant la synchro — le loader prend le relais", () => {
    expect(nudgeEstVisible({ arme: true, enCours: true, aUnRetour: false })).toBe(
      false,
    );
  });

  it("s'efface après une synchro sans quitter la page — sinon il contredirait le compte rendu", () => {
    expect(nudgeEstVisible({ arme: true, enCours: false, aUnRetour: true })).toBe(
      false,
    );
  });
});
