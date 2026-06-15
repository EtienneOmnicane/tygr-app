"use client";

/**
 * Hook React du widget MFA Omni-FI (PR-W3). Pilote la machine à états pure
 * (machine-mfa.ts) : polling périodique du job, soumission d'OTP, resend, en
 * gérant watermark/cooldown/échecs. Découplé du réseau par des dépendances
 * INJECTABLES (les 3 Server Actions runtime) → testable sans navigateur ni API.
 *
 * Le hook NE détient aucun secret persistant : le SessionToken et le jobId lui
 * sont passés (issus de l'échange widget côté client) et relayés aux actions.
 * Aucun log d'OTP/token (règle 8). La logique métier vit dans la machine pure ;
 * le hook n'orchestre que les effets (timers, appels, état React).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  etatInitial,
  peutResend,
  peutSoumettre,
  pollingActif,
  transition,
  type EtatMfa,
} from "./machine-mfa";
import type {
  JobPublic,
  ReponseRuntime,
} from "@/app/(workspace)/banques/widget-runtime";

/** Intervalle de polling par défaut (le scraping amont avance par secondes). */
export const INTERVALLE_POLL_MS = 2000;

/**
 * Plafond de ticks de polling (filet anti-polling-infini, constat #6). À 2 s/tick,
 * 300 ticks ≈ 10 min — couvre largement un scraping bancaire lent, et borne un job
 * bloqué en état non terminal (banque muette / bug amont).
 */
export const MAX_POLLS = 300;

/** Les 3 actions runtime, injectables (par défaut : les Server Actions réelles). */
export interface DepsWidget {
  poll: (sessionToken: string, jobId: string) => Promise<ReponseRuntime<JobPublic>>;
  submit: (
    sessionToken: string,
    jobId: string,
    otp: string,
    watermark?: string,
  ) => Promise<ReponseRuntime<{ status: string }>>;
  resend: (
    sessionToken: string,
    jobId: string,
  ) => Promise<ReponseRuntime<{ mfaResendRequestedAt: string; mfaResendCount: number }>>;
  /** Source d'horloge injectable (tests déterministes). */
  maintenant?: () => number;
  /** Planificateur de polling injectable (tests sans vrais timers). */
  intervalleMs?: number;
}

export interface ApiWidget {
  etat: EtatMfa;
  /** Erreur runtime du dernier appel (code machine), ou null. */
  erreur: string | null;
  enCours: boolean;
  soumettreOtp: (otp: string) => Promise<void>;
  demanderResend: () => Promise<void>;
}

type ActionReducer =
  | { type: "JOB"; job: JobPublic; maintenant: number }
  | { type: "RESEND_OK"; mfaResendRequestedAt: string; cooldownSeconds: number | null; maintenant: number };

function reducer(etat: EtatMfa, action: ActionReducer): EtatMfa {
  return transition(etat, action);
}

export function useOmniFiWidget(
  sessionToken: string,
  jobId: string,
  deps: DepsWidget,
): ApiWidget {
  const [etat, dispatch] = useReducer(reducer, undefined, etatInitial);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  // Horloge stable (sinon les useCallback se recréeraient à chaque rendu).
  const maintenant = useMemo(
    () => deps.maintenant ?? (() => Date.now()),
    [deps.maintenant],
  );
  const intervalle = deps.intervalleMs ?? INTERVALLE_POLL_MS;

  // Réfs stables pour les callbacks (évite de relancer le polling à chaque rendu).
  // Synchronisées dans un effect (jamais pendant le rendu — React 19).
  const depsRef = useRef(deps);
  const etatRef = useRef(etat);
  useEffect(() => {
    depsRef.current = deps;
    etatRef.current = etat;
  });

  const pollUneFois = useCallback(async () => {
    const r = await depsRef.current.poll(sessionToken, jobId);
    if (r.ok && r.data) {
      dispatch({ type: "JOB", job: r.data, maintenant: maintenant() });
      setErreur(null);
    } else {
      setErreur(r.code);
    }
  }, [sessionToken, jobId, maintenant]);

  // Polling : démarre au montage. S'ARRÊTE réellement (clearInterval) dès que
  // l'état devient terminal OU que le plafond de ticks est atteint — un job bloqué
  // en état non terminal ne doit pas pinger l'API indéfiniment (constat
  // cross-review #6 : avant, l'intervalle continuait à tirer en early-return).
  useEffect(() => {
    let annule = false;
    let ticks = 0;
    let id: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const tick = async () => {
      if (annule) return;
      if (!pollingActif(etatRef.current) || ticks >= MAX_POLLS) {
        stop();
        return;
      }
      ticks += 1;
      await pollUneFois();
      // Le snapshot peut être devenu terminal : on coupe sans attendre un tick mort.
      if (!pollingActif(etatRef.current)) stop();
    };
    void tick();
    id = setInterval(() => void tick(), intervalle);
    return () => {
      annule = true;
      stop();
    };
  }, [pollUneFois, intervalle]);

  const soumettreOtp = useCallback(
    async (otp: string) => {
      if (!peutSoumettre(etatRef.current)) return;
      setEnCours(true);
      try {
        // Watermark verbatim si un resend a eu lieu, sinon undefined (jamais null).
        const r = await depsRef.current.submit(
          sessionToken,
          jobId,
          otp,
          etatRef.current.watermark,
        );
        if (!r.ok) setErreur(r.code);
        else setErreur(null);
        // Le résultat réel (acceptation/rejet) est constaté au polling suivant
        // (transition UserInput présent→absent) — source de vérité serveur.
        await pollUneFois();
      } finally {
        setEnCours(false);
      }
    },
    [sessionToken, jobId, pollUneFois],
  );

  const demanderResend = useCallback(async () => {
    if (!peutResend(etatRef.current, maintenant())) return;
    setEnCours(true);
    try {
      const r = await depsRef.current.resend(sessionToken, jobId);
      if (r.ok && r.data) {
        dispatch({
          type: "RESEND_OK",
          mfaResendRequestedAt: r.data.mfaResendRequestedAt,
          cooldownSeconds: null, // le cooldown précis arrive au polling suivant
          maintenant: maintenant(),
        });
        setErreur(null);
      } else {
        setErreur(r.code);
      }
    } finally {
      setEnCours(false);
    }
  }, [sessionToken, jobId, maintenant]);

  return { etat, erreur, enCours, soumettreOtp, demanderResend };
}
