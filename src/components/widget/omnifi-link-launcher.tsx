"use client";

/**
 * Launcher du widget natif Omni-FI — isole l'usage du hook `useOmniFILink` du
 * package officiel `@omni-fi/react-link` (vendoré dans `vendor/`, cf.
 * SECURITY_VENDORING.md). Chargé via `next/dynamic` (`ssr:false`) par
 * `bank-connect-widget.tsx` car le hook touche `window.OmniFI` / charge un script
 * CDN : il ne peut pas s'exécuter côté serveur.
 *
 * Contrat (types réels du package + README) :
 *   - `useOmniFILink(config)` : hook ; `config.token` = LinkToken serveur.
 *   - `onSuccess(payload)` : appelé UNE FOIS, quand l'utilisateur termine le
 *     parcours (clic « Finish » de l'écran Account-Select). `payload.connections[]`
 *     porte chaque connexion `{ publicToken, connectionId, … }`. C'est LE signal de
 *     finalisation (≠ `omni-fi:connection-linked`, event INTERMÉDIAIRE par banque,
 *     émis AVANT « Finish » — ne PAS l'utiliser pour finaliser/fermer, sinon on
 *     détruit le widget pendant que l'utilisateur est encore dessus).
 *   - `onExit()` : l'utilisateur a FERMÉ le widget (annulation) — aucun argument.
 *   - `onError({ code, message })` : le widget/la banque a ÉCHOUÉ. Distinct de
 *     `onExit` : aliaser les deux sur le même handler faisait disparaître l'échec
 *     en silence (bug corrigé le 2026-07-13). Un échec PARLE, une annulation non.
 *   - `config.env` pilote le CDN ; dérivé de NEXT_PUBLIC_OMNIFI_ENV.
 *   - Attendre `isReady` avant `open()`.
 *
 * Sécurité : le publicToken n'est jamais loggé ici ; il part vers la Server Action
 * de finalisation (règle 8).
 */
import { useCallback, useEffect, useRef } from "react";

import {
  useOmniFILink,
  type OmniFIConnection,
  type OmniFIEnv,
  type OmniFIError,
  type OmniFISuccessPayload,
} from "@omni-fi/react-link";

/** Normalise le payload de `onSuccess` en LISTE de connexions (interne). */
function connexionsDepuisPayload(
  payload: OmniFISuccessPayload | OmniFIConnection[],
): OmniFIConnection[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.connections) ? payload.connections : [];
}

/**
 * Extrait les PublicTokens valides du payload `onSuccess`, quelle que soit la forme
 * que le CDN nous envoie. Fonction PURE (testée) — toute la robustesse du contrat
 * externe instable est ici, pas dans le composant React.
 *
 * ⚠️ DIVERGENCE CONTRAT SDK (vérifiée runtime 2026-06-19, cf. OMNIFI_API_FEEDBACK.md) :
 * les TYPES et le README vendorés (`@omni-fi/react-link`) déclarent
 * `OmniFISuccessPayload = { connections: OmniFIConnection[] }` (un OBJET), MAIS le
 * loader CDN déployé (`omni-fi-connect.js`, `e.onSuccess(n.connections)`) passe le
 * TABLEAU NU. Notre code suivait les types → `payload.connections` était `undefined`
 * → `TypeError: Cannot read properties of undefined (reading 'map')`, le widget
 * restait bloqué sur « Finishing… ».
 *
 * Trois niveaux de tolérance, parce que le contrat amont n'est pas stable :
 *  1. forme du conteneur : tableau nu OU `{ connections }` ;
 *  2. élément dégénéré : `c?.publicToken` — un élément null/undefined ne fait pas crasher ;
 *  3. token invalide : on ne garde que les strings non vides.
 * Aucun de ces cas ne doit jeter (sinon retour du blocage « Finishing… »).
 */
