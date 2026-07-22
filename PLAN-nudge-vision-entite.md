# PLAN — NUDGE-VISION-ENTITE1 : distinguer « hors périmètre » de « aucun compte »

> Phase 1 (CONCEPTION). Delta sur `PLAN-loader-sync-et-nudge-connexion.md`.
> Branche `fix/nudge-vision-entite`, basée sur `origin/main` = `015f8ba`.
> **Révision 2** — après cross-review indépendante (constats F1–F7). La révision 1
> affirmait un scénario « connexion orpheline + erreur silencieuse » qui n'existe pas :
> corrigé en §1.
> Statut : **EN ATTENTE D'ARBITRAGE D'ETIENNE** — le périmètre du ticket change (§1.3).

---

## 0. Le défaut structurel, vérifié

`dashboard-content.tsx:139` sort en `DashboardEmptyState` quand
`choisirEtatDashboard(donnees) === "vide"`, soit `comptes.length === 0`
(`src/lib/etat-dashboard.ts:25`). Le montage du nudge est 80 lignes plus bas
(`dashboard-content.tsx:219`) : dans cet état il n'est jamais atteint. Exact.

Mais **quel utilisateur atteint réellement cet écran**, et avec quelle attente ? C'est là
que le ticket se trompe.

## 1. Pushback (règle 10) — le ticket vise le mauvais scénario

### 1.1 Le scénario décrit par le ticket ne peut pas se produire

TODOS.md:67 pose comme « invariant **assumé** » que l'ingestion crée les comptes avec
`entity_id = NULL`, qui seraient masqués par `entity_scope` — laissant un membre scopé
devant un dashboard vide après avoir connecté sa banque. Vérifié : **cette connexion
échoue entièrement, avec une erreur affichée.**

- `upsertCompte` (`ingestion.ts:117-151`) n'écrit pas `entity_id` → INSERT à `NULL` ;
- `entity_scope` est RESTRICTIVE FOR ALL avec `WITH CHECK`
  (`0014_entity-write-scope-foral.sql:36`) → `NULL` n'est dans aucun scope → INSERT
  **rejeté** (prouvé : `tests/isolation/entites-isolation.test.ts:545-593`, test 14c) ;
- l'ingestion tourne bien avec le GUC d'entité actif : `exigerSessionSansPerimetre`
  (`session.ts:209-217`) n'ampute que le `viewFilter` ; le scope d'entité est un droit
  serveur re-résolu depuis `member_entity_scopes` (`tenancy.ts:269-278`) ;
- **mais** `persisterConnexionEtComptes` écrit connexion ET comptes dans **une seule**
  `db.transaction` (`orchestration.ts:334-395`, transaction ouverte `tenancy.ts:211`) →
  le rejet avorte la transaction → **ROLLBACK : la connexion n'est pas commitée non plus** ;
- et l'erreur n'est pas avalée : `reussies.length === 0` → `throw premiereErreur`
  (`orchestration.ts:1496-1499`) → mappée par l'action (`banques/actions.ts:266-271`) →
  affichée par le widget.

État réel après ce parcours : **0 connexion, 0 compte, erreur visible**. Donc
`aDesConnexionsTenant = false`, et le nouvel état ne se déclencherait même pas.

*(La révision 1 citait un fail-soft `orchestration.ts:1343-1350` : il appartient à
`synchroniserConnexionsDepuisOmnifi`, pas au chemin drop-in du ticket. Erreur d'analyse
corrigée.)*

### 1.2 Le volet « faire monter le nudge » devient sans objet

Le nudge post-connexion se déclenche sur `?connexion=etablie`, posé par la redirection du
widget après un parcours **réussi**. Pour un membre scopé, ce parcours ne réussit jamais
(§1.1) : il n'arrive donc jamais sur le dashboard avec ce drapeau et zéro compte.

Câbler le nudge dans le nouvel état écrirait du **code mort**, et — si un chemin l'y
amenait tout de même — inviterait à « lancer une première synchronisation », geste qui ne
peut pas rendre les comptes visibles (ils resteront non assignés). On ne monte donc **pas**
le nudge ici.

### 1.3 Le défaut RÉEL, lui, existe et n'a rien à voir avec le nudge

**S1 — un membre scopé arrive sur un tenant dont les comptes ne lui sont pas assignés.**
Un ADMIN (Vision Globale) connecte la banque → comptes créés `entity_id = NULL` → le
membre scopé ouvre le dashboard → `listerComptes` renvoie 0 ligne → il lit « Aucune banque
n'est encore connectée à cet espace », alors que l'espace en a une et qu'il la voit sur
`/banques` (`listerConnexionsBancaires`, `dashboard.ts:256`, non filtrée par entité).

