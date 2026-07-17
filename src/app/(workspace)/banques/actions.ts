"use server";

/**
 * Server Actions du flux Link Widget (PR-W2) — démarrer/finaliser une connexion
 * bancaire. Elles câblent session + withWorkspace + orchestration scopée
 * (`src/server/widget/orchestration.ts`) ; elles ne touchent jamais la DB ni le
 * client Omni-FI directement hors de l'orchestration.
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionSansPerimetre + withWorkspace (membership re-validée) ;
 *   gating MANAGER/ADMIN porté par l'orchestration (ctx.role). VIEWER → refus.
 *   ⚠️ Session AMPUTÉE du viewFilter (TOOLBAR-PERIMETRE-AMPUTATION1) : `/banques` est une
 *   surface de GESTION tenant-wide (une connexion attache les comptes de N entités). Sous
 *   une session complète, un filtre résiduel fait attacher 0 compte au sync SANS erreur
 *   (WITH CHECK) — le bug « spinner puis rien ». Les droits durs (tenant/entity/account)
 *   restent posés : la sécurité est inchangée, on ne retire que l'intention d'affichage.
 * - Validation zod stricte des entrées (RedirectOrigin https, tokens bornés).
 * - Erreurs nommées → messages non-énumérants (registre S2). Catch-all interdit.
 * - A1 (cross-review PR-W1) : on ne logge JAMAIS l'erreur avec ses arguments
 *   (publicToken/sessionToken sont sensibles). On mappe par type, sans payload.
 */
import { z } from "zod";

import { exigerSessionSansPerimetre } from "@/server/auth/session";
import { withWorkspace } from "@/server/db";
import { WorkspaceAccessDeniedError } from "@/server/db/tenancy";
import { creerClientOmniFi, OmniFiApiError } from "@/server/omnifi";
import {
  ConnexionNonAutoriseeError,
  ConsentAccountUnknownError,
  ReparationContexteInvalideError,
  WorkspaceSansClientUserIdError,
  demarrerConnexion,
  demarrerReparation,
  finaliserConnexionsDropin,
  resynchroniserConnexion,
  selectionnerComptes,
  synchroniserConnexionsDepuisOmnifi,
} from "@/server/widget/orchestration";
import {
  messageAucuneConnexion,
  supplementsDesync,
} from "@/server/widget/messages-sync";
import { demanderIngestionSync } from "@/server/inngest/emission";
import { autoriserRedirectOrigin } from "@/server/widget/redirect-origin";

export interface EtatDemarrage {
  erreur: string | null;
  linkToken: string | null;
}

