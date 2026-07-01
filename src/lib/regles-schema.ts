/**
 * Contrat de données (Zod) du moteur de règles de catégorisation. Valide les
 * ENTRÉES côté frontière (Server Actions) : types, bornes, longueurs, énum de
 * stratégie. Les invariants base (FK catégorie, unicité) restent en base ; Zod
 * garde la FORME.
 *
 * `pattern` : motif textuel non vide (trim), ≤ 255 (aligné varchar(255)). Le
 * matching côté serveur échappe les méta-caractères LIKE — aucune contrainte de
 * caractères ici (un motif « 50% » est légitime).
 */
import { z } from "zod";

/** Stratégies de match supportées (miroir du CHECK SQL). */
export const ruleMatchTypeSchema = z.enum(["contains", "starts_with"]);

/** Motif : non vide après trim, ≤ 255 caractères. */
const motif = z.string().trim().min(1, "Motif requis").max(255);

/** Priorité : entier ≥ 0, borné (évite des valeurs absurdes). */
const priorite = z.number().int().min(0).max(100000);

export const creerRegleSchema = z
  .object({
    pattern: motif,
    matchType: ruleMatchTypeSchema,
    categoryId: z.string().uuid(),
    priority: priorite.optional(),
  })
  .strict();

export type CreerRegleInput = z.infer<typeof creerRegleSchema>;

/**
 * Modification partielle : tous les champs sont optionnels SAUF ruleId. On exige
 * au moins un champ à modifier (sinon l'appel n'a pas de sens) via un refine.
 */
export const modifierRegleSchema = z
  .object({
    ruleId: z.string().uuid(),
    pattern: motif.optional(),
    matchType: ruleMatchTypeSchema.optional(),
    categoryId: z.string().uuid().optional(),
    priority: priorite.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.pattern !== undefined ||
      d.matchType !== undefined ||
      d.categoryId !== undefined ||
      d.priority !== undefined ||
      d.isActive !== undefined,
    { message: "Aucun champ à modifier.", path: ["ruleId"] },
  );

export type ModifierRegleInput = z.infer<typeof modifierRegleSchema>;

export const archiverRegleSchema = z
  .object({ ruleId: z.string().uuid() })
  .strict();

/**
 * Réordonnancement des règles ACTIVES : liste ORDONNÉE des ruleId (le nouvel ordre
 * visuel). La priorité de chaque règle devient son index (0-based). `ordre` doit
 * être exactement l'ensemble des règles actives du workspace (l'égalité d'ensembles
 * est vérifiée côté repository sous RLS, pas ici — Zod ne connaît pas la base). Ici
 * on garde la FORME : uuids valides, au moins un, sans doublon, borne haute
 * pragmatique (le volume de règles est petit).
 */
export const reordonnerReglesSchema = z
  .object({
    ordre: z
      .array(z.string().uuid())
      .min(1, "Ordre vide")
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Ordre invalide (doublon).",
      }),
  })
  .strict();

export type ReordonnerReglesInput = z.infer<typeof reordonnerReglesSchema>;

/**
 * Application des règles : optionnellement bornée à un compte. Aucun montant ni
 * libellé en entrée (le service lit la base). bankAccountId facultatif (uuid).
 */
export const appliquerReglesSchema = z
  .object({
    bankAccountId: z.string().uuid().optional(),
  })
  .strict();

export type AppliquerReglesInput = z.infer<typeof appliquerReglesSchema>;
