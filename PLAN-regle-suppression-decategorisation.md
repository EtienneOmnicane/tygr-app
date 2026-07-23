# PLAN — Suppression de règle + décatégorisation de son périmètre (FEAT-REGLE-DELETE1)

> **Phase : CONCEPTION uniquement** (CLAUDE.md règle 1). Ce document est le livrable.
> Aucune ligne de code applicatif, aucune migration, aucun test n'est écrit dans le
> même fil. L'implémentation référencera ce plan.
>
> Ouvert le 2026-07-21 · Détaille l'entrée `TODOS.md` **FEAT-REGLE-DELETE1 (P2)**
> (ligne 3794) — ne la duplique pas. Effort M. Gardien : Front + Server.

---

## 1. Problème

Aujourd'hui `/regles` n'offre qu'un **archivage** (`is_active=false`). Archiver stoppe
les futurs matches — `appliquerRegles` ne charge que les actives
(`regles-categorisation.ts:393`) — mais **laisse en place les splits déjà posés**.

Constaté en démo : une règle « VAT → Loyer » a catégorisé ~479 transactions à tort ;
les archiver ne les a pas décatégorisées. L'utilisateur reste avec une ventilation
fausse et aucun moyen de la défaire en masse.

Deux manques :
- **(a)** une vraie suppression de règle, en plus de l'archivage ;
- **(b)** au moment de l'archivage **ou** de la suppression, le choix de
  **décatégoriser** (ou conserver) les transactions que cette règle a catégorisées.

---

## 2. Constats de terrain (vérifiés dans le code — à ne pas re-dériver)

### C1 — Faisabilité : aucun changement de schéma, aucune migration

`transaction_categorizations.rule_id` existe (`src/server/db/schema.ts:624`) et le CHECK
`txn_categorizations_source_rule_coherence` (`schema.ts:656-659`) garantit
`RULE ⟺ rule_id NOT NULL` / `MANUAL ⟺ rule_id NULL`.

Donc « défaire exactement ce que CETTE règle a posé » se réduit à
`DELETE FROM transaction_categorizations WHERE rule_id = $1` borné workspace —
**zéro risque pour les splits MANUAL** (leur `rule_id` est NULL par contrainte, ils ne
peuvent pas matcher).

### C2 — La table n'est PAS append-only au DELETE : le DELETE chirurgical est légitime

Vérifié dans `drizzle/provisioning/tygr_app.sql` :
- la liste blanche DELETE (étape 5, lignes 137-153) contient **`categorization_rules`**
  (ligne 145) **et `transaction_categorizations`** (ligne 146), documentées comme
  éditables / non append-only (lignes 75-80) ;
- les tables interdites de DELETE sont énumérées lignes 113-116 :
  `transactions_cache` (+ partitions), `balance_history`, `categorization_audit`.

Le schéma confirme la même intention côté Drizzle (`schema.ts:718-728` : « Config de
WORKSPACE, éditable / archivable, NON append-only → DELETE en liste blanche »).

**Conséquence : ni migration, ni changement de provisioning.** Le lot A n'ajoute aucune
DDL. C'est ce qui rend ce chantier petit.

### C3 — ⚠️ Correction du brief : il n'y a **AUCUNE FK** `rule_id → categorization_rules`

`schema.ts:624` déclare `ruleId: uuid("rule_id")` **sans `.references()`**, et la liste
de contraintes (`schema.ts:635-672`) ne comporte que : FK composite vers
`transactions_cache`, FK composite vers `categories`, les CHECK, deux index, la policy.

La question du brief (« une règle supprimée dont des splits subsistent créerait-elle une
FK orpheline — quel `ON DELETE` ? ») a donc une réponse **négative mais piégeuse** :

- **Pas de contrainte** → le DELETE d'une règle ne sera **ni bloqué, ni cascadé**. Aucun
  `ON DELETE` à choisir : il n'y a rien à paramétrer.
