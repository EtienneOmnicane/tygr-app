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
    TransactionInformation: "LOYER",
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

/**
 * executer factice : exécute le fn avec tx/ctx bidon, capture les appels DB.
 * `select()` renvoie une chaîne qui se résout en [] (thenable) — suffisant pour
 * que appliquerRegles (appelé en best-effort post-sync) trouve « aucune règle »
 * et court-circuite proprement à {0,0}, sans dépendre d'une vraie DB. La logique
 * RÉELLE du moteur de règles est prouvée par tests/isolation/regles-categorisation.
 */
function executerFactice() {
  const upserts: unknown[] = [];
  // Builder de SELECT minimal : chaque maillon renvoie l'objet lui-même, et
  // l'objet est thenable (résout []) pour les `await tx.select()...` d'appliquerRegles.
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => selectChain,
    for: () => selectChain,
    then: (resolve: (v: unknown[]) => unknown) => resolve([]),
  };
  const tx = {
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {},
      }),
    }),
    select: () => selectChain,
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

  // Le libellé brut vient de TransactionInformation (nom OBIE officiel), PAS de
  // Description (champ inexistant dans le contrat HTTP public — bug confirmé runtime
  // + audit serializer Omni-FI : lire t.Description mettait bank_label_raw NULL partout).
  it("TransactionInformation présent → bankLabelRaw mappé (libellé brut OBIE)", () => {
    const l = versLignePersistee(
      txOBIE({ TransactionInformation: "DBIT / POS / BLUEMARBLE SUPERMARKET QBNS" }),
    );
    expect(l.bankLabelRaw).toBe("DBIT / POS / BLUEMARBLE SUPERMARKET QBNS");
  });

  it("TransactionInformation absent/vide → bankLabelRaw null (normalisé, pas de chaîne vide)", () => {
    expect(versLignePersistee(txOBIE({ TransactionInformation: undefined })).bankLabelRaw).toBeNull();
    expect(versLignePersistee(txOBIE({ TransactionInformation: "   " })).bankLabelRaw).toBeNull();
  });

  it("montant à 4 décimales NULLES (format API) → numeric(15,2) sans perte", () => {
    const l = versLignePersistee(txOBIE({ Amount: { Amount: "750.0000", Currency: "MUR" } }));
    expect(l.amount).toBe("750.00");
  });

  // PROD-MERCHANT1 — l'enrichissement est IMBRIQUÉ sous Enrichment{} (serializer
  // Django faisant foi), PAS à plat. Le mapping doit hydrater depuis t.Enrichment,
  // et NORMALISER la chaîne vide "" (défaut serializer) vers null — sinon clean_label
  // vide → libellé blanc à l'écran (pire que le fallback).
  it("Enrichment plein → cleanLabel / primaryCategory / subCategory hydratés", () => {
    const l = versLignePersistee(
      txOBIE({
        Enrichment: {
          CleanMerchantName: "Shell",
          PrimaryCategory: "Transport",
          SubCategory: "Fuel",
          ConfidenceLevel: "Very High",
          ClassificationSource: "USER_RULE",
          RuleIdMatch: "rule_77382",
        },
      }),
    );
    expect(l.cleanLabel).toBe("Shell");
    expect(l.primaryCategory).toBe("Transport");
    expect(l.subCategory).toBe("Fuel");
  });

  it("PIÈGE : CleanMerchantName \"\" (défaut serializer) → cleanLabel null, pas chaîne vide", () => {
    const l = versLignePersistee(
      txOBIE({
        Enrichment: {
          CleanMerchantName: "",
          PrimaryCategory: "",
          SubCategory: "   ", // espaces seuls = vide aussi
          ConfidenceLevel: "Low",
          ClassificationSource: "",
          RuleIdMatch: "",
        },
      }),
    );
    expect(l.cleanLabel).toBeNull();
    expect(l.primaryCategory).toBeNull();
    expect(l.subCategory).toBeNull();
  });

  it("Enrichment absent (payload ancien) → cleanLabel / primaryCategory / subCategory null, sans crash", () => {
    const l = versLignePersistee(txOBIE({ Enrichment: undefined }));
    expect(l.cleanLabel).toBeNull();
    expect(l.primaryCategory).toBeNull();
    expect(l.subCategory).toBeNull();
  });

  // Choix documenté : le défaut serializer "Uncategorized" est une étiquette amont
  // assumée (string non vide) → on la laisse passer telle quelle ; seules les VRAIES
  // absences ("") deviennent null.
  it("PrimaryCategory \"Uncategorized\" (défaut serializer) → conservé tel quel", () => {
    const l = versLignePersistee(
      txOBIE({ Enrichment: { PrimaryCategory: "Uncategorized" } }),
    );
    expect(l.primaryCategory).toBe("Uncategorized");
    expect(l.cleanLabel).toBeNull(); // CleanMerchantName absent du bloc → null
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
    // Aucun upsert de transactions (lignes vides), mais DEUX appels executer en
    // fin de parcours : (1) marquerSynchronise, (2) appliquerRegles post-sync
    // (best-effort ; aucune règle dans le mock → no-op {0,0}).
    expect(upserts.length).toBe(2);
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
