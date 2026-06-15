/**
 * Logique PURE de sélection de l'état d'affichage du dashboard (Epic 3, PR D).
 * Extraite de `DashboardContent` pour être testable sans rendu React (le projet
 * n'outille pas le test de composants ; cette fonction, elle, est testable
 * unitairement).
 *
 * Trois états (décisions revue eng) :
 *   - "vide"    : AUCUN compte connecté → empty global + CTA de connexion.
 *   - "partiel" : comptes présents MAIS courbe vide (workspace fraîchement
 *                 connecté, soldes pas encore synchronisés) → KPI/solde affichés,
 *                 courbe et table avec leur propre vide par section.
 *   - "complet" : comptes + au moins un point de courbe → dashboard plein.
 *
 * La distinction vide/partiel se fait sur la PRÉSENCE de comptes, pas sur la
 * courbe : un workspace avec comptes mais sans historique n'est pas « vide »,
 * il est en cours de synchronisation.
 */
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

export type EtatDashboard = "vide" | "partiel" | "complet";

export function choisirEtatDashboard(donnees: DonneesDashboard): EtatDashboard {
  if (donnees.comptes.length === 0) {
    return "vide";
  }
  if (donnees.courbe.length === 0) {
    return "partiel";
  }
  return "complet";
}
