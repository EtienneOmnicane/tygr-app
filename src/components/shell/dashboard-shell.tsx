/**
 * Coquille de mise en page asymétrique du dashboard (UI_GUIDELINES §1.1) :
 * side-panel KPI fixe (300px, sticky sous le header) + zone de données
 * scrollable (min-w-0 pour autoriser le rétrécissement des enfants larges
 * comme la table/le graphe).
 *
 * Présentationnel PUR : aucune donnée, aucun état. Le contenu du side-panel
 * et de la zone de données est injecté par le parent (la page câble les vrais
 * KPI ; la démo câble des fixtures). C'est la « coquille réutilisable » que la
 * page dashboard ET la page de démo partagent — pas de chrome dupliqué.
 *
 *   ┌──────────────┬───────────────────────────────────────┐
 *   │ aside 300px  │  main (min-w-0, flex-1)               │
 *   │ sticky top-? │  ┌ une ancre par écran (courbe) ──┐   │
 *   │ KPI / solde  │  └────────────────────────────────┘   │
 *   │ (optionnel)  │  table / autres cartes                │
 *   └──────────────┴───────────────────────────────────────┘
 *
 * `aside` est optionnel (UI_GUIDELINES §6.7 : side-panel seulement si des KPI
 * contextuels existent ; sinon pleine largeur). Absent → la zone de données
 * occupe toute la largeur.
 */
import type { ReactNode } from "react";

export function DashboardShell({
  aside,
  children,
}: {
  /** Contenu du side-panel KPI (300px). Absent → zone de données pleine largeur. */
  aside?: ReactNode;
  /** Zone de données scrollable (graphe ancre + table…). */
  children: ReactNode;
}) {
  return (
    <div className="flex gap-6 px-6 py-6">
      {aside ? (
        <aside className="hidden w-[300px] shrink-0 flex-col gap-6 lg:flex">
          {aside}
        </aside>
      ) : null}
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
