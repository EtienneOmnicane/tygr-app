/**
 * Contrat de données (Zod) des échéances (créances/dettes projetées — cadrage
 * PLAN-cadrage-echeances.md §6). Valide les ENTRÉES côté frontière (Server Actions)
 * et sert les tests. Zod garde la FORME (types, bornes, énum, décimal) ; les
 * invariants base (FK entité/catégorie scopées workspace, RLS entity_scope, CHECK
 * `montant_regle <= montant`) restent en base — un schéma ne voit qu'une entrée
 * isolée.
 *
 * Énumérations codées en dur ICI (miroir des CHECK SQL / const arrays de schema.ts),
 * volontairement PAS importées de `@/server/db/schema` : ce module est importable
 * côté client (formulaire de saisie), la frontière serveur ne doit pas fuir. Toute
 * évolution d'énum se répercute des deux côtés (revue — règle 6).
 *
 * Montants : chaîne décimale (règle 8, jamais de float côté TS). Format strict
 * aligné sur numeric(15,2) — 13 chiffres entiers max, 2 décimales. `montant` est
 * strictement positif (une échéance porte un montant) ; `montant_regle` (part déjà
 * réglée) peut être nul (0) — le signe/sens est porté par `direction`, pas par le
 * montant.
 */
import { z } from "zod";

import { estDateISO } from "@/lib/format-date";

/** Sens de flux (miroir ECHEANCE_DIRECTIONS / CHECK SQL). */
export const directionEcheanceSchema = z.enum(["encaissement", "decaissement"]);

/** Cycle de vie (miroir ECHEANCE_STATUTS / CHECK SQL). « en_retard » N'EST PAS
 * un statut stocké : il est DÉRIVÉ (date passée + non terminal) à la lecture. */
export const statutEcheanceSchema = z.enum([
  "en_cours",
  "partiel",
  "paiement_en_cours",
  "payee",
  "annulee",
]);

/** Récurrence optionnelle (miroir ECHEANCE_RECURRENCES / CHECK SQL). */
export const recurrenceEcheanceSchema = z.enum(["mensuelle", "trimestrielle"]);

/** Devises supportées (multi-devise first — CLAUDE.md). Devise = char(3) en base ;
 * on borne à l'énum métier à la frontière (pas d'ISO arbitraire à la saisie). */
export const deviseEcheanceSchema = z.enum(["MUR", "USD", "EUR"]);

/** Décimal strictement positif, ≤ 13 chiffres entiers, 2 décimales (numeric(15,2)). */
const montantDecimalPositif = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, "Montant décimal invalide")
  .refine((v) => Number(v) > 0, "Le montant doit être strictement positif");

/** Décimal positif OU NUL (part réglée) — même forme numeric(15,2). Le regex exclut
 * déjà le négatif ; « 0 » est légitime (rien encore réglé). La borne haute
 * (≤ montant) est un invariant cross-champ → gardé par le CHECK SQL (23514), pas ici. */
const montantRegleDecimal = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, "Montant réglé décimal invalide");

/** Libellé : non vide après trim, ≤ 255 (aligné varchar(255)). */
const libelleEcheance = z.string().trim().min(1, "Libellé requis").max(255);

/**
 * Contrepartie optionnelle, undefined-préservant pour la modification PARTIELLE :
 * `undefined` = « ne pas toucher », `null`/chaîne vide = « effacer », chaîne = valeur
 * (trim). Sans ce transform, un PATCH sans contrepartie l'écraserait à null.
 */
const contrepartieOpt = z
  .string()
  .trim()
  .max(255, "Contrepartie trop longue (max 255)")
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v && v.length > 0 ? v : null));

/**
 * Date d'échéance : `YYYY-MM-DD` valide (rejette les dates roulées via estDateISO)
 * et bornée (2000–2100 — garde-fou contre une saisie absurde). C'est une date
 * comptable « nue » Maurice, comparée lexicographiquement à `dateCouranteMaurice()`
 * pour dériver « en retard » (CLAUDE.md Localisation — fuseau posé explicitement).
 */
