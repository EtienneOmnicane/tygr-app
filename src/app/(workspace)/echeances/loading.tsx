/**
 * État LOADING de la page « Échéances » — skeleton neutre rendu pendant que le RSC
 * résout la vue (liste triée + synthèse) + catégories (Suspense automatique de Next).
 * Épouse la forme réelle (layout §1.1 : side-panel synthèse + zone de données) pour
 * éviter le saut de layout. Aucune couleur sémantique (le chargement n'est pas de la
 * donnée — convention §6.5), montants placeholders en `tabular-nums`.
 */
import { DashboardShell } from "@/components/shell/dashboard-shell";

/** Bloc synthèse skeleton empilé verticalement (side-panel §1.1, 300px). */
function SyntheseSkeleton({ vertical = false }: { vertical?: boolean }) {
  return (
    <div className="rounded-card border border-line bg-surface-forecast p-4">
      <div className="mb-4 h-4 w-40 animate-pulse rounded bg-surface-inset" />
      <div className={vertical ? "flex flex-col gap-3" : "flex flex-col gap-3 sm:flex-row"}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 flex-1 animate-pulse rounded-control border border-line bg-surface-inset"
          />
        ))}
      </div>
    </div>
  );
}

export default function ChargementEcheances() {
  return (
    <DashboardShell aside={<SyntheseSkeleton vertical />}>
      <div className="flex flex-col gap-4">
        {/* En-tête */}
        <div>
          <div className="h-6 w-64 animate-pulse rounded bg-surface-inset" />
          <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-surface-inset" />
        </div>

        {/* Synthèse inline (remontée sous lg, où l'aside est masqué). */}
        <div className="lg:hidden">
          <SyntheseSkeleton />
        </div>

        {/* Barre de saisie */}
        <div className="h-[132px] animate-pulse rounded-control border border-line bg-surface-inset" />

        {/* Sélecteur de direction */}
        <div className="h-9 w-56 animate-pulse rounded-control bg-surface-inset" />

        {/* Liste d'échéances */}
        <ul className="flex flex-col gap-px overflow-hidden rounded-control border border-line">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-[68px] animate-pulse bg-surface-inset" />
          ))}
        </ul>
      </div>
    </DashboardShell>
  );
}
