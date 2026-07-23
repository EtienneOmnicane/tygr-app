/**
 * Services de LECTURE du dashboard (Epic 3 — FEAT-3.1). Toutes les fonctions
 * s'exécutent DANS withWorkspace(session, fn) : `tx` porte app.current_workspace_id,
 * donc chaque SELECT est filtré par la policy RLS tenant_isolation — l'isolation
 * inter-workspace est garantie par la base, pas par un WHERE applicatif (CLAUDE.md
 * règle 2). Aucun de ces services ne prend workspace_id en paramètre.
 *
 * Règle 8 (montants) : les colonnes sont `numeric` ; toute SOMME/agrégat est
 * calculé EN SQL (jamais d'addition de floats côté JS). Les montants ressortent
 * en CHAÎNES décimales — la couche UI les formate (tabular-nums) sans recalcul.
 * Les transactions tombstone (is_removed=true) sont exclues de toute lecture.
 *
 * Étage 2 — ENTITÉ (ENTITY-READ-JOIN1) : la policy RLS RESTRICTIVE `entity_scope`
 * vit sur `bank_accounts` (migration 0008). Les soldes/transactions n'héritent du
 * périmètre entité QUE par une JOINTURE sur `bank_accounts` (pas de policy dédiée sur
 * l'append-only/partitionné). Toute lecture de `transactions_cache`/`balance_history`
 * ici joint donc `bank_accounts` pour que le scope morde par héritage : en Vision
 * Globale (GUC vide) la RESTRICTIVE laisse tout passer (agrégats inchangés) ; en Vision
 * Entité, les comptes hors périmètre (et les non assignés) sont masqués. Ne JAMAIS
 * lire ces tables filles sans cette jointure (sinon fuite intra-groupe — étage 2).
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  accountPartyRole,
  bankAccounts,
  bankConnections,
  balanceHistory,
  entities,
  parties,
  transactionsCache,
} from "@/server/db/schema";
import type { CategorySource } from "@/server/db/schema";
import type { WorkspaceTx } from "@/server/db/tenancy";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type Tx = WorkspaceTx<AnyPgDatabase>;

/* ------------------------------------------------------------------ */
/* Types de sortie (montants = chaînes décimales, règle 8)             */
/* ------------------------------------------------------------------ */

export interface CompteConnecte {
  bankAccountId: string;
  accountName: string;
  /** Nom lisible de la banque (« Absa Internet Banking »), via la connexion ; null si absent. */
  institutionName: string | null;
  currency: string;
  currentBalance: string | null;
  lastSyncedAt: Date | null;
  /**
   * TITULAIRE (Omni-FI Party) — libellé de groupement DISPLAY-ONLY, jamais un
   * filtre (le périmètre vit dans la RLS). `holderId` = parties.id (clé de groupe
   * stable), `holderName` = parties.name (PII d'affichage sous RLS : jamais loggé).
   * null = compte sans party exploitable → bucket « Non regroupé ». Optionnels :
   * les consommateurs/fixtures qui les ignorent restent valides.
   */
  holderId?: string | null;
  holderName?: string | null;
}

/**
 * Une ENTITÉ (BU) telle que le membre la voit, pour l'onglet « Par entité » du
 * sélecteur de périmètre (L8b-2). Dérivée des COMPTES VISIBLES (pas de
 * member_entity_scopes, qui rate la Vision Globale ; pas de listerEntites, ADMIN-only).
 */
export interface EntiteVisible {
  entityId: string;
  name: string;
  /** Nb de comptes de cette entité visibles sous le droit (libellé « Sucre · 3 comptes »). */
  nbComptes: number;
  /**
   * bankAccountId des comptes visibles de l'entité. Sert au libellé re-dérivé (C5) :
   * égalité ENSEMBLISTE EXACTE entre cet ensemble et le view_filter courant ⇒ « Sucre ».
   * (nbComptes === bankAccountIds.length ; les deux sont gardés pour la lisibilité.)
   */
  bankAccountIds: string[];
}

/**
 * Solde consolidé COURANT d'une devise (somme des `current_balance` des comptes de
 * cette devise). Multi-devises (CLAUDE.md) : on NE somme JAMAIS entre devises — on
 * expose une ligne PAR devise, l'UI les affiche côte à côte (« 7 074 400 MUR » +
 * « 179 200 USD »). La conversion vers la base_currency (FX annoté) est un chantier
 * séparé (TODOS DASH-FX1) ; tant qu'il n'existe pas, on n'invente aucun taux.
 */
export interface SoldeParDevise {
  currency: string;
  /** Somme des soldes courants de la devise, chaîne décimale (règle 8). */
  total: string;
}

export interface PointCourbe {
  date: string; // YYYY-MM-DD (jour comptable Maurice)
  /** Devise de CETTE série — jamais d'addition cross-devise (§2.4, PROD-TRESO-EOD1). */
  currency: string;
  soldeConsolide: string; // somme EOD des comptes de CETTE devise, chaîne numeric
}

