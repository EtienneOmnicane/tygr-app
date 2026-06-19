# Point de reprise — à lire en premier (session du 2026-06-19)

> Document de reprise. On reprend **ici** lundi. Tout est consigné pour repartir sans
> rien rechercher. Les détails vivent dans les docs liés ; ce fichier est la **carte**.

---

## TL;DR — où on en est

La session a réparé deux blocages majeurs et posé l'architecture du gros chantier.

1. ✅ **Crash `/transactions` réparé** (drift de migration) — PR #72 mergée. Outillage
   `db:migrate` / `db:baseline` désormais câblé.
2. ✅ **Ingestion des transactions réparée** — PR #75 mergée. **260 transactions remontent**
   enfin (workspace Omnicane), `/transactions` affiche la liste.
3. ✅ **Roadmap produit** formalisée (8 axes CEO challengés) — PR #73 mergée
   (`ROADMAP-OMNICANE.md`).
4. 📋 **Plan d'architecture Entités écrit** (Option B validée) — `PLAN-entites-multi-tenant.md`,
   **EN ATTENTE DE TA VALIDATION**. C'est le point de reprise principal.

---

## Ce qui est LIVRÉ et mergé cette session

| PR | Quoi | État |
|----|------|------|
| #72 | `db:migrate` + `db:baseline` câblés (drift migration → crash /transactions) | ✅ MERGED |
| #73 | `ROADMAP-OMNICANE.md` — to-do globale CEO (8 axes, challengée) | ✅ MERGED |
| #74 | Correctif doc : pas de base Neon cloud (DB-MIGRATE1 repriorisé) | ✅ MERGED |
| #75 | Fix ingestion : montant 4 décimales + bank_label_raw nullable (migration 0007) | ✅ MERGED |

Détails techniques durables : voir les mémoires `migration-drift-db-migrate.md` et
`ingestion-transactions-format.md` (dans `~/.claude/projects/.../memory/`).

---

## LE POINT DE REPRISE — chantier Entités (priorité démo n°1)

### Décision actée (validée CEO, ne pas re-litiger)
**Option B** : le Workspace = « Groupe Omnicane » (tenant unique) ; les **Entités** (BU :
Sucrière, Énergie…) sont un **attribut** `bank_accounts.entity_id`, PAS une frontière de
tenant. Raison : **1 credential bancaire = comptes de N entités** (une connexion remonte
les comptes de plusieurs BU d'un coup → l'Option A polluerait les workspaces). Confirmé par
la donnée réelle : 35 connexions / 99 comptes pour un seul EndUser.

### Le plan détaillé est écrit → `PLAN-entites-multi-tenant.md`
Il couvre les 4 axes demandés :
1. **Modèle/migrations** : table `entities` + `bank_accounts.entity_id` nullable (FK
   composite) + sas de tri compte→entité (Omni-FI ne ventile pas par entité).
2. **RLS** : 2 étages — tenant (inchangé) + scope entité via GUC `app.current_entity_scope`
   + policy `entity_scope`. Fail-closed.
3. **RBAC/UI** : Vision Entité (membre scopé) vs Group Auditor (scope vide = consolidation
   globale). L'UI ne décide rien, la RLS filtre.
4. **CLAUDE.md** : texte Tribal Knowledge prêt (à insérer après implémentation).

Découpage : **PR-E1** (schéma) → **PR-E2** (RLS scope, cœur sécurité, cross-review) →
**PR-E3** (sas d'assignation) → **PR-E4** (RBAC + UI).

### ⏳ EN ATTENTE DE TOI avant de coder PR-E1
**Décision provisoire prise** : 1 compte = 1 entité (`entity_id` colonne). Le multi-entités
(cash-pooling) est balisé comme évolution future.

**3 questions ouvertes (§6 du plan)** + 1 vérif métier — à trancher lundi :
1. **Vérif métier** : des comptes mutualisés (partagés entre entités) existent-ils chez
   Omnicane ? Si oui → re-trancher colonne vs table de liaison AVANT PR-E1.
2. Règle de mapping auto compte→entité : une convention Omnicane fiable existe-t-elle
   (préfixe de nom de compte, plage IBAN, code) ? Sinon → sas 100 % manuel au départ.
3. Group Auditor : nouveau rôle `GROUP_AUDITOR` (recommandé) ou réutiliser `ADMIN` ?
4. La catégorisation (splits) doit-elle être bornée au périmètre entité ? (recommandé : oui)

### Comment reprendre lundi (3 voies)
- **A** — Tu réponds aux 4 questions ci-dessus → j'affine le plan → on attaque **PR-E1**.
- **B** — Tu valides le plan tel quel → revue (`/plan-eng-review`) avant code, ou PR-E1 direct.
- **C** — Tu ajustes un point du plan → je le révise.

---

## Reste aussi sur la table (roadmap, après Entités ou en parallèle)

Priorités issues de `ROADMAP-OMNICANE.md` (ordre recommandé) :
- **DASH-AUTOSYNC1 (P1, partiel)** : l'ingestion est réparée (#75) mais la synchro reste
  **manuelle** (clic « Synchroniser »). Reste à **automatiser** le déclencheur (cron Inngest
  / webhook / post-Finish). Chantier scheduling dédié.
- **Test API production (P2)** : branche dédiée, garde-fous sécu, vrai compte bancaire.
- **Déploiement (P2)** : choisir l'hébergeur (Vercel vs conteneur — attention au driver DB
  WebSocket/transactions), créer l'instance cloud, puis **DB-MIGRATE1** (baseline+migrate
  sur cette base — aujourd'hui tout est en local Docker, pas de base cloud).
- **Scalabilité (P3)**, **refacto anglais (P3, reporté)**.

---

## État technique au moment de la pause

- Branche : `main` (à jour, tout mergé jusqu'à #75).
- Base : **100 % locale Docker** (`tygr_postgres`), à jour (migrations 0000→0007 appliquées).
  Pas de base Neon cloud. 260 transactions présentes dans le workspace Omnicane.
- Tests : 356 verts. `db:migrate` / `db:baseline` opérationnels.
- Working tree : `PLAN-entites-multi-tenant.md` + ce fichier (à committer).

> Pour reprendre le fil complet : lis `PLAN-entites-multi-tenant.md` (le plan), puis les §
> « questions ouvertes » ci-dessus. C'est tout ce qu'il faut.
