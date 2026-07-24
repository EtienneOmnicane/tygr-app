/**
 * Orchestrateur d'ingestion Omni-FI (PR 2) — boucle de synchronisation d'un
 * compte : appelle le client (PR 1), convertit (règle 8 / E20), persiste via les
 * repositories scopés (withWorkspace). Pur de toute I/O DB directe : il reçoit un
 * `executer` = withWorkspace lié à la session, et délègue la persistance.
 *
 * Modèle = pagination par PAGE (contrat réel déployé, aligné OBIE ; confirmé
 * Omni-FI 2026-06-19) : on relit la liste complète des transactions du compte,
 * page après page, en suivant `Links.Next` / `Meta.TotalPages`. L'ancien modèle
 * par curseur (`/transactions/sync`, delta Added/Modified/Removed) est une
 * extension future NON déployée (cf. OMNIFI_API_FEEDBACK.md §10) ; on ne s'y fige
 * pas. Pas de delta incrémental : l'`upsert` idempotent (clé `omnifi_account_id`
 * UNIQUE) absorbe les doublons d'un re-téléchargement complet.
 *
 * Gardes conservées :
 * - `bornerPageSize` : `pageSize` borné [1, PAGE_SIZE_MAX] avant tout appel réseau.
 * - `MAX_PAGES` : filet anti-boucle-infinie si l'amont ment sur `Links.Next` /
 *   `Meta.TotalPages` (jamais de boucle non bornée).
 */
import type { OmniFiClient, OmniFiTransaction } from "@/server/omnifi";
import type { ExecuterWorkspace } from "@/server/db/tenancy";
import { categorieAutoValide } from "@/lib/categorie-obie-vide.mjs";

import {
  deriverDateComptableMaurice,
  normaliserMontant,
  normaliserSoldeCourant,
  validerCreditDebit,
} from "./conversion";
import {
  deriverSoldesEod,
  marquerSynchronise,
  upsertTransactions,
  type TransactionAUpserter,
} from "@/server/repositories/ingestion";
import { appliquerRegles } from "@/server/repositories/regles-categorisation";

/** Borne dure du `pageSize` (défaut amont = 20 ; on plafonne pour ne pas demander
 *  des pages déraisonnables). */
export const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAUT = 100;

/** Plafond de sécurité d'itérations — filet si l'amont ment sur Links.Next/TotalPages. */
export const MAX_PAGES = 1000;

export class IngestionBoucleError extends Error {
  readonly code = "INGESTION_BOUCLE";
  constructor(message: string) {
    super(message);
    this.name = "IngestionBoucleError";
  }
}

/** Borne le pageSize dans [1, PAGE_SIZE_MAX]. */
export function bornerPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return PAGE_SIZE_DEFAUT;
  if (!Number.isInteger(pageSize) || pageSize < 1) return 1;
  return Math.min(pageSize, PAGE_SIZE_MAX);
}

/**
 * Normalise une chaîne d'enrichissement vers `string | null`. Le serializer amont
 * (`get_Enrichment`) renvoie une CHAÎNE VIDE ("") — pas `null` — quand la donnée
 * manque. Sans cette normalisation, `"" ?? null` vaut `""` : on persisterait un
 * `clean_label` vide, le fallback Front (« Opération bancaire ») ne se déclencherait
 * PAS et on afficherait un libellé blanc — pire que le bug initial (PROD-MERCHANT1).
 * Les espaces seuls sont aussi traités comme vides.
 */
function chaineOuNull(s: string | undefined | null): string | null {
  const v = s?.trim();
  return v ? v : null;
}

/**
 * Prédicat « catégorie OBIE exploitable » — RÉ-EXPORT de la source unique
 * `src/lib/categorie-obie-vide.mjs` (liste fermée des sentinelles amont + doctrine).
 *
 * Il vivait ICI, en dur, pendant que `scripts/backfill-auto-categorized.mjs` en tenait
 * une seconde copie recopiée à la main en SQL. Les deux ont divergé dès #243 (ajout de
 * "unclassified" côté TS seulement). Le prédicat est désormais défini UNE fois et
 * dérivé en SQL depuis la même constante — ne pas le redéfinir ici (règle 9).
 *
 * Ré-exporté pour ne casser aucun import existant (`tests/unit/ingestion-orchestrateur`
 * l'importe d'ici, et c'est le point d'entrée naturel pour lire l'ingestion).
 */
export { categorieAutoValide };

