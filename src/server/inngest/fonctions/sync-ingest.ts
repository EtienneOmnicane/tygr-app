/**
 * Job durable `omnifi/sync.ingest.requested` (lot W1, plan §6.2 — convergence
 * D1=C) : LE worker unique de synchronisation qu'émettent le clic manuel
 * (relais W1), le cron quotidien (W2) et le webhook (W4).
 *
 * Ce qu'il referme (SYNC-WEBHOOK-INGEST1, côté infra) : une Server Action est
 * bornée à ~120 s de polling (POLL_SYNC_PLAFOND_MS) alors qu'un scrape bancaire
 * observé en prod dure 6 min+. Ici, l'attente est DURABLE : chaque poll est un
 * `step.run` mémoïsé, chaque pause un `step.sleep` — aucun compute retenu, pas
 * de budget de requête HTTP. Un scrape long aboutit à des transactions
 * complètes en base sans nouveau clic.
 *
 * Sécurité / tenancy :
 *  - `workspaceId` (événement) vient TOUJOURS d'une résolution serveur (session
 *    de l'action émettrice, cron, tygr_service) — validé zod ici (défense en
 *    profondeur : un événement peut être forgé depuis le dashboard Inngest).
 *  - Tout accès données passe par `executerPourWorkspaceSysteme(workspaceId)` :
 *    la RLS tenant borne le job à CE workspace. Une `omnifiConnectionId` qui
 *    n'y vit pas résout à ZÉRO ligne → arrêt propre, jamais de routage
 *    cross-tenant (l'esprit de WEBHOOK-TENANT-FIRST1 dès W1).
 *  - Fail-soft ⚠️ jamais sur les gardes de tenancy : ce module n'attrape AUCUNE
 *    erreur d'isolation (UnsafeDatabaseRoleError…) — elles font échouer le run,
 *    visibles au dashboard (leçon PR #123).
 *
 * Idempotence, TROIS étages : (1) upserts d'ingestion idempotents (« bretelles »)
 * + `concurrency: 1` par connexion (deux événements rapprochés se sérialisent) ;
 * (2) dédup PERMANENTE par tenant dans `audit_events` (côté webhook, W4) ;
 * (3) `idempotency: "event.data.cleIdempotence"` ci-dessous — clé TOUJOURS
 * présente (D2, W4), donc « rejeu ×5 → 1 seul RUN » sur la fenêtre SDK de 24 h.
 * On dédup sur `cleIdempotence` et NON `omnifiEventId` : ce dernier est absent
 * des émetteurs cron/manuel ; la clé PAR ÉMETTEUR (wh:/cron:/man:, cf. client.ts)
 * garantit que deux événements DISTINCTS ne collisionnent jamais.
 */
import { and, eq } from "drizzle-orm";

import { bankAccounts, bankConnections } from "@/server/db/schema";
import { executerPourWorkspaceSysteme } from "@/server/db/systeme";
import type { ExecuterWorkspace } from "@/server/db/tenancy";
import { synchroniserCompteComplet } from "@/server/ingestion";
import {
  donneesSyncIngestSchema,
  evenementSyncIngest,
  inngest,
} from "@/server/inngest/client";
import { creerClientOmniFi, OmniFiApiError, type OmniFiClient } from "@/server/omnifi";
import {
  clientUserIdDuWorkspace,
  estThrottleAmont,
  SYNC_STATUTS_MFA,
  SYNC_STATUTS_TERMINAUX,
} from "@/server/widget/orchestration";

/**
 * Cadence du polling durable. Plus espacée que les 3 s du chemin synchrone :
 * ici personne n'attend devant un spinner, et un scrape long se mesure en
 * minutes — 30 s suit d'assez près sans marteler l'amont.
 */
const INTERVALLE_POLL_DURABLE = "30s";
/**
 * Plafond de POLLS (≈ 30 min de couverture à 30 s) — filet anti-job-amont-zombie,
 * PAS un budget de compute (chaque poll est un step indépendant). « No silent
 * caps » : l'atteindre est journalisé (`sync_ingest_plafond_atteint`) et le
 * partiel déjà scrapé est INGÉRÉ quand même (même politique que le chemin
 * manuel INCOMPLET — l'upsert idempotent rend la relecture sûre).
 */
