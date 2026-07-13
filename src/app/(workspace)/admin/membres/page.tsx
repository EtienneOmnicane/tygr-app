/**
 * Écran de provisioning + liste des membres (Epic 2 L3) — réservé à l'ADMIN du
 * workspace courant.
 *
 * Gating (D2 #37 + S3) : la page résout le rôle via withWorkspace (re-validé à
 * chaque requête). Un non-ADMIN ne reçoit PAS un écran désactivé mais un 404
 * (notFound) — la surface admin est CACHÉE, pas grisée, et non-énumérante. Le rôle,
 * le référentiel d'entités (pour les cases du formulaire) et la liste des membres
 * (avec leur périmètre) sont lus dans UNE seule transaction scopée workspace.
 */
import { notFound, redirect } from "next/navigation";

import { AvertissementVueRestreinte } from "@/components/admin/avertissement-vue-restreinte";
import { peutAdministrer } from "@/lib/permissions";
import {
  AucunWorkspaceActifError,
  exigerSessionAdministration,
  NonAuthentifieError,
} from "@/server/auth/session";
import { listerEntites, listerMembresWorkspace, withWorkspace } from "@/server/db";

import {
  FormulaireProvisioning,
  type EntiteOption,
} from "./formulaire-provisioning";
import { ListeMembres, type MembreLigne } from "./liste-membres";

export const metadata = { title: "Members — Dodo" };

export default async function PageMembres() {
  let session;
  try {
    // L0 (§3.3) : surface d'administration → session amputée du viewFilter.
    session = await exigerSessionAdministration();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    if (erreur instanceof AucunWorkspaceActifError) redirect("/selection");
    throw erreur;
  }

  // Lecture serveur sous RLS : rôle + entités actives + membres (avec périmètre joint),
  // dans une seule transaction. On sort AVANT toute lecture pour un non-ADMIN (404).
  const donnees = await withWorkspace(session, async (tx, ctx) => {
    if (!peutAdministrer(ctx.role)) {
      // S3 / D2 #37 : surface admin CACHÉE (404, pas 403), sans rien divulguer.
      return null;
    }
    const entites = await listerEntites(tx, ctx);
    const membres: MembreLigne[] = await listerMembresWorkspace(tx, ctx);

    // Même garde fail-safe que /admin/entites (§12) : l'amputation du viewFilter ne couvre
    // que l'axe JWT. `entity_scope` / `account_scope` sont résolus EN BASE — un ADMIN scopé
    // lirait des listes partielles. Le périmètre acté (Q-PERIMETRE) est l'ADMIN, pas une
    // page : les deux écrans disent la même chose de la même situation.
    const vueRestreinte =
      ctx.entityScope.mode !== "GLOBALE" || ctx.accountScope.mode !== "GLOBALE";

    return { entites, membres, vueRestreinte };
  });

  if (donnees === null) {
    notFound();
  }

  // Entités actives pour les cases du formulaire (les archivées disparaissent des pickers).
  const entitesActives: EntiteOption[] = donnees.entites
    .filter((e) => e.isActive)
    .map((e) => ({ id: e.id, nom: e.name, code: e.code }));

  // Map id→nom pour afficher le périmètre des membres en clair. On inclut TOUTES les
  // entités (même archivées) afin de nommer un scope encore rattaché à une entité archivée.
  const entitesParId: Record<string, string> = Object.fromEntries(
    donnees.entites.map((e) => [e.id, e.name]),
  );

  // Pleine largeur — même gabarit que /admin/entites (UI_GUIDELINES §1.1 : « Admin — la
  // table pleine largeur EST l'écran »). Les deux écrans admin restent cohérents.
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <div className="flex flex-col gap-10">
        {donnees.vueRestreinte && <AvertissementVueRestreinte />}

        <section className="mx-auto w-full max-w-md">
          <h1 className="mb-1 text-lg font-semibold">Workspace members</h1>
          <p className="mb-6 text-sm text-text-muted">
            Create a user, add them to this workspace and choose what they can see.
          </p>
          <FormulaireProvisioning entites={entitesActives} />
        </section>

        <section>
          <h2 className="mb-1 text-lg font-semibold">Current members</h2>
          <p className="mb-4 text-sm text-text-muted">
            {donnees.membres.length} member{donnees.membres.length > 1 ? "s" : ""} in
            this workspace.
          </p>
          <ListeMembres membres={donnees.membres} entitesParId={entitesParId} />
        </section>
      </div>
    </main>
  );
}
