/**
 * REGISTRE d'affichage du retour de synchronisation — logique PURE, séparée du visuel, et
 * PARTAGÉE par les deux écrans qui appellent `synchroniserConnexionsAction` : le bouton du
 * dashboard (`dashboard/sync-button.tsx`) et le widget de /banques (`widget/widget-feedback.tsx`).
 *
 * Pourquoi ce module existe (dette SYNC-TYPE-STRUCTUREL1, revue PR #202) : les DEUX écrans
 * rendaient `succes` en VERT dès qu'il était non nul, sans jamais lire de signal structuré.
 * Or l'action est FAIL-SOFT : une banque en `SCRAPER_ERROR` laisse `erreur` à `null` et écrit
 * l'échec DANS `succes`. Le vert triomphal se posait donc par-dessus une banque morte — le
 * dashboard allant jusqu'à jeter le message pour afficher « Comptes à jour. » en dur.
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
 * Ton du message rendu :
 *  - `erreur` : quelque chose a planté → `text-danger` + `role="alert"` ;
 *  - `succes` : synchro pleine, AUCUNE réserve → `text-success` (le seul vert autorisé) ;
 *  - `neutre` : la synchro a abouti mais une RÉSERVE subsiste (échec partiel, scrape encore
 *    en cours, réparation, reconnexion) → `text-text-muted`. Ni rouge (rien n'a planté), ni
 *    vert (ce n'est pas « à jour ») ;
 *  - `muet`  : rien à dire dans ce canal (ni erreur ni succès — le cas « aucune banque à
 *    synchroniser » passe par `info`, canal distinct).
 */
export type RegistreSynchro = "erreur" | "succes" | "neutre" | "muet";

/**
 * Une RÉSERVE subsiste-t-elle sur cette synchro ? Si oui, le vert est INTERDIT : annoncer
 * « à jour » alors qu'une banque a échoué, que le scrape tourne encore, ou qu'une réparation
 * est requise est exactement le faux message de victoire corrigé par la PR #202.
 *
 * ⚠️ `rateLimited` n'est PAS une réserve — c'est contre-intuitif, donc on l'explique. Sous
 * cooldown on ne re-déclenche pas de scrape, mais on RELIT tout : la branche RATE_LIMITED ne
 * fait PAS `continue` (orchestration.ts), donc `persisterConnexionEtComptes` rafraîchit les
 * soldes et `synchroniserCompte` ré-ingère les transactions. Les données SONT à jour. Et
 * depuis le correctif du 2ᵉ clic, un job qui tourne ENCORE sous cooldown ressort en INCOMPLET,
 * plus en RATE_LIMITED : un RATE_LIMITED résiduel signifie donc que le dernier scrape est
 * TERMINÉ. En faire une réserve rendrait le vert structurellement inatteignable pour toute
 * banque lente, et contredirait le message du serveur — qui compte ces banques comme « à
 * jour » (`banquesOk`, actions.ts). Deux sources de vérité qui divergent sur la même synchro :
 * c'est exactement la classe de bug qu'on élimine ici.
 */
function aUneReserve(r: EtatFinalisation): boolean {
  return (
    r.incomplet === true ||
    (r.echecs ?? 0) > 0 ||
    (r.reparation?.length ?? 0) > 0 ||
    (r.aReconnecter?.length ?? 0) > 0
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
