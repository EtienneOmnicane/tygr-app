/**
 * Point d'entrée d'ingestion Omni-FI (PR 2). Surface livrée : persistance d'une
 * connexion/d'un compte, et synchronisation COMPLÈTE d'un compte connu
 * (transactions par PAGE + soldes EOD). Tout accès données passe par
 * `executer` = withWorkspace(session, fn) (règle 2) : le workspace_id vient du
 * contexte, jamais d'un paramètre. Pas de PII en log (règle 8).
 *
 * LIMITE DE PÉRIMÈTRE (dette, voir TODOS) : la DÉCOUVERTE des comptes d'une
 * connexion (connexion → liste de comptes) passe par l'endpoint widget/job
 * (`GET /sync/job/{JobId}/accounts`, SessionTokenAuth) hors de la surface lecture
 * ApiKey de la PR 1. Ce module synchronise donc des comptes DÉJÀ rattachés en
 * base ; le rattachement initial (création des bank_accounts depuis une
 * connexion) arrive avec le flux widget. Pour la démo sandbox, les comptes
 * pré-connectés sont rattachés en amont.
 */
import type { OmniFiClient, OmniFiConnection } from "@/server/omnifi";
import type { ExecuterWorkspace } from "@/server/db/tenancy";

import { normaliserMontant, normaliserNomInstitution } from "./conversion";
import { synchroniserCompte, type ResultatSync } from "./orchestrateur";
import {
  upsertConnexion,
  upsertSoldes,
  type SoldeAUpserter,
} from "@/server/repositories/ingestion";

/** Collecte toutes les pages de /connections (Q2 du client : suit Links.Next). */
export async function collecterConnexions(
  client: OmniFiClient,
  clientUserId: string,
): Promise<OmniFiConnection[]> {
  const out: OmniFiConnection[] = [];
  let page = 1;
  for (;;) {
    const env = await client.listerConnexions(clientUserId, { page });
    out.push(...env.Data.Connections);
    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || page >= totalPages) break;
    page += 1;
  }
  return out;
}

/** Persiste les connexions d'un EndUser dans le workspace courant. */
export async function ingererConnexions(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  clientUserId: string,
): Promise<{ connexions: number }> {
  const connexions = await collecterConnexions(client, clientUserId);
  for (const conn of connexions) {
    await executer((tx, ctx) =>
      upsertConnexion(tx, ctx, {
        omnifiConnectionId: conn.ConnectionId,
        institutionId: conn.InstitutionId,
        institutionName: normaliserNomInstitution(conn.InstitutionName),
        status: conn.Status,
        nextSyncAvailableAt: conn.NextSyncAvailableAt
          ? new Date(conn.NextSyncAvailableAt)
          : null,
      }),
    );
  }
  return { connexions: connexions.length };
}

/**
 * Synchronise UN compte déjà rattaché : transactions (par PAGE, suit Links.Next/
 * Meta.TotalPages) + soldes EOD (par page également). Composable depuis un cron/
 * route. Pas de curseur : chaque sync relit la liste complète (upsert idempotent).
 */
export async function synchroniserCompteComplet(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: {
    omnifiAccountId: string;
    bankAccountId: string;
    clientUserId: string;
    fenetreSoldes?: { fromStatementDateTime?: string; toStatementDateTime?: string };
    pageSize?: number;
    maintenant?: () => Date;
  },
): Promise<{ sync: ResultatSync; soldes: number }> {
  const sync = await synchroniserCompte(client, executer, params);

  const soldes: SoldeAUpserter[] = [];
  let page = 1;
  for (;;) {
    const env = await client.historiqueSoldes(params.omnifiAccountId, {
      ...params.fenetreSoldes,
      page,
    });
    for (const b of env.Data.HistoricalBalances) {
      soldes.push({
        balanceDate: b.Date,
        balance: normaliserMontant(b.Balance.Amount.Amount),
        currency: b.Balance.Amount.Currency,
      });
    }
    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || page >= totalPages) break;
    page += 1;
  }

  if (soldes.length > 0) {
    await executer((tx, ctx) =>
      upsertSoldes(tx, ctx, params.bankAccountId, soldes),
    );
  }

  return { sync, soldes: soldes.length };
}