export interface EtatFinalisation {
  erreur: string | null;
  succes: string | null;
  /**
   * INFORMATION actionnable — troisième registre, distinct des deux autres : rien n'a
   * échoué (≠ `erreur`, jamais de rouge) et rien n'a réussi non plus (≠ `succes`, jamais
   * de vert). Porte les désynchronisations base ↔ Omni-FI et le cas « aucune banque à
   * synchroniser », qui étaient jusqu'ici renvoyés en SILENCE (`{erreur:null, succes:null}`
   * → spinner puis rien). Absent quand il n'y a rien à signaler.
   */
  info?: string | null;
  /**
   * Succès TOTAL de la finalisation : `true` ssi zéro échec lors de la
   * découverte/synchronisation des comptes (toutes les connexions du payload ont
   * été échangées et persistées), `false` en cas de succès PARTIEL (≥ 1 échec).
   * Le Front l'utilise pour déclencher la redirection auto vers le Dashboard
   * UNIQUEMENT sur un succès total (WIDGET-RD1) — ne jamais rediriger sur un
   * partiel masquerait un échec. Optionnel/absent quand la notion n'a pas de sens
   * (rejet de forme, erreur, ou synchro idempotente `GET /connections`).
   */
  complet?: boolean;
  /**
   * SYNCHRONISATION INCOMPLÈTE : ≥1 banque dont le job de scraping tournait ENCORE quand
   * le plafond de polling a été atteint (un scrape bancaire peut durer plusieurs minutes).
   * Les transactions DÉJÀ disponibles ont été importées — mais il en manque probablement.
   *
   * Ni une erreur (rien n'a planté, on a ramené des données), ni un succès plein :
   * annoncer « Comptes à jour » ici serait un FAUX MESSAGE DE VICTOIRE (c'était le bug —
   * l'UI affichait le succès sur `comptesRattaches > 0` avec `transactionsImportees: 0`).
   * L'UI doit inviter à RELANCER. Absent quand tout est complet.
   */
  incomplet?: boolean;
  /**
   * Nombre de banques en ÉCHEC DUR sur ce passage (job FAILED, 4xx/5xx, panne réseau) —
   * fail-soft : les autres banques ont été synchronisées.
   *
   * Signal STRUCTURÉ, et pas seulement une phrase dans `succes` : le dashboard ne lisait
   * pas le message (il affichait « Comptes à jour. » en dur dès que `succes` était non
   * nul), donc une banque en `SCRAPER_ERROR` ressortait en VERT. Un consommateur doit
   * pouvoir décider de son REGISTRE sans parser du texte — cf. `registreSynchro`.
   * Absent quand aucune banque n'a échoué.
   */
  echecs?: number;
  /**
   * Connexions dont le re-sync exige une RÉPARATION MFA (le scraping a redemandé un
   * OTP). Signal pour que l'UI rouvre le widget natif `@omni-fi/react-link` en mode
   * REPAIR (link-token portant ConnectionId + JobId) — on ne pilote PAS la MFA côté
   * serveur. Absent/omis quand aucune connexion n'est concernée. Non-énumérant : ne
   * porte que des identifiants opaques Omni-FI (ni libellé bancaire ni token).
   */
  reparation?: Array<{ connectionId: string; jobId: string }>;
  /**
   * Connexions non re-synchronisées car en cooldown (« 1 sync / 15 min ») — PAS une
   * erreur. `nextSyncAt` = ISO 8601 du prochain sync possible (ou null si inconnu) ;
   * l'UI affiche le délai d'attente. Absent/omis quand aucune connexion n'est en
   * cooldown.
   */
  rateLimited?: Array<{ connectionId: string; nextSyncAt: string | null }>;
  /**
   * Connexions dont l'EndUser/credential est DÉSALIGNÉ côté Omni-FI (403
   * `PUBLIC_TOKEN_CLIENT_MISMATCH`) : le lien banque n'est plus rattachable à ce
   * workspace. DISTINCT d'un échec générique (`echecs`) et de la réparation MFA
   * (`reparation`) : ici la synchro « réussit » en apparence mais ne remonte plus
   * rien — l'utilisateur doit RECONNECTER la banque (nouveau parcours de connexion).
   * L'UI affiche une invite dédiée « Reconnecter cette banque ». Absent/omis quand
   * aucune connexion n'est concernée. Non-énumérant : identifiant opaque Omni-FI
   * uniquement (ni libellé bancaire ni token).
   */
  aReconnecter?: Array<{ connectionId: string }>;
}

const MESSAGE_REFUS = "Action non autorisée.";
const MESSAGE_GENERIQUE = "La connexion bancaire a échoué. Réessayez.";
// Échec de TOUTES les connexions lors d'une synchro (aucune n'a abouti). Distinct du
// message d'exception générique : ici on a bien tenté chaque connexion, toutes ont
// échoué (fail-soft). Non-énumérant (ne nomme ni banque ni cause).
const MESSAGE_SYNC_TOUT_ECHOUE =
  "La synchronisation a échoué pour toutes vos banques. Réessayez dans un instant.";
const MESSAGE_CONFIG = "Workspace non configuré pour Omni-FI.";
// Message DISTINCT du « paramètres invalides » générique (Volet B) : le rejet le
// plus courant n'est pas une malformation mais une origine non sécurisée/non
// autorisée. Reste non-énumérant (registre S2) : il ne révèle pas l'allowlist.
const MESSAGE_ORIGINE = "Origine sécurisée non autorisée pour la connexion bancaire.";

/**
 * Schéma de FORME seulement (string/url/longueur). L'AUTORISATION (https/dev/
 * allowlist) est décidée séparément par `autoriserRedirectOrigin` (module pur
 * `@/server/widget/redirect-origin`) dans l'action, pour pouvoir distinguer et
 * logger le motif de rejet (Volet B) — un fichier `"use server"` ne peut exporter
 * que des Server Actions, d'où l'extraction de la logique testable dans un module.
 */
const demarrageSchema = z
  .object({
    redirectOrigin: z.string().url().max(255),
    institutionId: z.string().trim().max(64).optional(),
  })
  .strict();

/**
 * Démarre une connexion : retourne un LinkToken pour initialiser le widget.
 * Le ClientUserId vient du workspace (frontière tenant), jamais du client.
 */
export async function demarrerConnexionAction(
  _etat: EtatDemarrage,
  formData: FormData,
): Promise<EtatDemarrage> {
  const session = await exigerSessionSansPerimetre();

  const parsed = demarrageSchema.safeParse({
    redirectOrigin: formData.get("redirectOrigin"),
    institutionId: formData.get("institutionId") ?? undefined,
  });
  if (!parsed.success) {
    // Malformation pure (champ absent, pas une URL, trop long) : reste générique.
    logRejetDemarrage(session.activeWorkspaceId, "forme");
    return { erreur: "Paramètres invalides.", linkToken: null };
  }

  // Autorisation de l'origine (Volet B/C) : motif loggé côté serveur, message UI
  // distinct et parlant mais non-énumérant.
  const motif = autoriserRedirectOrigin(parsed.data.redirectOrigin);
  if (motif !== "ok") {
    logRejetDemarrage(session.activeWorkspaceId, motif);
    return { erreur: MESSAGE_ORIGINE, linkToken: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await demarrerConnexion(client, executer, {
      redirectOrigin: parsed.data.redirectOrigin,
      institutionId: parsed.data.institutionId,
    });
    return { erreur: null, linkToken: r.linkToken };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "demarrer"),
      linkToken: null,
    };
  }
}

