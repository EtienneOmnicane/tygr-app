/**
 * État LOADING de /transactions (Suspense RSC natif). Next monte ce fichier
 * pendant que `page.tsx` résout ses données (catégories, comptes, 1re page) dans
 * `withWorkspace`. Le chrome (header/nav) reste affiché via `(workspace)/layout.tsx` ;
 * seule la zone de données passe en skeleton.
 *
 * Réutilise `TransactionsLoading` — même forme que le tableau réel (4 colonnes,
 * densité §2.2), donc pas de saut de layout au passage au contenu. En-tête de page
 * dupliqué (statique) pour une transition sans à-coup.
 */
import { TransactionsLoading } from "@/components/transactions";

export default function TransactionsRouteLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text">Transactions</h1>
        <p className="mt-1 text-sm text-text-muted">
          Parcourez, filtrez et catégorisez vos opérations. Cliquez une ligne pour
          ventiler son montant.
        </p>
      </div>
      <TransactionsLoading />
    </main>
  );
}
