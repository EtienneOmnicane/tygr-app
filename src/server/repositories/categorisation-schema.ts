/**
 * Contrat de données (Zod) de la catégorisation manuelle — Pilier 1. Réutilisable
 * par les Server Actions de l'UI (à venir) et par les tests. Valide les ENTRÉES
 * côté frontière : types, bornes, format décimal, cohérence source/rule_id.
 *
 * Les invariants qui dépendent d'AUTRES lignes (somme des splits ≤ montant txn)
 * ne sont PAS ici : ils vivent dans le repository en transaction (un schéma ne
 * voit qu'une entrée isolée). Zod garde la FORME ; le repository garde l'INVARIANT.
 *
 * Montants : chaîne décimale (règle 8, jamais de float côté TS). Format strict
 * `\d+(\.\d{1,2})?` > 0 — aligné sur numeric(15,2) en base (max 13 chiffres avant
 * la virgule, 2 après). Le signe est porté par la transaction, pas par le split :
 * un montant de split est toujours positif.
 */
import { z } from "zod";

/** Décimal positif à 2 décimales max, ≤ 13 chiffres entiers (numeric(15,2)). */
const montantDecimalPositif = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, "Montant décimal invalide")
  .refine((v) => Number(v) > 0, "Le montant doit être strictement positif");

export const ajouterSplitSchema = z
  .object({
    transactionId: z.string().uuid(),
    // Date comptable Maurice (YYYY-MM-DD) — clé composite de la transaction.
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide"),
    categoryId: z.string().uuid(),
    amount: montantDecimalPositif,
    source: z.enum(["MANUAL", "RULE"]),
    ruleId: z.string().uuid().nullable().default(null),
  })
  .strict()
  // Double verrou source/rule_id (miroir du CHECK SQL) : rejet bruyant à la
  // frontière, avant même d'atteindre la base.
  .refine(
    (d) =>
      (d.source === "MANUAL" && d.ruleId === null) ||
      (d.source === "RULE" && d.ruleId !== null),
    {
      message:
        "Incohérence source/rule_id : MANUAL exige rule_id nul, RULE exige un rule_id.",
      path: ["ruleId"],
    },
  );

export type AjouterSplitInput = z.infer<typeof ajouterSplitSchema>;

export const supprimerSplitSchema = z
  .object({ splitId: z.string().uuid() })
  .strict();

export const refTransactionSchema = z
  .object({
    transactionId: z.string().uuid(),
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide"),
  })
  .strict();
