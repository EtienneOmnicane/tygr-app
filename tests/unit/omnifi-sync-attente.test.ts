/**
 * `attendreFinSync` (orchestration.ts) — attente d'un job de sync RÉEL, invariants
 * testés avec un client factice (aucun réseau) + fake timers (aucune attente réelle).
 *
 * Faits du diagnostic sandbox encodés ici :
 *  - le job peut être COMPLETED dès le 1er poll (t+0s) → on ne doit PAS attendre ;
 *  - aucune transition n'est garantie : on ne traite que les états terminaux + OTP ;
 *  - à COMPLETED, PersistenceStats est loggé (preuve différée, sans PII).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { attendreFinSync, declencherEtAttendre } from "@/server/widget/orchestration";
import type { OmniFiClient } from "@/server/omnifi";

const CLIENT_USER_ID = "enduser-1";
const JOB_ID = "job-xyz";
const CONNECTION_ID = "conn-xyz";

/** Client factice exposant uniquement getSyncJobServeur (seul appel d'attendreFinSync). */
function clientAvecPolls(
  reponses: Array<{ Status: string; PersistenceStats?: unknown; Error?: unknown }>,
): { client: OmniFiClient; poll: ReturnType<typeof vi.fn> } {
  const poll = vi.fn();
  for (const r of reponses) poll.mockResolvedValueOnce({ JobId: JOB_ID, ...r });
  // Au-delà des réponses fournies, on reste sur la dernière (évite un undefined).
  if (reponses.length > 0) {
    poll.mockResolvedValue({ JobId: JOB_ID, ...reponses[reponses.length - 1] });
  }
  return { client: { getSyncJobServeur: poll } as unknown as OmniFiClient, poll };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attendreFinSync — 1er poll immédiat", () => {
  it("COMPLETED dès le 1er poll (t+0s) → retourne sans attendre, logue PersistenceStats", async () => {
    const stats = {
      TransactionsCreated: 3,
      TransactionsUpdated: 1,
      TransactionsDuplicated: 0,
      AccountsUpdated: 1,
    };
    const { client, poll } = clientAvecPolls([{ Status: "COMPLETED", PersistenceStats: stats }]);
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Pas de fake timers nécessaires : si le code attendait, le test pendrait.
    const r = await attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);

    expect(r.status).toBe("COMPLETED");
    expect(r.persistenceStats).toEqual(stats);
    expect(poll).toHaveBeenCalledTimes(1); // un seul poll, immédiat
    // Log structuré d'observabilité (sans PII) — la preuve différée.
    const charge = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(charge).toMatchObject({
      evt: "omnifi_sync_completed",
      connectionId: CONNECTION_ID,
      jobId: JOB_ID,
      created: 3,
      updated: 1,
      duplicated: 0,
    });
  });

  it("OTP_REQUESTED → status OTP_REQUESTED (réparation MFA), pas de log de complétion", async () => {
    const { client } = clientAvecPolls([{ Status: "OTP_REQUESTED" }]);
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const r = await attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);

    expect(r.status).toBe("OTP_REQUESTED");
    expect(r.jobId).toBe(JOB_ID);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("FAILED → status FAILED + errorType (Type seul, jamais le Message)", async () => {
    const { client } = clientAvecPolls([
      { Status: "FAILED", Error: { Type: "LOGIN_FAILED", Message: "secret-ne-doit-pas-fuiter" } },
    ]);

    const r = await attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);

    expect(r.status).toBe("FAILED");
    expect(r.errorType).toBe("LOGIN_FAILED");
  });
});

