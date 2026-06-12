/**
 * Accueil authentifié (placeholder Epic 1) — démontre la chaîne complète :
 * JWT → exigerSessionWorkspace (re-validation is_active, E6) → withWorkspace
 * (re-validation membership + RLS, E14) → données du tenant.
 *
 * Mapping erreurs (règle 3) : non authentifié → /login ; workspace d'un autre
 * tenant → 404 via notFound() (jamais 403, pas d'oracle) ; aucun workspace →
 * écran dédié (le sélecteur arrive en PR 2).
 */
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { signOut } from "@/server/auth/config";
import { schema, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { WorkspaceAccessDeniedError } from "@/server/db/tenancy";

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
      return (
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-sm rounded-card bg-surface-card p-8 text-center shadow-card">
            <h1 className="text-base font-semibold">Aucun workspace</h1>
            <p className="mt-2 text-sm text-text-muted">
              Votre compte n&apos;est rattaché à aucun workspace. Contactez
              votre administrateur.
            </p>
          </div>
        </main>
      );
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
      return { role: ctx.role, workspace: lignes[0]?.name ?? "—" };
    });
  } catch (erreur) {
    if (erreur instanceof WorkspaceAccessDeniedError) {
      notFound(); // ressource d'un autre tenant → 404, jamais 403
    }
    throw erreur;
  }

  return (
    <>
      <header className="flex h-16 items-center justify-between bg-ink px-6 text-white">
        <span className="font-semibold">
          TYGR<span className="text-accent">.</span>
        </span>
        <div className="flex items-center gap-4">
          <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
            {contexte.workspace} · {contexte.role}
          </span>
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
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-text-muted">
          Fondation authentifiée en place — le consent flow Omni-FI (Epic 1)
          arrive ici.
        </p>
      </main>
    </>
  );
}
