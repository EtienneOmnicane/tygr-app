/**
 * Orchestrateur d'ingestion — pagination par PAGE (pageSize borné, garde MAX_PAGES,
 * arrêt sur Links.Next/Meta.TotalPages), mapping. Client Omni-FI factice (aucun
 * réseau), `executer` factice qui capture les appels sans vraie DB.
 */
import { describe, expect, it, vi } from "vitest";

import type { OmniFiClient, OmniFiTransaction } from "@/server/omnifi";
import {
  bornerPageSize,
  categorieAutoValide,
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

  // PROD-TRESO-EOD1 — running_balance : garde de devise (§2.4) + normalisation NON-levante.
  it("RunningBalance même devise → running_balance persisté (négatif possible)", () => {
    expect(
      versLignePersistee(
        txOBIE({ RunningBalance: { Amount: "50000.00", Currency: "MUR" } }),
      ).runningBalance,
    ).toBe("50000.00");
    expect(
      versLignePersistee(
        txOBIE({ RunningBalance: { Amount: "-1234.50", Currency: "MUR" } }),
      ).runningBalance,
    ).toBe("-1234.50");
  });

  it("RunningBalance d'une AUTRE devise (opération FX) → null (garde cross-devise §2.4)", () => {
    // Compte MUR, solde amont en USD : l'écrire dans la série MUR serait une addition
    // cross-devise déguisée. On nullifie (fail-closed).
    const l = versLignePersistee(
      txOBIE({
        Amount: { Amount: "1500.00", Currency: "MUR" },
        RunningBalance: { Amount: "50.00", Currency: "USD" },
      }),
    );
    expect(l.runningBalance).toBeNull();
  });

  it("RunningBalance absent → null", () => {
    expect(versLignePersistee(txOBIE()).runningBalance).toBeNull();
    expect(
      versLignePersistee(txOBIE({ RunningBalance: null })).runningBalance,
    ).toBeNull();
  });

  it("RunningBalance à >2 décimales significatives → null SANS faire perdre la transaction", () => {
    const l = versLignePersistee(
      txOBIE({ RunningBalance: { Amount: "50.1234", Currency: "MUR" } }),
    );
    expect(l.runningBalance).toBeNull(); // non-levant
    expect(l.amount).toBe("1500.00"); // la transaction est intacte (pas de throw)
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
    // Catégorie OBIE exploitable → marqueur de provenance posé, paire cohérente.
    expect(l.isAutoCategorized).toBe(true);
    expect(l.categorySource).toBe("OMNIFI");
    // TECH-API-TRACE : les 3 métadonnées de classification amont sont TRACÉES fidèlement.
    expect(l.confidenceLevel).toBe("Very High");
    expect(l.classificationSource).toBe("USER_RULE");
    expect(l.ruleIdMatch).toBe("rule_77382");
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
    // Catégorie vide → AUCUNE provenance auto (marqueur false / source null).
    expect(l.isAutoCategorized).toBe(false);
    expect(l.categorySource).toBeNull();
    // TECH-API-TRACE : ClassificationSource/RuleIdMatch "" → null (chaineOuNull).
    expect(l.classificationSource).toBeNull();
    expect(l.ruleIdMatch).toBeNull();
    // DÉCISION §3.2 : ConfidenceLevel "Low" (défaut serializer) est CONSERVÉ tel quel —
    // la trace est fidèle à la source, neutraliser un score bas relève de la couche UI
    // (GAP-CATEG-NATIVE1), pas de l'ingestion. Et il est tracé même quand la catégo est
    // vide (les métadonnées sont INDÉPENDANTES de categorieValide).
    expect(l.confidenceLevel).toBe("Low");
  });

  it("Enrichment absent (payload ancien) → cleanLabel / primaryCategory / subCategory null + pas de marqueur, sans crash", () => {
    const l = versLignePersistee(txOBIE({ Enrichment: undefined }));
    expect(l.cleanLabel).toBeNull();
    expect(l.primaryCategory).toBeNull();
    expect(l.subCategory).toBeNull();
    expect(l.isAutoCategorized).toBe(false);
    expect(l.categorySource).toBeNull();
    // TECH-API-TRACE : objet Enrichment absent → les 3 métadonnées null (via e?.), sans crash.
    expect(l.confidenceLevel).toBeNull();
    expect(l.classificationSource).toBeNull();
    expect(l.ruleIdMatch).toBeNull();
  });

  // DÉCISION ACTÉE (PO 2026-06-23, ce chantier) : le défaut serializer "Uncategorized"
  // est traité comme une ABSENCE de catégorie — primary_category nullifiée (base
  // rigoureuse, pas de chaîne polluée dans les rapports) et AUCUN marqueur de
  // provenance. Remplace l'ancien comportement « conservé tel quel ».
  it("PrimaryCategory \"Uncategorized\" → nullifiée + aucune provenance auto", () => {
    const l = versLignePersistee(
      txOBIE({ Enrichment: { PrimaryCategory: "Uncategorized" } }),
    );
    expect(l.primaryCategory).toBeNull();
    expect(l.isAutoCategorized).toBe(false);
    expect(l.categorySource).toBeNull();
  });

  it("PrimaryCategory \"uncategorized\" (casse différente) → traitée comme absence", () => {
    const l = versLignePersistee(
      txOBIE({ Enrichment: { PrimaryCategory: "  UNCATEGORIZED  " } }),
    );
    expect(l.primaryCategory).toBeNull();
    expect(l.isAutoCategorized).toBe(false);
    expect(l.categorySource).toBeNull();
  });

  // La valeur RÉELLEMENT émise par l'amont aujourd'hui (inventaire base 2026-07-21),
  // en SCREAMING_SNAKE — graphie différente de la "Uncategorized" documentée. Non
  // neutralisée, elle posait isAutoCategorized=true + categorySource="OMNIFI" sur ~93 %
  // des transactions : la base prétendait « classé par l'amont » là où l'amont disait
  // précisément l'inverse. On teste la casse OBSERVÉE, pas celle de la fixture.
  it("PrimaryCategory \"UNCLASSIFIED\" (valeur réelle amont) → nullifiée + aucune provenance auto", () => {
    const l = versLignePersistee(
      txOBIE({ Enrichment: { PrimaryCategory: "UNCLASSIFIED" } }),
    );
    expect(l.primaryCategory).toBeNull();
    expect(l.isAutoCategorized).toBe(false);
    // Cohérence exigée par le CHECK transactions_cache_auto_source_coherence :
    // is_auto_categorized=false ⇒ category_source IS NULL.
    expect(l.categorySource).toBeNull();
  });

  it("PrimaryCategory valide → marqueur OMNIFI même si CleanMerchantName absent", () => {
    const l = versLignePersistee(
      txOBIE({ Enrichment: { PrimaryCategory: "Income" } }),
    );
    expect(l.primaryCategory).toBe("Income");
    expect(l.isAutoCategorized).toBe(true);
    expect(l.categorySource).toBe("OMNIFI");
  });

  // TECH-API-TRACE §3.3 — les métadonnées de classification sont INDÉPENDANTES de la
  // validité de la catégorie : une classification amont peut avoir abouti à
  // "Uncategorized" (donc catégo nullifiée, AUCUN marqueur) tout en portant un score /
  // une source significatifs — info précieuse pour la future file de revue. On NE doit
  // donc PAS conditionner la trace à categorieValide.
  it("Uncategorized mais métadonnées présentes → catégo nullifiée SANS marqueur, métadonnées TRACÉES", () => {
    const l = versLignePersistee(
      txOBIE({
        Enrichment: {
          PrimaryCategory: "Uncategorized",
          ConfidenceLevel: "Medium",
          ClassificationSource: "ML",
          RuleIdMatch: "",
        },
      }),
    );
    // Catégorie absente → pas de provenance auto (comportement 0011 inchangé).
    expect(l.primaryCategory).toBeNull();
    expect(l.isAutoCategorized).toBe(false);
    expect(l.categorySource).toBeNull();
    // Métadonnées tracées malgré tout (indépendance prouvée).
    expect(l.confidenceLevel).toBe("Medium");
    expect(l.classificationSource).toBe("ML");
    expect(l.ruleIdMatch).toBeNull(); // "" → null
  });
});