describe("attendreFinSync — boucle d'attente", () => {
  it("PENDING puis COMPLETED → poll deux fois (1 immédiat + 1 après la pause)", async () => {
    vi.useFakeTimers();
    const { client, poll } = clientAvecPolls([
      { Status: "PENDING" },
      { Status: "COMPLETED", PersistenceStats: { TransactionsCreated: 0 } },
    ]);
    vi.spyOn(console, "info").mockImplementation(() => {});

    const promesse = attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);
    // 1er poll immédiat (PENDING) déjà parti ; on laisse filer la microtask puis la pause.
    await vi.advanceTimersByTimeAsync(3_000);
    const r = await promesse;

    expect(r.status).toBe("COMPLETED");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("toujours non terminal → TIMEOUT au plafond (~120s), sans pendre", async () => {
    vi.useFakeTimers();
    // Toujours PENDING (le mock par défaut reste sur la dernière réponse).
    const { client } = clientAvecPolls([{ Status: "PENDING" }]);

    const promesse = attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);
    // Avance bien au-delà du plafond pour franchir la condition de timeout.
    await vi.advanceTimersByTimeAsync(130_000);
    const r = await promesse;

    expect(r.status).toBe("TIMEOUT");
    expect(r.jobId).toBe(JOB_ID);
  });
});

/**
 * RÉGRESSION PROD 2026-07-13 — « le sync importe 0 transaction ».
 *
 * Cause réelle : un scrape peut durer BIEN plus longtemps que notre plafond (observé :
 * `RETRIEVING` pendant 6 min+, soit 3× les 120 s). Le job n'est ni terminal ni en échec —
 * il TOURNE. Or les transactions déjà scrapées sont lisibles immédiatement (67 dispo).
 * L'ancien code rendait `SKIP_FAILED (POLL_TIMEOUT)` → la connexion était sautée → 0
 * transaction importée, alors que la donnée était là.
 *
 * Invariant garanti ici : un job encore en cours au plafond est INCOMPLET, jamais un
 * échec — et la LECTURE doit suivre.
 */
describe("attendreFinSync — job encore en cours au plafond (INCOMPLET, pas un échec)", () => {
  it("RETRIEVING au plafond → TIMEOUT + dernierStatut, log `omnifi_sync_incomplet` (jamais `completed`)", async () => {
    vi.useFakeTimers();
    // Le cas EXACT de la prod : le scrape tourne toujours quand on rend la main.
    const { client } = clientAvecPolls([{ Status: "RETRIEVING" }]);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promesse = attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);
    await vi.advanceTimersByTimeAsync(130_000);
    const r = await promesse;

    expect(r.status).toBe("TIMEOUT");
    // Le dernier statut amont remonte : c'est lui qui EXPLIQUE le partiel côté UI/logs.
    expect(r.dernierStatut).toBe("RETRIEVING");

    // On NE prétend PAS avoir complété : `omnifi_sync_completed` fausserait la preuve
    // d'observabilité (et le message de succès).
    expect(infoSpy).not.toHaveBeenCalled();

    // Événement DISTINCT, et SANS PII : que des identifiants opaques + une valeur
    // d'énumération. Aucun libellé bancaire, aucun message d'erreur amont.
    const charge = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(charge).toMatchObject({
      evt: "omnifi_sync_incomplet",
      connectionId: CONNECTION_ID,
      jobId: JOB_ID,
      dernierStatut: "RETRIEVING",
    });
    expect(JSON.stringify(charge)).not.toContain("Message");
  });

  it("statut INCONNU de nos types (dérive amont) → ni terminal ni succès : TIMEOUT, pas de poll infini", async () => {
    vi.useFakeTimers();
    // L'amont DÉRIVE : le backend persiste `SCRAPING` là où l'API documente `RETRIEVING`.
    // Un statut hors de nos types ne doit ni faire planter, ni être pris pour un succès,
    // ni faire boucler indéfiniment. Il doit ressortir en INCOMPLET, avec sa valeur
    // brute — le seul signal qui nous préviendra de la dérive.
    const { client } = clientAvecPolls([{ Status: "SCRAPING" }]);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const promesse = attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);
    await vi.advanceTimersByTimeAsync(130_000);
    const r = await promesse;

    expect(r.status).toBe("TIMEOUT");
    expect(r.dernierStatut).toBe("SCRAPING");
    expect(infoSpy).not.toHaveBeenCalled(); // surtout pas un faux COMPLETED
  });
});