export interface SyntheseMois {
  libelleMois: string; // YYYY-MM
  entrees: string;
  sorties: string;
  variation: string; // entrees - sorties (calcul SQL)
}

/**
 * Synthèse entrées/sorties/variation d'une PÉRIODE POUR UNE DEVISE. Multi-devises
 * (CLAUDE.md règle 8) : `synthesePeriodeParDevise` renvoie UNE entrée PAR devise — on
 * n'additionne JAMAIS des MUR et des USD (ce que faisait `syntheseMois`, qui sommait
 * `amount` toutes devises confondues et affichait le total dans la base_currency :
 * faux dès qu'un workspace a des comptes en plusieurs devises). Aucune conversion FX
 * (chantier DASH-FX1) : on expose les flux côte à côte, par devise.
 *
 * (Renommé de `SyntheseMoisDevise` en 2026-07-14 : la période n'est plus forcément un
 * MOIS — une plage précise `?du`/`?au` la borne au JOUR. Cf. `synthesePeriodeParDevise`.)
 */
export interface SynthesePeriodeDevise {
  currency: string;
  entrees: string;
  sorties: string;
  variation: string; // entrees - sorties (calcul SQL), pour CETTE devise
}

/**
 * Un point de la SÉRIE temporelle mensuelle (Cash In/Out), pour UN mois et UNE
 * devise. Alimente un graphique Front (barres entrées/sorties par mois). Multi-
 * devises (règle 8) : une ligne par (mois, devise) — JAMAIS d'addition cross-devise,
 * aucune conversion FX (chantier DASH-FX1). `mois` = "YYYY-MM" (mois comptable Maurice).
 */
export interface SyntheseMensuelle {
  mois: string; // "YYYY-MM" (mois comptable Maurice)
  currency: string;
  entrees: string;
  sorties: string;
  variation: string; // entrees - sorties (calcul SQL), pour CE mois ET CETTE devise
}

