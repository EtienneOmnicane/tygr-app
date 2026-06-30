/**
 * Header applicatif ink (UI_GUIDELINES §1.2), réutilisé par tout le groupe
 * (workspace). Server component : il reçoit le contexte workspace déjà résolu
 * par le layout (jamais de fetch ici) et le passe au `WorkspaceSwitcher` et au
 * gating admin. La nav active vit dans `AppNav` (client, `usePathname`).
 *
 * Extrait du header inline de l'ancien `app/page.tsx` (placeholder accueil) +
 * du chrome de démo `demo/dashboard-states/page.tsx` — source unique désormais.
 *
 *   ┌ bg-ink h-16 ─────────────────────────────────────────────────────┐
 *   │ TYGR.   [nav active=accent]            [switcher] [Membres] [⎋]   │
 *   └──────────────────────────────────────────────────────────────────┘
 */
import Link from "next/link";
import { Suspense } from "react";

import type { MembershipAvecNom } from "@/server/repositories/identite";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
import type { WorkspaceRole } from "@/server/db/schema";

import { peutAdministrer } from "@/lib/permissions";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { PerimetreSwitcher } from "@/components/shell/perimetre-switcher";
import { PeriodeSwitcher } from "@/components/shell/periode-switcher";
import { AppNav } from "@/components/shell/app-nav";
import { BankCtaLink } from "@/components/shell/bank-cta";

export function AppHeader({
  workspaceId,
  workspaceNom,
  role,
  memberships,
  comptes,
  entites,
  viewFilterActif,
  onDeconnexion,
}: {
  workspaceId: string;
  workspaceNom: string;
  role: WorkspaceRole;
  memberships: MembershipAvecNom[];
  /** Comptes visibles (scopés RLS) — alimentent le sélecteur de périmètre. */
  comptes: CompteConnecte[];
  /** Entités visibles (scopées RLS) — alimentent l'onglet « Par entité » (L8b-2). */
  entites: EntiteVisible[];
  /** viewFilter courant (ids) ; null = « Groupe ». Pour l'état actif du sélecteur. */
  viewFilterActif: string[] | null;
  /** Server Action de déconnexion, fournie par le layout. */
  onDeconnexion: () => void;
}) {
  return (
    <header className="flex h-16 items-center gap-6 bg-ink px-6 text-text-onink">
      <Link
        href="/"
        className="text-lg font-bold tracking-tight focus:outline-none
          focus-visible:ring-2 focus-visible:ring-primary"
      >
        TYGR<span className="text-accent">.</span>
      </Link>

      <AppNav />

      <div className="ml-auto flex items-center gap-3">
        {/* Sélecteur de PÉRIODE (L8c) : presets Ce mois / 3m / 6m / 12m / Tout. Lit/écrit
            `?periode` (filtre de lecture, hors RLS) côté client. Sous <Suspense> car
            useSearchParams force le bail-out CSR au prerender (recommandation Next 16) —
            fallback inerte aux mêmes dimensions pour éviter le saut de layout. */}
        <Suspense
          fallback={
            <div
              aria-hidden
              className="h-7 w-[260px] rounded-full bg-surface-inset"
            />
          }
        >
          <PeriodeSwitcher />
        </Suspense>
        {/* Sélecteur de périmètre d'affichage (L8b-1) : Groupe / banque(s). La
            `key` dérivée du périmètre actif force un remount propre quand le
            serveur change le viewFilter (après Appliquer + redirect) — la
            sélection locale repart alors sur la nouvelle vérité sans effet. */}
        <PerimetreSwitcher
          key={viewFilterActif?.join(",") ?? "groupe"}
          comptes={comptes}
          entites={entites}
          viewFilterActif={viewFilterActif}
        />
        <WorkspaceSwitcher
          actifId={workspaceId}
          actifNom={workspaceNom}
          role={role}
          memberships={memberships}
        />
        {/* CTA permanent vers /banques : seul accès à la connexion bancaire une
            fois les états vides disparus (cf. bank-cta.tsx). Gating role à l'intérieur. */}
        <BankCtaLink role={role} />
        {peutAdministrer(role) && (
          <>
            <Link
              href="/admin/membres"
              className="text-sm text-text-onink/64 transition-colors hover:text-text-onink
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Membres
            </Link>
            <Link
              href="/admin/entites"
              className="text-sm text-text-onink/64 transition-colors hover:text-text-onink
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Entités
            </Link>
          </>
        )}
        <form action={onDeconnexion}>
          <button
            type="submit"
            className="text-sm text-text-onink/64 transition-colors hover:text-text-onink
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Se déconnecter
          </button>
        </form>
      </div>
    </header>
  );
}
