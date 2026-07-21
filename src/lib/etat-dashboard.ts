/**
 * Logique PURE de sélection de l'état d'affichage du dashboard (Epic 3, PR D).
 * Extraite de `DashboardContent` pour être testable sans rendu React (le projet
 * n'outille pas le test de composants ; cette fonction, elle, est testable
 * unitairement).
 *
 * Quatre états (décisions revue eng, + NUDGE-VISION-ENTITE1) :
 *   - "vide"           : AUCUN compte connecté ET rien à voir dans le tenant → empty
 *                        global + CTA de connexion.
 *   - "hors-perimetre" : AUCUN compte VISIBLE, mais le tenant a au moins une connexion
 *                        ET le lecteur est borné → ses comptes existent hors de son
 *                        périmètre. Voir ci-dessous : c'est un état DISTINCT, pas un vide.
 *   - "partiel"        : comptes présents MAIS aucun flux (workspace fraîchement
 *                        connecté, transactions pas encore synchronisées) → KPI/solde
 *                        affichés, courbe et table avec leur propre vide par section.
 *   - "complet"        : comptes + au moins un point de flux → dashboard plein.
 *
 * La distinction vide/partiel se fait sur la PRÉSENCE de comptes, pas sur les
 * flux : un workspace avec comptes mais sans données n'est pas « vide », il est
 * en cours de synchronisation. (La courbe trace le flux net mensuel dérivé des
 * transactions — `flux` ; balance_history n'est plus la source, cf.
 * cashflow-main-chart.)
 *
 * ⚠️ POURQUOI « hors-perimetre » EXIGE LES DEUX DRAPEAUX (NUDGE-VISION-ENTITE1) —
 * `aDesConnexionsTenant` seul ne suffit PAS, et s'en contenter fait mentir l'écran :
 * une connexion peut être commitée avec ZÉRO compte (découverte vide, ou comptes tous
 * écartés par le filtre `Status !== "Enabled"` de l'orchestration — cas qui a déjà vidé
 * une synchro en production). Un ADMIN en Vision Globale, sur un workspace sans aucune
 * entité, tomberait alors sur « un administrateur doit vous donner accès » : il EST
 * l'administrateur, et il n'y a aucun compte à rattacher. `lecteurBorne` — vrai
 * uniquement si le contexte serveur résout un périmètre entité ou compte — réserve donc
 * cet état à quelqu'un pour qui « hors de votre périmètre » a un sens.
 */
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

export type EtatDashboard =
  | "vide"
  | "hors-perimetre"
  | "partiel"
  | "complet";

export function choisirEtatDashboard(donnees: DonneesDashboard): EtatDashboard {
  if (donnees.comptes.length === 0) {
    // Ordre significatif : « hors périmètre » se décide AVANT « vide », car les deux
    // partagent `comptes.length === 0` — c'est justement ce que le modèle initial
    // confondait.
    return donnees.lecteurBorne && donnees.aDesConnexionsTenant
      ? "hors-perimetre"
      : "vide";
  }
  if (donnees.flux.length === 0) {
    return "partiel";
  }
  return "complet";
}
