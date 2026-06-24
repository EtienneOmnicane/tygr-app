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
  cashflowParDevise,
  grilleMois,
  listerComptes,
  soldesCourantsParDevise,
  syntheseMoisParDevise,
  syntheseParMois,
  transactionsRecentes,
  vendorsParConcentration,
  withWorkspace,
} from "@/server/db";
import { VENDORS_TOP_N_DEFAUT } from "@/lib/insights-schema";
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

/**
 * Premier jour (YYYY-MM-DD) du mois obtenu en reculant de `recul` mois depuis
 * `mois` ("YYYY-MM"). Calcul pur sur les composantes (pas de fuseau : on raisonne
 * en mois calendaires Maurice, déjà portés par `mois`). Ex. ("2026-06", 5) →
 * "2026-01-01".
 */
function premierJourMoisRecul(mois: string, recul: number): string {
  const [a, m] = mois.split("-").map(Number);
  // Index 0-based du mois, reculé ; Date normalise les débordements d'année.
  const d = new Date(Date.UTC(a, m - 1 - recul, 1));
  return d.toISOString().slice(0, 10);
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
  const mois = to.slice(0, 7); // "YYYY-MM" courant
  const NB_MOIS_HISTORIQUE = 6; // fenêtre de tendance (littéral serveur, jamais client)
  // Fenêtre de la courbe de FLUX (granularité mois) : 1er jour du mois il y a
  // (NB_MOIS_HISTORIQUE − 1) mois → couvre les mêmes N mois que la tendance.
  const fromFlux = premierJourMoisRecul(mois, NB_MOIS_HISTORIQUE - 1);

  // UN SEUL withWorkspace : les lectures + la devise de base partagent le tx.
  const { donnees, devise } = await withWorkspace(session, async (tx) => {
    const [
      comptes,
      soldesParDevise,
      flux,
      synthesesMois,
      vendors,
      serie,
      transactions,
      ligneWs,
    ] = await Promise.all([
      listerComptes(tx),
      // Solde Total = soldes COURANTS par devise (indépendant de balance_history,
      // vide tant qu'Omni-FI n'expose pas /balances/history). DASH-SOLDE2.
      soldesCourantsParDevise(tx),
      // Courbe = FLUX net mensuel dérivé des transactions (cashflowParDevise) :
      // balance_history est vide en Staging → la courbe de solde restait muette.
      cashflowParDevise(tx, { granularite: "mois", from: fromFlux, to }),
      // Synthèse du mois courant VENTILÉE PAR DEVISE (remplace syntheseMois mono,
      // @deprecated : additionnait MUR + USD). Une ligne par devise.
      syntheseMoisParDevise(tx, mois),
      // Concentration des contreparties (par défaut dépenses) — donnée neuve Voie A.
      vendorsParConcentration(tx, {
        direction: "outflow",
        topN: VENDORS_TOP_N_DEFAUT,
      }),
      // Tendance N derniers mois jusqu'au mois courant Maurice. Une seule requête
      // GROUP BY (mois, devise) ; les mois vides sont comblés par grilleMois côté UI.
      syntheseParMois(tx, { moisFin: mois, nbMois: NB_MOIS_HISTORIQUE }),
      transactionsRecentes(tx),
      tx.execute(
        sql`select base_currency from workspaces where id = current_setting('app.current_workspace_id')::uuid limit 1`,
      ),
    ]);

    const rows = ligneWs as unknown as Array<{ base_currency: string }>;
    const deviseBase = rows[0]?.base_currency ?? "MUR";
    return {
      devise: deviseBase,
      donnees: {
        comptes,
        soldesParDevise,
        // MVP mono-série : on n'affiche que la base_currency dans la courbe
        // (cashflowParDevise renvoie multi-devise ; le multi-série est la dette
        // DASH-CASHFLOW-MULTISERIE). Filtre PUR, hors transaction.
        flux: flux.points.filter((p) => p.currency === deviseBase),
        synthesesMois,
        topVendors: vendors,
        serieMensuelle: serie,
        // Axe continu des N mois (calcul pur, partagé avec l'UI).
        grilleMensuelle: grilleMois(NB_MOIS_HISTORIQUE, mois),
        transactionsRecentes: transactions,
      },
    };
  });

  return <DashboardContent donnees={donnees} devise={devise} mois={mois} />;
}
