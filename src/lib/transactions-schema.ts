/**
 * Contrat de données (Zod) de la LECTURE paginée des transactions (B1-B3, page
 * /transactions). Valide les ENTRÉES côté frontière : filtres + curseur opaque.
 * Réutilisable par la Server Action et par les tests.
 *
 * PAGINATION PAR CURSEUR (keyset), jamais OFFSET : sur de gros volumes, OFFSET N
 * scanne et jette N lignes à chaque page (coût O(N), dégradation linéaire). Le
 * keyset reprend exactement après la dernière ligne via le tuple de tri, en O(log
 * n) grâce à l'index couvrant transactions_cache_workspace_date_idx
 * (workspace_id, transaction_date DESC). Le curseur est OPAQUE côté client : on ne
 * valide ici que sa FORME (base64url) ; sa structure interne (date+id) est un
 * détail du repository, jamais un contrat exposé — on peut la changer sans casser
 * l'UI.
 *
 * Montants : aucun ici (lecture seule). Dates de filtre = chaînes YYYY-MM-DD
 * (jour comptable Maurice, E20).
 */
import { z } from "zod";

/** Statut de ventilation d'une transaction (dérivé en SQL, cf. repository). */
export const STATUTS_VENTILATION = ["NON_CATEGORISE", "PARTIEL", "COMPLET"] as const;
export type StatutVentilation = (typeof STATUTS_VENTILATION)[number];

/** Borne de page : défaut 50, max 100. Garde-fou contre une page géante. */
const LIMITE_DEFAUT = 50;
const LIMITE_MAX = 100;

/**
 * Valide une date comptable RÉELLE (YYYY-MM-DD), pas seulement sa forme. La regex
 * seule accepte des dates impossibles (`2026-13-99`, `2026-02-30`) qui passeraient
 * la frontière puis casseraient Postgres en `::date` out-of-range (DrizzleQueryError
 * brut). On valide donc la validité CALENDAIRE par round-trip UTC. Partagé entre le
 * contrat Zod (filtres dateDebut/dateFin) et le décodage du curseur côté repository
 * (cohérence stricte d'un seul point de vérité).
 */
export function estDateComptableValide(valeur: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valeur);
  if (!m) return false;
  const [, a, mo, j] = m;
  const annee = Number(a);
  const mois = Number(mo);
  const jour = Number(j);
  const dt = new Date(Date.UTC(annee, mois - 1, jour));
  return (
    dt.getUTCFullYear() === annee &&
    dt.getUTCMonth() === mois - 1 &&
    dt.getUTCDate() === jour
  );
}

const dateComptable = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide (attendu YYYY-MM-DD)")
  .refine(estDateComptableValide, "Date inexistante (calendrier)");

/**
 * Curseur opaque : chaîne base64url non vide, bornée (anti-abus). On ne décode PAS
 * ici — `safeParse` ne garantit que la forme ; un curseur forgé est rejeté plus
 * loin au décodage (repository) sans jamais court-circuiter la RLS (le workspace
 * vient toujours de ctx, jamais du curseur).
 */
const curseurOpaque = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, "Curseur invalide");

/**
 * Filtres de lecture. Tous optionnels (liste complète par défaut). `recherche`
 * porte sur le libellé nettoyé (jamais bank_label_raw — PII, règle 8). Le filtre
 * de statut s'appuie sur l'agrégat de ventilation (anti-N+1, cf. repository).
 */
export const listerTransactionsSchema = z
  .object({
    /** Recherche plein-texte simple sur clean_label (ILIKE). */
    recherche: z.string().trim().min(1).max(120).optional(),
    /** Restreint à un compte bancaire (uuid). */
    bankAccountId: z.string().uuid().optional(),
    /** Filtre sur l'état de catégorisation. */
    statut: z.enum(STATUTS_VENTILATION).optional(),
    /** Bornes de date comptable (incluses). */
    dateDebut: dateComptable.optional(),
    dateFin: dateComptable.optional(),
    /** Curseur de page suivante (issu d'un appel précédent). */
    curseur: curseurOpaque.optional(),
    /** Taille de page demandée (clampée [1, 100]). */
    limite: z.coerce.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAUT),
  })
  .strict()
  // Cohérence de l'intervalle : début ≤ fin si les deux sont fournis.
  .refine(
    (f) => !f.dateDebut || !f.dateFin || f.dateDebut <= f.dateFin,
    { message: "dateDebut doit précéder dateFin", path: ["dateDebut"] },
  );

export type ListerTransactionsInput = z.infer<typeof listerTransactionsSchema>;

export { LIMITE_DEFAUT, LIMITE_MAX };