export interface TransactionRecente {
  omnifiTxnId: string;
  transactionDate: string;
  amount: string;
  currency: string;
  creditDebit: "Credit" | "Debit";
  cleanLabel: string | null;
  primaryCategory: string | null;
  subCategory: string | null;
  /** Provenance auto de la catégorie OBIE (true = pré-catégorisée par Omni-FI). */
  isAutoCategorized: boolean;
  /** Source de la catégorie auto (NULL si non auto). */
  categorySource: CategorySource | null;
  /**
   * Narratif bancaire brut (OBIE `TransactionInformation`) ; ultime filet de la cascade
   * de libellé quand `cleanLabel` est absent. Affiché atténué/italique et consultable au
   * survol (cf. `LibelleTransaction`). Le narratif OBIE n'est PAS de la PII nominative —
   * l'interdiction règle 8 vise les logs/télémétrie, pas l'UI du propriétaire.
   */
  bankLabelRaw: string | null;
  bankAccountId: string;
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

/** Comptes connectés (sélectionnés) du workspace — side-panel + en-tête courbe. */
export async function listerComptes(tx: Tx): Promise<CompteConnecte[]> {
  // Titulaire PRIMAIRE du compte (D2 — anti-multiplication de lignes) : un LEFT
  // JOIN nu sur account_party_role dupliquerait les comptes le jour où un compte
  // joint porte N parties. DISTINCT ON (bank_account_id) garantit 0/1 titulaire
  // par compte : is_primary DESC d'abord, puis name/id pour un choix déterministe.
  // Sécurité : la lecture reste PILOTÉE par bank_accounts (entity/account scope
  // par jointure — ENTITY-READ-JOIN1) ; parties et account_party_role portent en
  // plus leur propre tenant_isolation. Aucun workspace_id en paramètre.
  const titulairePrimaire = tx
    .selectDistinctOn([accountPartyRole.bankAccountId], {
      bankAccountId: accountPartyRole.bankAccountId,
      holderId: parties.id,
      holderName: parties.name,
    })
    .from(accountPartyRole)
    .innerJoin(parties, eq(accountPartyRole.partyId, parties.id))
    // Convention lecture du fichier (cf. entities.isActive plus bas) : une party
    // ARCHIVÉE ne titre plus de groupe — son compte retombe dans « Non regroupé ».
    .where(eq(parties.isActive, true))
    .orderBy(
      accountPartyRole.bankAccountId,
      desc(accountPartyRole.isPrimary),
      parties.name,
      parties.id,
    )
    .as("titulaire_primaire");

  const lignes = await tx
    .select({
      bankAccountId: bankAccounts.id,
      accountName: bankAccounts.accountName,
      // Provenance bancaire (DASH-INST1) : le nom vit sur la connexion. innerJoin
      // sûr car bank_accounts.connection_id est NOT NULL (tout compte a une connexion).
      institutionName: bankConnections.institutionName,
      currency: bankAccounts.currency,
      currentBalance: bankAccounts.currentBalance,
      lastSyncedAt: bankAccounts.lastSyncedAt,
      holderId: titulairePrimaire.holderId,
      holderName: titulairePrimaire.holderName,
    })
    .from(bankAccounts)
    .innerJoin(bankConnections, eq(bankAccounts.connectionId, bankConnections.id))
    .leftJoin(
      titulairePrimaire,
      eq(bankAccounts.id, titulairePrimaire.bankAccountId),
    )
    .where(eq(bankAccounts.isSelected, true))
    .orderBy(bankAccounts.accountName);
  return lignes;
}

/**
 * Connexions bancaires du workspace (page /banques — QA-LISTES-MANQUANTES1a : la
 * page ne montrait que « + Connecter », jamais les banques déjà reliées). UNE ligne
 * par connexion : nom d'institution, statut, nombre de comptes rattachés et fraîcheur
 * de la dernière synchro (max des comptes). LEFT JOIN pour lister aussi une connexion
 * sans compte (0). Pilotée par la RLS tenant (`tenant_isolation` sur bank_connections) ;
 * le nombre de comptes hérite en plus du scope entité (RESTRICTIVE sur bank_accounts,
 * ENTITY-READ-JOIN1) — un membre scopé voit la connexion mais ne compte que ses comptes
 * visibles. Aucun workspace_id en paramètre. Agrégats calculés EN SQL (règle 8).
 */
export interface ConnexionBancaire {
  connectionId: string;
  /**
   * Identifiant OMNI-FI de la connexion (`bank_connections.omnifi_connection_id`) — à ne
   * pas confondre avec `connectionId`, qui est notre UUID INTERNE (`bank_connections.id`).
   *
   * ⚠️ POURQUOI IL EST EXPOSÉ : c'est la SEULE clé qui permet de rapprocher la liste des
   * banques de l'écran des signaux `reparation[]` / `aReconnecter[]` d'`EtatFinalisation`,
   * lesquels portent `cx.ConnectionId` — l'identifiant AMONT (`orchestration.ts`), pas le
   * nôtre. Sans cette colonne, les deux jeux d'identifiants ne sont pas joignables et
   * l'UI ne peut afficher qu'un compteur anonyme (« 2 banque(s) »).
   *
   * Aucune surface nouvelle : cet identifiant traverse DÉJÀ vers le client dans
   * `EtatFinalisation.aReconnecter[].connectionId`. C'est un UUID opaque amont, pas de la
   * PII — et le nom d'institution qu'il permet de résoudre, lui, reste dans l'UI
   * authentifiée scopée (règle 8 : jamais dans un log, une erreur ou la télémétrie).
   */
  omnifiConnectionId: string;
  /** Nom lisible de l'institution ; null si la connexion est antérieure à la colonne. */
  institutionName: string | null;
  /** Statut STOCKÉ (« active », …) — libellé mappé côté UI. */
  status: string;
  /** Nombre de comptes rattachés VISIBLES sous le droit du membre. */
  nbComptes: number;
  /** Dernière synchro (max sur les comptes) ; null si aucun compte synchronisé. */
  lastSyncedAt: Date | null;
  createdAt: Date;
}

export async function listerConnexionsBancaires(
  tx: Tx,
): Promise<ConnexionBancaire[]> {
  const lignes = await tx
    .select({
      connectionId: bankConnections.id,
      omnifiConnectionId: bankConnections.omnifiConnectionId,
      institutionName: bankConnections.institutionName,
      status: bankConnections.status,
      createdAt: bankConnections.createdAt,
      nbComptes: sql<number>`count(${bankAccounts.id})::int`,
      // Agrégat SQL brut : Drizzle NE mappe PAS un `sql` vers Date (contrairement à
      // une vraie colonne timestamptz). `max(...)` remonte donc une CHAÎNE du driver
      // pg/Neon — on la type honnêtement `string | null` et on la coerce ci-dessous.
      lastSyncedAt: sql<string | null>`max(${bankAccounts.lastSyncedAt})`,
    })
    .from(bankConnections)
    .leftJoin(bankAccounts, eq(bankAccounts.connectionId, bankConnections.id))
    .groupBy(
      bankConnections.id,
      bankConnections.omnifiConnectionId,
      bankConnections.institutionName,
      bankConnections.status,
      bankConnections.createdAt,
    )
    .orderBy(bankConnections.institutionName, bankConnections.createdAt);
  // Coercion Date à la frontière du repository : l'UI reçoit un vrai `Date`
  // (formaterFraicheurRelative appelle `.getTime()`). createdAt est une vraie
  // colonne → déjà mappée en Date, pas de coercion nécessaire.
  return lignes.map((l) => ({
    ...l,
    lastSyncedAt: l.lastSyncedAt ? new Date(l.lastSyncedAt) : null,
  }));
}

/**
 * Le TENANT a-t-il au moins une connexion bancaire ? (NUDGE-VISION-ENTITE1)
 *
 * Sert à distinguer deux situations que `listerComptes` rend identiques (0 ligne) :
 * « cet espace n'a aucune banque » et « cet espace en a une, mais aucun de ses comptes
 * n'est dans mon périmètre ». Sans ce signal, le dashboard affiche l'empty state global
 * à un membre scopé — donc lui NIE une connexion que /banques lui montre juste à côté.
 *
 * SÉCURITÉ — pourquoi ce COUNT est sûr, et pourquoi il porte sur CETTE table :
 *  - `bank_connections` ne porte QUE `tenant_isolation` (PERMISSIVE, migration 0003) —
 *    vérifié exhaustivement sur les migrations : ni `entity_scope`, ni `account_scope`,
 *    ni clause `view_filter`. Le comptage est donc borné au workspace PAR LA RLS
 *    elle-même, pas par un WHERE applicatif qu'un oubli pourrait perdre (règle 2) ;
 *  - il ne joint PAS `bank_accounts` : aucun contournement de l'étage 2. C'est tout
 *    l'intérêt — un COUNT de comptes « hors scope » exigerait de neutraliser le GUC
 *    `app.current_entity_scope`, ce qui est INTERDIT ;
 *  - il ne divulgue rien de neuf : `listerConnexionsBancaires` ci-dessus expose DÉJÀ
 *    toutes les connexions du tenant à tout membre (nbComptes=0 sous périmètre), et
 *    /banques n'a pas de garde de rôle. L'appelant n'en dérive qu'un BOOLÉEN — ni id,
 *    ni nom, ni montant, ni entité.
 *
 * À appeler dans le `withWorkspace` DÉJÀ ouvert par la page : un second withWorkspace
 * rejouerait le défaut d'auto-amputation L8b-1 (un chemin parallèle qui lit sous un
 * périmètre différent du reste de l'écran).
 */
export async function compterConnexionsTenant(tx: Tx): Promise<number> {
  const [ligne] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bankConnections);
  return ligne?.n ?? 0;
}

