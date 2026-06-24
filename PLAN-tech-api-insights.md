# PLAN — [P2] TECH-API-INSIGHTS (`/insights/cashflow` + `/insights/vendors`)

**Phase :** Planning / Audit de faisabilité (aucun code applicatif écrit).
**Date :** 2026-06-24 · **Env :** Staging (`api-stage.omni-fi.co`), prod Omni-FI bloquée.
**Auteur :** Architecte Backend.

---

## 0. TL;DR (la décision d'abord)

> **L'intégration directe de `/insights/*` est IMPOSSIBLE aujourd'hui : le module
> Insights renvoie `501 NOT_IMPLEMENTED` en Staging, sur TOUS ses endpoints, même
> sans authentification.** Ce n'est pas un bug de config chez nous — c'est un module
> non livré côté Omni-FI.

Deux voies. Je **recommande la Voie A** et je déconseille de coder le client amont
maintenant :

- **Voie A — Insights DÉRIVÉS en interne** (recommandée) : on calcule cashflow &
  vendors à partir de `transactions_cache` (déjà ingérée, colonnes suffisantes). Zéro
  dépendance au 501. Livre de la valeur démo immédiatement. Le jour où Omni-FI livre
  le module, on bascule ou on réconcilie.
- **Voie B — Adaptateur amont en attente** : écrire le client `/insights/*` + DTO +
  parsing maintenant, contre un endpoint 501. **Déconseillé** : on coderait un contrat
  **non observable** (le 501 ne nous montre AUCUN payload de succès réel), au risque de
  re-livrer le bug « `/v1` » et « Enrichment imbriqué » — du code écrit contre la doc,
  démenti par le runtime. Coût élevé, valeur nulle tant que le 501 tient.

Le présent plan détaille **Voie A** comme chemin de livraison, et **provisionne Voie B**
comme adaptateur futur derrière une frontière nette (DTO + flag), sans l'implémenter.

---

## 1. Audit de faisabilité Staging — preuves runtime

Méthode : `curl` sécurisés (secret jamais affiché, lu via `source .env`), chemin DOC
(`/v1/...`) **et** chemin RACINE testés, avec et sans auth.

### 1.1 Résultats bruts (reproductibles)

