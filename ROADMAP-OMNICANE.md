# Roadmap Omnicane — feuille de route stratégique

> Transcription challengée de la to-do globale CEO (2026-06-19). Vue **produit** ;
> les dettes techniques fines vivent dans `TODOS.md` (référencées ici). Chaque point
> porte : état réel vérifié dans le code, priorité, dépendances, et le défi posé.
>
> Décisions d'architecture déjà actées (ne pas re-litiger) :
> - **Modèle = Option B** (un workspace « Groupe Omnicane », entités = niveau SOUS le
>   workspace, `entity_id` taggé à l'ingestion). Tranché par la contrainte métier
>   **« 1 connexion bancaire = N entités »** : une connexion (1 credential) remonte les
>   comptes de plusieurs entités d'un coup. L'Option A (entité = workspace isolé) y va
>   dans le mur (pollution cross-workspace + duplication du credential + consolidation
>   cross-tenant interdite par la RLS). Voir le détail au point 2.
> - **Langue = français conservé pour la démo** (cohérent BOM Innov8). Le refacto anglais
>   est reporté (point 8). DR-F1 (traduire les catégories Omni-FI anglaises → FR) reste valable.

---

## 0. État des lieux préalable — ✅ FAIT (2026-06-19)

Point de situation établi. Acquis récents : dashboard solde multidevise (PR #68/#69),
nom d'institution (#65), idempotence comptes (#65), **fix du crash `/transactions`**
(drift de migration, PR #72 mergée — `db:migrate`/`db:baseline` câblés). Reste : la
synchro des transactions est vide (point 4), aucune notion d'Entité (point 2), pas de
stratégie de déploiement (point 7).

---

## 1. Modèle de données & hiérarchie consolidée

**Objectif** : structurer la donnée selon le flux **Banques → Entités → Comptes → Soldes → Transactions** pour refléter l'organisation du Groupe Omnicane.

**État réel** : le schéma a `workspaces → bank_connections → bank_accounts → {balance_history, transactions_cache}`. Le maillon **Entités est ABSENT**. `bank_accounts` hérite mécaniquement du `workspace_id` de la session qui synchronise (`repositories/ingestion.ts`) — aucune granularité sous le workspace.

**Défi / ce que ça implique** : c'est le socle de TOUT le bloc rôles (point 3). Sans `entity_id` sur les comptes, « Vision Entité » est impossible. **Bloquant pour la priorité démo n°1.**

**P1** — dépend de rien, bloque le point 3. Voir conception détaillée au point 2.

---

## 2. Entités : conception (priorité démo n°1) — À CONCEVOIR

**Décision actée : Option B.** Un seul workspace « Groupe Omnicane ». Les entités (BU :
Sucrière, Énergie…) sont un **niveau sous le workspace**. Chaque `bank_account` porte un
`entity_id`. La connexion bancaire reste unique (1 credential), ses comptes se répartissent
entre entités.

```
Workspace « Groupe Omnicane »            ← UN tenant, UNE frontière RLS (inchangée)
├─ bank_connection « Absa » (1 credential, JAMAIS dupliquée)
│   ├─ bank_account (entity_id = Sucrière)   ← tag posé à l'ingestion / au tri
│   ├─ bank_account (entity_id = Énergie)    ← même connexion, autre entité
│   └─ ...
├─ entité « Sucrière BU »
└─ entité « Énergie BU »
```

**Pourquoi Option B et pas A** (contrainte « 1 connexion = N entités », ton tableau blanc) :
- Option A (entité = workspace isolé) → si je connecte Absa depuis « Sucrière » et qu'Omni-FI
  renvoie aussi les comptes d'« Énergie » (credential maître), ils **polluent** Sucrière.
- Le « sas de tri » dans A violerait la RLS (écrire un compte avec un `workspace_id` ≠ ctx) et
  forcerait à dupliquer le credential bancaire dans chaque workspace.
- La consolidation « Vision Globale » exigerait d'additionner à travers des workspaces isolés =
  exactement ce que la RLS interdit (anti-IDOR).
- Avec B, « 1 connexion = N entités » est **trivial** et la consolidation tombe gratuitement.

**Le vrai travail (à cadrer dans un plan écrit, règle 1)** :
1. Schéma : table `entities (id, workspace_id, name, …)` + colonne `bank_accounts.entity_id`
   (nullable au départ → comptes « non assignés »). RLS sur `entities` (scopée workspace).
2. **Sas d'assignation compte → entité** à l'ingestion. Omni-FI ne connaît pas les entités
   Omnicane → quelqu'un doit dire quel compte va à quelle entité. Deux sous-options à trancher :
   - **Manuel** : comptes découverts « non assignés », un ADMIN les range via une UI de tri.
   - **Automatique** : règle de mapping (préfixe de nom, IBAN, convention Omnicane). Plus rapide,
     fragile si la convention n'est pas fiable.
3. Lecture : `entity_id` comme second niveau de scope **sous** la RLS (un `WHERE entity_id = ?`,
   PAS à la place de la RLS).

**P1, gardien Backend (schéma + RLS + ingestion).** Effort L. **Déclencheur : DÛ pour la démo.**
**Prochaine étape concrète : `/plan-eng-review` ou `/spec` pour écrire le plan avant tout code.**

---

## 3. Gestion des utilisateurs et des rôles (multi-accès)

**Objectif** : deux profils de lecture.
- **« Vision Entité »** (priorité démo n°1) : ne voit que les données de SON entité.
- **« Vision Globale »** (auditeur/directeur) : voit la consolidation = addition des soldes de
  toutes les entités du groupe.

**État réel** : rôles existants = `ADMIN`, `MANAGER`, `VIEWER` (`schema.ts:120`), tous scopés au
**workspace entier**, pas à une entité. Aucun scope par entité.

**Défi** : entièrement dépendant du point 2 (`entity_id`). Avec l'Option B :
- « Vision Entité » = un membre dont l'accès est **borné à une/des entités** (nouvelle liaison
  `membre ↔ entité`, ou un champ de scope). Reste un VIEWER, mais filtré par `entity_id`.
- « Vision Globale » = pas de filtre entité → voit tout le workspace = **l'addition naturelle**
  de toutes les entités (la consolidation par devise existe déjà, DASH-SOLDE1). Gratuit avec B.

**P1, gardien Backend, APRÈS le point 2.** Effort M. À inclure dans le même plan que les Entités.

---

## 4. Fix Dashboard & Transactions

**Objectif** : résoudre le manque de visualisations dashboard + le bug de la page transactions.

**État réel** :
- **Page Transactions bug = ✅ RÉSOLU** (PR #72, drift de migration — `categories` manquante).
  Vérifié SQL + navigateur.
- **Dashboard** : largement livré (solde multidevise #68/#69, comptes connectés, courbe).
- **MAIS** : `/transactions` rend l'état VIDE car « Omnicane Trading BU » a **12 comptes et 0
  transaction** synchronisée. Les visualisations « manquent » surtout parce que la donnée
  transaction n'est pas descendue → c'est le point 4bis ci-dessous, pas un bug d'UI.

**P2** (le bug bloquant est réglé). Le « manque de visu » réel = la synchro (4bis).

### 4bis. Synchro des transactions vide — DASH-AUTOSYNC1 (P1)

À la connexion, les comptes sont rattachés mais soldes/transactions exigent un clic manuel
« Synchroniser ». Constaté au QA : 0 transaction en base. **À investiguer** : un clic synchro
remplit-il la liste ? sinon pourquoi ? Puis automatiser (cron Inngest / webhook). Détail :
`TODOS.md → DASH-AUTOSYNC1`. **P1 — sans ça, les pages restent vides en démo.**

---

## 5. Test sur l'API de production

**Objectif** : une branche dédiée prod, sécurités locales bloquantes retirées, pour tester la
connexion à un **vrai** compte bancaire via l'API Omni-FI de prod (plus la sandbox).

**État réel** : tout pointe sur la sandbox (`stage.omni-fi.co`). `W4-D1` tracé (`OMNIFI_ENV`
découplé de l'hôte) mais aucune stratégie de test prod réel.

**Défi / garde-fous (NON négociables, app à secrets bancaires)** : « retirer les sécurités »
doit rester **chirurgical**. À cadrer :
- Ce qu'on relâche (allowlist d'origines dev ? `OMNIFI_ENV=production` + vrais hôtes ?) vs ce
  qu'on NE touche JAMAIS (RLS, append-only, isolation tenant, pas de PII en log).
- Secrets prod distincts de la sandbox (env, jamais commités).
- W4-D1 doit être fait d'abord (lier env→hôtes, fail-closed) pour ne pas viser la prod par erreur.

**P2 — DÛ avant la démo « vrai compte »**, gardien Backend. Effort M. **À concevoir dans un plan
dédié** (pas une PR à l'arrache vu la surface secrets/sécu).

---

## 6. Scalabilité (charge multi-utilisateurs)

**Objectif** : vérifier que l'app tient avec plusieurs utilisateurs simultanés.

**État réel** : aucune entrée, aucun test de charge. Points d'attention connus : pool de
connexions Neon (WebSocket), `withWorkspace` ouvre une transaction par requête (BEGIN + SET
LOCAL), rate-limits amont Omni-FI (sync 1/15min/connexion).

**Défi** : « scalabilité » est vague — il faut définir la cible (combien d'utilisateurs ? quels
parcours ?). Le vrai risque court terme n'est pas le nombre d'utilisateurs mais le **coût du
re-téléchargement complet des transactions** à chaque sync (déjà tracé `INGEST-DELTA1`) et la
taille du pool Neon.

**P3 (après la démo)** — à transformer en objectif mesurable. Effort M-L.

---

## 7. Stratégie de déploiement

**Objectif** : choisir la plateforme d'hébergement. Évaluer Vercel + alternatives.

**État réel** : `Dockerfile` présent (build standalone), aucune plateforme choisie. Plusieurs
dettes pointent « au 1er déploiement » (W4-D1, partitions, runbook AUTH_SECRET) — CLAUDE.md
règle 9 réclame ce choix.

**Défi** : Vercel est naturel pour Next.js MAIS l'app exige des **transactions DB
multi-statements** (`SET LOCAL`, E16) → driver WebSocket/Pool obligatoire, mode HTTP interdit.
Sur du serverless, attention au pooling. Le `Dockerfile` existant ouvre la porte à un hébergement
conteneur (Fly, Railway, Cloud Run) si Vercel coince. Inngest (crons) et Neon ont aussi leur mot
à dire.

**À livrer** : un comparatif court (Vercel vs conteneur) + le choix + le runbook de déploiement
(migrate AVANT deploy — voir DB-MIGRATE1, le câblage existe désormais). **P2**, à décider avant la
mise en prod. Effort S (décision) + M (mise en place).

---

## 8. Refactoring linguistique (tout en anglais) — REPORTÉ

**Objectif** : traduire l'intégralité du projet (code + interface) en anglais.

**Décision (2026-06-19)** : **REPORTÉ après la démo.** Le français est conservé (contexte BOM
Innov8, directive CLAUDE.md « Interface en français »). Ce refacto contredirait la directive
actuelle et DR-F1 (qui traduit les catégories anglaises Omni-FI → FR).

**Si rouvert** : gros chantier transverse (toutes les chaînes UI + commentaires + identifiants).
Option i18n (next-intl) si bilingue voulu plutôt que bascule sèche. **P3, hors démo.**

---

## ⚠️ Correctif (2026-06-19, vérifié) : pas de base Neon cloud aujourd'hui

Vérification de l'env : `DATABASE_URL` ET `DATABASE_URL_ADMIN` pointent sur le conteneur
Docker **local** (`tygr_postgres:5432`), via `NEON_WSPROXY_LOCAL=localhost:5433`. **Aucune
URL `neon.tech`, aucun `.env.production/.staging`.** « Neon » n'est que le DRIVER
(`@neondatabase/serverless`, WebSocket) ; la seule base réelle est le Docker local, déjà à
jour (fix #72 appliqué). **Conséquence** : **DB-MIGRATE1 n'a rien à migrer maintenant** — il n'y
a pas de base cloud. Il devient un **point de déploiement** : DÛ le jour où une instance cloud est
créée (dépend donc du point 7). On ne migre pas une base qui n'existe pas.

## Ordre recommandé (synthèse, corrigé)

1. **DASH-AUTOSYNC1 / 4bis** — pourquoi 0 transaction ? (P1, c'est ce qui vide les écrans en démo).
2. **Entités + rôles (points 2 & 3)** — LE chantier démo n°1. Plan écrit d'abord (`/plan-eng-review`).
3. **Test API prod (point 5)** — plan dédié, garde-fous sécu (P2, avant démo « vrai compte »).
4. **Déploiement (point 7)** — comparatif + choix + création de l'instance cloud + runbook (P2).
5. **DB-MIGRATE1** — baseline+migrate sur la base cloud, **une fois qu'elle existe** (étape 4).
6. **Scalabilité (6)** puis **refacto anglais (8)** — post-démo (P3).
