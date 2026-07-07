/**
 * Page « Échéances » (section à venir — Epic ultérieure). Coquille en EMPTY
 * STATE : le suivi des échéances clients/fournisseurs n'est pas encore développé,
 * mais l'onglet est actif (pas de 404). Empty State contextualisé
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

export const metadata = { title: "Échéances — Dodo" };

export default async function PageEcheances() {
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
        illustration="calendar"
        title="Suivez vos paiements à venir"
        message="Bientôt, anticipez vos échéances clients et fournisseurs, avec leur statut et leurs montants. Cette section s’activera avec vos premières opérations synchronisées."
        cta={
          aucuneBanque
            ? { label: "Connecter une banque", href: "/banques" }
            : undefined
        }
      />
    </main>
  );
}
