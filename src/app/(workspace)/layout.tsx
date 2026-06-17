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
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";

import { signOut } from "@/server/auth/config";
import { identite, schema, withWorkspace } from "@/server/db";
import type { WorkspaceRole } from "@/server/db/schema";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import {
  UnsafeDatabaseRoleError,
  WorkspaceAccessDeniedError,
} from "@/server/db/tenancy";

import { AppHeader } from "@/components/shell/app-header";
import { AppErrorState } from "@/components/ui/states";

async function deconnecter() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

/**
 * Filet d'erreur d'INFRASTRUCTURE pour le data-fetching de CE layout. Un error
 * boundary (error.tsx/global-error.tsx) ne capture PAS une exception levée par le
 * fetch d'un layout au SSR initial (Next 16.2, vérifié) — on rend donc l'écran
 * proprement ici. Couvre toute erreur infra (ServiceIndisponibleError du chemin
 * E6, MAIS aussi une panne réseau brute survenant pendant withWorkspace /
 * membershipsAvecNom — axe 5 de la cross-review).
 *
 * Garde-fous (ordre important) :
 * 1. `unstable_rethrow` : re-lance les exceptions de CONTRÔLE Next
 *    (redirect/notFound) — ne JAMAIS les avaler, sinon une navigation est perdue.
 * 2. `UnsafeDatabaseRoleError` : refus de SÉCURITÉ définitif (garde-fou C6, la
 *    connexion tourne sous l'owner → RLS contournable). Ce n'est PAS un incident
 *    temporaire « réessayable » : on re-`throw` (500 bruyant), jamais l'écran.
 * 3. Le reste = incident d'infra temporaire → écran propre, FAIL-CLOSED (aucune
 *    session/chrome n'est rendu, on retourne un écran d'erreur).
 */
function gererErreurInfra(erreur: unknown): never | ReactNode {
  unstable_rethrow(erreur); // (1) ne pas avaler redirect/notFound
  if (erreur instanceof UnsafeDatabaseRoleError) {
    throw erreur; // (2) refus de sécurité — pas un « réessayez »
  }
  // (3) incident d'infra : écran propre sans chrome (session non résolue).
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-6 py-8">
      <AppErrorState />
    </main>
  );
}

export default async function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Résolution de la chaîne auth/workspace. Les erreurs MÉTIER déclenchent une
  // navigation (redirect/notFound — qui lèvent leur propre exception de contrôle
  // Next, laissée remonter). Les erreurs d'INFRA (ServiceIndisponibleError : base
  // injoignable) sont rendues ICI en écran propre — car un error boundary
  // (error.tsx/global-error.tsx) NE capture PAS une exception levée par le
  // data-fetching d'un layout pendant le SSR initial (vérifié empiriquement sur
  // Next 16.2 ; cf. TODOS). On gère donc l'incident dans le layout lui-même
  // plutôt que de propager. FAIL-CLOSED conservé : aucune session n'est servie.
  let contexte:
    | { role: WorkspaceRole; workspaceId: string; workspaceNom: string }
    | null = null;
  let userId: string | null = null;
  try {
    const session = await exigerSessionWorkspace();
    userId = session.userId;
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
    if (erreur instanceof NonAuthentifieError) {
      redirect("/login");
    }
    if (erreur instanceof AucunWorkspaceActifError) {
      redirect("/selection");
    }
    if (erreur instanceof WorkspaceAccessDeniedError) {
      notFound(); // ressource d'un autre tenant → 404, jamais 403
    }
    return gererErreurInfra(erreur);
  }

  // Memberships pour le switcher (sous RLS, S2). Lu hors withWorkspace : lecture
  // pré-contexte (own_memberships_select), pas du tenant courant. Même filet
  // infra que ci-dessus.
  let memberships;
  try {
    memberships = await identite.membershipsAvecNom(userId);
  } catch (erreur) {
    return gererErreurInfra(erreur);
  }

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
