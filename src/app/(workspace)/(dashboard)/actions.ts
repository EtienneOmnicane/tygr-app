"use server";

/**
 * Server Actions du dashboard. Surface d'appel CLIENT par-dessus les services de
 * lecture scopés (`@/server/repositories/dashboard` via le barrel @/server/db).
 * Le RSC `page.tsx` lit ses données directement dans withWorkspace ; CETTE action
 * sert aux rafraîchissements CLIENT dynamiques (ex. un graphique qui change sa
 * fenêtre de mois sans recharger la page).
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (membership re-validée à chaque
 *   requête ; RLS tenant + scope entité par jointure). Lecture seule, ouverte aux
 *   membres (comme le reste du dashboard). workspace_id JAMAIS un paramètre client.
 * - Validation Zod stricte (nbMois borné).
 * - Retour normalisé ResultatAction (jamais d'exception propagée au client).
 * - Pas de PII (agrégats de montants uniquement, jamais de libellé).
 */
import { z } from "zod";

import { moisCourantMaurice } from "@/lib/format-date";
import {
  dernierJourMois,
  premierJourMoisRecul,
  resoudrePeriode,
} from "@/lib/periode";
import {
  detailBucketParamsSchema,
  fluxParamsSchema,
  MAX_BUCKETS_FLUX,
  VENDORS_TOP_N_DEFAUT,
} from "@/lib/insights-schema";
import { bornesBucket, grilleBuckets } from "@/components/charts/grille-buckets";
import {
  exigerSessionWorkspace,
  ServiceIndisponibleError,
} from "@/server/auth/session";
import {
  cashflowParDevise,
  InsightsParamsInvalidesError,
  repartitionParCategorie,
  type SyntheseMensuelle,
  syntheseParMois,
  vendorsParConcentration,
  withWorkspace,
} from "@/server/db";
import type {
  ConcentrationVendors,
  GranulariteCashflow,
  PointCashflow,
  RepartitionCategories,
} from "@/server/insights/types";

export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** Payload de flux d'une granularité : points bruts multi-devises + axe continu. */
export interface SerieFluxChargee {
  granularite: GranulariteCashflow;
  /** Une ligne par (bucket, devise) — jamais d'addition cross-devise. */
  points: PointCashflow[];
  /** Buckets attendus (axe continu), du plus ancien au plus récent. */
  grille: string[];
}

// Le sélecteur de périmètre (definirViewFilter / EtatPerimetre) vit au niveau
// workspace (`(workspace)/actions.ts`, à côté de basculerWorkspace) car son
// PerimetreSwitcher est monté dans le header GLOBAL du groupe, pas seulement sur
// le dashboard. Cf. revue d'altitude L8b-1.

/** Borne du nombre de mois demandés (1..36 ; 3 ans suffisent pour un graphique). */
const syntheseParMoisSchema = z
  .object({ nbMois: z.number().int().min(1).max(36).default(12) })
  .strict();

/**
 * Série mensuelle Entrées/Sorties (Cash In/Out) des `nbMois` derniers mois (défaut
 * 12), par devise — pour un graphique Front. La fenêtre est dérivée SERVEUR depuis le
 * mois COURANT Maurice (conversion explicite Indian/Mauritius) ; jamais un paramètre
 * client. Multi-devises : une ligne par (mois, devise), jamais d'addition cross-devise.
 *
 * ⚠️ `syntheseParMois` prend désormais des bornes au JOUR [from, to] (et non plus
 * {moisFin, nbMois}) — cf. TOOLBAR-DATE-PRECISE1 : une plage précise doit pouvoir borner
 * la série ailleurs qu'à un bord de mois. Ici on reconstitue EXACTEMENT l'ancienne
 * fenêtre : du 1er jour du mois reculé de (nbMois − 1) au DERNIER jour du mois courant
 * → série identique à celle d'avant, zéro régression pour cet appelant.
 */
