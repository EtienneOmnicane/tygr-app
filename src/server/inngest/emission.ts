/**
 * Émission d'événements Inngest — point d'entrée des SURFACES APPLICATIVES
 * (Server Actions aujourd'hui ; cron W2 et route webhook W4 demain).
 *
 * FAIL-SOFT VOULU : un échec d'émission (Inngest injoignable — dev local sans
 * `npx inngest-cli dev` —, clé absente, panne réseau) ne doit JAMAIS casser la
 * réponse d'une action dont le travail principal a réussi. On journalise le
 * code (jamais de PII, règle 8) et on rend `false` : l'appelant adapte son
 * message (« relancez » au lieu de « ça se poursuit en arrière-plan » — ne
 * jamais promettre un job qui n'est pas parti). Aucune garde de tenancy ne
 * transite ici (envoi réseau pur) : ce catch n'avale rien d'isolation.
 */
import {
  evenementSyncIngest,
  inngest,
  type DonneesSyncIngest,
} from "@/server/inngest/client";

/**
 * Demande l'ingestion durable d'une connexion (`omnifi/sync.ingest.requested`,
 * plan §6.2). Rend `true` si l'événement est parti, `false` sinon (fail-soft).
 */
export async function demanderIngestionSync(
  donnees: DonneesSyncIngest,
): Promise<boolean> {
  try {
    // Voie typée du SDK v4 : l'événement est construit puis VALIDÉ (schéma zod
    // de l'eventType) AVANT l'envoi — une donnée malformée échoue ici, en local.
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
    return true;
  } catch (erreur) {
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
    return false;
  }
}