// Fonction pure pilotant la provenance auto ET la nullification de primary_category.
describe("categorieAutoValide", () => {
  it("catégorie exploitable → true", () => {
    expect(categorieAutoValide("Income")).toBe(true);
    expect(categorieAutoValide("business expenses")).toBe(true);
    expect(categorieAutoValide("  Transport  ")).toBe(true);
  });

  it("absence / vide / Uncategorized (toutes casses) → false", () => {
    expect(categorieAutoValide(null)).toBe(false);
    expect(categorieAutoValide(undefined)).toBe(false);
    expect(categorieAutoValide("")).toBe(false);
    expect(categorieAutoValide("   ")).toBe(false);
    expect(categorieAutoValide("Uncategorized")).toBe(false);
    expect(categorieAutoValide("uncategorized")).toBe(false);
    expect(categorieAutoValide("  UNCATEGORIZED ")).toBe(false);
  });

  // La graphie que l'amont émet VRAIMENT (SCREAMING_SNAKE, inventaire base 2026-07-21).
  // C'est le cas qui manquait : la liste fermée ne connaissait que "uncategorized".
  it("Unclassified (toutes casses, dont la SCREAMING_SNAKE observée) → false", () => {
    expect(categorieAutoValide("UNCLASSIFIED")).toBe(false);
    expect(categorieAutoValide("unclassified")).toBe(false);
    expect(categorieAutoValide("Unclassified")).toBe(false);
    expect(categorieAutoValide("  UNCLASSIFIED ")).toBe(false);
  });

  // CONTRE-PREUVE — sans elle, un filtre trop large (ex. tout préfixe "unc"/"uncl", ou
  // une neutralisation du SCREAMING_SNAKE en bloc) passerait les tests ci-dessus tout en
  // détruisant les catégories réelles. Ce sont les trois AUTRES valeurs de l'inventaire
  // du 2026-07-21 : elles doivent rester exploitables.
  it("les vraies catégories amont en SCREAMING_SNAKE restent exploitables", () => {
    expect(categorieAutoValide("UTILITIES")).toBe(true);
    expect(categorieAutoValide("BANKING_AND_FINANCE")).toBe(true);
    expect(categorieAutoValide("INTER_ACCOUNT_TRANSFER")).toBe(true);
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