/**
 * Traduction « axe ENTITÉ → liste de bankAccountId » pour le sélecteur de périmètre
 * (L8b-2). Renvoie les comptes de l'entité `entityId` VISIBLES sous le droit du membre.
 *
 * SÉCURITÉ — pourquoi cette lecture est sûre (différence CRITIQUE avec le bloc 4b de
 * tenancy.ts) : 4b traduit entité→comptes AVANT la pose du droit (sur l'état tenant
 * BRUT) parce qu'il CONSTRUIT le droit. Ici, au contraire, la fonction s'exécute DANS
 * un withWorkspace dont la session a DÉJÀ posé `entity_scope` (RESTRICTIVE) et
 * `account_scope` (RESTRICTIVE) — donc le SELECT ne voit QUE les comptes du périmètre du
 * membre. Conséquences fail-closed :
 *  - un `entityId` hors du périmètre du membre → 0 ligne (la RLS masque tout) ;
 *  - une entité dont le membre ne voit qu'une partie des comptes → le SOUS-ENSEMBLE
 *    visible, jamais l'entité entière. C'est cette lecture scopée qui empêche qu'une
 *    entité hors-droit fasse fuiter des comptes (le rempart serveur view_filter, qui
 *    intersecte DROIT ∩ filtre dans tenancy.ts, reste le garant ultime en aval).
 *
 * APPELANT (C3) : appeler avec une session SANS `viewFilter` (userId + activeWorkspaceId
 * seulement). Sinon la clause AND view_filter de la policy account_scope amputerait la
 * traduction (même mécanique que le bug #143) → l'entité ne pourrait jamais ré-élargir.
 *
 * Pas de filtre `workspace_id` paramètre : la RLS (tenant + entity + account scope) borne
 * la lecture (CLAUDE.md règle 2). `eq` PARAMÉTRÉ (zéro interpolation). Ordre stable par
 * `accountName` (déterminisme d'affichage + comparaison ensembliste du libellé, C5).
 */
export async function comptesParEntite(
  tx: Tx,
  entityId: string,
): Promise<string[]> {
  const lignes = await tx
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(eq(bankAccounts.entityId, entityId))
    .orderBy(bankAccounts.accountName);
  return lignes.map((l) => l.id);
}

