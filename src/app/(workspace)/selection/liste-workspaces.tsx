"use client";

/**
 * Liste cliquable des workspaces (Epic 2 L1). Chaque entrée déclenche la bascule
 * (Server Action). État erreur D2 : message générique si la bascule échoue
 * (workspace devenu indisponible). Pending : item en cours grisé + spinner.
 */
import { useActionState } from "react";

import type { MembershipAvecNom } from "@/server/repositories/identite";

import { basculerWorkspace, type EtatBascule } from "../actions";

const ETAT_INITIAL: EtatBascule = { erreur: null };

export function ListeWorkspaces({
  memberships,
}: {
  memberships: MembershipAvecNom[];
}) {
  const [etat, action, enCours] = useActionState(
    basculerWorkspace,
    ETAT_INITIAL,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      {etat.erreur !== null && (
        <p role="alert" className="mb-1 text-xs text-danger">
          {etat.erreur}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {memberships.map((m) => (
          <li key={m.workspaceId}>
            <button
              type="submit"
              name="workspaceId"
              value={m.workspaceId}
              disabled={enCours}
              className="flex w-full items-center justify-between gap-3 rounded-control
                border border-line bg-white px-4 py-3 text-left transition-colors
                hover:border-primary hover:bg-primary-50 focus:outline-none
                focus:ring-2 focus:ring-primary disabled:opacity-48"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text">
                  {m.nom}
                </span>
                <span className="block text-xs text-text-muted">
                  {m.kind} · {m.role}
                </span>
              </span>
              {enCours && (
                <span
                  aria-hidden
                  className="size-4 shrink-0 animate-spin rounded-full border-2
                    border-primary/30 border-t-primary"
                />
              )}
            </button>
          </li>
        ))}
      </ul>
    </form>
  );
}