/**
 * Entrée du widget DROP-IN (hook `useOmniFILink`) : `onSuccess` remonte les
 * connexions abouties → le composant (après normalisation de la forme du payload,
 * cf. `omnifi-link-launcher.tsx`) nous transmet la LISTE des PublicTokens (un par
 * connexion). On borne la liste (1..20 connexions, tokens bornés) pour ne pas
 * accepter de payload non contrôlé.
 */
const dropinSchema = z
  .object({
    publicTokens: z.array(z.string().min(1).max(512)).min(1).max(20),
  })
  .strict();

/**
 * Finalisation pour le widget natif @omni-fi/react-link (hook). Reçoit les PublicTokens
 * de `onSuccess` (le payload peut porter plusieurs connexions), échange chacun
 * (ApiKey) et découvre les comptes via GET /accounts (ApiKey, sans SessionToken).
 * Appelée directement depuis le composant client.
 */
export async function finaliserConnexionDropinAction(
  publicTokens: string[],
): Promise<EtatFinalisation> {
  const session = await exigerSessionSansPerimetre();

  const parsed = dropinSchema.safeParse({ publicTokens });
  if (!parsed.success) {
    // Rejet de forme de la finalisation (liste vide/hors bornes/token trop long) :
    // tracé pour ne pas être invisible (Volet B), message UI inchangé.
    console.warn(
      JSON.stringify({
        evt: "widget_finalisation_rejet",
        action: "finaliser-dropin",
        workspaceId: session.activeWorkspaceId,
      }),
    );
    return { erreur: "Paramètres invalides.", succes: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await finaliserConnexionsDropin(
      client,
      executer,
      parsed.data.publicTokens,
    );
    // Succès partiel possible : on rattache ce qui a réussi et on signale le reste
    // sans énumérer (registre S2) — le détail des échecs est tracé côté serveur.
    const base = `Connexion établie — ${r.comptesRattaches} compte(s) rattaché(s) sur ${r.reussies.length} banque(s).`;
    const succes =
      r.echecs > 0 ? `${base} ${r.echecs} connexion(s) n'ont pas pu être finalisées.` : base;
    // WIDGET-RD1 : drapeau de succès TOTAL. `echecs` est le nb de publicTokens
    // reçus n'ayant pas pu être finalisés (cf. ResultatConnexionMulti). Zéro échec
    // = succès complet → le Front peut rediriger ; sinon partiel → il reste sur place.
    //
    // `echecs` est publié EN PLUS de `complet` : ce sont deux consommateurs distincts
    // (`complet` pilote la redirection, `echecs` interdit le vert). L'omettre laissait le
    // registre voir « zéro réserve » sur une finalisation partielle — le piège du sous-type
    // structurel, côté PRODUCTEUR cette fois (revue PR #202, C6).
    return {
      erreur: null,
      succes,
      complet: r.echecs === 0,
      ...(r.echecs > 0 ? { echecs: r.echecs } : {}),
    };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "finaliser-dropin"),
      succes: null,
    };
  }
}

/**
 * Synchronise les connexions du workspace en lisant l'état réel côté Omni-FI
 * (`GET /connections`), SANS dépendre du PublicToken/postMessage du widget — qui est
 * cassé en sandbox (cf. OMNIFI_API_FEEDBACK.md §5/§6). Appelée à la fermeture du
 * widget (le widget a déjà persisté la connexion côté Omni-FI). Idempotente.
 */