C'est **ce** mensonge qu'il faut corriger : il ne dépend d'aucune connexion récente, il est
permanent tant que l'assignation n'est pas faite. Le ticket l'a diagnostiqué à travers le
nudge ; le nudge n'en est pas le remède.

→ **Cible retenue : rendre l'empty state honnête pour un lecteur scopé.** Le volet nudge
est retiré du lot.

## 2. Le signal (validé en cross-review, inchangé)

**`compterConnexionsTenant(tx)` — `count()` sur `bank_connections`.**

- `bank_connections` ne porte **que** `tenant_isolation` PERMISSIVE
  (`0003_epic3-financial-core.sql:91`) — vérifié exhaustivement sur les 23 migrations :
  aucune `entity_scope`, aucune `account_scope`, aucune clause `view_filter`. Le COUNT est
  borné au workspace **par la RLS elle-même** ;
- il ne lit pas `bank_accounts` : aucun contournement de l'étage 2 ;
- il n'expose qu'un **booléen dérivé** à l'UI. Un membre scopé voit déjà toutes les
  connexions du tenant sur `/banques` (route sans garde de rôle, `banques/page.tsx:31-51`,
  LEFT JOIN affichant `nbComptes = 0`) : **aucune information neuve n'est divulguée** ;
- calculé serveur dans le `withWorkspace` **existant** de `page.tsx:171` — ne jamais en
  ouvrir un second (piège d'auto-amputation L8b-1, documenté `page.tsx:209-212`).

*Alternatives écartées* : (a) vider temporairement `app.current_entity_scope` → contourne
l'étage 2, refusé (règle 2) ; (b) compter via `account_party_role`, qui porte
`bank_account_id` sans `entity_scope` ni `account_scope` (`0013:34-41`, `0013:71`) →
donnerait le nombre de comptes du tenant, mais divulgue davantage que le COUNT de
connexions. **(b) est un angle mort de l'étage 2 signalé en revue → à traiter dans son
propre lot** (cf. §7).

## 3. Le nouvel état

### 3.1 Garde de scope — la correction décisive (constat F2)

Le COUNT seul ne suffit pas : une connexion **commitée avec zéro compte** existe hors de
tout contexte d'entité — découverte vide, ou tous les comptes écartés par le filtre
`Status !== "Enabled"` (`orchestration.ts:384`), cas qui a **déjà vidé une synchro en
prod** (`orchestration.ts:378-383`) et que `dashboard.ts:221` documente. Un ADMIN seul, en
Vision Globale, sans aucune entité, tomberait alors sur « un administrateur doit rattacher
ces comptes à votre entité » : il **est** l'administrateur, et il n'y a rien à rattacher.

→ L'état n'est monté **que si le lecteur est réellement borné** : `estLecteurBorne(ctx)`
(`tenancy.ts`, fonction PARTAGÉE entre la page et la preuve — une copie de la formule dans
chacune rendrait le test tautologique). Ne lit pas `bank_accounts`, ne touche pas l'étage 2.

⚠️ **Ce qu'elle couvre, et ce qu'elle NE couvre PAS** (correction post-revue) : elle couvre
les deux axes de DROIT — `member_entity_scopes` et `user_scopes`. Elle **ne couvre pas le
`viewFilter`**, qui n'affecte ni l'un ni l'autre `mode` (`tenancy.ts:400-427` : il ne pose
qu'un GUC). Deux angles morts subsistent donc, tous deux ANTÉRIEURS à ce lot :
un lecteur non borné dont le `viewFilter` ne résout à rien relit l'empty trompeur ; un
lecteur borné dont l'intersection droit ∩ filtre est vide lit « un administrateur peut vous
donner accès » alors qu'il lui suffirait de vider son propre sélecteur. Ne pas s'appuyer sur
une couverture `viewFilter` inexistante dans un lot futur.

### 3.2 Sélection

`src/lib/etat-dashboard.ts` — 4e valeur, décidée **avant** `"vide"` :

```
comptes.length === 0 && lecteurBorne && aDesConnexionsTenant → "hors-perimetre"
comptes.length === 0                                          → "vide"
```

`DonneesDashboard` reçoit `aDesConnexionsTenant: boolean` et `lecteurBorne: boolean`.
`DashboardContent` : branche montée avant l'empty global, rendant `<ConsommerDrapeauConnexion/>`
(même raison qu'à la ligne 148) + `<DashboardHorsPerimetreState/>`. **Pas de nudge** (§1.2).

Le `if` en chaîne devient un `switch` exhaustif avec garde `never` (constat F5) : sans ça,
un état non traité laisse monter le dashboard complet avec `comptes = []` — en-tête
« 0 compte connecté », aucune pastille, écran dégradé silencieux.

### 3.3 Copy

- titre : « Aucun compte visible dans votre périmètre »
- message : « Cet espace a au moins une banque connectée, mais aucun de ses comptes n'est
  rattaché à votre périmètre. Un administrateur peut vous y donner accès. »
- CTA unique : « Voir les banques connectées » → `/banques` — honnête (la connexion y est
  listée) et soigne la contradiction.

Spécialisation d'`EmptyState` (`src/components/ui/states/empty-state.tsx`), comme
`DashboardEmptyState` : aucun markup de carte dupliqué, tokens sémantiques uniquement.
**Pas** un état d'erreur (§3.4 UI_GUIDELINES) : aucun `danger-bg`, aucun `role="alert"` —
ce n'est pas une panne.

## 4. Exit criteria (règle 3)

Aucune nouvelle route ni Server Action — une lecture de plus dans le `withWorkspace`
existant. Applicables :
- authz : hérite du `withWorkspace` de `page.tsx:171` (membership re-validée, RLS posée) ;
- pas d'entrée client → pas de zod ; le COUNT ne prend aucun paramètre ;
- erreurs : aucun `catch` ajouté — un échec DB remonte à `error.tsx` comme les autres
  lectures (pas de catch-all silencieux) ;
- **4 états d'affichage** : loading / vide / **hors-périmètre** / erreur / partiel-complet
  — l'état erreur reste exposé en démo (`demo/dashboard-states/page.tsx:29-36`) ;
- tests unitaires `tests/unit/etat-dashboard.test.ts` : les 4 états, la bascule
  `vide`↔`hors-perimetre` à comptes égaux, et **le cas F2** (lecteur non borné + connexion
  sans compte → `"vide"`, jamais `"hors-perimetre"`) ;
- **fichiers impactés par les 2 champs de `DonneesDashboard`** (constat F4 — sinon `tsc`
  rouge, règle 5) : `src/lib/dashboard-demo-fixtures.ts` (8 objets : l. 29, 222, 241, 261,
  286, 345, 399, 424), `src/app/demo/dashboard/page.tsx` (l. 67, 80, 107, 109, 121),
  `tests/unit/dashboard-demo-couverture-echelle.test.ts` (l. 51, 73).

## 5. Preuve de non-régression d'isolation

Ajout à `tests/isolation/` (pattern autonome : PGlite + migrations réelles + `set role
tygr_app`, cf. `entites-isolation.test.ts:48-172`) :

1. **Pas de fuite cross-tenant** : WS_B a des connexions ; le COUNT sous une session WS_A
   ne les compte pas (contre-preuve : ≠ total de la table).
2. **Le COUNT ne dépend pas du périmètre entité** : même valeur en Vision Globale et en
   Vision Entité pour un même workspace — prouve qu'il ne lit pas `bank_accounts`.
3. **Le COUNT ne démasque aucun compte** : sous Vision Entité, `listerComptes` renvoie
   toujours 0 ligne quand tous les comptes sont `entity_id = NULL`.
4. **Cas S1 de bout en bout** : connexion + comptes non assignés → session scopée →
   `comptes = []`, `aDesConnexionsTenant = true`, `lecteurBorne = true` → état
   `"hors-perimetre"`.
5. **Axe `account_scope`/`user_scopes`** (constat F7) : un membre borné **par compte**
   (`user_scopes`, `0015`/`0016`), ou dont le droit résout à ∅ (sentinelle UUID-nul,
   `tenancy.ts:366-373`), produit le même `comptes = []` → doit aussi donner
   `lecteurBorne = true`. Le modèle « `entity_scope` seul » de la révision 1 était périmé.

## 6. Visual QA (Gate 4)

`demo/dashboard-states/page.tsx` : onglet « hors-périmètre » à côté de « empty ». Captures
des deux états, comparées à `docs/UI_GUIDELINES.md` §4.4 (illustration outline, message
`text-muted`, un seul CTA) et §3.4 (ne doit pas ressembler à une erreur). QA sur
`next start` HTTP, jamais `next dev` (hydratation morte).

## 7. Découvertes adjacentes — hors périmètre, à arbitrer

1. **Un membre scopé ne peut pas connecter de banque du tout** (§1.1) : le parcours échoue
   par rejet RLS. C'est le fail-closed VOULU par CLAUDE.md (« un membre borné ne crée pas
   de comptes non-assignés »), mais l'utilisateur reçoit une erreur d'origine RLS là où il
   faudrait un refus nommé et intelligible (règle 3 : « chaque erreur a un nom »). Aucune
   garde applicative de périmètre n'existe en amont (`orchestration.ts:487` ne teste que
   `peutModifier`).
2. **`account_party_role` échappe à l'étage 2** (§2, alternative b) : elle porte
   `bank_account_id` sans `entity_scope` ni `account_scope` (`0013:71`, non couverte par
   `0017`). Angle mort d'isolation intra-groupe → relève de la dette **INTERDITE**
   (règle 9), donc d'un lot immédiat, pas d'une entrée TODOS.
