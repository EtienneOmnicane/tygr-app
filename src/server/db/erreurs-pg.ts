/**
 * Lecture des SQLSTATE Postgres — point de convergence CANONIQUE.
 *
 * Traduire un refus de la base en erreur applicative nommée est un geste récurrent
 * (exit-criterion règle 3 : « chaque erreur a un nom »). Le SQLSTATE qui compte le
 * plus ici est `42501` (insufficient_privilege) : c'est ce que rend un WITH CHECK de
 * policy RESTRICTIVE violé — autrement dit un refus de PÉRIMÈTRE, pas une panne.
 *
 * ⚠️ Ce module NOMME un refus, il ne DÉCIDE de rien : l'autorité reste la RLS. Ne
 * jamais s'en servir pour reconstituer une décision d'accès côté applicatif.
 *
 * DEUX copies privées de cette fonction préexistent — `repositories/echeances.ts` et
 * `repositories/entites.ts`. Elles n'ont PAS été migrées ici sciemment : cinq branches
 * en vol touchent ces deux fichiers (2026-07-21), et un déplacement mécanique y aurait
 * créé des conflits gratuits sur une PR de sécurité. Convergence consignée en TODOS
 * (PG-CODE-CONVERGENCE1) ; tout NOUVEL appelant importe d'ici, jamais une 3e copie.
 */

/**
 * SQLSTATE de la première erreur de la chaîne `cause` qui en porte un, sinon `undefined`.
 *
 * Remonte la chaîne parce que les drivers (et Drizzle) emballent volontiers l'erreur
 * native. Le test de forme `^[0-9A-Z]{5}$` est ce qui distingue un SQLSTATE (`42501`)
 * de nos propres `code` applicatifs (`ENTITY_CONNECTION_OUT_OF_SCOPE`) : les deux vivent
 * sur la propriété `code`, et sans ce filtre une erreur maison serait lue comme un
 * verdict de la base.
 */
export function codePg(e: unknown): string | undefined {
  let cur: unknown = e;
  while (cur instanceof Error) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * `insufficient_privilege` — rendu notamment par un WITH CHECK de policy RESTRICTIVE
 * violé (écriture hors périmètre). Constante nommée : `=== "42501"` disséminé dans le
 * code ne dit pas ce qu'il teste.
 */
export const PG_PRIVILEGE_INSUFFISANT = "42501";
