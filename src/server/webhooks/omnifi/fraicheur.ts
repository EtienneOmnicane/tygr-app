/**
 * Fenêtre anti-replay / fraîcheur (§3.4). Le `Timestamp` est DANS le corps signé : un
 * attaquant ne peut pas le modifier sans invalider l'HMAC — ancrage temporel fiable.
 */
import { WebhookHorsFenetreError } from "./erreurs";

/**
 * Inngest déduplique sur une fenêtre de 24 h (vérifié doc SDK). On borne la fraîcheur à
 * 12 h (≤ 24 h, marge §6.1) : un rejeu de plus de 12 h est rejeté ICI (étage 1) AVANT
 * de pouvoir sortir de la fenêtre d'idempotence Inngest (étage 3) — aucun trou.
 * Elle borne aussi l'exposition d'une requête signée capturée. TODOS WEBHOOK-FENETRE :
 * resserrer à 10-15 min dès que la politique de retry amont (D4-b) est connue.
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
