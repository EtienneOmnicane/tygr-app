/**
 * Page « Analyse par catégorie » (camembert — chantier Graphiques). Cette page RSC
 * résout la répartition du premier paint sous RLS (défauts métier : SORTIES du mois
 * courant, multi-devise) via `chargerAnalyseCategories`, puis monte le conteneur
 * CLIENT `GraphiquesFeature` avec la surface d'actions RÉELLE (closure pontant la
 * Server Action de re-fetch) — l'UI ne touche jamais la DB.
 *
 * Le chrome (header/nav) vient de `(workspace)/layout.tsx` ; le loading est géré par
 * le `loading.tsx` du segment (Suspense App Router pendant la résolution RSC).
 *
 * Multi-devise (CLAUDE.md Localisation / règle 8) : la répartition porte une entrée
 * par devise, jamais d'addition cross-devise — le rendu délègue à la feature.
 *
 * Authz (règle 3) : `chargerAnalyseCategories` exige la session + withWorkspace ; non
 * authentifié → /login, aucun workspace → /selection (mapping identique au groupe).
 */
import { redirect } from "next/navigation";

import {
  AucunWorkspaceActifError,
  NonAuthentifieError,
} from "@/server/auth/session";
import { analyseCategoriesParamsSchema } from "@/lib/insights-schema";

import { GraphiquesFeature } from "@/components/graphiques";
import type {
  ActionsGraphiques,
  SelectionGraphique,
} from "@/components/graphiques";

import {
  analyserCategoriesAction,
  chargerAnalyseCategories,
  type AnalyseVue,
} from "./actions";

export const metadata = { title: "Graphiques — Dodo" };

export default async function PageGraphiques() {
  // Premier paint sous RLS (défauts sorties/mois-courant). Erreurs de session mappées
  // vers les redirections du groupe ; toute autre erreur (infra) remonte à l'error boundary.
  let vue: AnalyseVue;
  try {
    vue = await chargerAnalyseCategories();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    if (erreur instanceof AucunWorkspaceActifError) redirect("/selection");
    throw erreur;
  }

  // Sélection initiale = défauts canoniques du schéma (source unique) → aligne les
  // sélecteurs sur ce que le premier paint a réellement chargé.
  const selectionInitiale: SelectionGraphique =
    analyseCategoriesParamsSchema.parse({});

  // Surface d'actions RÉELLE : closure serveur relayant la Server Action de re-fetch.
  // Son retour est déjà normalisé `ResultatAction` (= `ResultatAnalyse`) — relais direct.
  const actions: ActionsGraphiques = {
    async analyser(selection) {
      "use server";
      return analyserCategoriesAction(selection);
    },
  };

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text">Analyse par catégorie</h1>
        <p className="mt-1 text-sm text-text-muted">
          Répartissez vos entrées ou vos sorties par catégorie sur la période de votre
          choix. Une vue par devise, sans conversion — vos montants restent exacts.
        </p>
      </div>

      <GraphiquesFeature
        initiale={vue.repartition}
        selectionInitiale={selectionInitiale}
        aucuneBanque={vue.aucuneBanque}
        actions={actions}
      />
    </main>
  );
}