- **Mais orphelin LOGIQUE** : un split `source='RULE'` dont le `rule_id` ne désigne plus
  rien reste **parfaitement valide** au regard du CHECK (qui n'exige que `NOT NULL`).
  L'invariant « ce split vient de la règle X » devient **inobservable et silencieux** :
  la provenance ment sans qu'aucune garde ne se déclenche.
- Pire : `rule_id` n'étant contraint par rien, **deux tenants peuvent porter le même
  uuid** en `rule_id`. Toute requête de masse sur `rule_id` DOIT donc être bornée
  workspace explicitement, en plus de la RLS (défense en profondeur, cf. §6).

**Décision D1 (ci-dessous) découle directement de C3** : puisque la base ne peut pas
empêcher l'orphelin, c'est l'**ordre d'opérations applicatif** qui doit l'empêcher, de
façon fail-closed.

### C4 — ⚠️ Correction du brief : rien à « recalculer » sur `transactions_cache`

Le brief demande : « une transaction qui perd son dernier split RULE doit voir son
`primary_category` / marqueur auto recalculé (`transactions_cache_auto_source_coherence`) ».
**Cette prémisse est fausse et l'appliquer serait une violation.**

- `primary_category`, `is_auto_categorized` et `category_source` décrivent la
  classification **AMONT Omni-FI**, pas la ventilation TYGR (`schema.ts:436`, `458-467` :
  « la catégorisation manuelle TYGR vit dans les splits `transaction_categorizations`,
  table à part »).
- Le CHECK `transactions_cache_auto_source_coherence` (`schema.ts:500-503`) lie
  `is_auto_categorized ↔ category_source` — **deux colonnes amont**. Supprimer un split
  ne peut pas le violer : il ne touche ni l'une ni l'autre.
- `transactions_cache` est **READ-ONLY pour la catégorisation** (`schema.ts:607`,
  `categorisation.ts:9`). Vérifié : le seul module qui fait `update(transactionsCache)`
  est `src/server/repositories/ingestion.ts`. Ni `categorisation.ts` ni
  `regles-categorisation.ts` n'y écrivent.

**Ce qu'il faut vraiment traiter, à la place :** le « statut de ventilation » est
**dérivé à la volée**, jamais stocké. `aggregatVentilation()`
(`src/server/repositories/transactions.ts:550-563`) agrège les splits et est joint en
**LEFT JOIN** (`transactions.ts:454`). Quand le dernier split d'une transaction
disparaît, la jointure cesse de matcher et la transaction **redevient « non ventilée »
d'elle-même**. Il n'y a **aucun recalcul à écrire** — seulement une invalidation de
cache Next (§5.4).

→ **Écrire dans `transactions_cache` ici serait un défaut de revue.** Le lot A
l'interdit explicitement.

### C5 — ⚠️ Mensonge d'interface déjà en place (cause de la surprise en démo)

Le bouton de la liste s'appelle **déjà « Supprimer »** (`regles-list.tsx:239`) mais
appelle `archiverRegleAction` (`regles-feature.tsx:122`). Le commentaire d'en-tête
l'assume : « "Supprimer" (= archiver) » (`regles-list.tsx:14`).

De plus, **aucune confirmation** n'est demandée : `supprimer()`
(`regles-feature.tsx:116-134`) part directement au serveur.

L'utilisateur clique « Supprimer », la règle disparaît de la liste active, et 479 splits
restent. L'écart mot/effet **est** le défaut ressenti. Le corriger est un préalable
(lot 0), pas un raffinement.

### C6 — Concurrence : décatégoriser sans archiver d'abord est un no-op différé

`appliquerRegles` sélectionne les transactions **sans aucun split** (`NOT EXISTS`,
`regles-categorisation.ts:406-410`). Donc une transaction fraîchement décatégorisée
**redevient candidate**. Si la règle est encore active, le prochain déclenchement la
re-catégorise **à l'identique**.

Les déclencheurs sont réels et non contrôlés par l'utilisateur :
- « Ré-analyser » manuel (`appliquerReglesAction`, `actions.ts:205`) ;
- **post-sync automatique** : l'orchestrateur d'ingestion appelle `appliquerRegles`
  (`src/server/ingestion/orchestrateur.ts:33,203`).

→ **L'ordre `désactiver la règle` PUIS `décatégoriser`, dans la MÊME transaction, est
non négociable** (§5.1). C'est une contrainte de correction, pas de confort.

### C7 — Le moteur ne fait que `contains | starts_with` : cause racine du « VAT → Loyer »

`ruleMatchTypeSchema` (`src/lib/regles-schema.ts:14`) et le CHECK SQL
(`schema.ts:767-770`) n'admettent que ces deux stratégies. Le match est un `ILIKE`
`'%' || motif || '%'` (`regles-categorisation.ts:472-475`).

Un motif court en `contains` matche donc **au milieu des mots** : « VAT » matche
`ADVANTAGE`, `PRIVATE`, `CULTIVATE`, `VATEL`… C'est structurellement dangereux et c'est
ce qui a produit les 479 faux positifs. Traité au lot D.

### C8 — Isolation : `transaction_categorizations` porte une policy `account_scope`

`drizzle/migrations/0017_account-scope-filles-l5.sql:323` pose
`CREATE POLICY "account_scope" ON "transaction_categorizations" AS RESTRICTIVE FOR ALL`.

**RESTRICTIVE FOR ALL** ⇒ elle borne aussi le **DELETE**. Sous une session dont le GUC
de périmètre est non vide, un `DELETE ... WHERE rule_id = $1` ne supprimerait que les
splits **du périmètre visible** — alors que la règle, elle, est **workspace-global**
(`schema.ts:726-727` : « pas de scope entité : une règle vit au niveau workspace »).

C'est le piège central de ce chantier (§6.2) : décompte et suppression seraient
*mutuellement cohérents* mais **tous deux faux** vis-à-vis de la portée réelle de la
règle. Une décatégorisation partielle silencieuse est le pire résultat possible : elle
laisse la moitié du dégât en place en affichant « terminé ».

---

## 3. Périmètre

**Dans le périmètre**
1. Vraie suppression d'une règle (DELETE physique), en plus de l'archivage.
2. Décatégorisation optionnelle du périmètre d'une règle, offerte à l'archivage **et** à
   la suppression.
3. Décompte des transactions impactées **avant** l'action (aperçu honnête).
4. Correction du libellé « Supprimer » (= archiver) → lot 0.
5. Précaution moteur : match mot-entier (lot D).

**Hors périmètre** (→ TODOS si le besoin se confirme)
- Annulation / restauration d'une décatégorisation (« undo »). L'audit trace, il ne
  rejoue pas.
- Décatégorisation sélective (par compte, par période, par sous-ensemble). Le périmètre
  d'une règle est traité en bloc.
- Refonte de l'écran `/regles`.
- Exploitation des métadonnées de classification amont (`GAP-CATEG-NATIVE1`).

---

## 4. Décisions

### D1 — Suppression = DELETE physique, **fail-closed** s'il reste des splits

**Retenu.** `supprimerRegle` refuse (`RULE_HAS_SPLITS`) tant que des splits portent son
`rule_id`. Pour supprimer une règle « productive », l'utilisateur doit passer par la
décatégorisation (offerte dans la même modale, §5.3).

*Pourquoi* : C3 montre que la base ne peut pas garantir l'intégrité référentielle de
`rule_id`. Une suppression permissive fabriquerait des splits `source='RULE'` à
provenance morte — invisibles, jamais rattrapables, et **indiscernables** d'un split
légitime. Le fail-closed déplace l'invariant de la base vers l'application, seul endroit
où il peut encore vivre.

*Écarté — cascade implicite* (supprimer la règle efface ses splits) : une suppression
qui détruit 479 lignes de donnée métier sans que l'utilisateur ait dit « oui » à ça
précisément est un piège. Le choix doit être **explicite**, jamais un effet de bord.

*Écarté — ajouter une vraie FK `rule_id → categorization_rules`* : c'est la solution
propre à long terme, mais elle exige une migration + le nettoyage des `rule_id`
potentiellement déjà orphelins en base, et elle déborde de FEAT-REGLE-DELETE1.
→ **TODOS `REGLE-FK-RULEID1` (P2)**, déclencheur : prochaine migration touchant
`transaction_categorizations`.

### D2 — La décatégorisation est une opération **à part**, offerte aux deux chemins

**Retenu.** `decategoriserPerimetreRegle(ruleId)` est une fonction autonome, appelable :
- à l'archivage (« archiver **et** décatégoriser ») ;
- avant la suppression (« supprimer **et** décatégoriser ») ;
- seule (rattrapage sur une règle déjà archivée — le cas de la démo).

*Pourquoi* : les règles déjà archivées à tort existent **déjà** en base. Une conception
qui ne traiterait la décatégorisation qu'au moment de l'archivage les laisserait
définitivement orphelines.

### D3 — Audit : un événement `DELETE` par split, **en une seule instruction**

**Retenu.** Chaque split décatégorisé produit sa ligne `categorization_audit` — la table
est append-only stricte (`schema.ts:675-681`, REVOKE UPDATE/DELETE `tygr_app.sql:179-183`)
et c'est précisément le registre qui doit garder trace d'une correction de masse.

**Mais interdiction de boucler sur `supprimerSplit`** (`categorisation.ts:229-257`) :
elle fait un DELETE + un `ecrireAudit` qui lui-même fait un SELECT catégorie + un INSERT.
Sur 479 splits ⇒ **~1900 allers-retours SQL** dans une seule transaction. Risque de
timeout réel, et la transaction porte un verrou pendant tout ce temps.

→ **Forme imposée : set-based, deux instructions.**
1. `DELETE FROM transaction_categorizations WHERE rule_id = $1 AND workspace_id = $2
   RETURNING transaction_id, transaction_date, category_id, amount, source`
2. `INSERT INTO categorization_audit (...) SELECT ... FROM <résultat>` joint à
   `categories` pour le snapshot `category_name`, en **un seul** INSERT.

L'audit doit rester **sémantiquement identique** à celui de `supprimerSplit` (mêmes
colonnes, `action='DELETE'`, `actor_id = ctx.userId`) : c'est le même événement métier,
seule la forme d'exécution change. La revue vérifiera cette équivalence colonne par
colonne.

