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

import { auth, signOut } from "@/server/auth/config";
import { GardeSession } from "@/components/shell/garde-session";
import {
  identite,
  listerComptes,
  listerEntitesVisibles,
  schema,
  withWorkspace,
} from "@/server/db";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
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

import { AppSidebar } from "@/components/shell/app-sidebar";
import { AppTopbar } from "@/components/shell/app-topbar";
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
    | {
        role: WorkspaceRole;
        workspaceId: string;
        workspaceNom: string;
        comptes: CompteConnecte[];
        entites: EntiteVisible[];
      }
    | null = null;
  let userId: string | null = null;
  // viewFilter courant (L8b-1) : INTENTION de périmètre portée par la session,
  // passée au header pour que le sélecteur affiche l'état actif (comptes cochés).
  // Absent/null ⇒ « Groupe ». Lecture seule (pas une autorité — la RLS décide).
  let viewFilterActif: string[] | null = null;
  // Expiration du JWT (ms epoch) pour la garde de session (PR 2′). `auth()` est
  // mémoïsé par requête ; `exigerSessionWorkspace` ne remonte pas `expires` et on
  // n'élargit pas son contrat (c'est une surface de sécurité).
  let expiresAt: number | null = null;
  try {
    const session = await exigerSessionWorkspace();
    userId = session.userId;
    viewFilterActif = session.viewFilter ?? null;

    const sessionBrute = await auth();
    const expires = sessionBrute?.expires;
    if (typeof expires === "string") {
      const ms = Date.parse(expires);
      // NaN (format inattendu) ⇒ on n'arme pas la garde plutôt que d'ouvrir la
      // modale immédiatement (fail-soft : la session reste valide côté serveur).
      expiresAt = Number.isNaN(ms) ? null : ms;
    }

    // (1) CONTEXTE du chrome (role + nom du workspace). On garde la SESSION
    //     COMPLÈTE : le nom du workspace est indifférent au view_filter (il ne lit
    //     aucun bank_accounts scopé), donc le filtre éventuel est sans effet ici.
    const contexteChrome = await withWorkspace(session, async (tx, ctx) => {
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

    // (2) Liste qui ALIMENTE le sélecteur de périmètre : elle doit refléter le
    //     DROIT COMPLET du membre, JAMAIS le view_filter — sinon, une fois un
    //     filtre appliqué, listerComptes (SELECT bank_accounts, soumis à la clause
    //     AND view_filter de la policy account_scope, 0016/0017) ne renverrait que
    //     les comptes filtrés → le sélecteur s'auto-amputerait et on ne pourrait
    //     plus ré-élargir (bug L8b-1). On lit donc dans une transaction SÉPARÉE
    //     avec une session SANS viewFilter (mêmes 2 champs que le callback jwt,
    //     config.ts:145-151) → le GUC app.current_view_filter n'est PAS posé →
    //     clause view_filter neutre. account_scope / entity_scope / tenant_isolation
    //     restent posés (sécurité INCHANGÉE) → la liste = exactement le droit du
    //     membre, ni plus, ni moins. Transaction distincte = GUC en SET LOCAL, donc
    //     aucune interférence avec la lecture filtrée des cartes (page.tsx).
    const comptes = await withWorkspace(
      { userId: session.userId, activeWorkspaceId: session.activeWorkspaceId },
      (tx) => listerComptes(tx),
    );

    // (3) Entités VISIBLES qui peuplent l'onglet « Par entité » du sélecteur (L8b-2).
    //     MÊME exigence que (2) : session SANS viewFilter (droit complet) pour que la
    //     liste d'entités reste COMPLÈTE même quand un filtre est actif — sinon elle
    //     s'auto-amputerait après filtrage (leçon #143) et on ne pourrait plus
    //     ré-élargir vers une autre entité. Transaction distincte (SET LOCAL) → aucune
    //     interférence avec les lectures filtrées des cartes (page.tsx).
    const entites = await withWorkspace(
      { userId: session.userId, activeWorkspaceId: session.activeWorkspaceId },
      (tx) => listerEntitesVisibles(tx),
    );

    contexte = { ...contexteChrome, comptes, entites };
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

  // Signature du périmètre actif → `key` du conteneur de page (A4 /
  // PERIMETRE-REDIRECT-PAGE1). GARDE INDISPENSABLE depuis que les actions de
  // périmètre reviennent sur la page COURANTE au lieu du dashboard :
  //
  // rester sur la même route = un RE-RENDER, pas un remount (Next : poser un cookie
  // dans une Server Action re-rend la page et ses layouts, mais « client state is
  // preserved for re-rendered components »). Or les features clientes SÈMENT leur
  // donnée RSC dans un useState — `transactions-feature.tsx:104`,
  // `graphiques-feature.tsx:121`, `echeances-feature.tsx:93` — et un useState(prop)
  // ne se re-sème PAS au re-render. Sans cette `key`, « Appliquer » sur
  // /transactions afficherait « Sucre » dans la topbar pendant que la table
  // montrerait encore TOUS les comptes : un mensonge d'affichage sur de la donnée
  // financière.
  //
  // Changer la clé démonte/remonte le sous-arbre de page → chaque feature re-sème
  // depuis les props RSC FRAÎCHES (déjà scopées par la RLS). Garde STRUCTURELLE :
  // elle couvre aussi les pages FUTURES, sans qu'elles aient à y penser.
  // Contrepartie assumée (arbitrage 2026-07-14) : les filtres in-page (recherche /
  // statut / dates) sont réinitialisés à un changement de PÉRIMÈTRE — plus jamais
  // lors d'une navigation. Dette P2 TX-FILTRES-URL1 : les porter dans l'URL, ils
  // survivront alors au remount.
  //
  // Indépendante de la `key` du PerimetreSwitcher (app-topbar.tsx:64) : chacune n'a
  // besoin que d'être une signature stable de `viewFilterActif` — elles n'ont pas à
  // être identiques, donc aucun couplage à maintenir.
  const clePerimetre = viewFilterActif?.join(",") ?? "groupe";

  return (
    <div className="flex min-h-screen bg-surface-page">
      <AppSidebar
        workspaceId={contexte.workspaceId}
        workspaceNom={contexte.workspaceNom}
        role={contexte.role}
        memberships={memberships}
        onDeconnexion={deconnecter}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar
          role={contexte.role}
          comptes={contexte.comptes}
          entites={contexte.entites}
          viewFilterActif={viewFilterActif}
        />
        <div key={clePerimetre} className="min-w-0 flex-1">
          {children}
        </div>
      </div>

      {/* Garde de session (PR 2′, D2 « Transverse »). Montée EN DEHORS de
          `children` et rendue en portail : quand la modale s'ouvre, l'écran
          sous-jacent n'est ni démonté ni re-rendu — c'est ce qui préserve le
          contexte (OTP du widget MFA, formulaire en cours). Inerte tant que la
          session n'approche pas de l'expiration ; absente si `expiresAt` est
          indéterminé (fail-soft). */}
      {userId !== null && expiresAt !== null && (
        <GardeSession userIdActuel={userId} expiresAt={expiresAt} />
      )}
    </div>
  );
}
