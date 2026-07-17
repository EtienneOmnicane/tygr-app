/**
 * Arithmétique de MONTANTS en CENTIMES ENTIERS (BigInt) — source UNIQUE du projet
 * (règle 8 : jamais de float sur un montant ; `0.1 + 0.2 !== 0.3`).
 *
 * EXTRAIT verbatim de `src/components/ui/category/allocation.ts` (déplacement PUR,
 * formules INCHANGÉES) : le moteur de récurrence (`echeances-recurrence.ts`) et les
 * repositories serveur en ont besoin, et un repository ne peut pas importer un module
 * de `src/components/**` (inversion de dépendance). Dupliquer un additionneur décimal
 * aurait créé une SECONDE source de vérité sur les montants — exactement ce que la
 * règle « source unique de formatage » interdit. `allocation.ts` ré-exporte depuis ici.
 *
 * Périmètre : ce module ne fait QUE du calcul. Le FORMATAGE d'affichage (milliers,
 * espace fine, devise) reste `@/lib/format-montant` ; la conversion de devise n'existe
 * pas (DASH-FX1) — additionner deux devises est INTERDIT, ici comme ailleurs.
 *
 * NB : `BigInt(n)` et non les littéraux `0n`/`100n` — la cible tsconfig est ES2017
 * (les littéraux BigInt exigeraient ES2020), le type bigint reste dispo via `lib: esnext`.
 */

export const ZERO_CENTIMES = BigInt(0);
const CENT = BigInt(100);

/**
 * Parse une chaîne décimale POSITIVE en centimes (BigInt). `null` si le format est
 * invalide — jamais une valeur de repli silencieuse (un montant illisible n'est pas 0).
 *
 * Accepte au plus 13 chiffres entiers + 2 décimales (`numeric(15,2)` en base) ; refuse
 * donc le signe, l'exposant et les séparateurs de milliers. C'est VOULU : tous les
 * montants métier du modèle sont positifs (le SENS est porté par `direction`).
 */
export function enCentimes(montant: string): bigint | null {
  const v = montant.trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(v)) return null;
  const [entier, decimal = ""] = v.split(".");
  const centimes = (decimal + "00").slice(0, 2);
  try {
    return BigInt(entier) * CENT + BigInt(centimes);
  } catch {
    return null;
  }
}

/**
 * Formate des centimes (BigInt) en chaîne décimale `"1234.50"` — échelle TOUJOURS à 2
 * décimales (même contrat que le `::numeric(15,2)::text` du SQL : « 0.00 », pas « 0 »).
 * Gère le négatif (un net encaissement − décaissement peut l'être).
 */
export function depuisCentimes(centimes: bigint): string {
  const negatif = centimes < ZERO_CENTIMES;
  const abs = negatif ? -centimes : centimes;
  const entiers = abs / CENT;
  const cents = abs % CENT;
  const txt = `${entiers}.${cents.toString().padStart(2, "0")}`;
  return negatif ? `-${txt}` : txt;
}
