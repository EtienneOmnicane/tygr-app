/**
 * Erreurs nommées du client Omni-FI (CLAUDE.md règle 3 : chaque erreur a un code
 * machine, jamais de catch-all silencieux). Toutes dérivent d'OmniFiError pour un
 * `instanceof` unique côté appelant, et portent un `code` stable + le contexte
 * minimal nécessaire au log structuré — JAMAIS de PII ni de secret (règle 8 :
 * pas de libellé bancaire brut, pas de credential, dans un message d'erreur).
 *
 * Mapping des statuts HTTP issu de docs/documentation_api.md § « Codes d'erreur
 * fréquents » et des enveloppes OBIE { Code, Message, Errors[] }.
 */

/** Détail OBIE normalisé (sans PII : on ne garde que code machine + chemin). */
export interface OmniFiErreurDetail {
  errorCode: string;
  path?: string;
}

export abstract class OmniFiError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Configuration absente/invalide (env vars Omni-FI). Erreur de déploiement, pas
 * déclenchable par un client — volontairement bruyante (cf. UnsafeDatabaseRoleError).
 */
export class OmniFiConfigError extends OmniFiError {
  readonly code = "OMNIFI_CONFIG_INVALID";
}

/**
 * Résumé sûr d'une cause d'erreur réseau — uniquement des champs non sensibles.
 * On NE stocke jamais l'objet d'erreur brut d'un fetch (constat S2) : certains
 * wrappers fetch y accrochent la requête, donc l'en-tête Authorization (secret).
 */
export interface CauseReseauResumee {
  name?: string;
  code?: string;
}

/** Panne réseau / DNS / TLS / abort avant toute réponse HTTP. */
export class OmniFiNetworkError extends OmniFiError {
  readonly code = "OMNIFI_NETWORK_ERROR";
  constructor(
    message: string,
    readonly cause?: CauseReseauResumee,
  ) {
    super(message);
  }
}

/** Délai d'attente dépassé (AbortController). */
export class OmniFiTimeoutError extends OmniFiError {
  readonly code = "OMNIFI_TIMEOUT";
  constructor(readonly timeoutMs: number) {
    super(`Délai Omni-FI dépassé après ${timeoutMs} ms`);
  }
}

/**
 * Réponse HTTP d'erreur (4xx/5xx) avec enveloppe OBIE décodée si présente.
 * `status` et `details[].errorCode` sont sûrs à logger (pas de PII) ; le `Message`
 * OBIE peut en contenir, donc il N'est PAS exposé tel quel — on ne garde que les
 * codes machine.
 */
export class OmniFiApiError extends OmniFiError {
  readonly code = "OMNIFI_API_ERROR";
  constructor(
    readonly status: number,
    readonly obieCode: string | null,
    readonly details: OmniFiErreurDetail[],
    /** Présent uniquement sur 429 (docs § 429 : header Retry-After). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Omni-FI a répondu ${status}${obieCode ? ` (${obieCode})` : ""}`);
  }

  get estRateLimit(): boolean {
    return this.status === 429;
  }

  /** 5xx ou 429 : un retry a du sens. 4xx (hors 429) : non, c'est notre faute. */
  get estReessayable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/** Corps de réponse illisible ou enveloppe { Data } absente là où elle est due. */
export class OmniFiInvalidResponseError extends OmniFiError {
  readonly code = "OMNIFI_INVALID_RESPONSE";
  constructor(message: string) {
    super(`Réponse Omni-FI inexploitable : ${message}`);
  }
}
