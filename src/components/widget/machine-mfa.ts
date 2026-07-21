/**
 * Machine à états PURE du flux MFA Omni-FI (PR-W3). Aucune dépendance React ni
 * réseau : un état + un réducteur `transition(etat, evenement)`. C'est le cœur
 * métier testable ; le hook `useOmniFiWidget` ne fait que l'alimenter avec les
 * réponses de polling et déclencher les effets (submit/resend/poll).
 *
 * ⚠️ NON MONTÉ AUJOURD'HUI — ce n'est PAS du code mort. Le widget drop-in
 * (`@omni-fi/react-link`) gère la MFA en interne, donc ce module et son hook ne
 * sont sur aucun chemin runtime : ils sont CONSERVÉS comme substrat de
 * `SYNC-LOADER-ETAPES1` (TODOS.md), dont le loader à étapes dérivera le palier
 * d'avancement d'ici. Ne pas supprimer sans abandonner ce chantier (CODE-MORT-MFA1).
 * Corollaire : un statut de job non mappé ici est SANS effet runtime. Le chemin
 * actif est `attendreFinSync` (`orchestration.ts:594`), qui absorbe déjà tout statut
 * INCONNU en `INCOMPLET` (`:538-543`) plutôt que de figer — d'où la suspension de
 * SYNC-MACHINE-INTERRUPTED1 (prémisse réfutée, cf. TODOS.md).
 *
 * Contrat (CLAUDE.md « Machine à états MFA », docs § Sync Engine) :
 * - Cycle job : PENDING→STARTED→LOGGING_IN→[OTP_REQUESTED↔OTP_WAITING]→
 *   RETRIEVING→PARSING→ENRICHING→COMPLETED | FAILED.
 * - Rejet OTP : un mauvais code → `UserInput` repasse de non-null à null alors
 *   que Status reste OTP_REQUESTED. La machine DÉTECTE cette transition et
 *   re-prompte (incrémente le compteur d'échecs). 3 échecs → le job passe FAILED.
 * - Watermark `MfaResendRequestedAt` : ré-émis VERBATIM au submit suivant un
 *   resend ; AVANT tout resend il reste `undefined` (jamais `null` — A2 de la
 *   cross-review PR-W1, sinon 409 STALE_INPUT).
 * - Resend : autorisé hors cooldown (`MfaResendCooldownSeconds`), max 3.
 *
 * Aucune donnée sensible ici : pas d'identifiant bancaire, pas de token (le hook
 * les détient hors de la machine). On ne manipule que la forme PUBLIQUE du job
 * (JobPublic, exposée par les Server Actions runtime), pas le SyncJob serveur.
 */
import type { OmniFiSyncStatus, OmniFiSyncStatusConnu } from "@/server/omnifi";
import type { JobPublic } from "@/app/(workspace)/banques/widget-runtime";

export const MAX_RESENDS = 3;
export const MAX_OTP_ECHECS = 3;

/** Phase de l'UI widget dérivée du job. */
export type PhaseWidget =
  | "initialisation" // job pas encore OTP / en cours amont
  | "mfa_requis" // OTP_REQUESTED, en attente de saisie
  | "mfa_validation" // OTP_WAITING / submit en vol
  | "synchronisation" // RETRIEVING/PARSING/ENRICHING
  | "termine" // COMPLETED
  | "echec"; // FAILED

export interface EtatMfa {
  phase: PhaseWidget;
  /** Dernier statut brut du job (pour la détection de transition). */
  statut: OmniFiSyncStatus | null;
  /** Détection de rejet : valeur précédente de UserInput (non-null → null). */
  dernierUserInput: string | null;
  /** Nombre d'OTP rejetés détectés. */
  echecsOtp: number;
  /** Watermark à ré-émettre au prochain submit. undefined tant qu'aucun resend. */
  watermark: string | undefined;
  /** Nombre de resends effectués. */
  resends: number;
  /** Timestamp (ms) avant lequel un resend est interdit (cooldown). */
  cooldownJusqua: number | null;
  /** Métadonnées MFA pour l'UI (canal, longueur, destinations masquées). */
  mfa: {
    type: JobPublic["mfaType"];
    length: JobPublic["mfaLength"];
    charset: JobPublic["mfaCharset"];
    deliveryTargets: JobPublic["deliveryTargets"];
  } | null;
  /** Code d'échec terminal (ex. LOGIN_FAILED) si phase === echec. */
  codeEchec: string | null;
}