*Note* : `ecrireAudit` reste la source unique pour l'unitaire. Le chemin de masse est une
**seconde** implémentation du même contrat — divergence à surveiller (cf. critères §8).

### D4 — Décompte **avant** l'action, sous le **même** périmètre que l'action

**Retenu.** La modale affiche « N transactions seront décatégorisées » **avant**
confirmation, obtenu par un `COUNT` sur `rule_id`, borné workspace, **dans le même
contexte de session** que le DELETE qui suivra (§6.2). Index disponible : le COUNT et le
DELETE filtrent sur `rule_id`, non indexé aujourd'hui — cf. §7 (volumétrie).

Le compte est **indicatif, jamais contractuel** : entre l'aperçu et la confirmation, un
sync a pu poser de nouveaux splits. Le résultat renvoyé après l'action est le **nombre
réellement supprimé** (`RETURNING`), et c'est **lui** qui est affiché en confirmation.
Ne jamais ré-afficher le compte pré-calculé comme s'il était le résultat.

### D5 — Match mot-entier : **nouvelle** stratégie `word`, `contains` inchangé

**Retenu.** Ajouter `word` à `ruleMatchTypeSchema` et au CHECK SQL, implémenté par un
`~*` sur `\m<motif échappé>\M` (bornes de mot PostgreSQL).