export async function synchroniserConnexionsAction(): Promise<EtatFinalisation> {
  const session = await exigerSessionSansPerimetre();

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await synchroniserConnexionsDepuisOmnifi(client, executer);

    // DIAGNOSTIC (« spinner puis rien ») — récapitulatif du résultat, + le `viewFilter`
    // de la SESSION, qui n'est pas visible depuis l'orchestration (il est consommé dans
    // la transaction). C'est l'INTENTION du sélecteur de périmètre : s'il est actif, le
    // sync écrit sous la clause `view_filter` de la policy `account_scope` (RESTRICTIVE,
    // USING **et** WITH CHECK) → `bank_accounts` devient inaccessible en écriture hors du
    // filtre, et `comptesRattaches` tombe à 0 SANS erreur. À corréler avec `sync_diag`.
    console.info(
      JSON.stringify({
        evt: "sync_resultat",
        workspaceId: session.activeWorkspaceId,
        viewFilterActif: session.viewFilter?.length ?? 0,
        connexions: r.connexions,
        echecs: r.echecs,
        comptesRattaches: r.comptesRattaches,
        transactionsImportees: r.transactionsImportees,
        aReconnecter: r.aReconnecter.length,
        rateLimited: r.rateLimited.length,
        aReparer: r.aReparer.length,
        // Banques dont le scrape tournait encore au plafond : explique un
        // `transactionsImportees` partiel sans qu'on ait à deviner (valeurs d'énumération
        // amont, jamais de PII).
        incompletes: r.incompletes.length,
        statutsIncomplets: r.incompletes.map((c) => c.dernierStatut),
      }),
    );

    // RELAIS DURABLE (lot W1, PLAN-ingestion-webhook-omnifi.md §6.2) : chaque
    // banque dont le scrape courait ENCORE au plafond de polling est confiée au
    // job Inngest `omnifi/sync.ingest.requested`, qui attend la fin du scrape
    // HORS du budget de cette Server Action puis ingère le reste — plus besoin
    // de re-cliquer (SYNC-WEBHOOK-INGEST1, côté infra). Le `workspaceId` vient
    // de la SESSION (résolution serveur — jamais un paramètre client) ; le
    // jobId est celui observé au timeout. Fail-soft : si l'émission échoue
    // (dev local sans dev server Inngest, panne), on garde l'invite à relancer
    // — ne jamais promettre un travail de fond qui n'est pas parti.
    let relaisConfies = 0;
    if (r.incompletes.length > 0) {
      const envois = await Promise.all(
        r.incompletes.map((c) =>
          demanderIngestionSync({
            workspaceId: session.activeWorkspaceId,
            omnifiConnectionId: c.connectionId,
            omnifiJobId: c.jobId,
            declencheur: "MANUAL",
          }),
        ),
      );
      relaisConfies = envois.filter(Boolean).length;
    }
    const relaisComplet =
      r.incompletes.length > 0 && relaisConfies === r.incompletes.length;

    if (r.connexions === 0) {
      // Aucune connexion TRAITÉE. Ce n'est ni une erreur (rien n'a planté) ni un succès
      // (rien n'a été synchronisé) — mais ce n'est SURTOUT PAS « rien à dire » : le
      // renvoi muet `{erreur:null, succes:null}` laissait l'utilisateur devant un spinner
      // sans réponse, alors que la cause est souvent ACTIONNABLE (une banque connectée
      // chez Omni-FI mais jamais rattachée ici, ou des banques d'ici qui ne répondent
      // plus). On le DIT, dans le registre « information » — jamais en rouge (rien n'a
      // échoué), jamais en vert (rien n'a réussi).
      return { erreur: null, succes: null, info: messageAucuneConnexion(r) };
    }

    // TOUT ÉCHOUÉ : toutes les connexions traitées ont échoué « dur » ET rien n'a été
    // rattaché → message d'ÉCHEC clair (erreur, pas un faux succès). On ne tombe ici que
    // si aucune connexion n'a réussi/cooldown/réparé. Les échecs par-connexion sont déjà
    // journalisés (orchestration), avec leur status/obieCode.
    if (r.echecs === r.connexions && r.comptesRattaches === 0) {
      // Même ici, les désyncs doivent être dites : une banque morte resterait sinon invisible
      // derrière le message d'échec, et l'utilisateur réessaierait indéfiniment une synchro
      // qui ne peut pas aboutir tant qu'il n'a pas reconnecté.
      const desyncEchec = supplementsDesync(r);
      return {
        erreur: MESSAGE_SYNC_TOUT_ECHOUE,
        succes: null,
        ...(desyncEchec ? { info: desyncEchec } : {}),
      };
    }

    // Phrase de base + suppléments. Tous NON-énumérants : on COMPTE les cas, on ne nomme
    // ni banque ni token. On exprime le succès en BANQUES (= connexions traitées sans
    // échec dur), pas en comptes : ainsi la clause de succès et la clause d'échec partagent
    // la MÊME unité (banque) et ne se contredisent jamais — éviter « 1 compte sur 1 banque »
    // + « 1 banque a échoué » (constat cross-review : comptes ≠ banques). Le nombre de
    // comptes/transactions reste un détail secondaire cohérent.
    // « À jour » exclut AUSSI les banques désalignées (`aReconnecter`) : elles n'ont
    // rien remonté (comptes silencieusement vides côté Omni-FI), donc les compter
    // comme à jour serait exactement le bug qu'on corrige. Unité BANQUE conservée.
    // MÊME raisonnement pour les banques INCOMPLÈTES (`incompletes`) : leur scrape tourne
    // ENCORE côté banque, on n'a ramené qu'une partie des transactions. Les compter « à
    // jour » serait le faux message de victoire qu'on corrige ici (prod 2026-07-13 :
    // « Comptes à jour » affiché avec 0 transaction importée).
    const banquesOk =
      r.connexions - r.echecs - r.aReconnecter.length - r.incompletes.length;
    let base = `Synchronisation effectuée — ${banquesOk} banque(s) à jour, ${r.comptesRattaches} compte(s) mis à jour.`;
    if (r.transactionsImportees > 0) {
      base += ` ${r.transactionsImportees} transaction(s) importée(s).`;
    }
    // PARTIEL : au moins une connexion a échoué mais d'autres ont réussi. On le DIT
    // (jamais « échoué » tout court, qui masquerait les succès ; jamais silencieux non
    // plus). Distinct du cooldown (pas une erreur) et de la réparation (action requise).
    if (r.echecs > 0) {
      base += ` ${r.echecs} banque(s) n'ont pas pu être synchronisées — réessayez plus tard.`;
    }
    // INCOMPLET : le scrape tourne ENCORE chez la banque (il peut durer plusieurs
    // minutes, bien au-delà de notre plafond d'attente). On a importé ce qui était déjà
    // disponible — on le DIT. Ni rouge (rien n'a échoué, on a des données) ni triomphal
    // (il en manque) : c'est le remplaçant du faux « à jour ». Deux suites possibles :
    // le relais durable est PARTI pour toutes les banques concernées → la récupération
    // se poursuit seule (W1) ; sinon (émission échouée, même partielle) → l'invite à
    // relancer reste — promettre un travail de fond non parti serait un mensonge.
    if (r.incompletes.length > 0) {
      base += relaisComplet
        ? ` ${r.incompletes.length} banque(s) sont encore en cours de synchronisation` +
          ` — les transactions déjà disponibles ont été importées ;` +
          ` la récupération du reste se poursuit automatiquement en arrière-plan.`
        : ` ${r.incompletes.length} banque(s) sont encore en cours de synchronisation` +
          ` — les transactions déjà disponibles ont été importées ;` +
          ` relancez dans quelques minutes pour récupérer le reste.`;
    }
    // DÉSALIGNEMENT ENDUSER (403) : état ACTIONNABLE distinct — on le DIT clairement et on
    // remonte le signal structuré pour que l'UI propose « Reconnecter cette banque ». Sans
    // ça, l'utilisateur voyait des comptes vides avec un last_synced_at frais (incident prod).
    if (r.aReconnecter.length > 0) {
      base += ` ${r.aReconnecter.length} banque(s) doivent être reconnectées — leur accès n'est plus valide.`;
    }
    // Cooldown : information, pas erreur. On indique le délai si on connaît la date la
    // plus proche (sinon mention générique). L'UI peut afficher un compte à rebours.
    if (r.rateLimited.length > 0) {
      const delai = messageDelaiCooldown(r.rateLimited);
      base += ` ${r.rateLimited.length} banque(s) déjà synchronisée(s) récemment${delai ? ` (nouveau rafraîchissement possible ${delai})` : ""} — dernier état affiché.`;
    }
    // Réparation MFA : on le DIT clairement et on remonte le signal structuré pour que
    // l'UI rouvre le widget natif en mode REPAIR (jamais une MFA serveur).
    if (r.aReparer.length > 0) {
      base += ` ${r.aReparer.length} banque(s) demandent une nouvelle vérification de sécurité — reconnectez-les pour terminer.`;
    }
    // Les désynchronisations se disent AUSSI quand la synchro a réussi par ailleurs : une
    // banque qui ne répond plus resterait sinon invisible derrière un message vert, avec
    // ses comptes affichés comme à jour. Canal `info` (≠ succès) : ce n'est pas une bonne
    // nouvelle, et ce n'est pas une erreur — c'est une action à mener.
    const desync = supplementsDesync(r);
    return {
      erreur: null,
      succes: base,
      ...(desync ? { info: desync } : {}),
      // Signal structuré : l'UI doit remplacer le vert « Comptes à jour » par un message
      // neutre « synchronisation incomplète, relancez ».
      ...(r.incompletes.length > 0 ? { incomplet: true } : {}),
      // Idem pour les échecs DURS : sans ce signal, le dashboard rendait un vert triomphal
      // par-dessus une banque morte (il n'affichait pas `succes`, où l'échec est pourtant
      // écrit). Le message reste la source du TEXTE ; ce compteur décide du TON.
      ...(r.echecs > 0 ? { echecs: r.echecs } : {}),
      ...(r.aReparer.length > 0 ? { reparation: r.aReparer } : {}),
      ...(r.rateLimited.length > 0 ? { rateLimited: r.rateLimited } : {}),
      ...(r.aReconnecter.length > 0
        ? { aReconnecter: r.aReconnecter.map((c) => ({ connectionId: c.connectionId })) }
        : {}),
    };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "synchroniser"),
      succes: null,
    };
  }
}