/**
 * Source des entités du sélecteur « Par entité » (L8b-2), pour TOUS les rôles (pas
 * d'`exigerAdmin` : c'est le but — une lecture entités non-admin, scopée RLS). On
 * NE réutilise PAS `listerEntites` (ADMIN-only, lèverait pour un MANAGER et exposerait
 * un nbComptes non scopé) ni `member_entity_scopes` (vide en Vision Globale → raterait
 * les entités du groupe).
 *
 * On part de `bank_accounts` (filtré par tenant_isolation + entity_scope + account_scope)
 * et on `innerJoin entities` pour le nom : la BORNE entité vient du côté bank_accounts
 * (un compte hors scope est déjà absent → son entité n'apparaît pas), donc fail-closed.
 * `innerJoin` ⇒ les comptes `entity_id IS NULL` (non assignés, NULL-B) ne forment AUCUN
 * groupe — ils restent accessibles via l'onglet « Par compte ».
 *
 * - Vision Globale (entity_scope non posé) : DISTINCT couvre toutes les entités portées
 *   par ≥1 compte du groupe.
 * - Vision Entité (membre scopé) : la liste se réduit aux entités du périmètre ayant ≥1
 *   compte visible.
 *
 * Filtres : `isSelected=true` (cohérent avec listerComptes) + `isActive=true` (une entité
 * archivée disparaît du picker ; un compte resté assigné à elle reste visible « Par
 * compte »). `array_agg` calqué sur entites.ts (array_remove NULL par sécurité, même si
 * l'innerJoin garantit déjà des id non-NULL). Ordre stable par nom.
 */
export async function listerEntitesVisibles(tx: Tx): Promise<EntiteVisible[]> {
  const lignes = await tx
    .select({
      entityId: entities.id,
      name: entities.name,
      nbComptes: sql<number>`count(${bankAccounts.id})::int`,
      bankAccountIds: sql<
        string[]
      >`coalesce(array_remove(array_agg(${bankAccounts.id}), null), '{}')::text[]`,
    })
    .from(bankAccounts)
    .innerJoin(entities, eq(bankAccounts.entityId, entities.id))
    .where(and(eq(bankAccounts.isSelected, true), eq(entities.isActive, true)))
    .groupBy(entities.id, entities.name)
    .orderBy(entities.name);
  return lignes;
}

/**
 * Solde consolidé courant : somme du DERNIER solde EOD connu de chaque compte.
 * On prend, par compte, la ligne balance_history de date max, puis on somme.
 * Calcul d'agrégat EN SQL (numeric), retour en chaîne. NULL → "0.00".
 */
export async function soldeConsolideCourant(tx: Tx): Promise<string> {
  // Sous-requête : dernier solde par compte (date max).
  const dernier = tx
    .select({
      bankAccountId: balanceHistory.bankAccountId,
      maxDate: sql<string>`max(${balanceHistory.balanceDate})`.as("max_date"),
    })
    .from(balanceHistory)
    .groupBy(balanceHistory.bankAccountId)
    .as("dernier");

  const res = await tx
    .select({
      total: sql<string>`coalesce(sum(${balanceHistory.balance}), 0)::text`,
    })
    .from(balanceHistory)
    .innerJoin(
      dernier,
      and(
        eq(balanceHistory.bankAccountId, dernier.bankAccountId),
        eq(balanceHistory.balanceDate, dernier.maxDate),
      ),
    )
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope par jointure sur
    // bank_accounts. La sous-requête `dernier` peut calculer des dates max pour des
    // comptes hors scope, mais ce join les ÉLIMINE (la policy masque ces bank_accounts
    // → pas de correspondance), donc la somme ne porte que sur le périmètre. NOT NULL
    // garanti sur bank_account_id. (Fonction sans appelant applicatif vivant à ce jour,
    // mais corrigée pour ne pas laisser une fuite balance_history par une autre porte.)
    .innerJoin(bankAccounts, eq(balanceHistory.bankAccountId, bankAccounts.id));
  return res[0]?.total ?? "0";
}

/**
 * Soldes consolidés COURANTS par devise — somme de `bank_accounts.current_balance`
 * des comptes sélectionnés, GROUP BY devise. C'est la source du « Solde Total » du
 * dashboard : elle ne dépend PAS de `balance_history` (vide tant qu'Omni-FI n'expose
 * pas `/balances/history`, cf. OMNIFI_API_FEEDBACK.md §10), contrairement à
 * `soldeConsolideCourant` (réservé aux usages EOD historiques).
 *
 * Multi-devises (CLAUDE.md, règle 8) : agrégat EN SQL (numeric), une ligne par
 * devise, jamais d'addition cross-devise. Les comptes à `current_balance` NULL sont
 * ignorés par `sum`. Ordonné par devise pour un affichage stable.
 */
export async function soldesCourantsParDevise(tx: Tx): Promise<SoldeParDevise[]> {
  const lignes = await tx
    .select({
      currency: bankAccounts.currency,
      total: sql<string>`coalesce(sum(${bankAccounts.currentBalance}), 0)::text`,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.isSelected, true))
    .groupBy(bankAccounts.currency)
    .orderBy(bankAccounts.currency);
  return lignes;
}

