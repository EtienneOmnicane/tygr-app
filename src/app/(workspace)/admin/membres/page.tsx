/**
 * Écran de provisioning (Epic 2 L3) — réservé à l'ADMIN du workspace courant.
 *
 * Gating (D2 #37 + S3) : la page résout le rôle via withWorkspace (re-validé à
 * chaque requête). Un non-ADMIN ne reçoit PAS un écran désactivé mais un 404
 * (notFound) — la surface admin est CACHÉE, pas grisée, et non-énumérante.
 */
import { notFound, redirect } from "next/navigation";

import { peutAdministrer } from "@/lib/permissions";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { withWorkspace } from "@/server/db";

import { FormulaireProvisioning } from "./formulaire-provisioning";

export const metadata = { title: "Membres — TYGR" };

export default async function PageMembres() {
  let session;
  try {
    session = await exigerSessionWorkspace();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    if (erreur instanceof AucunWorkspaceActifError) redirect("/selection");
    throw erreur;
  }

  const role = await withWorkspace(session, async (_tx, ctx) => ctx.role);

  // S3 / D2 #37 : surface admin CACHÉE pour un non-ADMIN (404, pas 403).
  if (!peutAdministrer(role)) {
    notFound();
  }

  return (
    <main className="flex flex-1 justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-lg font-semibold">Membres du workspace</h1>
        <p className="mb-6 text-sm text-text-muted">
          Créez un utilisateur et rattachez-le à cet espace.
        </p>
        <FormulaireProvisioning />
      </div>
    </main>
  );
}
