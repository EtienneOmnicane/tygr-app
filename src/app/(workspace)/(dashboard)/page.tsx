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
 * - Fenêtre = pilotée par le PRESET de période (L8c) lu dans `?periode`. Défaut
 *   « 6m » si absent/invalide → comportement historique inchangé (NB_MOIS_HISTORIQUE
 *   = 6). Les bornes sont résolues par `resoudrePeriode` (PUR, fuseau Maurice) — la
 *   valeur d'URL brute ne touche jamais le SQL (normalisée en nbMois/dates typées).
 *   Le MÊME preset pilote la courbe de flux, la tendance mensuelle et la grille d'axe.
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
import { resoudrePeriode } from "@/lib/periode";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { DashboardContent } from "@/components/dashboard/dashboard-content";

/**
 * Next 16 : `searchParams` est un Promise à `await` (AGENTS.md « This is NOT the
 * Next.js you know »). Lire `?periode` opte la page en rendu dynamique — sans impact
 * ici (le dashboard fetch déjà par requête sous withWorkspace, jamais prérendu).
 */
export default async function PageDashboard({
  searchParams,
}: {
  searchParams: Promise<{ [cle: string]: string | string[] | undefined }>;
}) {
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

  // Preset de période (L8c) : la valeur d'URL est NORMALISÉE ici (liste blanche,
  // défaut 6m). `resoudrePeriode` retourne les bornes typées — from/to (jours Maurice
  // INCLUSIFS), nbMois (≥1, fenêtre de tendance) et moisAncrage ("YYYY-MM" courant).
  // Pour « tout », from = plancher 1re partition ("2024-01-01") → from ≤ to garanti et
  // pruning des partitions préservé (filtre sur transaction_date, jamais booking_date_time).
  const { periode } = await searchParams;
  const { from: fromFlux, to, nbMois, moisAncrage: mois } = resoudrePeriode(periode);

  // UN SEUL withWorkspace : les lectures + la devise de base partagent le tx. Le
  // `ctx.role` (re-résolu serveur) descend en prop pour gater le bouton « Synchroniser »
  // côté UI (confort — la garde réelle est dans l'orchestration, cf. SyncButton).
  const { donnees, devise, role } = await withWorkspace(session, async (tx, ctx) => {
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
      // Fenêtre = MÊME période que la courbe de flux (FB0709-TOPVENDORS5 : le
      // sélecteur 1/3/6 mois doit piloter la carte, pas tout l'historique).
      vendorsParConcentration(tx, {
        direction: "outflow",
        topN: VENDORS_TOP_N_DEFAUT,
        from: fromFlux,
        to,
      }),
      // Tendance des `nbMois` derniers mois jusqu'au mois courant Maurice (piloté par
      // le preset). Une seule requête GROUP BY (mois, devise) ; les mois vides sont
      // comblés par grilleMois côté UI.
      syntheseParMois(tx, { moisFin: mois, nbMois }),
      transactionsRecentes(tx),
      tx.execute(
        sql`select base_currency from workspaces where id = current_setting('app.current_workspace_id')::uuid limit 1`,
      ),
    ]);

    const rows = ligneWs as unknown as Array<{ base_currency: string }>;
    const deviseBase = rows[0]?.base_currency ?? "MUR";
    return {
      devise: deviseBase,
      role: ctx.role,
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
        // Axe continu des `nbMois` mois (calcul pur, partagé avec l'UI).
        grilleMensuelle: grilleMois(nbMois, mois),
        transactionsRecentes: transactions,
      },
    };
  });

  return (
    <DashboardContent donnees={donnees} devise={devise} mois={mois} role={role} />
  );
}
