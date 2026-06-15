/**
 * Orchestrateur d'ingestion Omni-FI (PR 2) — boucle de synchronisation d'un
 * compte : appelle le client (PR 1), convertit (règle 8 / E20), persiste via les
 * repositories scopés (withWorkspace). Pur de toute I/O DB directe : il reçoit un
 * `executer` = withWorkspace lié à la session, et délègue la persistance.
 *
 * Résout deux dettes de la cross-review PR 1, là où elles mordent réellement :
 * - Q3 : `count` du sync borné [1, COUNT_MAX] avant tout appel réseau.
 * - Q4 : garde anti-boucle-infinie — on NE reboucle JAMAIS si l'amont renvoie
 *   HasMore=true avec un NextCursor vide/identique (sinon on re-demande la 1re
 *   page à l'infini en ré-ingérant les mêmes lignes).
 */
import type { OmniFiClient, OmniFiTransaction } from "@/server/omnifi";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";

import {
  deriverDateComptableMaurice,
  normaliserMontant,
  validerCreditDebit,
} from "./conversion";
import {
  avancerCurseur,
  upsertTransactions,
  type TransactionAUpserter,
} from "@/server/repositories/ingestion";

/** Borne dure du `count` de sync (doc Omni-FI § Transactions : max 500). */
export const COUNT_MAX = 500;
const COUNT_DEFAUT = 100;

/** Plafond de sécurité d'itérations — filet si l'amont ment sur HasMore. */
export const MAX_PAGES = 1000;

export class IngestionBoucleError extends Error {
  readonly code = "INGESTION_BOUCLE";
  constructor(message: string) {
    super(message);
    this.name = "IngestionBoucleError";
  }
}

/** `executer` = withWorkspace(session, fn) déjà lié — l'orchestrateur reste pur. */
type Executer = <T>(
  fn: (tx: WorkspaceTx<never>, ctx: WorkspaceContext) => Promise<T>,
) => Promise<T>;

/** Borne le count dans [1, COUNT_MAX] (Q3). */
export function bornerCount(count: number | undefined): number {
  if (count === undefined) return COUNT_DEFAUT;
  if (!Number.isInteger(count) || count < 1) return 1;
  return Math.min(count, COUNT_MAX);
}

/** Mappe une transaction OBIE → ligne à persister (conversions règle 8 / E20). */
export function versLignePersistee(t: OmniFiTransaction): TransactionAUpserter {
  return {
    omnifiTxnId: t.TransactionId,
    transactionDate: deriverDateComptableMaurice(t.BookingDateTime),
    bookingDateTime: new Date(t.BookingDateTime),
    amount: normaliserMontant(t.Amount.Amount),
    currency: t.Amount.Currency,
    creditDebit: validerCreditDebit(t.CreditDebitIndicator),
    bankLabelRaw: t.Description,
    cleanLabel: t.CleanMerchantName ?? null,
    primaryCategory: t.PrimaryCategory ?? null,
    subCategory: t.SubCategory ?? null,
    isRemoved: false,
  };
}

export interface ResultatSync {
  pages: number;
  transactionsTraitees: number;
  curseurFinal: string;
}

/**
 * Synchronise les transactions d'UN compte par curseur, jusqu'à épuisement.
 * Chaque page : appel client → conversion → upsert + avance curseur DANS une
 * même transaction withWorkspace (atomicité données/curseur). Reprend du curseur
 * fourni (incrémental) ou de zéro (historique complet) si `curseurInitial` vide.
 */
export async function synchroniserCompte(
  client: OmniFiClient,
  executer: Executer,
  params: {
    omnifiAccountId: string;
    bankAccountId: string;
    clientUserId: string;
    curseurInitial: string | null;
    count?: number;
    maintenant?: () => Date;
  },
): Promise<ResultatSync> {
  const count = bornerCount(params.count); // Q3
  const maintenant = params.maintenant ?? (() => new Date());
  let curseur = params.curseurInitial ?? undefined;
  let pages = 0;
  let total = 0;

  for (;;) {
    const page = await client.syncTransactions(
      params.omnifiAccountId,
      params.clientUserId,
      { cursor: curseur, count },
    );

    const aIngerer = [...page.Added, ...page.Modified];
    const lignes = aIngerer.map(versLignePersistee);

    // Persistance + avance du curseur dans UNE transaction scopée (pas de trou).
    await executer(async (tx, ctx) => {
      if (lignes.length > 0) {
        await upsertTransactions(tx, ctx, params.bankAccountId, lignes);
      }
      await avancerCurseur(tx, params.bankAccountId, page.NextCursor, maintenant());
    });

    total += lignes.length;
    pages += 1;

    if (!page.HasMore) {
      return { pages, transactionsTraitees: total, curseurFinal: page.NextCursor };
    }

    // Q4 — garde anti-boucle-infinie : HasMore=true mais le curseur n'avance pas
    // (vide ou identique au précédent) ⇒ on reboucle sur la même page à l'infini.
    if (!page.NextCursor || page.NextCursor === curseur) {
      throw new IngestionBoucleError(
        "HasMore=true mais NextCursor vide/inchangé — pagination amont incohérente, arrêt pour éviter une boucle infinie",
      );
    }
    if (pages >= MAX_PAGES) {
      throw new IngestionBoucleError(
        `MAX_PAGES (${MAX_PAGES}) atteint — arrêt de sécurité`,
      );
    }
    curseur = page.NextCursor;
  }
}
