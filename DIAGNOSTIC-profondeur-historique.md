# Diagnostic — absence de données de flux avant 2026 sur le dashboard

**Date** : 2026-07-20 · **Mode** : investigation lecture seule (aucun fichier applicatif modifié, aucune écriture en base, aucun `POST` amont) · **Méthode** : trace de bout en bout déclenchement → pagination → conversion → upsert → requête dashboard, puis confrontation base ↔ API réelle.

---

## Verdict

> **Profondeur limitée côté Omni-FI. Notre code importe tout ce qui est servi.**
> **Confiance : 10/10.**

L'affirmation « Omni-FI ne sert qu'une fenêtre courte d'historique » est **exacte** pour les 3 connexions en place. Aucune troncature côté TYGR n'a été trouvée sur le chemin réellement emprunté.

Mais elle est **incomplète sur un point qui compte** : la fenêtre courte n'est pas une limite d'Omni-FI en général — c'est la fenêtre par défaut de l'**extracteur de la variante bancaire utilisée** (`inst_mcb_pro`). Le backend expose une capacité d'historique profond (18 mois) que TYGR n'appelle jamais… et que **cet extracteur précis ignore de toute façon**. Détail en §6, car il change l'action à mener.

---

## 1. Bornes envoyées à l'API à l'ingestion — TYGR ne plafonne rien

`listerTransactionsPage` n'envoie **aucune borne de date** : `src/server/omnifi/client.ts:340-349` ne pose que `client_user_id`, `page`, `pageSize`. On demande donc tout ce que l'amont détient.

- Les `fromDate`/`toDate` de `client.ts:358` appartiennent à `resumeTransactions` (endpoint *summary*) — **code mort**, aucun appelant.
- `fenetreSoldes` (`src/server/ingestion/index.ts:79`) concerne les soldes EOD et **n'est jamais renseigné** par aucun appelant (`orchestration.ts:1326`, `:1658`, `sync-ingest.ts:407` l'omettent tous).
- `declencherSync` (`client.ts:386-395`) ne transmet que `client_user_id` — la signature n'accepte structurellement aucune profondeur.

**Aucun plafonnement de fenêtre côté TYGR. Confiance 10/10.**

## 2. Boucle de pagination — fonctionnelle en pratique, fragile en droit

Chemin réel au clic « Synchroniser » : `sync-button.tsx:47` → `sync-contexte.tsx:61` → `banques/actions.ts:277,285` → `widget/orchestration.ts:1026,1326` → **`src/server/ingestion/orchestrateur.ts:150`**, boucle `:165-193`, arrêt `:183`.

L'analyse statique soupçonnait une sortie après la page 1 : la condition `if (!env.Links?.Next || page >= totalPages) break;` (`orchestrateur.ts:183`) est un `||`, et le dépôt documente lui-même (`widget/orchestration.ts:1091-1095`, correctif du 2026-07-13) que l'amont **omet `Links.Next`** sur `/connections`. Le correctif `Meta.TotalPages` n'a jamais été propagé à `/transactions`.

**Ce soupçon est infirmé par le runtime.** Appel GET réel sur `api-stage`, compte `434836a2…` :

```json
"Links": { "Self": "...", "First": "...", "Last": "...page=20...", "Next": "...page=2..." }
"Meta":  { "TotalPages": 20, "TotalRecords": 1923 }
```

`Next` **est** servi sur cet endpoint. Corroboré en base : un compte porte 1811 transactions = 19 pages effectivement parcourues à `pageSize=100`.

**La pagination ne tronque pas. Confiance 10/10.** La condition reste néanmoins une **dette latente** (§7-A) : elle marche par chance, pas par contrat.

`pageSize` effectif = 100 (`orchestrateur.ts:37`, `bornerPageSize(undefined)` — aucun appelant ne le passe).

## 3. Partitions `transactions_cache` — hors de cause

`drizzle/migrations/0003_epic3-financial-core.sql:58` partitionne par `transaction_date`. Partitions 2024 / 2025 / 2026 / 2027 (`:65-72`) **plus une partition `DEFAULT`** (`:73`).

Une transaction de n'importe quelle date atterrit donc quelque part : `no partition of relation found for row` est **structurellement impossible**. `upsertTransactions` (`src/server/repositories/ingestion.ts:165-241`) n'avale rien non plus — pas de try/catch, `onConflictDoUpdate` (`:208-237`) et non `DoNothing`, aucun filtrage de lignes.

Preuve directe en base : `transactions_cache_2024`, `_2025`, `_2027` et `_default` contiennent **0 ligne** ; les 9 056 lignes sont toutes dans `_2026`. Les partitions anciennes existent et sont vides — elles n'ont jamais rien refusé.

**Confiance 10/10.**

## 4. Plancher SQL du dashboard — hors de cause

