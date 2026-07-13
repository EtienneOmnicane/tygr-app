/**
 * REGISTRE d'affichage du retour de synchronisation — logique PURE, séparée du visuel.
 *
 * Pourquoi ce module existe (dette SYNC-TYPE-STRUCTUREL1, revue PR #202) : le dashboard
 * affichait « Comptes à jour. » en VERT, **en dur**, dès que `succes` était non nul — sans
 * jamais lire son contenu. `succes` n'y servait que de booléen de présence. Résultat : une
 * banque en `SCRAPER_ERROR` (fail-soft, `erreur` reste `null`), un cooldown, ou un scrape
 * encore en cours produisaient tous un FAUX MESSAGE DE VICTOIRE — alors que l'action, elle,
 * construit un message exact (« 1 banque(s) n'ont pas pu être synchronisées… »).
 *
 * Séparation des responsabilités, désormais :
 *  - le TEXTE vient du SERVEUR (`erreur` / `succes` / `info`) — plus aucun statut en dur ;
 *  - le TON est décidé ICI, à partir des signaux STRUCTURÉS (jamais en parsant la phrase).
 *
 * Pur (zéro React, zéro I/O) parce que le projet n'a pas de renderer React de test
 * (CLAUDE.md) : c'est la seule façon de PROUVER par un test qu'une banque en échec ne
 * ressort pas en vert. Même principe que `machine-mfa.ts`.
 */
import type { EtatFinalisation } from "@/app/(workspace)/banques/actions";

/**
 * Ton du message rendu sous le bouton :
 *  - `erreur` : quelque chose a planté → `text-danger` + `role="alert"` ;
 *  - `succes` : synchro pleine, AUCUNE réserve → `text-success` (le seul vert autorisé) ;
 *  - `neutre` : la synchro a abouti mais une RÉSERVE subsiste (échec partiel, scrape en
 *    cours, cooldown, réparation, reconnexion) → `text-text-muted`. Ni rouge (rien n'a
 *    planté), ni vert (ce n'est pas « à jour ») ;
 *  - `muet`  : rien à dire dans ce canal (l'action n'a produit ni erreur ni succès — le
 *    cas « aucune banque à synchroniser » passe par `info`, canal distinct).
 */
export type RegistreSynchro = "erreur" | "succes" | "neutre" | "muet";

/**
 * Une RÉSERVE subsiste-t-elle sur cette synchro ? Si oui, le vert est INTERDIT : annoncer
 * « à jour » alors qu'une banque a échoué / que le scrape tourne encore / qu'on n'a fait
 * que relire un cache est exactement le faux message de victoire corrigé par la PR #202.
 *
 * `rateLimited` compte comme une réserve : sous cooldown, on n'a RIEN rafraîchi — on a
 * relu le dernier état connu. Le dire en vert affirmerait plus que ce qu'on a fait.
 */
function aUneReserve(r: EtatFinalisation): boolean {
  return (
    r.incomplet === true ||
    (r.echecs ?? 0) > 0 ||
    (r.reparation?.length ?? 0) > 0 ||
    (r.aReconnecter?.length ?? 0) > 0 ||
    (r.rateLimited?.length ?? 0) > 0
  );
}

/**
 * Registre du message principal. `null` = action jamais lancée (état de repos).
 *
 * L'ordre est significatif : une `erreur` prime sur tout (elle est exclusive côté action —
 * `succes` est alors `null`), puis l'absence de message rend le canal muet, et seule une
 * synchro SANS la moindre réserve obtient le vert.
 */
export function registreSynchro(r: EtatFinalisation | null): RegistreSynchro {
  if (r === null) return "muet";
  if (r.erreur !== null) return "erreur";
  if (!r.succes) return "muet";
  return aUneReserve(r) ? "neutre" : "succes";
}