/**
 * Courbe de trésorerie : solde EOD CONSOLIDÉ (somme multi-comptes) par jour ET PAR
 * DEVISE, sur [from, to]. Agrégation SQL ; une ligne par (jour, devise) ayant au moins
 * un solde. MULTI-DEVISE (§2.4, règle 8) : le `GROUP BY` porte sur `(balance_date,
 * currency)` — JAMAIS sur la date seule, qui additionnerait des roupies et des dollars
 * (bug historique). Le rendu trace une SÉRIE PAR DEVISE, jamais une addition cross-devise.
 */
export async function courbeTresorerie(
  tx: Tx,
  fenetre: { from: string; to: string },
): Promise<PointCourbe[]> {
  const lignes = await tx
    .select({
      date: balanceHistory.balanceDate,
      currency: balanceHistory.currency,
      soldeConsolide: sql<string>`sum(${balanceHistory.balance})::text`,
    })
    .from(balanceHistory)
    // ENTITY-READ-JOIN1 : la policy RLS entity_scope vit sur bank_accounts. Cette
    // jointure (sûre : balance_history.bank_account_id est NOT NULL) la fait HÉRITER
    // sur les soldes EOD → en Vision Entité, seuls les comptes du périmètre comptent
    // dans la courbe ; en Vision Globale (GUC vide) la RESTRICTIVE laisse tout passer
    // → agrégat inchangé. Sans elle, la lecture directe fuit les autres entités.
    .innerJoin(bankAccounts, eq(balanceHistory.bankAccountId, bankAccounts.id))
    .where(
      and(
        gte(balanceHistory.balanceDate, fenetre.from),
        lte(balanceHistory.balanceDate, fenetre.to),
      ),
    )
    .groupBy(balanceHistory.balanceDate, balanceHistory.currency)
    .orderBy(balanceHistory.balanceDate, balanceHistory.currency);
  return lignes;
}

/**
 * @deprecated MULTI-DEVISE CASSÉ : cette fonction somme `amount` SANS GROUP BY devise
 * → pour un workspace avec des comptes MUR + USD, elle additionne des roupies et des
 * dollars et l'UI affiche le total dans la base_currency (faux). Conservée le temps que
 * le Front migre la carte `CashFlowSummary` vers `syntheseMoisParDevise` (une ligne par
 * devise). NE PAS l'utiliser dans du code neuf.
 *
 * Synthèse entrées/sorties/variation d'un mois (YYYY-MM). Somme conditionnelle
 * EN SQL sur le sens ; exclut les tombstones. Montants en chaînes.
 */
export async function syntheseMois(
  tx: Tx,
  mois: string, // "YYYY-MM"
): Promise<SyntheseMois> {
  const debut = `${mois}-01`;
  // Borne haute exclusive = 1er du mois suivant (calcul SQL pour rester correct).
  const res = await tx
    .select({
      entrees: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)::text`,
      sorties: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)::text`,
      variation: sql<string>`(
        coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)
        - coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)
      )::text`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : transactions_cache.bank_account_id est NOT NULL). En Vision
    // Entité, la synthèse entrées/sorties ne compte que les transactions du périmètre ;
    // en Vision Globale la RESTRICTIVE n'exclut rien → totaux inchangés.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        gte(transactionsCache.transactionDate, debut),
        sql`${transactionsCache.transactionDate} < (${debut}::date + interval '1 month')`,
      ),
    );
  return {
    libelleMois: mois,
    entrees: res[0]?.entrees ?? "0",
    sorties: res[0]?.sorties ?? "0",
    variation: res[0]?.variation ?? "0",
  };
}

/**
 * Synthèse entrées/sorties/variation d'une PÉRIODE [from, to] VENTILÉE PAR DEVISE —
 * remplace `syntheseMois` pour le multi-devise (challenge mapping 2026-06-22). GROUP BY
 * devise : une ligne par devise présente sur la période, JAMAIS d'addition cross-devise
 * (CLAUDE.md règle 8). Mêmes règles que `syntheseMois` (somme conditionnelle EN SQL sur
 * le sens, exclusion des tombstones, montants en chaînes) + héritage du scope entité
 * par jointure sur bank_accounts (ENTITY-READ-JOIN1). Ordonné par devise (affichage
 * stable). Période sans transaction → tableau vide (l'UI affiche 0 dans la devise de base).
 *
 * ⚠️ BORNES AU JOUR, INCLUSIVES (TOOLBAR-DATE-PRECISE1, 2026-07-14) — était
 * `syntheseMoisParDevise(mois)`, qui bornait au MOIS ENTIER (`>= mois-01`,
 * `< mois-01 + 1 mois`). Ça coïncidait tant que la seule fenêtre possible était un preset
 * (dont le `from` tombe toujours un 1er du mois). Avec une PLAGE PRÉCISE (`?du`/`?au`),
 * ça ne coïncide plus : une plage « 3 mars → 17 avril » aurait renvoyé AVRIL ENTIER, donc
 * des montants HORS période — un mensonge d'affichage sur de la donnée financière. Les
 * bornes viennent désormais de l'appelant (`resoudrePeriode`), qui possède le contrat
 * d'URL. `from`/`to` sont des dates comptables MAURICE (E20 : `transaction_date` l'est
 * déjà — aucune re-conversion de fuseau ici).
 */
