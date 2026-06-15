/**
 * Layout du groupe (workspace) — shell applicatif partagé par l'accueil/dashboard,
 * /admin/membres, /banques… (UI_GUIDELINES §1.1/§1.2).
 *
 * RSC : résout la chaîne auth UNE fois pour tout le groupe (E6 is_active +
 * activeWorkspaceId), puis le nom du workspace courant sous RLS (withWorkspace,
 * E14) et les memberships pour le switcher. Le contexte est passé en props au
 * header ; les pages enfants n'ont plus à reconstruire le chrome.
 *
 * Mapping erreurs (règle 3, registre S2) — identique au pattern de l'ancien
 * accueil :
 *   NonAuthentifieError     → /login (jamais de détail : désactivé ≡ non connecté)
 *   AucunWorkspaceActifError → /selection (Epic 2)
 *   WorkspaceAccessDeniedError → 404 (jamais 403, pas d'oracle d'existence)
 */
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { signOut } from "@/server/auth/config";
import { identite, schema, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { WorkspaceAccessDeniedError } from "@/server/db/tenancy";

import { AppHeader } from "@/components/shell/app-header";

async function deconnecter() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
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

  let contexte;
  try {
    contexte = await withWorkspace(session, async (tx, ctx) => {
      const lignes = await tx
        .select({ name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ctx.workspaceId))
        .limit(1);
      return {
        role: ctx.role,
        workspaceId: ctx.workspaceId,
        workspaceNom: lignes[0]?.name ?? "—",
      };
    });
  } catch (erreur) {
    if (erreur instanceof WorkspaceAccessDeniedError) {
      notFound(); // ressource d'un autre tenant → 404, jamais 403
    }
    throw erreur;
  }

  // Memberships pour le switcher (sous RLS, S2). Lu hors withWorkspace : lecture
  // pré-contexte (own_memberships_select), pas du tenant courant.
  const memberships = await identite.membershipsAvecNom(session.userId);

  return (
    <div className="flex min-h-screen flex-col bg-surface-page">
      <AppHeader
        workspaceId={contexte.workspaceId}
        workspaceNom={contexte.workspaceNom}
        role={contexte.role}
        memberships={memberships}
        onDeconnexion={deconnecter}
      />
      {children}
    </div>
  );
}
