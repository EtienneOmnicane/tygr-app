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

import type { MembershipAvecNom } from "@/server/repositories/identite";
import type { WorkspaceRole } from "@/server/db/schema";

import { peutAdministrer } from "@/lib/permissions";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { AppNav } from "@/components/shell/app-nav";
import { BankCtaLink } from "@/components/shell/bank-cta";

export function AppHeader({
  workspaceId,
  workspaceNom,
  role,
  memberships,
  onDeconnexion,
}: {
  workspaceId: string;
  workspaceNom: string;
  role: WorkspaceRole;
  memberships: MembershipAvecNom[];
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