const dateEcheanceSchema = z
  .string()
  .refine(estDateISO, "Date d'échéance invalide (attendu AAAA-MM-JJ)")
  .refine(
    (v) => v >= "2000-01-01" && v <= "2100-12-31",
    "Date d'échéance hors plage (2000–2100)",
  );

/**
 * Création : direction + libellé + montant + devise + date obligatoires. Ni `statut`
 * ni `montant_regle` en entrée — une échéance naît « en_cours », non réglée (défauts
 * base). `entityId` optionnel (NULL = non assigné, visible ADMIN uniquement ; un
 * membre scopé ne peut créer que DANS son périmètre — fail-closed RLS entity_scope).
 */
export const creerEcheanceSchema = z
  .object({
    entityId: z.string().uuid().nullable().optional(),
    direction: directionEcheanceSchema,
    libelle: libelleEcheance,
    contrepartie: contrepartieOpt,
    montant: montantDecimalPositif,
    devise: deviseEcheanceSchema,
    dateEcheance: dateEcheanceSchema,
    categorieId: z.string().uuid().nullable().optional(),
    recurrence: recurrenceEcheanceSchema.nullable().optional(),
  })
  .strict();

export type CreerEcheanceInput = z.infer<typeof creerEcheanceSchema>;

/**
 * Modification PARTIELLE des champs descriptifs : tous optionnels SAUF echeanceId.
 * Au moins un champ à modifier (sinon l'appel n'a pas de sens) via refine. Le cycle
 * de vie (`statut`, `montant_regle`) est HORS de ce schéma : il transite par
 * `changerStatutEcheance` (séparation des préoccupations). Réduire `montant` sous un
 * `montant_regle` déjà posé lèvera le CHECK SQL (23514) — invariant cross-champ non
 * visible ici.
 */
export const modifierEcheanceSchema = z
  .object({
    echeanceId: z.string().uuid(),
    entityId: z.string().uuid().nullable().optional(),
    direction: directionEcheanceSchema.optional(),
    libelle: libelleEcheance.optional(),
    contrepartie: contrepartieOpt,
    montant: montantDecimalPositif.optional(),
    devise: deviseEcheanceSchema.optional(),
    dateEcheance: dateEcheanceSchema.optional(),
    categorieId: z.string().uuid().nullable().optional(),
    recurrence: recurrenceEcheanceSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.entityId !== undefined ||
      d.direction !== undefined ||
      d.libelle !== undefined ||
      d.contrepartie !== undefined ||
      d.montant !== undefined ||
      d.devise !== undefined ||
      d.dateEcheance !== undefined ||
      d.categorieId !== undefined ||
      d.recurrence !== undefined,
    { message: "Aucun champ à modifier.", path: ["echeanceId"] },
  );

export type ModifierEcheanceInput = z.infer<typeof modifierEcheanceSchema>;

/**
 * Transition de cycle de vie + part réglée. `partiel` EXIGE un `montant_regle`
 * fourni (un « partiel » sans montant réglé n'a pas de sens). Les autres statuts
 * n'ont pas de montant réglé pertinent : le repository le remet à NULL. La borne
 * `montant_regle <= montant` (invariant cross-champ) est gardée par le CHECK SQL,
 * pas ici (23514 → MontantRegleInvalideError).
 */
export const changerStatutEcheanceSchema = z
  .object({
    echeanceId: z.string().uuid(),
    statut: statutEcheanceSchema,
    montantRegle: montantRegleDecimal.nullable().optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.statut !== "partiel" ||
      (d.montantRegle !== undefined && d.montantRegle !== null),
    {
      message: "Un statut « partiel » exige un montant réglé.",
      path: ["montantRegle"],
    },
  );

export type ChangerStatutEcheanceInput = z.infer<
  typeof changerStatutEcheanceSchema
>;

export const supprimerEcheanceSchema = z
  .object({ echeanceId: z.string().uuid() })
  .strict();

export type SupprimerEcheanceInput = z.infer<typeof supprimerEcheanceSchema>;
