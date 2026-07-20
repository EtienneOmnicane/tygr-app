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

const ESPACE_FINE = " "; // espace fine insécable — séparateur de milliers FR

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
  // Zéro n'a JAMAIS de signe (règle « zéro = Rs 0,00 sans signe ») — y compris
  // un zéro signé "-0.00" (sortie FX / arrondi) : on neutralise le − ET le +.
  const signe = estZero ? "" : negatif ? "−" : opts.signeExplicite ? "+" : "";
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

/**
 * Suffixes d'ordre de grandeur du format compact, du plus grand au plus petit.
 * `chiffres` = longueur de partie entière à partir de laquelle le suffixe s'applique.
 */
const PALIERS_COMPACTS = [
  { suffixe: "Md", chiffres: 10 },
  { suffixe: "M", chiffres: 7 },
  { suffixe: "k", chiffres: 4 },
] as const;

/**
 * Formate un montant en COMPACT pour un contexte à largeur contrainte (étiquette de
 * barre, axe) : `Rs 10 k`, `Rs 3,1 M`, `Rs 2,4 Md`, `Rs 850`.
 *
 * ## Pourquoi il vit ICI et pas dans le composant
 * Règle 8 / audit ergonomie 2026-06-22 : la source de formatage des montants est UNIQUE.
 * Un « petit format court » recodé dans un graphe est exactement la dette C8 qui a été
 * tuée (trois formateurs de date parallèles).
 *
 * ## Il TRONQUE, il n'arrondit pas — et c'est un choix
 * `999999` rend `999,9 k`, **jamais** `1 M`. Arrondir ferait afficher un palier que le
 * montant n'a PAS atteint : sur un outil de trésorerie (seuils, covenants, découverts),
 * « 1 M » pour 999 999,00 est le mauvais côté de l'approximation. La troncature ne peut
 * que sous-estimer, jamais promettre. Corollaire assumé : le compact est APPROXIMATIF par
 * construction — il est réservé aux contextes contraints, et le montant exact reste
 * accessible (tooltip, tableau « Évolution mensuelle »), jamais remplacé par lui.
 *
 * ## Zéro arithmétique flottante
 * Tout se joue par découpage de la CHAÎNE (longueur de la partie entière → palier ;
 * premier chiffre du reste → décimale). Aucune division, donc aucun centime perdu — même
 * sur un montant à 15 chiffres.
 *
 * @param montant chaîne décimale (peut être négative)
 * @param devise code ISO — mêmes règles que `formatMontant` (symbole préfixe / ISO suffixe
 *   / `""` = montant nu)
 */
export function formatMontantCompact(montant: string, devise: string): string {
  const { negatif, entier, decimales } = decomposer(montant);

  const palier = PALIERS_COMPACTS.find((p) => entier.length >= p.chiffres);

  let corps: string;
  if (palier === undefined) {
    // < 1 000 : aucune abréviation possible sans perdre l'ordre de grandeur. On garde la
    // partie entière telle quelle et on laisse tomber les centimes (contexte contraint).
    corps = entier;
  } else {
    const rangDecimale = palier.chiffres - 1; // 3 pour k, 6 pour M, 9 pour Md
    const tete = entier.slice(0, entier.length - rangDecimale);
    const premiereDecimale = entier[entier.length - rangDecimale];
    // La décimale n'apparaît que si elle porte de l'information : « 10 k », pas « 10,0 k ».
    // `grouperMilliers` sur la tête couvre le cas extrême (> 10^12, tête à 4 chiffres) —
    // improbable, mais il ne coûte rien et évite un « 1234 Md » non groupé.
    corps =
      premiereDecimale === "0"
        ? `${grouperMilliers(tete)}${ESPACE_FINE}${palier.suffixe}`
        : `${grouperMilliers(tete)},${premiereDecimale}${ESPACE_FINE}${palier.suffixe}`;
  }

  // Un zéro n'a jamais de signe (même règle que `formatMontant`, y compris pour "-0.00").
  const estZeroCompact = entier === "0" && decimales === "00";
  const nombre = `${estZeroCompact || !negatif ? "" : "−"}${corps}`;

  const code = devise.trim();
  if (code === "") return nombre;
  const symbole = SYMBOLES_PREFIXE[code.toUpperCase()];
  return symbole
    ? `${symbole}${ESPACE_FINE}${nombre}`
    : `${nombre}${ESPACE_FINE}${code}`;
}

/**
 * Symbole de préfixe d'une devise connue (`MUR`→`Rs`, `USD`→`$`, `EUR`→`€`), ou
 * `null` si inconnue (repli ISO suffixe). Sert à l'affichage multi-devises qui
 * sépare le symbole du corps numérique pour ALIGNER les virgules décimales —
 * source unique de la table (pas de duplication dans un composant).
 */
export function symbolePrefixe(devise: string): string | null {
  return SYMBOLES_PREFIXE[devise.trim().toUpperCase()] ?? null;
}

/**
 * Indicateur de devise à poser À GAUCHE d'un montant nu, format UNIFIÉ : le
 * symbole si la devise est connue (`Rs`/`$`/`€`), SINON le code ISO en majuscules
 * (`GBP`, `ZAR`) — plus jamais de code en suffixe inline. `null` pour une devise
 * vide (contexte de saisie qui n'affiche aucun indicateur).
 *
 * Contrat de la pile multi-devise (UI-SOLDE-MULTIDEVISE-POLISH1) : l'indicateur
 * occupe une colonne gauche de largeur `auto`, le montant nu la colonne droite
 * `tabular-nums` — les virgules décimales s'alignent quelle que soit la devise.
 */
export function indicateurDevise(devise: string): string | null {
  const code = devise.trim();
  if (code === "") return null;
  return SYMBOLES_PREFIXE[code.toUpperCase()] ?? code.toUpperCase();
}

/**
 * Nom LISIBLE d'une devise (label des cartes de solde de la refonte Dodo :
 * « Roupie mauricienne », « Dollar américain »…). Centralisé ICI (source unique
 * des concernes d'AFFICHAGE de devise, à côté d'`indicateurDevise`) pour ne pas
 * réintroduire un dictionnaire ad-hoc dans un composant. Devise inconnue → repli
 * sur le code ISO en majuscules ; devise vide → chaîne vide.
 */
const NOMS_DEVISE: Record<string, string> = {
  MUR: "Roupie mauricienne",
  USD: "Dollar américain",
  EUR: "Euro",
};

export function nomDevise(devise: string): string {
  const code = devise.trim().toUpperCase();
  if (code === "") return "";
  return NOMS_DEVISE[code] ?? code;
}

/**
 * Corps numérique NU d'un montant (« 7 691 000,00 », « −384 250,00 », « +25,50 »),
 * sans aucun indicateur de devise ni espace parasite. Remplace proprement le hack
 * `formatMontant(x, "")` : délègue au formateur partagé avec devise vide, donc
 * signe typographique, zéro-sans-signe, groupement FR et anti-float restent
 * garantis par une SEULE implémentation. Se pose à droite d'`indicateurDevise`.
 */
export function montantNu(
  montant: string,
  opts: { signeExplicite?: boolean } = {},
): string {
  return formatMontant(montant, "", opts);
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
