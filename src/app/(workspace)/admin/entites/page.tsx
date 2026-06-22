/**
 * Écran d'assignation des Entités (BU) aux membres — réservé à l'ADMIN du
 * workspace courant (Groupe « Omnicane »). Epic 3 / Entités L3.
 *
 * ⚠️ MAQUETTE (mock) : cette page NE consomme PAS encore les requêtes/Server
 * Actions L3 (en cours de développement côté serveur). Le rôle ADMIN est résolu
 * réellement (gating identique à /admin/membres), mais la liste des membres et
 * des entités, ainsi que l'enregistrement, sont MOCKÉS dans le composant client
 * (tableaux en dur, état purement en mémoire). Aucun appel base de données.
 *
 * Gating (D2 #37 + S3) : le rôle est re-validé à chaque requête via
 * withWorkspace. Un non-ADMIN ne reçoit PAS un écran désactivé mais un 404
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

import { AssignationEntites } from "./assignation-entites";

export const metadata = { title: "Entités — TYGR" };

export default async function PageEntites() {
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
      <div className="w-full max-w-3xl">
        <h1 className="mb-1 text-lg font-semibold">Assignation des entités</h1>
        <p className="mb-6 text-sm text-text-muted">
          Définissez le périmètre de chaque membre : accès à l’ensemble du groupe
          (Vision Globale) ou restreint à certaines entités (Vision Entité).
        </p>
        <AssignationEntites />
      </div>
    </main>
  );
}