*Pourquoi ne pas corriger `contains`* : des règles `contains` légitimes existent en base
(fragments de libellé bancaire, références partielles). Changer leur sémantique en place
modifierait silencieusement le comportement de règles que l'utilisateur n'a pas touchées
— exactement le mode de défaillance qu'on corrige.

*Complément UI, non bloquant* : avertir à la création quand un motif `contains` fait
**moins de 4 caractères** (« "VAT" peut matcher au milieu d'un mot — préférez "mot
entier" »). Avertissement, jamais un blocage : « EDF » est un motif court légitime.

⚠️ **`word` exige un échappement distinct de `echapperLike`** (`regles-categorisation.ts:356`) :
les méta-caractères d'une **regex** ne sont pas ceux de LIKE. Un motif « 50 % (net) »
deviendrait une regex invalide → erreur SQL à l'exécution. Fonction d'échappement
dédiée + test aux bornes exigés.

---

## 5. Conception

### 5.1 Ordre d'opérations (non négociable)

Tout se déroule **dans la transaction `withWorkspace` courante** (atomique, C6) :

```
1. Garde de rôle           → peutModifier(ctx.role), AVANT toute lecture (anti-oracle)
2. Garde de périmètre      → GUC de périmètre vide, sinon fail-closed (§6.2)
3. Verrou sur la règle     → SELECT ... FOR UPDATE (sérialise deux opérations concurrentes)
4. is_active = false       → la règle cesse de matcher (AVANT la décatégorisation, C6)
5. DELETE des splits       → ... WHERE rule_id AND workspace_id, RETURNING (D3)
6. INSERT audit en masse   → un DELETE par split supprimé (D3)
7. [si suppression] DELETE de la règle → 0 split restant garanti par 5 (D1)
```

**L'inversion de 4 et 5 est un bug**, pas un détail de style : entre le DELETE des splits
et le COMMIT, une ré-analyse concurrente verrait des transactions « sans split » et une
règle encore active, et les re-catégoriserait. Le verrou (3) sérialise contre une autre
opération *sur la règle*, il ne protège pas contre `appliquerRegles` (qui verrouille les
lignes `transactions_cache`, pas la règle). Seul l'ordre 4→5 ferme la fenêtre.

### 5.2 Surface serveur

**Repository** `src/server/repositories/regles-categorisation.ts` :

| Fonction | Rôle |
|---|---|
| `compterPerimetreRegle(tx, ctx, ruleId)` | `COUNT` des splits `rule_id`, borné workspace. Lève `RegleIntrouvableError` si la règle n'existe pas dans le tenant. |
| `decategoriserPerimetreRegle(tx, ctx, ruleId)` | Étapes 3→6 de §5.1. Retourne `{ splitsSupprimes: number }`. |
| `supprimerRegle(tx, ctx, ruleId)` | DELETE physique. Lève `RegleAvecSplitsError` si des splits subsistent (D1). |
| `archiverRegle` | **inchangé** (`regles-categorisation.ts:230`). |

**Erreurs nommées** (règle 3 — chaque erreur a un code machine) :

| Erreur | Code | Message UI |
|---|---|---|
| `RegleIntrouvableError` *(existe déjà, `:65`)* | `RULE_NOT_FOUND` | « Règle introuvable. » |
| `RegleNonAutoriseeError` *(existe déjà, `:80`)* | `FORBIDDEN_ROLE` | « Action réservée aux gestionnaires. » |
| `RegleAvecSplitsError` *(nouvelle)* | `RULE_HAS_SPLITS` | « Cette règle a catégorisé des transactions. Décatégorisez-les d'abord. » |
| `PerimetreReduitError` *(nouvelle)* | `SCOPE_TOO_NARROW` | « Opération réservée à la vision globale. » |

**Server Actions** `src/app/(workspace)/regles/actions.ts` — trois ajouts, calqués sur
l'existant (`exigerSessionSansPerimetre` + `withWorkspace` + mapping `echec()`) :
`compterPerimetreRegleAction`, `decategoriserPerimetreRegleAction`, `supprimerRegleAction`.

**Zod** `src/lib/regles-schema.ts` — réutiliser la forme d'`archiverRegleSchema`
(`:59-61`, `.strict()` + uuid). `decategoriserRegleSchema` porte `{ ruleId, archiver?:
boolean }`. Ajouter `"word"` à `ruleMatchTypeSchema` (D5).

### 5.3 UX — modale de confirmation

Aujourd'hui : **aucune confirmation** (C5). Cible : une modale unique, dont le contenu
dépend du décompte, obtenu **avant** ouverture.

```
┌─────────────────────────────────────────────────┐
│  Supprimer la règle « contient VAT → Loyer » ?   │
│                                                  │
│  Cette règle a catégorisé 479 transactions.      │
│                                                  │
│  ( ) Conserver ces catégorisations               │
│  (•) Décatégoriser ces 479 transactions          │
│      Elles redeviendront non catégorisées.       │
│      Action irréversible.                        │
│                                                  │
│              [ Annuler ]  [ Supprimer la règle ] │
└─────────────────────────────────────────────────┘
```

- **Décompte AVANT confirmation** (D4), jamais après. Un décompte nul supprime le bloc
  de choix : la modale devient une confirmation simple.
- **Défaut = décatégoriser** quand le décompte est non nul : c'est l'intention réelle
  derrière « je supprime cette règle, elle est fausse ». Conserver reste à un clic.
- **Montants et compteurs** : `tabular-nums` ; formatage via `src/lib/format-montant.ts`
  uniquement — jamais de formateur local (CLAUDE.md, formatage figé 2026-06-22).
- **Erreur ≠ sortie** : tout échec porte fond `danger-bg` + icône + message + `role="alert"`.
  Le rouge sémantique reste réservé aux montants `outflow`.
- **Tokens uniquement**, aucune couleur en dur. Réutiliser `StateCard` /
  `states/primitives.tsx` — pas de carte ad-hoc.
- **Échap ferme la modale** ; focus piégé ; assertions QA sur `[role=dialog]`.
- Route de démo `src/app/demo/regles-states/` (existe déjà) : y exposer les états
  `décompte nul`, `décompte élevé`, `en cours`, `erreur` pour le Visual QA (Gate 4).

### 5.4 Invalidation des agrégats

- **En base : rien à faire.** C4 — le statut de ventilation est dérivé à la volée par
  `aggregatVentilation()` ; aucun agrégat n'est matérialisé.
- **Effet perf : favorable, pas défavorable.** `aggregatVentilation()`
  (`transactions.ts:550-563`) agrège **tous** les splits du workspace, sans borne de
  période, avant la jointure. Retirer 479 splits **réduit** son coût. La régression de
  perf connue de `/transactions` n'est pas aggravée par ce chantier ; elle reste traitée
  ailleurs.
- **Cache Next : à invalider.** Après une décatégorisation, `revalidatePath` sur
  `/transactions` **et** `/dashboard` (les deux lisent la ventilation). L'oublier
  laisserait l'utilisateur devant des chiffres périmés juste après avoir confirmé — le
  défaut serait attribué à la décatégorisation elle-même.
  ⚠️ `/regles` n'est pas cachée (`regles/page.tsx:11`) : ne pas la revalider inutilement.

---

## 6. Isolation & sécurité (règle 2, exit-criteria règle 3)

### 6.1 Tenancy

- Tout passe par `withWorkspace` ; `workspace_id` vient de `ctx`, **jamais** du client.
- COUNT et DELETE bornés `rule_id = $1 AND workspace_id = ctx.workspaceId` — **explicitement**,
  en plus de la RLS. C3 le rend obligatoire : `rule_id` n'étant contraint par aucune FK,
  deux tenants peuvent légalement porter le même uuid.
- Règle d'un autre tenant → **`RULE_NOT_FOUND` (404)**, jamais 403 : pas d'oracle
  d'existence. Le pattern existe déjà (`regles-categorisation.ts:222,247`).
- Paramètres liés uniquement — aucune interpolation de `ruleId` ni de motif.
- Logs : `{ evt, action, workspaceId, code, splitsSupprimes }`. **Jamais** le motif ni un
  libellé bancaire (règle 8). Le format de `echec()` (`actions.ts:113-115`) est la référence.

### 6.2 ⚠️ Le piège central : périmètre réduit ⇒ décatégorisation partielle silencieuse

C8 : `transaction_categorizations` porte `account_scope` **RESTRICTIVE FOR ALL** → le
DELETE est borné par le périmètre. Or la règle est workspace-global.

`exigerSessionSansPerimetre` (déjà utilisé par toutes les écritures `/regles`,
`actions.ts:31`) ampute le **viewFilter** — un choix de *vue*. Il **n'ampute pas les
droits durs** (`entity_scope` / `account_scope` issus du contexte membre). Un membre
scopé garderait donc ses bornes : COUNT et DELETE seraient cohérents entre eux et
**faux** tous les deux. L'utilisateur lirait « 12 transactions décatégorisées » là où la
règle en a sali 479, et repartirait convaincu que c'est réglé.

**Décision : fail-closed.** `decategoriserPerimetreRegle` **refuse de s'exécuter** si le
GUC de périmètre est non vide → `SCOPE_TOO_NARROW`. L'opération est réservée à la vision
globale.

*Pourquoi refuser plutôt qu'avertir* : un avertissement laisse l'action se produire à
moitié. Or l'état « à moitié décatégorisé » est **indiscernable** de l'état « rien à
faire » sans re-compter hors périmètre — ce que l'utilisateur scopé ne peut pas faire.
Mieux vaut ne rien faire bruyamment.

*À vérifier au lot A* : la mécanique exacte de lecture du GUC de périmètre dans
`src/server/db/tenancy.ts` (nom, forme CSV, valeur « vide »). Si le contexte n'expose pas
cette information de façon fiable, **STOP + question** — ne pas approximer une garde
d'isolation (règle 7 ; dette d'isolation INTERDITE, règle 9).

