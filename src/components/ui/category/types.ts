/**
 * CONTRAT PARTAGÉ UI ↔ Backend pour la catégorisation (Pilier 1).
 *
 * Frontière (décision 2026-06-17) : le Backend implémente les Server Actions et
 * les schémas Zod ; l'UI code ses composants CONTRE cette interface (deps
 * injectables, pattern `DepsWidget` du widget MFA). Le câblage réel branche les
 * Server Actions du Backend sur ces signatures.
 *
 * Ce fichier est aussi la LISTE DE COURSES pour le Backend : il expose tout ce
 * dont l'UI a besoin. Aujourd'hui le repository ne couvre que les splits
 * (`listerSplits`/`ajouterSplit`/`supprimerSplit`) — la lecture et le CRUD des
 * CATÉGORIES (`listerCategories`/`creerCategorie`/…) restent à livrer côté serveur.
 *
 * Types alignés sur `server/repositories/categorisation.ts` et le schéma
 * (`categories`, `transaction_categorizations`). Montants = chaînes décimales
 * (règle 8, jamais de float). Le signe vit sur la transaction ; un `amount` de
 * split est toujours > 0.
 */

/** Origine d'une catégorisation (miroir de `CategorizationSource` serveur). */
export type SourceCategorisation = "MANUAL" | "RULE";

/**
 * Catégorie telle qu'affichée par l'UI. Hiérarchie à 2 niveaux : `parentId` nul
 * = Nature (racine) ; sinon = Sous-nature. Pas de couleur en base — l'UI
 * l'attribue (CategoryBadge, déterministe par `id`).
 */
export interface CategorieUI {
  id: string;
  name: string;
  /** Nul = catégorie racine (Nature) ; sinon id du parent (même workspace). */
  parentId: string | null;
  /** false = archivée : masquée des pickers, mais l'historique de splits subsiste. */
  isActive: boolean;
}

/** Un split lu (miroir de `SplitLu` serveur), pour l'affichage d'une ventilation. */
export interface SplitUI {
  id: string;
  categoryId: string;
  /** Montant de CETTE part, chaîne décimale > 0. */
  amount: string;
  source: SourceCategorisation;
  ruleId: string | null;
}

/** Référence d'une transaction (clé composite — table partitionnée par date). */
export interface RefTransactionUI {
  transactionId: string;
  /** Date comptable Maurice YYYY-MM-DD (E20). */
  transactionDate: string;
}

/** Entrée d'ajout d'un split MANUEL (l'UI ne crée jamais de RULE — moteur à venir). */
export interface AjoutSplitManuelUI {
  transactionId: string;
  transactionDate: string;
  categoryId: string;
  amount: string;
}

/**
 * Résultat normalisé d'une action d'écriture. Le code machine permet à l'UI de
 * mapper un message (registre S2) — notamment `VENTILATION_EXCEEDS_AMOUNT` pour
 * un dépassement (la modale de ventilation pré-valide, mais le serveur juge).
 */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/**
 * Surface d'actions injectée aux composants de catégorisation. Le Backend fournit
 * l'implémentation réelle (Server Actions) ; les tests/démos fournissent des
 * stubs. Toutes les fonctions sont scopées au workspace courant côté serveur
 * (withWorkspace) — l'UI ne passe JAMAIS de workspace_id.
 */
export interface ActionsCategorisation {
  /** Catégories actives du workspace (pour les pickers). À livrer (Backend). */
  listerCategories(): Promise<CategorieUI[]>;
  /** Splits d'une transaction donnée. */
  listerSplits(ref: RefTransactionUI): Promise<SplitUI[]>;
  /** Ajoute un split manuel. Échoue `VENTILATION_EXCEEDS_AMOUNT` si dépassement. */
  ajouterSplit(input: AjoutSplitManuelUI): Promise<ResultatAction<{ splitId: string }>>;
  /** Retire un split (correction). Pas de `modifier` côté serveur : retirer + ré-ajouter. */
  supprimerSplit(splitId: string): Promise<ResultatAction>;
}

/**
 * Surface d'actions pour la gestion du référentiel (CategoryManagerModal).
 * À livrer côté serveur (le repository actuel ne couvre PAS le CRUD catégories).
 */
export interface ActionsReferentielCategories {
  listerCategories(): Promise<CategorieUI[]>;
  creerCategorie(input: {
    name: string;
    parentId: string | null;
  }): Promise<ResultatAction<{ categoryId: string }>>;
  renommerCategorie(input: { categoryId: string; name: string }): Promise<ResultatAction>;
  /** Archive (is_active=false) — jamais de suppression dure (préserve l'historique). */
  archiverCategorie(categoryId: string): Promise<ResultatAction>;
}
