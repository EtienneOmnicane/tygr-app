/**
 * Page « Graphiques » (section à venir — Epic ultérieure). Coquille en EMPTY
 * STATE : la fonctionnalité d'analyse graphique n'est pas encore développée,
 * mais l'onglet est actif (pas de 404). On affiche un Empty State contextualisé
 * (UI_GUIDELINES §4.4) qui décrit la VALEUR à venir de cette section.
 *
 * Le chrome (header/nav) vient de `(workspace)/layout.tsx`. Cette page ne rend
 * que son contenu. Pas de loading.tsx : aucune donnée métier fetchée (la section
 * n'existe pas encore) — seul `listerComptes` sert à décider du CTA (D2).
 *
 * CTA conditionnel (décision design D2) : « Connecter une banque » UNIQUEMENT si
 * aucun compte n'est connecté (les graphiques dépendent des données bancaires).
 * Si des comptes existent déjà, pas de CTA creux — la section arrivera d'elle-même.
 *
 * Mapping erreurs (règle 3) : non authentifié → /login ; aucun workspace →
 * /selection. Identique au reste du groupe (chaque RSC re-valide).
 */
import { redirect } from "next/navigation";

import { listerComptes, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { EmptyState } from "@/components/ui/states";

export const metadata = { title: "Graphiques — Dodo" };

export default async function PageGraphiques() {
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
        illustration="chart"
        title="Visualisez l’évolution de votre trésorerie"
        message="Bientôt, retrouvez ici vos graphiques de position sur 90 jours, entrées et sorties par période. Cette section s’activera dès que vos comptes seront synchronisés."
        cta={
          aucuneBanque
            ? { label: "Connecter une banque", href: "/banques" }
            : undefined
        }
      />
    </main>
  );
}