### 6.3 Cas à ajouter à la suite d'isolation IDOR (bloquante en CI)

Fichier : `tests/isolation/regles-categorisation.test.ts` (existe).

1. **Cross-tenant sur la règle** — tenant B tente `supprimerRegle(ruleId de A)` →
   `RULE_NOT_FOUND`, règle de A **intacte**.
2. **Cross-tenant sur les splits, même `rule_id`** — A et B portent des splits avec le
   **même uuid** en `rule_id` (légal, C3). B décatégorise → **seuls** les splits de B
   partent ; le compte de A est inchangé. *C'est le test qui prouve la borne workspace.*
3. **MANUAL épargné** — une transaction ventilée à la main (`rule_id` NULL) sur un compte
   matché par la règle survit intacte à la décatégorisation.
4. **Fail-closed périmètre** — sous un GUC de périmètre non vide →
   `SCOPE_TOO_NARROW`, **zéro** split supprimé.
5. **Fail-closed suppression** — `supprimerRegle` sur une règle à splits →
   `RULE_HAS_SPLITS`, règle **et** splits intacts.
6. **VIEWER** → `FORBIDDEN_ROLE` avant toute lecture (anti-oracle : le VIEWER n'apprend
   pas si la règle existe).
7. **Audit complet** — N splits supprimés ⇒ exactement N lignes `categorization_audit`
   `action='DELETE'`, avec le bon `actor_id` et le snapshot `category_name`.