export async function syntheseParMoisAction(input?: {
  nbMois?: number;
}): Promise<ResultatAction<SyntheseMensuelle[]>> {
  const session = await exigerSessionWorkspace();
  const parsed = syntheseParMoisSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: "Paramètres invalides." };
  }
  try {
    const moisFin = moisCourantMaurice();
    const from = premierJourMoisRecul(moisFin, parsed.data.nbMois - 1);
    const to = dernierJourMois(moisFin);
    const data = await withWorkspace(session, (tx) =>
      syntheseParMois(tx, { from, to }),
    );
    return { ok: true, data };
  } catch (erreur) {
    const code =
      erreur instanceof ServiceIndisponibleError
        ? "SERVICE_UNAVAILABLE"
        : "ERREUR";
    console.warn(
      JSON.stringify({
        evt: "dashboard_echec",
        action: "synthese-par-mois",
        workspaceId: session.activeWorkspaceId,
        code,
      }),
    );
    return {
      ok: false,
      code,
      message:
        code === "SERVICE_UNAVAILABLE"
          ? "Service momentanément indisponible."
          : "L’opération a échoué. Réessayez.",
    };
  }
}

/**
 * Série de flux (entrées/sorties par bucket ET par devise) à la GRANULARITÉ demandée
 * (jour / semaine / mois) — re-fetch CLIENT du graphe « Flux de trésorerie » quand
 * l'utilisateur change le pas de temps (L2). La FENÊTRE ne change pas : elle est
 * re-dérivée à Maurice depuis le descripteur d'URL renvoyé par le client
 * (`resoudrePeriode`, qui normalise toute valeur inconnue) — le client n'impose jamais
 * une borne de date brute au SQL.
 *
 * Exit-criteria (règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (RLS tenant + scope entité hérité par
 *   la jointure `bank_accounts` de `cashflowParDevise`) ; workspace_id jamais un paramètre.
 * - Validation Zod stricte : granularité = énum fermée (→ littéral SQL figé côté repo),
 *   descripteur de période re-normalisé par `resoudrePeriode`.
 * - PLAFOND de buckets : au-delà de MAX_BUCKETS_FLUX, refus NOMMÉ (`GRANULARITE_TROP_FINE`)
 *   AVANT le SQL — jamais de troncature silencieuse.
 * - Retour normalisé (jamais d'exception au navigateur) ; logs corrélés (workspace_id +
 *   code), SANS PII (agrégats de montants uniquement).
 */
export async function chargerFluxAction(
  input: unknown,
): Promise<ResultatAction<SerieFluxChargee>> {
  const session = await exigerSessionWorkspace();
  const parsed = fluxParamsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: "Paramètres invalides." };
  }
  const { granularite, periode, du, au } = parsed.data;
  const { from, to } = resoudrePeriode({ periode, du, au });
  const grille = grilleBuckets(granularite, from, to);
  if (grille.length > MAX_BUCKETS_FLUX) {
    console.warn(
      JSON.stringify({
        evt: "dashboard_echec",
        action: "charger-flux",
        workspaceId: session.activeWorkspaceId,
        code: "GRANULARITE_TROP_FINE",
        buckets: grille.length,
      }),
    );
    return {
      ok: false,
      code: "GRANULARITE_TROP_FINE",
      message:
        "Période trop large pour ce pas de temps. Choisissez un pas plus grand ou une période plus courte.",
    };
  }
  try {
    const serie = await withWorkspace(session, (tx) =>
      cashflowParDevise(tx, { granularite, from, to }),
    );
    return { ok: true, data: { granularite, points: serie.points, grille } };
  } catch (erreur) {
    const code =
      erreur instanceof InsightsParamsInvalidesError
        ? "INVALID_PARAMS"
        : erreur instanceof ServiceIndisponibleError
          ? "SERVICE_UNAVAILABLE"
          : "ERREUR";
    console.warn(
      JSON.stringify({
        evt: "dashboard_echec",
        action: "charger-flux",
        workspaceId: session.activeWorkspaceId,
        code,
      }),
    );
    return {
      ok: false,
      code,
      message:
        code === "SERVICE_UNAVAILABLE"
          ? "Service momentanément indisponible."
          : code === "INVALID_PARAMS"
            ? "Paramètres invalides."
            : "L’opération a échoué. Réessayez.",
    };
  }
}

