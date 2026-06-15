/**
 * Point d'entrée de la logique widget MFA (PR-W3). L'agent UI branche ses
 * composants présentationnels sur `useOmniFiWidget` (état + actions) et, si
 * besoin, sur les sélecteurs/typage de la machine pure.
 */
export {
  useOmniFiWidget,
  INTERVALLE_POLL_MS,
  type DepsWidget,
  type ApiWidget,
} from "./use-omnifi-widget";
export {
  etatInitial,
  transition,
  peutSoumettre,
  peutResend,
  cooldownRestantSecondes,
  pollingActif,
  MAX_RESENDS,
  MAX_OTP_ECHECS,
  type EtatMfa,
  type PhaseWidget,
  type EvenementMfa,
} from "./machine-mfa";