/**
 * Solde courant à persister (`running_balance`) : GARDE DE DEVISE d'INGESTION (§2.4) +
 * normalisation NON-levante (§5.4). Fonction pure. Le `RunningBalance` amont porte la
 * devise de la TRANSACTION (`serializers.py` : `Currency = obj.currency`). On n'accepte
 * le solde QUE si sa devise égale celle du montant (`t.Amount.Currency` = la colonne
 * `currency` de la ligne) : le solde stocké est ainsi TOUJOURS cohérent avec la devise de
 * SA PROPRE ligne — jamais un solde d'une autre devise taggé sous celle-ci (règle 8).
 * Sinon NULLIFIÉ (fail-closed).
 *
 * ⚠️ Cette garde d'ingestion N'EXCLUT PAS à elle seule un solde FX de la série d'un compte
 * d'une AUTRE devise (Amount USD sur un compte MUR ⇒ ligne `currency=USD`, cohérente) :
 * l'exclusion de la série MUR est la GARDE D'ÉLECTION (§2.2, `currency = D_c` = devise du
 * COMPTE), HORS périmètre de ce lot. `courbeTresorerie` (déjà corrigée) sépare déjà par
 * devise, donc aucune addition cross-devise n'est possible en aval quoi qu'il arrive.
 *
 * Absent / forme inattendue / >2 décimales significatives ⇒ null aussi (jamais un throw :
 * ne pas faire perdre la page de transactions).
 */
function deriverSoldeCourant(t: OmniFiTransaction): string | null {
  const rb = t.RunningBalance;
  if (rb == null || rb.Currency !== t.Amount.Currency) return null;
  return normaliserSoldeCourant(rb.Amount);
}

/** Mappe une transaction OBIE → ligne à persister (conversions règle 8 / E20). */
export function versLignePersistee(t: OmniFiTransaction): TransactionAUpserter {
  // L'enrichissement est IMBRIQUÉ sous `Enrichment{}` (serializer Django faisant foi),
  // PAS à plat — lire à plat valait `undefined` → fallback partout (PROD-MERCHANT1).
  // `t.Enrichment?.` couvre aussi le cas où l'objet entier manque (payload ancien).
  const e = t.Enrichment;
  // Provenance auto : la pré-catégorisation OBIE n'est retenue QUE si elle est
  // exploitable. Sinon on retombe sur le comportement actuel (catégorie nulle, pas
  // de marqueur) — « ne corrompt pas la donnée ». Calculé une fois : pilote à la
  // fois primary_category, is_auto_categorized et category_source (cohérence
  // garantie aussi par le CHECK transactions_cache_auto_source_coherence).
  const categorieValide = categorieAutoValide(e?.PrimaryCategory);
  return {
    omnifiTxnId: t.TransactionId,
    transactionDate: deriverDateComptableMaurice(t.BookingDateTime),
    bookingDateTime: new Date(t.BookingDateTime),
    amount: normaliserMontant(t.Amount.Amount),
    currency: t.Amount.Currency,
    creditDebit: validerCreditDebit(t.CreditDebitIndicator),
    // Solde EOD (PROD-TRESO-EOD1) : garde de devise + normalisation non-levante.
    runningBalance: deriverSoldeCourant(t),
    // Libellé brut = `TransactionInformation` (nom OBIE officiel du narratif). Le code
    // lisait `t.Description`, champ INEXISTANT dans le contrat HTTP public → bank_label_raw
    // était NULL sur 100 % des transactions (bug confirmé runtime + audit serializer
    // Omni-FI). `chaineOuNull` normalise une chaîne vide en null propre.
    bankLabelRaw: chaineOuNull(t.TransactionInformation),
    cleanLabel: chaineOuNull(e?.CleanMerchantName),
    // PrimaryCategory : persistée UNIQUEMENT si exploitable. "Uncategorized" et les
    // chaînes vides deviennent NULL (auparavant "Uncategorized" survivait tel quel et
    // polluait la base — 96 % des tx ; cf. categories-fr.ts). Reste une étiquette OBIE
    // brute (anglais, langue pivot), pas une vraie catégorie TYGR : la catégorisation
    // réelle est portée par les splits / le moteur de règles.
    primaryCategory: categorieValide ? chaineOuNull(e?.PrimaryCategory) : null,
    subCategory: chaineOuNull(e?.SubCategory),
    // Métadonnées de classification AMONT (TECH-API-TRACE) — on TRACE fidèlement la valeur
    // reçue, INDÉPENDAMMENT de categorieValide : ces champs peuvent décrire une classification
    // amont ayant abouti à "Uncategorized" (utile pour la future file de revue). `Low`
    // (défaut serializer de ConfidenceLevel) est CONSERVÉ — neutraliser un score bas est une
    // décision de couche UI (GAP-CATEG-NATIVE1), pas de la trace. `chaineOuNull` : "" → null.
    confidenceLevel: chaineOuNull(e?.ConfidenceLevel),
    classificationSource: chaineOuNull(e?.ClassificationSource),
    ruleIdMatch: chaineOuNull(e?.RuleIdMatch),
    // Marqueur de provenance : posé SSI la catégorie OBIE est exploitable. La paire
    // (is_auto_categorized, category_source) est toujours cohérente (cf. CHECK).
    isAutoCategorized: categorieValide,
    categorySource: categorieValide ? "OMNIFI" : null,
    isRemoved: false,
  };
}