`PLANCHER_HISTORIQUE = "2024-01-01"` (`src/lib/periode.ts:55`) est une **ouverture, pas une exclusion** : c'est la borne la plus large, alignée sur la première partition. `resoudrePeriode` en mode « tout » (`periode.ts:323-331`) renvoie `from = 2024-01-01`, `to = aujourd'hui`.

L'agrégat `syntheseParMois` (`src/server/repositories/dashboard.ts:611-618`) ne filtre que `is_removed = false` + `transaction_date BETWEEN from AND to`. **Aucun `LIMIT`, aucun `now() - interval`, aucun second plancher.**

La grille de mois vient des bornes de période (`page.tsx:243` → `dashboard.ts:636-650`), pas des données — d'où l'axe janv. 2024 → oct. 2026 (31 mois + 3 de prévision) affiché même à vide. Les mois vides sont **légitimement** vides.

Si la base contenait du 2024/2025, le dashboard l'afficherait. **Confiance 9/10.**

## 5. Preuve base ↔ preuve source — la confrontation décisive

**En base** (9 056 transactions réelles, 157 comptes, 3 connexions) :

| Banque | `institution_id` | Créée le | Tx | Plus ancienne | Écart |
|---|---|---|---|---|---|
| Mauritius Commercial Bank | `inst_mcb_pro` | 2026-07-13 | 8 282 | **2026-04-13** | **91 j** |
| State Bank of Mauritius | `inst_sbm_pro` | 2026-07-16 | 765 | 2026-06-09 | 37 j |
| Absa Internet Banking | `inst_absa` | 2026-07-16 | 9 | 2026-05-19 | 58 j |

16 comptes MCB partagent **exactement** le plancher 2026-04-13 et portent 68 % de la base — signature d'un mur de date, non d'une décroissance d'activité.

**À la source** (3 preuves indépendantes et convergentes, GET seuls) :

1. Dernière page (`page=20`) du compte le plus fourni → plus ancien `BookingDateTime` servi = **2026-04-13T08:00:00Z**, identique au `min(transaction_date)` en base.
2. `fromBookingDateTime=2024-01-01T00:00:00Z` → `TotalRecords: 1923`, **strictement inchangé** par rapport à l'appel sans borne.
3. `toBookingDateTime=2026-04-12T23:59:59Z` → `TotalPages: 1, TotalRecords: 0` sur les 3 comptes testés.

**L'amont ne détient rien avant le 2026-04-13.** La base contient ce que l'API sert. **Confiance 10/10.**

**Cause racine, côté extracteur amont** — chaîne complète :
`inst_mcb_pro` → `extractor: 'mcb_pro_extractor'` (`omni-fi-core`, `apps/institutions/management/commands/seed_institutions.py:266,314`) → `apps/scraping/extractors/api/mcb_pro_transactions.py:54-62` :

```python
def _days_window(days_from: int = 92, days_to: int = 0) -> Dict[str, str]:
    """Using 92 days to approximate 3 months without month arithmetic edge cases."""
