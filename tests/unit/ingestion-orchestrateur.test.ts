/**
 * Orchestrateur d'ingestion — Q3 (count borné), Q4 (garde anti-boucle), boucle
 * de curseur, mapping. Client Omni-FI factice (aucun réseau), `executer` factice
 * qui capture les upserts sans vraie DB.
 */
import { describe, expect, it, vi } from "vitest";

import type { OmniFiClient, OmniFiTransaction } from "@/server/omnifi";
import {
  bornerCount,
  COUNT_MAX,
  IngestionBoucleError,
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

describe("Q3 — bornerCount", () => {
  it("défaut sans valeur, plafonne à COUNT_MAX, plancher à 1", () => {
    expect(bornerCount(undefined)).toBe(100);
    expect(bornerCount(50)).toBe(50);
    expect(bornerCount(99999)).toBe(COUNT_MAX);
    expect(bornerCount(0)).toBe(1);
    expect(bornerCount(-5)).toBe(1);
    expect(bornerCount(1.5)).toBe(1);
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

describe("synchroniserCompte — boucle de curseur", () => {
  it("parcourt plusieurs pages jusqu'à HasMore=false", async () => {
    const client = {
      syncTransactions: vi
        .fn()
        .mockResolvedValueOnce({
          Added: [txOBIE({ TransactionId: "a" })],
          Modified: [],
          Removed: [],
          NextCursor: "c1",
          HasMore: true,
        })
        .mockResolvedValueOnce({
          Added: [txOBIE({ TransactionId: "b" })],
          Modified: [],
          Removed: [],
          NextCursor: "c2",
          HasMore: false,
        }),
    } as unknown as OmniFiClient;
    const { executer } = executerFactice();

    const r = await synchroniserCompte(client, executer, {
      omnifiAccountId: "acc-1",
      bankAccountId: "ba-1",
      clientUserId: "cu-1",
      curseurInitial: null,
    });

    expect(r.pages).toBe(2);
    expect(r.transactionsTraitees).toBe(2);
    expect(r.curseurFinal).toBe("c2");
    // count borné transmis au client
    expect((client.syncTransactions as ReturnType<typeof vi.fn>).mock.calls[0][2].count).toBe(100);
  });

  it("Q4 — HasMore=true + NextCursor vide → IngestionBoucleError (pas de boucle infinie)", async () => {
    const client = {
      syncTransactions: vi.fn().mockResolvedValue({
        Added: [],
        Modified: [],
        Removed: [],
        NextCursor: "",
        HasMore: true,
      }),
    } as unknown as OmniFiClient;
    const { executer } = executerFactice();

    await expect(
      synchroniserCompte(client, executer, {
        omnifiAccountId: "acc-1",
        bankAccountId: "ba-1",
        clientUserId: "cu-1",
        curseurInitial: null,
      }),
    ).rejects.toBeInstanceOf(IngestionBoucleError);
  });

  it("Q4 — HasMore=true + NextCursor identique au précédent → IngestionBoucleError", async () => {
    const client = {
      syncTransactions: vi.fn().mockResolvedValue({
        Added: [],
        Modified: [],
        Removed: [],
        NextCursor: "meme-curseur",
        HasMore: true,
      }),
    } as unknown as OmniFiClient;
    const { executer } = executerFactice();

    await expect(
      synchroniserCompte(client, executer, {
        omnifiAccountId: "acc-1",
        bankAccountId: "ba-1",
        clientUserId: "cu-1",
        curseurInitial: "meme-curseur",
      }),
    ).rejects.toBeInstanceOf(IngestionBoucleError);
  });
});