8. **Append-only préservé** — aucune écriture sur `transactions_cache` pendant
   l'opération (C4). Se prouve : `updated_at` / contenu inchangés sur les transactions
   touchées.

**Protocole de mutation obligatoire** (fixtures qui prouvent, cf. pièges connus) :
- **Cardinalités distinctes** entre A et B (ex. 3 splits chez A, 7 chez B). Des
  cardinalités égales rendent un test vert alors que la mauvaise clause mord.
- Pour le cas 2, **muter** la clause `workspace_id` du DELETE et vérifier que le test
  **rougit**. Une garde jamais vue échouer n'est pas une garde.
- Commiter **avant** de muter, pour ne pas laisser la mutation dans l'arbre.

---

## 7. Volumétrie, concurrence, idempotence

- **Volumétrie** : 479 splits est le cas observé ; dimensionner pour ~10⁴. La forme
  set-based (D3) rend le coût indépendant du nombre de lignes en nombre d'allers-retours
  (2 instructions), mais pas en temps SQL.
- **Index** : `rule_id` **n'est pas indexé** (`schema.ts:660-670` : les deux index portent
  sur `(workspace_id, transaction_id, transaction_date)` et `(workspace_id, category_id)`).
  COUNT et DELETE feront donc un scan. Acceptable au volume actuel ; à mesurer au lot A.
  Si le seuil gêne → index `(workspace_id, rule_id)` **partiel** sur `rule_id IS NOT NULL`,
  en migration séparée. **Ne pas l'ajouter par précaution** : un index non justifié par une
  mesure est de la dette.
