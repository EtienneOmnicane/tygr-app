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
 * Assouplissement DEV UNIQUEMENT (Volet C, DURCI après audit sécurité C1) : on
 * tolère `http://localhost` / `http://127.0.0.1` SEULEMENT si l'origine est
 * allowlistée ET que la tolérance est activée par un OPT-IN EXPLICITE
 * (`APP_ALLOW_INSECURE_LOCALHOST="1"`) — PAS déduite de `NODE_ENV` seul. Raison
 * (audit C1) : `NODE_ENV === "production"` échoue OUVERT si la var est absente ou
 * mal casée (`undefined`, `""`, `"Production"`, `"staging"`) ; un contrôle de
 * sécurité ne doit pas dépendre d'une var d'env oubliable. Double garde : même avec
 * l'opt-in, le chemin reste mort si `NODE_ENV === "production"`. Le widget natif
 * exige https de toute façon ; ceci sert juste à tester le DÉMARRAGE en local.
 */
export function localhostInsecureAutorise(): boolean {
  return (
    process.env.APP_ALLOW_INSECURE_LOCALHOST === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

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

  // Non-https : toléré UNIQUEMENT via opt-in dev explicite, et seulement pour
  // localhost/loopback. En prod OU sans opt-in → « protocole » (fail-closed).
  const estLoopback =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (estLoopback && localhostInsecureAutorise()) return "ok";

  return "protocole";
}
