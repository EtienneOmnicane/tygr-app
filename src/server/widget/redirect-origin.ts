/**
 * Validation d'AUTORISATION du RedirectOrigin du widget Link (constat cross-review
 * 3.1). Module PUR (pas `"use server"`) → testable unitairement, et la logique de
 * sécurité ne vit pas dans le fichier d'actions.
 *
 * Le RedirectOrigin vient du client (`window.location.origin`) : c'est la cible
 * postMessage qui recevra le PublicToken. Le valider est une frontière de sécurité —
 * une origine tierce ne doit JAMAIS pouvoir s'y poser.
 *
 * Règle 8 : ce module ne logge rien et ne reçoit aucun secret ; il décide seulement.
 */

/** Motif d'acceptation/rejet (loggé côté serveur, jamais exposé tel quel à l'UI). */
export type MotifOrigine = "ok" | "forme" | "protocole" | "non_allowliste";

/**
 * Allowlist serveur (APP_ALLOWED_ORIGINS, liste séparée par virgules). Si l'env
 * n'est pas configuré → ensemble VIDE → on n'autorise RIEN (fail-closed). Lue à
 * chaque appel (pas de cache) pour rester correcte si l'env change entre tests.
 */
export function originesAutorisees(): Set<string> {
  const brut = process.env.APP_ALLOWED_ORIGINS ?? "";
  return new Set(
    brut
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/**
 * Décide si une origine de redirection est autorisée à recevoir le PublicToken.
 *
 * Invariants de SÉCURITÉ (inchangés en production) :
 *  - forme stricte : scheme+host SANS path/query/fragment (contrat link-token) ;
 *  - l'origine DOIT figurer dans l'allowlist serveur (fail-closed si vide) ;
 *  - en PRODUCTION, le protocole DOIT être https (la cible postMessage d'un secret
 *    ne transite jamais en clair).
 *
 * Assouplissement DEV UNIQUEMENT (Volet C) : hors production (`NODE_ENV !==
 * "production"`), on tolère `http://localhost` / `http://127.0.0.1` POURVU que
 * l'origine soit explicitement allowlistée. Le widget natif exige https de toute
 * façon ; ceci sert à tester le DÉMARRAGE (création du LinkToken) en local sans
 * ouvrir la porte à une origine tierce. En prod ce chemin est mort (`estProd`).
 */
export function autoriserRedirectOrigin(brut: string): MotifOrigine {
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    return "forme";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return "forme";
  }
  // L'allowlist est la barrière non négociable, en dev comme en prod.
  if (!originesAutorisees().has(url.origin)) {
    return "non_allowliste";
  }

  if (url.protocol === "https:") return "ok";

  // Non-https : toléré UNIQUEMENT en dev local, et seulement pour localhost/loopback.
  const estProd = process.env.NODE_ENV === "production";
  const estLoopback =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!estProd && estLoopback) return "ok";

  return "protocole";
}
