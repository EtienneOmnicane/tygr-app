/**
 * Skeleton de chargement de la liste /transactions. Présentationnel PUR, INERTE.
 *
 * Épouse la FORME réelle du tableau (mêmes 4 colonnes, même densité §2.2, en-tête)
 * pour éviter le saut de layout à l'arrivée des données. AUCUNE couleur sémantique
 * (`inflow`/`outflow`) : le chargement n'est pas de la donnée (convention « états »).
 * Remplissage neutre `surface-inset` via `SkeletonBlock` (brique transverse).
 */
import { SkeletonBlock } from "@/components/ui/states";

export function TransactionsLoading({ lignes = 8 }: { lignes?: number }) {
  return (
    <div
      className="overflow-hidden rounded-card border border-line bg-surface-card shadow-card"
      aria-busy="true"
      aria-label="Chargement des transactions"
    >
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[68px] sm:w-[92px]" />
          <col />
          <col className="w-0 lg:w-[200px]" />
          <col className="w-[128px] sm:w-[150px]" />
        </colgroup>

        {/* En-tête réel (statique) pour ancrer la forme. Catégorie masquée sous lg. */}
        <thead>
          <tr className="border-b border-line-strong">
            {(
              [
                { c: "Date", cls: "sm:px-4 px-3" },
                { c: "Libellé", cls: "sm:px-4 px-3" },
                { c: "Catégorie", cls: "hidden lg:table-cell px-4" },
                { c: "Montant", cls: "text-right sm:px-4 px-3" },
              ] as const
            ).map(({ c, cls }) => (
              <th
                key={c}
                scope="col"
                className={`py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted ${cls}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-line">
          {Array.from({ length: lignes }).map((_, i) => (
            <tr key={i}>
              <td className="px-3 py-[14px] sm:px-4">
                <SkeletonBlock className="h-3 w-12" />
              </td>
              <td className="px-3 py-[14px] sm:px-4">
                <SkeletonBlock className="h-3.5 w-40" />
                <SkeletonBlock className="mt-1.5 h-2.5 w-24" />
              </td>
              <td className="hidden px-4 py-[14px] sm:table-cell">
                <SkeletonBlock className="h-5 w-24" rounded="pill" />
              </td>
              <td className="px-3 py-[14px] sm:px-4">
                {/* Montant placeholder aligné à droite (forme tabulaire). */}
                <div className="flex justify-end">
                  <SkeletonBlock className="h-3.5 w-20" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