/**
 * L'ISSUE est ce qui décide, en aval, si la connexion est LUE ou SAUTÉE :
 *   - SKIP_FAILED → `continue` (aucune transaction ingérée) ;
 *   - INCOMPLET / RATE_LIMITED / DECLENCHE → la lecture suit.
 * C'est donc ICI que se joue la régression « 0 transaction importée ».
 */
describe("declencherEtAttendre — un job qui tourne encore n'est PAS un échec", () => {
  /** Client factice : POST /sync accepté, puis le job reste dans `statut` à chaque poll. */
  function clientQuiDeclenche(statut: string, erreurJob?: unknown) {
    const declencherSync = vi.fn().mockResolvedValue({ JobId: JOB_ID, Status: "PENDING" });
    const getSyncJobServeur = vi
      .fn()
      .mockResolvedValue({ JobId: JOB_ID, Status: statut, Error: erreurJob });
    return {
      client: { declencherSync, getSyncJobServeur } as unknown as OmniFiClient,
      getSyncJobServeur,
    };
  }

  it("job encore en RETRIEVING au plafond → INCOMPLET (la lecture SUIT), jamais SKIP_FAILED/POLL_TIMEOUT", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientQuiDeclenche("RETRIEVING");

    const promesse = declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);
    await vi.advanceTimersByTimeAsync(130_000);
    const issue = await promesse;

    // L'invariant du correctif : la connexion N'EST PAS sautée.
    expect(issue).toEqual({
      kind: "INCOMPLET",
      jobId: JOB_ID,
      dernierStatut: "RETRIEVING",
    });
    // Contre-preuve explicite : plus AUCUN POLL_TIMEOUT, qui faisait `continue` en aval
    // et jetait des transactions déjà disponibles (67 en prod).
    expect(issue.kind).not.toBe("SKIP_FAILED");
    expect(JSON.stringify(issue)).not.toContain("POLL_TIMEOUT");
  });

  it("CHEMIN D'ÉCHEC INCHANGÉ : job FAILED → SKIP_FAILED + errorType (jamais INCOMPLET)", async () => {
    // Un vrai échec reste un échec : on ne doit PAS se mettre à lire une connexion dont le
    // scrape a planté (ce serait affaiblir le fail-soft en corrigeant le timeout).
    const { client } = clientQuiDeclenche("FAILED", {
      Type: "SCRAPER_ERROR",
      Message: "libellé-bancaire-qui-ne-doit-pas-fuiter",
    });

    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(issue).toEqual({ kind: "SKIP_FAILED", errorType: "SCRAPER_ERROR" });
    // Règle 8 : le Message OBIE (PII potentielle) ne remonte jamais.
    expect(JSON.stringify(issue)).not.toContain("libellé-bancaire");
  });

  it("job COMPLETED → DECLENCHE (comportement nominal inchangé)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { client } = clientQuiDeclenche("COMPLETED");

    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(issue).toEqual({ kind: "DECLENCHE" });
  });
});

/**
 * LE 2ᵉ CLIC — le geste que notre propre message provoque (« relancez dans quelques
 * minutes »), et qui tombe SOUS le cooldown amont de 15 min.
 *
 * Sans la vérification du job en cours, ce clic sortait en RATE_LIMITED à la garde, donc
 * sans le drapeau `incomplet`, donc en « Comptes à jour » : le faux message de victoire
 * renaissait exactement sur le geste qu'on venait de prescrire (revue PR #202, constat 1).
 * Un cooldown dit qu'un sync est PARTI récemment — jamais qu'il est FINI.
 */