const POLLS_MAX = 60;

/* ------------------------------------------------------------------ */
/* Briques PURES / composables (testées unitairement, sans Inngest)    */
/* ------------------------------------------------------------------ */

/** Issue d'un poll du job amont, projetée en catégories décidables. */
export type EtatJobAmont =
  | { categorie: "TERMINAL_OK" }
  | { categorie: "TERMINAL_ECHEC"; errorType: string | null }
  | { categorie: "MFA" }
  | { categorie: "EN_COURS"; statut: string };

/**
 * Classe un SyncJob amont. Union OUVERTE (leçon PR #202 : l'enum amont dérive) :
 * un statut inconnu n'est ni un succès ni un échec — il se re-polle, et le
 * plafond le rendra visible plutôt que de l'assimiler.
 */
export function classifierStatutJob(job: {
  Status: string;
  Error?: { Type: string } | null;
}): EtatJobAmont {
  const statut = job.Status;
  if (SYNC_STATUTS_MFA.has(statut)) return { categorie: "MFA" };
  if (SYNC_STATUTS_TERMINAUX.has(statut)) {
    if (statut === "COMPLETED") return { categorie: "TERMINAL_OK" };
    // FAILED : Type machine seul, jamais le Message OBIE (règle 8).
    return { categorie: "TERMINAL_ECHEC", errorType: job.Error?.Type ?? null };
  }
  return { categorie: "EN_COURS", statut };
}

/** Ce que le worker doit faire du job amont pour cette connexion. */
export type ResolutionJobAmont =
  | { mode: "ATTENDRE"; jobId: string }
  | { mode: "LIRE_SEULEMENT"; raison: "COOLDOWN" | "SANS_JOB_ID" | "JOB_DEJA_TERMINE" };

/**
 * Résout le job amont à attendre quand l'événement n'en porte pas (chemin cron
 * W2 / re-déclenchement) : respecte le cooldown amont (« 1 sync / 15 min »),
 * absorbe le throttle et le « sync already running » (mêmes voies que
 * `declencherEtAttendre`, sans l'attente bornée).
 *
 * `LIRE_SEULEMENT` n'est pas un échec : sous cooldown, le dernier scrape date
 * de < 15 min — relire l'état courant EST la fraîcheur promise (lecture
 * idempotente).
 */
export async function resoudreJobAmont(
  client: OmniFiClient,
  omnifiConnectionId: string,
  clientUserId: string,
  nextSyncAvailableAt: string | null,
): Promise<ResolutionJobAmont> {
  // (a) Cooldown amont actif → ne PAS déclencher. Si le dernier job court
  //     encore, on l'attend (c'est le cas « incomplet » du chemin manuel) ;
  //     sinon on lit l'état courant.
  const cooldownMs = nextSyncAvailableAt ? Date.parse(nextSyncAvailableAt) : NaN;
  if (!Number.isNaN(cooldownMs) && cooldownMs > Date.now()) {
    const enCours = await dernierJobNonTerminal(client, omnifiConnectionId, clientUserId);
    if (enCours) return { mode: "ATTENDRE", jobId: enCours };
    return { mode: "LIRE_SEULEMENT", raison: "COOLDOWN" };
  }

  // (b) Déclenchement gardé (429 / 400-RATE_LIMIT / 400-already-running).
  try {
    const job = await client.declencherSync(omnifiConnectionId, clientUserId);
    if (!job.JobId) return { mode: "LIRE_SEULEMENT", raison: "SANS_JOB_ID" };
    return { mode: "ATTENDRE", jobId: job.JobId };
  } catch (erreur) {
    if (estThrottleAmont(erreur)) {
      // Course avec la garde : un sync vient de tourner/tourne. On attend le
      // job courant s'il vit encore, sinon lecture du dernier état.
      const enCours = await dernierJobNonTerminal(client, omnifiConnectionId, clientUserId);
      if (enCours) return { mode: "ATTENDRE", jobId: enCours };
      return { mode: "LIRE_SEULEMENT", raison: "COOLDOWN" };
    }
    if (
      erreur instanceof OmniFiApiError &&
      erreur.status === 400 &&
      erreur.conflitSyncEnCours
    ) {
      const enCours = await dernierJobNonTerminal(client, omnifiConnectionId, clientUserId);
      if (enCours) return { mode: "ATTENDRE", jobId: enCours };
      // « already running » mais latest déjà terminal : rien de frais à attendre.
      return { mode: "LIRE_SEULEMENT", raison: "JOB_DEJA_TERMINE" };
    }
    // Autre 400 / 5xx / réseau : remonte — le retry de step Inngest gère les
    // transitoires ; épuisé, le run échoue VISIBLEMENT au dashboard.
    throw erreur;
  }
}

