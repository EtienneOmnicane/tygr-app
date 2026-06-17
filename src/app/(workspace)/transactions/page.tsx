/**
 * Page « Transactions » (section à venir — Epic ultérieure). Coquille en EMPTY
 * STATE : la liste/catégorisation complète des opérations n'est pas encore
 * développée, mais l'onglet est actif (pas de 404). Empty State contextualisé
 * (UI_GUIDELINES §4.4) décrivant la valeur à venir.
 *
 * Le chrome vient de `(workspace)/layout.tsx`. Pas de loading.tsx (aucune donnée
 * métier ; seul `listerComptes` décide du CTA — D2).
 *
 * CTA conditionnel (D2) : « Connecter une banque » uniquement si aucun compte
 * connecté. Mapping erreurs (règle 3) : non auth → /login ; aucun workspace →
 * /selection.
 */
import { redirect } from "next/navigation";

import { listerComptes, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { EmptyState } from "@/components/ui/states";

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

  const comptes = await withWorkspace(session, (tx) => listerComptes(tx));
  const aucuneBanque = comptes.length === 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <EmptyState
        headingLevel="h1"
        illustration="table"
        title="Retrouvez toutes vos opérations"
        message="Bientôt, parcourez, recherchez et catégorisez l’ensemble de vos transactions bancaires. Elles apparaîtront ici après la première synchronisation de vos comptes."
        cta={
          aucuneBanque
            ? { label: "Connecter une banque", href: "/banques" }
            : undefined
        }
      />
    </main>
  );
}