export interface ResultatSync {
  pages: number;
  transactionsTraitees: number;
}

/**
 * Synchronise les transactions d'UN compte par PAGE, jusqu'à épuisement. Chaque
 * page : appel client → conversion → upsert dans une transaction withWorkspace.
 * On relit toujours depuis la page 1 (pas de delta côté API) ; `lastSyncedAt` est
 * marqué en fin de parcours.
 */
export async function synchroniserCompte(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: {
    omnifiAccountId: string;
    bankAccountId: string;
    clientUserId: string;
    pageSize?: number;
    maintenant?: () => Date;
  },
): Promise<ResultatSync> {
  const pageSize = bornerPageSize(params.pageSize);
  const maintenant = params.maintenant ?? (() => new Date());
  let page = 1;
  let total = 0;

  for (;;) {
    const env = await client.listerTransactionsPage(
      params.omnifiAccountId,
      params.clientUserId,
      { page, pageSize },
    );

    const lignes = env.Data.Transaction.map(versLignePersistee);
    if (lignes.length > 0) {
      await executer((tx, ctx) =>
        upsertTransactions(tx, ctx, params.bankAccountId, lignes),
      );
    }
    total += lignes.length;

    const totalPages = env.Meta?.TotalPages ?? 1;
    // Fin : plus de lien suivant OU on a atteint la dernière page annoncée.
    if (!env.Links?.Next || page >= totalPages) break;

    // Filet anti-boucle-infinie : l'amont prétend qu'il reste des pages au-delà du
    // plafond → on s'arrête plutôt que d'itérer sans borne (Links.Next peut mentir).
    if (page >= MAX_PAGES) {
      throw new IngestionBoucleError(
        `MAX_PAGES (${MAX_PAGES}) atteint — arrêt de sécurité (pagination amont incohérente)`,
      );
    }
    page += 1;
  }

  // Trace de dernière synchro (sans curseur : le modèle par page repart de 1).
  await executer((tx) =>
    marquerSynchronise(tx, params.bankAccountId, maintenant()),
  );

  // Élection EOD BEST-EFFORT (TRESO-EOD-ELECTION, §2.2) : dérive les soldes de
  // clôture depuis running_balance UNE FOIS toutes les pages persistées (l'élection
  // lit la BASE, pas le flux — indépendante de l'ordre d'arrivée des pages).
  // Isolée dans un try/catch, exactement comme appliquerRegles ci-dessous : une
  // dérivation bancale ne doit JAMAIS faire perdre des transactions déjà
  // persistées (critère §6 du plan — seul catch large admis, journalisé sans PII).
  try {
    await executer((tx, ctx) =>
      deriverSoldesEod(tx, ctx, params.bankAccountId),
    );
  } catch {
    console.warn(
      JSON.stringify({
        evt: "eod_derivation_echec",
        action: "deriver-soldes-post-sync",
        bankAccountId: params.bankAccountId,
      }),
    );
  }

  // Catégorisation automatique BEST-EFFORT des transactions nouvellement
  // ingérées : on applique les règles ACTIVES aux transactions de CE compte qui
  // n'ont encore aucun split (MANUAL prime, jamais écrasé). Idempotent. Tourne en
  // Vision Globale (chemin ingestion, GUC entité vide) ; appliquerRegles JOINT
  // bank_accounts donc le scope serait honoré le cas échéant.
  // Isolé dans un try/catch : la synchro des transactions est l'essentiel ; une
  // règle bancale ne doit pas faire perdre des transactions déjà persistées.
  // L'utilisateur peut relancer « Ré-analyser » (appliquerReglesAction). On logue
  // le code sans PII (jamais le motif ni un libellé).
  try {
    await executer((tx, ctx) =>
      appliquerRegles(tx, ctx, { bankAccountId: params.bankAccountId }),
    );
  } catch {
    console.warn(
      JSON.stringify({
        evt: "regles_auto_echec",
        action: "appliquer-regles-post-sync",
        bankAccountId: params.bankAccountId,
      }),
    );
  }

  return { pages: page, transactionsTraitees: total };
}