| Appel | HTTP | Corps |
|---|---|---|
| `GET /v1/insights/cashflow` | **404** | HTML « Not Found » (le routeur ignore `/v1`) |
| `GET /insights/cashflow` | **501** | `{"Error":{"Code":"NOT_IMPLEMENTED","Message":"Insights module is not yet implemented."}}` |
| `GET /insights/vendors` | **501** | idem |
| `GET /insights/alerts` | **501** | idem |
| `GET /dashboard/insights` | **501** | idem |
| `GET /insights/cashflow` **sans auth** | **501** | idem (le 501 précède l'authz) |
| `OPTIONS /insights/cashflow` | **200** | `Allow: GET, HEAD, OPTIONS` |
| `POST /insights/cashflow` | **405** | (méthode non permise) |
| `GET /connections?clientUserId=…` (camelCase) | **403** | `FORBIDDEN` |
| `GET /connections?client_user_id=…` (snake) | **200** | connexions réelles (témoin vivant) |

### 1.2 Lecture des preuves (faits durs, pas hypothèses)

1. **Le module Insights N'EST PAS implémenté en Staging.** 501 uniforme sur les 4
   routes. → **Aucune intégration applicative possible aujourd'hui.** Bloqueur amont.
2. **La route EST déclarée, seul le handler manque.** `OPTIONS → 200` +
   `Allow: GET, HEAD, OPTIONS` + `POST → 405` : si la route n'existait pas, on aurait
   404 (cf. `/v1`). C'est un **stub câblé, logique métier absente** — bon signe pour la
   stabilité du *path*, mais le **schéma de réponse de succès reste totalement inconnu**
   (le 501 ne révèle aucun payload). On ne peut pas figer un DTO de parsing fiable.
3. **La doc OpenAPI ment (×2), confirmé :**
   - le préfixe **`/v1` est FAUX** (404) — routes à la RACINE. Déjà gravé dans
     `config.ts` ; cet audit le re-confirme pour le module Insights.
   - le paramètre est **`client_user_id` (snake_case)**, PAS `clientUserId` (qui donne
     403). Notre `client.ts` a **raison contre la doc** (il envoie déjà `client_user_id`).
     → règle de plan : **toujours snake_case en query B2B**, ne jamais se fier au camelCase
     de la doc.
4. **L'enveloppe d'erreur 501 diverge du contrat OBIE documenté.** On reçoit
   `{"Error":{"Code","Message"}}` (objet `Error` **singulier**), là où la doc promet
   `{"Id","Code","Message","Errors":[…]}`. → notre mapper d'erreurs (`erreurs.ts`) doit
   **tolérer les deux formes** et traiter **501 comme un état nommé** (`OMNIFI_FEATURE_UNAVAILABLE`).

### 1.3 Conséquence directe

Construire l'intégration amont *maintenant* = écrire un parseur contre un contrat
fantôme. Le projet a déjà été mordu deux fois par ce schéma (`/v1`, `Enrichment`
imbriqué). **On ne recommence pas.** D'où la Voie A.

---

## 2. Voie A — Insights dérivés de `transactions_cache` (chemin de livraison)

### 2.1 Pourquoi c'est faisable sans l'API

`transactions_cache` porte déjà tout le nécessaire (vérifié `schema.ts`) :
`amount` (numeric 15,2), `currency` (char 3), `credit_debit` (`Credit`|`Debit`),
`transaction_date` (date Maurice, dérivée TZ à l'ingestion), `booking_date_time`,
`primary_category`, `clean_merchant_name`/`normalized_description`, `is_removed`.

→ **cashflow** = agrégat inflow/outflow/net par bucket temporel.
→ **vendors** = concentration par contrepartie (clean_merchant_name) + part.

C'est exactement la logique que l'API *finira* par offrir ; on la tient déjà côté data.

### 2.2 Contrat de sortie (DTO internes — pas de couplage à l'API amont)

DTO **nôtres**, nommés pour notre domaine, pas un miroir du schéma Omni-FI inconnu.
Montants en **chaîne décimale** (règle 8, jamais de float). Un bucket/ligne **par
devise** (jamais d'addition cross-devise — convention dashboard existante DASH-FX1).

```ts
// src/server/insights/types.ts  (à créer en phase implémentation)
type PointCashflow = {
  bucket: string;          // 'YYYY-MM-DD' (granularité jour/semaine/mois)
  devise: string;          // ISO 4217
  entrees: string;         // somme |Credit|, décimal string
  sorties: string;         // somme |Debit|, décimal string
  net: string;             // entrees − sorties (decimal arithmetic, pas float)
  nbTransactions: number;
};
type SerieCashflow = { granularite: 'jour'|'semaine'|'mois'; points: PointCashflow[] };

type LigneVendor = {
  contrepartie: string;    // clean_merchant_name (repli normalized_description)
  devise: string;
  montant: string;         // total décimal (sens selon `direction`)
  part: string;            // fraction 0..1 EN STRING (ratio décimal, pas float d'affichage)
  nbTransactions: number;
};
type ConcentrationVendors = {
  direction: 'inflow'|'outflow'|'both';
  lignes: LigneVendor[];   // triées montant desc, top N borné
};
```

### 2.3 Schéma de base de données — **AUCUNE nouvelle table requise (P0)**

> Décision : les insights dérivés sont **calculés à la lecture** (agrégation SQL sur
> `transactions_cache`), pas matérialisés. Donc **pas de migration au MVP**.

Justification : (a) le volume actuel (≈ centaines de tx/workspace) rend l'agrégat
trivial ; (b) matérialiser introduit une **dette de cohérence** (re-sync, tombstone
`is_removed`, réassignation d'entité → invalidation) pour zéro besoin de perf prouvé ;
(c) règle 9 — pas de table spéculative.

**Si** un besoin de perf émerge (cap démontré, pas supposé) → vue matérialisée
`insights_cashflow_daily` rafraîchie post-sync, **append-only au DELETE** (trigger +
liste blanche, comme toute table financière). Tracé comme **dette conditionnelle P2**
(déclencheur : p95 de la requête d'agrégat > seuil sur jeu réel). **Pas avant.**

### 2.4 Accès données — invariants TYGR NON négociables

- **Tenancy** : tout passe par `withWorkspace` (règle 2). L'agrégat est une lecture
  scopée `workspace_id` via repository, jamais de SQL ad-hoc en route/composant.
- **Scope entité** : l'agrégat lit `transactions_cache` **JOINT à `bank_accounts`**
  (jamais la table fille seule — ENTITY-READ-JOIN1). La policy `entity_scope`
  RESTRICTIVE filtre alors Vision Entité vs Globale **sans WHERE manuel** dans le code.
- **Fuseau Maurice** : les buckets temporels s'appuient sur `transaction_date` (déjà
  en heure Maurice à l'ingestion) ; toute borne de période repasse
  `AT TIME ZONE 'Indian/Mauritius'` si dérivée de `booking_date_time` (E20).
- **Append-only** : lecture seule, aucun DELETE/UPDATE — rien à durcir côté intégrité.
- **Multi-devise** : `GROUP BY … currency` systématique ; pas de FX d'affichage sans
  taux annoté.

### 2.5 Surface exposée (Server Actions / repositories)

- `src/server/repositories/insights.ts` : `cashflowParDevise(ctx, {granularite, from, to})`,
  `vendorsParConcentration(ctx, {direction, topN})`. Keyset/borné, jamais OFFSET.
- Server Actions de lecture si l'UI les appelle directement, sinon RSC → repository.
- **Pas** de route HTTP publique nouvelle au MVP (lecture interne dashboard).

---

## 3. Voie B — Adaptateur amont `/insights/*` (PROVISIONNÉ, non implémenté)

Quand Omni-FI livrera le module (501 → 200), l'intégration sera **mince** car isolée :

- `OmniFiClient.getInsightsCashflow(clientUserId, {partyId, granularity})` et
  `getInsightsVendors(clientUserId, {direction})` — `ApiKey`, query **snake_case**,
  chemin **racine** (`/insights/cashflow`, sans `/v1`).
- **DTO de mapping séparé** des DTO internes du §2.2 : le code de dérivation et le code
  amont produisent le **même type interne** (`SerieCashflow`/`ConcentrationVendors`),
  derrière une frontière `mapDepuisOmniFi(payload) → SerieCashflow`. L'UI ne voit jamais
  la différence.
- **Bascule par flag** `INSIGHTS_SOURCE = 'derive' | 'omnifi'` (env), défaut `derive`.
  Permet réconciliation (comparer dérivé vs amont) avant de couper.
- **Garde 501** : tant que `mapDepuisOmniFi` reçoit 501/`NOT_IMPLEMENTED`, on **retombe
  sur la dérivation** (fail-safe), avec log structuré `OMNIFI_FEATURE_UNAVAILABLE`.
- **Parsing défensif** : le schéma de succès étant **inconnu à ce jour**, le DTO amont
  sera figé **uniquement** après un premier 200 réel observé (re-run de cet audit).
  → Jusque-là, **ne pas geler le parseur** : risque « contrat fantôme ».

> ⚠️ Aucune ligne de la Voie B n'est écrite tant que le 501 tient. C'est un **design
> de frontière**, pas une implémentation. Re-déclencher l'audit (§1) à chaque sprint
> tant que TECH-API-INSIGHTS est ouvert ; le passage 501→200 est le **déclencheur**.

---

## 4. Quality Gates (exigés avant toute future PR)

Rappel des gates TYGR applicables à ce chantier (CLAUDE.md). **Bloquants.**

### 4.1 Revue de sécurité OWASP (ASVS) — sur les futures routes/Server Actions
- **IDOR / tenancy** : agrégat scopé `withWorkspace` ; cas cross-workspace → 0 ligne,
  ajouté à la **suite d'isolation IDOR** (bloquante CI). Un workspace ne voit jamais le
  cashflow d'un autre.
- **Scope entité** : cas « membre Vision Entité » → l'agrégat exclut les comptes hors
  périmètre (preuve via JOIN `bank_accounts` + GUC, pas de WHERE applicatif).
- **Injection** : agrégats en **paramètres liés** uniquement (granularité/direction
  validées contre une **enum fermée** zod, jamais interpolées dans le SQL).
- **Validation d'entrée** : zod strict sur `granularite ∈ {jour,semaine,mois}`,
  `direction ∈ {inflow,outflow,both}`, bornes de dates **calendaires** valides (cf.
  pièges F1/F2 transactions), `topN` borné (anti-abus mémoire).
- **Messages non-énumérants** + **erreurs nommées** : 501 amont → `OMNIFI_FEATURE_UNAVAILABLE` ;
  jamais de libellé bancaire brut ni de `Message` PII de l'API dans nos logs/erreurs (règle 8).
- **Mapper d'erreurs amont** (Voie B) : tolère **les deux enveloppes** observées
  (`{Error:{…}}` singulier **et** `{Id,Code,Message,Errors:[]}` OBIE).

### 4.2 Hooks stricts (linter + compilation) avant push
- `npm run lint` **et** `npm run typecheck` **verts** — stop-loss au commit (Gate 5),
  doublement appliqué : hook `PreToolUse` (`.claude/settings.json`) **et** `.husky/pre-commit`.
- Aucun test rouge commité ; aucune dette d'isolation/append-only/montant (interdites).

### 4.3 Autres gates
- **Tests** (Gate 3/3) : chemin heureux (agrégat multi-devise), échec (période vide →
  série vide, pas null), limite (tx `is_removed=true` exclues, devise unique vs multi,
  contrepartie nulle → repli libellé).
- **Visual QA** (Gate 4) si l'UI consomme : états loading/vide/erreur du graphe cashflow
  capturés headless vs `UI_GUIDELINES.md` (couleurs `inflow`/`outflow` sémantiques,
  `tabular-nums`, virgules décimales alignées en multi-devise).
- **Human-in-the-Loop** : PR `feat/`, donc **applicative** → l'agent s'arrête à la PR
  poussée, l'humain valide (devises/fuseaux) et merge. Pas d'auto-merge.

---

## 5. Plan d'action séquencé (phase implémentation, hors de ce ticket de planning)

| # | Étape | Gate de sortie |
|---|---|---|
| 1 | Re-confirmer le 501 (audit §1 rejoué) + décider Voie A | preuve runtime à jour |
| 2 | DTO internes `src/server/insights/types.ts` (§2.2) | typecheck |
| 3 | Repository `insights.ts` : `cashflowParDevise`, `vendorsParConcentration` (JOIN bank_accounts, GROUP BY currency) | tests agrégat + isolation IDOR |
| 4 | Câblage RSC/Server Action de lecture (scopé `withWorkspace`) | zod strict + erreurs nommées |
| 5 | (UI, autre agent) graphe cashflow + table vendors sur DTO internes | Visual QA Gate 4 |
| 6 | Frontière Voie B `mapDepuisOmniFi` + flag `INSIGHTS_SOURCE` **STUB** (signature only) | revue de frontière, **pas** de parseur figé |
| — | **Différé** : vue matérialisée (P2 conditionnelle perf) ; client amont réel (déclencheur 501→200) | dette TODOS.md datée |

---

## 6. Dettes / différés à inscrire dans TODOS.md (règle 9)

- **INSIGHTS-AMONT1 (P2)** — module Omni-FI `/insights/*` = `501 NOT_IMPLEMENTED` en
  Staging (2026-06-24). Déclencheur de résolution : passage 501→200 (re-run audit §1).
  Effort : ~1j (client + mapper) **une fois le schéma de succès observable**. Bloque la
  Voie B ; n'impacte pas la Voie A.
- **INSIGHTS-MATVIEW1 (P2 conditionnelle)** — matérialiser cashflow si p95 agrégat >
  seuil sur jeu réel. Déclencheur : cap de perf **démontré**, pas supposé. Append-only
  au DELETE obligatoire (trigger + liste blanche).
- **Note transversale** — paramètre B2B = **`client_user_id` snake_case** (camelCase →
  403). Confirmé sur `/connections`. Aligne tout futur appel ; la doc OpenAPI est fausse
  sur ce point comme sur `/v1`.

---

## 7. Pushback (règle 10) — l'angle mort que je signale

Le ticket suppose implicitement « intégrer les endpoints `/insights/*` ». **Cette
prémisse est invalidée par le runtime** : le module n'existe pas côté amont. Exécuter
la lettre du ticket (coder le client `/insights/*`) produirait du **code mort testé
contre un mock inventé**, exactement le piège `/v1`/`Enrichment` déjà payé deux fois.

→ Alternative chiffrée :
- **Voie A** (dérivé interne) : ~1–1,5 j CC, valeur démo **immédiate**, zéro dépendance
  au 501, réutilise 100 % de la data ingérée. Réconciliable plus tard.
- **Voie B maintenant** : ~1 j CC **gaspillé** (parseur contre contrat fantôme) +
  re-travail garanti au premier 200 réel + risque de bug silencieux en prod.

Recommandation : **Voie A livrée, Voie B provisionnée derrière une frontière + flag,
implémentée seulement quand le 501 tombe.** L'humain tranche.
