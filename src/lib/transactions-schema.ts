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
 * Filtres MÉTIER — SOURCE UNIQUE, partagée par la LISTE paginée et par l'AGRÉGAT de
 * somme nette (TX-RECHERCHE-SOMME-NETTE1). Tous optionnels (liste complète par
 * défaut). `recherche` porte sur le libellé nettoyé (jamais bank_label_raw — PII,
 * règle 8). Le filtre de statut s'appuie sur l'agrégat de ventilation (anti-N+1, cf.
 * repository).
 *
 * ⚠️ Les deux schémas exportés ci-dessous DÉRIVENT de cet objet — on ne recopie
 * JAMAIS la liste des champs. La somme nette doit porter EXACTEMENT les mêmes
 * prédicats que la liste, sinon le total affiché ne correspond pas aux lignes
 * affichées. Un filtre ajouté ici atterrit mécaniquement dans les deux (garantie
 * STRUCTURELLE, pas une consigne de vigilance).
 */
const filtresTransactions = z.object({
  /** Recherche plein-texte simple sur clean_label (ILIKE). */
  recherche: z.string().trim().min(1).max(120).optional(),
  /** Restreint à un compte bancaire (uuid). */
  bankAccountId: z.string().uuid().optional(),
  /**
   * Restreint aux transactions portant AU MOINS un split de cette catégorie du
   * référentiel TYGR (sémantique EXISTS, arbitrage PLAN-transactions-filtre-categorie
   * §2 : la DOMINANTE est un choix d'affichage, pas un critère d'appartenance —
   * filtrer dessus cacherait les splits minoritaires). Égalité STRICTE sur
   * category_id (pas de sous-arbre Nature→Sous-natures : TX-FILTRE-CAT-SOUSARBRE1).
   * Un uuid inconnu/étranger rend simplement 0 ligne (fail-safe non-énumérant).
   */
  categorieId: z.string().uuid().optional(),
  /** Filtre sur l'état de catégorisation. */
  statut: z.enum(STATUTS_VENTILATION).optional(),
  /** Bornes de date comptable (incluses). */
  dateDebut: dateComptable.optional(),
  dateFin: dateComptable.optional(),
});

/** Cohérence de l'intervalle : début ≤ fin si les deux sont fournis (partagé). */
function intervalleCoherent(f: {
  dateDebut?: string;
  dateFin?: string;
}): boolean {
  return !f.dateDebut || !f.dateFin || f.dateDebut <= f.dateFin;
}

/** Lecture PAGINÉE : les filtres + le curseur opaque et la taille de page. */
export const listerTransactionsSchema = filtresTransactions
  .extend({
    /** Curseur de page suivante (issu d'un appel précédent). */
    curseur: curseurOpaque.optional(),
    /** Taille de page demandée (clampée [1, 100]). */
    limite: z.coerce.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAUT),
  })
  .strict()
  .refine(intervalleCoherent, {
    message: "dateDebut doit précéder dateFin",
    path: ["dateDebut"],
  });

export type ListerTransactionsInput = z.infer<typeof listerTransactionsSchema>;

/**
 * AGRÉGAT « somme nette » : les MÊMES filtres que la liste, SANS curseur ni limite.
 * Une somme porte sur l'INTÉGRALITÉ du jeu filtré, pas sur une page — c'est toute la
 * raison d'être de cet agrégat serveur (piège TX-FILTRE1 : la pagination est en
 * KEYSET, le client ne détient qu'une page, sommer côté client ne totaliserait que le
 * visible). `.strict()` rejette donc explicitement un `curseur`/`limite` égaré.
 */
export const sommeNetteSchema = filtresTransactions
  .strict()
  .refine(intervalleCoherent, {
    message: "dateDebut doit précéder dateFin",
    path: ["dateDebut"],
  });

export type SommeNetteInput = z.infer<typeof sommeNetteSchema>;

export { LIMITE_DEFAUT, LIMITE_MAX };
