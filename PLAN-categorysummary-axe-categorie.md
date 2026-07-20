# PLAN — Repository `categorySummary` : axe catégorie × mois × devise (PROD-GRAPHS-FYGR1)

**Phase :** Conception (règle 1) — **aucune ligne de code applicatif**.
**Date :** 2026-07-17 · **Chantier :** PROD-GRAPHS-FYGR1 (TODOS.md:3053), pré-requis
transverse de l'incrément A « vue tableau du réalisé » et de la matrice
(`PLAN-cadrage-scenario-previsionnel-fygr.md` §4/§6).
**Décision d'archi associée :** `DECISION-categorysummary-amont-vs-interne.md` (à
trancher par Etienne AVANT toute implémentation — ce plan couvre les DEUX options au
niveau contrat, pour que l'arbitrage n'invalide rien).
**Cadrages amont :** `PLAN-cadrage-graphs-fygr.md` (§4 mapping, §5 décisions, §6
recommandation) · `PLAN-tech-api-insights.md` (frontière Voie B, lignes 175-179).

---

## 1. Recon de l'existant (lecture seule, vérifiée au 2026-07-17)

### 1.1 Le moteur flux / insights dérivés internes (Voie A)

- **Repository** `src/server/repositories/insights.ts` — trois fonctions livrées, même
  facture attendue pour `categorySummary` :
  - `cashflowParDevise` (`insights.ts:103`) — buckets `date_trunc` × devise ; l'unité et
    le format sont **inlinés via `sql.raw` depuis des tables figées** (`insights.ts:120-126`)
    car un paramètre lié casse l'égalité SELECT↔GROUP BY (erreur 42803, piège documenté).
    Bucket sans transaction → **ABSENT** (on ne fabrique pas de 0 ; l'UI comble l'axe,
    `insights.ts:99-101`).
  - `vendorsParConcentration` (`insights.ts:187`) — `part` par devise via window
    `over (partition by currency)` + `nullif` anti-DIV/0 (`insights.ts:236-239`).
  - `repartitionParCategorie` (`insights.ts:301`) — **le donut existe déjà** : catégorie
    × devise sur une fenêtre, fenêtre précédente en 2e requête séparée
    (`insights.ts:372-404`), collapse des sentinelles `UNCLASSIFIED`/`Uncategorized` en
    « Non catégorisé » (`insights.ts:357-370`). **Il manque uniquement la dimension MOIS.**
- **DTO internes** `src/server/insights/types.ts` — types NÔTRES, pas un miroir du schéma
  Omni-FI inconnu (`types.ts:11-14`) ; montants = chaînes décimales (`types.ts:16-19`).
- **Bornes zod** `src/lib/insights-schema.ts` — source unique des bornes à la frontière
  (`insights-schema.ts:15-24`), enums fermées, presets de période
  (`periodePresetSchema`, `insights-schema.ts:95-100`).
- **Consommateur type** `src/app/(workspace)/graphiques/actions.ts` — patron à
  reproduire : le client n'envoie qu'un **preset** ; bornes dérivées à Maurice côté
  serveur (`bornesPeriodeMaurice`, `src/lib/periode-analyse.ts:62`) ; deux surfaces
  (RSC premier paint qui laisse remonter à l'error boundary + action client à retour
  normalisé `ResultatAction`) (`actions.ts:9-14`) ; drapeau `aucuneBanque` pour l'état
  vide (`actions.ts:53-61`).
- **Rendu flux** `src/components/dashboard/flux-*` — `projeterSurGrille`
  (`flux-projection.ts:35`) comble les mois vides à 0 **côté présentation** (module
  neutre) : la grille de mois est une responsabilité du consommateur, pas du repository.
- **Barrel** : la page importe le repository **via `@/server/db`**
  (`src/server/db/index.ts:166-168`) — jamais en valeur directe depuis `src/app`
  (frontière lint P0-a).

