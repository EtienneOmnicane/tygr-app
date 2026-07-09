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

/**
 * Deep-link « Créer une règle » depuis la catégorisation (FB0709-REGLES-LIEN1).
 * Valide les searchParams `?nouvelle=1&motif=<pattern>&categorie=<uuid>` de
 * `regles/page.tsx`. STRICT et TOLÉRANT : les valeurs mal formées sont IGNORÉES
 * silencieusement (le formulaire s'ouvre sans pré-remplissage partiel) — jamais
 * d'erreur, jamais d'oracle. `catchall`/coercion volontairement absents : on ne
 * lit que ces 3 clés, le reste des searchParams est ignoré par nature.
 *
 * - `nouvelle` : "1" active l'ouverture pré-remplie (toute autre valeur = ignorée).
 * - `motif` : réutilise les bornes du motif de règle (trim, 1..255). Un motif vide
 *   ou trop long est écarté (le formulaire s'ouvre sans motif).
 * - `categorie` : uuid ; sa VALIDITÉ TENANT (appartenance au workspace) est
 *   re-vérifiée côté page contre le référentiel chargé sous RLS — un uuid d'un
 *   autre tenant (ou inexistant) est simplement ignoré (pas de pré-sélection),
 *   aucun oracle d'existence. `searchParams` peut fournir string | string[] :
 *   on n'accepte que la forme string (un tableau = clé répétée = ignorée).
 */
export const deepLinkRegleSchema = z
  .object({
    nouvelle: z.literal("1").optional(),
    motif: z.string().trim().min(1).max(255).optional(),
    categorie: z.string().uuid().optional(),
  })
  // Non-strict à dessein : les autres searchParams (le cas échéant) sont ignorés.
  .partial();

export type DeepLinkRegleInput = z.infer<typeof deepLinkRegleSchema>;
