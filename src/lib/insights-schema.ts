/**
 * Schémas zod stricts pour les Insights dérivés (TECH-API-INSIGHTS, Gate OWASP).
 *
 * Frontière de validation d'entrée (CLAUDE.md règle 3) : toute lecture d'insights
 * appelée depuis une Server Action / RSC valide ses paramètres ICI avant d'atteindre
 * le repository. Enums FERMÉES (granularité, direction) — impossible d'injecter une
 * unité SQL arbitraire : le repository mappe ces valeurs vers des littéraux SQL figés.
 * Dates au format calendaire strict ; `topN` borné. Mêmes bornes que le repository
 * (défense en profondeur : la validation zod n'est pas l'unique garde).
 *
 * Le style suit `src/lib/regles-schema.ts` (z.enum / z.string().trim() / z.number().int()).
 */
import { z } from "zod";

/**
 * Bornes du top N vendors — SOURCE UNIQUE, définie ici (frontière) car ce module est
 * importable côté client : il ne peut PAS dépendre de `src/server/**` (règle 2, garde
 * lint no-restricted-imports). Le repository serveur RÉUTILISE ces constantes (la
 * dépendance va lib → server, jamais l'inverse). Plafond dur = anti-abus mémoire/SQL.
 */
export const VENDORS_TOP_N_MAX = 100;
export const VENDORS_TOP_N_DEFAUT = 10;

/** Granularité temporelle du cashflow (enum fermée, valeurs FR). */
export const granulariteCashflowSchema = z.enum(["jour", "semaine", "mois"]);

/** Sens d'analyse des vendors (enum fermée). */
export const directionVendorsSchema = z.enum(["inflow", "outflow", "both"]);

/**
 * Date calendaire "YYYY-MM-DD" RÉELLE (rejette 2026-02-30, 2026-13-01 — pièges F1/F2).
 * On valide le format PUIS la validité calendaire via reconstruction UTC (un Date qui
 * « déborde » ne réécrit pas les composantes → on détecte l'invalide).
 */
const dateCalendaire = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD")
  .refine((s) => {
    const [a, m, j] = s.split("-").map(Number);
    const d = new Date(Date.UTC(a, m - 1, j));
    return (
      d.getUTCFullYear() === a &&
      d.getUTCMonth() === m - 1 &&
      d.getUTCDate() === j
    );
  }, "Date calendaire invalide");

/** topN borné [1, VENDORS_TOP_N_MAX] ; défaut métier si omis. */
const topN = z
  .number()
  .int()
  .min(1)
  .max(VENDORS_TOP_N_MAX)
  .default(VENDORS_TOP_N_DEFAUT);

/**
 * Paramètres de `cashflowParDevise` : fenêtre [from, to] + granularité. La cohérence
 * from ≤ to est vérifiée ici (refine) ET dans le repository (défense en profondeur).
 */
export const cashflowParamsSchema = z
  .object({
    granularite: granulariteCashflowSchema,
    from: dateCalendaire,
    to: dateCalendaire,
  })
  .refine((v) => v.from <= v.to, {
    message: "from doit être antérieur ou égal à to",
    path: ["from"],
  });

/** Paramètres de `vendorsParConcentration` : sens + top N borné. */
export const vendorsParamsSchema = z.object({
  direction: directionVendorsSchema.default("outflow"),
  topN: topN.optional(),
});

export type CashflowParams = z.infer<typeof cashflowParamsSchema>;
export type VendorsParams = z.infer<typeof vendorsParamsSchema>;

/**
 * Sens d'analyse d'un camembert par catégorie (enum fermée, sans `both` : on ne
 * mélange pas crédits et débits dans un donut). Mappé côté repository vers un
 * littéral SQL figé (`credit_debit = 'Credit' | 'Debit'`).
 */
export const sensFluxSchema = z.enum(["inflow", "outflow"]);

/**
 * Preset de période de l'analyse (enum fermée). Les bornes réelles [from, to] sont
 * calculées À MAURICE côté serveur (E20) par `bornesPeriodeMaurice`
 * (`lib/periode-analyse.ts`) — le client n'envoie qu'un preset, jamais des dates
 * (pas de fuseau client interpolé dans une borne comptable).
 */
export const periodePresetSchema = z.enum([
  "mois-courant",
  "30-jours",
  "90-jours",
  "12-mois",
]);

/**
 * Paramètres de la Server Action d'analyse par catégorie : sens + preset de période.
 * Défauts métier = analyse des SORTIES du mois courant (cas d'usage FYGR « category
 * analysis » = dépenses). Les dates sont dérivées du preset côté serveur, pas ici.
 */
export const analyseCategoriesParamsSchema = z.object({
  sens: sensFluxSchema.default("outflow"),
  periode: periodePresetSchema.default("mois-courant"),
});

export type SensFluxParam = z.infer<typeof sensFluxSchema>;
export type PeriodePresetParam = z.infer<typeof periodePresetSchema>;
export type AnalyseCategoriesParams = z.infer<
  typeof analyseCategoriesParamsSchema
>;
