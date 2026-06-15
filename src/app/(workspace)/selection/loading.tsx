/**
 * État LOADING du sélecteur (D2) — skeleton liste, rendu pendant que le RSC
 * résout membershipsAvecNom (Suspense automatique de Next).
 */
export default function ChargementSelection() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-card bg-surface-card p-8 shadow-card">
        <div className="h-5 w-20 animate-pulse rounded bg-surface-inset" />
        <div className="mt-2 mb-6 h-4 w-64 animate-pulse rounded bg-surface-inset" />
        <ul className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-[58px] animate-pulse rounded-control border border-line
                bg-surface-inset"
            />
          ))}
        </ul>
      </div>
    </main>
  );
}