export function etatInitial(): EtatMfa {
  return {
    phase: "initialisation",
    statut: null,
    dernierUserInput: null,
    echecsOtp: 0,
    watermark: undefined,
    resends: 0,
    cooldownJusqua: null,
    mfa: null,
    codeEchec: null,
  };
}

export type EvenementMfa =
  | { type: "JOB"; job: JobPublic; maintenant: number } // nouveau snapshot de polling
  | { type: "RESEND_OK"; mfaResendRequestedAt: string; cooldownSeconds: number | null; maintenant: number };

/**
 * Phase UI par statut CONNU. La table est typée sur `OmniFiSyncStatusConnu` — l'union
 * FERMÉE — donc une coquille (`RETRIEVIN`) échoue au TYPECHECK.
 *
 * Ce n'est pas de la coquetterie : depuis que le statut du fil est une union OUVERTE
 * (`OmniFiSyncStatusConnu | (string & {})`, parce que l'amont DÉRIVE — il persiste
 * `SCRAPING` là où l'API documente `RETRIEVING`), une comparaison `s === "OTP_REQUESTED"`
 * n'est PLUS vérifiée par TS : comparer à n'importe quelle chaîne devient légal (TS2367 ne
 * mord plus). Une faute de frappe passerait donc en silence, et la phase MFA ne se
 * déclencherait jamais — sans qu'aucun gate ne le voie. Même parade que les Sets de
 * `orchestration.ts` : on INTERROGE avec l'union ouverte, on CONSTRUIT avec la fermée.
 */
const PHASE_PAR_STATUT: Partial<Record<OmniFiSyncStatusConnu, PhaseWidget>> = {
  OTP_REQUESTED: "mfa_requis",
  OTP_WAITING: "mfa_validation",
  COMPLETED: "termine",
  FAILED: "echec",
  RETRIEVING: "synchronisation",
  PARSING: "synchronisation",
  ENRICHING: "synchronisation",
};

/**
 * Phase UI depuis le statut du fil (union ouverte). Un statut INCONNU de nos types (dérive
 * amont) retombe sur `initialisation` : jamais `undefined`, et surtout jamais un faux
 * `termine`/`echec`. Les statuts connus non mappés (PENDING, STARTED, LOGGING_IN) prennent
 * le même repli — c'est bien une phase d'initialisation.
 */
function phaseDepuisStatut(s: OmniFiSyncStatus): PhaseWidget {
  return PHASE_PAR_STATUT[s as OmniFiSyncStatusConnu] ?? "initialisation";
}

/**
 * Le statut du fil vaut-il CE statut connu ? À utiliser partout à la place d'un `===` nu.
 *
 * Raison — la même que pour la table ci-dessus, et elle est facile à oublier : le statut du
 * fil est une union OUVERTE, donc `statut === "OTP_REQUESTED"` n'est PLUS vérifié par
 * TypeScript (comparer une `string` à n'importe quel littéral est légal ; TS2367 ne mord
 * plus). Une coquille passerait en silence — et ici les conséquences sont pires que d'afficher
 * la mauvaise phase : la détection de rejet d'OTP ne se déclencherait jamais, le re-prompt
 * après un mauvais code non plus. Le 2ᵉ argument est typé sur l'union FERMÉE : la coquille
 * échoue au typecheck.
 */
function estStatut(
  s: OmniFiSyncStatus | null,
  connu: OmniFiSyncStatusConnu,
): boolean {
  return s === connu;
}

/**
 * Réducteur pur. Calcule le nouvel état à partir d'un snapshot de job (polling)
 * ou d'un resend réussi. Idempotent sur un même snapshot (sauf détection de
 * rejet, qui dépend de la transition de UserInput).
 */
