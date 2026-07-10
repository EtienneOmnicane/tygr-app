/**
 * Masquage des identifiants de compte pour l'audit trail (règle 8, PII).
 *
 * SOURCE UNIQUE — même discipline que `format-montant.ts` : aucun composant, aucun
 * repository ne redéfinit un masquage local. Toute désignation de compte écrite dans
 * `consent_records.scope` ou `audit_events.payload` passe par ici.
 *
 * Ce que la fonction garantit, et pourquoi c'est la SEULE forme admissible :
 * - elle ne rend JAMAIS plus de 4 caractères de l'entrée — un IBAN, un numéro de
 *   compte complet ou un libellé bancaire brut ne peuvent donc pas transiter ;
 * - elle est TOTALE : toute entrée (null, vide, trop courte, non-chaîne à la
 *   frontière JS) rend une valeur masquée, jamais une exception, jamais l'entrée
 *   brute en repli. Un repli « on renvoie la valeur telle quelle si elle est
 *   courte » aurait été la faille : un numéro de 4 chiffres serait passé en clair.
 *
 * ⚠️ Le préfixe est un caractère U+2022 (BULLET) répété 4 fois, pas un point ASCII.
 */

/** Ce qu'on montre : les 4 derniers caractères, jamais plus. */
const CARACTERES_VISIBLES = 4;

/** Préfixe fixe, indépendant de la longueur de l'entrée (aucune fuite de longueur). */
const PREFIXE = "••••";

/**
 * `masquerCompte("MU17BOMM0101234567890123456789")` → `"••••6789"`.
 *
 * Cas aux bornes (tous rendent le préfixe SEUL, jamais l'entrée) :
 * - `null` / `undefined` / chaîne vide → `"••••"` ;
 * - chaîne plus courte que 4 caractères → `"••••"` (on ne révèle pas un numéro
 *   court en entier — refuser de masquer serait pire que masquer trop).
 *
 * La longueur de l'entrée n'est jamais observable dans la sortie.
 */
export function masquerCompte(valeur: string | null | undefined): string {
  if (typeof valeur !== "string") return PREFIXE;

  const nettoye = valeur.trim();
  if (nettoye.length < CARACTERES_VISIBLES) return PREFIXE;

  return `${PREFIXE}${nettoye.slice(-CARACTERES_VISIBLES)}`;
}
