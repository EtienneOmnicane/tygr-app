/**
 * Page « Échéances prévisionnelles » (Epic 8 · FEAT-8.2). Cette page RSC résout les
 * données sous RLS (vue triée + synthèse par horizon + catégories + rôle), puis monte
 * le conteneur CLIENT `EcheancesFeature` avec la surface d'actions RÉELLE (closures
 * pontant les Server Actions de `./actions.ts`) — l'UI ne touche jamais la DB.
 *
 * Le chrome vient de `(workspace)/layout.tsx`. Le loading est géré par `loading.tsx`
 * (Suspense App Router pendant la résolution RSC).
 *
 * Gating (règle 3, cohérent avec les règles/catégories) : le CRUD des échéances est
 * ouvert aux membres (la RLS WITH CHECK workspace + la garde `peutModifier` serveur
 * suffisent) ; on ne CACHE donc pas la page. `peutGerer` masque juste le formulaire
 * et les contrôles pour un VIEWER (défense en profondeur — la vraie garde reste
 * serveur : les actions échouent `FORBIDDEN_ROLE`).
 *
 * Authz : exigerSessionWorkspace + withWorkspace ; non auth → /login, aucun
 * workspace → /selection.
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
import { EcheancesFeature } from "@/components/echeances";
import type {
  ActionsEcheances,
  EcheanceUI,
  EcheancesVueUI,
  SyntheseEcheancesUI,
} from "@/components/echeances";

import { listerCategoriesAction } from "../transactions/actions";
import {
  changerStatutEcheanceAction,
  creerEcheanceAction,
  listerEcheancesAction,
  modifierEcheanceAction,
  supprimerEcheanceAction,
  type EcheancesVue,
} from "./actions";

export const metadata = { title: "Échéances — Dodo" };

/** Miroir serveur `EcheanceLue` → contrat UI `EcheanceUI` (champs identiques). */
function versEcheanceUI(e: EcheancesVue["echeances"][number]): EcheanceUI {
  return {
    id: e.id,
    entityId: e.entityId,
    direction: e.direction,
    libelle: e.libelle,
    contrepartie: e.contrepartie,
    montant: e.montant,
    devise: e.devise,
    dateEcheance: e.dateEcheance,
    statut: e.statut,
    statutAffiche: e.statutAffiche,
    enRetard: e.enRetard,
    categorieId: e.categorieId,
    recurrence: e.recurrence,
    montantRegle: e.montantRegle,
  };
}

/** Miroir serveur `SyntheseEcheances` → contrat UI (jours/lignes par devise). */
function versSyntheseUI(synthese: EcheancesVue["synthese"]): SyntheseEcheancesUI {
  return synthese.map((h) => ({
    jours: h.jours,
    lignes: h.lignes.map((l) => ({
      devise: l.devise,
      encaissement: l.encaissement,
      decaissement: l.decaissement,
      net: l.net,
    })),
  }));
}

/** Vue serveur complète → contrat UI (liste + synthèse). */
function versVueUI(vue: EcheancesVue): EcheancesVueUI {
  return {
    echeances: vue.echeances.map(versEcheanceUI),
    synthese: versSyntheseUI(vue.synthese),
  };
}

export default async function PageEcheances() {
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

  // Données initiales : vue (liste triée + synthèse) + catégories (select + noms).
  const [vueDTO, categoriesDTO] = await Promise.all([
    listerEcheancesAction(),
    listerCategoriesAction(),
  ]);

  const initiales = versVueUI(vueDTO);

  const categories: CategorieUI[] = categoriesDTO.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    isActive: c.isActive,
  }));

  // Surface d'actions RÉELLE (closures serveur). Chaque retour est déjà normalisé
  // `ResultatAction` côté ./actions.ts — on relaie tel quel, en adaptant seulement la
  // lecture vers le contrat UI (mappage `EcheanceLue`/`SyntheseEcheances` → *UI).
  const actions: ActionsEcheances = {
    async listerEcheances(): Promise<EcheancesVueUI> {
      "use server";
      const vue = await listerEcheancesAction();
      return versVueUI(vue);
    },
    async creerEcheance(input) {
      "use server";
      return creerEcheanceAction(input);
    },
    async modifierEcheance(input) {
      "use server";
      return modifierEcheanceAction(input);
    },
    async changerStatut(input) {
      "use server";
      return changerStatutEcheanceAction(input);
    },
    async supprimerEcheance(echeanceId) {
      "use server";
      return supprimerEcheanceAction(echeanceId);
    },
  };

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text">Échéances prévisionnelles</h1>
        <p className="mt-1 text-sm text-text-muted">
          Anticipez vos encaissements et décaissements à venir : suivez leur statut,
          leur montant et leur exigibilité, avec une synthèse par horizon.
        </p>
      </div>

      <EcheancesFeature
        initiales={initiales}
        categories={categories}
        actions={actions}
        peutGerer={peutGerer}
      />
    </main>
  );
}