### 1.2 Tenancy — passage obligatoire et jointures d'héritage

- `withWorkspace` vit dans **`src/server/db/tenancy.ts`** (⚠️ CLAUDE.md règle 2 cite
  encore `src/lib/tenancy.ts`, chemin périmé) : BEGIN → garde anti-owner fail-closed
  (`tenancy.ts:191-203`) → `set_config('app.current_workspace_id', …, true)`
  (`tenancy.ts:205-210`) → re-validation membership (`tenancy.ts:212-226`) → pose des
  GUC d'étage 2 `entity_scope`/`account_scope` (`tenancy.ts:228-366`) → intersection
  serveur du `view_filter` (`tenancy.ts:368-419`).
- **ENTITY-READ-JOIN1** : les policies d'étage 2 vivent sur `bank_accounts` ;
  `transactions_cache` n'en hérite QUE par `innerJoin(bankAccounts, …)`
  (`insights.ts:145-146`, doctrine `insights.ts:12-17`).
- **Extension OBLIGATOIRE pour l'option splits (D2)** : `transaction_categorizations`
  ne porte QUE `tenant_isolation` (`schema.ts:659`) — **aucune policy d'étage 2**. Toute
  lecture agrégée de cette table DOIT donc remonter la chaîne
  `transaction_categorizations → transactions_cache (FK composite, schema.ts:624-629)
  → bank_accounts` pour hériter du scope entité/compte/view_filter. Une lecture directe
  de la table de splits sans cette double jointure = fuite intra-groupe (étage 2) —
  dette d'isolation INTERDITE (règle 9).

### 1.3 Les deux sources de catégorie (fait structurant → Décision D2)

1. **`transactions_cache.primary_category`** (`schema.ts:424`) — classification AMONT
   Omni-FI (bloc Enrichment), avec trace `confidence_level`/`classification_source`/
   `rule_id_match` (`schema.ts:443-445`, TECH-API-TRACE). C'est l'axe du donut actuel.
