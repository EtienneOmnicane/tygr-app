/**
 * Page « Transactions » — liste réelle des opérations + ventilation (Pilier 1).
 *
 * Le chrome vient de `(workspace)/layout.tsx`. La 1re page de données arrive en RSC
 * (Suspense natif → `loading.tsx`), puis le conteneur CLIENT `TransactionsFeature`
 * gère filtres / pagination / ouverture de la SplitAllocationModal.
 *
 * ⚠️ CONTRAT-FIRST (frontière UI/Backend, 2026-06-17) : l'UI est complète et câblée
 * contre le contrat `ActionsTransactions`. Il MANQUE deux Server Actions côté
 * Backend (liste de courses B1/B3 — cf. PLAN-transactions-page.md, entrée TODOS) :
 *   - `listerTransactionsAction` (lecture paginée + résumé de ventilation),
 *   - `listerSplitsAction` (détail des splits à l'ouverture de la modale).
 * Tant qu'elles ne sont pas livrées, `actionsTransactions` renvoie une page VIDE
 * (l'écran montre l'Empty State, sans planter). Le branchement final = remplacer le
 * corps de ces deux closures par l'appel aux Server Actions (une ligne chacune).
 * La preuve visuelle du tableau peuplé se fait via `/demo/transactions`.
 *
 * Authz (règle 3) : exigerSessionWorkspace + withWorkspace. Catégories & comptes
 * lus côté serveur. Mapping erreurs : non auth → /login ; aucun workspace → /selection.
 */
import { redirect } from "next/navigation";

import { listerComptes, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { TransactionsFeature } from "@/components/transactions";
import type { ActionsTransactions } from "@/components/transactions/types-transactions";
import type { CategorieUI, SplitUI } from "@/components/ui/category";

import {
  listerCategoriesAction,
  remplacerSplitsAction,
} from "./actions";

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

  // Données déjà disponibles côté serveur (existant).
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
  const aucuneBanque = comptes.length === 0;

  // ⚠️ STUB CONTRAT-FIRST — à remplacer par les Server Actions Backend (B1/B3).
  // Ce ne sont PAS de nouvelles Server Actions : juste des closures de page qui
  // renverront l'appel réel dès qu'il existe. Page vide en attendant (≠ plantage).
  const actionsTransactions: ActionsTransactions = {
    async listerTransactions() {
      // TODO(Backend B1) : return (await listerTransactionsAction(args));
      return { ok: true, data: { lignes: [], curseurSuivant: null } };
    },
    async chargerSplits(): Promise<SplitUI[]> {
      // TODO(Backend B3bis) : return (await listerSplitsAction(ref));
      return [];
    },
  };

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
        initial={{ lignes: [], curseurSuivant: null }}
        categories={categories}
        comptes={comptesFiltre}
        actions={actionsTransactions}
        remplacerSplits={remplacerSplitsAction}
        aucuneBanque={aucuneBanque}
      />
    </main>
  );
}
