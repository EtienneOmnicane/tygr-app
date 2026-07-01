/**
 * Libellé d'une transaction (marchand) avec CASCADE intelligente. Présentationnel PUR.
 *
 * Depuis la correction d'ingestion PROD-MERCHANT1 (commit b00e81c), `cleanLabel`
 * est hydraté depuis l'enrichissement Omni-FI. Le libellé PRINCIPAL suit une
 * hiérarchie stricte (arbitrage produit 2026-06-23), du plus « propre » au filet
 * de sécurité :
 *  1. `cleanLabel` (marchand enrichi) → `text-text` plein. Priorité absolue.
 *  2. à défaut `categorieFr` (catégorie OBIE de la banque, DÉJÀ traduite en FR par
 *     l'appelant) → `text-text` plein : on préfère une catégorie lisible (« Loyer »,
 *     « Charges ») au jargon bancaire brut. C'est une vraie donnée, pas un placeholder.
 *  3. à défaut `bankLabelRaw` (narratif brut OBIE `TransactionInformation`, « DBIT /
 *     POS / … ») → `text-muted` + italique : ultime filet, stylisé comme un repli pour
 *     le distinguer d'un libellé propre — illisible mais authentique, mieux que rien.
 *  4. à défaut un repli générique « Opération bancaire » → `text-muted` italique.
 *
 * RÈGLE PRODUIT — accessibilité de la donnée brute (Mission 3, 2026-06-23) :
 * QUEL QUE SOIT le niveau retenu, le `bankLabelRaw` (libellé bancaire d'origine) est
 * injecté dans l'attribut `title` du CONTENEUR DE LIGNE (cf. `transaction-row.tsx`),
 * de sorte que le narratif bancaire reste TOUJOURS lisible au survol — même quand un
 * marchand propre ou une catégorie l'a remplacé à l'affichage. On lève ainsi
 * l'ancienne interdiction stricte d'afficher le brut (PII) au profit de l'utilisabilité,
 * sans polluer l'écran : le brut est consultable à la demande, pas imposé. Le narratif
 * OBIE `TransactionInformation` n'est pas de la PII nominative. La recherche (ILIKE)
 * reste, elle, sur le marchand nettoyé uniquement (cf. repositories/transactions.ts).
 *
 * RÈGLE PRODUIT — anti-doublon (2026-06-23) : quand le libellé principal se rabat sur
 * le NIVEAU 2 (catégorie), l'appelant DOIT masquer le sous-texte « catégorie » de la
 * ligne (sinon la même catégorie apparaîtrait deux fois). Le composant n'affiche pas
 * ce sous-texte (il ne connaît que le libellé) ; il EXPOSE le niveau retenu via la
 * fonction pure `resoudreLibelle` pour que l'appelant pilote ce masquage. Voir
 * l'usage dans `transaction-row.tsx`.
 *
 * Tokens UNIQUEMENT (UI_GUIDELINES) : aucune couleur en dur. Aucune sémantique
 * inflow/outflow ici (réservée au montant) — un repli n'est ni une entrée ni une
 * sortie ni une erreur.
 */

/** Texte affiché quand NI marchand NI catégorie NI libellé brut ne sont disponibles. */
export const LIBELLE_REPLI = "Opération bancaire";

/** Niveau de la cascade effectivement retenu pour le libellé principal. */
export type NiveauLibelle = "marchand" | "categorie" | "brut" | "repli";

/** Entrées de la cascade (toutes nullables = « non disponible à ce niveau »). */
export interface SourcesLibelle {
  /** Marchand normalisé Omni-FI ; niveau 1. */
  cleanLabel?: string | null;
  /**
   * Catégorie OBIE de la banque DÉJÀ traduite en FR par l'appelant ; niveau 2.
   * DOIT être `null` quand la catégorie est absente ou non cartographiée (l'appelant
   * écarte le « Non catégorisé » par défaut) — sinon ce placeholder remonterait en
   * libellé principal. Voir `categorieFr` / l'adaptateur.
   */
  categorieFr?: string | null;
  /** Libellé brut bancaire (OBIE `TransactionInformation`) ; niveau 3. */
  bankLabelRaw?: string | null;
  /**
   * Active la cascade complète (niveaux 2 et 3). `true` par défaut (page
   * /transactions). `false` = mode historique marchand → repli (DASHBOARD), voir
   * `resoudreLibelle`.
   */
  cascade?: boolean;
}

/** Le libellé résolu : son niveau (pour l'anti-doublon) et le texte à afficher. */
export interface LibelleResolu {
  niveau: NiveauLibelle;
  texte: string;
}

/**
 * Résout le libellé principal selon la cascade (PURE, sans React) : marchand →
 * catégorie FR → brut bancaire → repli générique. Exposée pour que l'appelant
 * connaisse le `niveau` retenu (règle anti-doublon : masquer le sous-texte catégorie
 * quand `niveau === "categorie"`).
 *
 * `cascade` (défaut `true`) active les niveaux 2 et 3. Le passer à `false` restreint
 * au comportement HISTORIQUE marchand → repli générique (niveaux 1 et 4 seulement),
 * en IGNORANT catégorie ET brut même s'ils sont fournis. C'est le mode du DASHBOARD,
 * qui a une colonne Catégorie dédiée (l'anti-doublon n'y est pas transposable) et dont
 * le DTO ne porte pas encore le brut (dette TECH-DASHBOARD-CASCADE, cf. TODOS.md).
 */
export function resoudreLibelle({
  cleanLabel,
  categorieFr,
  bankLabelRaw,
  cascade = true,
}: SourcesLibelle): LibelleResolu {
  const marchand = cleanLabel?.trim();
  if (marchand) return { niveau: "marchand", texte: marchand };

  // Mode restreint (dashboard) : on saute directement au repli générique.
  if (!cascade) return { niveau: "repli", texte: LIBELLE_REPLI };

  const categorie = categorieFr?.trim();
  if (categorie) return { niveau: "categorie", texte: categorie };

  const brut = bankLabelRaw?.trim();
  if (brut) return { niveau: "brut", texte: brut };

  return { niveau: "repli", texte: LIBELLE_REPLI };
}

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function LibelleTransaction({
  cleanLabel,
  categorieFr,
  bankLabelRaw,
  cascade,
  className,
}: SourcesLibelle & {
  /** Classes de mise en page (troncature, taille) portées par l'appelant. */
  className?: string;
}) {
  const { niveau, texte } = resoudreLibelle({
    cleanLabel,
    categorieFr,
    bankLabelRaw,
    cascade,
  });

  // Niveaux 1 et 2 = vraie donnée lisible → texte plein. Niveaux 3 et 4 = repli
  // (brut jargonneux ou générique) → atténué + italique pour se lire comme un
  // placeholder, jamais comme un marchand.
  const estRepli = niveau === "brut" || niveau === "repli";

  return (
    <span className={cn(estRepli && "italic text-text-muted", !estRepli && "text-text", className)}>
      {texte}
    </span>
  );
}
