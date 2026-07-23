/**
 * Décision de RÉSOLUTION TENANT du webhook — fonction PURE (zéro I/O), testée en
 * isolation (§10.1 cas 4). Consomme les lignes rendues par `resoudreConnexionParId`
 * (bornées à LIMIT 2) et décide, SANS JAMAIS choisir arbitrairement :
 *   - 0 ligne   → quarantaine `CONNEXION_INCONNUE` (webhook avant `link-exchange` :
 *                 cas NOMINAL du tout premier sync, pas une anomalie) ;
 *   - ≥ 2 lignes → quarantaine `AMBIGUE` (router au hasard EST le cross-tenant que
 *                 WEBHOOK-TENANT-FIRST1 interdit — code mort tant que l'unique globale
 *                 vit, écrit quand même : ne pas faire dépendre l'isolation d'un futur
 *                 geste humain, règle 9) ;
 *   - 1 ligne   → résolue → candidate au cross-check d'environnement (§5.3).
 *
 * Le TYPE de la ligne vient du client de service (couche DB) ; l'import est `type`-only
 * (erased à la compilation) → ce module reste PUR au runtime (aucun chargement de
 * service.ts, donc aucune connexion DB tirée par le test de la décision).
 *
 * Spec : docs/specs/PLAN-webhook-ingestion.md §5.
 */
import type { LigneConnexionResolue } from "@/server/db/service";

export type DecisionResolution =
  | { type: "RESOLUE"; connexion: LigneConnexionResolue }
  | { type: "QUARANTAINE"; motif: "CONNEXION_INCONNUE" | "AMBIGUE" };

export function deciderResolution(
  lignes: readonly LigneConnexionResolue[],
): DecisionResolution {
  if (lignes.length === 0) {
    return { type: "QUARANTAINE", motif: "CONNEXION_INCONNUE" };
  }
  if (lignes.length >= 2) {
    // JAMAIS lignes[0] : l'ambiguïté ne se tranche pas, elle se met en quarantaine.
    return { type: "QUARANTAINE", motif: "AMBIGUE" };
  }
  return { type: "RESOLUE", connexion: lignes[0] };
}