export function transition(etat: EtatMfa, ev: EvenementMfa): EtatMfa {
  if (ev.type === "RESEND_OK") {
    return {
      ...etat,
      watermark: ev.mfaResendRequestedAt,
      resends: etat.resends + 1,
      cooldownJusqua:
        ev.cooldownSeconds != null
          ? ev.maintenant + ev.cooldownSeconds * 1000
          : null,
    };
  }

  const { job } = ev;
  const statut = job.status;
  const phase = phaseDepuisStatut(statut);

  // Détection de rejet OTP (CLAUDE.md) : on était en OTP_REQUESTED avec un
  // UserInput présent, et il disparaît sans changer de statut → un code a été
  // rejeté. On incrémente le compteur d'échecs. `dernierUserInput` stocke "1"
  // (marqueur de présence) ou null — la valeur réelle n'arrive jamais au client.
  // ⚠️ BEST-EFFORT (constat cross-review #3) : si un snapshot de polling est manqué
  // (présent→absent jamais observé), ce compteur CLIENT peut diverger. Sans impact
  // sécurité : la VÉRITÉ est serveur (3 mauvais codes → job FAILED côté Omni-FI).
  // Ce compteur ne sert qu'à l'UX (re-prompt / désactivation locale).
  let echecsOtp = etat.echecsOtp;
  const rejet =
    estStatut(etat.statut, "OTP_REQUESTED") &&
    estStatut(statut, "OTP_REQUESTED") &&
    etat.dernierUserInput != null &&
    !job.userInputPresent;
  if (rejet) echecsOtp += 1;

  // Watermark : autorité serveur dès qu'il fournit une valeur ; sinon on garde
  // l'existant. Jamais null (A2) — undefined tant qu'aucun resend.
  const watermark = job.mfaResendRequestedAt ?? etat.watermark;

  const resends =
    typeof job.mfaResendCount === "number" ? job.mfaResendCount : etat.resends;

  return {
    ...etat,
    phase,
    statut,
    dernierUserInput: job.userInputPresent ? "1" : null,
    echecsOtp,
    watermark,
    resends,
    cooldownJusqua:
      job.mfaResendCooldownSeconds != null && job.mfaResendRequestedAt != null
        ? Date.parse(job.mfaResendRequestedAt) + job.mfaResendCooldownSeconds * 1000
        : etat.cooldownJusqua,
    mfa:
      estStatut(statut, "OTP_REQUESTED") || estStatut(statut, "OTP_WAITING")
        ? {
            type: job.mfaType,
            length: job.mfaLength,
            charset: job.mfaCharset,
            deliveryTargets: job.deliveryTargets,
          }
        : etat.mfa,
    codeEchec: estStatut(statut, "FAILED")
      ? (job.errorType ?? "FAILED")
      : etat.codeEchec,
  };
}

/* --- Sélecteurs purs (l'UI s'en sert pour activer/désactiver les contrôles) --- */

/** Peut-on soumettre un OTP maintenant ? (en attente de saisie, pas en échec) */
export function peutSoumettre(etat: EtatMfa): boolean {
  return etat.phase === "mfa_requis" && etat.echecsOtp < MAX_OTP_ECHECS;
}

/** Peut-on demander un resend ? (hors cooldown, sous le plafond, en phase MFA) */
export function peutResend(etat: EtatMfa, maintenant: number): boolean {
  if (etat.phase !== "mfa_requis") return false;
  if (etat.resends >= MAX_RESENDS) return false;
  if (etat.cooldownJusqua != null && maintenant < etat.cooldownJusqua) return false;
  return true;
}

/** Secondes restantes de cooldown (0 si aucun). Pour l'affichage d'un compteur. */
export function cooldownRestantSecondes(etat: EtatMfa, maintenant: number): number {
  if (etat.cooldownJusqua == null) return 0;
  return Math.max(0, Math.ceil((etat.cooldownJusqua - maintenant) / 1000));
}

/** Le polling doit-il continuer ? (états non terminaux) */
export function pollingActif(etat: EtatMfa): boolean {
  return etat.phase !== "termine" && etat.phase !== "echec";
}
