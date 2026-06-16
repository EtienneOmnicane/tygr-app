/**
 * Configuration du client Omni-FI — lecture des env vars UNIQUEMENT (CLAUDE.md
 * règle 8 : secrets en env, jamais en commit/fixture). Voir .env.example § Omni-FI.
 *
 * Lecture PARESSEUSE (au premier usage, pas à l'import) sur le modèle de
 * src/server/db/index.ts : `next build` évalue les modules sans les env vars
 * runtime ; une lecture eager casserait le build et la CI. L'absence d'une
 * variable lève OmniFiConfigError au premier appel réel, pas au chargement.
 *
 * Le `secret` n'est jamais loggé ni inclus dans un message d'erreur.
 */
import { OmniFiConfigError } from "./erreurs";

export interface OmniFiConfig {
  /** Base URL sans slash final NI préfixe /v1, ex. https://api-stage.omni-fi.co
   *  (routes à la racine : /connections/link-token — la doc OpenAPI ment sur /v1). */
  readonly baseUrl: string;
  readonly environment: "sandbox" | "production";
  /** Identifiant public de l'ApiClient (peut figurer dans les logs). */
  readonly clientId: string;
  /** Secret de la clé API — JAMAIS loggé. */
  readonly secret: string;
}

function exiger(nom: string): string {
  const valeur = process.env[nom];
  if (!valeur || valeur.trim() === "") {
    throw new OmniFiConfigError(
      `${nom} manquante — voir .env.example § Omni-FI (jamais commitée, règle 8)`,
    );
  }
  return valeur.trim();
}

/**
 * Hôtes Omni-FI légitimes (docs/documentation_api.md § Environnements). La clé
 * ApiKey transite dans l'en-tête Authorization : on n'autorise QUE ces hôtes,
 * sinon une OMNIFI_BASE_URL mal saisie/compromise enverrait le secret ailleurs.
 *
 * NOTE (2026-06-16) : l'hôte sandbox de la doc officielle (`sandbox.omni-fi.co`)
 * est une COQUILLE — il ne résout pas (NXDOMAIN, vérifié). Le vrai hôte de
 * pré-prod est `stage.omni-fi.co` (HTTP 200 vérifié). On retire l'hôte mort de
 * l'allow-list pour ne pas laisser croire qu'il est utilisable.
 */
const HOTES_AUTORISES = new Set([
  "api.omni-fi.co",
  "api-stage.omni-fi.co",
  "stage.omni-fi.co",
]);

/**
 * Valide OMNIFI_BASE_URL contre une fuite de secret (constat sécurité S1) :
 * `startsWith("https://")` est contournable (`https://x\t@evil/` → host evil).
 * On parse réellement l'URL et on exige : protocole https, AUCUN userinfo
 * (user:pass@ détournerait le host), hôte dans l'allow-list. Renvoie l'URL
 * normalisée (origin + path sans slash final).
 */
function validerBaseUrl(brut: string): string {
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    throw new OmniFiConfigError(`OMNIFI_BASE_URL n'est pas une URL valide`);
  }
  if (url.protocol !== "https:") {
    throw new OmniFiConfigError(
      "OMNIFI_BASE_URL doit être en https:// (la clé ApiKey transite dans l'en-tête Authorization)",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new OmniFiConfigError(
      "OMNIFI_BASE_URL ne doit pas contenir d'identifiants (user:pass@) — détournement d'hôte possible",
    );
  }
  if (!HOTES_AUTORISES.has(url.hostname)) {
    throw new OmniFiConfigError(
      `Hôte OMNIFI_BASE_URL non autorisé : ${url.hostname}. ` +
        `Attendu l'un de : ${[...HOTES_AUTORISES].join(", ")} (docs § Environnements)`,
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function lireConfig(): OmniFiConfig {
  const environment = exiger("OMNIFI_ENV");
  if (environment !== "sandbox" && environment !== "production") {
    throw new OmniFiConfigError(
      `OMNIFI_ENV invalide ("${environment}") : attendu "sandbox" ou "production"`,
    );
  }

  const baseUrl = validerBaseUrl(exiger("OMNIFI_BASE_URL"));

  return {
    baseUrl,
    environment,
    clientId: exiger("OMNIFI_CLIENT_ID"),
    secret: exiger("OMNIFI_SECRET"),
  };
}

let cache: OmniFiConfig | undefined;

/** Config singleton, résolue au premier usage. */
export function obtenirConfigOmniFi(): OmniFiConfig {
  return (cache ??= lireConfig());
}

/** Réinitialise le cache — réservé aux tests (changement d'env entre cas). */
export function _reinitialiserConfigOmniFi(): void {
  cache = undefined;
}
