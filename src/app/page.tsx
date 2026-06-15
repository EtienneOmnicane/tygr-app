/**
 * Accueil authentifié (placeholder Epic 1) — démontre la chaîne complète :
 * JWT → exigerSessionWorkspace (re-validation is_active, E6) → withWorkspace
 * (re-validation membership + RLS, E14) → données du tenant.
 *
 * Mapping erreurs (règle 3) : non authentifié → /login ; workspace d'un autre
 * tenant → 404 via notFound() (jamais 403, pas d'oracle) ; aucun workspace →
 * /selection (Epic 2).
 */
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { peutAdministrer, peutModifier } from "@/lib/permissions";
import { signOut } from "@/server/auth/config";
import { identite, schema, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { WorkspaceAccessDeniedError } from "@/server/db/tenancy";

import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";

async function deconnecter() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function PageAccueil() {
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
        workspace: lignes[0]?.name ?? "—",
      };
    });
  } catch (erreur) {
    if (erreur instanceof WorkspaceAccessDeniedError) {
      notFound(); // ressource d'un autre tenant → 404, jamais 403
    }
    throw erreur;
  }

  // Memberships pour le switcher (sous RLS, S2). Lu hors withWorkspace : c'est
  // une lecture pré-contexte (own_memberships_select), pas du tenant courant.
  const memberships = await identite.membershipsAvecNom(session.userId);
  const modifiable = peutModifier(contexte.role);

  return (
    <>
      <header className="flex h-16 items-center justify-between bg-ink px-6 text-white">
        <span className="font-semibold">
          TYGR<span className="text-accent">.</span>
        </span>
        <div className="flex items-center gap-3">
          <WorkspaceSwitcher
            actifId={contexte.workspaceId}
            actifNom={contexte.workspace}
            role={contexte.role}
            memberships={memberships}
          />
          {peutAdministrer(contexte.role) && (
            <Link
              href="/admin/membres"
              className="text-sm text-white/64 transition-colors hover:text-white
                focus:outline-none focus:ring-2 focus:ring-primary"
            >
              Membres
            </Link>
          )}
          <form action={deconnecter}>
            <button
              type="submit"
              className="text-sm text-white/64 transition-colors hover:text-white
                focus:outline-none focus:ring-2 focus:ring-primary"
            >
              Se déconnecter
            </button>
          </form>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <p className="text-sm text-text-muted">
          Fondation authentifiée en place — le consent flow Omni-FI (Epic 1)
          arrive ici.
        </p>
        {/* Démonstration du gating VIEWER (D2 #37) : action de modification
            désactivée + tooltip pour un VIEWER. */}
        <button
          type="button"
          disabled={!modifiable}
          title={
            modifiable ? undefined : "Réservé aux managers et administrateurs"
          }
          className="h-10 rounded-control bg-primary px-4 text-sm font-semibold
            text-white disabled:opacity-48"
        >
          Ajouter une banque
        </button>
      </main>
    </>
  );
}