2. **`transaction_categorizations`** (`schema.ts:597`) — ventilation TYGR : N splits par
   transaction, `amount > 0` (`schema.ts:638`), `source IN ('MANUAL','RULE')`
   (`schema.ts:639-642`), FK catégorie **composite scopée workspace**
   (`schema.ts:633-637`), alimentée par la saisie manuelle et le moteur de règles
   (`appliquerRegles`, split 100 %, MANUAL prime — PR #95). Le référentiel `categories`
   est hiérarchique **à deux niveaux** (Nature/Sous-nature via `parent_id`,
   `schema.ts:536-551`).
   - Doctrine déjà écrite : « **MANUAL prime à l'affichage/agrégation** »
     (`schema.ts:446-453`). La liste /transactions élit déjà une « catégorie dominante »
     depuis les splits + un statut `NON_CATEGORISE|PARTIEL|COMPLET`
     (`transactions.ts:261-279`).
   - La ventilation manuelle est **purement locale** : l'amont ne la connaît jamais
     (TODOS.md, DECISION-PRODUIT-OVERRIDE).

### 1.4 Ce que l'amont expose réellement (doc + runtime du jour)

- **Doc** (`docs/documentation_api.md:1171-1190`) : `CategorySummary` n'existe QUE dans
  `GET /dashboard/insights` → `[{ Category, Amount, TransactionCount, Share }]`
  (`documentation_api.md:1184`). Auth `ApiKeyAuth` + query `clientUserId`, `partyId`,
  `granularity (daily|weekly|monthly)`, `fromDate`, `toDate` (`documentation_api.md:1175-1176`).
  **Ni champ devise, ni dimension mois par élément, ni pagination documentés.**
- **Runtime rejoué le 2026-07-17** (script scratchpad, même discipline que
  `PLAN-cadrage-graphs-fygr.md` §7 — codes HTTP + forme des clés, aucune valeur) :

  | Appel | HTTP | Forme des clés |
  |---|---|---|
  | `GET /health/` (témoin) | **200** | `status` |
  | `GET /insights/cashflow` | **501** | `Error.Code`, `Error.Message` |
  | `GET /insights/vendors` | **501** | `Error.Code`, `Error.Message` |
  | `GET /insights/alerts` | **501** | `Error.Code`, `Error.Message` |
  | `GET /dashboard/insights` | **501** | `Error.Code`, `Error.Message` |
  | `GET /dashboard/insights?granularity=monthly` | **501** | `Error.Code`, `Error.Message` |

  → Le verdict des audits 2026-06-24 et 2026-07-02 **tient au 2026-07-17** : module non
  livré, aucun payload de succès observable, enveloppe d'erreur `{Error:{Code,Message}}`
  singulière (≠ OBIE plurielle).

### 1.5 Fuseau — où la conversion Maurice est DÉJÀ faite

`transactions_cache.transaction_date` **EST la date comptable Maurice**, dérivée à
l'ingestion de `BookingDateTime AT TIME ZONE 'Indian/Mauritius'`
(`deriverDateComptableMaurice`, `src/server/ingestion/conversion.ts:57` ; schéma
`schema.ts:407-412`). Conséquence non négociable pour ce plan : le bucket mensuel se
calcule par `date_trunc('month', transaction_date)` **SANS re-conversion de fuseau**
(une deuxième conversion décalerait deux fois — doctrine `insights.ts:22-23`). Le
caractère « Indian/Mauritius EXPLICITE » exigé par E20 est satisfait par la chaîne
ingestion → `transaction_date`, et les bornes `[from, to]` sont dérivées à Maurice par
`bornesPeriodeMaurice` (`periode-analyse.ts:62`) côté serveur, jamais par le client.

---

## 2. Contrat du repository (valable pour les DEUX options de la décision)

### 2.1 Signature

```ts
// src/server/repositories/insights.ts (même fichier que la famille existante)
export async function ventilationCategorieParMois(
  tx: Tx,
  params: {
    sens: SensFlux;          // "inflow" | "outflow" — PAS de "both" (cohérent donut)
    from: string;            // "YYYY-MM-DD" comptable Maurice (dérivé serveur d'un preset)
    to: string;              // idem, from ≤ to, fenêtre bornée (cf. §6)
    niveau?: NiveauCategorie; // "categorie" (défaut) | "nature" — rollup SQL, cf. §2.4
  },
): Promise<VentilationCategorieMois>
```

- Un appel = **un sens**. La matrice (Entrées + Sorties) fait **deux appels dans UNE
  transaction `withWorkspace`**, en séquence (même patron que `chargerAnalyseCategories`
  qui enchaîne déjà deux lectures, `graphiques/actions.ts:96-123` — une connexion
  transactionnelle ne pipeline pas, pas de `Promise.all`).
- Nom : cohérent avec la famille FR (`repartitionParCategorie`, `cashflowParDevise`).
  « categorySummary » reste le nom du TICKET, pas de l'export.
- Export ajouté au barrel `src/server/db/index.ts` (frontière P0-a).

### 2.2 Forme de sortie (catégorie × mois × DEVISE)

```ts
export interface CelluleMois {
  mois: string;          // "YYYY-MM" (étiquette stable, même format que FORMAT_BUCKET.mois)
  montant: string;       // sum SQL ::numeric(15,2)::text — JAMAIS un float
  nbTransactions: number; // count(distinct transaction) — un split double ne compte qu'une fois
}

export interface LigneCategorieMois {
  categorie: string;           // label affichable
  estNonCategorise: boolean;   // poste « Non catégorisé » (rendu neutre, trié en dernier)
  /** Renseignés si la ligne vient du référentiel TYGR (D2 option b/c), sinon null. */
  categorieId: string | null;
  parentId: string | null;     // Nature parente (rollup UI sans addition côté JS)
  origine: "splits" | "amont" | "aucune"; // provenance de l'axe (D2) — trace honnête
  totalFenetre: string;        // somme SQL de la ligne sur [from, to]
  part: string;                // totalFenetre / total de SA devise (0..1, chaîne, nullif)
  cellules: CelluleMois[];     // CREUX : mois sans transaction ABSENT (convention Voie A)
}

export interface VentilationDeviseMois {
  currency: string;
  totalFenetre: string;        // total devise (fenêtre) — centre de donut / pied de matrice
  totauxParMois: CelluleMois[]; // ligne « Total » de la matrice (agrégat SQL, pas une addition JS)
  lignes: LigneCategorieMois[]; // catégorisées d'abord (total desc), « Non catégorisé » en fin
}

export interface VentilationCategorieMois {
  sens: SensFlux;
  from: string;
  to: string;
  /** Grille COMPLÈTE des mois de la fenêtre ("YYYY-MM", croissant) — arithmétique
   *  calendaire pure côté serveur (aucun montant), pour que le consommateur aligne
   *  colonnes/barres sans recalculer de bornes (même rôle que grilleMois/projeterSurGrille). */
  mois: string[];
  /** Une entrée PAR devise — JAMAIS d'addition cross-devise (DASH-FX1). */
  devises: VentilationDeviseMois[];
}
```

Décisions de forme (et leurs raisons) :
- **Cellules CREUSES + grille `mois[]` fournie** : le repository ne fabrique pas de 0
  (convention `insights.ts:99-101`) ; la grille permet au consommateur de combler sans
  arithmétique de dates. En réalisé, « mois absent » = flux 0 — l'UI peut afficher
  `Rs 0,00` (vérité) ou « — » ; c'est un choix d'affichage, pas de données.
- **`totalFenetre`/`totauxParMois`/`part` calculés EN SQL** (windows
  `over (partition by …)`, comme `insights.ts:414-428`) : le donut se sert de
  `totalFenetre`+`part` sans additionner les cellules côté JS (règle 8), les barres
  mono-catégorie se servent de `cellules`, la matrice se sert de tout.
- **Multi-devise** : une section par devise, triée par code. Une matrice « total
  unique » à la FYGR est INTERDITE tant que DASH-FX1 (taux annoté) n'existe pas.
- **`origine`** : trace la provenance de l'axe par ligne — indispensable pour l'option
  hybride D2-c et pour l'UI de fiabilité (cohérent avec `ui-fiabilite-classification`).

### 2.3 Sémantique d'agrégation

- **Fenêtre** : `[from, to]` inclusives, borne haute rendue exclusive en SQL
  (`< to + 1 jour`), dates re-validées calendairement dans le repository (défense en
  profondeur, même code que `estDateCalendaireValide`, `insights.ts:84-91`).
- **Bucket mois** : `to_char(date_trunc('month', transaction_date), 'YYYY-MM')` —
  littéral inliné via `sql.raw` depuis une constante figée (piège 42803,
  `insights.ts:120-126`). PAS de re-conversion de fuseau (§1.5).
- **Sens** : filtre `credit_debit = 'Credit'|'Debit'` en littéral figé
  (`insights.ts:347-350`). Montants = magnitudes positives (le signe vit sur
  `credit_debit`).
- **Tombstones** : `is_removed = false` partout (`insights.ts:149`).
- **Non catégorisé** : même collapse des sentinelles que le donut
  (`insights.ts:357-366`) — NULL/''/`UNCLASSIFIED`/`Uncategorized` → un poste unique
  « Non catégorisé », trié en dernier.
- **`nbTransactions`** : `count(distinct (transaction_id, transaction_date))` dans les
  variantes à splits (une transaction ventilée en 2 splits d'une même catégorie compte 1).

### 2.4 Hiérarchie (Nature/Sous-nature)

`categories.parent_id` donne deux niveaux (`schema.ts:536-551`). Le rollup Nature est
une **addition de montants → il se fait en SQL**, jamais côté UI :
- `niveau: "categorie"` (défaut v1) : clé de groupe = la catégorie telle qu'assignée.
  `parentId` est retourné pour le REGROUPEMENT VISUEL (indentation, sections) sans somme.
- `niveau: "nature"` : clé de groupe = `coalesce(parent_id, id)` (une Sous-nature compte
  dans sa Nature ; une Nature racine compte pour elle-même). Même requête, autre clé.
Ce paramètre n'a de sens que si D2 retient l'axe TYGR (options b/c) ; en D2-a il est
ignoré (l'amont `primary_category` est plat).

---

## 3. Implémentation — Option A (dérivation interne `transactions_cache`)

> S'applique si Etienne confirme la recommandation de
> `DECISION-categorysummary-amont-vs-interne.md`. Esquisse structurelle, pas du code.

### 3.1 Variante D2-a — axe = `primary_category` (continuité donut)

Une seule requête, extension directe de `repartitionParCategorie` :
`GROUP BY cle_categorie, currency, date_trunc('month', transaction_date)` + windows :
- `sum(sum(amount)) over (partition by currency)` → `totalFenetre` devise ;
- `sum(sum(amount)) over (partition by currency, cle_categorie)` → `totalFenetre` ligne ;
- `part` = ligne/devise avec `nullif` ;
- `totauxParMois` : la MÊME requête via `grouping sets` OU une agrégation window
  `over (partition by currency, mois)` — au choix de l'implémentation, tant que c'est
  UNE passe SQL (pas d'addition JS).
JOIN `bank_accounts` obligatoire (ENTITY-READ-JOIN1). `origine` = `'amont'` ou
`'aucune'`.

### 3.2 Variante D2-b/c — axe = catégories TYGR (splits), repli amont en D2-c

Deux sous-ensembles agrégés puis réunis **en SQL** (`UNION ALL` dans une CTE, une seule
requête finale) :
1. **Parts ventilées** : `transaction_categorizations tc`
   JOIN `transactions_cache t` sur la **FK composite** `(transaction_id,
   transaction_date)` (`schema.ts:624-629`) JOIN `bank_accounts` (héritage étage 2,
   §1.2) JOIN `categories c` (FK composite scopée workspace, `schema.ts:633-637`,
   1:1 sûre — même argument de cardinalité que `transactions.ts:261-266`).
   Montant de la cellule = `sum(tc.amount)` ; clé = catégorie TYGR (ou sa Nature) ;
   `origine='splits'`.
2. **Reste non ventilé** (D2-c uniquement) : par transaction,
   `reste = greatest(abs(t.amount) − coalesce(sum(tc.amount), 0), 0)`. L'invariant
   « somme des splits ≤ |montant| » est garanti au niveau REPOSITORY, pas par un CHECK
   en base (`schema.ts:585-590`) : le `greatest(…, 0)` défensif borne donc le reste à
   zéro même si un futur chemin d'écriture violait l'invariant — un reste négatif ne
   doit jamais alimenter une cellule. Si `reste > 0`, il alimente la clé de repli
   `primary_category` normalisée (collapse sentinelles) sinon « Non catégorisé » ;
   `origine='amont'|'aucune'`. En D2-b, tout le reste tombe dans « Non catégorisé ».
   Le filtre de sens et `is_removed` s'appliquent sur `t` dans les deux branches.

Points durs identifiés d'avance :
- La branche 2 exige un agrégat par transaction AVANT la soustraction (table dérivée
  pré-agrégée, même parade anti-N+1 et anti-désalignement rowMode que
  `transactions.ts:249-260`).
- Les labels des deux branches vivent dans le MÊME espace de noms d'affichage : une
  collision `categories.name` = `primary_category` (ex. « Utilities ») ferait fusionner
  deux lignes de provenances différentes → la clé de groupe inclut `origine` (ou
  `categorieId` nullable), pas seulement le label.
- RLS : `categories` et `transaction_categorizations` sont tenant-only — l'étage 2
  passe par la chaîne de jointures vers `bank_accounts` (§1.2). Aucun raccourci.

### 3.3 Performance

- Filtre `transaction_date` → **partition pruning** (table partitionnée par RANGE,
  `schema.ts:382-384`) + index `transactions_cache_workspace_date_idx`
  (`schema.ts:493-496`).
- Côté splits : `txn_categorizations_workspace_txn_idx` (`schema.ts:649-653`) pour la
  jointure, `txn_categorizations_workspace_category_idx` (`schema.ts:655-658`,
  commentaire « Agrégats par catégorie (dashboards futurs) » — cet usage-ci).
- Si les volumes le justifient un jour : la dette conditionnelle INSIGHTS-MATVIEW1 (P2)
  couvre la matérialisation. Pas dans ce chantier.

---

## 4. Implémentation — Option B (consommer l'amont, si Etienne tranche contre la reco)

Le contrat §2 reste la cible : l'UI ne voit jamais la source. La voie amont suit la
frontière déjà provisionnée `mapDepuisOmniFi` + flag `INSIGHTS_SOURCE`
(`PLAN-tech-api-insights.md:175-179`, défaut `derive`, garde 501 → retombée dérivée).

Ce qu'il faudrait combler côté amont (état documenté au 2026-07-17,
`documentation_api.md:1171-1190`) :
- **Dimension mois** : `CategorySummary` est un agrégat PLAT sur la fenêtre → il
  faudrait **un appel `GET /dashboard/insights` par mois** (fenêtres `fromDate/toDate`
  successives), soit N appels réseau par rendu de matrice (12 mois = 12 appels), à
  authentifier `ApiKey` + `client_user_id` **snake_case** (le camelCase 403,
  `PLAN-cadrage-graphs-fygr.md` §1.2-3).
- **Devise** : AUCUN champ devise documenté dans `CategorySummary` → impossible de
  garantir « pas d'addition cross-devise cachée » (DASH-FX1) sans observer un payload
  réel. Bloquant tant que le schéma de succès est inconnu (501).
- **Axe catégorie** : catégories Omni-FI uniquement — les ventilations
  MANUAL/RULE TYGR (vérité locale, §1.3) sont invisibles de l'amont.
- **Étage 2** : l'amont connaît l'EndUser (= workspace), pas nos scopes
  entité/compte/view_filter → tout agrégat amont est GROUPE ENTIER. Servir cela à un
  membre scopé = fuite intra-groupe (interdit, règle 9) ; le « fix » serait de
  re-filtrer par compte côté TYGR… ce qui revient à recalculer en interne.
- **Enveloppes d'erreur** : tolérer les DEUX formes (`{Error:{…}}` singulière ET OBIE
  plurielle) + état nommé `OMNIFI_FEATURE_UNAVAILABLE` sur 501.

**Déclencheur** : passage 501 → 200 en Staging (dette INSIGHTS-AMONT1) → rejouer
l'audit, observer le schéma RÉEL, et seulement alors figer le DTO amont.

---

## 5. Invariants non négociables (appliqués, pas re-découverts)

| Invariant | Application dans ce plan |
|---|---|
| Montants jamais float (règle 8) | Agrégats SQL → `::numeric(15,2)::text` ; `part` chaîne avec `nullif` ; affichage via `format-montant.ts` ; `parseFloat` toléré UNIQUEMENT pour la géométrie (hauteur de barre/angle), jamais réinjecté dans un montant affiché (`PLAN-cadrage-graphs-fygr.md` §5.4) |
| Multi-devise (DASH-FX1) | Sortie sectionnée PAR devise (§2.2) ; aucune addition cross-devise ; matrice « total unique » interdite sans taux annoté |
| Virements internes (§5.2 cadrage) | Risque : sur-représentation Entrées ET Sorties dans la matrice/le donut (le net reste juste). Options posées à Etienne dans la note de décision (D3 : exclure / neutraliser / annoter) — le contrat §2 est neutre aux trois (une exclusion = filtre WHERE ; une neutralisation = catégorie dédiée ; une annotation = pur affichage) |
| Isolation (règle 2/9) | Tout accès DANS `withWorkspace` (`src/server/db/tenancy.ts:174`) ; JOIN `bank_accounts` systématique ; chaîne de jointure obligatoire pour les splits (§1.2) ; cross-tenant → 404 (`WorkspaceAccessDeniedError`, `tenancy.ts:68-74`) ; **aucune dénormalisation d'`entity_id` sur l'append-only** |
| Fuseau (E20) | `transaction_date` = date comptable Maurice posée à l'ingestion (`conversion.ts:57`) ; `date_trunc('month')` dessus SANS re-conversion ; bornes dérivées par `bornesPeriodeMaurice` côté serveur |
| Append-only | Lecture seule de `transactions_cache` ; la catégorisation vit dans ses tables dédiées (`schema.ts:527-531`) |

---

## 6. Validation d'entrée & erreurs nommées (règle 3)

- **Frontière zod** (`src/lib/insights-schema.ts`, source unique des bornes) :
  - réutiliser `sensFluxSchema` (`insights-schema.ts:87`) et `periodePresetSchema`
    (`insights-schema.ts:95-100`) — le client n'envoie **jamais** de dates ;
  - nouveau `niveauCategorieSchema = z.enum(["categorie", "nature"])` (défaut
    `categorie`) ;
  - nouvelle borne `VENTILATION_MOIS_MAX` (proposition : **36 mois**) — plafond dur
    anti-abus mémoire/SQL sur la largeur de fenêtre, vérifié aussi dans le repository
    (défense en profondeur, comme `VENDORS_TOP_N_MAX`).
- **Repository** : re-validation calendaire stricte (F1/F2), `from ≤ to`, fenêtre ≤
  borne → `InsightsParamsInvalidesError` (`insights.ts:58-63`, réutilisée telle quelle).
- **Server Action** : retour normalisé `ResultatAction` avec codes machine stables
  (`INVALID_PARAMS`, `SERVICE_UNAVAILABLE`, `ERREUR`) + log corrélé
  `{evt, action, workspaceId, code}` SANS PII (patron `graphiques/actions.ts:75-93`).
  Jamais de libellé bancaire brut dans un log ou message.

---

## 7. Exit-criteria & plan de tests (livrés dans le MÊME PR, sinon PR incomplet)

**Chemins heureux**
1. 2 devises × 3 catégories × 3 mois → sections par devise, cellules creuses correctes,
   `totalFenetre`/`totauxParMois`/`part` = valeurs SQL attendues (chaînes `"x.00"`).
2. `niveau: "nature"` → les Sous-natures s'additionnent dans leur Nature (en SQL).
3. Donut-compat : `totalFenetre`+`part` d'une fenêtre 1 mois = résultat
   `repartitionParCategorie` sur la même fenêtre (non-régression de sémantique).
4. Grille `mois[]` complète même quand des mois n'ont aucune transaction.

**Chemins d'échec**
5. Date invalide (`2026-02-30`), `from > to`, fenêtre > `VENTILATION_MOIS_MAX`,
   `sens`/`niveau` hors enum → `InsightsParamsInvalidesError` / rejet zod bruyant.

**Cas limites**
6. `from = to` (fenêtre d'un jour) ; fenêtre à cheval sur un 31/mois court ; transaction
   à 22h UTC le dernier jour du mois → tombe le mois SUIVANT à Maurice (E20, vérifie la
   non-re-conversion).
7. Workspace sans aucune transaction → `devises: []`, `mois[]` non vide.
8. Splits : transaction ventilée PARTIELLEMENT (60/40) → 60 sur la catégorie TYGR,
   reste sur le repli (D2-c) ; deux splits même catégorie même mois →
   `nbTransactions = 1` ; collision de label TYGR/amont → deux lignes distinctes.
9. `"0"` vs `"0.00"` : échelle figée sur agrégat vide (piège `::numeric(15,2)::text`).

**Isolation (suite bloquante CI, `tests/isolation/`)**
10. IDOR : workspace B ne voit AUCUNE ligne de A (requête sans WHERE → 0 ligne sous
    RLS) ; route/action cross-tenant → **404, jamais 403**.
11. Scope ENTITÉ : membre scopé entité E1 → les cellules n'agrègent QUE les comptes E1
    (les comptes `entity_id IS NULL` invisibles) — sur les DEUX branches (directe et
    splits, via la chaîne de jointures §1.2).
12. `view_filter` posé → cellules rétrécies au filtre (jamais élargies).
13. Tombstone `is_removed = true` exclu des agrégats.

Suite exécutée sous `tygr_app` (JAMAIS l'owner — BYPASSRLS fausserait la preuve).
PGlite suffit (lecture seule, pas de course à sérialiser).

---

## 8. États d'affichage attendus par le consommateur (convention CLAUDE.md)

Consommateurs : `/graphiques` (barres mensuelles par catégorie — FYGR `graphics_3/4`)
et le futur mode tableau du Dashboard (matrice, incrément A). Pour chacun :

- **Loading** : skeleton épousant la FORME réelle (colonnes de mois / barres),
  `tabular-nums` sur les placeholders, AUCUNE couleur sémantique.
- **Empty** : deux cas distingués par le drapeau `aucuneBanque` (patron
  `graphiques/actions.ts:53-61`) — « Connecter une banque » (CTA unique) vs « Aucune
  donnée sur la période » (proposer d'élargir la période).
- **Error** : fond `danger-bg` + icône + message + `role="alert"` + bouton réessayer
  (l'erreur n'est JAMAIS un simple rouge — réservé à `outflow`).
- **Partiel** : une devise fournie / l'autre vide → sections indépendantes ; mois sans
  données → cellule comblée depuis `mois[]` (0 réalisé véridique ou « — », choix
  UI_GUIDELINES) ; ligne « Non catégorisé » toujours rendue en NEUTRE et en dernier.
- Route de démo `src/app/demo/…` pour la capture headless des états (Gate 4), hors
  auth/DB.

---

## 9. Hors périmètre (anti-scope-creep, tracé)

- Moteur de formules FYGR et rapports nommés persistés — hors MVP graphes
  (`PLAN-cadrage-graphs-fygr.md` §5, déjà tracé).
- Conversion FX annotée (DASH-FX1) — chantier séparé ; ce repo n'additionne jamais
  cross-devise.
- Prévisionnel/scénarios (incréments C/D du plan scénario) — consommeront ce contrat
  plus tard, rien ici ne les précâble.
- Matérialisation (INSIGHTS-MATVIEW1) — conditionnelle aux volumes.
- Identification STRUCTURELLE des virements internes (appariement débit/crédit
  automatique) — si D3 retient « neutraliser », c'est un incrément dédié.

## 10. Ordre de livraison proposé (APRÈS arbitrage d'Etienne)

1. PR backend : DTO (`types.ts`) + zod (`insights-schema.ts`) + repository
   (`insights.ts`) + barrel + tests §7 (dont isolation). Zéro UI.
2. PR front « barres mensuelles par catégorie » sur `/graphiques` (réutilise le
   sélecteur sens/période existant + états §8).
3. PR front « matrice réalisé » (incrément A du plan scénario) — son propre plan de
   conception au lancement (règle 1).

Chaque PR : lint/typecheck/tests verts, Visual QA Gate 4, revue contradictoire.
