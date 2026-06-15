/**
 * État LOADING du dashboard (Suspense RSC natif). Next monte ce fichier pendant
 * que `page.tsx` résout les 5 services dans `withWorkspace`. Le shell
 * (header/nav, via le layout du groupe) reste affiché ; seul le contenu de la
 * zone de données passe en skeleton.
 *
 * Réutilise `DashboardLoadingState` (livré PR #12) — même squelette que la forme
 * réelle (carte courbe + table), donc pas de saut de layout au passage au
 * contenu. On le monte dans la coquille pour conserver le side-panel à sa place.
 */
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { DashboardLoadingState } from "@/components/dashboard/states";

export default function DashboardLoading() {
  return (
    <DashboardShell>
      <DashboardLoadingState />
    </DashboardShell>
  );
}
