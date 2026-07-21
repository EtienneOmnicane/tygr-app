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
  compterConnexionsTenant,
  estLecteurBorne,
  grilleMois,
  grilleMoisSuivants,
  listerComptes,
  soldesCourantsParDevise,
  synthesePeriodeParDevise,
  occurrencesSurFenetre,
  syntheseParMois,
  transactionsRecentes,
  vendorsParConcentration,
  withWorkspace,
} from "@/server/db";
import { projeterEcheancesSurGrille } from "@/components/dashboard/flux-projection";
import { VENDORS_TOP_N_DEFAUT } from "@/lib/insights-schema";
import {
  dateCouranteMaurice,
  formaterIntervalleComptable,
  formaterMoisAnnee,
} from "@/lib/format-date";
import { dernierJourMois, resoudrePeriode } from "@/lib/periode";

/**
 * Profondeur de la zone PRÉVISIONNELLE, en mois (décision D3, 2026-07-17) : FIXE à 3,
 * aligné sur les horizons 30/60/90 j de l'onglet Échéances — le dashboard et la synthèse
 * parlent ainsi de la même profondeur d'engagement. Pas de contrôle de toolbar au MVP.
 */
const NB_MOIS_PREVISION = 3;
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  MotDePasseAChangerError,
  NonAuthentifieError,
} from "@/server/auth/session";