- **Concurrence — verrou** : `SELECT ... FOR UPDATE` sur la ligne `categorization_rules`
  sérialise deux opérations concurrentes *sur la même règle*.
- **Concurrence — sync pendant l'opération** : couverte par l'ordre 4→5 (§5.1). Un sync
  qui démarre **après** le COMMIT verra la règle inactive et ne reposera rien. Un sync
  **en cours** est sérialisé par les verrous `transactions_cache` d'`appliquerRegles`.
  → *Cas limite à documenter au lot A* : un `appliquerRegles` ayant **déjà** lu ses
  candidats et ses règles actives avant notre COMMIT peut poser quelques splits juste
  après. Fenêtre étroite, conséquence bénigne (quelques splits à re-décatégoriser),
  **et rattrapable** : `decategoriserPerimetreRegle` est ré-exécutable seule (D2).
  À accepter explicitement, pas à ignorer.
- **Idempotence** : ré-exécuter la décatégorisation sur une règle déjà traitée supprime 0
  split, écrit 0 audit, retourne `{ splitsSupprimes: 0 }` — succès, pas erreur.
- **Montants** : `amount` transite en **chaîne décimale** du `RETURNING` vers l'audit.
  Jamais de `parseFloat`, jamais de conversion TS (règle 8). Idéalement il ne quitte pas
  SQL du tout (INSERT ... SELECT).

---

## 8. Critères de sortie (mesurables)

**Fonctionnels**
- [ ] Depuis `/regles`, supprimer une règle **sans** splits → elle disparaît de la base.
- [ ] Supprimer une règle **avec** splits sans décatégoriser → `RULE_HAS_SPLITS`, rien n'est
      touché.
- [ ] Archiver **ou** supprimer avec décatégorisation → les N transactions redeviennent
      non catégorisées, vérifié sur `/transactions` (filtre « non ventilées »).
- [ ] Décatégoriser une règle **déjà archivée** fonctionne (cas de la démo).
- [ ] La modale affiche le décompte **avant** confirmation ; la confirmation affiche le
      nombre **réellement** supprimé.
- [ ] Une règle `word` avec le motif « VAT » ne matche **pas** « ADVANTAGE ».

**Isolation (bloquant CI)**
- [ ] Les 8 cas de §6.3 passent dans `tests/isolation/regles-categorisation.test.ts`.
- [ ] Le cas 2 **rougit** quand on mute la clause `workspace_id` (mutation-check exécuté,
      résultat consigné dans la PR).
- [ ] Aucune écriture sur `transactions_cache` (C4) — prouvé par le cas 8.

