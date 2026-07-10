/**
 * Page « Règles de catégorisation » (moteur FYGR-style — UI du backend PR #95).
 *
 * Le chrome vient de `(workspace)/layout.tsx`. Cette page RSC résout les données
 * (règles + catégories + rôle) sous RLS, puis monte le conteneur CLIENT
 * `ReglesFeature` avec la surface d'actions RÉELLE (closures pontant les Server
 * Actions de `./actions.ts`, livrées #95) — l'UI ne touche jamais la DB.
 *
 * Gating (décision PO 2026-06-17, cohérent avec le CRUD de catégories) : le CRUD
 * des règles est OUVERT aux membres (la RLS WITH CHECK workspace suffit) ; on ne
 * CACHE donc pas la page. Seul « Ré-analyser » (appliquerReglesAction) écrit des
 * splits en masse → réservé MANAGER/ADMIN côté serveur ; ici on ne l'OFFRE que si
 * `peutModifier` (défense en profondeur — la vraie garde reste serveur). Un VIEWER
 * voit la liste en lecture seule.
 *
 * Authz (règle 3) : exigerSessionWorkspace + withWorkspace ; non auth → /login,
 * aucun workspace → /selection.
 */
import { redirect } from "next/navigation";

import { peutModifier } from "@/lib/permissions";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { withWorkspace } from "@/server/db";

import type { CategorieUI } from "@/components/ui/category";
import { ReglesFeature } from "@/components/regles";
import type { ActionsRegles, RegleUI } from "@/components/regles";

import { deepLinkRegleSchema } from "@/lib/regles-schema";

import { listerCategoriesAction } from "../transactions/actions";
import {
  appliquerReglesAction,
  archiverRegleAction,
  creerRegleAction,
  listerReglesAction,
  modifierRegleAction,
  reordonnerReglesAction,
} from "./actions";

export const metadata = { title: "Règles — Dodo" };

export default async function PageRegles({
  searchParams,
}: {
  // Next 16 : searchParams est un Promise à `await` (AGENTS.md).
  searchParams: Promise<{ [cle: string]: string | string[] | undefined }>;
}) {
  let session;
  try {
    session = await exigerSessionWorkspace();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    if (erreur instanceof AucunWorkspaceActifError) redirect("/selection");
    throw erreur;
  }

  // Rôle re-résolu sous RLS (gating UI ; la garde de fond reste serveur).
  const role = await withWorkspace(session, async (_tx, ctx) => ctx.role);
  const peutGerer = peutModifier(role);

  // Données initiales : règles + catégories (pour le select cible + noms).
  const [reglesDTO, categoriesDTO] = await Promise.all([
    listerReglesAction(),
    listerCategoriesAction(),
  ]);

  const initiales: RegleUI[] = reglesDTO.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    matchType: r.matchType,
    categoryId: r.categoryId,
    isActive: r.isActive,
    priority: r.priority,
  }));

  const categories: CategorieUI[] = categoriesDTO.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    isActive: c.isActive,
  }));

  // Deep-link « Créer une règle » depuis la catégorisation (FB0709-REGLES-LIEN1) :
  // `?nouvelle=1&motif=<pattern>&categorie=<uuid>`. Validation zod STRICTE + tolérante
  // (valeurs mal formées ignorées, aucun oracle). La catégorie n'est pré-sélectionnée
  // que si elle appartient VRAIMENT au workspace (présente dans `categories`, chargées
  // sous RLS) → un uuid d'un AUTRE tenant est simplement ignoré (fail-closed, pas
  // d'oracle d'existence). Le motif transite en clair dans l'URL : côté /transactions
  // on n'y met QUE `cleanLabel` (jamais bank_label_raw) et on NE LOGGE PAS l'URL.
  const params = await searchParams;
  const deepLink = deepLinkRegleSchema.safeParse(params);
  let creationInitiale: { pattern?: string; categoryId?: string } | undefined;
  if (deepLink.success && deepLink.data.nouvelle === "1") {
    const categorieValide =
      deepLink.data.categorie &&
      categories.some((c) => c.id === deepLink.data.categorie && c.isActive)
        ? deepLink.data.categorie
        : undefined;
    // N'ouvre le formulaire pré-rempli que si au moins un champ exploitable subsiste.
    if (deepLink.data.motif || categorieValide) {
      creationInitiale = {
        pattern: deepLink.data.motif,
        categoryId: categorieValide,
      };
    }
  }

  // Surface d'actions RÉELLE (closures serveur). Le retour de chaque action est
  // déjà normalisé `ResultatAction` côté ./actions.ts — on relaie tel quel, en
  // adaptant uniquement la forme de la ré-analyse vers le contrat UI.
  const actions: ActionsRegles = {
    async listerRegles(): Promise<RegleUI[]> {
      "use server";
      const dto = await listerReglesAction();
      return dto.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        matchType: r.matchType,
        categoryId: r.categoryId,
        isActive: r.isActive,
        priority: r.priority,
      }));
    },
    async creerRegle(input) {
      "use server";
      return creerRegleAction(input);
    },
    async modifierRegle(input) {
      "use server";
      return modifierRegleAction(input);
    },
    async archiverRegle(ruleId) {
      "use server";
      return archiverRegleAction(ruleId);
    },
    async reordonnerRegles(ordre) {
      "use server";
      return reordonnerReglesAction({ ordre });
    },
    async appliquerRegles() {
      "use server";
      const res = await appliquerReglesAction();
      if (!res.ok) return res;
      // Contrat UI : { appliquees } ← { transactionsCategorisees, splitsCrees }.
      return { ok: true, data: { appliquees: res.data.transactionsCategorisees } };
    },
  };

  return (
    <main className="w-full flex-1 px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text">Règles de catégorisation</h1>
        <p className="mt-1 text-sm text-text-muted">
          Classez automatiquement vos transactions : définissez un motif de libellé
          et la catégorie à appliquer quand il correspond.
        </p>
      </div>

      <ReglesFeature
        initiales={initiales}
        categories={categories}
        actions={actions}
        peutGerer={peutGerer}
        creationInitiale={creationInitiale}
      />
    </main>
  );
}
