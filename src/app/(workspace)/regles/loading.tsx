/**
 * État LOADING de la page « Règles » — skeleton neutre rendu pendant que le RSC
 * résout règles + catégories (Suspense automatique de Next). Épouse la forme réelle
 * (titre + barre de création + liste) pour éviter le saut de layout. Aucune couleur
 * sémantique (le chargement n'est pas de la donnée — convention §6.5).
 */
export default function ChargementRegles() {
  return (
    <main className="w-full flex-1 px-6 py-8">
      <div className="mb-6">
        <div className="h-6 w-56 animate-pulse rounded bg-surface-inset" />
        <div className="mt-2 h-4 w-80 animate-pulse rounded bg-surface-inset" />
      </div>

      {/* Barre de création */}
      <div className="h-[88px] animate-pulse rounded-control border border-line bg-surface-inset" />

      {/* Liste de règles */}
      <ul className="mt-4 flex flex-col gap-px overflow-hidden rounded-control border border-line">
        {[0, 1, 2].map((i) => (
          <li key={i} className="h-[52px] animate-pulse bg-surface-inset" />
        ))}
      </ul>
    </main>
  );
}
