/**
 * Émission d'événements Inngest — point d'entrée des SURFACES APPLICATIVES
 * (Server Actions ; cron W2 et route webhook W4).
 *
 * DEUX contrats, selon qui appelle :
 *  - `demanderIngestionSync` (FAIL-SOFT) : un échec d'émission (Inngest injoignable
 *    — dev local sans `npx inngest-cli dev` —, clé absente, panne) ne doit JAMAIS
 *    casser la réponse d'une action dont le travail principal a réussi. On
 *    journalise le code (jamais de PII, règle 8) et on rend `false` : l'appelant
 *    adapte son message (« relancez » plutôt que « ça se poursuit »). C'est le
 *    contrat du RELAIS MANUEL.
 *  - `demanderIngestionSyncOuLever` (FAIL-LOUD) : pour le WEBHOOK (§6.4). Un enqueue
 *    raté DOIT devenir une erreur (→ 500 → retry amont), jamais un `false` avalé :
 *    côté webhook, ne pas partir = perdre l'événement (sans W2, aucun filet pull).
 *
 * Aucune garde de tenancy ne transite ici (envoi réseau pur) : ces catch n'avalent
 * rien d'isolation.
 */
import {
  evenementSyncIngest,
  inngest,
  type DonneesSyncIngest,
} from "@/server/inngest/client";

/** Cœur d'émission : construit → VALIDE (schéma zod de l'eventType) → envoie, puis
 *  journalise le succès. Peut LEVER (Inngest injoignable, données invalides). */
async function envoyerSyncIngest(donnees: DonneesSyncIngest): Promise<void> {
  const evenement = evenementSyncIngest.create(donnees);
  await evenement.validate();
  await inngest.send(evenement);
  console.info(
    JSON.stringify({
      evt: "sync_ingest_demande",
      workspaceId: donnees.workspaceId,
      connectionId: donnees.omnifiConnectionId,
      declencheur: donnees.declencheur,
      omnifiJobId: donnees.omnifiJobId ?? null,
    }),
  );
}

/** Journalise un échec d'émission sans PII (code machine seul). */
function journaliserEchecEmission(
  donnees: DonneesSyncIngest,
  erreur: unknown,
): void {
  const code =
    erreur instanceof Error && "code" in erreur && typeof erreur.code === "string"
      ? erreur.code
      : erreur instanceof Error
        ? erreur.name
        : "UNKNOWN";
  console.warn(
    JSON.stringify({
      evt: "sync_ingest_demande_echec",
      workspaceId: donnees.workspaceId,
      connectionId: donnees.omnifiConnectionId,
      declencheur: donnees.declencheur,
      code,
    }),
  );
}

/**
 * Demande l'ingestion durable d'une connexion (`omnifi/sync.ingest.requested`,
 * plan §6.2). FAIL-SOFT : rend `true` si l'événement est parti, `false` sinon.
 */
export async function demanderIngestionSync(
  donnees: DonneesSyncIngest,
): Promise<boolean> {
  try {
    await envoyerSyncIngest(donnees);
    return true;
  } catch (erreur) {
    journaliserEchecEmission(donnees, erreur);
    return false;
  }
}

/**
 * Variante FAIL-LOUD (§6.4) — réservée au WEBHOOK. Journalise le même `evt` d'échec
 * puis RE-LÈVE : l'appelant webhook mappe toute levée → `WEBHOOK_ENQUEUE_ECHEC` (500),
 * pour que le retry amont re-tente (et, l'audit n'étant écrit qu'APRÈS l'enqueue,
 * retombe sur un chemin réellement rejouable — §6.3).
 */
export async function demanderIngestionSyncOuLever(
  donnees: DonneesSyncIngest,
): Promise<void> {
  try {
    await envoyerSyncIngest(donnees);
  } catch (erreur) {
    journaliserEchecEmission(donnees, erreur);
    throw erreur;
  }
}
