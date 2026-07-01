# Audit ingestion Omni-FI — libellés & montants (2026-06-22)

> Mission « Maxi-Sprint Data », point 1. **Livrable = ce RAPPORT** (décision : audit
> sans modification de code tant que la cause n'est pas prouvée). Aucun fichier `src/`
> n'a été modifié par cet audit.

## TL;DR

- **Montants : NON inventés par un mock.** Le flux d'ingestion réel lit
  `t.Amount.Amount` de l'API Omni-FI et le normalise en chaîne `numeric(15,2)`
  **sans float** (`normaliserMontant`), avec rejet bruyant en cas de perte de
  précision. Verrou `SANDBOX_UNIQUEMENT=true` actif.
- **Libellés : on persiste DÉJÀ deux champs API** — `Description` (brut) et
  `CleanMerchantName` (marchand nettoyé). Le champ « `original_label` » du briefing
  **n'existe pas** dans le contrat Omni-FI tel que nous le typons.
- **Cause la plus probable du décalage observé** : soit (a) l'**UI affiche
  `cleanLabel`** (nom marchand) là où tu attends le **brut** `Description` — c'est un
  choix d'**affichage Front**, pas d'ingestion ; soit (b) des **données de démo
  fictives** ont été semées sur le workspace par `scripts/seed-dashboard-demo.ts`
  (script manuel, 100 % fictif). À départager en inspectant la base (cf. §5).
- **Champs API disponibles mais NON mappés** : `NormalizedDescription`,
  `TransactionReference` (cf. §4 — piste d'amélioration, pas un bug).

## 1. Le chemin d'ingestion RÉEL (synchro widget / bouton)

`synchroniserCompte` (`src/server/ingestion/orchestrateur.ts`) →
`versLignePersistee(t)` → `upsertTransactions` (`repositories/ingestion.ts`).

Mapping OBIE → colonnes (`versLignePersistee`, orchestrateur.ts) :

| Colonne TYGR (`transactions_cache`) | Champ API Omni-FI | Note |
|---|---|---|
| `omnifi_txn_id` | `t.TransactionId` | clé naturelle (idempotence) |
| `transaction_date` | dérivé de `t.BookingDateTime` | `AT TIME ZONE Indian/Mauritius` (E20) |
| `booking_date_time` | `t.BookingDateTime` | horodatage UTC brut |
| `amount` | **`t.Amount.Amount`** | `normaliserMontant` (chaîne, jamais float) |
| `currency` | `t.Amount.Currency` | |
| `credit_debit` | `t.CreditDebitIndicator` | CHECK strict {Credit,Debit} |
| `bank_label_raw` | **`t.Description`** | libellé bancaire BRUT (PII) |
| `clean_label` | **`t.CleanMerchantName`** | nom marchand nettoyé |
| `primary_category` | `t.PrimaryCategory` | catégorie OBIE auto |
| `sub_category` | `t.SubCategory` | |

→ **Deux libellés sont déjà persistés** : le brut (`Description`) ET le nettoyé
(`CleanMerchantName`). Aucun n'est inventé : ils viennent tels quels de l'API.

## 2. Montants — preuve qu'ils viennent de l'API (pas d'un mock)

`normaliserMontant` (`src/server/ingestion/conversion.ts`) :
- Entrée = `t.Amount.Amount` (chaîne décimale OBIE, ex. « 750.0000 »).
- **Manipulation de chaîne uniquement** — jamais `Number(x)*100` (perd des centimes,
  règle 8). Regex `^\d{1,13}(\.\d+)?$` ; garde 2 décimales ; **rejette** toute
  décimale significative au-delà de la 2e (`12.3456` → erreur nommée, pas d'arrondi
  silencieux).
- Le signe vient de `CreditDebitIndicator`, pas du montant (OBIE = montant positif).

→ Le montant en base est une **transformation déterministe et sans perte** de la
valeur API. **Aucun montant n'est généré** dans ce chemin.

## 3. Verrou sandbox (le connecteur tape la bonne API)

`src/server/omnifi/config.ts` : `SANDBOX_UNIQUEMENT = true`. Le client **refuse de
démarrer** si `OMNIFI_ENV=production` OU si l'hôte est de production
(`api.omni-fi.co`). Garde de cohérence env↔hôte (fail-closed). Donc toute donnée
ingérée par le flux réel vient de la **sandbox Omni-FI**, jamais d'un mock ni de la
prod.

## 4. Champs API disponibles mais NON mappés (piste, pas un bug)

Le type `OmniFiTransaction` (`src/server/omnifi/types.ts`) expose des champs que
l'ingestion **n'utilise pas** aujourd'hui :

- **`NormalizedDescription?`** — libellé **normalisé** par Omni-FI (intermédiaire
  entre le brut `Description` et le marchand `CleanMerchantName`). Non persisté.
- **`TransactionReference?`** — référence bancaire. Non persistée.
- `ValueDateTime?`, `PartyId?`, `IsDuplicate?`, `ManuallyOverridden?` — non persistés
  (hors périmètre actuel).

**Si** le « vrai » libellé attendu est `NormalizedDescription`, c'est une **évolution
d'ingestion** (ajout de colonne + mapping), pas une correction d'un mapping faux —
`Description` reste un champ API légitime. Décision produit requise (cf. la question
posée à l'humain). **NON fait dans cet audit** (pas de modif de code).

## 5. Hypothèse « données de démo fictives en base » — à vérifier côté DB

Deux scripts MANUELS écrivent dans `transactions_cache` (jamais branchés au flux de
synchro ni à la CI) :

- **`scripts/seed-dashboard-demo.ts`** : données **100 % FICTIVES** (sociétés
  mauriciennes plausibles). En-tête : « Ne JAMAIS pointer sur un workspace contenant
  de la vraie donnée ». C'est **le « vieux script de mock » du briefing** — il existe,
  mais HORS du chemin d'ingestion réel.
- **`scripts/seed-omnifi-demo.ts`** : VRAIS appels API sandbox (manuel).

**Risque** : si `seed-dashboard-demo.ts` a été lancé sur ton workspace BU, des
libellés/montants **fictifs** y coexistent avec les vrais → le décalage observé
(« les libellés ne correspondent pas à Omni-FI ») s'expliquerait par des lignes de
démo, pas par un bug de mapping.

**Diagnostic à faire (DB, dev) — non destructif :**
```sql
-- Les libellés de démo de seed-dashboard-demo.ts sont des sociétés fictives.
-- Comparer un échantillon de clean_label / bank_label_raw aux libellés réels
-- attendus côté Omni-FI pour le compte concerné.
SELECT transaction_date, amount, currency, credit_debit,
       clean_label, left(bank_label_raw, 40) AS brut_tronque
FROM transactions_cache
WHERE workspace_id = '<WORKSPACE_BU>'
ORDER BY transaction_date DESC
LIMIT 30;
```
Si des libellés ne ressemblent pas à ce qu'Omni-FI renvoie pour ce compte → données
de démo. Purge dev possible (runbook TODOS « Purge locale des données de démo ») puis
re-synchro réelle.

## 6. Conclusion & recommandations

1. **Pas de bug d'ingestion prouvé.** Montants et libellés viennent de l'API ; le
   mapping est correct pour les champs choisis (`Description`, `CleanMerchantName`).
2. **Si le décalage est un problème d'AFFICHAGE** (UI montre le marchand au lieu du
   brut, ou inversement) → correctif **Front** (choisir quel champ afficher), pas
   ingestion.
3. **Si tu veux le libellé `NormalizedDescription`** → évolution d'ingestion (colonne
   + mapping), à décider.
4. **Vérifier d'abord la base** (§5) : écarter l'hypothèse « données de démo semées »
   avant tout correctif — c'est l'explication la plus probable d'un décalage
   libellés/montants vs Omni-FI.

> Aucune modification de code dans cette tâche (audit). Les correctifs éventuels
> (Front ou ingestion) sont des chantiers séparés à décider après le diagnostic DB.
