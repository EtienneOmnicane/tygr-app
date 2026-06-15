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
 */

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
 * Formate un montant pour l'affichage : "7 691 000,00 MUR".
 * @param montant chaîne décimale (peut être négative)
 * @param devise code ISO (MUR/USD/EUR) — affiché en suffixe
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
  return `${signe}${corps}${ESPACE_FINE}${devise}`;
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