**Qualité (règles 3 & 5)**
- [ ] Zod strict sur les 3 nouvelles actions ; entrée invalide → `INVALID_PARAMS`.
- [ ] Les 4 codes d'erreur (§5.2) sont mappés à un message UI ; aucun catch-all silencieux.
- [ ] Tests : chemin heureux + chemin d'échec spécifique + cas limite (0 split, règle
      inexistante, VIEWER, périmètre réduit).
- [ ] Logs structurés `workspace_id` + code, **sans** motif ni libellé bancaire.
- [ ] `lint`, `typecheck`, `build` verts. Suite d'isolation verte.
- [ ] **Équivalence d'audit** : une décatégorisation set-based de 1 split produit une ligne
      `categorization_audit` **identique** (colonne par colonne) à celle produite par
      `supprimerSplit` sur le même split. Vérifié par test, pas par lecture.

**Visual QA (Gate 4)**
- [ ] Captures headless des 4 états de la modale (décompte nul / élevé / en cours / erreur)
      comparées **par vision** à `docs/UI_GUIDELINES.md`.
- [ ] Mesures faites sur `/(workspace)/regles`, **jamais** sur `/demo/*` (la route de démo
      n'a pas la sidebar — les mesures y sont fausses).
- [ ] Échap ferme la modale ; focus visible ; assertions sur `[role=dialog]`.

---

## 9. Lots

| Lot | Contenu | Dépend de | Effort |
|---|---|---|---|
| **0** | Renommer « Supprimer » → « Archiver » dans `regles-list.tsx` (+ commentaire `:14`, libellés `regles-feature.tsx`). Corrige C5 **immédiatement**. | — | XS |
| **A** | Repository : `compterPerimetreRegle`, `decategoriserPerimetreRegle`, `supprimerRegle` + 2 erreurs nommées + garde de périmètre (§6.2). Tests d'isolation (§6.3) **dans le même PR**. | 0 | M |
| **B** | Server Actions + schémas Zod + mapping d'erreurs + `revalidatePath`. | A | S |
| **C** | Modale de confirmation + décompte + Visual QA + états de démo. | B | M |
| **D** | Match `word` : Zod + CHECK SQL (migration) + échappement regex dédié + avertissement motif court. | indép. | S |

**Ordre recommandé : 0 → A → B → C**, puis D. Le lot 0 seul supprime déjà le mensonge
d'interface — c'est la moitié de la surprise ressentie en démo, pour un coût quasi nul.

Le lot D est **indépendant** et peut partir en parallèle : il ne touche ni le repository
de suppression ni l'UI de la modale. C'est le seul lot qui porte une **migration**
(CHECK `categorization_rules_match_type_check`, `schema.ts:767-770`) — donc le seul
soumis à l'expand-contract et à la compatibilité N-1.

---

## 10. Points ouverts (à trancher au lot A — STOP + question si bloquant)

1. **Lecture du GUC de périmètre** (§6.2) — forme exacte exposée par `tenancy.ts`. Si le
   contexte ne permet pas de décider « périmètre vide / non vide » de façon fiable,
   **STOP** : ne pas approximer une garde d'isolation.
2. **Décatégorisation d'une règle archivée depuis longtemps** — les catégories cibles
   peuvent avoir été archivées entre-temps. `ecrireAudit` résout le nom par un SELECT
   (`categorisation.ts:281-285`) : vérifier que la variante set-based conserve le même
   comportement (LEFT JOIN, `NULL` toléré — la colonne `category_name` est nullable,
   `schema.ts:694`). Un INNER JOIN perdrait des lignes d'audit **en silence**.
3. **Plafond de volumétrie** — faut-il refuser au-delà d'un seuil (ex. 50 000 splits) et
   basculer sur un traitement asynchrone Inngest ? À décider **sur mesure**, pas
   a priori.

---

## 11. Traçabilité

- `TODOS.md` **FEAT-REGLE-DELETE1 (P2)** (ligne 3794) — ce plan la détaille ; l'entrée
  reste le registre canonique.
- Nouvelle dette à ouvrir **si D1 est retenu** : **`REGLE-FK-RULEID1` (P2)** — ajouter une
  vraie FK `rule_id → categorization_rules` ; ouvert 2026-07-21, effort S, déclencheur :
  prochaine migration touchant `transaction_categorizations`.
- Dette existante voisine, non traitée ici : `REGLE-REORDER-CONCUR1` (P2, last-write-wins
  au réordonnancement, `regles-categorisation.ts:279-281`).
