/**
 * Conversions Omni-FI → modèle TYGR (PR 2 ingestion). Brique pure et testable,
 * sans I/O. Deux invariants non négociables du CLAUDE.md :
 *
 * - Règle 8 (montants) : un montant OBIE est une CHAÎNE décimale ("1500.00").
 *   On la NORMALISE en chaîne `numeric(15,2)` sans JAMAIS passer par un float
 *   (Number(x)*100 perd des centimes). Le signe vient de CreditDebitIndicator,
 *   pas du montant (toujours positif côté OBIE).
 * - E20 (date comptable Maurice) : `transaction_date` dérive de `BookingDateTime`
 *   converti en `Asia/Port_Louis`. Une transaction à 22h UTC tombe le lendemain
 *   à Maurice. On NE compare jamais une date « nue » sans poser le fuseau.
 */
import { OmniFiInvalidResponseError } from "@/server/omnifi";

/** Décalage fixe de Maurice : UTC+4, sans heure d'été (CLAUDE.md). */
const DECALAGE_MAURICE_MIN = 4 * 60;

/**
 * Normalise un montant décimal OBIE en chaîne `numeric(15,2)` canonique.
 * Manipulation de chaîne uniquement (règle 8). Rejette tout format inattendu
 * avec une erreur nommée — pas de coercition silencieuse.
 */
export function normaliserMontant(montant: string): string {
  if (typeof montant !== "string" || !/^\d{1,13}(\.\d{1,2})?$/.test(montant.trim())) {
    throw new OmniFiInvalidResponseError(
      `montant OBIE non conforme (attendu décimal positif ≤2 décimales)`,
    );
  }
  const [entier, decimales = ""] = montant.trim().split(".");
  const cents = decimales.padEnd(2, "0").slice(0, 2);
  // Retire les zéros de tête superflus sans vider l'entier.
  const entierNorm = entier.replace(/^0+(?=\d)/, "");
  return `${entierNorm}.${cents}`;
}

/**
 * Dérive la date comptable Maurice (YYYY-MM-DD) d'un `BookingDateTime` OBIE
 * (ISO 8601, UTC ou avec offset). E20 : conversion EXPLICITE vers Asia/Port_Louis.
 * On calcule en arithmétique d'epoch (pas de comparaison de date nue).
 */
export function deriverDateComptableMaurice(bookingDateTime: string): string {
  const ms = Date.parse(bookingDateTime);
  if (Number.isNaN(ms)) {
    throw new OmniFiInvalidResponseError(
      "BookingDateTime illisible (ISO 8601 attendu)",
    );
  }
  // Instant UTC + décalage Maurice → composantes du calendrier local Maurice.
  const local = new Date(ms + DECALAGE_MAURICE_MIN * 60_000);
  const annee = local.getUTCFullYear();
  const mois = String(local.getUTCMonth() + 1).padStart(2, "0");
  const jour = String(local.getUTCDate()).padStart(2, "0");
  return `${annee}-${mois}-${jour}`;
}

/** Valide le sens d'une transaction (la colonne porte un CHECK strict en base). */
export function validerCreditDebit(valeur: string): "Credit" | "Debit" {
  if (valeur !== "Credit" && valeur !== "Debit") {
    throw new OmniFiInvalidResponseError(
      `CreditDebitIndicator inattendu : ${valeur === undefined ? "absent" : "valeur hors {Credit,Debit}"}`,
    );
  }
  return valeur;
}

/** Longueur max du nom d'institution persisté (= varchar de `bank_connections.institution_name`). */
export const INSTITUTION_NAME_MAX = 140;

/**
 * Normalise le nom d'institution remonté par l'API (`OmniFiConnection.InstitutionName`)
 * avant persistance. C'est une string libre amont (non contractuelle) : on est défensif.
 * - absente / vide après trim → `null` (la colonne est nullable, l'UI dégrade) ;
 * - trim des espaces de bord ;
 * - tronquée à `INSTITUTION_NAME_MAX` pour ne jamais dépasser la colonne (sinon
 *   l'insert échouerait et ferait planter toute la synchro pour un simple libellé).
 */
export function normaliserNomInstitution(valeur: string | null | undefined): string | null {
  if (typeof valeur !== "string") return null;
  const trim = valeur.trim();
  if (trim.length === 0) return null;
  return trim.length > INSTITUTION_NAME_MAX ? trim.slice(0, INSTITUTION_NAME_MAX) : trim;
}