```

**Fenêtre de 92 jours codée en dur.** 2026-07-13 − 92 j = 2026-04-12 ; plancher observé 2026-04-13 (écart d'un jour cohérent avec `bookingDateGreaterThan` strict + fuseau `Indian/Mauritius`). **Confiance 9/10.**

## 6. Pourquoi « il suffit de demander plus » ne marche pas ici

Le backend Omni-FI **possède** une capacité d'historique profond, déployée : `POST /sync/{id}?fromDate=&toDate=` (camelCase, `YYYY-MM-DD`), plafonnée à 548 jours / 18 mois (`apps/sync_engine/views.py:48,51-105`). Elle vit sur `origin/staging`, et `staging` **est** la branche déployée sur `api-stage.omni-fi.co` (`.github/workflows/aws-ecs.deploy.staging.yml:17-20` → cluster `omni-fi-staging` → ALB portant le certificat `api-stage`).

TYGR ne l'appelle jamais (§1). **Mais l'ajouter ne débloquerait rien pour les connexions actuelles** :

- `mcb_pro.py:170-184` — `extract()` accepte `history_from_date`/`history_to_date` et **ne les utilise jamais** : il appelle `self.extract_transactions()` sans les transmettre. Les kwargs n'existent que pour satisfaire l'interface `Extractor`.
- Même motif documenté sur `absa_pro.py:694-706` (« does not use these parameters »).
- Seule la variante **personnelle** `inst_mcb` honore la profondeur (`mcb.py:475-483` → `_extract_windowed`). Nos 3 connexions sont `_pro` / `absa`.

Autrement dit : la fenêtre courte est imposée par l'extracteur de la variante *business*, et **aucun paramètre côté TYGR ne peut la contourner aujourd'hui**. **Confiance 8/10** (le mapping registre est prouvé ; le comportement runtime de l'extracteur n'a pas été exécuté).

Point favorable pour la suite : **il n'y a aucune rétention/purge côté Omni-FI** — pas de purge planifiée des transactions, `Transaction.account` en `on_delete=PROTECT`, `cleanup_old_jobs` ne touche que `raw_scraper_output`. Tout ce qui est scrapé une fois **reste**. Un backfill profond, le jour où il est possible, est un one-shot permanent.

---

## 7. Constats secondaires (réels, hors question posée)

**A. Dette latente — la condition d'arrêt disqualifiée n'a été corrigée qu'à un seul endroit.** Le correctif du 2026-07-13 (`widget/orchestration.ts:1096-1097`, piloté sur `Meta.TotalPages`) n'a pas été propagé aux 6 autres boucles : `orchestrateur.ts:183` (transactions), `ingestion/index.ts:38` (connections) et `:101` (soldes EOD), `orchestration.ts:506`, `:1247`, `:1587` (accounts). Elles fonctionnent parce que ces endpoints-là servent `Links.Next` — ce n'est pas garanti par contrat. Aggravant : les fixtures de test **fabriquent** un `Links.Next` que l'amont n'envoie pas toujours — `tests/unit/ingestion-orchestrateur.test.ts:33-42` (`Links: { Next: opts.next ?? null }`), `tests/isolation/widget-orchestration-isolation.test.ts:112-116`. Le test de non-régression `Links: {Self}` + `TotalPages: 2` existe **uniquement** pour `listerConnexions` (`:553-571`), jamais pour les transactions. Gate verte sans mentir. **Confiance 10/10.**

**B. La pagination par offset amont est instable.** Balayage des 20 pages : 1 923 lignes servies pour **1 821 `TransactionId` distincts** (102 doublons). Tri non déterministe sur `-booking_date_time` avec ex æquo → ce qui est dupliqué sur une page est omis ailleurs. Une passe isolée perd ~5 % des lignes. L'upsert idempotent fait converger les passes successives, donc pas de perte durable — mais une synchro unique n'est pas complète. Contre-preuve qui isole le phénomène : requête bornée sur `2026-04-27` → `TotalRecords: 54`, 54 ids distincts, **54 en base**. Piste : itérer par fenêtres de dates bornées (`fromBookingDateTime`/`toBookingDateTime`, qui fonctionnent, §5) et asserter `count == Meta.TotalRecords` par fenêtre. **Confiance 9/10.**

**C. 73 transactions récentes non ingérées** sur le seul compte `434836a2…` (2026-07-14 : 30, 07-15 : 26, 07-16 : 17) — postérieures à la dernière synchro. Cohérent avec B et avec le retard amont observé (82 comptes synchronisés le 2026-07-20, `max(transaction_date)` = 2026-07-17).

**D. 55 comptes sur 157 (35 %) ont zéro transaction**, et 32 comptes s'arrêtent net au 2026-06-30 alors que d'autres vont au 07-16. À investiguer séparément — possible décrochage de sync par compte.

---

## 8. Action recommandée

**Aucun correctif de troncature n'est à faire** : le code d'ingestion est innocenté sur la question posée. Ce qu'il reste, par ordre de valeur :

1. **Trancher avec Omni-FI la profondeur d'historique des variantes `_pro`** (métier, pas technique). Question précise à leur poser : « `mcb_pro_extractor` ignore `history_from_date` et impose une fenêtre de 92 jours (`mcb_pro_transactions.py:54-62`) — pouvez-vous le câbler sur `history_from_date` comme `mcb.py:475-483` le fait pour la variante personnelle ? » Sans cela, **aucune donnée avant avril 2026 n'existera jamais**, quoi que fasse TYGR.
2. **Refermer la dette A** (6 boucles + fixtures fidèles au runtime) — 1 h, sans effet visible aujourd'hui, mais c'est exactement le motif qui a causé l'incident #201.
3. **Traiter B** (complétude par fenêtres de dates + assertion `Meta.TotalRecords`) — c'est le vrai risque de perte silencieuse restant sur le chemin d'ingestion.
4. **Côté UI** : tant que la profondeur reste de 3 mois, un axe qui s'ouvre en janvier 2024 sur une période « Tout » affiche 27 mois structurellement vides et donne l'impression d'un bug. Envisager d'ancrer la borne basse de « Tout » sur `min(transaction_date)` réel plutôt que sur `PLANCHER_HISTORIQUE`. **Décision produit — non tranchée ici.**

---

## Ce qui n'a pas pu être vérifié

- Le comportement runtime des extracteurs amont n'a pas été **exécuté** (lecture de code uniquement) — aucun `POST /sync` n'a été déclenché, conformément au mandat lecture seule et au rate-limit 1/15 min.
- Les refs locales de `omni-fi-core` datent du 2026-06-17 (~5 semaines) ; aucun `git fetch` n'a été fait. Le `staging` déployé a pu bouger depuis.
- La fenêtre par défaut de `inst_sbm_pro` n'a pas été localisée (pas de `sbm_pro.py` ; `sbm.py:733,756,833` honore `history_from_date`, mais le mapping registre de la variante `_pro` n'a pas été confirmé). Les planchers SBM (37 j) et Absa (58 j) s'expliquent aussi bien par une activité faible que par une fenêtre courte — **non tranché**, sans incidence sur le verdict, MCB portant 91 % des transactions.