/** Détail d'un bucket cliqué (L4) : catégories + contreparties de dépenses, sur la
 * fenêtre du bucket INTERSECTÉE avec la fenêtre écran. La synthèse entrées/sorties/net,
 * elle, vient de la barre côté client (identité garantie avec le graphe). */
export interface DetailBucket {
  from: string;
  to: string;
  /** Répartition des SORTIES par catégorie (multi-devise ; le client filtre à sa devise). */
  categories: RepartitionCategories;
  /** Concentration des contreparties de SORTIES, BORNÉE à la devise affichée (top-N PAR
   * devise) — jamais un top-N global qui tronquerait la liste du drill en multi-devise. */
  contreparties: ConcentrationVendors;
}

/**
 * Détail d'un bucket au clic sur une barre (L4). Réutilise les lectures EXISTANTES
 * (`repartitionParCategorie`, `vendorsParConcentration`) sur la fenêtre du bucket
 * INTERSECTÉE avec la fenêtre écran — un bucket d'extrémité est PARTIEL, et le détail
 * doit couvrir exactement ce que la barre agrège. Aucun repo neuf → surface d'isolation
 * INCHANGÉE (les deux lectures sont déjà prouvées en isolation).
 *
 * Exit-criteria (règle 3) : authz `exigerSessionWorkspace` + `withWorkspace` (RLS tenant
 * + scope entité par jointure) ; zod strict (granularité fermée, bucket re-validé contre
 * sa granularité) ; fenêtre re-dérivée à Maurice (`resoudrePeriode`) ; retour normalisé ;
 * logs corrélés sans PII. UNE lecture par ouverture de panneau (pas de N+1).
 */
export async function detailBucketAction(
  input: unknown,
): Promise<ResultatAction<DetailBucket>> {
  const session = await exigerSessionWorkspace();
  const parsed = detailBucketParamsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: "Paramètres invalides." };
  }
  const { granularite, bucket, currency, periode, du, au } = parsed.data;
  const bornes = bornesBucket(granularite, bucket);
  const fenetre = resoudrePeriode({ periode, du, au });
  const from = bornes.from > fenetre.from ? bornes.from : fenetre.from;
  const to = bornes.to < fenetre.to ? bornes.to : fenetre.to;
  // Bucket hors fenêtre écran (défensif — le bucket cliqué vient de la série, donc
  // intersecte toujours) : rien à détailler, on ne lance aucun SQL.
  if (from > to) {
    return {
      ok: true,
      data: {
        from,
        to,
        categories: {
          sens: "outflow",
          from,
          to,
          fromPrecedent: "",
          toPrecedent: "",
          devises: [],
        },
        contreparties: { direction: "outflow", lignes: [] },
      },
    };
  }
  try {
    const data = await withWorkspace(session, async (tx) => {
      const categories = await repartitionParCategorie(tx, {
        sens: "outflow",
        from,
        to,
      });
      const contreparties = await vendorsParConcentration(tx, {
        direction: "outflow",
        topN: VENDORS_TOP_N_DEFAUT,
        from,
        to,
        // Top-N PAR devise : la liste du drill couvre exactement ce que la barre agrège
        // pour la devise affichée (sinon les gros postes d'une AUTRE devise l'évinceraient).
        currency,
      });
      return { from, to, categories, contreparties };
    });
    return { ok: true, data };
  } catch (erreur) {
    const code =
      erreur instanceof InsightsParamsInvalidesError
        ? "INVALID_PARAMS"
        : erreur instanceof ServiceIndisponibleError
          ? "SERVICE_UNAVAILABLE"
          : "ERREUR";
    console.warn(
      JSON.stringify({
        evt: "dashboard_echec",
        action: "detail-bucket",
        workspaceId: session.activeWorkspaceId,
        code,
      }),
    );
    return {
      ok: false,
      code,
      message:
        code === "SERVICE_UNAVAILABLE"
          ? "Service momentanément indisponible."
          : "L’opération a échoué. Réessayez.",
    };
  }
}
