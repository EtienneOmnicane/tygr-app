/**
 * Règles d'AFFICHAGE des indices de fiabilité de classification amont (Omni-FI) sur
 * une ligne de /transactions. Module PUR : zéro React, zéro réseau, zéro état — toute
 * la DÉCISION vit ici (pas dans le .tsx), donc testable unitairement sans renderer
 * (le projet n'a pas de renderer de test — choix tracé). Les composants présentationnels
 * (`FiabiliteBadge`, `SourceClassificationIcon`) ne font que RENDRE le verdict.
 *
 * Deux concepts AMONT, à ne jamais confondre avec la ventilation manuelle TYGR
 * (concept A, `statutCategorisation`) :
 *  - B. FIABILITÉ (`niveauFiabilite`) → badge « À vérifier ».
 *  - C. SOURCE (`sourceClassification`) → icône + infobulle.
 */
import type {
  NiveauFiabilite,
  SourceClassification,
} from "./types-transactions";

/* ------------------------------------------------------------------ */
/* B. Badge « À vérifier » (fiabilité)                                 */
/* ------------------------------------------------------------------ */

/**
 * Niveaux de fiabilité qui DÉCLENCHENT le badge « À vérifier » (sous réserve de la
 * condition catégorie ci-dessous). Constante ISOLÉE et volontairement élargissable :
 * si l'observation réelle des volumes (sandbox/prod) montre qu'il faut inclure
 * « Medium », on ajoute la valeur ICI — sans toucher au rendu (dette P2 du plan §8).
 */
export const NIVEAUX_A_VERIFIER: ReadonlySet<NiveauFiabilite> = new Set(["Low"]);

/**
 * Exiger qu'une catégorie soit POSÉE pour afficher « À vérifier ». RAISON (décision
 * produit validée) : le serializer Omni-FI met `ConfidenceLevel` à « Low » par DÉFAUT
 * sur les lignes NON enrichies ; sans cette condition, le badge apparaîtrait sur la
 * majorité des lignes (bruit) au lieu de signaler une classification présente mais
 * douteuse. Une ligne sans catégorie relève du repli « Non catégorisé », déjà affiché.
 * Flag isolé (ajustable après mesure, dette P2).
 */
export const EXIGE_CATEGORIE = true;

/**
 * Entrée minimale pour décider l'affichage du badge — un sous-ensemble de
 * `TransactionListItem` (on ne dépend que de ce qui est nécessaire, pour des tests
 * légers et un couplage faible).
 */
export interface EntreeFiabilite {
  niveauFiabilite: NiveauFiabilite | null;
  /** La catégorie OBIE traduite (sous-texte). `null` ⇔ aucune catégorie posée. */
  categorieBanque: string | null;
}

/**
 * Décide si le badge « À vérifier » doit s'afficher pour une ligne.
 *
 *   Low + catégorie posée → true ; tout le reste → false.
 *
 * `null` (fiabilité non remontée) → false : on n'alarme JAMAIS sur une absence de
 * donnée. `Medium`/`High` → false (classification jugée sûre par l'amont).
 */
export function afficherAVerifier(item: EntreeFiabilite): boolean {
  if (item.niveauFiabilite === null) return false;
  if (!NIVEAUX_A_VERIFIER.has(item.niveauFiabilite)) return false;
  if (EXIGE_CATEGORIE && item.categorieBanque === null) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* C. Source de classification (icône + infobulle)                    */
/* ------------------------------------------------------------------ */

/**
 * Variante d'icône pour une source. `USER_RULE` et `SYSTEM_RULE` partagent le glyphe
 * « règle » (deux variantes du même mécanisme déterministe) ; `ML_FALLBACK` a un
 * glyphe distinct (origine probabiliste). Évite un zoo d'icônes.
 */
export type GlypheSource = "regle" | "modele";

/**
 * Libellé + glyphe d'une source amont, pour l'infobulle et le lecteur d'écran.
 *
 * ⚠️ Les libellés disent « Omni-FI » et JAMAIS « par l'utilisateur » tout court :
 * `USER_RULE` est une règle définie DANS Omni-FI, pas la ventilation manuelle d'un
 * utilisateur TYGR (concept A). Confondre les deux serait un contresens produit.
 *
 * Retourne `null` si la source est inconnue/non remontée (aucune icône à afficher).
 */
export function descriptionSource(
  source: SourceClassification | null,
): { glyphe: GlypheSource; libelle: string } | null {
  switch (source) {
    case "USER_RULE":
      return { glyphe: "regle", libelle: "Classé par règle Omni-FI" };
    case "SYSTEM_RULE":
      return { glyphe: "regle", libelle: "Classé par règle système Omni-FI" };
    case "ML_FALLBACK":
      return { glyphe: "modele", libelle: "Classé par modèle (ML) Omni-FI" };
    case null:
      return null;
  }
}
