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

import { peutAdministrer } from "@/lib/permissions";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { listerEntites, listerMembresWorkspace, withWorkspace } from "@/server/db";

import {
  FormulaireProvisioning,
  type EntiteOption,
} from "./formulaire-provisioning";
import { ListeMembres, type MembreLigne } from "./liste-membres";

export const metadata = { title: "Membres — Dodo" };

export default async function PageMembres() {
  let session;
  try {
    session = await exigerSessionWorkspace();
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
    return { entites, membres };
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

  return (
    <main className="flex flex-1 justify-center p-6">
      <div className="flex w-full max-w-3xl flex-col gap-10">
        <section className="mx-auto w-full max-w-md">
          <h1 className="mb-1 text-lg font-semibold">Membres du workspace</h1>
          <p className="mb-6 text-sm text-text-muted">
            Créez un utilisateur, rattachez-le à cet espace et définissez son périmètre.
          </p>
          <FormulaireProvisioning entites={entitesActives} />
        </section>

        <section>
          <h2 className="mb-1 text-lg font-semibold">Membres actuels</h2>
          <p className="mb-4 text-sm text-text-muted">
            {donnees.membres.length} membre{donnees.membres.length > 1 ? "s" : ""} dans
            cet espace.
          </p>
          <ListeMembres membres={donnees.membres} entitesParId={entitesParId} />
        </section>
      </div>
    </main>
  );
}
