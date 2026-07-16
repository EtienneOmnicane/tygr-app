"use client";

/**
 * Switcher de workspace dans le header (Epic 2 L1, dropdown riche §4.4).
 * - Mono-workspace → badge simple (pas de dropdown, plan D2 « switcher skippé »).
 * - Multi → bouton ouvrant la liste ; chaque entrée poste la bascule (L2). Le
 *   workspace actif est coché et non cliquable.
 * La liste vient du serveur (membershipsAvecNom, sous RLS) — jamais construite ici.
 */
import { useState } from "react";

import type { MembershipAvecNom } from "@/server/repositories/identite";
import type { WorkspaceRole } from "@/server/db/schema";

import { basculerWorkspace, type EtatBascule } from "@/app/(workspace)/actions";
import { useActionState } from "react";

const ETAT_INITIAL: EtatBascule = { erreur: null };

export function WorkspaceSwitcher({
  actifId,
  actifNom,
  role,
  memberships,
}: {
  actifId: string;
  actifNom: string;
  role: WorkspaceRole;
  memberships: MembershipAvecNom[];
}) {
  const [ouvert, setOuvert] = useState(false);
  const [, action, enCours] = useActionState(basculerWorkspace, ETAT_INITIAL);

  // Mono-workspace : badge simple, pas d'interaction.
  if (memberships.length <= 1) {
    return (
      <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
        {actifNom} · {role}
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOuvert((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={ouvert}
        className="flex items-center gap-2 rounded-full bg-surface-inset px-3 py-1
          text-xs font-medium text-ink focus:outline-none focus:ring-2
          focus:ring-primary"
      >
        <span className="max-w-[160px] truncate">{actifNom}</span>
        <span className="text-ink/60">· {role}</span>
        <span aria-hidden>▾</span>
      </button>

      {ouvert && (
        <form
          action={action}
          className="absolute right-0 z-10 mt-2 w-64 rounded-control bg-surface-card
            p-1 shadow-popover"
          role="listbox"
        >
          {memberships.map((m) => {
            const estActif = m.workspaceId === actifId;
            return (
              <button
                key={m.workspaceId}
                type="submit"
                name="workspaceId"
                value={m.workspaceId}
                disabled={estActif || enCours}
                role="option"
                aria-selected={estActif}
                className="flex w-full items-center justify-between gap-2 rounded-control
                  px-3 py-2 text-left text-sm text-text transition-colors
                  hover:bg-primary-50 disabled:cursor-default disabled:hover:bg-transparent
                  focus:outline-none focus:bg-primary-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{m.nom}</span>
                  <span className="block text-xs text-text-muted">
                    {m.kind} · {m.role}
                  </span>
                </span>
                {estActif && (
                  <span aria-hidden className="text-success">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </form>
      )}
    </div>
  );
}