/**
 * JobId du dernier job amont s'il court encore (ni terminal ni MFA), sinon
 * null. Best-effort : une erreur de lecture rend null (même contrat que
 * `jobEnCoursNonTerminal` du chemin manuel) — un diagnostic ne fait pas
 * échouer une synchro.
 */
async function dernierJobNonTerminal(
  client: OmniFiClient,
  omnifiConnectionId: string,
  clientUserId: string,
): Promise<string | null> {
  try {
    const latest = await client.getLatestSyncJob(omnifiConnectionId, clientUserId);
    if (!latest.JobId) return null;
    if (SYNC_STATUTS_TERMINAUX.has(latest.Status) || SYNC_STATUTS_MFA.has(latest.Status)) {
      return null;
    }
    return latest.JobId;
  } catch {
    return null;
  }
}

/** Contexte de la connexion, résolu SOUS la RLS du workspace de l'événement. */
export type ContexteConnexion =
  | { present: false }
  | { present: true; clientUserId: string; nextSyncAvailableAt: string | null };

/**
 * Résout la connexion DANS le workspace (RLS posée par la primitive système).
 * `present: false` = la connexion n'existe pas dans CE tenant (jamais
 * rattachée, ou événement mal routé) → l'appelant s'arrête proprement, aucune
 * lecture amont. Fail-closed structurel : c'est la RLS qui répond, pas une
 * clause WHERE qu'on pourrait oublier.
 */
export async function resoudreContexteConnexion(
  executer: ExecuterWorkspace,
  omnifiConnectionId: string,
): Promise<ContexteConnexion> {
  return executer(async (tx, ctx) => {
    const lignes = await tx
      .select({ nextSyncAvailableAt: bankConnections.nextSyncAvailableAt })
      .from(bankConnections)
      .where(eq(bankConnections.omnifiConnectionId, omnifiConnectionId))
      .limit(1);
    if (lignes.length === 0) return { present: false } as const;
    return {
      present: true,
      clientUserId: await clientUserIdDuWorkspace(tx, ctx.workspaceId),
      nextSyncAvailableAt: lignes[0].nextSyncAvailableAt?.toISOString() ?? null,
    } as const;
  });
}

/** Compte rattaché à ingérer (résolu local ↔ amont). */
export interface CompteAIngerer {
  bankAccountId: string;
  omnifiAccountId: string;
}

/**
 * Comptes SÉLECTIONNÉS de la connexion, dans le workspace courant (RLS). Même
 * périmètre que le chemin manuel : `is_selected = true` (Account Selection).
 */
export async function listerComptesAIngerer(
  executer: ExecuterWorkspace,
  omnifiConnectionId: string,
): Promise<CompteAIngerer[]> {
  return executer(async (tx) =>
    tx
      .select({
        bankAccountId: bankAccounts.id,
        omnifiAccountId: bankAccounts.omnifiAccountId,
      })
      .from(bankAccounts)
      .innerJoin(bankConnections, eq(bankAccounts.connectionId, bankConnections.id))
      .where(
        and(
          eq(bankConnections.omnifiConnectionId, omnifiConnectionId),
          eq(bankAccounts.isSelected, true),
        ),
      ),
  );
}

/** Récapitulatif d'une ingestion de connexion (observabilité, retour de run). */
export interface ResultatIngestionConnexion {
  statut: "OK" | "CONNEXION_INCONNUE" | "AUCUN_COMPTE";
  comptes: number;
  transactions: number;
  soldes: number;
}

