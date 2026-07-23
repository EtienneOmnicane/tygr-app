# PLAN — FEAT-8.3 « Alertes proactives » (CONCEPTION)

> **Statut : conception seule (règle 1).** Ce document est un plan écrit sur disque ;
> il ne s'accompagne d'AUCUNE ligne de code applicatif. Il fixe le modèle de données,
> les requêtes de détection, la surface UI, le canal email, les critères de sortie
> (règle 3) et les questions produit ouvertes. L'implémentation fera l'objet de lots
> dédiés (branches `feat/*`), postérieurs à la validation de ce plan.
>
> **Ticket :** `TODOS.md` — Epic 8 « Intelligence Métier », `FEAT-8.3 Alertes proactives`
> (effort M). Deux alertes : (a) **liquidités dormantes** (solde excédentaire stagnant,
> seuil + durée configurables) ; (b) **frais bancaires anormaux** (écart vs moyenne
> historique de catégorie). **Dashboard + email, JAMAIS d'action automatique.**

---

## 0. Contrainte amont structurante (à intégrer avant tout)

L'API Omni-FI expose sur le papier `Alerts` et `CategoryAnomalies`
(`docs/documentation_api.md:1185,1190,1212` — `GET /insights/alerts`), MAIS **tout le
module `/insights/*` renvoie `501 NOT_IMPLEMENTED`**, y compris sans authentification
(audit Staging 2026-06-24, dette **INSIGHTS-AMONT1** `TODOS.md`, cf.
`PLAN-tech-api-insights.md`). Un 501 ne révèle **aucun payload de succès** : coder un
client contre ce contrat fantôme figerait un parseur sur du vide (piège `/v1` /
`Enrichment` déjà payé deux fois).

**Décision d'architecture (le pushback de la règle 10, déjà tranché pour la Voie A) :
FEAT-8.3 DÉRIVE ses deux alertes EN INTERNE** depuis `transactions_cache` et
`balance_history`, **zéro dépendance amont**. On réutilise le socle **Voie A** déjà
livré (`src/server/repositories/insights.ts` + DTO `src/server/insights/types.ts` +
traduction FR en SQL `src/server/insights/categorie-fr-sql.ts`) : mêmes invariants,
même style d'agrégat SQL en chaînes décimales, mêmes gardes de tenancy.

La forme du contrat amont `CategoryAnomalies` —
`{ Category, CurrentMonth, HistoricalAverage, Delta, DeltaPercent, Direction }`
(`documentation_api.md:1185`) — est **conservée comme boussole sémantique** de l'alerte
(b) : nos DTO internes en seront un miroir de domaine, de sorte que le jour du passage
501→200 un `mapDepuisOmniFi` séparé produise les MÊMES types sans que l'UI ne voie la
bascule (provisionné, non implémenté). Idem esprit `Alerts` pour l'alerte (a).

**Ce plan N'EST PAS une dette d'isolation / append-only / montant** (règle 9) : comme
la Voie A, il respecte RLS tenant + JOIN de scope entité + agrégats SQL en chaînes
décimales. Aucun invariant financier n'est relâché.

---

## 1. Modèle de données

Deux tables neuves, deux natures distinctes qu'il ne faut pas confondre :

| Table | Nature | Éditable ? | RLS | Rôle |
|---|---|---|---|---|
| `alert_settings` | **Configuration** (seuils) | OUI (comme `categories`, `categorization_rules`) | tenant | Où vivent les seuils **configurables** |
| `alert_events` | **Journal append-only** des alertes NOTIFIÉES | NON (append-only strict) | tenant | Dédup email + traçabilité + historique |

### 1.1 Où vivent les seuils configurables → `alert_settings`

**Choix : une table dédiée, pas une colonne de `workspaces`.** Justification :

