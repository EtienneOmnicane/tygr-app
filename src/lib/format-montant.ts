/**
 * Formatage des montants financiers (CLAUDE.md règle 8, UI_GUIDELINES §0).
 *
 * Entrée = CHAÎNE décimale telle que renvoyée par les services (`numeric(15,2)`
 * → string, p. ex. "7691000.00", "-384250.00"). On NE convertit JAMAIS en
 * `number` : `parseFloat` sur un gros montant perd des centimes (IEEE-754). Le
 * groupement des milliers et la mise en forme se font sur la CHAÎNE, par
 * découpage — aucune arithmétique flottante, y compris à l'affichage.
 *
 * L'UI affiche, ne recalcule rien : toute somme/différence est déjà faite côté
 * SQL (les services renvoient solde/variation prêts).
 *
 * Devise (décision audit ergonomie 2026-06-22) : symbole en PRÉFIXE pour les
 * devises connues (MUR→Rs, USD→$, EUR→€), séparé du montant par une espace fine
 * insécable — il ne se coupe JAMAIS du chiffre. Devise inconnue → repli code ISO
 * en SUFFIXE. Devise vide ("") → montant nu (aucun symbole, aucune espace
 * parasite), pour les contextes de saisie qui veulent juste le corps formaté.
 */

/**
 * Devises affichées en PRÉFIXE symbolique (usage mauricien + benchmark FYGR).
 * `Rs` pour la roupie : à Maurice le symbole précède le montant. Toute devise
 * HORS de cette table retombe sur son code ISO en SUFFIXE (repli).
 */
const SYMBOLES_PREFIXE: Record<string, string> = {
  MUR: "Rs",
  USD: "$",
  EUR: "€",
};

const ESPACE_FINE = " "; // espace fine insécable — séparateur de milliers FR

/** Découpe une chaîne décimale signée en { signe, entier, decimales }. */
function decomposer(montant: string): {
  negatif: boolean;
  entier: string;
  decimales: string;
} {
  const trim = montant.trim();
  const negatif = trim.startsWith("-");
  const sansSigne = negatif ? trim.slice(1) : trim;
  const [entierBrut, decBrut = ""] = sansSigne.split(".");
  // Normalise à 2 décimales (les numeric(_,2) en ont déjà 2, mais "0" → "00").
  const decimales = (decBrut + "00").slice(0, 2);
  // Retire les zéros de tête superflus, garde au moins un chiffre.
  const entier = entierBrut.replace(/^0+(?=\d)/, "");
  return { negatif, entier, decimales };
}

/** Groupe les milliers d'une chaîne d'entier par espace fine (FR). */
function grouperMilliers(entier: string): string {
  return entier.replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE_FINE);
}

/**
 * Formate un montant pour l'affichage : "Rs 7 691 000,00" (devise connue,
 * préfixe), "1 200,00 ZAR" (devise inconnue, repli suffixe ISO), "42,00"
 * (devise vide → montant nu).
 * @param montant chaîne décimale (peut être négative)
 * @param devise code ISO (MUR/USD/EUR → symbole préfixe ; autre → suffixe ;
 *   "" → aucun)
 * @param opts.signeExplicite force un "+" devant les positifs (KPI entrées)
 */
export function formatMontant(
  montant: string,
  devise: string,
  opts: { signeExplicite?: boolean } = {},
): string {
  const { negatif, entier, decimales } = decomposer(montant);
  const corps = `${grouperMilliers(entier)},${decimales}`;
  const estZero = entier === "0" && decimales === "00";
  const signe = negatif ? "−" : opts.signeExplicite && !estZero ? "+" : "";
  const nombre = `${signe}${corps}`;

  const code = devise.trim();
  if (code === "") return nombre; // montant nu, aucune espace parasite
  const symbole = SYMBOLES_PREFIXE[code.toUpperCase()];
  // Le symbole/code est séparé du chiffre par une espace fine INSÉCABLE : il ne
  // se retrouve jamais coupé du montant en fin de ligne (contre les troncatures).
  return symbole
    ? `${symbole}${ESPACE_FINE}${nombre}` // devise connue → préfixe symbolique
    : `${nombre}${ESPACE_FINE}${code}`; // repli → code ISO en suffixe
}

/** Vrai si le montant décimal est négatif (sortie). Test sur la chaîne. */
export function estNegatif(montant: string): boolean {
  return montant.trim().startsWith("-");
}

/** Vrai si le montant vaut zéro ("0", "0.00", "-0.00"…). Test sur la chaîne. */
export function estZero(montant: string): boolean {
  const { entier, decimales } = decomposer(montant);
  return entier === "0" && decimales === "00";
}
