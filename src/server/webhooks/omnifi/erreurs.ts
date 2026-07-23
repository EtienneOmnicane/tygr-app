/**
 * Registre S2 des erreurs webhook (règle 3 : chaque erreur a un nom ; catch-all
 * interdit). Spec : docs/specs/PLAN-webhook-ingestion.md §9.1.
 *
 * Chaque classe porte un `code` machine STABLE et le `statutHttp` que la route
 * renvoie — avec un CORPS VIDE (§2.2) : jamais de message, jamais de `cause`, jamais
 * d'écho du payload sur le fil. Le `code` ne vit QUE dans le log et le nom de classe.
 *
 * Les motifs de QUARANTAINE (CONNEXION_INCONNUE / AMBIGUE / ENV_MISMATCH) ne sont
 * PAS des erreurs : ils répondent 202 (§2.1). Ils vivent dans `resolution.ts` et le
 * schéma de quarantaine, pas ici.
 */
export abstract class ErreurWebhook extends Error {
  abstract readonly code: string;
  abstract readonly statutHttp: number;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Aucun secret configuré pour l'env courant → route INERTE (jamais « accepte sans vérifier »). */
export class WebhookNonConfigureError extends ErreurWebhook {
  readonly code = "WEBHOOK_NON_CONFIGURE";
  readonly statutHttp = 503;
  constructor() {
    super("Secret webhook absent pour l'environnement courant");
  }
}

/** Corps au-delà de la borne (64 Ko) — content-length OU octets lus. */
export class WebhookTropVolumineuxError extends ErreurWebhook {
  readonly code = "WEBHOOK_TROP_VOLUMINEUX";
  readonly statutHttp = 413;
  constructor() {
    super("Corps de requête au-delà de la borne");
  }
}

/** Seau de rate-limit dépassé (avant tout calcul HMAC). */
export class WebhookTropDeRequetesError extends ErreurWebhook {
  readonly code = "WEBHOOK_TROP_DE_REQUETES";
  readonly statutHttp = 429;
  /** Secondes à attendre — pour l'en-tête `Retry-After` (borne l'exposition). */
  readonly retryApresSecondes: number;
  constructor(retryApresSecondes: number) {
    super("Trop de requêtes");
    this.retryApresSecondes = retryApresSecondes;
  }
}

/** Signature absente, mal formée, ou invalide (aucun écrit DB avant ce point). */
export class WebhookSignatureInvalideError extends ErreurWebhook {
  readonly code = "WEBHOOK_SIGNATURE_INVALIDE";
  readonly statutHttp = 401;
  constructor() {
    super("Signature webhook invalide");
  }
}

/** Corps non conforme au schéma zod strict. */
export class WebhookPayloadInvalideError extends ErreurWebhook {
  readonly code = "WEBHOOK_PAYLOAD_INVALIDE";
  readonly statutHttp = 400;
  constructor() {
    super("Payload webhook non conforme");
  }
}

/** `Timestamp` hors de la fenêtre de fraîcheur (passé lointain ou futur au-delà de la dérive). */
export class WebhookHorsFenetreError extends ErreurWebhook {
  readonly code = "WEBHOOK_HORS_FENETRE";
  readonly statutHttp = 400;
  constructor() {
    super("Timestamp webhook hors fenêtre");
  }
}

/** Échec d'enqueue Inngest → 500 → l'amont retente (aucune trace posée avant, §6.3). */
export class WebhookEnqueueEchecError extends ErreurWebhook {
  readonly code = "WEBHOOK_ENQUEUE_ECHEC";
  readonly statutHttp = 500;
  constructor() {
    super("Échec d'enqueue de l'ingestion");
  }
}

/** Échec d'écriture d'audit APRÈS enqueue réussi → 500 → le retry ré-enqueue (collapsé)
 *  puis repose la trace : auto-réparant (§6.3). */
export class WebhookAuditEchecError extends ErreurWebhook {
  readonly code = "WEBHOOK_AUDIT_ECHEC";
  readonly statutHttp = 500;
  constructor() {
    super("Échec d'écriture d'audit");
  }
}
