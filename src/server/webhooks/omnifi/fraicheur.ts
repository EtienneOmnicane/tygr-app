/**
 * Fenêtre anti-replay / fraîcheur (§3.4). Le `Timestamp` est DANS le corps signé : un
 * attaquant ne peut pas le modifier sans invalider l'HMAC — ancrage temporel fiable.
 */
import { WebhookHorsFenetreError } from "./erreurs";

/**
 * Fenêtre d'idempotence Inngest = **24 h**, VÉRIFIÉE contre la doc SDK (point bloquant
 * §6.1, non présent dans les typings) : inngest.com/docs/guides/handling-idempotency —
 * « Each unique expression will only trigger one function execution per 24 hour period ».
 * On borne donc la fraîcheur à 12 h (≤ 24 h, marge §6.1) : un rejeu de plus de 12 h est
 * rejeté ICI (étage 1) AVANT de pouvoir SORTIR de la fenêtre d'idempotence Inngest
 * (étage 3) → aucun trou où un rejeu ré-enqueuerait un nouveau run. (Filet en profondeur
 * même si l'hypothèse dérivait : upserts idempotents + `concurrency:1` par connexion du
 * worker préviennent toute double-ingestion.) Elle borne aussi l'exposition d'une requête
 * signée capturée. TODOS WEBHOOK-FENETRE1 : resserrer à 10-15 min dès que la politique de
 * retry amont (D4-b) est connue.
 */
export const FENETRE_FRAICHEUR_MS = 12 * 60 * 60 * 1000; // 12 h
/** Dérive d'horloge tolérée vers le FUTUR (symétrique — sinon une horloge amont décalée
 *  ouvre une fenêtre illimitée). */
export const DERIVE_FUTUR_MS = 5 * 60 * 1000; // 5 min

/**
 * Rejette si `|maintenant − Timestamp|` hors fenêtre, en INSTANTS UTC. AUCUNE conversion
 * `Indian/Mauritius` : on compare des instants, pas des dates comptables (la règle de
 * fuseau CLAUDE.md vise les clôtures, pas les fenêtres de fraîcheur). `Timestamp` non
 * parsable → rejet (fail-closed). Lève `WebhookHorsFenetreError` (400).
 */
export function verifierFraicheur(timestampIso: string, maintenantMs: number): void {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) {
    throw new WebhookHorsFenetreError();
  }
  const delta = maintenantMs - t; // > 0 = passé, < 0 = futur
  if (delta > FENETRE_FRAICHEUR_MS) {
    throw new WebhookHorsFenetreError(); // trop ancien
  }
  if (delta < -DERIVE_FUTUR_MS) {
    throw new WebhookHorsFenetreError(); // trop loin dans le futur (dérive)
  }
}