export async function synthesePeriodeParDevise(
  tx: Tx,
  opts: { from: string; to: string }, // "YYYY-MM-DD" INCLUSIFS (dates Maurice)
): Promise<SynthesePeriodeDevise[]> {
  const lignes = await tx
    .select({
      currency: transactionsCache.currency,
      entrees: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)::text`,
      sorties: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)::text`,
      variation: sql<string>`(
        coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)
        - coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)
      )::text`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : bank_account_id NOT NULL). Même garantie que syntheseMois.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        // Bornes JOUR inclusives des DEUX côtés (≠ ancien « < 1er du mois suivant »).
        gte(transactionsCache.transactionDate, opts.from),
        lte(transactionsCache.transactionDate, opts.to),
      ),
    )
    .groupBy(transactionsCache.currency)
    .orderBy(transactionsCache.currency);
  return lignes;
}

/**
 * SÉRIE temporelle mensuelle des entrées/sorties (Cash In/Out), groupée PAR MOIS
 * et PAR DEVISE — destinée à alimenter un graphique Front (barres mensuelles).
 *
 * Fenêtre : [`from`, `to`] au JOUR, bornes INCLUSIVES, passées explicitement
 * (déterministe + testable ; « aujourd'hui » dépend du fuseau Maurice et se calcule côté
 * appelant — `resoudrePeriode` —, JAMAIS d'un now() opaque ici).
 *
 * ⚠️ BORNES AU JOUR (TOOLBAR-DATE-PRECISE1, 2026-07-14) — la fenêtre était auparavant
 * `{moisFin, nbMois}`, donc calée sur des BORDS DE MOIS. Ça coïncidait avec le filtre tant
 * que la seule fenêtre possible était un preset (`from` = un 1er du mois, `to` =
 * aujourd'hui). Avec une PLAGE PRÉCISE (`?du`/`?au`), une fenêtre « 3 mars → 17 avril »
 * aurait agrégé MARS ENTIER + AVRIL ENTIER : des montants hors période dans les barres.
 * Le groupement reste MENSUEL — les mois d'EXTRÉMITÉ d'une plage sont donc légitimement
 * PARTIELS (mars = 3→31), ce que l'UI annonce par le libellé de période.
 *
 * FUSEAU (CLAUDE.md, non négociable) : on groupe sur `transaction_date`, qui est
 * DÉJÀ la date comptable Maurice (dérivée à l'ingestion via
 * deriverDateComptableMaurice, AT TIME ZONE Indian/Mauritius). Il ne faut donc PAS
 * re-convertir le fuseau ici — la colonne est déjà en jour calendaire Maurice
 * (même raison que syntheseMois, qui filtre directement sur transaction_date). Un
 * date_trunc('month', transaction_date) donne donc bien le mois comptable Maurice.
 *
 * Multi-devises (règle 8) : GROUP BY (mois, devise) → une ligne par couple, JAMAIS
 * d'addition cross-devise, aucune conversion FX (DASH-FX1). Sommes conditionnelles
 * sur le sens EN SQL, en numeric (chaînes en sortie), tombstones exclus. Héritage
 * du scope entité par jointure sur bank_accounts (ENTITY-READ-JOIN1) : en Vision
 * Entité la série ne compte que le périmètre ; en Vision Globale, RESTRICTIVE
 * neutre → série inchangée.
 *
 * Mois SANS transaction : ABSENT de la série (pas de ligne fabriquée — on ne sait
 * pas dans quelle devise mettre un 0 en multi-devise). Le Front comble l'axe via
 * `grilleMois` (cf. ci-dessous). Ordre : chronologique (mois) puis devise (stable).
 */
export async function syntheseParMois(
  tx: Tx,
  opts: { from: string; to: string }, // "YYYY-MM-DD" INCLUSIFS (dates Maurice)
): Promise<SyntheseMensuelle[]> {
  const mois = sql<string>`to_char(date_trunc('month', ${transactionsCache.transactionDate}), 'YYYY-MM')`;
  const lignes = await tx
    .select({
      mois: mois,
      currency: transactionsCache.currency,
      entrees: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)::text`,
      sorties: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)::text`,
      variation: sql<string>`(
        coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)
        - coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)
      )::text`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : bank_account_id NOT NULL). Même garantie que syntheseMois.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        // Bornes JOUR inclusives (≠ anciens bords de MOIS dérivés de moisFin/nbMois).
        gte(transactionsCache.transactionDate, opts.from),
        lte(transactionsCache.transactionDate, opts.to),
      ),
    )
    .groupBy(mois, transactionsCache.currency)
    .orderBy(mois, transactionsCache.currency);
  return lignes;
}

