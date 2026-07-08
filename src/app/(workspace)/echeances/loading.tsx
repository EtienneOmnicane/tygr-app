/**
 * État LOADING de la page « Échéances » — skeleton neutre rendu pendant que le RSC
 * résout la vue (liste triée + synthèse) + catégories (Suspense automatique de Next).
 * Épouse la forme réelle (titre + synthèse + barre de saisie + sélecteur + liste) pour
 * éviter le saut de layout. Aucune couleur sémantique (le chargement n'est pas de la
 * donnée — convention §6.5), montants placeholders en `tabular-nums`.
 */
export default function ChargementEcheances() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <div className="mb-6">
        <div className="h-6 w-64 animate-pulse rounded bg-surface-inset" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-surface-inset" />
      </div>

      {/* Synthèse prévisionnelle (3 horizons) */}
      <div className="rounded-card border border-line bg-surface-forecast p-4">
        <div className="mb-4 h-4 w-40 animate-pulse rounded bg-surface-inset" />
        <div className="flex flex-col gap-3 sm:flex-row">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-28 flex-1 animate-pulse rounded-control border border-line bg-surface-inset"
            />
          ))}
        </div>
      </div>

      {/* Barre de saisie */}
      <div className="mt-4 h-[132px] animate-pulse rounded-control border border-line bg-surface-inset" />

      {/* Sélecteur de direction */}
      <div className="mt-4 h-9 w-56 animate-pulse rounded-control bg-surface-inset" />

      {/* Liste d'échéances */}
      <ul className="mt-4 flex flex-col gap-px overflow-hidden rounded-control border border-line">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="h-[68px] animate-pulse bg-surface-inset" />
        ))}
      </ul>
    </main>
  );
}