/**
 * Schéma de la demande de RÉPARATION. `connectionId`/`jobId` = identifiants opaques
 * Omni-FI (UUID) issus du signal `reparation` remonté par `synchroniserConnexionsAction`
 * (jamais saisis par l'utilisateur). `redirectOrigin` validé comme à l'onboarding (le
 * widget exige https). Bornes larges mais finies pour ne pas accepter de payload non
 * contrôlé. La FORME seulement ici ; l'autorisation d'origine est décidée à part.
 */
const reparationSchema = z
  .object({
    redirectOrigin: z.string().url().max(255),
    connectionId: z.string().trim().min(1).max(64),
    jobId: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * Crée un LinkToken de RÉPARATION (`Mode: REPAIR`) pour rouvrir le widget natif sur une
 * connexion en erreur (signal `reparation`). Le widget gère l'OTP EN INTERNE (cf. vendor
 * README §MFA handling) — on ne pilote pas la MFA côté serveur. Mêmes gardes que
 * `demarrerConnexionAction` : origine autorisée + gating MANAGER/ADMIN + ClientUserId
 * scopé + anti-IDOR (la connexion doit appartenir au workspace). Retourne `EtatDemarrage`
 * (la même forme que l'onboarding) pour que le front monte le MÊME launcher.
 */
export async function creerLinkTokenRepairAction(
  connectionId: string,
  jobId: string,
  redirectOrigin: string,
): Promise<EtatDemarrage> {
  const session = await exigerSessionSansPerimetre();

  const parsed = reparationSchema.safeParse({ redirectOrigin, connectionId, jobId });
  if (!parsed.success) {
    logRejetDemarrage(session.activeWorkspaceId, "forme");
    return { erreur: "Paramètres invalides.", linkToken: null };
  }

  const motif = autoriserRedirectOrigin(parsed.data.redirectOrigin);
  if (motif !== "ok") {
    logRejetDemarrage(session.activeWorkspaceId, motif);
    return { erreur: MESSAGE_ORIGINE, linkToken: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await demarrerReparation(client, executer, {
      redirectOrigin: parsed.data.redirectOrigin,
      connectionId: parsed.data.connectionId,
      jobId: parsed.data.jobId,
    });
    return { erreur: null, linkToken: r.linkToken };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "reparation"),
      linkToken: null,
    };
  }
}

/** Schéma de la re-lecture post-réparation : un seul identifiant opaque de connexion. */
const resyncConnexionSchema = z
  .object({ connectionId: z.string().trim().min(1).max(64) })
  .strict();

/**
 * Re-lit UNE connexion après que le widget natif a terminé la réparation (onSuccess).
 * Réutilise la boucle d'ingestion existante (`synchroniserCompte`) via
 * `resynchroniserConnexion`. Fail-soft : un sync FAILED/timeout ne lève pas — on remonte
 * ce qui a été lu. Gating + anti-IDOR portés par l'orchestration.
 */
export async function resynchroniserConnexionApresReparationAction(
  connectionId: string,
): Promise<EtatFinalisation> {
  const session = await exigerSessionSansPerimetre();

  const parsed = resyncConnexionSchema.safeParse({ connectionId });
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        evt: "widget_resync_connexion_rejet",
        action: "resync-connexion",
        workspaceId: session.activeWorkspaceId,
      }),
    );
    return { erreur: "Paramètres invalides.", succes: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await resynchroniserConnexion(client, executer, parsed.data.connectionId);
    let succes = `Connexion rétablie — ${r.comptesRattaches} compte(s) mis à jour.`;
    if (r.transactionsImportees > 0) {
      succes += ` ${r.transactionsImportees} transaction(s) importée(s).`;
    }
    if (r.echecSync) {
      // Le scrape a PLANTÉ après la réparation. Les comptes sont bien rattachés (ils le sont
      // AVANT le job), mais aucune transaction n'a pu être lue : sans ce dire, on publiait
      // « Connexion rétablie » en VERT sur un échec (revue PR #202, C5).
      succes +=
        " En revanche, la récupération des transactions a échoué — réessayez plus tard.";
    }
    if (r.incomplet) {
      // Le scrape tourne ENCORE : on a importé du partiel. Le dire ici AUSSI, sinon la
      // réparation afficherait un succès plein sur une ingestion incomplète.
      succes +=
        " La synchronisation est encore en cours — relancez dans quelques minutes" +
        " pour récupérer le reste.";
    }
    if (r.reparationJobId) {
      // Rare : la banque a redemandé une vérification → on re-signale la réparation
      // (avec le NOUVEAU jobId) pour que l'UI laisse le bouton « Reconnecter » ré-armé.
      // Non-énumérant : que des identifiants opaques.
      succes += " Une nouvelle vérification de sécurité est encore demandée.";
      return {
        erreur: null,
        succes,
        ...(r.incomplet ? { incomplet: true } : {}),
        ...(r.echecSync ? { echecs: 1 } : {}),
        reparation: [
          { connectionId: parsed.data.connectionId, jobId: r.reparationJobId },
        ],
      };
    }
    return {
      erreur: null,
      succes,
      ...(r.incomplet ? { incomplet: true } : {}),
      // Signal STRUCTURÉ, pas seulement une phrase : c'est lui qui interdit le vert.
      ...(r.echecSync ? { echecs: 1 } : {}),
    };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "resync-connexion"),
      succes: null,
    };
  }
}