/**
 * Grille des `nbMois` derniers mois (du plus ancien au plus récent), ancrée sur
 * `moisAncrage` ("YYYY-MM", typiquement le mois courant à Maurice). PURE (sans DB,
 * sans `Date` locale) → testable : on décompose l'ancre en année/mois et on recule
 * mois par mois en arithmétique entière (pas de dérive de fuseau).
 *
 * Sert à COMBLER l'axe temporel de `syntheseParMois`, qui omet les mois sans
 * transaction (il ne peut pas inventer la devise d'un 0 en multi-devise). Le Front
 * mappe cette grille sur la série pour obtenir un axe CONTINU.
 *
 * @returns ex. nbMois=3, moisAncrage="2026-03" → ["2026-01","2026-02","2026-03"].
 */
export function grilleMois(nbMois: number, moisAncrage: string): string[] {
  const [anneeStr, moisStr] = moisAncrage.split("-");
  let annee = Number(anneeStr);
  let mois = Number(moisStr); // 1..12
  const grille: string[] = [];
  for (let i = 0; i < nbMois; i++) {
    grille.push(`${annee}-${String(mois).padStart(2, "0")}`);
    mois -= 1;
    if (mois === 0) {
      mois = 12;
      annee -= 1;
    }
  }
  return grille.reverse(); // du plus ancien au plus récent
}

/**
 * Grille des `nbMois` mois qui SUIVENT `moisAncrage` (du plus proche au plus lointain),
 * ancrage EXCLU. Pendant exact de `grilleMois` (qui recule) : même arithmétique entière,
 * même pureté (sans DB, sans `Date` locale → aucune dérive de fuseau).
 *
 * Sert l'axe PRÉVISIONNEL du dashboard (C1) : `grilleMois` couvre le réalisé jusqu'au
 * mois d'ancrage, `grilleMoisSuivants` prolonge la fenêtre vers l'avant, où les colonnes
 * sont alimentées par les occurrences d'échéances (jamais par des transactions).
 *
 * L'ancrage est EXCLU parce qu'il appartient déjà à la grille du réalisé : le mois
 * courant est une colonne MIXTE (réalisé + prévision empilés, décision D2) — il n'est
 * pas dupliqué en tête de la zone future.
 *
 * @returns ex. nbMois=3, moisAncrage="2026-11" → ["2026-12","2027-01","2027-02"].
 */
export function grilleMoisSuivants(nbMois: number, moisAncrage: string): string[] {
  const [anneeStr, moisStr] = moisAncrage.split("-");
  let annee = Number(anneeStr);
  let mois = Number(moisStr); // 1..12
  const grille: string[] = [];
  for (let i = 0; i < nbMois; i++) {
    mois += 1;
    if (mois === 13) {
      mois = 1;
      annee += 1;
    }
    grille.push(`${annee}-${String(mois).padStart(2, "0")}`);
  }
  return grille; // déjà du plus proche au plus lointain
}

/**
 * N transactions les plus récentes (hors tombstone), triées date desc puis
 * booking desc. Expose `bankLabelRaw` (narratif OBIE brut) comme ultime filet de la
 * cascade de libellé (alignement dashboard ↔ /transactions, dette TECH-DASHBOARD-CASCADE
 * résolue 2026-07-10) : le narratif OBIE `TransactionInformation` n'est pas de la PII
 * nominative — l'interdiction règle 8 vise les logs/télémétrie, pas l'UI du propriétaire.
 */
export async function transactionsRecentes(
  tx: Tx,
  limite = 8,
): Promise<TransactionRecente[]> {
  const lignes = await tx
    .select({
      omnifiTxnId: transactionsCache.omnifiTxnId,
      transactionDate: transactionsCache.transactionDate,
      amount: transactionsCache.amount,
      currency: transactionsCache.currency,
      creditDebit: transactionsCache.creditDebit,
      cleanLabel: transactionsCache.cleanLabel,
      primaryCategory: transactionsCache.primaryCategory,
      subCategory: transactionsCache.subCategory,
      isAutoCategorized: transactionsCache.isAutoCategorized,
      categorySource: transactionsCache.categorySource,
      bankLabelRaw: transactionsCache.bankLabelRaw,
      bankAccountId: transactionsCache.bankAccountId,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : transactions_cache.bank_account_id est NOT NULL). En Vision
    // Entité, seules les transactions des comptes du périmètre remontent ; en Vision
    // Globale la RESTRICTIVE laisse tout passer → liste inchangée. La jointure ne
    // change ni les colonnes sélectionnées (toutes issues de transactions_cache) ni la
    // cardinalité (1 compte par transaction), donc le contrat TransactionRecente tient.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(eq(transactionsCache.isRemoved, false))
    .orderBy(desc(transactionsCache.transactionDate), desc(transactionsCache.bookingDateTime))
    .limit(limite);
  return lignes as TransactionRecente[];
}
