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