/**
 * Sélection de comptes (Account Selection, Epic 1 / L3.2). Identifiants LOCAUX
 * (UUID de `bank_accounts.id` / `bank_connections.id`), jamais des identifiants
 * Omni-FI : la traduction se fait serveur, sous RLS. Bornes finies (1..200 comptes)
 * pour ne pas accepter de payload non contrôlé.
 */
const selectionComptesSchema = z
  .object({
    connectionId: z.string().uuid(),
    bankAccountIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();

export interface EtatSelectionComptes {
  erreur: string | null;
  succes: string | null;
}

/**
 * Enregistre la sélection de comptes de l'utilisateur : `PUT /connections/{id}/accounts`
 * PUIS écriture du consentement `ACCOUNTS_SELECTED` (ordre §2.3 — jamais l'inverse).
 *
 * Exit-criteria (règle 3) : authz `withWorkspace` (membership re-validée) + gating
 * MANAGER/ADMIN dans l'orchestration ; zod strict ; erreurs nommées ; ressource d'un
 * autre tenant → refus non-énumérant (jamais 403, pas d'oracle d'existence) ; log
 * structuré corrélé (workspace_id, connection_id).
 */
export async function selectionnerComptesAction(
  connectionId: string,
  bankAccountIds: string[],
): Promise<EtatSelectionComptes> {
  const session = await exigerSessionSansPerimetre();

  const parsed = selectionComptesSchema.safeParse({ connectionId, bankAccountIds });
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        evt: "consent_selection_rejet",
        action: "selectionner-comptes",
        workspaceId: session.activeWorkspaceId,
        motif: "forme",
      }),
    );
    return { erreur: "Paramètres invalides.", succes: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await selectionnerComptes(client, executer, {
      connectionId: parsed.data.connectionId,
      bankAccountIds: parsed.data.bankAccountIds,
    });
    // Log de SUCCÈS corrélé : le consentement est un acte réglementaire, son
    // émission doit être traçable en exploitation (identifiants opaques seuls).
    console.info(
      JSON.stringify({
        evt: "consent_accounts_selected",
        action: "selectionner-comptes",
        workspaceId: session.activeWorkspaceId,
        connectionId: parsed.data.connectionId,
        comptes: r.comptesAutorises,
      }),
    );
    return {
      erreur: null,
      succes: `Sélection enregistrée — ${r.comptesAutorises} compte(s) autorisé(s).`,
    };
  } catch (erreur) {
    return {
      erreur: messageSelection(erreur, session.activeWorkspaceId, connectionId),
      succes: null,
    };
  }
}

