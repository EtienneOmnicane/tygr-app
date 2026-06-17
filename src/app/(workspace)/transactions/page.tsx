/**
 * Page « Transactions » — liste réelle des opérations + ventilation (Pilier 1).
 *
 * Le chrome vient de `(workspace)/layout.tsx`. La 1re page de données arrive en RSC
 * (Suspense natif → `loading.tsx`), puis le conteneur CLIENT `TransactionsFeature`
 * gère filtres / pagination / ouverture de la SplitAllocationModal.
 *
 * CÂBLAGE FINAL (2026-06-17) : les Server Actions Backend sont livrées et branchées —
 *   - `listerTransactionsAction` (lecture paginée par curseur + résumé ventilation),
 *   - `listerSplitsAction` (détail des splits à l'ouverture de la modale ; LÈVE une
 *     exception en cas d'échec plutôt que de renvoyer [] → la modale ne s'ouvre pas
 *     sur un état faussement vide qui écraserait les splits au Valider),
 *   - `remplacerSplitsAction` (écriture atomique).
 * La réconciliation des contrats Backend↔UI vit dans `./adapter` (statut, compteNom,
 * curseur opaque, libellé non-PII). La 1re page est chargée ICI (RSC) ; le conteneur
 * recharge/paginera côté client via les mêmes actions.
 *
 * Authz (règle 3) : exigerSessionWorkspace + withWorkspace. Mapping erreurs :
 * non auth → /login ; aucun workspace → /selection.
 */
import { redirect } from "next/navigation";

import { listerComptes, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { TransactionsFeature } from "@/components/transactions";
import type {
  ActionsTransactions,
  PageTransactions,
} from "@/components/transactions/types-transactions";
import type { CategorieUI, SplitUI } from "@/components/ui/category";

import {
  listerCategoriesAction,
  listerSplitsAction,
  listerTransactionsAction,
  remplacerSplitsAction,
} from "./actions";
import { versInputBackend, versPageUI } from "./adapter";

export const metadata = { title: "Transactions — TYGR" };

export default async function PageTransactions() {
  let session;
  try {
    session = await exigerSessionWorkspace();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) {
      redirect("/login");
    }
    if (erreur instanceof AucunWorkspaceActifError) {
      redirect("/selection");
    }
    throw erreur;
  }

  // Données serveur : catégories (modale), comptes (filtre + résolution compteNom).
  const [categoriesDTO, comptes] = await Promise.all([
    listerCategoriesAction(),
    withWorkspace(session, (tx) => listerComptes(tx)),
  ]);

  const categories: CategorieUI[] = categoriesDTO.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    isActive: c.isActive,
  }));

  const comptesFiltre = comptes.map((c) => ({
    bankAccountId: c.bankAccountId,
    nom: c.accountName,
  }));
  const nomParCompte = new Map(
    comptes.map((c) => [c.bankAccountId, c.accountName]),
  );
  const aucuneBanque = comptes.length === 0;

  // Surface d'actions RÉELLE injectée au conteneur. Les closures pontent l'UI vers
  // les Server Actions Backend en passant par l'adaptateur de contrat. La résolution
  // de compteNom réutilise la map des comptes côté serveur (pas de requête en plus).
  const actionsTransactions: ActionsTransactions = {
    async listerTransactions({ curseur, filtres }) {
      "use server";
      const res = await listerTransactionsAction(
        versInputBackend(filtres, curseur),
      );
      if (!res.ok) return res;
      return { ok: true, data: versPageUI(res.data, nomParCompte) };
    },
    async chargerSplits(ref): Promise<SplitUI[]> {
      "use server";
      // listerSplitsAction LÈVE en cas d'échec (jamais [] faussement vide) — le
      // conteneur catche et bloque l'ouverture de la modale (anti-écrasement).
      return listerSplitsAction(ref);
    },
  };

  // Première page (RSC) — rendue immédiatement, puis paginée/filtrée côté client.
  const premiere = await listerTransactionsAction(versInputBackend(undefined, null));
  const initial: PageTransactions = premiere.ok
    ? versPageUI(premiere.data, nomParCompte)
    : { lignes: [], curseurSuivant: null };

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text">Transactions</h1>
        <p className="mt-1 text-sm text-text-muted">
          Parcourez, filtrez et catégorisez vos opérations. Cliquez une ligne pour
          ventiler son montant.
        </p>
      </div>

      <TransactionsFeature
        initial={initial}
        categories={categories}
        comptes={comptesFiltre}
        actions={actionsTransactions}
        remplacerSplits={remplacerSplitsAction}
        aucuneBanque={aucuneBanque}
      />
    </main>
  );
}