- La config est **par type d'alerte** et **multi-paramètres** (seuil + devise + durée
  pour (a) ; fenêtre + écart % + plancher pour (b)). L'entasser dans `workspaces`
  (aujourd'hui : `id, name, kind, base_currency, omnifi_client_user_id,
  omnifi_environment` — `schema.ts:48`) le dénaturerait et grossirait une table lue
  partout.
- Extensibilité : un 3ᵉ type d'alerte = une ligne, pas une migration de `workspaces`.
- **Montants (règle 8) : colonnes `numeric`, PAS de JSONB.** Un seuil stocké en JSONB
  serait une chaîne à recaster ; le garder en `numeric(15,2)` typé rend la comparaison
  SQL directe et interdit tout float. On paie ce choix par des colonnes **nullables par
  type** (les params de (b) sont NULL sur la ligne DORMANT_CASH et inversement),
  bornées par un `CHECK` de cohérence par `alert_type`.

**Esquisse de schéma** (Drizzle, à écrire au lot 1 — *illustratif, pas du code livré*) :

```
alert_settings
  workspace_id                uuid    NOT NULL  REFERENCES workspaces(id)
  alert_type                  varchar(20) NOT NULL   -- 'DORMANT_CASH' | 'ABNORMAL_FEES'
  is_enabled                  boolean NOT NULL DEFAULT true   -- pilote la carte ET le cron
  notify_email                boolean NOT NULL DEFAULT true   -- dashboard toujours ON ; email opt-in
  -- Paramètres DORMANT_CASH (NULL si ABNORMAL_FEES)
  dormant_min_days            integer                -- durée de stagnation (jours)
  dormant_threshold_amount    numeric(15,2)          -- seuil de solde « excédentaire »
  dormant_threshold_currency  char(3)                -- devise du seuil (jamais cross-devise)
  dormant_movement_floor      numeric(15,2)          -- plancher d'activité sous lequel = « dormant »
  -- Paramètres ABNORMAL_FEES (NULL si DORMANT_CASH)
  fees_lookback_months        integer                -- fenêtre de la moyenne historique (K mois)
  fees_deviation_pct          numeric(5,2)           -- écart déclencheur en % vs moyenne
  fees_min_amount             numeric(15,2)          -- plancher anti-bruit (base + montant courant)
  updated_at                  timestamptz NOT NULL DEFAULT now()
  updated_by_user_id          uuid       REFERENCES users(id)   -- traçabilité éditeur
  PRIMARY KEY (workspace_id, alert_type)
  CHECK alert_type IN ('DORMANT_CASH','ABNORMAL_FEES')
  CHECK (alert_type = 'DORMANT_CASH'
           AND dormant_min_days IS NOT NULL AND dormant_threshold_amount IS NOT NULL
           AND dormant_threshold_currency IS NOT NULL)
     OR (alert_type = 'ABNORMAL_FEES'
           AND fees_lookback_months IS NOT NULL AND fees_deviation_pct IS NOT NULL)
  pgPolicy("tenant_isolation", POLITIQUE_TENANT)   -- schema.ts:182
  .enableRLS()
```

**Gardes non négociables :**

- **RLS tenant obligatoire** (`POLITIQUE_TENANT`, `schema.ts:182`). Attention piège
  `piege-default-privileges-table-future` : une table neuve reçoit les GRANT `tygr_app`
  via `ALTER DEFAULT PRIVILEGES` — **seule la policy RLS la protège**, jamais l'absence
  de GRANT. Test d'isolation dédié (workspace B ne lit pas la config de A).
- **Table ÉDITABLE** (pas append-only) : `INSERT/UPDATE/DELETE` autorisés à `tygr_app`
  → elle **doit figurer sur la liste blanche DELETE** du provisioning
  (`scripts/migrate.mjs` + `schema.ts`), comme `categories`. Ne PAS lui poser de trigger
  `BEFORE DELETE`.
- **Initialisation** : au provisioning d'un workspace (repo `provisioning.ts`), semer
  les deux lignes avec les valeurs par défaut (cf. §7, questions ouvertes) et
  `is_enabled = false` **ou** `true` selon la décision produit. Un workspace sans ligne
  de config = alerte inactive (fail-safe : pas de bruit par défaut si on choisit `false`).

### 1.2 Journal des alertes notifiées → `alert_events` (append-only)

Le **dashboard calcule les alertes EN DIRECT** (à la lecture, comme la Voie A —
décision KISS `INSIGHTS-MATVIEW1` : pas de table spéculative tant qu'aucun cap de perf
n'est *démontré*). `alert_events` **n'est donc PAS la source de la carte** : c'est le
**registre de ce qui a été NOTIFIÉ** (email), qui sert trois usages :

1. **Dédup email** : ne pas ré-emailer la même condition persistante à chaque run du
   cron. Clé d'unicité `(workspace_id, alert_type, subject_key, period_bucket)` →
   `INSERT … ON CONFLICT DO NOTHING` : l'email n'est envoyé **que** si l'INSERT crée
   réellement la ligne (nouvelle occurrence).
2. **Historique / audit** : « quelles alertes ont été levées, quand, pour quel sujet ».
3. **Cohérence** : lien optionnel depuis la carte vers « alerte déjà notifiée ».

**Append-only strict** (doctrine `append-only-strict-snapshot-autosuffisance`,
`CLAUDE.md` : toute nouvelle table financière append-only pose son trigger
`BEFORE DELETE` + reste hors liste blanche). Une alerte porte des **montants** (solde
observé, montant de frais) → traitée comme `audit_events` :

```
alert_events
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid()
  workspace_id   uuid NOT NULL REFERENCES workspaces(id)   -- workspaces jamais supprimé
  alert_type     varchar(20) NOT NULL
  subject_key    text        NOT NULL   -- clé de dédup (voir ci-dessous)
  period_bucket  text        NOT NULL   -- fenêtre logique dédupliquée (voir ci-dessous)
  currency       char(3)     NOT NULL   -- une occurrence PAR devise (jamais cross-devise)
  -- SNAPSHOT auto-suffisant (jamais de FK vers une table ÉDITABLE) :
  observed_amount   numeric(15,2) NOT NULL   -- solde dormant OU frais du mois courant
  reference_amount  numeric(15,2)            -- seuil (a) OU moyenne historique (b)
  detail            jsonb                    -- deltas/nb jours/nb mois, sans PII bancaire
  bank_account_ref  uuid                     -- (a) : uuid OPAQUE, SANS FK (append-only)
  detected_at    timestamptz NOT NULL DEFAULT now()
  notified_email_at timestamptz             -- NULL si dashboard-only / email désactivé
  UNIQUE (workspace_id, alert_type, subject_key, period_bucket)
  pgPolicy("tenant_isolation", POLITIQUE_TENANT) + .enableRLS()
  -- + trigger BEFORE DELETE append-only, HORS liste blanche DELETE
  -- + héritage partitions/trigger vérifié si un jour partitionnée (spike-truncate-partitions)
```

- **`subject_key` / `period_bucket`** (granularité de dédup) :
  - (a) dormant : `subject_key = bank_account_ref::text` (ou `"cur:"+currency` si on
    dédup à la devise, cf. §7), `period_bucket` = date de première détection de
    l'épisode courant **ou** une fenêtre glissante (décision de re-notification §7).
  - (b) frais : `subject_key = "FEES:"+currency`, `period_bucket = "YYYY-MM"` du mois
    analysé → **une seule alerte de frais par mois et par devise**.
- **Aucune FK vers `bank_accounts`** (table éditable) : on stocke `bank_account_ref`
  comme `uuid` **opaque** + snapshot des montants. La carte/email n'affichent jamais le
  libellé brut du compte (règle 8, cf. §4/§5) ; si un identifiant d'affichage est requis,
  il est re-résolu **à la lecture sous RLS** (le compte existe encore), jamais figé en PII.

---

## 2. Requêtes de détection

**Deux appelants, mêmes fonctions pures.** À l'image de `insights.ts`, chaque détecteur
est une fonction `(tx: WorkspaceTx, params) => Promise<…>` qui ne connaît pas *qui* a
ouvert la transaction :

- **Carte dashboard** → appelée dans le `withWorkspace(session, …)` du RSC
  (`src/app/(workspace)/(dashboard)/page.tsx:173`), comme les autres lectures d'insights.
- **Cron email** → appelée dans `executerPourWorkspaceSysteme(workspaceId)`
  (`src/server/db/systeme.ts`), sans session (cf. §5).

Emplacement proposé : étendre `src/server/repositories/insights.ts` (ou un nouveau
`src/server/repositories/alertes.ts` frère, exporté par le barrel `@/server/db`) avec
`detecterLiquiditesDormantes(tx, cfg)` et `detecterFraisAnormaux(tx, cfg)`. DTO dans
`src/server/insights/types.ts` (miroir sémantique `Alerts` / `CategoryAnomalies`).

### Invariants communs (copiés de la Voie A, `insights.ts:1-40`)

- **Tenant (règle 2)** : tout s'exécute DANS la transaction porteuse de
  `app.current_workspace_id` → chaque `SELECT` filtré par `tenant_isolation`. Aucune
  fonction ne prend `workspace_id` en paramètre.
- **Scope ENTITÉ (`ENTITY-READ-JOIN1`)** : la policy RESTRICTIVE `entity_scope` vit sur
  `bank_accounts`. `transactions_cache` **et `balance_history`** n'en héritent QUE par
  **jointure sur `bank_accounts`** (les deux ont `bank_account_id` NOT NULL). **Ne
  JAMAIS lire ces tables filles sans cette jointure** (sinon fuite intra-groupe). En
  Vision Globale (GUC vide) la RESTRICTIVE laisse tout passer ; en Vision Entité, les
  comptes hors périmètre sont masqués → l'alerte ne les voit pas.
- **Montants (règle 8)** : agrégats **EN SQL** (`numeric`), sortie en **chaînes
  décimales**. Aucune addition de floats côté JS. Ratios calculés en SQL avec `nullif`.
- **Multi-devises** : `GROUP BY currency`, une occurrence **par devise**, **JAMAIS
  d'addition cross-devise**, aucune conversion FX (`DASH-FX1`). Tombstones
  (`is_removed`) exclus.
- **Fuseau Indian/Mauritius (E20)** : les bornes de fenêtre s'appuient sur
  `transaction_date` / `balance_date`, **déjà** dates comptables Maurice à l'ingestion
  — **pas de re-conversion**. Le « maintenant » du cron est ramené à la date locale
  via `(now() AT TIME ZONE 'Indian/Mauritius')::date` (identifiant IANA correct,
  `TZ-DOC1` : jamais `Asia/Port_Louis`).
- **Anti-injection** : granularités/unités mappées vers des **constantes SQL figées**
  (jamais la valeur d'entrée interpolée) ; dates et seuils en **paramètres liés** ;
  re-validation défensive des params (défense en profondeur, comme
  `InsightsParamsInvalidesError`).

### 2.a Liquidités dormantes

**Définition retenue** : un compte détient un solde **≥ seuil** (dans SA devise), **sans
descendre** sous ce seuil, **et sans activité significative**, pendant **≥ N jours**
consécutifs (N, seuil, devise, plancher d'activité = `alert_settings`).

Deux volets combinés, par compte (chaque compte a **une** devise → pas de mélange) :

1. **Volet solde** (`balance_history`, EOD par compte/jour) : sur la fenêtre
   `[today − N + 1 ; today]` (Maurice), `min(balance) ≥ dormant_threshold_amount` ET
   la fenêtre est **couverte** (au moins un point par jour attendu, ou une couverture
   minimale — sinon un compte muet paraîtrait « dormant » à tort). Le solde reste donc
   *continûment* excédentaire.
2. **Volet activité** (`transactions_cache`) : sur la même fenêtre,
   `coalesce(sum(amount) filter (where credit_debit='Debit'), 0) < dormant_movement_floor`
   → argent **immobile**, pas seulement abondant. (Un gros solde très actif n'est pas
   « dormant ».)

**Filtre devise** : ne comparer un compte au seuil que si
`bank_accounts.currency = dormant_threshold_currency` (cf. question ouverte §7 sur le
multi-devise du seuil). Jamais de comparaison d'un solde EUR à un seuil MUR.

Esquisse SQL (illustrative) :

```sql
-- fenêtre = [borneBasse, today] en dates Maurice ; N = dormant_min_days
WITH soldes AS (
  SELECT bh.bank_account_id,
         min(bh.balance)                          AS solde_min,
         count(*)                                 AS jours_couverts
  FROM balance_history bh
  JOIN bank_accounts ba ON ba.id = bh.bank_account_id      -- ENTITY-READ-JOIN1
  WHERE bh.balance_date >= :borneBasse
    AND ba.currency = :devise
  GROUP BY bh.bank_account_id
),
activite AS (
  SELECT tc.bank_account_id,
         coalesce(sum(tc.amount) FILTER (WHERE tc.credit_debit='Debit'), 0) AS sorties
  FROM transactions_cache tc
  JOIN bank_accounts ba ON ba.id = tc.bank_account_id       -- ENTITY-READ-JOIN1
  WHERE tc.is_removed = false
    AND tc.transaction_date >= :borneBasse
    AND ba.currency = :devise
  GROUP BY tc.bank_account_id
)
SELECT s.bank_account_id,
       (s.solde_min)::numeric(15,2)::text        AS solde_dormant,
       (:seuil)::numeric(15,2)::text             AS seuil
FROM soldes s
LEFT JOIN activite a ON a.bank_account_id = s.bank_account_id
WHERE s.solde_min >= :seuil
  AND s.jours_couverts >= :couvertureMin
  AND coalesce(a.sorties, 0) < :plancherActivite;
```

DTO de sortie (chaînes décimales, une entrée par compte, groupable par devise) : miroir
`Alerts`. `AlerteDormante { bankAccountRef, currency, soldeDormant, seuil, joursObserves, … }`.

### 2.b Frais bancaires anormaux

**Définition** (miroir `CategoryAnomalies`) : sur la catégorie **« Frais bancaires »**,
comparer les **frais du mois courant** à la **moyenne des K mois précédents**, **par
devise** ; lever si l'écart **≥ `fees_deviation_pct`** ET le montant courant **≥
`fees_min_amount`**.

- **Catégorie** = libellé FR **« Frais bancaires »**, obtenu **en SQL** via
  `caseCategorieFr(transactions_cache.primary_category)` (`categorie-fr-sql.ts`) : la
  correspondance `CORRESPONDANCE_FR` est MANY-TO-ONE (`banking & finance` **et**
  `bank charges` → « Frais bancaires », `categories-fr.ts:73-74`) — grouper sur le
  libellé FR fusionne les deux clés OBIE **dans le `sum()`**, jamais côté JS. Prédicat
  d'appartenance : `caseCategorieFr(primary_category) = 'Frais bancaires'`.
  *(Choix source = `primary_category` bancaire, cf. question ouverte §7 : catégorie
  bancaire vs catégorie effective.)*
- **Sens** : frais = `credit_debit = 'Debit'` (sorties). Somme des magnitudes positives.
- **Mois Maurice** : `date_trunc('month', transaction_date)` — `transaction_date` est
  déjà la date comptable Maurice (pas de re-tz). Mois courant =
  `date_trunc('month', (now() AT TIME ZONE 'Indian/Mauritius')::date)`.
- **Moyenne historique** : moyenne des sommes mensuelles sur les K mois **précédant** le
  mois courant (fenêtre `fees_lookback_months`). Calculée EN SQL (`avg` sur les totaux
  mensuels, `numeric`).
- **Garde de division (piège `piege-garde-division-zero-pas-magnitude`)** : le
  `DeltaPercent = (courant − moyenne) / moyenne` **explose** si la moyenne est
  minuscule. **Bornes obligatoires** : (1) `nullif(moyenne, 0)` anti-DIV/0 ; (2) exiger
  `moyenne ≥ fees_min_amount` (une **magnitude**, pas seulement `> 0`) avant de juger le
  ratio ; (3) exiger `courant ≥ fees_min_amount`. Sans base significative, **pas
  d'alerte** (on ne crie pas sur +900 % de « 2 Rs → 20 Rs »).

Esquisse SQL (illustrative) :

```sql
WITH mensuel AS (
  SELECT tc.currency,
         to_char(date_trunc('month', tc.transaction_date), 'YYYY-MM')      AS mois,
         sum(tc.amount)                                                     AS total_frais
  FROM transactions_cache tc
  JOIN bank_accounts ba ON ba.id = tc.bank_account_id            -- ENTITY-READ-JOIN1
  WHERE tc.is_removed = false
    AND tc.credit_debit = 'Debit'
    AND (/* caseCategorieFr(tc.primary_category) */) = 'Frais bancaires'
    AND tc.transaction_date >= :borneBasseKmois     -- 1er jour du mois (courant − K)
  GROUP BY tc.currency, date_trunc('month', tc.transaction_date)
),
agg AS (
  SELECT currency,
         sum(total_frais) FILTER (WHERE mois =  :moisCourant)               AS courant,
         avg(total_frais) FILTER (WHERE mois <> :moisCourant)               AS moyenne
  FROM mensuel GROUP BY currency
)
SELECT currency,
       coalesce(courant,0)::numeric(15,2)::text                            AS frais_courant,
       coalesce(moyenne,0)::numeric(15,2)::text                            AS moyenne_hist,
       ((coalesce(courant,0) - coalesce(moyenne,0))
          / nullif(moyenne,0))::numeric(6,4)::text                         AS delta_pct
FROM agg
WHERE courant >= :plancher
  AND moyenne >= :plancher                        -- garde de MAGNITUDE, pas juste > 0
  AND (courant - moyenne) / nullif(moyenne,0) >= :seuilPct;
```

DTO (miroir `CategoryAnomalies`) :
`AlerteFraisAnormaux { currency, fraisCourant, moyenneHist, deltaPct, moisAnalyse, … }`
— tous montants en chaînes décimales, une entrée par devise.

---

## 3. Surface UI — carte « Alertes » du dashboard

**Fil identique à la carte modèle « Top contreparties »** (`top-vendors-card.tsx` ←
`vendorsParConcentration`), qui sert de patron.

### 3.1 Câblage serveur → présentation

1. **RSC** `src/app/(workspace)/(dashboard)/page.tsx` : ajouter les deux détecteurs à
   la grappe `Promise.all` du `withWorkspace` unique (`page.tsx:184-232`), avec la config
   lue depuis `alert_settings`. Le RSC ne recalcule aucun montant.
2. **Passage des données** : étendre l'interface `DonneesDashboard`
   (`dashboard-content.tsx:69-116`) d'un champ `alertes: AlertesDashboard`.
3. **Assemblage** : insérer `<AlertesCard … />` comme enfant du `flex flex-col gap-6`
   de `dashboard-content.tsx:244`. **Placement recommandé : haut de la colonne**
   (au-dessus de `SoldesDevisesRow` ou juste sous les nudges de synchro) — une alerte
   proactive doit être vue en premier. À arbitrer au Visual QA.
4. **Composant présentationnel PUR** `src/components/dashboard/alertes-card.tsx` :
   `AlertesCard({ alertes })`, zéro fetch, zéro état interne ; formate via
   `formatMontant` (`src/lib/format-montant.ts:64`, chaîne décimale → affichage, jamais
   de `number`). Une ligne **par alerte et par devise** (jamais de total cross-devise).

### 3.2 Habillage (tokens sémantiques, `globals.css` `@theme`)

- Conteneur : **`StateCard`** (`src/components/ui/states/primitives.tsx:52`) —
  `rounded-card bg-surface-card p-6 shadow-card`. En-tête maison
  `flex items-start justify-between` + `<h2 class="text-base font-semibold text-text">
  Alertes</h2>` + sous-titre `text-xs text-text-muted` (pattern `top-vendors-card.tsx:78-84`).
- **Chaque alerte = un `Callout`** (`src/components/ui/states/callout.tsx:90`) de
  sévérité **`warning`** (fond `bg-warning-bg` `#f7e8c3`, icône `text-warning` `#8a6108`)
  — niveau « attention », `role="status"`. Réserver **`danger`** (`bg-danger-bg` +
  `text-danger`, `role="alert"`) à une future criticité forte. **Le corps du message
  reste en `text-text`** (contraste AA : `text-warning`/`text-danger` sur leur fond
  échouent l'AA en corps de texte — cf. docstrings `callout.tsx`). `onFermer`
  **interdit** ici (la condition tient encore ; le « × » est réservé à l'éphémère).
- **Interdit sémantique (§3.4 UI_GUIDELINES)** : ne JAMAIS employer `inflow`/`outflow`
  (vert/rouge de **donnée** financière) pour l'état système d'une alerte. Une alerte =
  fond teinté + icône + message.
- Badge de type éventuel : réutiliser le patron `EcheanceBadge`
  (`src/components/echeances/echeance-badge.tsx:32`, pastille `rounded-full px-2 py-0.5
  text-xs` en teinte pastel `bg-*-bg text-*`).

### 3.3 Les 4 états (convention `CLAUDE.md` §« États d'affichage » + UI_GUIDELINES §6.5)

- **Loading** : géré par le `loading.tsx` natif du segment (Suspense RSC) via
  `DashboardLoadingState` — le skeleton épouse la forme, **neutre** (aucune couleur
  sémantique), montants placeholders `tabular-nums` (`dashboard-loading-state.tsx`).
  Pas de skeleton propre à la carte si elle est incluse dans le fetch groupé.
- **Vide** : « **Aucune alerte — tout est sous contrôle.** » via `EmptyState`
  (`empty-state.tsx:54`) `illustration="empty"`, message `text-text-muted`, **un seul**
  CTA optionnel « Configurer les alertes » (lien vers l'écran de réglages, cf. §6). Un
  vide **positif**, jamais un « No data » sec (§4.4).
- **Erreur** : `DashboardErrorState` / `AppErrorState` (`app-error-state.tsx:18`) — fond
  `bg-danger-bg` + `StateIllustration variant="error"` + `role="alert"`, `onRetry`
  optionnel, **jamais** de message d'erreur brut (PII/§3.4). Au niveau page, `error.tsx`
  couvre déjà l'échec du fetch groupé ; une erreur **partielle** propre aux alertes
  (le reste du dashboard OK) se rend en carte d'erreur locale.
- **Partiel** : si une devise/compte manque de données (fenêtre incomplète), l'afficher
  sans fabriquer de 0 (comme la Voie A « bucket sans transaction → absent »).

### 3.4 Visual QA (Gate 4)

Route de démo hors auth/DB pour capture headless :
`src/app/demo/alertes-states/` (convention `src/app/demo/<domaine>-states/`), exposant
les 4 états + une carte peuplée (1 alerte dormante MUR + 1 alerte frais EUR pour prouver
le rendu **multi-devise sans addition**). Mesurer sur `(workspace)` réel ≥ 1024 px, pas
sur `/demo` (piège `piege-mesure-qa-sur-route-demo` : la sidebar 232 px change la
largeur). Vérifier le contraste du message (`text-text`), l'icône sur fond réel
(`contraste-icone-sur-fond-teinte`).

---

## 4. Écran de configuration des seuils (surface d'édition)

Les seuils étant **configurables**, il faut une surface d'écriture. **MVP minimal** :
un écran de réglages workspace (ADMIN/MANAGER) — p.ex. `/(workspace)/parametres/alertes`
— avec un `<form action>` Server Action :

- `"use server"` + `exigerSessionWorkspace()` + contrôle de rôle
  (ADMIN/MANAGER — cf. question ouverte §7) + `withWorkspace` + **validation Zod** des
  bornes (seuils ≥ 0, jours ≥ 1, % ≥ 0), retour `ResultatAction<T>`
  (`actions.ts:53`). Écriture `UPDATE alert_settings`.
- Combobox devise = **input caché frère** (`select-maison-form-action-hidden` : un
  combobox maison ne poste rien seul).
- Montants saisis : garder en **chaîne**, valider le format décimal, ne jamais
  `parseFloat` (règle 8).

*Alternative si l'on veut réduire le périmètre du MVP* : seeds par défaut au provisioning
+ édition différée (l'écran arrive en lot 2). À trancher (§7) ; la **détection et
l'affichage** ne dépendent pas de l'écran d'édition (ils lisent `alert_settings`,
peuplée par le seed).

---

## 5. Canal email

**Constat : aucune infrastructure email n'existe** (grep : ni `resend`, ni `nodemailer`,
ni `sendgrid`/`smtp` dans `src/` ou `package.json`). FEAT-8.3 **introduit** ce canal —
c'est un sous-chantier à part entière.

### 5.1 Déclenchement — fonction Inngest planifiée (cron)

Le socle **Inngest v4** est en place (`src/server/inngest/*`, route
`src/app/api/inngest/route.ts`). Le cron d'ingestion (W2) est « à venir » ; **la même
mécanique** sert ici. Nouvelle fonction durable
`src/server/inngest/fonctions/alertes-evaluer.ts` :

```
inngest.createFunction(
  { id: "tygr-alertes-evaluer", retries: 2,
    triggers: [{ cron: "TZ=Indian/Mauritius <horaire>" }] },   // ex. quotidien matin Maurice
  async ({ step }) => { … }
)
```

- **Énumération des workspaces** : `workspaces` **n'a AUCUNE RLS** (confirmé, cf.
  mémoire `piege-default-privileges-table-future`) → un `SELECT id FROM workspaces`
  (éventuellement filtré `omnifi_environment`, actifs) sous `tygr_app` liste les
  tenants. **Cette énumération vit UNIQUEMENT sous `src/server/inngest/**`** (frontière
  ESLint `FRONTIERE_SYSTEME`, `systeme.ts` : `executerPourWorkspaceSysteme` n'est
  importable que là).
- **Fan-out par workspace** : pour chaque `workspaceId`, un `step.run` qui appelle
  `executerPourWorkspaceSysteme(workspaceId)` (`systeme.ts`) → la RLS tenant borne
  **tout** à ce workspace. On y : (1) lit `alert_settings` (`is_enabled`,
  `notify_email`) ; (2) exécute les **mêmes** détecteurs qu'au §2 ; (3) `INSERT …
  ON CONFLICT DO NOTHING` dans `alert_events` (dédup) ; (4) pour chaque ligne
  **réellement insérée** avec `notify_email`, envoie l'email et pose `notified_email_at`.
- **Idempotence** : la clé d'unicité `alert_events` rend « rejeu → 1 seul email »
  structurel ; en complément, `idempotency`/clé de run Inngest par
  `(workspaceId, date-run)` (patron `cron:${…}:${dateDuRun}` de `client.ts:71`). Pas de
  `Date.now()` fantaisiste — la date de run vient du contexte Inngest.
- **Fail-soft SÉLECTIF** (leçon `sync-fail-soft-observabilite` / PR #123) : un échec
  d'envoi email ou de détection d'**un** workspace est isolé (log structuré JSON, zéro
  PII) et **n'affame pas** les autres. Mais **jamais** de catch sur une erreur de
  tenancy (`UnsafeDatabaseRoleError`…) : elle fait échouer le run, visible au dashboard
  Inngest.

### 5.2 Port d'envoi — `src/server/notifications/`

Introduire une frontière fine, **fournisseur derrière un port** (règle 9 : dépendance
Layer 1 éprouvée, pin exact) :

- `EmailSender` (interface) + un adaptateur (choix fournisseur = **question ouverte
  §7** : Resend vs SMTP/nodemailer). Config **par env vars** (clé API, `FROM`), **jamais
  en dur ni en fixture** (règle 8). Absence de clé en dev → **fail-soft** (comme les
  émetteurs Inngest : l'email échoue proprement, ne casse rien).
- Enregistrer la nouvelle fonction dans `serve({ functions: [...] })`
  (`src/app/api/inngest/route.ts`).

### 5.3 Destinataires & contenu — **sans PII bancaire** (règle 8)

- **Destinataires** = emails des membres du workspace au rôle habilité (ADMIN/MANAGER ?
  opt-in ? — question ouverte §7). L'email d'un **utilisateur TYGR** est **sa** PII, pas
  de la **PII bancaire** — acceptable en destinataire.
- **Corps — interdits absolus** : aucun identifiant de compte, **aucun `bank_label_raw`**,
  aucun IBAN/numéro, aucun libellé bancaire brut, aucune donnée nominative amont
  (règle 8 ; même discipline que `resumeCauseSure` / `messageErreurWidget` : on ne
  logge/affiche jamais la PII amont).
- **Corps — recommandé** : type d'alerte + libellé du workspace + **deep link** vers le
  dashboard (le détail chiffré vit **derrière l'auth**, dans la carte). Le niveau de
  détail chiffré admis dans l'email (montant agrégé ? « un compte en MUR » sans le
  nommer ?) est une **question ouverte §7** — par défaut on **minimise** : type + lien.
- Email **transactionnel**, pas marketing ; en-têtes anti-thread, `List-Unsubscribe`
  si opt-out par utilisateur retenu.

---

## 6. Critères de sortie (règle 3) — mesurables

Aucune PR n'est mergée sans que **tous** les points ci-dessous soient **prouvés** :

**Isolation & invariants (gates que la CI vérifie, + preuves de mutation) :**
- [ ] **RLS tenant** sur `alert_settings` ET `alert_events` : test « workspace B ne lit
      ni la config ni les events de A » (sous `tygr_app`, jamais owner —
      `db-migrate3-0014`). Prouver par **mutation** (retirer la policy → le test
      échoue) : `mutation-check-protocole-pieges`.
- [ ] **Scope entité** : un compte hors périmètre (Vision Entité) est **exclu** des deux
      détections (test avec un compte non assigné → alerte absente). La jointure
      `bank_accounts` est présente sur **chaque** requête (aucune lecture de table fille
      sans elle).
- [ ] **Append-only `alert_events`** : trigger `BEFORE DELETE` présent, table **hors**
      liste blanche DELETE, aucune FK vers table éditable ; test « DELETE refusé »
      (+ `CASCADE`/partitions si applicable, `spike-truncate-partitions`).
- [ ] **`alert_settings` éditable** : présente sur la liste blanche DELETE ; UPDATE/DELETE
      OK sous `tygr_app`.
- [ ] **Montants (règle 8)** : zéro `parseFloat` dans le chemin ; tous les montants
      transitent en chaînes ; agrégats et ratios **en SQL** ; échelle figée `::numeric(15,2)::text`.

**Détection (tests unitaires/intégration sur fixtures) :**
- [ ] (a) **fire** : compte à solde ≥ seuil, sans mouvement, sur N jours → alerte.
- [ ] (a) **no-fire** : gros débit en milieu de fenêtre (activité) → pas d'alerte ;
      solde qui descend un jour sous le seuil → pas d'alerte ; couverture insuffisante
      (compte muet) → pas d'alerte ; compte dans une devise **sans** seuil configuré →
      non évalué.
- [ ] (b) **fire** : frais du mois +60 % vs moyenne 6 mois, base ≥ plancher, seuil 50 %
      → alerte.
- [ ] (b) **no-fire** : +40 % → pas d'alerte ; **moyenne minuscule** (≈ 0) → **garde de
      magnitude** tient, pas d'explosion du ratio (`piege-garde-division-zero-pas-magnitude`) ;
      montant courant sous le plancher → pas d'alerte.
- [ ] **Multi-devise** : jeu à 2 devises → **deux occurrences distinctes**, **jamais**
      une ligne additionnée (fixture qui échouerait si un `sum` cross-devise existait —
      `dashboard-synthese-multidevise`).
- [ ] **Fuseau** : une opération à cheval sur minuit Maurice tombe dans le bon jour/mois
      (bornes sur date comptable Maurice, pas UTC).

**Email & dédup :**
- [ ] **Dédup** : deux runs consécutifs sur la même condition persistante → **un seul**
      email (2ᵉ INSERT `ON CONFLICT DO NOTHING`, pas de `notified_email_at` réécrit).
      Une **nouvelle** occurrence (nouveau mois / nouvel épisode) → nouvel email.
- [ ] **Pas de PII bancaire** : test qui **asserte** l'absence de `bank_label_raw` /
      identifiants de compte dans le corps rendu.
- [ ] **Fail-soft** : fournisseur email indisponible → le run n'échoue pas globalement,
      les autres workspaces sont traités, log structuré sans PII ; une erreur de tenancy
      **n'est pas** avalée (re-throw).

**UI (Gate 4 — Visual QA humain, règle 3) :**
- [ ] Les **4 états** rendus (loading neutre, vide positif à 1 CTA, erreur `danger-bg` +
      `role="alert"`, partiel) sur `src/app/demo/alertes-states/`.
- [ ] Sévérité = fond teinté + icône (`Callout warning`), message en `text-text`
      (contraste AA), **jamais** `inflow`/`outflow`.
- [ ] Montants via `formatMontant`, `tabular-nums`, une ligne par devise.

**Gates CI (déjà en place) :** `lint` (dont frontières ESLint), `tsc`, `build`, suite
`vitest` (dont tests d'isolation). Exécuter la **vraie** suite dans le worktree
(`sandbox-vitest-build-marchent`), attention au piège `cwd-session-vs-worktree-npm`
(un `npm run` vert lancé dans le mauvais cwd ne prouve rien).

---

## 7. Questions produit ouvertes (à trancher AVANT l'implémentation — non inventées ici)

Ces valeurs et arbitrages ne relèvent pas de l'ingénierie ; je ne fixe pas de défaut à
la place du produit.

1. **Seuils par défaut — liquidités dormantes** : quel montant « excédentaire » (et dans
   quelle(s) devise(s)) ? Quelle durée de stagnation (N jours) ? Quel plancher
   d'activité sous lequel un compte est « dormant » ?
2. **Seuil dormant & multi-devise** : le seuil est-il défini **par devise** (une carte
   MUR + EUR + …) ou **un seul** montant en devise de base, n'évaluant que les comptes
   dans cette devise ? (Recommandation technique : **par devise**, MVP = devise de base
   seule ; les comptes d'autres devises ne sont pas évalués tant qu'aucun seuil n'est
   posé pour la leur.)
3. **Seuils par défaut — frais anormaux** : écart déclencheur (ex. +50 %) ? Fenêtre de
   moyenne (K mois, ex. 6) ? Plancher anti-bruit `fees_min_amount` ?
4. **Catégorie « frais »** : détecter sur la catégorie **bancaire** (`primary_category`
   → « Frais bancaires », robuste car les frais sont fiablement tagués par la banque) ou
   sur la catégorie **effective** (splits utilisateur `transaction_categorizations`
   prioritaires) ? (Recommandation : **bancaire** au MVP.)
5. **Destinataires email** : quels rôles (ADMIN seul ? ADMIN + MANAGER ?) ? Opt-in
   **par utilisateur** ou réglage **par workspace** (`notify_email`) ? Un utilisateur
   peut-il se désabonner (`List-Unsubscribe`) ?
6. **Niveau de détail de l'email** : minimal (type + deep link, **recommandé** pour
   minimiser l'exposition) ou avec chiffres agrégés (montant, devise, sans nommer le
   compte) ?
7. **Cadence & horaire du cron** : quotidien ? hebdomadaire ? À quelle heure locale
   Maurice ?
8. **Cycle de vie d'une alerte** : ré-émet-on l'email si la condition **persiste** (et
   à quelle cadence : jamais, chaque semaine, chaque mois) ? Notifie-t-on la
   **résolution** (« le solde a bougé », « les frais sont rentrés dans la moyenne ») ?
   → détermine `period_bucket` / la fenêtre de dédup de `alert_events`.
9. **Fournisseur email** : Resend (simple, transactionnel) vs SMTP/nodemailer (générique,
   dépend d'un relais) — impacte l'adaptateur `EmailSender` et les env vars du runbook
   de déploiement (secret distinct sandbox/prod, comme le webhook).
10. **Provisioning** : à la création d'un workspace, les alertes démarrent-elles
    **activées** (avec défauts) ou **désactivées** (opt-in explicite) ?

---

## 8. Découpage d'implémentation suggéré (post-validation, pour mémoire)

1. **Lot 1 — Données** : migrations `alert_settings` (éditable, RLS, liste blanche) +
   `alert_events` (append-only, RLS, trigger BEFORE DELETE) ; seeds provisioning ;
   tests isolation + append-only. *Surface sensible (append-only + RLS) → cross-review.*
2. **Lot 2 — Détection** : `detecterLiquiditesDormantes` / `detecterFraisAnormaux` dans
   `repositories/` + DTO `insights/types.ts` ; tests fixtures (fire/no-fire, multi-devise,
   tz, garde de magnitude).
3. **Lot 3 — Carte dashboard** : `AlertesCard` + branchement RSC + 4 états + route démo +
   Visual QA.
4. **Lot 4 — Config UI** : écran réglages + Server Action + Zod.
5. **Lot 5 — Email** : port `notifications/` + adaptateur + fonction Inngest cron +
   dédup + fail-soft + tests « pas de PII / dédup / fail-soft ». *Surface sensible
   (frontière système, cron cross-workspace) → cross-review.*

Chaque lot : branche `feat/*`, commit par unité logique, **STOP à la PR** (l'humain
ouvre la PR — règles 1 & 2). Isolation prouvée sous `tygr_app`, jamais owner.