/**
 * Mappe les erreurs de la sélection en message UI non-énumérant + log corrélé.
 *
 * `AUDIT_PAYLOAD_INVALID` et `AUDIT_SNAPSHOT_INCOMPLET` sont des DÉFAUTS SERVEUR
 * (500) : leurs messages nomment des clés de payload / des motifs internes. Ils
 * sont tracés par leur code machine mais JAMAIS affichés — l'UI voit le message
 * générique. Un catch-all silencieux serait un défaut de revue (règle 3).
 */
function messageSelection(
  erreur: unknown,
  workspaceId: string,
  connectionId: string,
): string {
  const code =
    erreur instanceof Error && "code" in erreur && typeof erreur.code === "string"
      ? erreur.code
      : erreur instanceof Error
        ? erreur.name
        : "UNKNOWN";
  const detailApi =
    erreur instanceof OmniFiApiError
      ? { status: erreur.status, obieCode: erreur.obieCode }
      : {};
  console.warn(
    JSON.stringify({
      evt: "consent_selection_echec",
      action: "selectionner-comptes",
      workspaceId,
      connectionId,
      code,
      ...detailApi,
    }),
  );

  if (
    erreur instanceof ConnexionNonAutoriseeError ||
    erreur instanceof WorkspaceAccessDeniedError
  ) {
    return MESSAGE_REFUS;
  }
  if (erreur instanceof ConsentAccountUnknownError) {
    // Non-énumérant : ne dit pas LEQUEL des comptes est inconnu.
    return "Sélection de comptes invalide. Rechargez la page et réessayez.";
  }
  if (erreur instanceof WorkspaceSansClientUserIdError) {
    return MESSAGE_CONFIG;
  }
  // AuditPayloadInvalideError / AuditSnapshotIncompletError / OmniFiApiError /
  // réseau / UnsafeDatabaseRoleError → générique côté UI, tracés par code ci-dessus.
  return MESSAGE_GENERIQUE;
}

