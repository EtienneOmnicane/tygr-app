/**
 * Accueil authentifié = futur dashboard de trésorerie (Epic 3, décision plan
 * « l'accueil EST le dashboard »). Le chrome (header ink, switcher, nav) est
 * désormais porté par `(workspace)/layout.tsx` — cette page ne rend QUE son
 * contenu, monté dans la zone de données du shell.
 *
 * État actuel : placeholder. La courbe de trésorerie (ancre), le side-panel KPI
 * et la table arrivent avec PR C/D (câblés aux services de lecture dashboard.ts).
 * Le gating VIEWER (D2 #37) est conservé pour démontrer la chaîne d'autorisation.
 *
 * Mapping erreurs (règle 3) : non authentifié → /login ; aucun workspace →
 * /selection ; tenant étranger → 404. Identique au layout (chaque RSC re-valide).
 */
import { redirect } from "next/navigation";

import { peutModifier } from "@/lib/permissions";
import { withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

export default async function PageDashboard() {
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

  const role = await withWorkspace(session, async (_tx, ctx) => ctx.role);
  const modifiable = peutModifier(role);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <p className="text-sm text-text-muted">
        Fondation authentifiée en place — la courbe de trésorerie (Epic 3) arrive
        ici.
      </p>
      {/* Gating VIEWER (D2 #37) : action de modification désactivée + tooltip. */}
      <button
        type="button"
        disabled={!modifiable}
        title={modifiable ? undefined : "Réservé aux managers et administrateurs"}
        className="h-10 rounded-control bg-primary px-4 text-sm font-semibold
          text-text-onink disabled:opacity-48"
      >
        Ajouter une banque
      </button>
    </main>
  );
}
