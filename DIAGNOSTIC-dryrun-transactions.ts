/**
 * =============================================================================
 * DRY-RUN READ-ONLY — "transactions manquantes" : test discriminant final
 * =============================================================================
 * OBJET
 *   Rejouer EXACTEMENT le chemin de lecture + conversion réel de l'ingestion
 *   (client.listerTransactionsPage → versLignePersistee), page par page, pour UN
 *   compte, en loggant tout — SANS jamais écrire (aucun upsert, aucun
 *   marquerSynchronise, aucune transaction DB).
 *
 * POURQUOI
 *   La base contient 40 lignes (avril seul) pour le compte badc5f0b6337 alors que
 *   `last_synced_at` = ce matin 06:06. Preuve par le code (orchestrateur.ts L166-198,
 *   ingestion.ts upsertTransactions L161-231) : le chemin d'écriture ne peut PAS
 *   perdre de lignes silencieusement — versLignePersistee est un map 1:1, upsert
 *   insère chaque ligne, la boucle n'a aucun try/catch et `marquerSynchronise` n'est
 *   atteint QUE si aucune page n'a levé. Donc `last_synced_at` posé ⟹ la boucle est
 *   allée au bout sans throw ⟹ l'amont ne rendait QUE ~40 lignes à 06:06.
 *
 *   Ce dry-run tranche les 2 seules hypothèses restantes, en lecture pure :
 *     H1 — versLignePersistee REJETTE/lève sur des tx récentes (mai/juin).
 *          => on le verrait ici : `converties < brutes` ou une exception loggée.
 *     H2 — staleness amont : l'amont rend AUJOURD'HUI 162 (avril→juin) alors qu'il
 *          n'en rendait que ~40 à 06:06. => ici : brutes == converties == 162,
 *          0 exception, dates jusqu'en juin. C'est le résultat ATTENDU.
 *
 * SÉCURITÉ
 *   100 % lecture. N'importe RIEN de la couche DB (pas d'`executer`, pas de Drizzle).
 *   N'appelle QUE client.listerTransactionsPage (GET) + versLignePersistee (pur).
 *
 * PRÉ-REQUIS ENV (clés prod, comme `npm run start:prod`)
 *   OMNIFI_ENV=production  OMNIFI_AUTORISER_PRODUCTION=1  + OMNIFI_CLIENT_ID/SECRET/
 *   BASE_URL de .env.prod. Sinon le client refuse (verrou) ou renvoie 403 (clés
 *   sandbox) — cf. la mésaventure du 1er probe.
 *
 * PARAMÈTRES (env vars)
 *   DRYRUN_ACCOUNT_ID     omnifi_account_id du compte à sonder
 *                         (défaut : 53e448b0-1d6e-4321-85d5-badc5f0b6337 = badc5f0b6337)
 *   DRYRUN_CLIENT_USER_ID workspaces.omnifi_client_user_id du workspace prod
 *                         (obligatoire ; récupère-le en read-only, voir plus bas)
 *   DRYRUN_PAGE_SIZE      optionnel (défaut = défaut ingestion = 100)
 *
 *   Récupérer le clientUserId (read-only) :
 *     SELECT omnifi_client_user_id FROM workspaces;   -- 1 seule ligne en prod
 *
 * LANCEMENT (adapter au harnais tsx que tu utilises déjà)
 *   OMNIFI_ENV=production OMNIFI_AUTORISER_PRODUCTION=1 \
 *   DRYRUN_CLIENT_USER_ID='<uuid>' \
 *   npx dotenv -e .env.prod -- npx tsx DIAGNOSTIC-dryrun-transactions.ts
 *
 * LECTURE DU RÉSULTAT
 *   * total_brutes == total_converties, 0 exception, max(date) en mai/juin
 *       => H2 confirmée : STALENESS amont. Aucun bug TYGR. Correctif = re-sync
 *          (écriture, à toi) ; la base passera 40 → total_converties.
 *   * total_converties < total_brutes  OU  exceptions > 0
 *       => H1 : la conversion recale des lignes récentes. Le détail loggé (page,
 *          index, champ, message) pointe le champ fautif dans versLignePersistee.
 *   * total_brutes ~ 40 et max(date) = 30 avril
 *       => l'amont rend TOUJOURS 40 : la "profondeur" n'a pas bougé depuis 06:06 ;
 *          creuser côté job de scrape Omni-FI (PersistenceStats / antériorité).
 * =============================================================================
 */

