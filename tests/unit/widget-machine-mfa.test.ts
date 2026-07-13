/**
 * Machine à états MFA pure (PR-W3) — cœur métier sans React ni réseau.
 * Couvre : progression d'états, détection de rejet OTP, 3 échecs → terminal,
 * watermark (verbatim, jamais null), cooldown, plafond de resends.
 */
import { describe, expect, it } from "vitest";

import type { JobPublic } from "@/app/(workspace)/banques/widget-runtime";
import {
  MAX_OTP_ECHECS,
  MAX_RESENDS,
  cooldownRestantSecondes,
  etatInitial,
  peutResend,
  peutSoumettre,
  pollingActif,
  transition,
  type EtatMfa,
} from "@/components/widget/machine-mfa";

const T0 = 1_750_000_000_000;

function job(over: Partial<JobPublic> = {}): JobPublic {
  return {
    status: "OTP_REQUESTED",
    userInputPresent: false,
    mfaType: "sms",
    mfaLength: 6,
    mfaCharset: "numeric",
    deliveryTargets: [{ Kind: "phone", Target: "+230 5*** 1234" }],
    mfaResendRequestedAt: null,
    mfaResendCooldownSeconds: null,
    mfaResendCount: 0,
    errorType: null,
    ...over,
  };
}

function appliquer(etat: EtatMfa, j: JobPublic, t = T0): EtatMfa {
  return transition(etat, { type: "JOB", job: j, maintenant: t });
}

describe("progression d'états", () => {
  it("LOGGING_IN → OTP_REQUESTED → RETRIEVING → COMPLETED", () => {
    let e = etatInitial();
    e = appliquer(e, job({ status: "LOGGING_IN" }));
    expect(e.phase).toBe("initialisation");
    e = appliquer(e, job({ status: "OTP_REQUESTED" }));
    expect(e.phase).toBe("mfa_requis");
    expect(e.mfa?.type).toBe("sms");
    e = appliquer(e, job({ status: "RETRIEVING" }));
    expect(e.phase).toBe("synchronisation");
    expect(pollingActif(e)).toBe(true);
    e = appliquer(e, job({ status: "COMPLETED" }));
    expect(e.phase).toBe("termine");
    expect(pollingActif(e)).toBe(false);
  });

  it("FAILED → phase echec + codeEchec", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED", userInputPresent: true }));
    e = appliquer(e, job({ status: "FAILED", errorType: "LOGIN_FAILED" }));
    expect(e.phase).toBe("echec");
    expect(e.codeEchec).toBe("LOGIN_FAILED");
    expect(pollingActif(e)).toBe(false);
  });

  it("DÉRIVE AMONT — statut hors de nos types → `initialisation`, jamais un faux terminal", () => {
    // Le statut du fil est une union OUVERTE : l'amont émet des valeurs que ni la doc ni nos
    // types ne connaissent (le backend persiste `SCRAPING` là où l'API documente
    // `RETRIEVING`). Un inconnu ne doit ni faire planter, ni passer pour `termine`/`echec`
    // — et surtout jamais rendre `undefined` (le mode de défaillance payé sur le "UNKNOWN"
    // du SDK widget).
    const e = appliquer(etatInitial(), job({ status: "SCRAPING" }));
    expect(e.phase).toBe("initialisation");
    expect(e.phase).not.toBeUndefined();
  });
});

describe("détection de rejet OTP", () => {
  it("UserInput présent puis absent (statut inchangé) → +1 échec", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED" }));
    // L'utilisateur soumet : le polling voit UserInput présent.
    e = appliquer(e, job({ status: "OTP_REQUESTED", userInputPresent: true }));
    expect(e.echecsOtp).toBe(0);
    // Code rejeté : UserInput repasse absent, statut toujours OTP_REQUESTED.
    e = appliquer(e, job({ status: "OTP_REQUESTED", userInputPresent: false }));
    expect(e.echecsOtp).toBe(1);
    expect(e.phase).toBe("mfa_requis"); // re-prompt
  });

  it("3 rejets consécutifs : peutSoumettre devient false (plafond OTP)", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED" }));
    for (let i = 0; i < MAX_OTP_ECHECS; i++) {
      e = appliquer(e, job({ status: "OTP_REQUESTED", userInputPresent: true }));
      e = appliquer(e, job({ status: "OTP_REQUESTED", userInputPresent: false }));
    }
    expect(e.echecsOtp).toBe(MAX_OTP_ECHECS);
    expect(peutSoumettre(e)).toBe(false);
  });

  it("pas de faux rejet quand le statut change (OTP_WAITING)", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED", userInputPresent: true }));
    // Passage en validation : userInput absent mais statut différent → pas un rejet.
    e = appliquer(e, job({ status: "OTP_WAITING", userInputPresent: false }));
    expect(e.echecsOtp).toBe(0);
  });
});

describe("watermark (A2 — verbatim, jamais null)", () => {
  it("absent tant qu'aucun resend (undefined)", () => {
    const e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED", mfaResendRequestedAt: null }));
    expect(e.watermark).toBeUndefined();
  });

  it("RESEND_OK fixe le watermark verbatim et incrémente le compteur", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED" }));
    e = transition(e, {
      type: "RESEND_OK",
      mfaResendRequestedAt: "2026-06-15T10:00:05Z",
      cooldownSeconds: 30,
      maintenant: T0,
    });
    expect(e.watermark).toBe("2026-06-15T10:00:05Z");
    expect(e.resends).toBe(1);
    expect(e.cooldownJusqua).toBe(T0 + 30_000);
  });

  it("le watermark du job (autorité serveur) est repris verbatim", () => {
    const e = appliquer(
      etatInitial(),
      job({ status: "OTP_REQUESTED", mfaResendRequestedAt: "2026-06-15T11:22:33Z" }),
    );
    expect(e.watermark).toBe("2026-06-15T11:22:33Z");
  });
});

describe("cooldown & plafond de resends", () => {
  it("peutResend false pendant le cooldown, true après", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED" }));
    e = transition(e, {
      type: "RESEND_OK",
      mfaResendRequestedAt: "2026-06-15T10:00:05Z",
      cooldownSeconds: 30,
      maintenant: T0,
    });
    expect(peutResend(e, T0 + 10_000)).toBe(false); // cooldown actif
    expect(cooldownRestantSecondes(e, T0 + 10_000)).toBe(20);
    expect(peutResend(e, T0 + 31_000)).toBe(true); // cooldown expiré
  });

  it("peutResend false après MAX_RESENDS atteint", () => {
    let e = appliquer(etatInitial(), job({ status: "OTP_REQUESTED" }));
    e = appliquer(e, job({ status: "OTP_REQUESTED", mfaResendCount: MAX_RESENDS }));
    expect(e.resends).toBe(MAX_RESENDS);
    expect(peutResend(e, T0 + 999_999)).toBe(false);
  });

  it("peutResend false hors phase MFA", () => {
    const e = appliquer(etatInitial(), job({ status: "RETRIEVING" }));
    expect(peutResend(e, T0)).toBe(false);
  });
});
