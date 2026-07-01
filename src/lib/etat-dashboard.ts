/**
 * Logique PURE de sélection de l'état d'affichage du dashboard (Epic 3, PR D).
 * Extraite de `DashboardContent` pour être testable sans rendu React (le projet
 * n'outille pas le test de composants ; cette fonction, elle, est testable
 * unitairement).
 *
 * Trois états (décisions revue eng) :
 *   - "vide"    : AUCUN compte connecté → empty global + CTA de connexion.
 *   - "partiel" : comptes présents MAIS aucun flux (workspace fraîchement
 *                 connecté, transactions pas encore synchronisées) → KPI/solde
 *                 affichés, courbe et table avec leur propre vide par section.
 *   - "complet" : comptes + au moins un point de flux → dashboard plein.
 *
 * La distinction vide/partiel se fait sur la PRÉSENCE de comptes, pas sur les
 * flux : un workspace avec comptes mais sans données n'est pas « vide », il est
 * en cours de synchronisation. (La courbe trace le flux net mensuel dérivé des
 * transactions — `flux` ; balance_history n'est plus la source, cf.
 * cashflow-main-chart.)
 */
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

export type EtatDashboard = "vide" | "partiel" | "complet";

export function choisirEtatDashboard(donnees: DonneesDashboard): EtatDashboard {
  if (donnees.comptes.length === 0) {
    return "vide";
  }
  if (donnees.flux.length === 0) {
    return "partiel";
  }
  return "complet";
}