import { OmniFiClient } from "@/server/omnifi";
import { versLignePersistee } from "@/server/ingestion/orchestrateur";

const ACCOUNT_ID =
  process.env.DRYRUN_ACCOUNT_ID ?? "53e448b0-1d6e-4321-85d5-badc5f0b6337";
const CLIENT_USER_ID = process.env.DRYRUN_CLIENT_USER_ID ?? "";
const PAGE_SIZE = process.env.DRYRUN_PAGE_SIZE
  ? Number(process.env.DRYRUN_PAGE_SIZE)
  : undefined; // undefined => défaut ingestion (100)

const MAX_PAGES = 1000; // même filet que l'orchestrateur

// transactionDate = chaîne "YYYY-MM-DD" (E20). Tri lexicographique == tri chrono.
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateValide(s: string): boolean {
  return RE_DATE.test(s);
}

async function main(): Promise<void> {
  if (!CLIENT_USER_ID) {
    console.error(
      "DRYRUN_CLIENT_USER_ID manquant. SELECT omnifi_client_user_id FROM workspaces;",
    );
    process.exit(1);
  }

  const client = new OmniFiClient(); // lit la config env (clés prod requises)

  let page = 1;
  let totalBrutes = 0;
  let totalConverties = 0;
  let exceptions = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  const txnIds = new Set<string>();
  const coupleTxnDate = new Set<string>();

  console.log(
    JSON.stringify({
      evt: "dryrun_debut",
      account: ACCOUNT_ID.slice(0, 8),
      pageSize: PAGE_SIZE ?? "défaut(100)",
    }),
  );

  for (;;) {
    const env = await client.listerTransactionsPage(ACCOUNT_ID, CLIENT_USER_ID, {
      page,
      pageSize: PAGE_SIZE,
    });

    const brutes = env.Data.Transaction ?? [];
    let convertiesPage = 0;
    let minPage: string | null = null;
    let maxPage: string | null = null;

    brutes.forEach((t, index) => {
      try {
        const ligne = versLignePersistee(t);
        convertiesPage += 1;
        totalConverties += 1;
        txnIds.add(ligne.omnifiTxnId);
        coupleTxnDate.add(`${ligne.omnifiTxnId}|${ligne.transactionDate}`);
        const d = ligne.transactionDate;
        if (dateValide(d)) {
          if (!minPage || d < minPage) minPage = d;
          if (!maxPage || d > maxPage) maxPage = d;
          if (!minDate || d < minDate) minDate = d;
          if (!maxDate || d > maxDate) maxDate = d;
        } else {
          console.warn(
            JSON.stringify({
              evt: "dryrun_date_invalide",
              page,
              index,
              date: d,
              txn: ligne.omnifiTxnId?.slice(0, 8),
            }),
          );
        }
      } catch (err) {
        exceptions += 1;
        // On NE loggue PAS le contenu de la tx (règle 8 : pas de PII). Seulement la
        // position + le type/message d'erreur pour pointer le champ fautif.
        console.error(
          JSON.stringify({
            evt: "dryrun_conversion_echec",
            page,
            index,
            erreur: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          }),
        );
      }
    });

    totalBrutes += brutes.length;

    console.log(
      JSON.stringify({
        evt: "dryrun_page",
        page,
        brutes: brutes.length,
        converties: convertiesPage,
        min: minPage,
        max: maxPage,
        totalPages: env.Meta?.TotalPages ?? null,
        totalRecords: env.Meta?.TotalRecords ?? null,
        hasNext: Boolean(env.Links?.Next),
      }),
    );

    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || page >= totalPages) break;
    if (page >= MAX_PAGES) {
      console.error(JSON.stringify({ evt: "dryrun_max_pages", page }));
      break;
    }
    page += 1;
  }

  console.log(
    JSON.stringify(
      {
        evt: "dryrun_synthese",
        pages: page,
        total_brutes: totalBrutes,
        total_converties: totalConverties,
        exceptions,
        txn_ids_distincts: txnIds.size,
        couples_txn_date_distincts: coupleTxnDate.size,
        date_min: minDate,
        date_max: maxDate,
        // Grille : brutes==converties & exceptions==0 & date_max en mai/juin => STALENESS
        //   (H2, attendu, aucun bug). converties<brutes | exceptions>0 => conversion (H1).
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      evt: "dryrun_fatal",
      erreur: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }),
  );
  process.exit(1);
});