import { DashboardContent } from "@/components/dashboard/dashboard-content";
import {
  CLE_DRAPEAU_CONNEXION,
  drapeauConnexionArme,
} from "@/components/sync/drapeau-connexion";

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
    if (erreur instanceof MotDePasseAChangerError) {
      redirect("/account/password"); // gate AUTH-MDP-TEMPO1 (D3)
    }
    if (erreur instanceof AucunWorkspaceActifError) {
      redirect("/selection");
    }
    throw erreur;
  }

  // Période (L8c + plage précise A1) : on passe les searchParams ENTIERS — `?periode`
  // (preset) ET `?du`/`?au` (plage explicite, qui PRIME sur le preset). `resoudrePeriode`
  // possède tout le contrat d'URL et rend les bornes typées : from/to (jours Maurice
  // INCLUSIFS), nbMois (≥1, fenêtre de tendance), moisAncrage ("YYYY-MM" — mois courant
  // sur un preset, mois de FIN DE PLAGE sur une plage). Toute valeur invalide (preset
  // inconnu, plage inversée/incomplète/hors bornes) est NORMALISÉE ici : l'URL brute ne
  // touche jamais le SQL. Pour « tout », from = plancher 1re partition ("2024-01-01") →
  // from ≤ to garanti et pruning des partitions préservé (filtre sur transaction_date,
  // jamais booking_date_time).
  const parametres = await searchParams;
  const {
    preset,
    from: fromFlux,
    to,
    nbMois,
    moisAncrage: mois,
  } = resoudrePeriode(parametres);

  // ARRIVÉE d'un parcours de connexion réussi — posé par la redirection du widget
  // (`bank-connect-widget.tsx`). Arme le nudge « lancez une première synchronisation ».
  //
  // JETON À USAGE UNIQUE : le composant client le CONSOMME de l'historique dès le premier
  // rendu (cf. `drapeau-connexion.ts`). Sans cette consommation, le bouton Précédent
  // restaurait l'URL et ressuscitait l'invite au-dessus d'un dashboard déjà synchronisé.
  //
  // La lecture passe par le module partagé plutôt que par une comparaison en dur : clé et
  // valeur sont définies une seule fois, et la règle de validation (égalité stricte,
  // fail-safe sur tout le reste) est prouvée par test. Le drapeau ne pilote QU'UN
  // affichage — ni SQL, ni action, ni décision d'autorisation.
  const connexionEtablie = drapeauConnexionArme(
    parametres[CLE_DRAPEAU_CONNEXION],
  );

  // `preset === null` ⇔ une PLAGE EXPLICITE (?du/?au) prime (contrat de resoudrePeriode).
  const sousPlage = preset === null;

  // BORNES DE LA CARTE « SYNTHÈSE » — le point délicat du lot (constat BLOQUANT de la
  // cross-review). Les agrégats prennent désormais des bornes au JOUR :
  //   - sous PRESET : le MOIS D'ANCRAGE ENTIER (1er → dernier jour) = exactement l'ancien
  //     `syntheseMoisParDevise(mois)` → ZÉRO régression, la carte reste « Synthèse du mois » ;
  //   - sous PLAGE : la PLAGE elle-même → la carte devient « Synthèse de la période ».
  // Sans ça, une plage « 3 mars → 17 avril » aurait affiché AVRIL ENTIER (donc des montants
  // hors période) sous une barre annonçant « au 17/04 » : le mensonge que ce lot combat,
  // déplacé de la barre vers la donnée.
  const syntheseFrom = sousPlage ? fromFlux : `${mois}-01`;
  const syntheseTo = sousPlage ? to : dernierJourMois(mois);

  // LIBELLÉ de période — SOURCE UNIQUE (calculé ici, jamais recomposé dans un composant) :
  // il légende l'en-tête, le Top contreparties et la tendance. Sous plage, « N derniers
  // mois » serait FAUX (une plage janvier→mars affichée en juin n'est pas « 3 derniers
  // mois ») → on affiche l'intervalle réel.
  const libellePeriode = sousPlage
    ? formaterIntervalleComptable(fromFlux, to)
    : `${nbMois} dernier${nbMois > 1 ? "s" : ""} mois`;

  // ZONE PRÉVISIONNELLE (C1) — le fuseau Maurice est posé ICI, une seule fois (E20) :
  // tout l'aval (moteur de récurrence, grilles) est de l'arithmétique sur dates « nues ».
  const aujourdhui = dateCouranteMaurice();
  const moisCourant = aujourdhui.slice(0, 7);

  // D4 : la prévision n'apparaît QUE si la fenêtre atteint le mois courant. Sous une plage
  // PASSÉE (« janvier→mars » consultée en juillet), prolonger vers l'avant serait absurde —
  // l'utilisateur regarde le passé — et le libellé de période mentirait (même piège que
  // « N derniers mois » sous plage précise, TOOLBAR-DATE-PRECISE1). `moisAncrage` vaut le
  // mois courant sous preset, le mois de FIN DE PLAGE sous plage : le comparer suffit.
  const previsionActive = mois === moisCourant;
  const grillePrevision = previsionActive
    ? grilleMoisSuivants(NB_MOIS_PREVISION, mois)
    : [];
  // Fenêtre d'expansion : d'AUJOURD'HUI (D2 — le mois courant montre son réalisé à date
  // PUIS ses échéances restantes) au dernier jour du dernier mois projeté.
  const finPrevision = previsionActive
    ? dernierJourMois(grillePrevision[grillePrevision.length - 1])
    : null;

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
      occurrences,
      ligneWs,
      nbConnexionsTenant,
    ] = await Promise.all([
      listerComptes(tx),
      // Solde Total = soldes COURANTS par devise (indépendant de balance_history,
      // vide tant qu'Omni-FI n'expose pas /balances/history). DASH-SOLDE2.
      soldesCourantsParDevise(tx),
      // Courbe = FLUX net mensuel dérivé des transactions (cashflowParDevise) :
      // balance_history est vide en Staging → la courbe de solde restait muette.
      cashflowParDevise(tx, { granularite: "mois", from: fromFlux, to }),
      // Synthèse VENTILÉE PAR DEVISE (remplace syntheseMois mono, @deprecated :
      // additionnait MUR + USD). Une ligne par devise. Bornes au JOUR (cf. ci-dessus).
      synthesePeriodeParDevise(tx, { from: syntheseFrom, to: syntheseTo }),
      // Concentration des contreparties (par défaut dépenses) — donnée neuve Voie A.
      // Fenêtre = MÊME période que la courbe de flux (FB0709-TOPVENDORS5 : le
      // sélecteur 1/3/6 mois doit piloter la carte, pas tout l'historique).
      vendorsParConcentration(tx, {
        direction: "outflow",
        topN: VENDORS_TOP_N_DEFAUT,
        from: fromFlux,
        to,
      }),
      // Tendance : série GROUP BY (mois, devise) sur la MÊME fenêtre [from, to] que le
      // reste de l'écran — bornée au JOUR. Sous plage, les mois d'EXTRÉMITÉ sont donc
      // PARTIELS (mars = 3→31), ce que le libellé de période annonce. Les mois vides sont
      // comblés par grilleMois côté UI.
      syntheseParMois(tx, { from: fromFlux, to }),
      transactionsRecentes(tx),
      // PRÉVISIONNEL (C1) — occurrences d'échéances, récurrences comprises (moteur pur).
      // ⚠️ Lecture DANS le Promise.all existant, sous le MÊME `tx` : ouvrir un second
      // `withWorkspace` pour la projection rejouerait le défaut d'auto-amputation déjà
      // rencontré (L8b-1 : un chemin parallèle qui lit SANS le périmètre du reste de
      // l'écran). Même transaction ⇒ mêmes GUC ⇒ mêmes deux étages RLS.
      finPrevision !== null
        ? occurrencesSurFenetre(tx, ctx, {
            debut: aujourdhui,
            fin: finPrevision,
            aujourdhui,
          })
        : [],
      tx.execute(
        sql`select base_currency from workspaces where id = current_setting('app.current_workspace_id')::uuid limit 1`,
      ),
      // NUDGE-VISION-ENTITE1 — le tenant a-t-il au moins une connexion ? COUNT sur
      // `bank_connections`, table qui ne porte QUE `tenant_isolation` : borné au
      // workspace par la RLS, sans lire `bank_accounts`, donc sans contourner l'étage 2.
      // Dans CE Promise.all, sous le MÊME `tx` que le reste de l'écran — un second
      // withWorkspace rejouerait l'auto-amputation L8b-1 (cf. note des occurrences).
      compterConnexionsTenant(tx),
    ]);

    const rows = ligneWs as unknown as Array<{ base_currency: string }>;
    const deviseBase = rows[0]?.base_currency ?? "MUR";

    // Agrégation PURE (hors SQL, comme le filtre de flux ci-dessous) : les occurrences
    // deviennent des cellules mensuelles réduites à la devise de base — jamais additionnées
    // au réalisé, jamais converties (DASH-FX1). La grille est [mois pivot, ...mois futurs] :
    // le mois courant reçoit ses échéances RESTANTES, empilées sur son réalisé (D2).
    const previsionParMois = previsionActive
      ? projeterEcheancesSurGrille(
          occurrences,
          [mois, ...grillePrevision],
          deviseBase,
        )
      : [];
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
        // Prévision (C1) — `null` quand la fenêtre n'atteint pas le mois courant (D4) :
        // l'UI ne rend alors AUCUNE zone prévisionnelle (pas de colonnes fantômes à zéro —
        // une prévision vide n'est pas une prévision nulle).
        prevision: previsionActive
          ? {
              moisCourant: previsionParMois[0],
              moisFuturs: previsionParMois.slice(1),
            }
          : null,
        transactionsRecentes: transactions,
        // Deux BOOLÉENS dérivés (jamais le compte brut, jamais un identifiant) : ils ne
        // servent qu'à distinguer « aucune banque » de « aucun compte accessible ».
        aDesConnexionsTenant: nbConnexionsTenant > 0,
        // Le lecteur est-il réellement borné ? Résolu depuis le CONTEXTE serveur
        // (member_entity_scopes / user_scopes via withWorkspace), jamais d'un paramètre
        // client. La formule vit dans `tenancy.ts` (source unique, partagée avec la preuve
        // d'isolation) : recopiée ici, elle pourrait dériver sans faire rougir son test.
        lecteurBorne: estLecteurBorne(ctx),
      },
    };
  });

  return (
    <DashboardContent
      donnees={donnees}
      devise={devise}
      libellePeriode={libellePeriode}
      // La carte de synthèse DIT ce qu'elle agrège : le mois d'ancrage sous preset,
      // l'intervalle réel sous plage. Jamais « Synthèse du mois » au-dessus d'un total
      // qui ne couvre pas le mois.
      syntheseTitre={sousPlage ? "Synthèse de la période" : "Synthèse du mois"}
      syntheseLibelle={
        sousPlage
          ? formaterIntervalleComptable(syntheseFrom, syntheseTo)
          : formaterMoisAnnee(mois)
      }
      role={role}
      connexionEtablie={connexionEtablie}
    />
  );
}
