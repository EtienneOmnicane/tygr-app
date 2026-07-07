/**
 * Barre latérale applicative Dodo (UI_GUIDELINES §1.1/§1.2, refonte Dodo). Server
 * component : reçoit le contexte workspace déjà résolu par le layout (jamais de
 * fetch ici) et le passe au `WorkspaceSwitcher` + au gating admin. La nav active
 * vit dans `SidebarNav` (client, `usePathname`).
 *
 * Remplace l'ancien header horizontal `bg-ink` : colonne verticale 232px sur
 * `surface-card`, collée en haut (`sticky top-0 h-screen`), bordée à droite.
 *
 *   ┌ w-[232px] bg-surface-card border-r ┐
 *   │ [logo] Dodo.                        │
 *   │                                     │
 *   │  • Dashboard (actif=pilule ink)     │
 *   │    Transactions … Règles            │
 *   │                                     │
 *   │ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ │
 *   │ [workspace · rôle]                  │
 *   │ Membres · Entités (si admin)        │
 *   │ Se déconnecter                      │
 *   └─────────────────────────────────────┘
 */
import Image from "next/image";
import Link from "next/link";

import type { MembershipAvecNom } from "@/server/repositories/identite";
import type { WorkspaceRole } from "@/server/db/schema";

import { peutAdministrer } from "@/lib/permissions";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { SidebarNav } from "@/components/shell/sidebar-nav";

export function AppSidebar({
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
    <aside
      className="sticky top-0 flex h-screen w-[232px] shrink-0 flex-col gap-6
        overflow-y-auto border-r border-line bg-surface-card px-4 py-6"
    >
      <Link
        href="/"
        className="flex items-center gap-2.5 rounded px-1 focus:outline-none
          focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Image
          src="/logo-dodo.png"
          alt=""
          width={34}
          height={39}
          className="rounded-control"
          priority
        />
        <span className="text-xl font-extrabold tracking-tight text-ink">
          Dodo<span className="text-accent">.</span>
        </span>
      </Link>

      <SidebarNav />

      <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
        <WorkspaceSwitcher
          actifId={workspaceId}
          actifNom={workspaceNom}
          role={role}
          memberships={memberships}
        />
        {peutAdministrer(role) && (
          <div className="flex flex-col gap-0.5">
            <Link
              href="/admin/membres"
              className="rounded px-1 py-0.5 text-sm text-text-muted transition-colors
                hover:text-text focus:outline-none focus-visible:ring-2
                focus-visible:ring-primary"
            >
              Membres
            </Link>
            <Link
              href="/admin/entites"
              className="rounded px-1 py-0.5 text-sm text-text-muted transition-colors
                hover:text-text focus:outline-none focus-visible:ring-2
                focus-visible:ring-primary"
            >
              Entités
            </Link>
          </div>
        )}
        <form action={onDeconnexion}>
          <button
            type="submit"
            className="rounded px-1 py-0.5 text-left text-sm text-text-muted
              transition-colors hover:text-text focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary"
          >
            Se déconnecter
          </button>
        </form>
      </div>
    </aside>
  );
}
