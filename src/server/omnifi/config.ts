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
 * Hôtes de PRODUCTION Omni-FI (sous-ensemble de l'allow-list). Sert au verrou
 * sandbox (ci-dessous) ET à la garde de cohérence env↔hôte : un OMNIFI_ENV=sandbox
 * pointant un hôte de prod (ou l'inverse) est une mauvaise configuration, refusée
 * fail-closed. `api-stage` / `stage` sont pré-prod (sandbox). Garder cette liste à
 * jour si Omni-FI ajoute un hôte de prod.
 */
const HOTES_PRODUCTION = new Set(["api.omni-fi.co"]);

/**
 * 🔒 VERROU SANDBOX (exigence tuteur, 2026-06-22) — fail-closed STRUCTUREL.
 * Tant que ce drapeau vaut `true`, l'application REFUSE de démarrer le client
 * Omni-FI en production : ni `OMNIFI_ENV=production`, ni un hôte de prod ne sont
 * tolérés, quel que soit le `.env`. C'est volontairement un garde-fou CODE (pas une
 * simple convention d'env) : un `.env` mal réglé ne peut pas taper la prod par
 * accident pendant la phase de recette.
 *
 * ➡️ PASSAGE EN PRODUCTION (plus tard) : basculer cette constante à `false` dans une
 * PR DÉDIÉE et REVUE (Human-in-the-Loop) — c'est un changement à une ligne, traçable,
 * jamais un retrait d'allow-list destructif. La garde de cohérence env↔hôte et la
 * validation anti-fuite de secret restent actives dans les deux cas.
 */
const SANDBOX_UNIQUEMENT = true;

/**
 * Valide OMNIFI_BASE_URL contre une fuite de secret (constat sécurité S1) :
 * `startsWith("https://")` est contournable (`https://x\t@evil/` → host evil).
 * On parse réellement l'URL et on exige : protocole https, AUCUN userinfo
 * (user:pass@ détournerait le host), hôte dans l'allow-list. Renvoie l'URL
 * normalisée (origin + path sans slash final) ET le hostname (pour les gardes
 * env↔hôte et sandbox de lireConfig).
 */
function validerBaseUrl(brut: string): { baseUrl: string; hostname: string } {
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
  return {
    baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ""),
    hostname: url.hostname,
  };
}

function lireConfig(): OmniFiConfig {
  const environment = exiger("OMNIFI_ENV");
  if (environment !== "sandbox" && environment !== "production") {
    throw new OmniFiConfigError(
      `OMNIFI_ENV invalide ("${environment}") : attendu "sandbox" ou "production"`,
    );
  }

  const { baseUrl, hostname } = validerBaseUrl(exiger("OMNIFI_BASE_URL"));
  const hoteEstProd = HOTES_PRODUCTION.has(hostname);

  // 🔒 VERROU SANDBOX (fail-closed) : pendant la phase de recette, AUCUN chemin de
  // prod n'est toléré — ni l'env, ni l'hôte. Refus bruyant (erreur de déploiement).
  if (SANDBOX_UNIQUEMENT) {
    if (environment === "production") {
      throw new OmniFiConfigError(
        'Verrou sandbox actif : OMNIFI_ENV="production" interdit (recette sandbox ' +
          "uniquement). Voir SANDBOX_UNIQUEMENT dans config.ts pour le passage en prod.",
      );
    }
    if (hoteEstProd) {
      throw new OmniFiConfigError(
        `Verrou sandbox actif : l'hôte de production (${hostname}) est interdit. ` +
          "Utiliser un hôte sandbox (api-stage.omni-fi.co / stage.omni-fi.co).",
      );
    }
  }

  // Garde de COHÉRENCE env↔hôte (active même hors verrou) : un env qui ment sur la
  // cible est une mauvaise config → fail-closed (évite « je crois être en sandbox
  // mais je tape la prod » et réciproquement).
  if (environment === "sandbox" && hoteEstProd) {
    throw new OmniFiConfigError(
      `Incohérence : OMNIFI_ENV="sandbox" mais l'hôte ${hostname} est un hôte de ` +
        "production. Pointer un hôte sandbox, ou corriger OMNIFI_ENV.",
    );
  }
  if (environment === "production" && !hoteEstProd) {
    throw new OmniFiConfigError(
      `Incohérence : OMNIFI_ENV="production" mais l'hôte ${hostname} n'est pas un ` +
        "hôte de production. Corriger OMNIFI_BASE_URL ou OMNIFI_ENV.",
    );
  }

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