export function publicTokensDepuisPayload(
  payload: OmniFISuccessPayload | OmniFIConnection[],
): string[] {
  return connexionsDepuisPayload(payload)
    .map((c) => c?.publicToken)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

/** Échec du widget, normalisé : `code` pour le LOG, `message` (FR) pour l'UI. */
export interface ErreurWidget {
  /** Code machine, FORME VALIDÉE (cf. `FORME_CODE`) — sûr à logger. Jamais affiché. */
  code: string;
  /** Message FR mappé, non-énumérant, sans PII — le SEUL texte affichable. */
  message: string;
}

/** Le CDN émet lui-même cette valeur en repli (`t.code || "UNKNOWN"`). */
const CODE_INCONNU = "UNKNOWN";

/**
 * Code INTERNE (jamais émis par le CDN, et pour cause) : le SCRIPT du widget n'a pas
 * pu être chargé — 403 sur le bundle, CSP, bloqueur de pub, hors-ligne, panne CDN.
 * Chemin d'échec radicalement différent de `onError` : le CDN n'est pas là, il ne
 * peut donc rien nous émettre. Sans relais explicite, l'attente est INFINIE et MUETTE.
 */
const CODE_SDK_INDISPONIBLE = "SDK_SCRIPT_LOAD_FAILED";

/**
 * Le champ `code` n'avait pas la forme d'un code machine. On ne le propage PAS
 * (il pourrait porter du texte amont, donc de la PII — règle 8) : on lui substitue
 * ce marqueur, qui est ce qui sera loggé à sa place.
 */
const CODE_NON_CONFORME = "CODE_NON_CONFORME";

/** Forme d'un code machine Omni-FI (`LINK_TOKEN_EXPIRED`, `INSTITUTION_LOCKED`…). */
const FORME_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Délai au-delà duquel on déclare le SDK indisponible (cf. watchdog). Généreux à dessein :
 * il ne doit JAMAIS se déclencher sur une connexion simplement lente — seulement quand le
 * script ne viendra plus. Le CDN sert ~6 Ko.
 */
const DELAI_CHARGEMENT_SDK_MS = 15_000;

const LIEN_EXPIRE =
  "La session de connexion a expiré. Recommencez la connexion.";
const SESSION_EXPIREE =
  "La session de connexion a expiré (inactivité). Recommencez la connexion.";
const FINALISATION_IMPOSSIBLE =
  "La connexion n’a pas pu être finalisée. Réessayez.";
const BANQUE_INDISPONIBLE = "Cette banque n’est pas disponible pour le moment.";

/**
 * Échec d'AUTHENTIFICATION à la banque (`LOGIN_FAILED`). Le message couvre
 * VOLONTAIREMENT les deux causes, parce que l'amont les confond sous un seul code :
 * des identifiants refusés au login ET le 3e code de vérification erroné
 * (`docs/documentation_api.md` : « Le 3e mauvais code fait passer Status → FAILED
 * avec erreur LOGIN_FAILED »). Dire « identifiants incorrects » tout court enverrait
 * l'utilisateur qui a raté son OTP vérifier un mot de passe pourtant valide.
 * Non-énumérant : on ne dit PAS laquelle des deux est en cause (on ne le sait pas,
 * et le savoir ne doit pas se déduire de l'UI).
 */
const IDENTIFIANTS_REFUSES =
  "La banque a refusé la connexion : identifiants ou code de vérification incorrects. Vérifiez-les et recommencez.";

/** Le code MFA n'est jamais arrivé / n'a pas été saisi à temps (`MFA_TIMEOUT`). */
const DELAI_CODE_EXPIRE =
  "Le délai de saisie du code de vérification est dépassé. Recommencez la connexion.";

/**
 * Panne du côté de la chaîne de récupération (scraper, traitement, coffre à
 * identifiants) : l'utilisateur n'y peut RIEN et aucune re-saisie ne l'aidera.
 *
 * ⚠️ « Réessayez PLUS TARD », surtout pas le « dans un instant » du repli : un
 * connecteur cassé (`SCRAPER_UI_CHANGE` = la banque a changé son HTML) exige un
 * correctif Omni-FI, pas une nouvelle tentative immédiate. Même logique que
 * `CODE_SDK_INDISPONIBLE` plus bas : le message doit nommer la seule action qui a
 * une chance d'aboutir. On n'affirme rien sur la validité des identifiants — un
 * `SCRAPER_ERROR` peut survenir avant comme après le login.
 */
const RECUPERATION_IMPOSSIBLE =
  "La connexion à votre banque n’a pas pu aboutir. Réessayez plus tard ; si le problème persiste, contactez le support.";

/** Repli — TOUT code hors registre atterrit ici (jamais de catch-all silencieux). */
const MESSAGE_PAR_DEFAUT =
  "La connexion bancaire a échoué. Réessayez dans un instant.";

/**
 * Registre S2 EXÉCUTABLE du codepath « widget natif (CDN) » : code machine →
 * message UI. Non-énumérant, sans PII, en français. Un code absent d'ici tombe sur
 * `MESSAGE_PAR_DEFAUT` — et son code part au log, donc l'angle mort est visible.
 */
const MESSAGES_PAR_CODE: Record<string, string> = {
  // Le script CDN lui-même n'a pas pu être chargé (code INTERNE, cf. ci-dessus). On ne
  // nomme ni le CDN ni l'URL : l'utilisateur n'y peut rien, on lui donne une action.
  // ⚠️ « RECHARGEZ », surtout pas « réessayez » : le hook vendoré laisse le <script> MORT
  // dans le <head> (cf. watchdog plus bas), donc un nouvel essai SANS rechargement ne peut
  // PAS aboutir — il retomberait dans l'attente infinie. Le message doit dire la seule
  // action qui marche.
  [CODE_SDK_INDISPONIBLE]:
    "Le module de connexion bancaire n’a pas pu se charger. Rechargez la page ; si le problème persiste, contactez le support.",
  // LinkToken (usage unique, courte durée) : le lien d'ouverture du widget est mort.
  LINK_TOKEN_INVALID: LIEN_EXPIRE,
  LINK_TOKEN_EXPIRED: LIEN_EXPIRE,
  LINK_TOKEN_USED: LIEN_EXPIRE,
  // SessionToken : la session INTERNE du widget a expiré / été révoquée.
  SESSION_TOKEN_INVALID: SESSION_EXPIREE,
  SESSION_TOKEN_REVOKED: SESSION_EXPIREE,
  SESSION_TOKEN_EXPIRED: SESSION_EXPIREE,
  SESSION_TOKEN_IDLE_EXPIRED: SESSION_EXPIREE,
  // PublicToken : l'échange final a échoué.
  PUBLIC_TOKEN_INVALID: FINALISATION_IMPOSSIBLE,
  PUBLIC_TOKEN_USED: FINALISATION_IMPOSSIBLE,
  PUBLIC_TOKEN_EXPIRED: FINALISATION_IMPOSSIBLE,
  // Frontière TENANT (le ClientUserId ne correspond pas). Message VOLONTAIREMENT
  // identique au cas banal : il ne doit RIEN révéler du désalignement (§3
  // « messages non-énumérants »). Le signal vit dans le log, pas dans l'UI.
  PUBLIC_TOKEN_CLIENT_MISMATCH: FINALISATION_IMPOSSIBLE,
  // Institution.
  INSTITUTION_LOCKED:
    "L’accès à cette banque est temporairement bloqué après trop de tentatives. Réessayez plus tard.",
  INSTITUTION_NOT_FOUND: BANQUE_INDISPONIBLE,
  INSTITUTION_REQUIRED: BANQUE_INDISPONIBLE,
  INSTITUTION_SANDBOX_ONLY:
    "Cette banque n’est accessible qu’en environnement de test.",
  SANDBOX_CREDENTIALS_REQUIRED:
    "Cette banque de test attend des identifiants de démonstration.",
  // Origine non autorisée : RedirectOrigin (https exigé) — erreur de configuration.
  ORIGIN_NOT_ALLOWED:
    "La connexion bancaire n’est pas autorisée depuis cette adresse.",
  VALIDATION_ERROR:
    "La connexion bancaire a été refusée (données invalides). Réessayez.",

  // ── Sync Engine — échecs TERMINAUX du job (branche `↘ FAILED`) ──────────────
  //
  // Ces codes ne viennent PAS de l'union `OmniFIErrorCode` du SDK (elle ne les
  // contient pas) : ce sont les `SyncJob.Error.Type` de l'amont, relayés tels quels
  // jusqu'ici. Deux preuves, pas une supposition :
  //  1. RUNTIME — `LOGIN_FAILED` a été observé en console le 2026-07-16 (« Absa Pro »
  //     en sandbox). Or ce code n'existe QUE comme `Error.Type` de SyncJob : le pont
  //     `job.Error.Type → onError.code` est donc établi par constat, pas déduit.
  //  2. BUNDLE — le loader CDN ne fait que RELAYER le postMessage de l'iframe
  //     (`case ERROR: onError({code: t.code || "UNKNOWN", …})`) : il ne filtre aucun
  //     code, donc tout `Error.Type` remonté par l'iframe atterrit ici.
  //
  // Liste exhaustive lue à la source (backend Django `omni-fi-core`,
  // `apps/sync_engine/orchestrator.py` — les appels `_handle_failure`), PAS inventée.
  // Le regroupement suit l'ACTION possible pour l'utilisateur, pas la taxonomie
  // amont : le CODE exact reste au log pour le diagnostic (cf. `console.warn`).
  LOGIN_FAILED: IDENTIFIANTS_REFUSES,
  MFA_TIMEOUT: DELAI_CODE_EXPIRE,
  // Scraping : UI de la banque modifiée, timeout, captcha, proxy (ces trois derniers
  // remontent tous en `SCRAPER_ERROR`, cf. les sous-classes de `ScraperError`).
  SCRAPER_UI_CHANGE: RECUPERATION_IMPOSSIBLE,
  SCRAPER_ERROR: RECUPERATION_IMPOSSIBLE,
  // Traitement aval (parsing/enrichissement/persistance) : la donnée a été atteinte
  // mais pas menée au bout.
  ETL_ERROR: RECUPERATION_IMPOSSIBLE,
  ENRICHMENT_ERROR: RECUPERATION_IMPOSSIBLE,
  PERSISTENCE_ERROR: RECUPERATION_IMPOSSIBLE,
  // Coffre à identifiants amont (survient AVANT le login, donc bien dans la fenêtre
  // où le widget est ouvert). Panne interne : même issue utilisateur.
  CREDENTIAL_NOT_FOUND: RECUPERATION_IMPOSSIBLE,
  CREDENTIAL_ERROR: RECUPERATION_IMPOSSIBLE,
  KMS_ERROR: RECUPERATION_IMPOSSIBLE,
  //
  // `UNKNOWN_ERROR` (le fourre-tout `except Exception` de l'orchestrateur) est
  // DÉLIBÉRÉMENT absent : le repli dit déjà exactement ce qu'on saurait en dire, et
  // le laisser hors registre garde l'angle mort VISIBLE (message générique + code au
  // log) au lieu de le maquiller en cas traité. Verrouillé par un test.
};

/**
 * Extrait un code machine SÛR du payload d'erreur du CDN. Deux gardes :
 *  1. la valeur doit venir de `.code` d'un objet (contrat CDN vérifié) ;
 *  2. elle doit avoir la FORME d'un code machine — sinon on la remplace par
 *     `CODE_NON_CONFORME`. Cette 2e garde est ce qui protège le LOG : sans elle,
 *     un `code` qui contiendrait en réalité du texte amont (libellé bancaire →
 *     PII) serait journalisé (règle 8).
 */
function codeErreurWidget(erreur: unknown): string {
  if (typeof erreur !== "object" || erreur === null) return CODE_INCONNU;
  const brut = (erreur as { code?: unknown }).code;
  if (typeof brut !== "string" || brut.length === 0) return CODE_INCONNU;
  return FORME_CODE.test(brut) ? brut : CODE_NON_CONFORME;
}

/**
 * Traduit l'échec du widget en message affichable. Fonction PURE (testée) — comme
 * `publicTokensDepuisPayload`, toute la robustesse face au contrat externe instable
 * est ici, pas dans le composant React.
 *
 * ⚠️ DIVERGENCE CONTRAT SDK (vérifiée runtime 2026-07-13 sur le bundle déployé
 * `staging-cdn.omni-fi.co/v1/omni-fi-connect.js`) :
 *
 *   onError({ code: t.code || "UNKNOWN", message: t.message || "An error occurred" })
 *
 * Deux pièges que le `.d.ts` vendoré CACHE :
 *  1. `OmniFIErrorCode` est un faux type « fermé » : le CDN émet `"UNKNOWN"`, qui
 *     n'appartient PAS à l'union. Un `switch` exhaustif sur l'union compilerait,
 *     passerait `tsc`… et renverrait `undefined` en PRODUCTION — soit le retour du
 *     bug d'origine (échec muet). D'où : entrée `unknown`, table `Record<string, …>`,
 *     et une branche par défaut OBLIGATOIRE.
 *  2. `message` est un texte AMONT, en anglais, potentiellement porteur de PII
 *     (libellé bancaire) : il n'est ni affiché, ni loggé, ni recopié. On mappe le CODE.
 *
 * Ne jette JAMAIS : une exception dans `onError` laisserait le widget se fermer en
 * silence — exactement le défaut qu'on corrige.
 */
export function messageErreurWidget(erreur: unknown): ErreurWidget {
  const code = codeErreurWidget(erreur);
  // `Object.hasOwn` et pas un accès indexé nu : `MESSAGES_PAR_CODE["constructor"]`
  // rendrait une FONCTION héritée du prototype (donc un `message` qui n'est pas une
  // chaîne). `FORME_CODE` l'exclut déjà — aucune clé d'`Object.prototype` ne commence
  // par une majuscule — mais une garde de sécurité ne doit pas dépendre du détail
  // d'une regex qu'on pourrait assouplir demain. Deux gardes, comme ailleurs au projet.
  const message = Object.hasOwn(MESSAGES_PAR_CODE, code)
    ? MESSAGES_PAR_CODE[code]
    : MESSAGE_PAR_DEFAUT;
  return { code, message };
}

/**
 * Environnement CDN du widget (NEXT_PUBLIC_OMNIFI_ENV : "staging" pour le sandbox
 * de démo, "production" par défaut). Validé ici pour ne passer au hook qu'une des
 * valeurs attendues (sinon on omet → défaut "production" du package).
 */
function envWidget(): OmniFIEnv | undefined {
  const v = process.env.NEXT_PUBLIC_OMNIFI_ENV;
  return v === "staging" || v === "development" || v === "production"
    ? v
    : undefined;
}

export function OmniFiLinkLauncher({
  token,
  onConnexions,
  onExit,
  onErreur,
}: {
  /** LinkToken serveur (usage unique) injecté dans le hook. */
  token: string;
  /** Connexions abouties → liste des publicToken à finaliser côté serveur. */
  onConnexions: (publicTokens: string[]) => void;
  /**
   * ANNULATION : l'utilisateur a fermé le widget de lui-même. Silence légitime —
   * le parent démonte le launcher et réarme, sans rien afficher.
   */
  onExit: () => void;
  /**
   * ÉCHEC : le widget/la banque a refusé. À NE PAS confondre avec `onExit` — les
   * aliaser sur le même handler est précisément le bug corrigé ici (l'échec devenait
   * une fermeture muette). Le parent AFFICHE `message` et réarme pour un nouvel essai.
   */
  onErreur: (erreur: ErreurWidget) => void;
}) {
  const { open, isReady, error } = useOmniFILink({
    token,
    env: envWidget(),
    onSuccess: (payload: OmniFISuccessPayload | OmniFIConnection[]) => {
      // Signal de fin (clic « Finish ») : on remonte les publicToken (jamais loggés)
      // à la finalisation serveur. Le payload peut porter PLUSIEURS banques.
      // Le handshake `parentOrigin` (qui empêchait ce callback en sandbox) est
      // RÉSOLU côté CDN (ready/ack, vérifié runtime 2026-06-19). Toute la tolérance
      // de forme/robustesse est dans la fonction pure testée `publicTokensDepuisPayload`.
      const tokens = publicTokensDepuisPayload(payload);
      if (tokens.length > 0) onConnexions(tokens);
    },
    onExit,
    onError: (erreur: OmniFIError) => {
      // Le type annonce `OmniFIError` ; le RUNTIME peut mentir (cf. messageErreurWidget).
      // On ne fait donc confiance à rien : la fonction pure normalise et mappe.
      const normalisee = messageErreurWidget(erreur);
      // Observabilité : le CODE seul, dont la FORME est validée. Jamais le message
      // amont (anglais, PII possible), jamais l'identifiant de la banque (règle 8).
      console.warn(`[widget Omni-FI] échec ${normalisee.code}`);
      onErreur(normalisee);
    },
  });

  // `onErreur` est une closure RECRÉÉE à chaque rendu du parent. La mettre en dépendance
  // d'un effet qui appelle `open()` serait un piège : `open()` DÉTRUIT puis reconnecte le
  // widget (`instanceRef.destroy()` + `OmniFI.connect()`), donc l'effet se rejouerait à
  // chaque rendu et recréerait le widget en boucle sous l'utilisateur. On lit le callback
  // via une ref stable, et les effets ne dépendent que de signaux réels.
  const onErreurRef = useRef(onErreur);
  useEffect(() => {
    onErreurRef.current = onErreur;
  }, [onErreur]);

  const echecSignale = useRef(false);

  /**
   * Le SDK est indisponible. UN seul point de sortie pour les TROIS chemins qui y mènent
   * (script en échec, script qui ne vient jamais, SDK absent après « load »), et au plus
   * UNE notification par montage.
   */
  const signalerSdkIndisponible = useCallback(() => {
    if (echecSignale.current) return;
    echecSignale.current = true;
    const normalisee = messageErreurWidget({ code: CODE_SDK_INDISPONIBLE });
    console.warn(`[widget Omni-FI] échec ${normalisee.code}`);
    onErreurRef.current(normalisee);
  }, []);

  // Ouverture programmatique dès que le script CDN est prêt.
  useEffect(() => {
    if (!isReady) return;
    try {
      open();
    } catch {
      // `open()` JETTE si `window.OmniFI` est absent alors que le script a « chargé »
      // (`dist/index.js:104`). Cas réel : un PORTAIL CAPTIF (wifi d'hôtel/entreprise)
      // répond à `<script src>` par sa page de login en HTTP 200 → l'événement `load`
      // part, `isReady` passe à true, mais rien n'a installé le SDK. Sans ce filet,
      // l'exception remonte à l'error boundary : écran d'erreur GLOBAL au lieu d'un
      // message réarmable. Même issue utilisateur que l'échec de chargement.
      signalerSdkIndisponible();
    }
  }, [isReady, open, signalerSdkIndisponible]);

  // CHEMIN 1 — le script a explicitement ÉCHOUÉ. Le hook le signale par `error`, et NON
  // par `onError` : ce dernier appartient au CDN, qui n'est jamais arrivé. Ce relais parle
  // VITE (pas d'attente du watchdog), mais il ne parle qu'au PREMIER échec de la page —
  // d'où le chemin 2.
  useEffect(() => {
    if (error) signalerSdkIndisponible();
  }, [error, signalerSdkIndisponible]);

  // CHEMIN 2 — WATCHDOG : le filet qui ne dépend d'AUCUN événement amont, et la seule
  // garde qui tienne au 2e essai.
  //
  // Pourquoi le relais sur `error` ne suffit pas : le hook vendoré n'enlève JAMAIS le
  // <script> du <head> (`dist/index.js:78-96` — son cleanup ne fait que
  // `removeEventListener`). Au montage SUIVANT, son `querySelector` retrouve le script
  // MORT et lui attache ses écouteurs : un <script> qui a déjà émis `error` n'émettra
  // plus jamais rien. Donc `isReady` reste `false` ET `error` reste `null` → le relais
  // ci-dessus ne se déclenche PLUS. Sans ce watchdog, le 2e essai retombe dans l'attente
  // infinie et muette d'origine — au moment précis où l'utilisateur suit notre consigne.
  //
  // Il rattrape aussi deux cas qu'AUCUN événement ne signale : la requête GELÉE (blackhole
  // réseau : ni `load` ni `error`, jamais) et le bloqueur qui drop la requête en silence.
  //
  // ⚠️ BORNÉ À LA PHASE DE CHARGEMENT (`if (isReady) return`) — ce n'est pas un détail, c'est
  // LA propriété de sûreté. Un watchdog qui courrait après l'ouverture pourrait tuer un widget
  // légitimement ouvert PENDANT que l'utilisateur saisit ses identifiants bancaires. Une fois
  // `isReady` vrai, aucun minuteur ne tourne. NE JAMAIS étendre ce watchdog au-delà d'`open()`.
  useEffect(() => {
    if (isReady) return;
    const minuteur = setTimeout(signalerSdkIndisponible, DELAI_CHARGEMENT_SDK_MS);
    return () => clearTimeout(minuteur);
  }, [isReady, signalerSdkIndisponible]);

  if (!isReady) {
    return (
      <p className="text-sm text-text-muted">Ouverture de la connexion bancaire…</p>
    );
  }
  return null;
}
