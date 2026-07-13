/**
 * Skeleton de `/admin/entites` (L5, dette `ENTITY-ASSIGN-POLISH1 (c)`).
 *
 * `loading.tsx` natif : l'attente vient du RSC lui-même (Suspense automatique de Next
 * pendant que la page résout ses quatre lectures dans `withWorkspace`). C'est le défaut
 * pour un segment de route qui fetch côté serveur (convention CLAUDE.md).
 *
 * Il ÉPOUSE LA FORME RÉELLE de l'écran — mêmes blocs, mêmes hauteurs, même ordre — pour
 * qu'il n'y ait aucun saut de layout à l'arrivée des données. C'est pour ça qu'il est
 * écrit EN DERNIER : la forme a changé à chaque lot (bandeau en L1, liste d'entités en L2,
 * cases + barre d'action en L3, bannière en L4). L'écrire plus tôt aurait imposé de le
 * réécrire trois fois.
 *
 * Aucune couleur sémantique (`inflow`/`outflow`/`success`/`warning`) : le chargement n'est
 * pas de la donnée. `SkeletonBlock` est `aria-hidden` — un lecteur d'écran n'annonce pas
 * des formes vides.
 */
import { SkeletonBlock } from "@/components/ui/states";

function Tuile() {
  return (
    <div className="flex min-w-[120px] flex-col gap-2 rounded-control bg-surface-inset px-4 py-3">
      <SkeletonBlock className="h-7 w-10" />
      <SkeletonBlock className="h-3 w-16" />
    </div>
  );
}

function LigneTableau() {
  return (
    <div className="flex items-center gap-4 border-b border-line px-4 py-3">
      <SkeletonBlock className="size-4" rounded="control" />
      <SkeletonBlock className="h-4 flex-1" />
      <SkeletonBlock className="h-4 w-10" />
      <SkeletonBlock className="h-8 w-[200px]" rounded="control" />
    </div>
  );
}

export default function ChargementEntites() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <div className="flex flex-col gap-8">
        {/* En-tête */}
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-6 w-32" />
          <SkeletonBlock className="h-4 w-96 max-w-full" />
        </div>

        {/* Bandeau récap — 4 tuiles */}
        <div className="rounded-card border border-line bg-surface-card p-5 shadow-card">
          <div className="flex flex-wrap gap-3">
            <Tuile />
            <Tuile />
            <Tuile />
            <Tuile />
          </div>
          <SkeletonBlock className="mt-3 h-4 w-[28rem] max-w-full" />
        </div>

        {/* Liste des entités (créer / renommer / archiver) */}
        <div className="rounded-card border border-line bg-surface-card shadow-card">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div className="flex flex-col gap-2">
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="h-3 w-56" />
            </div>
            <SkeletonBlock className="h-10 w-32" rounded="control" />
          </div>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-line px-5 py-3 last:border-b-0"
            >
              <div className="flex flex-col gap-1.5">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-3 w-16" />
              </div>
              <SkeletonBlock className="h-8 w-32" rounded="control" />
            </div>
          ))}
        </div>

        {/* Étape 1 — toolbar + tableau */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <SkeletonBlock className="h-5 w-56" />
            <SkeletonBlock className="h-4 w-[30rem] max-w-full" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <SkeletonBlock className="h-10 w-full max-w-xs" rounded="control" />
            <SkeletonBlock className="h-10 w-56" rounded="control" />
          </div>

          <div className="rounded-card border border-line bg-surface-card shadow-card">
            <div className="flex items-center gap-4 border-b border-line-strong px-4 py-3">
              <SkeletonBlock className="size-4" rounded="control" />
              <SkeletonBlock className="h-3 w-20" />
            </div>
            {[0, 1, 2, 3, 4].map((i) => (
              <LigneTableau key={i} />
            ))}
          </div>
        </div>

        {/* Étape 2 — cartes membres */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <SkeletonBlock className="h-5 w-48" />
            <SkeletonBlock className="h-4 w-[26rem] max-w-full" />
          </div>
          {[0, 1].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-card bg-surface-card p-5 shadow-card"
            >
              <SkeletonBlock className="size-9" rounded="pill" />
              <div className="flex flex-1 flex-col gap-1.5">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-3 w-56" />
              </div>
              <SkeletonBlock className="h-8 w-48" rounded="control" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