/**
 * Ingestion complète (transactions + soldes EOD) des comptes d'une connexion —
 * la version COMPOSABLE (sans Inngest) du cœur du worker, réutilisée par les
 * tests d'isolation. Le worker fait la même chose mais en steps (retry
 * unitaire par compte, §6.2).
 */
export async function ingererComptesConnexion(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: { omnifiConnectionId: string; clientUserId: string },
): Promise<ResultatIngestionConnexion> {
  const comptes = await listerComptesAIngerer(executer, params.omnifiConnectionId);
  if (comptes.length === 0) {
    return { statut: "AUCUN_COMPTE", comptes: 0, transactions: 0, soldes: 0 };
  }
  let transactions = 0;
  let soldes = 0;
  for (const compte of comptes) {
    const r = await synchroniserCompteComplet(client, executer, {
      omnifiAccountId: compte.omnifiAccountId,
      bankAccountId: compte.bankAccountId,
      clientUserId: params.clientUserId,
    });
    transactions += r.sync.transactionsTraitees;
    soldes += r.soldes;
  }
  return { statut: "OK", comptes: comptes.length, transactions, soldes };
}

/* ------------------------------------------------------------------ */
/* La fonction Inngest — câblage déclaratif des briques ci-dessus      */
/* ------------------------------------------------------------------ */

