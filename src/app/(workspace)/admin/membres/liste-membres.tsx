/**
 * Liste des membres du workspace (présentationnel PUR — zéro fetch, zéro état).
 * Rend l'état à côté de l'action de création (solde QA-LISTES-MANQUANTES1(b)).
 * Données reçues en props depuis la page RSC (listerMembresWorkspace). Table dense
 * UI_GUIDELINES §2.1/§2.2 : en-têtes 12px/600 uppercase text-muted, cellules 13px,
 * séparateurs `line`, pas de zébrage. Aucune couleur en dur (tokens sémantiques).
 */
import type { WorkspaceRole } from "@/server/db/schema";

/** Membre tel que présenté (projection de MembreScope côté page). */
export interface MembreLigne {
  userId: string;
  nomComplet: string;
  email: string;
  role: WorkspaceRole;
  /** [] = Vision Globale ; sinon entityIds du périmètre. */
  scopeInitial: string[];
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  ADMIN: "Administrator",
  MANAGER: "Manager",
  VIEWER: "Viewer",
};

// Tokens existants uniquement (cf. globals.css : pas de token `info`).
const ROLE_BADGE: Record<WorkspaceRole, string> = {
  ADMIN: "bg-primary-50 text-primary",
  MANAGER: "bg-warning-bg text-warning",
  VIEWER: "bg-surface-inset text-text-muted",
};

/** Rend le périmètre d'un membre : « Vision Globale » ou la liste des noms d'entités. */
function libellePerimetre(
  scopeInitial: string[],
  entitesParId: Record<string, string>,
): string {
  if (scopeInitial.length === 0) return "Whole group";
  const noms = scopeInitial.map((id) => entitesParId[id]).filter(Boolean);
  // Repli si un id n'est pas dans la map (ex. entité archivée, absente des actives).
  if (noms.length === 0) {
    return `${scopeInitial.length} entité${scopeInitial.length > 1 ? "s" : ""}`;
  }
  return noms.join(", ");
}

export function ListeMembres({
  membres,
  entitesParId,
}: {
  membres: MembreLigne[];
  entitesParId: Record<string, string>;
}) {
  if (membres.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
        Aucun membre pour l’instant.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card bg-surface-card shadow-card">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">
              Nom
            </th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">
              Email
            </th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">
              Role
            </th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">
              Access
            </th>
          </tr>
        </thead>
        <tbody>
          {membres.map((membre) => (
            <tr
              key={membre.userId}
              className="border-b border-line last:border-b-0 align-middle"
            >
              <td className="px-4 py-3 text-[13px] font-medium">
                {membre.nomComplet}
              </td>
              <td className="px-4 py-3 text-[13px] text-text-muted">
                {membre.email}
              </td>
              <td className="px-4 py-3">
                <span
                  className={cn(
                    "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium",
                    ROLE_BADGE[membre.role],
                  )}
                >
                  {ROLE_LABEL[membre.role]}
                </span>
              </td>
              <td className="px-4 py-3 text-[13px] text-text-muted">
                {libellePerimetre(membre.scopeInitial, entitesParId)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