describe("declencherEtAttendre — cooldown actif : un job qui tourne ≠ des comptes à jour", () => {
  /** `NextSyncAvailableAt` dans le futur ⇒ cooldown actif (2ᵉ clic, 2 min après le 1er). */
  const COOLDOWN_FUTUR = new Date(Date.now() + 13 * 60_000).toISOString();

  function clientSousCooldown(latest: Record<string, unknown> | Error) {
    const declencherSync = vi.fn();
    const getLatestSyncJob =
      latest instanceof Error
        ? vi.fn().mockRejectedValue(latest)
        : vi.fn().mockResolvedValue(latest);
    return {
      client: { declencherSync, getLatestSyncJob } as unknown as OmniFiClient,
      declencherSync,
    };
  }

  it("job encore en RETRIEVING derrière le cooldown → INCOMPLET, sans re-poller 120 s", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, declencherSync } = clientSousCooldown({
      JobId: JOB_ID,
      Status: "RETRIEVING",
    });

    const issue = await declencherEtAttendre(
      client,
      CONNECTION_ID,
      CLIENT_USER_ID,
      COOLDOWN_FUTUR,
    );

    // L'invariant : le 2ᵉ clic reste HONNÊTE (données partielles), il ne repasse pas au vert.
    expect(issue).toEqual({
      kind: "INCOMPLET",
      jobId: JOB_ID,
      dernierStatut: "RETRIEVING",
    });
    expect(issue.kind).not.toBe("RATE_LIMITED");
    // La garde amont tient toujours : on ne re-déclenche PAS sous cooldown (pas de 429),
    // et on n'attend pas 120 s pour rien — on CONSTATE l'état du job.
    expect(declencherSync).not.toHaveBeenCalled();
  });

  it("dernier job TERMINAL (COMPLETED) → RATE_LIMITED : le cooldown seul reste un cooldown", async () => {
    // Contre-preuve : on ne transforme pas TOUT cooldown en « incomplet ». Si le scrape
    // précédent est allé au bout, les données SONT à jour — le comportement ne change pas.
    const { client } = clientSousCooldown({ JobId: JOB_ID, Status: "COMPLETED" });

    const issue = await declencherEtAttendre(
      client,
      CONNECTION_ID,
      CLIENT_USER_ID,
      COOLDOWN_FUTUR,
    );

    expect(issue).toEqual({ kind: "RATE_LIMITED", nextSyncAt: COOLDOWN_FUTUR });
  });

  it("CAS LIMITE — job en OTP_REQUESTED sous cooldown → RATE_LIMITED, JAMAIS INCOMPLET", async () => {
    // Un job MFA n'est pas « en cours de scraping » : il ATTEND l'utilisateur. Le classer
    // INCOMPLET masquerait une RÉPARATION requise derrière un rassurant « c'est en cours »
    // — c'est le sous-type structurel qui avait déjà piégé la PR #201. Le chemin MFA reste
    // celui d'`attendreFinSync` (→ NEEDS_REPAIR).
    const { client } = clientSousCooldown({ JobId: JOB_ID, Status: "OTP_REQUESTED" });

    const issue = await declencherEtAttendre(
      client,
      CONNECTION_ID,
      CLIENT_USER_ID,
      COOLDOWN_FUTUR,
    );

    expect(issue.kind).toBe("RATE_LIMITED");
    expect(issue.kind).not.toBe("INCOMPLET");
  });

  it("CAS LIMITE — lecture du dernier job en ERREUR → RATE_LIMITED (best-effort, jamais fatal)", async () => {
    // Ce diagnostic ne doit jamais faire échouer une synchro qui, sinon, aboutirait :
    // on retombe sur le comportement existant.
    const { client } = clientSousCooldown(new Error("réseau"));

    const issue = await declencherEtAttendre(
      client,
      CONNECTION_ID,
      CLIENT_USER_ID,
      COOLDOWN_FUTUR,
    );

    expect(issue).toEqual({ kind: "RATE_LIMITED", nextSyncAt: COOLDOWN_FUTUR });
  });

  it("log `omnifi_sync_incomplet` SANS PII (identifiants opaques + énumération)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientSousCooldown({ JobId: JOB_ID, Status: "RETRIEVING" });

    await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, COOLDOWN_FUTUR);

    const charge = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(charge).toMatchObject({
      evt: "omnifi_sync_incomplet",
      connectionId: CONNECTION_ID,
      jobId: JOB_ID,
      dernierStatut: "RETRIEVING",
      cause: "JOB_EN_COURS_SOUS_COOLDOWN",
    });
    // Règle 8 : aucun SessionToken / ClientUserId / libellé bancaire.
    expect(JSON.stringify(charge)).not.toContain(CLIENT_USER_ID);
  });
});
