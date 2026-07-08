/**
 * CONTRAT UI des ÉCHÉANCES prévisionnelles (Epic 8 · FEAT-8.2 ; cadrage
 * PLAN-cadrage-echeances.md §6/§7). L'UI code CONTRE cette interface ; la page RSC
 * `src/app/(workspace)/echeances/page.tsx` branche les Server Actions RÉELLES de
 * `./actions.ts` sur ces signatures (les démos/tests fournissent des stubs).
 *
 * Frontière (CLAUDE.md règle 2) : toutes les actions sont scopées au workspace
 * courant CÔTÉ SERVEUR (withWorkspace) — l'UI ne passe JAMAIS de workspace_id. Le
 * retour d'écriture est normalisé `ResultatAction` (code machine → message mappé, S2).
 *
 * Montants (règle 8) : chaînes décimales, jamais de float. Le SENS porte le signe
 * (`direction`) ; `montant` est toujours positif. Ces types sont un MIROIR fidèle de
 * `EcheanceLue` / `SyntheseEcheances` du repository serveur — l'UI n'invente rien.
 */

/** Sens de flux (miroir ECHEANCE_DIRECTIONS / CHECK SQL). */
export type DirectionEcheance = "encaissement" | "decaissement";

/**
 * Statut STOCKÉ (miroir ECHEANCE_STATUTS / CHECK SQL). « en_retard » N'EN FAIT PAS
 * PARTIE : il est DÉRIVÉ à la lecture (date passée + non terminal), jamais persisté.
 */
export type StatutEcheance =
  | "en_cours"
  | "partiel"
  | "paiement_en_cours"
  | "payee"
  | "annulee";

/** Statut d'AFFICHAGE : les statuts stockés + le dérivé « en_retard » (badge §3.6). */
export type StatutEcheanceAffiche = StatutEcheance | "en_retard";

/** Récurrence optionnelle (miroir ECHEANCE_RECURRENCES / CHECK SQL). */
export type RecurrenceEcheance = "mensuelle" | "trimestrielle";

/** Devises supportées à la saisie (multi-devise first — CLAUDE.md). */
export type DeviseEcheance = "MUR" | "USD" | "EUR";

/**
 * Une échéance telle qu'affichée par l'UI (miroir de `EcheanceLue` serveur). Le
 * statut d'affichage `statutAffiche` porte « en_retard » quand `enRetard` est vrai ;
 * `statut` reste le statut STOCKÉ (jamais « en_retard »), seul modifiable.
 */
export interface EcheanceUI {
  id: string;
  entityId: string | null;
  direction: DirectionEcheance;
  libelle: string;
  contrepartie: string | null;
  /** Chaîne décimale (règle 8), TOUJOURS positive. */
  montant: string;
  devise: string;
  /** Date comptable « nue » Maurice `YYYY-MM-DD`. */
  dateEcheance: string;
  /** Statut STOCKÉ (jamais « en_retard ») — c'est LUI qu'on transitionne. */
  statut: StatutEcheance;
  /** Statut d'AFFICHAGE : « en_retard » si dérivé, sinon `statut`. */
  statutAffiche: StatutEcheanceAffiche;
  /** Vrai si en retard (dérivé serveur, non stocké — ECH-D5). */
  enRetard: boolean;
  categorieId: string | null;
  recurrence: RecurrenceEcheance | null;
  /** Part déjà réglée (chaîne décimale) ou null. */
  montantRegle: string | null;
}

/** Une ligne de synthèse : UNE devise dans UN horizon (montants RESTANT dus). */
export interface SyntheseHorizonDeviseUI {
  devise: string;
  /** Somme des RESTANTS à encaisser (chaîne décimale). */
  encaissement: string;
  /** Somme des RESTANTS à décaisser (chaîne décimale). */
  decaissement: string;
  /** encaissement − decaissement (chaîne décimale, peut être négative). */
  net: string;
}

/** Un horizon de synthèse (30/60/90 j) avec ses lignes par devise. */
export interface SyntheseHorizonUI {
  jours: number;
  lignes: SyntheseHorizonDeviseUI[];
}

/** Synthèse complète : une entrée par horizon (30, 60, 90 j). */
export type SyntheseEcheancesUI = SyntheseHorizonUI[];

/** Vue combinée de la page : liste triée (par exigibilité) + synthèse par horizon. */
export interface EcheancesVueUI {
  echeances: EcheanceUI[];
  synthese: SyntheseEcheancesUI;
}

/** Résultat normalisé d'une écriture (miroir du `ResultatAction` serveur). */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** Entrée de création (miroir de `creerEcheanceSchema`). */
export interface CreerEcheanceInputUI {
  entityId?: string | null;
  direction: DirectionEcheance;
  libelle: string;
  contrepartie?: string | null;
  montant: string;
  devise: DeviseEcheance;
  dateEcheance: string;
  categorieId?: string | null;
  recurrence?: RecurrenceEcheance | null;
}

/** Entrée de modification PARTIELLE (miroir de `modifierEcheanceSchema`). */
export interface ModifierEcheanceInputUI {
  echeanceId: string;
  entityId?: string | null;
  direction?: DirectionEcheance;
  libelle?: string;
  contrepartie?: string | null;
  montant?: string;
  devise?: DeviseEcheance;
  dateEcheance?: string;
  categorieId?: string | null;
  recurrence?: RecurrenceEcheance | null;
}

/** Entrée de transition de statut (+ part réglée pour « partiel »). */
export interface ChangerStatutInputUI {
  echeanceId: string;
  statut: StatutEcheance;
  montantRegle?: string | null;
}

/**
 * Surface d'actions injectée à la feature des échéances. Le serveur fournit
 * l'implémentation (Server Actions closures) ; les démos/tests fournissent des stubs.
 * Toutes scopées au workspace courant côté serveur — l'UI ne passe JAMAIS de
 * workspace_id.
 */
export interface ActionsEcheances {
  /** Charge la vue : liste triée + synthèse par horizon. */
  listerEcheances(): Promise<EcheancesVueUI>;
  /** Crée une échéance. Échoue `FORBIDDEN_ROLE` pour un VIEWER (garde serveur). */
  creerEcheance(
    input: CreerEcheanceInputUI,
  ): Promise<ResultatAction<{ echeanceId: string }>>;
  /** Modifie les champs descriptifs (partiels) d'une échéance. */
  modifierEcheance(input: ModifierEcheanceInputUI): Promise<ResultatAction>;
  /** Transitionne le statut (+ montant réglé si « partiel »). */
  changerStatut(input: ChangerStatutInputUI): Promise<ResultatAction>;
  /** Supprime une échéance (projection non append-only — ECH-D3). */
  supprimerEcheance(echeanceId: string): Promise<ResultatAction>;
}
