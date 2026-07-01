/**
 * CONTRAT UI du moteur de règles de catégorisation (FYGR-style). L'UI code CONTRE
 * cette interface ; le câblage réel branche les Server Actions de
 * `src/app/(workspace)/regles/actions.ts` (livrées PR #95) sur ces signatures.
 *
 * Frontière (CLAUDE.md) : toutes les actions sont scopées au workspace courant
 * côté serveur (withWorkspace) — l'UI ne passe JAMAIS de workspace_id. Le retour
 * d'écriture est normalisé `ResultatAction` (code machine → message mappé, S2).
 *
 * « Supprimer » côté UI = ARCHIVER côté serveur (is_active=false) : la règle cesse
 * d'être appliquée mais subsiste (gouvernance / traçabilité — jamais de delete dur).
 */

/** Stratégie de correspondance (miroir du CHECK SQL + énum Zod serveur). */
export type RuleMatchType = "contains" | "starts_with";

/** Une règle telle qu'affichée par l'UI (miroir de `RegleDTO` serveur). */
export interface RegleUI {
  id: string;
  /** Motif textuel recherché dans le libellé (ex. « EDF »). */
  pattern: string;
  matchType: RuleMatchType;
  /** Catégorie cible appliquée quand le motif correspond. */
  categoryId: string;
  isActive: boolean;
  /** Ordre d'application (la plus haute priorité l'emporte ; défaut 0). */
  priority: number;
}

/** Résultat normalisé d'une écriture (miroir du `ResultatAction` serveur). */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/**
 * Surface d'actions injectée à la feature des règles. Le serveur fournit
 * l'implémentation (Server Actions) ; les démos/tests fournissent des stubs.
 */
export interface ActionsRegles {
  /** Liste les règles du workspace (toutes : actives ET archivées par défaut). */
  listerRegles(): Promise<RegleUI[]>;
  /** Crée une règle (motif + stratégie + catégorie cible, priorité optionnelle). */
  creerRegle(input: {
    pattern: string;
    matchType: RuleMatchType;
    categoryId: string;
    priority?: number;
  }): Promise<ResultatAction<{ ruleId: string }>>;
  /**
   * Modifie une règle existante (champs partiels). Sert aussi à RÉACTIVER une règle
   * archivée (`isActive:true`). La priorité n'est PAS passée ici : elle est pilotée
   * par le réordonnancement (`reordonnerRegles`).
   */
  modifierRegle(input: {
    ruleId: string;
    pattern?: string;
    matchType?: RuleMatchType;
    categoryId?: string;
    isActive?: boolean;
  }): Promise<ResultatAction>;
  /** Archive une règle (is_active=false) — « supprimer » côté UI. */
  archiverRegle(ruleId: string): Promise<ResultatAction>;
  /**
   * Réordonne les règles ACTIVES : `ordre` = liste des ruleId dans le nouvel ordre
   * visuel (la 1re gagne). Écriture de GOUVERNANCE réservée MANAGER/ADMIN côté
   * serveur. `ordre` doit être exactement l'ensemble des règles actives.
   */
  reordonnerRegles(ordre: string[]): Promise<ResultatAction>;
  /**
   * Ré-applique les règles aux transactions NON catégorisées (déclenchement
   * manuel). RÉSERVÉ MANAGER/ADMIN côté serveur (écrit des splits en masse) — la
   * feature ne l'expose qu'aux rôles qui peuvent modifier. Optionnelle : absente
   * si le conteneur ne veut pas l'offrir.
   */
  appliquerRegles?(): Promise<ResultatAction<{ appliquees: number }>>;
}
