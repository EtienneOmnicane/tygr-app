/**
 * Mapping des échecs du widget natif Omni-FI (`messageErreurWidget`,
 * `omnifi-link-launcher.tsx`) — registre S2 du codepath « widget natif (CDN) ».
 *
 * Défaut corrigé (2026-07-13) : `onError` était aliasé sur `onClose` — l'objet
 * d'erreur était jeté et le widget se fermait SANS UN MOT. Une annulation et un
 * échec devenaient indiscernables.
 *
 * Ce test verrouille un contrat DÉFENSIF, parce que le contrat amont ment déjà une
 * fois (cf. `omnifi-link-payload.test.ts` : `onSuccess` reçoit un tableau nu là où
 * les types promettent `{ connections }`). Contrat RUNTIME vérifié le 2026-07-13 sur
 * le bundle réellement déployé (`staging-cdn.omni-fi.co/v1/omni-fi-connect.js`) :
 *
 *   onError({ code: t.code || "UNKNOWN", message: t.message || "An error occurred" })
 *
 * Deux pièges que le `.d.ts` vendoré cache, tous deux verrouillés ici :
 *  1. `OmniFIErrorCode` est un faux type « fermé » — le CDN émet `"UNKNOWN"`, hors
 *     union. Un `switch` exhaustif compilerait et renverrait `undefined` en prod.
 *  2. `message` est un texte amont (anglais, PII possible) : il ne doit JAMAIS
 *     ressortir, ni dans l'UI, ni dans ce qui part au log.
 */
import { describe, expect, it } from "vitest";

import type { OmniFIErrorCode } from "@omni-fi/react-link";

import { messageErreurWidget } from "@/components/widget/omnifi-link-launcher";

/** Message de repli, obtenu SANS exporter la constante : via un code hors registre. */
const MESSAGE_PAR_DEFAUT = messageErreurWidget({ code: "ZZZ_CODE_HORS_REGISTRE" })
  .message;

/**
 * Exhaustivité VÉRIFIÉE PAR LE COMPILATEUR : un `Record` sur l'union exige UNE
 * entrée par membre. Si un bump du SDK vendoré ajoute un code d'erreur, `tsc` casse
 * ICI — il devient impossible de l'oublier au registre S2 sans que la CI le voie.
 */
const CODES_DOCUMENTES: Record<OmniFIErrorCode, true> = {
  LINK_TOKEN_INVALID: true,
  LINK_TOKEN_EXPIRED: true,
  LINK_TOKEN_USED: true,
  SESSION_TOKEN_INVALID: true,
  SESSION_TOKEN_REVOKED: true,
  SESSION_TOKEN_EXPIRED: true,
  SESSION_TOKEN_IDLE_EXPIRED: true,
  PUBLIC_TOKEN_INVALID: true,
  PUBLIC_TOKEN_USED: true,
  PUBLIC_TOKEN_EXPIRED: true,
  PUBLIC_TOKEN_CLIENT_MISMATCH: true,
  INSTITUTION_LOCKED: true,
  INSTITUTION_NOT_FOUND: true,
  INSTITUTION_REQUIRED: true,
  INSTITUTION_SANDBOX_ONLY: true,
  SANDBOX_CREDENTIALS_REQUIRED: true,
  ORIGIN_NOT_ALLOWED: true,
  VALIDATION_ERROR: true,
};

describe("messageErreurWidget — chemin heureux (code connu → message mappé)", () => {
  it("LinkToken mort (invalide/expiré/déjà utilisé) → invite à recommencer", () => {
    const attendu = "La session de connexion a expiré. Recommencez la connexion.";
    expect(messageErreurWidget({ code: "LINK_TOKEN_EXPIRED" }).message).toBe(attendu);
    expect(messageErreurWidget({ code: "LINK_TOKEN_USED" }).message).toBe(attendu);
    expect(messageErreurWidget({ code: "LINK_TOKEN_INVALID" }).message).toBe(attendu);
  });

  it("banque verrouillée → message d'attente explicite (pas un « réessayez » creux)", () => {
    expect(messageErreurWidget({ code: "INSTITUTION_LOCKED" }).message).toContain(
      "temporairement bloqué",
    );
  });

  it("origine non autorisée (RedirectOrigin) → message de configuration", () => {
    expect(messageErreurWidget({ code: "ORIGIN_NOT_ALLOWED" }).message).toContain(
      "n’est pas autorisée depuis cette adresse",
    );
  });

  it("conserve le code machine pour le log (le message, lui, va à l'UI)", () => {
    expect(messageErreurWidget({ code: "PUBLIC_TOKEN_EXPIRED" }).code).toBe(
      "PUBLIC_TOKEN_EXPIRED",
    );
  });

  it("SDK_SCRIPT_LOAD_FAILED (script CDN non chargé) → message DÉDIÉ, pas le repli", () => {
    // Code INTERNE : le CDN ne peut pas le signaler lui-même (il n'est jamais arrivé).
    // Sans relais, `isReady` restait false à vie → « Ouverture… » sans fin + boutons
    // désactivés = cul-de-sac muet. Chemin le plus probable en prod : cdn.omni-fi.co
    // répond 403 (seul staging-cdn est déployé).
    const { code, message } = messageErreurWidget({ code: "SDK_SCRIPT_LOAD_FAILED" });
    expect(code).toBe("SDK_SCRIPT_LOAD_FAILED");
    expect(message).not.toBe(MESSAGE_PAR_DEFAUT);
    expect(message).toContain("n’a pas pu se charger");
  });

  it("registre S2 EXHAUSTIF : aucun code documenté ne tombe sur le repli", () => {
    // Le repli est un filet, pas une réponse : si un code DOCUMENTÉ y atterrit, c'est
    // qu'on a oublié de le mapper.
    for (const code of Object.keys(CODES_DOCUMENTES)) {
      const { message } = messageErreurWidget({ code });
      expect(message, `code non mappé au registre S2 : ${code}`).not.toBe(
        MESSAGE_PAR_DEFAUT,
      );
    }
  });
});

