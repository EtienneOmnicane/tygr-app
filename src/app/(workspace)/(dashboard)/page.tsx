/**
 * Dashboard de trésorerie (Epic 3 — décision plan « l'accueil EST le dashboard »).
 * Le chrome (header/switcher/nav) vient de `(workspace)/layout.tsx` ; cette page
 * résout les données et monte `DashboardContent` dans la zone de données du shell.
 *
 * Câblage (décisions revue) :
 * - UN SEUL `withWorkspace` (perf) : les 5 services reçoivent le MÊME `tx` et
 *   tournent en parallèle (Promise.all) → une transaction, une revalidation de
 *   membership, RLS appliquée une fois. Le service `dashboard.ts` calcule toute
 *   agrégation en SQL (montants = chaînes, règle 8) ; la page ne recalcule rien.
 * - Fenêtre courbe = 90 jours glissants jusqu'à AUJOURD'HUI à Maurice (UTC+4).
 * - Mono-devise : on passe `base_currency` du workspace ; le service n'agrège que
 *   les comptes de cette devise (garde côté SQL).
 *
 * Mapping erreurs (règle 3) : non authentifié → /login ; aucun workspace →
 * /selection. Une erreur de service (DB/timeout) REMONTE → error.tsx (boundary)
 * rend DashboardErrorState (pas de try/catch ici : le throw est le signal).
 */
import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import {
  courbeTresorerie,
  grilleMois,
  listerComptes,
  soldesCourantsParDevise,
  syntheseMois,
  syntheseParMois,
  transactionsRecentes,
  withWorkspace,
} from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { DashboardContent } from "@/components/dashboard/dashboard-content";

/** Date du jour au fuseau Maurice (UTC+4), format YYYY-MM-DD. */
function aujourdhuiMaurice(): string {
  const maintenant = new Date();
  // Décale de +4h puis lit la date UTC → équivaut à la date locale Maurice.
  const maurice = new Date(maintenant.getTime() + 4 * 60 * 60 * 1000);
  return maurice.toISOString().slice(0, 10);
}

/** Date à J-N (Maurice), format YYYY-MM-DD. */
function ilYaNJours(n: number): string {
  const maintenant = new Date();
  const maurice = new Date(
    maintenant.getTime() + 4 * 60 * 60 * 1000 - n * 24 * 60 * 60 * 1000,
  );
  return maurice.toISOString().slice(0, 10);
}

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

  const to = aujourdhuiMaurice();
  const from = ilYaNJours(90);
  const mois = to.slice(0, 7); // "YYYY-MM" courant
  const NB_MOIS_HISTORIQUE = 6; // fenêtre de tendance (littéral serveur, jamais client)

  // UN SEUL withWorkspace : les lectures + la devise de base partagent le tx.
  const { donnees, devise } = await withWorkspace(session, async (tx) => {
    const [
      comptes,
      soldesParDevise,
      courbe,
      synthese,
      serie,
      transactions,
      ligneWs,
    ] = await Promise.all([
      listerComptes(tx),
      // Solde Total = soldes COURANTS par devise (indépendant de balance_history,
      // vide tant qu'Omni-FI n'expose pas /balances/history). DASH-SOLDE2.
      soldesCourantsParDevise(tx),
      courbeTresorerie(tx, { from, to }),
      syntheseMois(tx, mois),
      // Tendance N derniers mois jusqu'au mois courant Maurice. Une seule requête
      // GROUP BY (mois, devise) ; les mois vides sont comblés par grilleMois côté UI.
      syntheseParMois(tx, { moisFin: mois, nbMois: NB_MOIS_HISTORIQUE }),
      transactionsRecentes(tx),
      tx.execute(
        sql`select base_currency from workspaces where id = current_setting('app.current_workspace_id')::uuid limit 1`,
      ),
    ]);

    const rows = ligneWs as unknown as Array<{ base_currency: string }>;
    return {
      devise: rows[0]?.base_currency ?? "MUR",
      donnees: {
        comptes,
        soldesParDevise,
        courbe,
        syntheseMois: synthese,
        serieMensuelle: serie,
        // Axe continu des N mois (calcul pur, partagé avec l'UI).
        grilleMensuelle: grilleMois(NB_MOIS_HISTORIQUE, mois),
        transactionsRecentes: transactions,
      },
    };
  });

  return <DashboardContent donnees={donnees} devise={devise} />;
}