/**
 * Formate le délai de cooldown le PLUS PROCHE en texte relatif court (« dans ~12
 * min »). On prend le `nextSyncAt` minimal parmi les connexions rate-limitées.
 * Renvoie "" si aucune date exploitable (l'amont ne l'a pas fournie). Non-énumérant :
 * un délai n'identifie pas une banque.
 */
function messageDelaiCooldown(
  rateLimited: Array<{ nextSyncAt: string | null }>,
): string {
  const instants = rateLimited
    .map((r) => (r.nextSyncAt ? Date.parse(r.nextSyncAt) : NaN))
    .filter((ms) => !Number.isNaN(ms) && ms > Date.now());
  if (instants.length === 0) return "";
  const minutes = Math.max(1, Math.round((Math.min(...instants) - Date.now()) / 60_000));
  return `dans ~${minutes} min`;
}

/**
 * Mappe une erreur en message UI non-énumérant (registre S2) ET émet un log
 * structuré corrélé (exit-criteria règle 3, constat cross-review 5.1). Le log ne
 * contient QUE des identifiants sûrs (workspace_id + code machine) — JAMAIS de
 * token, mot de passe bancaire, ni Message OBIE brut (règle 8 / A1).
 *
 * Sans ce log, un échec de garde-fou (UnsafeDatabaseRoleError) ou un timeout
 * serait invisible en exploitation (transformé en message générique côté UI).
 */
function messageDepuis(erreur: unknown, workspaceId: string, action: string): string {
  const code =
    erreur instanceof Error && "code" in erreur && typeof erreur.code === "string"
      ? erreur.code
      : erreur instanceof Error
        ? erreur.name
        : "UNKNOWN";
  // Observabilité : pour une OmniFiApiError, le `code` générique ("OMNIFI_API_ERROR")
  // ne distingue pas 429 / 4xx / 5xx. On logge AUSSI le `status` HTTP et l'`obieCode`,
  // tous deux SÛRS (pas de PII — le Message OBIE, lui, reste exclu, règle 8 / A1). Sans
  // ça on était aveugle sur la cause réelle (cooldown vs param rejeté vs panne amont).
  const detailApi =
    erreur instanceof OmniFiApiError
      ? { status: erreur.status, obieCode: erreur.obieCode }
      : {};
  // Log corrélé sûr (pas de PII/secret). Niveau warn : échec fonctionnel.
  console.warn(
    JSON.stringify({
      evt: "widget_connexion_echec",
      action,
      workspaceId,
      code,
      ...detailApi,
    }),
  );

  if (
    erreur instanceof ConnexionNonAutoriseeError ||
    erreur instanceof WorkspaceAccessDeniedError ||
    // Contexte de réparation hors tenant (anti-IDOR) : refus non-énumérant, comme un
    // accès cross-workspace — on ne confirme pas l'existence de la connexion.
    erreur instanceof ReparationContexteInvalideError
  ) {
    return MESSAGE_REFUS;
  }
  if (erreur instanceof WorkspaceSansClientUserIdError) {
    return MESSAGE_CONFIG;
  }
  // Tout le reste (OmniFiApiError, ConnexionDesalignmentError, timeout, réseau,
  // UnsafeDatabaseRoleError…) → message générique côté UI (non-énumérant), mais
  // tracé ci-dessus par son code machine.
  return MESSAGE_GENERIQUE;
}

/**
 * Log structuré d'un rejet de validation AVANT tout appel amont (Volet B). Sans
 * lui, un rejet du schéma/de l'allowlist est invisible en exploitation (l'UI ne
 * voit qu'un message). On ne logge QUE le workspace_id + le motif machine — JAMAIS
 * l'URL d'origine (peut porter des identifiants) ni de token (règle 8).
 */
function logRejetDemarrage(workspaceId: string, motif: string): void {
  console.warn(
    JSON.stringify({
      evt: "widget_demarrage_rejet",
      action: "demarrer",
      workspaceId,
      motif,
    }),
  );
}
