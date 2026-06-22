/**
 * Écran d'assignation des Entités (BU) aux membres — réservé à l'ADMIN du
 * workspace courant (Groupe « Omnicane »). Epic 3 / Entités L3.
 *
 * Câblage L3/L4 (PR wiring) : les ENTITÉS et le PÉRIMÈTRE de chaque membre sont
 * désormais lus côté serveur (listerEntites + listerScopesMembre, dans
 * withWorkspace), puis passés en props au composant client. L'enregistrement
 * passe par la vraie Server Action `definirScopesAction` (cf. ./actions.ts).
 *
 * ⚠️ TODO(back) — TROU DE CONTRAT : il n'existe pas encore de requête serveur
 * pour LISTER LES MEMBRES d'un workspace (nom/email/rôle/userId). La liste des
 * membres reste donc MOCKÉE (MEMBRES_MOCK ci-dessous) en attendant une fonction
 * `listerMembresWorkspace(tx, ctx)` côté repository (cf. OMNIFI/feedback back).
 * Tout le RESTE est réellement câblé. Dès que la requête existe, remplacer
 * MEMBRES_MOCK par l'appel serveur — l'UI ne bouge pas.
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
import { listerEntites, listerScopesMembre, withWorkspace } from "@/server/db";

import {
  AssignationEntites,
  type EntiteVue,
  type MembreVue,
} from "./assignation-entites";

export const metadata = { title: "Entités — TYGR" };

/**
 * TODO(back) : à remplacer par `listerMembresWorkspace(tx, ctx)` quand la requête
 * existera. Les `userId` sont des UUID factices : un enregistrement réel renverra
 * « Ressource introuvable » (MembreNonScopableError → 404), ce que l'UI gère
 * proprement. Forme alignée sur le futur contrat attendu.
 */
const MEMBRES_MOCK: Array<{
  userId: string;
  nomComplet: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "VIEWER";
}> = [
  {
    userId: "00000000-0000-4000-8000-000000000001",
    nomComplet: "Aïsha Ramnauth",
    email: "aisha.ramnauth@omnicane.mu",
    role: "ADMIN",
  },
  {
    userId: "00000000-0000-4000-8000-000000000002",
    nomComplet: "Jean-Claude Bissoondoyal",
    email: "jc.bissoondoyal@omnicane.mu",
    role: "MANAGER",
  },
  {
    userId: "00000000-0000-4000-8000-000000000003",
    nomComplet: "Priya Goorah",
    email: "priya.goorah@omnicane.mu",
    role: "VIEWER",
  },
];

export default async function PageEntites() {
  let session;
  try {
    session = await exigerSessionWorkspace();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    if (erreur instanceof AucunWorkspaceActifError) redirect("/selection");
    throw erreur;
  }

  // Lecture serveur sous RLS : rôle + référentiel d'entités + périmètre de chaque
  // membre, dans une seule transaction scopée workspace.
  const donnees = await withWorkspace(session, async (tx, ctx) => {
    if (!peutAdministrer(ctx.role)) {
      // S3 / D2 #37 : surface admin CACHÉE (404, pas 403). On sort AVANT toute
      // lecture pour ne rien divulguer.
      return null;
    }

    const entites = await listerEntites(tx, ctx);

    // TODO(back) : un seul appel `listerMembresWorkspace` remplacera et la liste
    // ET cette boucle de scopes (à fusionner en une requête jointe côté repo).
    const membres: MembreVue[] = await Promise.all(
      MEMBRES_MOCK.map(async (m) => ({
        ...m,
        scopeInitial: await listerScopesMembre(tx, ctx, m.userId),
      })),
    );

    return { entites, membres };
  });

  if (donnees === null) {
    notFound();
  }

  // Restreint aux entités actives (les archivées disparaissent des pickers, cf.
  // archiverEntite côté repo).
  const entitesActives: EntiteVue[] = donnees.entites
    .filter((e) => e.isActive)
    .map((e) => ({ id: e.id, nom: e.name, code: e.code }));

  return (
    <main className="flex flex-1 justify-center p-6">
      <div className="w-full max-w-3xl">
        <h1 className="mb-1 text-lg font-semibold">Assignation des entités</h1>
        <p className="mb-6 text-sm text-text-muted">
          Définissez le périmètre de chaque membre : accès à l’ensemble du groupe
          (Vision Globale) ou restreint à certaines entités (Vision Entité).
        </p>
        <AssignationEntites entites={entitesActives} membres={donnees.membres} />
      </div>
    </main>
  );
}
