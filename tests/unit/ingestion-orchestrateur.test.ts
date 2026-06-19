/**
 * Orchestrateur d'ingestion — pagination par PAGE (pageSize borné, garde MAX_PAGES,
 * arrêt sur Links.Next/Meta.TotalPages), mapping. Client Omni-FI factice (aucun
 * réseau), `executer` factice qui capture les appels sans vraie DB.
 */
import { describe, expect, it, vi } from "vitest";

import type { OmniFiClient, OmniFiTransaction } from "@/server/omnifi";
import {
  bornerPageSize,
  IngestionBoucleError,
  MAX_PAGES,
  PAGE_SIZE_MAX,
  synchroniserCompte,
  versLignePersistee,
} from "@/server/ingestion/orchestrateur";

function txOBIE(over: Partial<OmniFiTransaction> = {}): OmniFiTransaction {
  return {
    TransactionId: "tx-1",
    AccountId: "acc-1",
    Description: "LOYER",
    Amount: { Amount: "1500.00", Currency: "MUR" },
    CreditDebitIndicator: "Debit",
    Status: "Booked",
    BookingDateTime: "2026-06-10T05:30:00Z",
    ...over,
  };
}

/** Enveloppe OBIE { Data: { Transaction }, Links, Meta } pour une page de transactions. */
function pageTx(
  transactions: OmniFiTransaction[],
  opts: { next?: string | null; totalPages?: number } = {},
) {
  return {
    Data: { Transaction: transactions },
    Links: { Next: opts.next ?? null },
    Meta: { TotalPages: opts.totalPages ?? 1 },
  };
}

/** executer factice : exécute le fn avec tx/ctx bidon, capture les appels DB. */
function executerFactice() {
  const upserts: unknown[] = [];
  const tx = {
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {},
      }),
    }),
  };
  const ctx = { workspaceId: "ws-1", userId: "u-1", role: "ADMIN" as const };
  const executer = async <T>(fn: (t: never, c: never) => Promise<T>) => {
    upserts.push("exec");
    return fn(tx as never, ctx as never);
  };
  return { executer, upserts };
}

describe("bornerPageSize", () => {
  it("défaut sans valeur, plafonne à PAGE_SIZE_MAX, plancher à 1", () => {
    expect(bornerPageSize(undefined)).toBe(100);
    expect(bornerPageSize(50)).toBe(50);
    expect(bornerPageSize(99999)).toBe(PAGE_SIZE_MAX);
    expect(bornerPageSize(0)).toBe(1);
    expect(bornerPageSize(-5)).toBe(1);
    expect(bornerPageSize(1.5)).toBe(1);
  });
});

describe("versLignePersistee — mapping + conversions", () => {
  it("dérive date Maurice, normalise montant, conserve le sens", () => {
    const l = versLignePersistee(
      txOBIE({ BookingDateTime: "2026-06-10T22:00:00Z", Amount: { Amount: "1500", Currency: "MUR" } }),
    );
    expect(l.transactionDate).toBe("2026-06-11"); // 22h UTC → lendemain Maurice
    expect(l.amount).toBe("1500.00");
    expect(l.creditDebit).toBe("Debit");
    expect(l.isRemoved).toBe(false);
  });
});

describe("synchroniserCompte — pagination par page", () => {
  it("parcourt plusieurs pages en suivant Links.Next jusqu'à la dernière", async () => {
    const client = {
      listerTransactionsPage: vi
        .fn()
        .mockResolvedValueOnce(pageTx([txOBIE({ TransactionId: "a" })], { next: "url2", totalPages: 2 }))
        .mockResolvedValueOnce(pageTx([txOBIE({ TransactionId: "b" })], { next: null, totalPages: 2 })),
    } as unknown as OmniFiClient;
    const { executer } = executerFactice();

    const r = await synchroniserCompte(client, executer, {
      omnifiAccountId: "acc-1",
      bankAccountId: "ba-1",
      clientUserId: "cu-1",
    });

    expect(r.pages).toBe(2);
    expect(r.transactionsTraitees).toBe(2);
    const mock = client.listerTransactionsPage as ReturnType<typeof vi.fn>;
    // pageSize borné transmis ; pages 1 puis 2.
    expect(mock.mock.calls[0][2].pageSize).toBe(100);
    expect(mock.mock.calls[0][2].page).toBe(1);
    expect(mock.mock.calls[1][2].page).toBe(2);
  });

  it("s'arrête dès qu'il n'y a pas de Links.Next (page unique)", async () => {
    const client = {
      listerTransactionsPage: vi
        .fn()
        .mockResolvedValue(pageTx([txOBIE()], { next: null, totalPages: 1 })),
    } as unknown as OmniFiClient;
    const { executer } = executerFactice();

    const r = await synchroniserCompte(client, executer, {
      omnifiAccountId: "acc-1",
      bankAccountId: "ba-1",
      clientUserId: "cu-1",
    });

    expect(r.pages).toBe(1);
    expect(r.transactionsTraitees).toBe(1);
    expect((client.listerTransactionsPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("page vide → 0 transaction, pas d'erreur, marque quand même la synchro", async () => {
    const client = {
      listerTransactionsPage: vi.fn().mockResolvedValue(pageTx([], { next: null, totalPages: 1 })),
    } as unknown as OmniFiClient;
    const { executer, upserts } = executerFactice();

    const r = await synchroniserCompte(client, executer, {
      omnifiAccountId: "acc-1",
      bankAccountId: "ba-1",
      clientUserId: "cu-1",
    });

    expect(r.transactionsTraitees).toBe(0);
    // Aucun upsert de transactions (lignes vides), mais marquerSynchronise est appelé.
    expect(upserts.length).toBe(1);
  });

  it("MAX_PAGES — l'amont prétend qu'il reste des pages au-delà du plafond → IngestionBoucleError", async () => {
    // Links.Next toujours présent ET TotalPages très grand → sans garde, boucle infinie.
    const client = {
      listerTransactionsPage: vi
        .fn()
        .mockResolvedValue(pageTx([txOBIE()], { next: "toujours-plus", totalPages: MAX_PAGES + 5 })),
    } as unknown as OmniFiClient;
    const { executer } = executerFactice();

    await expect(
      synchroniserCompte(client, executer, {
        omnifiAccountId: "acc-1",
        bankAccountId: "ba-1",
        clientUserId: "cu-1",
      }),
    ).rejects.toBeInstanceOf(IngestionBoucleError);
  });
});
