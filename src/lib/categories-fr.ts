/**
 * Table de correspondance des catégories de transactions OBIE → FRANÇAIS
 * (DR-F1, décision actée 2026-06-22, chantier `PLAN-audit-ergonomie-soldes.md` Lot 3).
 *
 * POURQUOI côté AFFICHAGE et pas côté service : Omni-FI renvoie `PrimaryCategory`
 * en anglais (catégorisation OBIE de la banque : « Income », « Utilities »…). Dans
 * une interface 100 % française, ces libellés bruts détonnent (finding /design-review
 * le plus visible). La localisation côté service (table de mapping en base, i18n
 * amont) est REPORTÉE (dette tracée) ; ici on traduit au RENDU, sans toucher la donnée
 * stockée — `primary_category` reste la valeur OBIE brute (export, réconciliation,
 * filtres futurs raisonnent dessus en anglais, langue pivot stable).
 *
 * NB de périmètre : ceci concerne la catégorie OBIE *automatique* (`primaryCategory`).
 * La catégorie de VENTILATION MANUELLE (saisie par l'utilisateur, déjà en français,
 * cf. `CategoryManager`) ne passe PAS par cette table — elle est localisée à la source.
 *
 * Correspondance fondée sur les catégories OBIE RÉELLEMENT émises par l'API (sonde
 * runtime 2026-06-23 sur compte réel : `business expenses`, `professional fees`,
 * `revenue`, `administrative costs`, `personnel`, `food & drink`, `travel &
 * transport`, `housing`, `healthcare`, `other`, `income`). Une clé INCONNUE
 * (catégorie OBIE non encore cartographiée, ou `null`) retombe sur « Non
 * catégorisé » — JAMAIS d'anglais résiduel à l'écran, et pas de crash.
 *
 * ⚠️ Catalogue FIGÉ = fragile : l'amont émet librement, ce mapping est une liste
 * fermée maintenue à la main. Toute catégorie OBIE hors liste s'affiche « Non
 * catégorisé » silencieusement (avant la sonde, 96 % des transactions étaient dans
 * ce cas). Dette OBIE-CATALOG1 (TODOS.md) : à reconsidérer si l'amont ajoute des
 * catégories ou si une localisation côté service est livrée.
 */

/** Libellé affiché quand la catégorie est absente ou non cartographiée. */
export const CATEGORIE_FR_PAR_DEFAUT = "Non catégorisé";

/**
 * OBIE `PrimaryCategory` (anglais, langue pivot) → libellé d'affichage français.
 *
 * Clés normalisées en minuscules à la lecture (`categorieFr` applique `toLowerCase`),
 * donc la casse renvoyée par l'API n'a pas d'importance. On inclut quelques
 * SOUS-catégories fréquentes (« Bank Charges ») par robustesse, au cas où un appelant
 * passerait une sous-catégorie : la résolution reste correcte sans élargir le contrat.
 */
const CORRESPONDANCE_FR: Record<string, string> = {
  // Catégories OBIE observées en runtime (sonde 2026-06-23). `income` et `revenue`
  // fusionnés sous « Revenus » (deux clés OBIE → même libellé FR, arbitrage validé).
  income: "Revenus",
  revenue: "Revenus",
  "business expenses": "Charges d'exploitation",
  "professional fees": "Honoraires",
  "administrative costs": "Frais administratifs",
  personnel: "Personnel",
  "food & drink": "Restauration",
  "travel & transport": "Déplacements",
  housing: "Logement",
  healthcare: "Santé",
  other: "Autres",
  // Catégories historiques (seed de démo / doc API) — conservées : sans coût et
  // robustes si l'amont les ré-émet.
  rent: "Loyer",
  utilities: "Charges",
  insurance: "Assurances",
  taxes: "Taxes",
  payroll: "Salaires",
  "banking & finance": "Frais bancaires",
  "bank charges": "Frais bancaires",
};

/**
 * Traduit une catégorie OBIE en français pour l'affichage. `null`/`undefined`/vide
 * ou clé inconnue → « Non catégorisé ». Aucune mutation de la donnée d'origine.
 */
export function categorieFr(primaryCategory: string | null | undefined): string {
  const clef = primaryCategory?.trim().toLowerCase();
  if (!clef) return CATEGORIE_FR_PAR_DEFAUT;
  return CORRESPONDANCE_FR[clef] ?? CATEGORIE_FR_PAR_DEFAUT;
}
