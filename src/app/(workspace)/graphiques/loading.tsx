/**
 * État LOADING de la page « Analyse par catégorie » — skeleton neutre rendu pendant
 * que le RSC résout la répartition (Suspense automatique de Next). Épouse la forme
 * réelle (titre + sélecteurs + carte donut/légende) pour éviter le saut de layout.
 * Aucune couleur sémantique (le chargement n'est pas de la donnée — convention §6.5) :
 * le donut placeholder est un anneau `surface-inset`, jamais une teinte catégorielle.
 */
export default function ChargementGraphiques() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <div className="mb-6">
        <div className="h-6 w-56 animate-pulse rounded bg-surface-inset" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-surface-inset" />
      </div>

      {/* Sélecteurs (sens + période) */}
      <div className="mb-5 flex flex-wrap gap-3">
        <div className="h-9 w-40 animate-pulse rounded-full bg-surface-inset" />
        <div className="h-9 w-72 max-w-full animate-pulse rounded-full bg-surface-inset" />
      </div>

      {/* Carte donut + légende */}
      <div className="rounded-card border border-line bg-surface-card p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <div className="h-5 w-40 animate-pulse rounded bg-surface-inset" />
          <div className="h-3 w-20 animate-pulse rounded bg-surface-inset" />
        </div>

        <div className="flex flex-col items-center gap-8 sm:flex-row">
          {/* Anneau placeholder (donut) — bordure épaisse pour figurer le trou central. */}
          <div className="h-[200px] w-[200px] shrink-0 animate-pulse rounded-full border-[36px] border-surface-inset" />

          {/* Lignes de légende */}
          <ul className="w-full min-w-0 flex-1 flex flex-col gap-2.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-surface-inset" />
                <span className="h-4 flex-1 animate-pulse rounded bg-surface-inset" />
                <span className="h-4 w-24 shrink-0 animate-pulse rounded bg-surface-inset" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