describe("messageErreurWidget — chemin d'échec (contrat amont menteur)", () => {
  it('"UNKNOWN" (repli ÉMIS PAR LE CDN, hors union TS) → message de repli, jamais undefined', () => {
    // Le cas qui piège un `switch` exhaustif : il compile, passe tsc… et rend
    // `undefined` en production → retour du bug (échec muet).
    const { code, message } = messageErreurWidget({ code: "UNKNOWN" });
    expect(code).toBe("UNKNOWN");
    expect(message).toBe(MESSAGE_PAR_DEFAUT);
    expect(message.length).toBeGreaterThan(0);
  });

  it("code inconnu FUTUR (Omni-FI en ajoute un) → repli, et le code part au log", () => {
    const { code, message } = messageErreurWidget({ code: "BANK_ON_FIRE_2027" });
    expect(message).toBe(MESSAGE_PAR_DEFAUT);
    expect(code).toBe("BANK_ON_FIRE_2027");
  });

  it("payload dégénéré (null/undefined/string/nombre/objet vide) → repli, jamais de throw", () => {
    // Une exception dans `onError` laisserait le widget se fermer en silence : le
    // défaut même qu'on corrige. Aucun de ces cas ne doit jeter.
    for (const degenere of [null, undefined, "boom", 42, {}, [], { code: null }, { code: "" }]) {
      const { code, message } = messageErreurWidget(degenere);
      expect(code).toBe("UNKNOWN");
      expect(message).toBe(MESSAGE_PAR_DEFAUT);
    }
  });
});

describe("messageErreurWidget — sécurité (règle 8 : ni PII, ni énumération)", () => {
  it("le message AMONT n'est jamais recopié — ni dans l'UI, ni dans le log", () => {
    // Le CDN passe `message` (anglais, potentiellement un libellé bancaire → PII).
    const amont = "Payment to John Doe rejected by ABSA account 1234";
    const { code, message } = messageErreurWidget({
      code: "LINK_TOKEN_EXPIRED",
      message: amont,
    });
    expect(message).not.toContain("John Doe");
    expect(message).not.toContain(amont);
    expect(code).not.toContain("John Doe");
  });

  it("un `code` qui n'a PAS la forme d'un code machine ne part pas au log tel quel", () => {
    // Garde anti-PII du LOG : si l'amont glissait du texte libre dans `code`, le
    // journaliser fuiterait. On lui substitue un marqueur, et le message reste le repli.
    const { code, message } = messageErreurWidget({
      code: "Virement de Jean Dupont refusé",
    });
    expect(code).toBe("CODE_NON_CONFORME");
    expect(code).not.toContain("Jean Dupont");
    expect(message).toBe(MESSAGE_PAR_DEFAUT);
  });

  it("clé du prototype d'Object en `code` → repli, JAMAIS une fonction héritée", () => {
    // `MESSAGES_PAR_CODE["constructor"]` rendrait la fonction `Object` sur un accès
    // indexé nu — le `message` cesserait d'être une chaîne (rendu React cassé). Deux
    // gardes l'empêchent : la forme du code ET `Object.hasOwn`.
    for (const cle of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const { message } = messageErreurWidget({ code: cle });
      expect(typeof message).toBe("string");
      expect(message).toBe(MESSAGE_PAR_DEFAUT);
    }
  });

  it("PUBLIC_TOKEN_CLIENT_MISMATCH (frontière tenant) : message NON ÉNUMÉRANT", () => {
    // Ce code signale un désalignement de ClientUserId. L'UI ne doit RIEN en révéler :
    // son message est volontairement IDENTIQUE au cas banal. Le signal vit dans le log.
    const mismatch = messageErreurWidget({ code: "PUBLIC_TOKEN_CLIENT_MISMATCH" });
    const banal = messageErreurWidget({ code: "PUBLIC_TOKEN_EXPIRED" });
    expect(mismatch.message).toBe(banal.message);
    expect(mismatch.code).toBe("PUBLIC_TOKEN_CLIENT_MISMATCH");
  });

  it("AUCUN texte amont ne ressort, quel que soit le code (invariant global)", () => {
    // L'invariant qui compte : le message affiché ne DÉRIVE jamais de l'amont — il est
    // choisi par nous, à partir du seul code. On le vérifie sur tout le registre.
    const amonts = [
      "An error occurred",
      "Login failed for account 1234",
      "Payment to John Doe rejected",
    ];
    for (const code of Object.keys(CODES_DOCUMENTES)) {
      for (const amont of amonts) {
        expect(messageErreurWidget({ code, message: amont }).message).not.toContain(
          amont,
        );
      }
    }
  });
});