export const syncIngest = inngest.createFunction(
  {
    id: "omnifi-sync-ingest",
    // §6.2 / cahier §4.3 : deux événements rapprochés sur la MÊME connexion se
    // sérialisent (le second ne fait qu'une relecture idempotente).
    concurrency: [{ key: "event.data.omnifiConnectionId", limit: 1 }],
    retries: 3,
    // §6.2 (D2) : dédup Inngest « 1 événement → 1 run » sur la fenêtre SDK de 24 h.
    // Clé PAR ÉMETTEUR (wh:/cron:/man:) : deux événements distincts ne collisionnent
    // jamais ; un rejeu amont du même EventId (`wh:${EventId}`) collapse en 1 run.
    idempotency: "event.data.cleIdempotence",
    triggers: [{ event: evenementSyncIngest }],
  },
  async ({ event, step }) => {
    // RE-validation à la réception (défense en profondeur : un événement peut
    // être forgé depuis le dashboard Inngest). Rejet bruyant (run FAILED,
    // visible) — jamais de catch-all.
    const donnees = donneesSyncIngestSchema.parse(event.data);
    const executer = executerPourWorkspaceSysteme(donnees.workspaceId);
    const client = creerClientOmniFi();

    // 1. Résolution tenant-first : la connexion DOIT vivre dans le workspace
    //    de l'événement (RLS). Sinon : arrêt propre, zéro appel amont.
    const contexte = await step.run("resoudre-contexte", () =>
      resoudreContexteConnexion(executer, donnees.omnifiConnectionId),
    );
    if (!contexte.present) {
      console.warn(
        JSON.stringify({
          evt: "sync_ingest_connexion_inconnue",
          workspaceId: donnees.workspaceId,
          connectionId: donnees.omnifiConnectionId,
          declencheur: donnees.declencheur,
        }),
      );
      return { statut: "CONNEXION_INCONNUE" as const };
    }

    // 2. Job amont à attendre : fourni par l'émetteur (relais manuel W1,
    //    webhook W4), sinon résolu/déclenché ici (cron W2).
    const resolution: ResolutionJobAmont = donnees.omnifiJobId
      ? { mode: "ATTENDRE", jobId: donnees.omnifiJobId }
      : await step.run("resoudre-job-amont", () =>
          resoudreJobAmont(
            client,
            donnees.omnifiConnectionId,
            contexte.clientUserId,
            contexte.nextSyncAvailableAt,
          ),
        );

    // 3. Attente DURABLE du statut terminal — le cœur du lot : chaque poll est
    //    un step mémoïsé, chaque pause un step.sleep. Plus de plafond 120 s.
    let issue: "COMPLETED" | "LECTURE_SEULE" | "PLAFOND" = "LECTURE_SEULE";
    let dernierStatut: string | null = null;
    if (resolution.mode === "ATTENDRE") {
      const jobId = resolution.jobId;
      for (let i = 0; ; i += 1) {
        const etat = await step.run(`poll-job-${i}`, async () =>
          classifierStatutJob(await client.getSyncJobServeur(jobId, contexte.clientUserId)),
        );
        if (etat.categorie === "TERMINAL_OK") {
          issue = "COMPLETED";
          break;
        }
        if (etat.categorie === "TERMINAL_ECHEC") {
          // Échec DUR du scrape : pas d'ingestion (parité SKIP_FAILED du chemin
          // manuel). Le statut d'erreur durable sur la connexion appartient à
          // SYNC-INCOMPLET-DURABLE1 (PR dédiée) — on journalise sans persister
          // (§6.4 : aucun couplage d'ordre entre les deux PR).
          console.warn(
            JSON.stringify({
              evt: "sync_ingest_job_failed",
              workspaceId: donnees.workspaceId,
              connectionId: donnees.omnifiConnectionId,
              jobId,
              declencheur: donnees.declencheur,
              errorType: etat.errorType,
            }),
          );
          return { statut: "JOB_AMONT_FAILED" as const, errorType: etat.errorType };
        }
        if (etat.categorie === "MFA") {
          // La banque redemande un OTP : non fournissable par un worker (le
          // widget natif pilote la MFA). Le signal UI (mode REPAIR) reste porté
          // par le chemin manuel ; ici on trace et on s'arrête.
          console.warn(
            JSON.stringify({
              evt: "sync_ingest_mfa_requise",
              workspaceId: donnees.workspaceId,
              connectionId: donnees.omnifiConnectionId,
              jobId,
              declencheur: donnees.declencheur,
            }),
          );
          return { statut: "MFA_REQUISE" as const };
        }
        dernierStatut = etat.statut;
        if (i + 1 >= POLLS_MAX) {
          // Job amont zombie (> ~30 min) : cap EXPLICITE, jamais silencieux. On
          // ingère quand même le partiel déjà scrapé (lecture idempotente).
          console.warn(
            JSON.stringify({
              evt: "sync_ingest_plafond_atteint",
              workspaceId: donnees.workspaceId,
              connectionId: donnees.omnifiConnectionId,
              jobId,
              declencheur: donnees.declencheur,
              dernierStatut,
              polls: POLLS_MAX,
            }),
          );
          issue = "PLAFOND";
          break;
        }
        await step.sleep(`attente-job-${i}`, INTERVALLE_POLL_DURABLE);
      }
    }

    // 4. Ingestion — COMPLETED (le scrape est fini), LECTURE_SEULE (cooldown :
    //    l'état courant EST le dernier scrape) ou PLAFOND (partiel, idempotent).
    //    Un step PAR COMPTE : retry unitaire (§6.2), id stable par identifiant.
    const comptes = await step.run("lister-comptes", () =>
      listerComptesAIngerer(executer, donnees.omnifiConnectionId),
    );
    let transactions = 0;
    let soldes = 0;
    for (const compte of comptes) {
      const r = await step.run(`ingerer-compte-${compte.omnifiAccountId}`, () =>
        synchroniserCompteComplet(client, executer, {
          omnifiAccountId: compte.omnifiAccountId,
          bankAccountId: compte.bankAccountId,
          clientUserId: contexte.clientUserId,
        }),
      );
      transactions += r.sync.transactionsTraitees;
      soldes += r.soldes;
    }

    // Récapitulatif structuré (observabilité W1 ; sync_runs arrive en W2).
    console.info(
      JSON.stringify({
        evt: "sync_ingest_termine",
        workspaceId: donnees.workspaceId,
        connectionId: donnees.omnifiConnectionId,
        declencheur: donnees.declencheur,
        omnifiEventId: donnees.omnifiEventId ?? null,
        issue,
        comptes: comptes.length,
        transactions,
        soldes,
      }),
    );
    return {
      statut: issue === "PLAFOND" ? ("PARTIEL_PLAFOND" as const) : ("OK" as const),
      comptes: comptes.length,
      transactions,
      soldes,
    };
  },
);
