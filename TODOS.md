# TODOS — TYGR
Différés par la revue /autoplan du 2026-06-10 (plan v2.1 multi-tenant Workspace).
Décisions D2 (ré-priorisation UI, 2026-06-11) puis **D3 (annulation de D2, même
jour)** : voir le decision log du plan
(`~/.gstack/projects/tygr-app/clawdy-unknown-design-20260610-120713.md`).
### ⛔ NON-DETTE — à corriger, pas à consigner (règle 9 : l'isolation ne se met pas en dette)
- [x] **ENTITY-PARTIES-SCOPE1 — RÉSOLU le 2026-07-21** (migration `0024_account-party-role-scope.sql`,
  suite `tests/isolation/parties-scope-isolation.test.ts`, plan `PLAN-entity-parties-scope.md`).
  Policy `account_scope` RESTRICTIVE FOR ALL posée sur `account_party_role` (calque 0017,
  prédicat direct sur `bank_account_id`), 10 cas d'isolation + mutation-check 5 points.
  ⚠️ **Requalification à ne PAS rouvrir** : le constat conservé ci-dessous décrivait une
  fuite ; il n'y en avait AUCUNE d'active — les 4 chemins de lecture recensés étaient tous
  bornés, et l'absence de policy était une décision TRACÉE (`0017` bloc COEXISTENCE,
  `schema.ts:936-937`), pas un oubli. Ce qui manquait était la défense COMPLÉMENTAIRE en
  RLS derrière la convention `ENTITY-READ-JOIN1`. Le reliquat `parties` part en P2
  ci-dessous (décision D2 du plan). Constat d'origine conservé pour l'audit trail :
- [ ] ~~**ENTITY-PARTIES-SCOPE1 (chantier immédiat, effort ~0,5 j, ouvert 2026-07-21) —
  `account_party_role` échappe à l'ÉTAGE 2 d'isolation.**~~ **Quoi** : la table porte
  `bank_account_id` (`0013_parties-account-party-role.sql:34-41`) mais UNIQUEMENT la policy
  `tenant_isolation` (`0013:71`). Ni `entity_scope`, ni `account_scope` — `0017` a couvert
  `transactions_cache` (+ partitions), `balance_history`, `transaction_categorizations` et
  `categorization_audit`, mais PAS celle-ci. Vérifié par grep exhaustif sur
  `drizzle/migrations/*.sql`. **Mode de défaillance** : une lecture de cette table qui ne
  joint pas `bank_accounts` expose à un membre borné les identifiants de comptes hors de son
  périmètre, et les titulaires qui leur sont rattachés — fuite INTRA-GROUPE (l'étage 1 tient,
  ce n'est pas cross-client). C'est exactement le risque que la règle ENTITY-READ-JOIN1
  cherche à contenir côté repository, ici sans filet structurel derrière.
  **Pourquoi ce n'est PAS une entrée de dette** : CLAUDE.md règle 9 — « dette touchant
  l'isolation tenant : INTERDITE, ça se corrige ». Consigné ici seulement pour ne pas perdre
  le fil entre deux lots. **À faire** : (1) établir si un chemin de lecture applicatif
  l'atteint aujourd'hui sans jointure, (2) poser la policy manquante, (3) cas d'isolation
  dédié. Découvert en instruisant NUDGE-VISION-ENTITE1 ; lot séparé arbitré par Etienne le
  2026-07-21.
- [ ] **ENTITY-PARTIES-P2 (P2, effort ~0,25 j, ouvert 2026-07-21) — `parties` n'a pas de
  policy d'étage 2.** **Quoi** : `parties` porte `tenant_isolation` (`0013:70`) mais aucune
  policy de périmètre, alors que `schema.ts:1001-1002` annonçait qu'elle serait couverte par
  le lot L4 (`0016` ne l'a posée que sur `bank_accounts`) — c'est un écart plan↔livré, pas
  une décision. Deux lectures l'atteignent **sans aucune jointure** à `bank_accounts` :
  `entites.ts:605-624` (`listerPropositionsPartyEntite` étape 1) et `user-scopes.ts:224-233`.
  **Pourquoi P2 et pas un correctif immédiat** (décision D2 du plan, chaîne prouvée maillon
  par maillon) : les deux chemins sont ADMIN-only **strict** — `peutAdministrer` est
  `role === "ADMIN"` (`permissions.ts:19-21`), `exigerAdmin` throw hors ADMIN
  (`entites.ts:390-391`) — et un ADMIN ne peut pas devenir scopé : gardes
  `AdminNonScopableError` sur les deux axes (`entites.ts:1021-1024`, `user-scopes.ts:212-216`)
  ET **aucun chemin d'UPDATE de rôle n'existe dans l'application** (le seul write sur
  `workspace_members` est un INSERT `onConflictDoNothing`, `provisioning.ts:132-140`), donc le
  contournement classique « membre scopé **puis promu** ADMIN » n'est pas atteignable.
  Aucune fuite active, donc — le risque est théorique **aujourd'hui**.
  **Mode de défaillance le jour où ça bascule** : `entites.ts:612` surface les noms de TOUS
  les titulaires du groupe à un membre borné à une BU — donnée nominative, sans erreur ni
  test rouge. **Déclencheur de résolution (nommé, pas « un jour »)** : la **première surface
  titulaire ouverte à un rôle non-ADMIN** — ou tout relâchement d'une des deux gardes
  `AdminNonScopableError`. **À faire ce jour-là** : policy `account_scope` sur `parties` par
  `EXISTS` vers `account_party_role` (chaîne à 2 niveaux — attention au point dur « party
  sans aucun compte », invisible sous un EXISTS nu), **et INVERSER le cas 9** de
  `tests/isolation/parties-scope-isolation.test.ts`, qui est aujourd'hui la contre-preuve
  volontaire que `parties` reste visible hors périmètre.
  **Résidu assumé, tracé** : un ADMIN scopé **hérité** peut exister en base (`page.tsx:97` le
  documente — lignes antérieures à l'arbitrage 2026-07-13 ou insertion SQL directe). Pour lui,
  `entites.ts:612` montre tout le groupe. Ce n'est **pas** une fuite (un ADMIN a le droit de
  tout voir) mais une incohérence d'affichage.
  ⚠️ **Ne PAS traiter `user_scopes` « par symétrie »** : elle porte `bank_account_id`
  (`schema.ts:1032`) sans policy d'étage 2, et c'est **correct** — c'est la table de DROITS
  qui définit le périmètre ; la scoper par lui-même serait une auto-référence circulaire.
  Y poser une policy serait un défaut, pas un correctif (plan §2.3).

### Performance `/transactions` (2026-07-22, plan `PLAN-perf-ventilation-agg1.md`)

> ⚠️ **Trou de procédure à ne pas reproduire (règle 9)** : cette section a été créée le
> 2026-07-22, EN MÊME TEMPS que le correctif. La session de conception qui a produit le
> diagnostic avait rédigé un prompt d'implémentation (`PROMPT-impl-perf-ventilation-agg1.md`)
> renvoyant à une entrée `PERF-VENTILATION-AGG1` de ce fichier… qui n'a JAMAIS été écrite.
> Le brief citait même des numéros de ligne (74-142) pointant en réalité sur la section
> « Clarté du cycle de connexion ». Une dette qui ne vit que dans un prompt non suivi par
> git n'existe pas : elle n'est ni priorisée, ni revue en fin d'epic, et le prochain lot
> part sur des chiffres que personne ne peut recouper. **Le registre canonique est
> TODOS.md** — un diagnostic n'est acquis qu'une fois inscrit ICI.

- [x] **PERF-VENTILATION-AGG1 (P1, ouvert et RÉSOLU le 2026-07-22, effort ~0,5 j) — la
  liste `/transactions` mettait ~1,85 s côté base.** **Cause** : `aggregatVentilation()`
  était une table dérivée PRÉ-GROUPÉE sur toute `transaction_categorizations`, jointe en
  LEFT JOIN. Sous RLS, tous les prédicats passent par `current_setting(…)`, **opaque à
  l'estimateur** → `rows=1` estimé à chaque étage contre 9 440 réels → **Nested Loop Left
  Join** qui RESCANNE l'agrégat par ligne externe (`Rows Removed by Join Filter: 4 415 760`).
  Modèle de coût **O(N_transactions × N_splits)** : les deux axes grossissent en prod.
  **Résolution** (forme retenue, cf. plan §3) : (1) la page se résout d'abord dans une
  sous-requête dont le `LIMIT` sert de **barrière d'optimisation** (PostgreSQL n'aplatit
  jamais une sous-requête portant un LIMIT) ; (2) l'agrégat est calculé en
  `LEFT JOIN LATERAL` **corrélé** sur les ≤51 lignes de la page, par index
  (`txn_categorizations_workspace_txn_idx`) ; (3) `predicatStatut` — qui filtre AVANT la
  pagination et ne peut donc pas se borner à la page — passe en **sous-requêtes corrélées**.
  **Mesures APPARIÉES** (base locale, **9 440 tx / 510 splits**, sous `tygr_app` + GUC de
  `withWorkspace`, Vision Globale, page 1, `limit 51` ; 3 exécutions dos à dos sur le MÊME
  état de données) :

  | Chemin | Avant | Après | Plan après |
  |---|---|---|---|
  | dominant (sans filtre) | 1947 / 1933 / 1952 ms | **8,47 / 8,55 / 8,64 ms** (**227×**) | agrégat `loops=51`, Index Scan |
  | `?statut=NON_CATEGORISE` | ~1940 ms | **14,4 ms** | Anti Join + agrégat `loops=51` |
  | `?statut=COMPLET` | ~1940 ms | **14,5 ms** | sous-requêtes corrélées par index |

  **Équivalence de sortie PROUVÉE sur le jeu réel** (pas seulement sur la fixture PGlite) :
  les deux formes comparées sur les **9 440 lignes**, toutes colonnes dérivées incluses
  (`nb_splits`, `montant_ventile`, `statut`, `cat_dominante_id`, `cat_dominante_nom`) →
  **0 différence symétrique, 0 désaccord d'ordre**. Témoin de non-vacuité : 510 lignes
  COMPLET portant un agrégat réel. ⚠️ Ce jeu ne contient **aucune** ligne PARTIEL — ce
  chemin n'est donc couvert que par la fixture PGlite (`T_PART`), pas par cette
  comparaison. Note : la base locale est VIVANTE (480 → 510 splits pendant la session) ;
  toute re-mesure doit être appariée, sous peine de comparer deux états différents.

  ⚠️ **Le brief d'implémentation imposait une conception FAUSSE, réfutée à la mesure** :
  « CTE `WITH agg AS MATERIALIZED` → barrière d'optimisation → Hash Left Join → 7,9 ms ».
  Mesuré : **324 ms**. La matérialisation empêche le RECALCUL (agrégat bien en `loops=1`,
  1,0 ms) mais **ne choisit pas la méthode de jointure** — le planificateur garde un Nested
  Loop et rescanne la CTE (`Rows Removed by Join Filter: 4 530 720`). `enable_nestloop=off`
  agissait sur la méthode, pas sur la matérialisation ; les deux ont été confondus. Deuxième
  contre-épreuve : piloter la jointure « depuis le petit côté » (agrégat 480 lignes en tête)
  → le planificateur **réordonne** et retombe sur le rescan → **286 ms**. **Leçon
  transposable** : sous RLS, l'estimateur est aveugle ; la robustesse ne s'obtient pas en
  espérant un bon plan mais en écrivant une forme **non réordonnable** — une sous-requête
  corrélée s'évalue par ligne, par index, quoi que décide le planificateur.
  **Correction connexe livrée** : `predicatStatut(COMPLET)` ne testait pas `nb_splits > 0`
  là où `statutExpr` le fait. `amount` étant `numeric(15,2)` **sans contrainte de
  positivité**, une transaction à montant NUL et sans split satisfaisait `0 >= abs(0)` : le
  filtre « Complet » l'aurait capturée alors que la colonne affichait « Non catégorisé » —
  divergence LATENTE (aucune ligne à montant nul en base aujourd'hui, vérifié) que
  l'ancien code portait tout en documentant l'inverse. Garde `exists` ajouté.
  **Preuve** : `tests/isolation/transactions-statut-coherence-isolation.test.ts` (8 cas,
  mutation-check concluant — 3 tests tombent si l'on retire le garde).

- [ ] **PERF-KEYSET-INDEX-RLS1 (P2, effort ~0,5–1 j, ouvert 2026-07-22) — l'index couvrant
  de la pagination n'est JAMAIS emprunté, pour cause d'opacité RLS.** **Quoi** : sur la base
  locale (9 440 tx), la seule résolution de page — **sans aucune jointure ni agrégat** —
  coûte déjà **5,1 ms**, en `Seq Scan` sur la partition + `top-N heapsort` de toutes les
  lignes. L'index `transactions_cache_<part>_workspace_id_transaction_date_idx
  (workspace_id, transaction_date DESC NULLS LAST)` **existe** (vérifié) et n'est pas
  utilisé : le prédicat RLS `workspace_id = current_setting(…)` étant opaque, l'estimateur
  table sur `rows=5` et juge tout plan gratuit — donc jamais le parcours d'index ORDONNÉ qui
  s'arrêterait après 51 lignes. **Mode de défaillance** : le coût est **O(N)** en nombre de
  transactions du workspace, pas O(log N). Invisible à 9 440 lignes (5 ms), linéaire ensuite
  — à 500 000 lignes le chargement initial repasse en centaines de ms, et **aucun test ne le
  signalera** (les suites tournent sur PGlite, qui ne prouve pas les plans).
  **Pourquoi ce n'est PAS traité ici** : foyer DISTINCT de la ventilation — il concerne la
  résolution de page, pas l'agrégat ; le mêler à PERF-VENTILATION-AGG1 aurait été du scope
  creep sur la surface d'isolation (règle 7). Arbitré par Etienne le 2026-07-22.
  **Pistes** : `ALTER TABLE … ALTER COLUMN workspace_id SET STATISTICS`, ou une fonction
  `STABLE` encapsulant le GUC pour rendre le prédicat estimable, ou `pg_hint_plan`. À
  **mesurer**, pas à supposer. **Déclencheur** : le premier des deux — (a) le chemin
  `?statut=` doit descendre sous ~15 ms, (b) un workspace de production dépasse ~100 000
  transactions.

### Clarté du cycle de connexion — dettes ouvertes (2026-07-20, PR `feat/clarte-cycle-connexion-demo`, plan `PLAN-loader-sync-et-nudge-connexion.md`)
Version **démo-safe** des lots 2, « nom de banque » et 3 Option B du plan : nudge
post-connexion, banques nommées sur `/banques`, loader indéterminé honnête. Aucun
contrat de Server Action touché, aucune requête ajoutée.
- [ ] **SYNC-NOM-BANQUE-DASHBOARD1 (P2, effort ~0,5 j, 2026-07-20) — nommer aussi les
  banques dans les callouts du DASHBOARD.** Le lot ne nomme les banques que sur
  `/banques`, seul écran à disposer de la liste des connexions. `SyncSummary`
  (dashboard) reste donc sur « L'accès d'une ou plusieurs banques doit être rétabli. »
  **Pourquoi ce n'est pas fait ici** : `CompteConnecte` (données du dashboard) ne porte
  PAS de `connectionId` — seulement `institutionName` par COMPTE. Il n'existe donc
  aucune clé pour rapprocher `aReconnecter[].connectionId` d'un nom sur cet écran, et
  fabriquer la jointure demanderait soit d'ajouter la connexion au DTO des comptes, soit
  une seconde lecture. **Déclencheur** : le lot SYNC-GRANULARITE-BANQUE1 (cartes par
  connexion), qui apportera cette donnée au dashboard de toute façon. Atténuation
  actuelle : le callout pointe vers `/banques`, où les noms SONT affichés.

- [ ] **SYNC-LOADER-ETAPES1 (P2, effort ~2–3 j, 2026-07-20) — loader à ÉTAPES réelles
  (Option A du plan).** Le loader livré est indéterminé : il dit « ça travaille », pas
  « où on en est ». Un vrai stepper suppose que `synchroniserConnexionsAction` rende les
  `{connectionId, jobId}` **dès le 201** au lieu d'attendre `attendreFinSync`, puis que
  le client poll par connexion et dérive le palier via `machine-mfa.ts`. **Pourquoi
  différé** : ça change le contrat de l'action et touche le cœur de l'ingestion — hors
  d'un lot démo-safe à J-2. ~~**Bloquant préalable** : `SYNC-MACHINE-INTERRUPTED1`
  (ci-dessous) — sans lui, un job interrompu figerait le loader sur « Initialisation… ».~~
  **LEVÉ 2026-07-21** : `SYNC-MACHINE-INTERRUPTED1` est SUSPENDUE (prémisse réfutée,
  cf. ci-dessous) et ne bloque plus ce chantier. Ce qui reste vrai et à traiter DANS ce
  lot : le loader devra dériver son palier d'une union de statuts **OUVERTE**, avec un
  repli explicite pour l'inconnu (le serveur, lui, le rend déjà `INCOMPLET`).
  **Déclencheur** : post-démo, après l'anomalie cooldown.

- [ ] **WIDGET-REJET-TRANSPORT1 (P2, effort ~1 j, 2026-07-20) — un rejet réseau sort de
  l'écran au lieu d'être traité sur place.**

  ⚠️ **Cette entrée a été RÉÉCRITE le 2026-07-20** : sa première version décrivait un
  mode de défaillance FAUX (« widget fermé, aucun message », et une asymétrie entre les
  blocs qui ont un `try/finally` et les autres). Vérification en cross-review, dans la
  source de React 19 : un rejet dans `useTransition` est re-levé PENDANT LE RENDU
  (`trackUsedThenable`), donc il atteint bien une frontière d'erreur — et les QUATRE blocs
  `startFinalisation` se comportent identiquement (le `finally` ne rattrape rien, il
  relâche seulement un verrou). Une dette instruite sur une prémisse fausse est pire
  qu'aucune dette : elle envoie le prochain lot corriger un problème inexistant.

  **Le vrai défaut** : sur un rejet de TRANSPORT (Wi-Fi coupé, 500 sur l'endpoint de
  Server Action), l'utilisateur quitte l'écran de connexion pour la frontière d'erreur et
  perd son contexte local (`reparation`, `aReconnecter`, message de synchro en cours) —
  là où un message inline suffirait. Depuis l'ajout de `(workspace)/error.tsx` il garde
  au moins le chrome de l'application, ce qui fait tomber la gravité de P1 à **P2**.
  **Pourquoi pas un simple `catch`** : essayé, puis retiré délibérément — une session
  expirée lève `NonAuthentifieError` avant le try de l'action et se déguiserait en
  « Réessayez dans un instant », conseil qui ne peut pas aboutir. Le correctif propre
  demande de DISCRIMINER transport et authentification, ce que le client ne sait pas faire
  (Next masque les erreurs de Server Action en production). **Piste** : faire porter la
  distinction par la couche action (retour typé plutôt qu'exception pour l'auth).
  **Déclencheur** : le premier signalement support d'une connexion « qui a sauté », ou le
  chantier de typage des erreurs d'action.

- [x] **NUDGE-VISION-ENTITE1 (P1, 2026-07-20 → LIVRÉ 2026-07-21) — l'empty state global
  MENTAIT à un membre au périmètre borné.** Livré : `PLAN-nudge-vision-entite.md` +
  branche `fix/nudge-vision-entite`. État `"hors-perimetre"` distinct, adossé à
  `compterConnexionsTenant` (COUNT sur `bank_connections` — seule table du chemin à ne
  porter que `tenant_isolation`, donc bornée workspace par la RLS, sans lire
  `bank_accounts` ni contourner l'étage 2) et gardé par `lecteurBorne`
  (`ctx.entityScope`/`ctx.accountScope`). Preuve :
  `tests/isolation/dashboard-hors-perimetre-isolation.test.ts`.
  ⚠️ **Le ticket d'origine visait le mauvais scénario** — à savoir : la prémisse
  « un membre scopé connecte une banque et voit un dashboard vide » est FAUSSE. Vérifié :
  `persisterConnexionEtComptes` écrit connexion ET comptes dans UNE transaction
  (`orchestration.ts:334-395`) ; le `WITH CHECK` d'`entity_scope` rejette l'INSERT
  `entity_id = NULL`, la transaction ROLLBACK, et `orchestration.ts:1496` re-lève l'erreur,
  qui est AFFICHÉE. Ce membre n'atteint donc jamais l'écran vide. Le défaut réel, permanent
  celui-là : un membre borné arrive sur un tenant dont les comptes ne lui sont pas
  assignés. Le volet « faire monter le nudge » a été RETIRÉ (code sans déclencheur, et une
  invite à synchroniser ne peut pas rendre visibles des comptes non assignés). Périmètre
  arbitré par Etienne le 2026-07-21.

- [ ] **ENTITY-CONNEXION-REFUS-NOMME1 (P1, effort ~0,5 j, 2026-07-21) — un membre borné
  qui connecte une banque reçoit une erreur RLS brute, pas un refus intelligible.**
  **Quoi** : le parcours de connexion d'un membre en Vision Entité (ou borné par compte)
  échoue par rejet `WITH CHECK` de la policy `entity_scope` — l'INSERT `entity_id = NULL`
  d'`upsertCompte` n'appartient à aucun scope. **Le fail-closed est VOULU** (CLAUDE.md :
  « un membre borné ne crée pas de comptes non-assignés ») ; ce qui ne l'est pas, c'est le
  message : l'utilisateur reçoit une erreur d'origine base au lieu d'un refus nommé
  (règle 3 : « chaque erreur a un nom »). Aucune garde applicative de périmètre n'existe en
  amont — `orchestration.ts:487` ne teste que `peutModifier`. **Pourquoi ça mord** : le
  membre ne comprend pas que le geste ne lui appartient pas, et rien ne l'oriente vers un
  administrateur. **Piste** : garde applicative explicite avant l'appel amont (échec AVANT
  de solliciter Omni-FI), code d'erreur dédié + message UI. **Déclencheur** : le premier
  membre scopé qui tente une connexion — Omnicane. Découvert en instruisant
  NUDGE-VISION-ENTITE1.

- [ ] **SYNC-NOM-BANQUE-HOMONYMES1 (P2, effort ~0,5 j, 2026-07-20) — deux connexions vers
  la même banque redeviennent indiscernables** (cross-review 7/10). **Quoi** :
  `institution_name` n'est pas unique. Deux connexions vers la même institution
  (utilisateur ayant reconnecté au lieu de réparer, ou deux credentials MCB) produisent
  « MCB Juice et MCB Juice — accès à rétablir », et dans la liste de réparation deux
  boutons portant le même libellé et le même `aria-label`. **Pourquoi** : c'est très
  exactement le défaut que le lot « nom de banque » existe pour corriger (« empilés sans
  libellé, ils étaient indiscernables ») — il réapparaît dès qu'il y a homonymie. Ni
  `nommerToutes` ni les 11 tests ne couvrent le cas doublon. **Pourquoi différé** : le
  repli demande un ARBITRAGE PRODUIT (retomber sur l'anonyme ? désambiguïser par la date
  de connexion ? par les 4 derniers caractères de l'identifiant ?) — aucun choix n'est
  évident et aucun n'est neutre pour la démo. **Déclencheur** : premier workspace réel
  portant deux connexions vers la même institution.

- [ ] **UI-TRUNCATE-MINW01 (P2, effort ~0,25 j, 2026-07-20) — `truncate` inopérant sur le
  nom de banque** (cross-review 6/10, à confirmer au Visual QA). **Quoi** : le `<li>` de
  la liste de réparation est `flex flex-wrap items-center` ; `min-width` d'un flex item
  vaut `auto`, donc le `<span class="truncate">` ne peut pas rétrécir sous son contenu et
  l'ellipse ne mord pas. Un `institution_name` long (la colonne va jusqu'à `varchar(140)`)
  pousse le bouton au lieu de s'ellipser. **Pourquoi P2** : `flex-wrap` fait d'abord
  passer le bouton à la ligne, donc le débordement n'apparaît qu'au-delà de la largeur du
  conteneur — dégradation cosmétique, jamais une perte d'information (et un LIBELLÉ peut
  tronquer, contrairement à un montant). **Fix connu** : `min-w-0` sur le span.
  **Déclencheur** : ta passe Visual QA, ou le premier nom d'institution > ~40 caractères.

- [ ] **NUDGE-SUCCES-PARTIEL1 (P2, effort ~0,25 j, 2026-07-20) — l'atterrissage le plus
  déroutant est le seul sans invite** (cross-review 6/10). **Quoi** : sur une finalisation
  PARTIELLE, il n'y a pas de redirection (décision WIDGET-RD1 : ne jamais masquer un
  échec) ; l'utilisateur suit « Voir mon tableau de bord », qui pointe volontairement sur
  `ROUTE_DASHBOARD` NU — il arrive donc sur un dashboard sans aucune invite à
  synchroniser. **Pourquoi le lien est nu** : il est PARTAGÉ avec le chemin « synchro
  manuelle », où l'invite serait fausse (l'utilisateur vient de faire ce qu'elle demande).
  **Pourquoi différé** : c'est un ARBITRAGE, pas un défaut — le parent sait quelle action
  a produit `succes`, une seconde prop discriminerait, mais il faut décider si un
  atterrissage partiel mérite l'invite alors qu'une partie des banques a échoué.
  **Déclencheur** : première finalisation partielle observée en usage réel, ou ton
  arbitrage produit.

- [ ] **SYNC-MACHINE-INTERRUPTED1 — 🚫 SUSPENDUE (prémisse RÉFUTÉE, 2026-07-21).**
  ~~P1, effort ~0,5 j, 2026-07-20~~ → **dé-priorisée : ni P1, ni bloquant démo, ni
  bloquant `SYNC-LOADER-ETAPES1`.** **Action = NE RIEN CODER** : aucun mapping
  d'`INTERRUPTED` ne doit être écrit sans **re-preuve runtime** préalable (statut
  observé sur un job réel). Arbitrage Etienne 2026-07-21.
  **Prémisse d'origine** (conservée pour l'audit trail) : « `INTERRUPTED` non mappé dans
  `machine-mfa.ts` — statut émis par le backend mais absent de l'enum OpenAPI ; il retombe
  sur le repli “statut inconnu → initialisation”, `pollingActif` reste vrai, le polling
  tourne jusqu'au plafond `MAX_POLLS` → le loader fige sur “Initialisation…”. »
  **Pourquoi elle est réfutée — quatre preuves convergentes :**
  1. **Le chemin actif absorbe DÉJÀ tout statut inconnu.** `orchestration.ts:538-543` :
     « un statut INCONNU n'est donc ni terminal ni MFA → il est poll jusqu'au plafond,
     puis **rendu INCOMPLET** (jamais assimilé à un succès, jamais à un échec dur) ».
     Même SI `INTERRUPTED` existait, il ne figerait rien : il sortirait en `INCOMPLET`
     (`:640-644`), état honnête qui ingère la lecture partielle. Le mode de défaillance
     décrit (« gel sur Initialisation… ») **ne peut pas se produire sur le chemin actif**.
  2. **Le lieu désigné est hors runtime.** `machine-mfa.ts` n'est monté par AUCUN
     composant (cf. CODE-MORT-MFA1) : le repli « inconnu → initialisation » qu'accuse
     l'entrée n'est exécuté par personne aujourd'hui.
  3. **Constat prod contradictoire.** `orchestration.ts:640-644` documente le vrai
     incident du **2026-07-13** : un scrape resté en **`RETRIEVING` > 6 min** (3× le
     plafond), 67 transactions lisibles pendant qu'il courait. Le gel réel vient d'un job
     **LONG**, pas d'un job « interrompu ».
  4. **Le statut est introuvable.** **0 occurrence** d'`INTERRUPTED` dans tout `src/` ; et
     la vérification runtime de la **PR #202 (2026-07-13)** l'avait déjà cherché sans le
     trouver — ni dans `docs/documentation_api.md` (§ Sync Engine), ni dans `omni-fi-core`
     (Django), ni au runtime. L'entrée (2026-07-20) réaffirmait donc une prémisse réfutée
     une semaine plus tôt.
  **Seule nuance conservée** : on ne prouve pas une inexistence *future*. L'enum amont
  **DÉRIVE** (`SCRAPING` côté Django vs `RETRIEVING` côté API, `orchestration.ts:538-539`)
  et le checkout `omni-fi-core` local est périmé. Mais l'union est **OUVERTE** et le repli
  `INCOMPLET` est gracieux : si `INTERRUPTED` apparaissait un jour, le produit dégraderait
  proprement — il n'y a **rien à faire par anticipation**.
  **Réouverture** (le seul déclencheur) : observation d'un `INTERRUPTED` réel dans un log
  de job (`evt: "omnifi_sync_incomplet"`, champ `dernierStatut`). À ce moment-là seulement,
  re-qualifier et chiffrer. Le mapping de `machine-mfa.ts` reste, lui, rattaché à
  `SYNC-LOADER-ETAPES1` — et ne le bloque pas.

### Prévisionnel C0 — occurrences récurrentes (2026-07-17, PR `feat/previsionnel-c0-recurrence`)

Lot C0 livré : le champ `recurrence` était **stocké mais jamais lu** — la synthèse
30/60/90 j comptait chaque échéance UNE fois, à sa date stockée, et **sous-estimait
donc tout engagement récurrent** (une mensuelle de 10 000 affichait 10 000 à plat au
lieu de 10 000 / 20 000 / 30 000). Corrigé par un moteur pur d'expansion
(`src/lib/echeances-recurrence.ts`), sémantique **D1 « gabarit + tête »** (décision
Etienne du 2026-07-17, cf. `PLAN-conception-previsionnel-C.md`).

- [ ] **ECH-OCCURRENCES1 (P1, effort ~2–3 j, 2026-07-17) — matérialiser les occurrences
  d'échéance récurrente** (table `echeance_occurrences` : une ligne par échéance × date,
  `statut`/`montant_regle` **par occurrence**, FK composite scopée workspace + RLS 2
  étages + liste blanche DELETE). **Pourquoi** : le modèle actuel porte `statut` et
  `montant_regle` sur **la ligne** (le gabarit), donc une occurrence ne peut pas être
  pointée individuellement. Trois conséquences, toutes de la même cause :
  1. **Aucun geste pour pointer un paiement** sans toucher la série. D1 « gabarit +
     tête » contourne le trou (une tête terminale n'éteint plus les dérivées), il ne le
     comble pas.
  2. **Une série ne se clôt pas par un statut** — le seul geste de clôture est la
     SUPPRESSION de la ligne (le modèle n'a pas de `recurrence_fin`). À dire
     explicitement dans l'UI tant que cette dette vit.
  3. **Une occurrence dérivée passée est INVISIBLE de la synthèse** (`deriveesDepuis`,
     décision Etienne 2026-07-17) : n'ayant aucun statut, rien ne dit si elle a été
     réglée — on ne la compte donc pas. Un arriéré réel sur une récurrente est ainsi
     **sous-évalué** au-delà de sa tête. C'est le choix DÉLIBÉRÉ face à l'alternative
     (tout compter → sur-estimation croissante et non bornée sur un montant affiché,
     interdite par la règle 9). Seules des occurrences matérialisées permettront de
     compter un arriéré **prouvé** plutôt que supposé.
  **Déclencheur** : le premier utilisateur qui pointe le paiement d'une occurrence
  récurrente, ou le premier besoin d'un arriéré exact sur une série. **Ne PAS** rouvrir
  en même temps que le lot UI (C1) : celui-ci consomme le moteur, pas le modèle.

### Prévisionnel C1 — zone prévisionnelle du dashboard (2026-07-17, PR `feat/previsionnel-c1-dashboard`)

Lot C1 livré : les barres de flux ne montraient que le **réalisé** — une échéance saisie
ne faisait bouger aucune trésorerie prévisionnelle. L'axe se prolonge désormais de 3 mois
vers l'avant, alimentés par les occurrences du moteur C0 (lecture dans le `Promise.all`
existant de la page, sous le même `tx` — jamais un second `withWorkspace`).

Décisions tranchées par Etienne le 2026-07-17 (les 3 étaient ouvertes, cf.
`PLAN-conception-previsionnel-C.md` §7) : **D2 = barre empilée** sur le mois courant
(réalisé à date + échéances restantes) · **D3 = 3 mois fixes** (aligné sur les horizons
30/60/90) · **D4 = pas de zone prévision** si la fenêtre n'atteint pas le mois courant.

Choix DÉLIBÉRÉ à connaître (pas une dette séparée — c'est la face dashboard de
`ECH-OCCURRENCES1` ci-dessus) : **une tête EN RETARD n'est pas projetée sur les barres**
(borne basse = aujourd'hui). La verser dans un mois PASSÉ la mélangerait au réalisé d'une
colonne rendue à 100 % d'opacité — un montant jamais mouvementé qui se lirait comme
encaissé. L'arriéré reste porté par l'onglet Échéances, qui le compte (« une dette
exigible hier reste due »). Divergence VOLONTAIRE entre les deux écrans, prouvée par le
test d'isolation 26.

Hors périmètre, inchangé : **courbe de position** de trésorerie (solde de départ +
variations cumulées) — elle exige un solde de départ fiable, or `balance_history` est vide
en Staging (la courbe du dashboard a déjà dû être recâblée sur le flux net pour cette
raison). À rouvrir quand les soldes historiques existeront (cf. plan §5.1).

Bug de schéma corrigé au passage (migration `0023`, **pas une dette** — il est fixé) :
`recurrence` était `varchar(12)` alors que `'trimestrielle'` fait **13** caractères. La
valeur était donc impossible à stocker (Postgres `22001`) **alors que le formulaire la
proposait** et que zod l'acceptait ; le `22001` n'étant mappé nulle part, toute création
d'échéance trimestrielle finissait en **500 brute**. La branche `'trimestrielle'` du
CHECK était morte depuis `0019`. Élargi à `varchar(20)`, prouvé par le test 25.

### Lisibilité du prévisionnel sur l'axe du réalisé (2026-07-20, PR `feat/flux-previsionnel-lisibilite-lots012`, plan `PLAN-flux-previsionnel-lisibilite.md`)

Lots 0-2 livrés (fixtures + garde Gate 4, mention de couverture, zone muette, étiquettes de
valeur). Ils rendent la prévision LISIBLE ; ils ne rendent pas la comparaison HONNÊTE — cette
distinction est le cœur du sujet et ne doit pas se perdre.

- [x] **FLUX-PREV-AXE1 (P2) — sortir la prévision de l'axe du réalisé (option E du plan §4.1).**
      **LIVRÉ le 2026-07-21** (direction retenue par Etienne le 2026-07-20).
      *Livré* : le graphe « Flux de trésorerie » est 100 % réalisé ; les échéances vivent dans
      `echeances-encart.tsx`, carte SECONDAIRE à échelle propre sous l'ancre, avec renvoi vers
      `/echeances`. Le montant ÉCRIT y est le canal principal, la barre l'appui comparatif —
      parce que l'écart d'ordre de grandeur se REPRODUIT à l'intérieur de la prévision
      (1:1260 mesuré) : sous le tick, la barre ne dit plus rien, le montant si.
      *Garde* : la couverture Gate 4 est re-ciblée sur l'écart INTERNE à la prévision
      (l'écrasement contre le réalisé n'existe plus) + fixture
      `DEMO_DASHBOARD_PREVISION_CONTRASTEE`, sans laquelle le corpus plafonnait à ~1:6.
      *Réversibilité* : `ColonneFlux`/`composerColonnes`/`maxFenetreColonnes` restent dans
      `flux-projection.ts`, débranchés du rendu mais testés — cf. FLUX-PREV-BASELINE1.

- [ ] **ENCART-ECHEANCES-VIDE1 (P2 produit, 2026-07-21) — l'encart « Échéances à venir »
      monte même quand le workspace n'a AUCUNE échéance.** Relevé en cross-review de
      FLUX-PREV-AXE1. `previsionActive` (`(dashboard)/page.tsx`) ne teste QUE « la fenêtre
      atteint le mois courant » (D4) ; l'existence d'une occurrence n'entre pas dans la
      condition, et `projeterEcheancesSurGrille` remplit toujours la grille de zéros. Un
      workspace neuf porte donc en permanence une carte « Aucune échéance sur ces mois » +
      sa mention de couverture.
      *Deux lectures défendables, d'où l'arbitrage* : (a) c'est du BRUIT sur un dashboard
      neuf → ne monter l'encart que si une occurrence existe ; (b) c'est une INFORMATION
      (« rien n'est prévu » ≠ « la fonction n'existe pas ») → statu quo, et c'est cohérent
      avec §5.4 du plan qui refuse les zones muettes.
      *Non tranché par l'agent* : changer un comportement produit visible sans arbitrage
      sortirait du périmètre du lot. Le code dit désormais la vérité (docstrings corrigées).
      *Effort* : ~30 min si (a). *Déclencheur* : arbitrage d'Etienne, ou premier retour
      d'un utilisateur sans échéances.

- [ ] **FLUX-PREV-BASELINE1 (P2) — homogénéiser la série prévisionnelle (option F du plan §4.2).**
      Le VRAI fix : la prévision cesse d'être « les échéances saisies » pour devenir une
      projection du flux attendu (baseline dérivée des mois réalisés / récurrents détectés,
      + échéances en supplément identifié). La série redevient commensurable et l'axe partagé
      redevient légitime.
      *NON lancé délibérément* (décision Etienne 2026-07-20) : c'est la question de **méthode
      de projection** laissée ouverte dans `PLAN-cadrage-scenario-previsionnel-fygr.md` §5, et
      elle se tranche DANS ce cadrage, comme chantier nommé — pas en réaction à un défaut
      d'affichage.
      *Effort* : 2-3 j agent + décision produit. *Déclencheur* : **reprise du cadrage
      prévisionnel FYGR**. *Risque à porter au cadrage* : une baseline est une hypothèse ; non
      annotée, elle remplace un faux constat visuel par un faux constat chiffré, donc plus
      crédible et plus dangereux.
      *Point de reprise (FLUX-PREV-AXE1, 2026-07-21)* : la machinerie d'axe partagé est
      conservée débranchée — `ColonneFlux`/`composerColonnes`/`maxFenetreColonnes`
      (`flux-projection.ts`) et les helpers d'étiquette encore TESTÉS de
      `flux-etiquettes.ts` (`estIllisible`, `etiquetteVerticale`, `largeurEtiquette`,
      `SEUIL_LISIBILITE_PX`, `RAPPORT_BARRE_INVISIBLE`, `MARGE_ETIQUETTE_PX`). Ce chantier
      les rebranche ; il ne repart pas de zéro. `ECART_ETIQUETTE_PX` a en revanche été
      SUPPRIMÉ : sans consommateur NI test, il aurait dérivé en silence — le geler ne se
      justifiait que pour ce qui reste couvert. Il se réécrit en une ligne (git le garde).
      Ce chantier réactive aussi FLUX-PREV-LABEL-DENSE1, clos par disparition de sa cause.

- [x] **FLUX-PREV-LABEL-DENSE1 (P2 cosmétique) — CADUC le 2026-07-21, résolu de fait par
      FLUX-PREV-AXE1.** Le défaut était : un mois projeté pouvait afficher « Rs 10 k » sans son
      libellé de mois sur une fenêtre dense, l'étiquette de valeur devenant orpheline. Il n'y a
      plus ni colonne projetée ni étiquette de valeur dans le graphe — la prévision a quitté
      l'axe. Rien à corriger : la cause a disparu avec la structure qui la portait.
      ⚠️ Reviendrait avec FLUX-PREV-BASELINE1 (option F) si une série prévisionnelle
      retournait sur l'axe partagé.

- [ ] **FLUX-PREV-CONTRASTE1 (P2 accessibilité, PRÉ-EXISTANT) — `text-faint` sous AA.**
      Mesuré au Visual QA : `text-faint` (#8a8f9f) donne **3,23:1 sur blanc** et **2,70:1 sur
      `surface-forecast`**, sous le minimum AA de 4,5:1 pour du texte de 11 px. Les étiquettes de
      valeur ont été passées en `inflow-700`/`outflow-700` (6,75:1 / 6,18:1), mais les **libellés
      de mois**, les **notes sous le graphe** et les autres usages de `text-faint` restent
      concernés — au-delà de ce composant. *Effort* : ~2 h (arbitrage token + balayage des usages).
      *Déclencheur* : prochain passage d'accessibilité, ou audit régulateur (audience BOM).

### QA runtime du 2026-07-15 — constats différés (rapport `.gstack/qa-reports/`)

Passe /qa complète sur main@747c4f3 (build local, vraie donnée, compte jetable).
Deux bugs corrigés dans la PR associée (recherche aveugle aux `clean_label` NULL ;
suppression d'échéance sans confirmation). Un seul constat différé — il ne touche
ni l'isolation, ni l'append-only, ni l'exactitude des montants :

- [ ] **QA-REGLES-PICKER-INDENT1 (P2, effort ~0,1 j, 2026-07-15) — le préfixe
  d'indentation hiérarchique fuit dans le label fermé du picker** : sur `/regles`,
  choisir la sous-catégorie « Fournitures » affiche « — Fournitures » (tiret
  d'indentation du dropdown) dans le bouton fermé du formulaire « Nouvelle règle ».
  Le label fermé doit rendre le NOM seul ; l'indentation n'a de sens que dans la
  liste déroulée. **Déclencheur** : prochain lot UI sur `/regles` ou sur le Select
  maison (`components/ui/select`).

Deux constats levés PENDANT la passe ont été requalifiés à la lecture des décisions
existantes, et ne sont PAS consignés (trace d'audit, règle 6) : l'anglais de
`/admin/*` est le pilote **Q-LANG** voulu (décision 2026-07-13 — ne pas « corriger »
la langue de ces écrans) ; l'incohérence préfixe/suffixe GBP/ZAR (cartes vs synthèse)
est déjà consignée par le design review du 2026-07-15 (`DESIGN-DEVISE-CONVENTION1`,
arbitrage Etienne attendu).

Statut des dettes déjà consignées re-vérifiées au passage : `QA-UX-VENTIL-RESTE1`
toujours reproductible à l'identique (2e ligne orpheline, Valider grisé — l'invariant
bloque, pas de corruption) ; `QA-LISTES-MANQUANTES1` et `QA-NAV-PLACEHOLDERS1` sont
RÉSOLUS en pratique (/banques liste la connexion, /admin/membres liste les membres,
/graphiques et /echeances sont de vraies pages) — à cocher par leur auteur si confirmé.
### Différés /design-review du 2026-07-15 (rapport : `~/.gstack/projects/tygr-app/designs/design-audit-20260715/`)

Baseline Design Score B− (AI Slop A) ; 10 findings fixés en
`fix/design-review-20260715`, les suivants DIFFÉRÉS. Aucun ne touche
l'isolation/append-only/montants-exacts (sinon corrigé, pas consigné).

- [ ] **DESIGN-PERIMETRE-LARGEUR1 (P2, effort ~0,25 j, 2026-07-16) — popover
  « Vue / Rechercher un compte » trop étroit, titres tronqués.** Le sélecteur de
  périmètre de la barre de vue (`src/components/shell/perimetre-switcher.tsx`, popover
  ouvert depuis « Vue · N comptes ») a une largeur fixe qui coupe les noms d'entités/
  titulaires (« AIRPORT HOTEL LTD - 1… », « OMNICANE AGRICULTU… »). Élargir le popover
  (ou passer à une largeur fluide plafonnée + `title`/tooltip au survol) pour lire les
  libellés en entier. Purement présentationnel, aucun changement serveur (la sélection
  postée reste une liste de `bankAccountId`). Lié à UI-PERIMETRE-ACCORDEON1 (même
  composant). **Déclencheur** : ce retour terrain (clawdy 2026-07-16) — à traiter à la
  prochaine passe sur la barre de vue.
- [ ] **DESIGN-MOBILE1 (P2, effort ~2-3 j, 2026-07-15) — mobile <768 non conçu.**
  La sidebar (232px, sans variante responsive) ne collapse pas ; à 375px le
  contenu s'écrase (graphe illisible, chiffres masqués). Spec §1.1 « <768 =
  lecture seule, KPIs en rangée scrollable, bottom-nav 4 entrées » NON
  implémentée. Captures : `screenshots/dashboard-mobile.png`,
  `transactions-mobile.png`. **Déclencheur** : décision produit « mobile
  lecture seule » ou premier usage mobile réel rapporté.
- [ ] **DESIGN-BREAKPOINTS1 (P2, effort ~0,5 j, 2026-07-15) — seuils sm/lg vs
  norme 768/1280.** Le code bascule à 640/1024 (64× `sm:`, 10× `lg:`), la norme
  §1.1 dit 768/1280. Soit ACTER les seuils réels dans UI_GUIDELINES, soit
  migrer (`md:`/`xl:`). Lié : DESIGN-MOBILE1. **Déclencheur** : mise à jour
  UI_GUIDELINES (DESIGN-DOCS-PERIMEES1) — trancher AVANT tout sweep.
- [ ] **DESIGN-FOCUS-SWEEP1 (P2, effort ~0,5 j, 2026-07-15) — focus non
  uniforme.** 44× `focus:ring` (s'allume au clic souris) vs 252×
  `focus-visible:ring`, mélangés jusque dans `category-picker.tsx` ; 3 rendus
  d'anneau (offset-2 / sans offset / `ring-primary/30`). Cible §2.3 : ring 2px
  primary offset 2px, `focus-visible` partout. Mécanique mais 15+ fichiers.
  **Déclencheur** : prochain chantier a11y OU prochaine /design-review.
- [ ] **DESIGN-HAUTEURS-CONTROLES1 (P2, effort ~0,25 j, 2026-07-15) — h-9 (19×)
  vs h-10 (46×, spec §2.3) vs toolbar h-12 (`barre-vue.tsx:99`).** Unifier à
  h-10 écran par écran (risque de layout calibré). **Déclencheur** : prochaine
  passe admin/forms.
- [ ] **DESIGN-CAT-COULEURS1 (P2, effort ~0,5 j, 2026-07-15) — deux référentiels
  de couleur catégorie ASSUMÉS mais divergents.** Badge = identité (hash,
  stable, tokens `--color-cat-badge-*`) ; donut = RANG de montant (tokens
  `--color-chart-cat-*`). Une même catégorie change de couleur selon la
  surface. Converger = décision produit (le donut par identité perdrait la
  lecture de classement ; le badge par rang perdrait la stabilité).
  **Déclencheur** : décision design/PO explicite — ne pas « fixer » en douce.
- [ ] **DESIGN-DEVISE-CONVENTION1 (P2, effort ~0,25 j, 2026-07-15) — CONFLIT de
  règles documentées sur les devises sans symbole.** CLAUDE.md §8 (figé
  2026-06-22) : repli code ISO en SUFFIXE (« 28 061,11 GBP » — synthèse,
  graphiques) ; `indicateurDevise` (UI-SOLDE-MULTIDEVISE-POLISH1) : indicateur
  TOUJOURS en préfixe pour aligner les virgules de la pile multi-devise
  (« GBP 349,20 » — cartes de solde). Même devise, deux écritures sur le même
  écran. Trancher (l'alignement décimal plaide pour le préfixe généralisé),
  harmoniser, corriger la règle perdante. **Déclencheur** : arbitrage Etienne.
- [ ] **DESIGN-ITALIQUE-BRUT1 (P2, effort ~0,25 j, 2026-07-15) — l'italique
  « libellé brut non enrichi » est un signal NON documenté.** Transactions et
  légendes graphiques rendent les libellés bruts en italique, les enrichis en
  romain — sémantique réelle, invisible pour l'utilisateur (deux « Merchant
  Settlement|… » stylés différemment sans explication). Documenter (légende/
  tooltip) OU uniformiser. **Déclencheur** : décision produit.
- [ ] **DESIGN-ENTETE-VARIANTES1 (P2, effort ~0,25 j, 2026-07-15) — 3 variantes
  de zone d'en-tête depuis #214.** Toolbar complète (dashboard/transactions/
  échéances) / CTA seul (banques) / bandeau « ESPACE » (règles + admin). Unifier
  ou acter la matrice page→en-tête. **Déclencheur** : consolidation toolbar
  (PLAN-toolbar-config).
- [ ] **DESIGN-DOCS-PERIMEES1 (P2, effort ~0,5 j, 2026-07-15) — docs design
  périmées vs code.** UI_GUIDELINES §1.1/§1.2 décrivent le header ink + side-panel
  KPI 300px (remplacés par AppSidebar verticale, refonte Dodo) ; §2.1 dit encore
  « Instrument Sans + Geist » (code = Red Hat Display unifiée, conforme §0) ;
  DESIGN.md racine résume d'ANCIENNES valeurs (`ink #0F1E3D` vs `#0C1633`) ;
  segmented actif rendu `primary` (spec §2.3 : pill `ink`) — à acter ; H1 de page
  26px sans rôle dans l'échelle §2.1 — à acter ; **CLAUDE.md « Interface en
  français » à réconcilier avec Q-LANG** (destination EN actée 2026-07-13 — le
  design-review 2026-07-15 a failli traduire le pilote admin EN en FR sur la foi
  de cette phrase). PR docs (auto-mergeable).
  **Déclencheur** : avant la PROCHAINE /design-consultation ou tout nouveau plan UI.
- [ ] **DESIGN-RESTANT-SERVEUR1 (P2, effort ~0,25 j, 2026-07-15) —
  `restantDecimal()` recalcule un montant dans l'UI** (`echeances-list.tsx:62-74`,
  centimes BigInt — pas de float). Contraire au principe « l'UI affiche, ne
  recalcule rien » (en-tête format-montant.ts) : déplacer le « restant dû » dans
  la requête/service. **Déclencheur** : prochain chantier échéances.

### Dashboard : carte « Comptes connectés » orpheline (2026-07-15)

- [ ] **DASH-COMPTES-CONNECTES-ORPHELIN1 (P2, effort ~0,25 j, 2026-07-15) — DETTE :
  `connected-accounts-card.tsx` n'est plus monté par le Dashboard.** Le ticket
  DASH-RETIRER-COMPTES-CONNECTES1 (branche `fix/dashboard-retirer-comptes-connectes`,
  `PLAN-dashboard-retirer-comptes-connectes.md`) a DÉBRANCHÉ la carte « Comptes connectés »
  du dashboard (jugée redondante avec la nav latérale par Etienne) et rééquilibré le layout
  (graphe `FluxTresorerieCard` pleine largeur + « Synthèse du mois » en bandeau horizontal).
  Le composant `src/components/dashboard/connected-accounts-card.tsx` et sa démo
  `src/app/demo/comptes-provenance/page.tsx` n'ont **PAS** été supprimés (règle 12/9 : dead
  code préexistant → on signale, on ne supprime pas sans demande). Ils ne sont donc plus
  référencés que par cette démo → **ORPHELINS**. La prop/fetch `comptes` reste utilisée par
  le dashboard (compteur `SoldesDevisesRow`, pastille `synchroLaPlusRecente`, « N comptes »
  du sous-titre) — seul le rendu de la carte a disparu. **À trancher** (recycler vs
  supprimer) : soit la carte est recyclée sur une autre page (ex. future page « Comptes » /
  détail de connexion), soit elle est supprimée avec sa démo. Pas une dette d'isolation/
  append-only/montants (pur présentationnel). **Déclencheur** : prochaine décision produit
  sur une page « Comptes » dédiée, OU revue de dead code de fin d'Epic 3 — l'un tranche.

### Barre de vue globale & bugs /transactions — backlog navbar (2026-07-13)

Retour terrain Etienne (passe navbar + `/transactions`, 2026-07-13) : deux bugs
fonctionnels (A4 redirect de périmètre, B1 layout du sélecteur de statut), un lot produit
« barre de vue globale » (A1-A3, à cadrer) et deux irritants UX/feature `/transactions`
(B2 saut visuel de la recherche, B3 somme nette des résultats). Aucun de ces points ne
touche l'isolation tenant, l'append-only ni les montants (sinon corrigé immédiatement, pas
consigné) ; B3 est une FEATURE d'AFFICHAGE de montants — spécifiée ici, non implémentée —
qui devra respecter la règle 8 (somme PAR devise, chaîne décimale, `tabular-nums`).
Fichiers cités vérifiés en lecture seule. Cadre plus large : la passe profonde
`PROD-UX-REVIEW1` (/design-review) est le déclencheur naturel de plusieurs de ces items.

**Topologie (recon)** : la « barre de vue des comptes » = `AppTopbar`
(`src/components/shell/app-topbar.tsx`), montée GLOBALEMENT par le layout
(`src/app/(workspace)/layout.tsx:206`) → présente sur TOUTES les pages workspace. Elle
compose `PeriodeSwitcher` (presets Ce mois/3m/6m/12m/Tout via `?periode`, canal de LECTURE
hors RLS — `periode-switcher.tsx`, lib `src/lib/periode.ts`), `PerimetreSwitcher` (périmètre
comptes/entités via Server Action + `redirect` — `perimetre-switcher.tsx`) et `BankCtaLink`.

- [x] **PERIMETRE-REDIRECT-PAGE1 (P1, effort ~0,5 j, 2026-07-13) — BUG : changer le
  périmètre de comptes depuis `/transactions` (ou toute page ≠ dashboard) REDIRIGE vers le
  dashboard.** ✅ **RÉSOLU 2026-07-14** (branche `fix/perimetre-redirect-page`, plan
  `PLAN-perimetre-redirect-page.md`). Les 2 actions de PÉRIMÈTRE reviennent sur la page
  courante : champ caché `origine` (`usePathname` + `useSyncExternalStore` sur
  `window.location.search` — jamais `useSearchParams`, bail-out CSR), VALIDÉ serveur par
  le nouveau `src/lib/redirect-interne.ts` (anti-open-redirect fail-closed : chemin
  interne absolu uniquement, rejet `//host`, `/\host`, schémas, CRLF ; résolution
  same-origin en défense en profondeur ; sortie `pathname+search`, jamais d'origine).
  19 tests unitaires. `basculerWorkspace` garde `redirect("/")` (décision D1 : le switch
  de workspace purge le viewFilter, et l'action sert aussi `/selection`).
  ⚠️ **Garde indispensable découverte en recon** (arbitrage Etienne du 2026-07-14) :
  rester sur la même route est un RE-RENDER, pas un remount → les features clientes qui
  sèment le RSC dans un `useState` (`transactions-feature.tsx:104`,
  `graphiques-feature.tsx:121`, `echeances-feature.tsx:93`) auraient affiché des données
  PÉRIMÉES (topbar « Sucre » + table de tous les comptes). D'où la `key` de périmètre sur
  le conteneur de page (`layout.tsx`), qui re-sème TOUTE page — présente et future — quand
  le périmètre change. Contrepartie assumée → dette `TX-FILTRES-URL1` ci-dessous.
  Mode de défaillance d'origine : sur `/transactions`, ouvrir le sélecteur « Vue »,
  ajouter/retirer un compte, « Appliquer » → on atterrit sur `/` au lieu de rester sur
  `/transactions` (perte de place + reset des filtres in-page recherche/statut/date). Cause
  EXACTE : les trois Server Actions de périmètre finissent par un `redirect("/")` EN DUR —
  `definirViewFilter` (`src/app/(workspace)/actions.ts:92`), `definirPerimetreEntite`
  (`:137`) et l'action sœur (`:61`). Attendu : revenir sur la page COURANTE. ⚠️ Le redirect
  n'est pas gratuit à supprimer : il pilote aujourd'hui le remount propre du
  `PerimetreSwitcher` via une `key` dérivée du périmètre (`app-topbar.tsx:64`,
  `perimetre-switcher.tsx:181`) → rester sur place doit quand même RE-résoudre le scope
  (revalidation) et re-semer la sélection locale. Piste : passer le chemin d'origine à
  l'action (`usePathname` → champ caché) puis `redirect(origine)` — chemin VALIDÉ (préfixe
  interne, jamais un chemin client brut → open-redirect). Même composant que
  UI-PERIMETRE-ACCORDEON1 / PERIMETRE-ENTITE-DERIVE1, à ne pas confondre (eux =
  accordéon/dérive de libellé ; ici = routage). **Déclencheur** : immédiat (reproduit ;
  gêne à chaque changement de périmètre hors dashboard). Pas une dette d'isolation (la RLS
  reste la garde ; c'est du routage).

- [ ] **TX-FILTRES-URL1 (P2, effort ~0,5 j, 2026-07-14) — porter les filtres in-page de
  `/transactions` (recherche / statut de ventilation / bornes de date) dans les
  searchParams, pour qu'ils SURVIVENT à un changement de périmètre.** Contrepartie ASSUMÉE
  de la garde livrée avec PERIMETRE-REDIRECT-PAGE1 (arbitrage Etienne, 2026-07-14) : la
  `key` de périmètre du conteneur de page (`(workspace)/layout.tsx`) remonte le sous-arbre
  quand le périmètre change — c'est ce qui interdit d'afficher des données PÉRIMÉES — mais
  elle réinitialise du même coup l'état CLIENT des filtres (`transactions-feature.tsx:108`,
  `useState<FiltresTransactions>({})`). Aujourd'hui : on reste bien sur `/transactions`
  (bug principal réglé) et `?periode` est préservé, mais un changement de périmètre vide la
  recherche/le statut/les dates. **Cible** : filtres dans l'URL (`?recherche`, `?statut`,
  `?du`, `?au`) → ils sont alors portés par le chemin de retour (`validerCheminInterne`
  préserve la query), survivent au remount, ET la page devient deep-linkable/partageable.
  ⚠️ Recoupe TOOLBAR-DATE-PRECISE1 (qui veut déjà `?du`/`?au` GLOBAUX) : trancher d'abord
  qui possède les bornes de date (barre de vue globale vs toolbar in-page), sinon deux
  canaux concurrents. ⚠️ **Point de vigilance (nit cross-review 2026-07-14)** : le champ
  `origine` du PerimetreSwitcher lit la query via `useSyncExternalStore` abonné au SEUL
  `popstate` (`perimetre-switcher.tsx`, `souscrireHistorique`). Tant que seule la période
  mute l'URL (et ferme le popover au clic), la valeur reste fraîche. Mais si ce chantier
  fait muter la query par `router.replace`/`pushState` SANS fermer le popover (raccourci
  clavier, debounce), `origine` pourrait poster une query périmée → au moment du fix,
  patcher `souscrireHistorique` pour intercepter `history.pushState`/`replaceState` (ou
  relire `window.location.search` au submit). Glitch UX bénin (le filtre vit dans le
  cookie ; seul le param d'URL régresserait), pas une faille. **Déclencheur** : prochain
  chantier `/transactions` (ou TOOLBAR-GLOBALE-CADRAGE1, qui tranche la propriété des
  filtres). Pas une dette d'isolation (la RLS reste la garde ; c'est de l'état d'UI).

- [x] **TX-STATUT-SELECT-LAYOUT1 (P2, effort ~0,25 j, 2026-07-13) — BUG FRONT : ouvrir le
  filtre « Tous statuts » sur `/transactions` fait SAUTER le layout (barre de scroll
  parasite).** ✅ **RÉSOLU 2026-07-14** (branche `fix/select-layout-shift`). **Cause réelle**
  (mesurée, ce n'était pas la scrollbar-gutter supposée) : le popover était `absolute`, donc
  enfant du groupe de filtres `overflow-x-auto` (`transactions-toolbar.tsx:156`) — or CSS
  force `overflow-y` à `auto` dès que `overflow-x` ne vaut plus `visible`. Le menu (288px)
  débordait de la rangée (40px) → **la toolbar devenait scrollable de 142px** (mesuré au
  navigateur) et le `scrollIntoView` de l'option active la faisait défiler → scrollbar
  parasite + saut. **Fix** : le menu est PORTALÉ dans `document.body` et positionné en
  `fixed` sur le rect du trigger (`src/components/ui/select/position-menu.ts`, géométrie
  PURE + 14 tests unitaires ; `select.tsx` mesure et applique). Un `fixed` échappe à TOUT
  ancêtre clippant ET, hors flux, ne peut créer aucune scrollbar de document.
  **Bugs LATENTS de la même famille tués au passage** — dans les 7 FICHIERS appelants du
  `Select` (14 occurrences), tous re-QA'és : (a) tableau d'assignation
  (`assignation-comptes.tsx:339` `overflow-x-auto`) — les menus des dernières lignes sortaient
  SOUS le viewport (mesuré à 1033px pour une fenêtre de 900 → options inatteignables) ;
  (b) liste des suggestions en modale (`propositions.tsx:233` `max-h-[60vh] overflow-y-auto`)
  — même clipping. ⚠️ La famille n'est PAS close pour autant : les popovers maison HORS
  `Select` restent à traiter (cf. SIDEBAR-SWITCHER-CLIP1). Le `z-[60]` du menu est exigé par
  la NOUVELLE architecture (le menu et l'overlay de la Modal sont désormais deux portals
  FRÈRES sous `body` : à z-index égal, seul l'ordre du DOM les départagerait) — avant le
  portal, le menu était un DESCENDANT du contexte d'empilement de l'overlay et passait donc
  toujours devant : il n'y avait là aucun défaut de z-index, seulement le clipping.
  Ajouts : FLIP au-dessus quand l'espace manque en bas, hauteur ET ancre bornées au viewport,
  reposition au scroll/resize (coalescée par rAF), fermeture du menu dès que le trigger n'est
  plus visible (`IntersectionObserver` — sinon le `fixed`, qui échappe au clip, laisserait le
  menu ORPHELIN sur une ancre invisible). Les deux derniers points viennent de la revue
  contradictoire (constats F1/F2, bloquants) — la géométrie sortait de l'écran dès qu'on
  scrollait menu ouvert ; 3 tests ajoutés, qui échouaient avant le bornage.
  Effet de bord assumé : le typeahead lit l'horodatage de l'ÉVÉNEMENT au lieu de `Date.now()`
  (le React Compiler refuse l'appel impur — `react-hooks/purity` — une fois le composant
  devenu analysable). Pas d'isolation, aucun changement d'API ni de token.
  Plan + registre de revue : `PLAN-select-layout-shift.md`.

- [ ] **SELECT-MODALE-A11Y1 (P1, effort ~0,5 j, 2026-07-14) — RÉGRESSION A11Y assumée du
  portal : dans une modale, le menu du `Select` sort du sous-arbre `aria-modal`.** Constat de
  la revue contradictoire de `fix/select-layout-shift` (confiance 7/10, non reproductible ici
  faute de lecteur d'écran). `modal.tsx:136` pose `aria-modal="true"` : les AT ignorent alors
  tout ce qui vit HORS du `role="dialog"`. Or le menu est désormais portalé sous `document.body`
  → **frère** de l'overlay, pas descendant du dialogue. Un utilisateur NVDA/JAWS/VoiceOver qui
  ouvre le seul `Select` vivant en modale (`propositions.tsx:422`, sas ADMIN des suggestions)
  et navigue ↑/↓ pourrait n'entendre AUCUNE option (`aria-activedescendant` pointe un `id`
  situé dans la zone masquée). Avant le portal, le menu était dans le panneau → annoncé.
  **Deux correctifs candidats, chacun avec son coût** : (a) portaler dans le panneau du
  dialogue (`closest('[role="dialog"]')`) — garde le sous-arbre a11y ET échappe au clip de la
  liste, MAIS les options rejoignent alors la requête du focus-trap de la Modal
  (`modal.tsx:94`, sélecteur qui n'exclut pas `tabindex="-1"`) → il faut AUSSI durcir la
  Modal (risque sur TOUTES les modales) ; (b) prop `container?: HTMLElement` sur `Select` +
  la Modal expose son panneau → API élargie, 3 fichiers. Écarté au MVP : incertitude sur le
  comportement réel des AT + périmètre (le lot devait rester CONTENU au `Select`, sans
  changement d'API). C'est le pattern que portent Radix/MUI/Headless UI (portal `body`), avec
  la même réserve connue. **Déclencheur** : prochaine passe a11y, ou tout chantier touchant
  `modal.tsx` / le sas ADMIN. Trancher AVANT la prod (P1) — à valider au lecteur d'écran réel.

- [ ] **SIDEBAR-SWITCHER-CLIP1 (P2, effort ~0,25 j, 2026-07-14) — MÊME famille que
  TX-STATUT-SELECT-LAYOUT1, hors `Select` : le popover du `WorkspaceSwitcher` est clippé par
  la sidebar.** `workspace-switcher.tsx:60-63` rend son menu en `absolute … mt-2` (il s'ouvre
  vers le BAS) ; son trigger vit dans le bloc `mt-auto` (collé en BAS) de
  `app-sidebar.tsx:47-49` — un `<aside class="sticky top-0 flex h-screen … overflow-y-auto">`.
  Popover `absolute` ouvrant vers le bas depuis le bas d'un conteneur `overflow-y-auto` =
  exactement la configuration corrigée pour le `Select` : la sidebar devient scrollable à
  l'ouverture (scrollbar parasite) et le menu est rogné. **Non traité ici** : ce n'est pas un
  `Select`, le lot devait rester contenu (règle 7, pas d'expansion de périmètre). Correctif :
  soit réutiliser le `Select` (il porte maintenant le portal), soit remonter la même mécanique
  (portal + `fixed` + `position-menu.ts`, déjà écrit et testé). **Déclencheur** : prochain
  chantier navbar/shell (typiquement TOOLBAR-GLOBALE-CADRAGE1). Pas d'isolation.

- [x] **UI-ZINDEX-ECHELLE1 (P2, effort ~0,1 j, 2026-07-14) — `docs/UI_GUIDELINES.md` ne
  documente AUCUNE échelle de z-index, alors qu'il en existe une de fait.** ✅ **LIVRÉ
  2026-07-17** (passe PROD-UX-REVIEW1, branche `chore/design-review-20260717`) : registre
  ajouté à UI_GUIDELINES §4.4, échelle re-vérifiée au grep avant écriture (z-10 ×6, z-20 ×3,
  z-30 ×1, z-50 ×4, z-[60] ×2 — inchangée depuis le relevé). Le token `z-popover` Tailwind
  (« éventuellement ») n'a PAS été posé : hors périmètre docs de cette passe, à raccrocher
  au prochain composant flottant s'il naît. Historique :
  Relevé par la revue de `fix/select-layout-shift`, qui a dû introduire le premier cran > 50
  (`z-[60]` du menu portalé, qui doit battre l'overlay Modal `z-50`). Sans registre écrit, le
  prochain composant flottant tirera un z-index au jugé et passera un jour DERRIÈRE une modale.

- [x] **TOOLBAR-GLOBALE-CADRAGE1 (P2, 2026-07-13) — faire de la « barre de vue » une TOOLBAR
  GLOBALE cohérente : présente là où c'est pertinent, retirée là où c'est obsolète.**
  ✅ **CADRÉ + LOT A2 (gating) LIVRÉ 2026-07-14** (branche `feat/toolbar-config`, plan
  `PLAN-toolbar-config.md`). Matrice tranchée par Etienne, implémentée en fonction PURE
  `src/components/shell/toolbar-config.ts` (`toolbarConfig(pathname)` → `{periode, perimetre,
  cta, minimal}`), consommée par un composant CLIENT `barre-vue.tsx` (`usePathname`) —
  `AppTopbar` reste SERVER et lui passe `BankCtaLink` en slot. **Livré** : période retirée de
  Banques/Règles/Admin (elle n'y a aucun effet) ; CTA retiré de Graphiques/Échéances ; période
  retirée d'Échéances (les presets sont rétrospectifs, l'écran regarde le futur) ; bande
  MINIMALE (repère de tenant seul) sur `/admin/*` ; AUCUNE barre sur `/selection` ; défaut
  fail-safe explicite pour toute page non cadrée. Reste du lot renvoyé à ses entrées :
  **TOOLBAR-DATE-PRECISE1** (plage de dates, A1), **horizon futur d'Échéances** (chantier
  séparé), **TX-TOOLBAR-DEDUP1**. ⚠️ **Deux cellules de la matrice N'ONT PAS été livrées**
  (périmètre conservé sur Banques et Règles) → cf. TOOLBAR-PERIMETRE-AMPUTATION1 ci-dessous,
  qui les débloque.

- [x] **TOOLBAR-PERIMETRE-AMPUTATION1 (P1, effort ~0,5 j, 2026-07-14) — amputer le
  `viewFilter` des surfaces de GESTION `/banques` et `/regles`, puis y retirer le sélecteur
  de périmètre (2 cellules restantes de la matrice A2).**
  ✅ **LIVRÉ 2026-07-15** (branche `fix/toolbar-perimetre-amputation`, plan
  `PLAN-toolbar-perimetre-amputation.md`). Helper renommé `exigerSessionSansPerimetre()`
  (arbitrage Etienne : nom honnête + alias `exigerSessionAdministration` rétro-compat).
  Amputé : `banques/page.tsx`, `banques/actions.ts` (×6), `banques/widget-runtime.ts` (×3,
  NO-OP — découverte), `regles/page.tsx` (découverte), et les **5 écritures** de
  `regles/actions.ts` (dont `appliquerReglesAction`, la SEULE réellement distordue —
  INNER JOIN `bank_accounts`). La **lecture** `listerReglesAction` reste en session complète
  (règles workspace-global, immunes au viewFilter). Matrice : `banques` → `perimetre:false`
  (CTA seul) ; `regles` → **`MINIMALE`** (plus aucun contrôle → bande de tenant, comme
  `/admin`). Preuve : `tests/isolation/perimetre-amputation-gestion-isolation.test.ts`
  (repro + fix des 2 surfaces + non-régression tenant). Effet de bord ASSUMÉ : « Ré-analyser »
  porte désormais sur tout le tenant quel que soit le filtre d'affichage. Reste : Visual QA +
  merge (Etienne).
  Découvert par la cross-review de
  `feat/toolbar-config` ; **arbitrage Etienne : ne PAS masquer le sélecteur tant que le
  serveur n'est pas amputé** (sinon on supprime le seul moyen de voir/annuler un filtre qui
  mord encore). **Le fond du problème** : le `viewFilter` n'est pas un filtre d'affichage
  local, c'est un prédicat **RLS** (`app.current_view_filter`, policy `account_scope`
  RESTRICTIVE en USING *et* WITH CHECK, migrations 0016/0017) porté par le **JWT** → il suit
  l'utilisateur de page en page et mord sur toute page dont la session n'est pas amputée.
  `/admin/*` l'est déjà (`exigerSessionAdministration()`, `server/auth/session.ts:136` — helper
  qui NE vérifie PAS le rôle et dont la doc établit « la sécurité est INCHANGÉE, on ne retire
  qu'une intention d'affichage » ; doctrine : « Administrer porte sur le TENANT ENTIER : un
  filtre d'affichage n'y a aucun sens »). **Pas `/banques` ni `/regles`, qui tournent sur
  `exigerSessionWorkspace()` (session COMPLÈTE)** :
  - `/banques` — filtre actif ⇒ le sync **attache 0 compte SANS erreur** (`WITH CHECK` refuse
    l'INSERT des comptes hors filtre). **Ce n'est pas théorique** : le repo le documente
    lui-même comme diagnostic d'un bug terrain « spinner puis rien »
    (`banques/actions.ts:281-286`). Les compteurs de `listerConnexionsBancaires` (leftJoin
    `bank_accounts`) sont faux du même coup (« 1 compte » pour une connexion qui en a 5).
  - `/regles` — filtre actif ⇒ `appliquerReglesAction` (`regles/actions.ts:200`) ne
    recatégorise **que le périmètre filtré** : le FM croit avoir ré-analysé tout le groupe.
  **Correctif** : `exigerSessionAdministration()` sur `banques/page.tsx:31`, les 6 actions de
  `banques/actions.ts` (l.152, 212, 272, 444, 491, 590) et les actions d'écriture de
  `regles/actions.ts` ; **puis** passer `banques`/`regles` à `perimetre: false` dans
  `toolbar-config.ts` (⚠️ la garde CI `tests/unit/toolbar-config.test.ts` REFUSE ce passage
  tant que le segment n'est pas déclaré amputé — c'est voulu). ⚠️ **Touche une surface
  serveur** → cas d'isolation à ajouter (règle 3), effet de bord ASSUMÉ à valider : «
  Ré-analyser » portera alors sur tout le tenant quel que soit le filtre d'affichage.
  **Déclencheur** : immédiat/prochain chantier toolbar — c'est un bug de correction d'AFFICHAGE
  et d'ÉCRITURE (sync silencieusement vide), pas une dette d'isolation (la RLS reste la garde,
  aucune fuite cross-tenant : le filtre ne fait que RÉTRÉCIR).

- [x] **TOOLBAR-DATE-PRECISE1 (P2, effort ~0,5 j, 2026-07-13) — ajouter un sélecteur de DATE
  PRÉCISE (plage `?du`/`?au`) dans la barre de vue, en complément des presets de période.**
  ✅ **LIVRÉ 2026-07-14 (lot A1)** — branche `feat/toolbar-date-precise`, plan
  `PLAN-toolbar-date-precise.md`. `src/lib/periode.ts` gère « **plage explicite prime sur
  preset** » (`lirePlage` = source UNIQUE de validation, partagée serveur/UI : dates
  calendaires réelles via `estDateISO`, garde `du ≤ au`, amplitude bornée à `MAX_MOIS_PLAGE`
  = 120 mois — anti-abus d'un `?du` forgé ; toute plage inexploitable → repli silencieux sur
  le preset). `BornesPeriode.preset` devient `PresetPeriode | null` (null sous plage = garde
  anti-mensonge au niveau du TYPE). UI : `plage-dates-switcher.tsx` (client) + le
  `PeriodeSwitcher` n'allume AUCUN segment sous plage (et un clic sur un preset efface la
  plage). **Câblage serveur RÉEL** : `(dashboard)/page.tsx` → `resoudrePeriode(searchParams)`.
  ⚠️ **Périmètre RÉDUIT au Dashboard** (arbitrage Etienne, cf. GRAPHIQUES-PERIODE-DEDUP1
  ci-dessous et TX-TOOLBAR-DEDUP1) : c'est la SEULE page qui lit ces params. La garde CI
  « une page qui MONTE la période DOIT la LIRE » (`tests/unit/toolbar-config.test.ts`) rend
  désormais impossible d'afficher un contrôle de période qui ne filtre rien.
  ⚠️ **BLOQUANT trouvé en cross-review et corrigé (arbitrage Etienne 2026-07-14)** : deux des
  quatre lectures du Dashboard n'étaient PAS bornées au jour — `syntheseMoisParDevise(mois)`
  et `syntheseParMois({moisFin, nbMois})` agrégeaient au **MOIS ENTIER**. Invisible avec les
  presets (leur `from` tombe toujours un 1er du mois → l'agrégat coïncidait), mais une plage
  « 3 mars → 17 avril » aurait affiché **avril entier** sous une barre annonçant « au 17/04 » :
  le mensonge d'affichage déplacé de la barre vers la DONNÉE FINANCIÈRE. Les deux repos
  prennent désormais `{from, to}` (renommage `synthesePeriodeParDevise` / type
  `SynthesePeriodeDevise` — ils n'agrègent plus « un mois ») ; le GROUP BY reste mensuel, donc
  sous plage les **mois d'extrémité sont PARTIELS**, ce que le nouveau `libellePeriode`
  (source unique, calculé par la page) annonce partout — en-tête, Top contreparties, tendance,
  `aria-label` du graphe — et la carte devient « Synthèse de la période ». Zéro régression sous
  preset (le mois d'ancrage ENTIER est repassé explicitement). Preuves en suite d'isolation.

- [ ] **GRAPHIQUES-PERIODE-DEDUP1 (P2, effort ~0,5 j, 2026-07-14) — unifier la période de
  `/graphiques` sur la barre de vue (retirer le sélecteur de période IN-PAGE).** Jumelle de
  TX-TOOLBAR-DEDUP1, **découverte au cadrage du lot A1** : `graphiques/page.tsx` ne prend même
  pas `searchParams` — le `PeriodeSwitcher` que la matrice A2 y montait ne filtrait donc RIEN,
  pendant que le vrai filtre (segmenté « Ce mois-ci / 30 j / 90 j / 12 mois ») vit in-page
  (`graphiques-feature.tsx:173`, Server Action `analyserCategoriesAction` + `periode-analyse.ts`).
  **Mitigation immédiate (A1)** : `periode: false` sur `/graphiques` → le no-op est retiré (zéro
  régression : le filtre in-page reste maître). **Reste à faire** : faire porter les bornes par
  l'URL (la barre devient source unique), ce qui suppose de **trancher le conflit de
  vocabulaire des presets** — la barre n'a pas de fenêtre glissante 30 j/90 j, Graphiques n'a
  pas de « Tout » — puis d'adapter la Server Action (aujourd'hui son contrat est « le client
  n'envoie qu'un preset fermé, jamais des dates »). ⚠️ Arbitrage PRODUIT requis avant code.
  **Déclencheur** : le chantier qui tranche la propriété des filtres (avec TX-TOOLBAR-DEDUP1),
  ou une demande terrain de plage précise sur les graphiques.

- [ ] **TX-TOOLBAR-DEDUP1 (P2, effort ~0,25 j, 2026-07-13) — retirer de la toolbar
  `/transactions` les contrôles qui DOUBLONNENT la barre de vue globale une fois celle-ci
  posée.** Corollaire de TOOLBAR-DATE-PRECISE1 (livrée) : dès que la plage de dates vit dans la
  toolbar globale, les bornes de date in-page (`transactions-toolbar.tsx:233-265`) et toute
  notion de période in-page deviennent une SECONDE source de filtre concurrente sur le même
  écran → à supprimer. PRÉCÉDENT exact déjà appliqué : le sélecteur de compte a été retiré de
  cette toolbar au profit du `PerimetreSwitcher` global (`transactions-toolbar.tsx:13-16`,
  « retrait feedback 0709 : doublon moche du sélecteur navbar ») → même geste pour les dates.
  ⚠️ Ne PAS retirer le filtre STATUT ni la recherche (propres à `/transactions`, absents de la
  toolbar globale). ⚠️ **DETTE PRÉCISÉE PAR A1 (2026-07-14)** : `/transactions` garde
  `periode: true` dans la matrice alors que sa page **ne lit PAS `?periode`** → ce
  PeriodeSwitcher est un **NO-OP** aujourd'hui (mensonge d'affichage, laissé INTACT sur
  arbitrage pour ne pas créer deux filtres de dates concurrents avant d'avoir retiré ceux de la
  page). Il est tracké : `transactions` est l'UNIQUE **exemption nommée** de la garde CI
  anti-mensonge (`SEGMENTS_PERIODE_NON_CABLEE`, `tests/unit/toolbar-config.test.ts`). **Ce lot
  DOIT supprimer cette exemption** (et non l'allonger) : retirer les dates in-page, câbler la
  page sur `resoudrePeriode(searchParams)`, puis passer `plageDates: true` dans la matrice.
  **Déclencheur** : maintenant que TOOLBAR-DATE-PRECISE1 est livrée (le remplaçant existe).

- [ ] **TX-RECHERCHE-LAYOUTSHIFT1 (P2, effort ~0,25-0,5 j, 2026-07-13) — UX : la recherche par
  libellé fait « sauter » l'écran à chaque rechargement de résultats.** ⚠️ NUANCE de recon
  (à ne pas mal implémenter) : la recherche EST DÉJÀ débouncée ~300 ms
  (`transactions-toolbar.tsx:48` `DEBOUNCE_RECHERCHE_MS`, effet `:118-131`) → ce n'est PAS
  « une requête par touche » qu'il faut corriger (le debounce existe déjà), mais le LAYOUT
  SHIFT au rechargement de la liste : elle se démonte/remonte et sa hauteur change, d'où le
  saut visuel. Piste : réserver la hauteur (skeleton à même gabarit / `min-height`), garder la
  liste montée pendant le refetch (état « en cours » superposé plutôt que unmount), ne pas
  faire clignoter le conteneur. Parent : `src/components/transactions/transactions-feature.tsx`.
  **Déclencheur** : `/design-review` (cf. PROD-UX-REVIEW1) OU plainte terrain sur le saut
  visuel. Pas d'isolation.

- [x] **TX-RECHERCHE-SOMME-NETTE1 (P2, effort ~0,5-1 j — dépend d'un agrégat serveur,
  2026-07-13) — FEATURE : afficher la SOMME NETTE des résultats filtrés (net = entrées −
  sorties) pendant une recherche.** ✅ LIVRÉ 2026-07-14 (branche `feat/tx-somme-nette`,
  plan `PLAN-tx-somme-nette.md`). Agrégat SERVEUR `sommeNetteParDevise` (SUM en SQL sous
  `withWorkspace`/RLS, GROUP BY devise, MÊMES filtres que la liste — schémas dérivés d'un
  même objet zod + prédicats SQL partagés, donc pas de divergence possible), Server Action
  `sommeNetteTransactionsAction`, bandeau pur `TransactionsSommeNette` (une ligne par
  devise, net coloré par son signe, `tabular-nums`, formatage via `src/lib/format-montant.ts`).
  Le total n'est demandé que sous filtre, et jamais au « Charger plus ». Preuve :
  `tests/isolation/transactions-somme-nette-isolation.test.ts` (24 cas — cross-tenant,
  périmètre entité, GROUP BY devise, tombstone, filtres croisés avec la liste, contre-preuve
  owner ; identité `net = entrées − sorties` vérifiée en centimes entiers BigInt, zéro float).
  ⚠️ **PIÈGE ÉVITÉ, à ne pas ré-introduire** : `transactions_cache.amount` est stocké en
  valeur ABSOLUE (`normaliserMontant` rejette tout signe ; `credit_debit` est la seule colonne
  sous CHECK qui porte le sens). Un agrégat `net = sum(amount)` ADDITIONNE donc les sorties aux
  entrées (total faux, toujours positif). On somme par `filter (where credit_debit = …)`, comme
  `cashflowParDevise`/`syntheseMoisParDevise` — une seule convention dans l'app. Le semis du
  test d'isolation reproduit la PRODUCTION (montants positifs) : le semer en négatif — comme le
  fait `transactions-isolation.test.ts`, où le signe est invisible — rendrait l'agrégat FAUX au
  VERT (vérifié par mutation : 13 cas tombent).

- [ ] **AGREGATS-NUMERIC-PLAFOND1 (P2, effort ~0,25 j, 2026-07-14) — DETTE : `::numeric(15,2)`
  sur une SOMME impose un plafond de précision (|x| < 10^13), pas seulement une échelle.**
  Relevé en cross-review de TX-RECHERCHE-SOMME-NETTE1 (probe PGlite à l'appui) : deux
  transactions au montant max accepté par `normaliserMontant` (13 chiffres) dans la même
  devise ⇒ `coalesce(sum(...),0)::numeric(15,2)` lève `numeric field overflow`, là où le
  `sum()` nu passe. Sites concernés : `cashflowParDevise` (`src/server/repositories/insights.ts`)
  et `syntheseMois`/`syntheseMoisParDevise` (`dashboard.ts`). ⚠️ **Fail-LOUD** (erreur, pas un
  chiffre faux) → ce n'est PAS une dette de montants au sens de la règle 9 (qui interdit la
  dette produisant un montant FAUX). Correctif : `round(x, 2)::text` — même garantie
  d'échelle (« 0.00 » sur un groupe vide), sans plafond ; c'est déjà ce qu'emploie
  `sommeNetteParDevise`. **Déclencheur** : premier import de volume réel, ou apparition d'une
  devise à faible valeur unitaire. Pas d'isolation (pas de changement de périmètre).

- [ ] **TX-LISTE-ECHEC-SILENCIEUX1 (P2, effort ~0,25-0,5 j, 2026-07-14) — BUG PRÉ-EXISTANT :
  un échec de rechargement de la liste est INVISIBLE quand des lignes sont déjà affichées.**
  `transactions-feature.tsx` : `corps` ne monte l'`AppErrorState` que si `erreur && !aDesResultats`
  → si `listerTransactionsAction` échoue pendant un re-fetch (changement de filtre), l'écran
  garde les lignes du filtre PRÉCÉDENT, sans aucun message. L'utilisateur croit voir le
  résultat de sa recherche. (Découvert en cross-review de TX-RECHERCHE-SOMME-NETTE1 ; le
  bandeau de total, lui, est déjà protégé — il n'est posé QUE si la liste l'est aussi.)
  Second volet : une Server Action qui **rejette** (session expirée → `exigerSessionWorkspace`
  hors du `try`) laisse `chargementEnCours="page"` pour toujours (pas de `try/finally` autour
  de `rechargerPremierePage`) → page figée, toolbar grisée. **Déclencheur** : plainte terrain
  « la recherche affiche les mauvaises lignes / la page ne répond plus », ou passage
  /design-review sur les états d'erreur. Pas d'isolation.

- [ ] **TX-SOMME-NETTE-HAUTEUR1 (P2, effort ~0,25 j, 2026-07-14) — UX : la hauteur du bandeau
  de total varie avec le NOMBRE DE DEVISES du jeu filtré.** Une devise = 1 ligne ; deux devises
  = 2 lignes + la note « jamais d'addition entre devises » (~44 px de plus). Si une frappe fait
  passer le jeu filtré de 2 devises à 1, le tableau saute d'autant — cousin de
  TX-RECHERCHE-LAYOUTSHIFT1 (#206), mais AU-DESSUS de la zone à hauteur plancher, donc non
  couvert par elle. Les cas franchement janky sont déjà tués (bandeau conservé pendant le
  re-fetch, wrapper non monté sur un total vide). Piste : créneau à hauteur réservée dès qu'un
  filtre est actif. **Déclencheur** : `/design-review` (mesure au navigateur — à faire avec
  captures, pas à l'aveugle). Pas d'isolation.

- [ ] **SCHEMA-FK-CONNECTION-COMPOSITE1 (P2, effort ~0,5 j — migration, 2026-07-14) — DURCISSEMENT :
  `bank_accounts.connection_id → bank_connections(id)` n'est PAS une FK composite scopée
  workspace.** CLAUDE.md impose le pattern `(x_id, workspace_id) → table(id, workspace_id)` pour
  `entity_id` ; `connection_id` y échappe. Rien EN BASE n'interdit donc qu'un compte du tenant A
  pointe une connexion du tenant B (la RLS `WITH CHECK` ne vérifie que le `workspace_id` de la
  LIGNE, pas celui de la ligne référencée). Conséquence concrète si ça arrivait : la LISTE
  `/transactions` (qui `innerJoin` bank_connections pour le nom d'institution) masquerait ces
  lignes, alors que les AGRÉGATS (qui ne joignent que bank_accounts) les compteraient → total ≠
  lignes affichées. Non atteignable par l'ingestion actuelle (relevé en cross-review, à titre de
  durcissement). **Déclencheur** : prochaine migration touchant `bank_accounts`, ou premier
  incident de cohérence liste/agrégat. Isolation : ajouter le cas au contract-test des FK.

### Fignolage layout §1.1 — pleine largeur (2026-07-08)

Chantier layout livré (retour Etienne « les div ne remplissent pas assez la page,
trop petites / vides ») : suppression des caps `max-w` sur les 5 pages de données
(Transactions, Règles, Banques, Graphiques → pleine largeur ; Échéances → layout
asymétrique §1.1 avec side-panel synthèse via `DashboardShell`). Deux points
volontairement différés (`PLAN-layout-pleine-largeur.md`) :

- [ ] **LAYOUT-ECHEANCES-SOLDE1 (P2, effort ~0,5 j) — carte « Solde » du side-panel
  Échéances non livrée.** §1.1 décrit la Carte 1 du panneau Échéances = solde courant
  (+ totaux clients/fournisseurs/global). Livré : le panneau porte la synthèse
  prévisionnelle seule. Ajouter le solde exige un nouveau fetch
  `soldesCourantsParDevise` sous `withWorkspace` dans `echeances/page.tsx` (la page ne
  charge aujourd'hui que règles/synthèse/catégories) + gestion multi-devise (une carte
  par devise, jamais d'addition FX, règle 8) → hors périmètre d'un chantier de layout.
  **Déclencheur** : prochaine itération Échéances, OU demande Etienne d'un solde
  contextuel dans le panneau — câbler `soldesCourantsParDevise` et monter une carte
  solde §1.3 (28px/700 primary) au-dessus de la synthèse dans l'`aside`.

- [ ] **LAYOUT-PANEL-MOBILE1 (P2, effort ~0,5 j) — side-panel Échéances masqué entre
  768 et 1024px.** `DashboardShell` masque l'`aside` sous `lg` (`hidden lg:flex`,
  pattern hérité du dashboard). Mitigation livrée : la synthèse est remontée INLINE
  sous `lg` (`lg:hidden`) → aucune perte de donnée, mais §1.1 prévoit sur 768-1280px un
  panneau « replié par défaut » (collapsible, ré-ouvrable), pas simplement masqué, et
  sous 768px une rangée KPI scrollable dédiée. **Déclencheur** : implémentation du
  side-panel collapsible §1.1 (chevron + état persisté) — le rendre repliable plutôt
  que `hidden lg:flex`, ce qui bénéficierait aussi au dashboard.

### Analyse par catégorie (camembert) — KPI d'en-tête (2026-07-08)

Chantier KPI livré (retour Etienne « page très maigre ») : fix libellé sentinelles
Omni-FI → « Non catégorisé » (L1), stats d'en-tête par devise moyenne/couverture/poste
dominant/concentration (L2+L3), variation vs période précédente dans la légende (L4).
Un lot du plan `PLAN-graphiques-kpi.md` a été **volontairement différé** :

- [ ] **GRAPHIQUES-KPI-L5-SOUSCATEGORIES1 (P2, effort ~1 j) — top marchands /
  sous-catégories par poste dominant NON livré.** Le plan L5 prévoyait, sous le poste
  dominant de chaque devise, un mini-classement des contreparties (`clean_label`) OU
  des sous-catégories Omni-FI qui le composent. Différé : (a) la donnée réelle est
  quasi intégralement NON catégorisée aujourd'hui (le poste dominant est souvent
  « Non catégorisé » → un sous-classement n'apporterait rien tant que la catégorisation
  n'a pas tourné) ; (b) l'agrégat existe déjà côté repo (`vendorsParConcentration`),
  donc pas de dette de schéma, juste du câblage UI. **Déclencheur** : quand la
  catégorisation Omni-FI (ou manuelle) couvre une part significative des opérations
  (couverture KPI « Catégorisé » > ~50 % sur un workspace réel) — brancher
  `vendorsParConcentration` filtré par catégorie dominante sous `StatsDevise`.

### Total central du donut — débordement corrigé, accès tactile ouvert (2026-07-21, PR `fix/donut-total-central`)

`DONUT-CENTRE-DEBORDE1` est **clos** : le total au centre passe au format compact
au-delà d'un seuil mesuré (9 chiffres avec symbole en préfixe, 8 avec code ISO en
suffixe), et reste PLEIN en deçà. Mesures et protocole :
`docs/qa/donut-total-central/README.md`. Un point reste ouvert :

- [ ] **DONUT-TOTAL-TACTILE1 (P2, effort ~0,5 j, ouvert 2026-07-21) — le total exact
  est inatteignable au TACTILE quand il est résumé.** Quand le montant dépasse le seuil,
  l'exact n'existe plus que via `title` (affordance souris) et `sr-only` (lecteur
  d'écran). Un utilisateur voyant sur mobile/tablette — un mode que `UI_GUIDELINES` §1.1
  supporte explicitement en lecture seule — n'a donc aucun chemin vers le montant exact.
  Le constat vient d'une cross-review et recoupe celui déjà consigné dans
  `components/ui/action-protegee.tsx:47-50` (« `title` … inatteignable au tactile »).
  **Pourquoi P2 et pas un correctif immédiat** : au-delà du seuil, le montant ne peut
  physiquement PAS s'écrire en entier dans l'anneau — le résoudre demande de l'exposer
  ailleurs dans la carte (en-tête à côté du nom de devise, ou ligne « Total » dans
  `StatsDevise`), donc un arbitrage de maquette qui appartient à l'humain, pas un
  câblage. Aucune donnée n'est fausse ni perdue : c'est un chemin d'ACCÈS qui manque.
  ⚠️ **Ne pas sous-estimer l'exposition** : pour MUR/USD/EUR la bascule ne tombe qu'à
  partir de 100 000 000, mais pour toute AUTRE devise (repli code ISO en suffixe, plus
  large de ~16 px) elle tombe dès **10 000 000** — un montant ordinaire, pas un cas
  extrême. Et sur ces cartes ni la légende (qui porte les parts, pas le total) ni
  `StatsDevise` (moyenne/opération) n'offrent de repli.
  **Déclencheur** : premier retour d'usage mobile sur `/graphiques`, ou
  le prochain lot qui touche `RepartitionDeviseCard`/`StatsDevise` — poser le total
  exact dans le flux de la carte à ce moment-là.

### Bandeau/sélecteur par titulaire — dettes ouvertes (2026-07-07)

- [ ] **TITULAIRE-GENERIQUE1 (P2, effort ~15 min) — sentinelle « Account Holder » en
  dur dans `src/lib/grouper-titulaire.ts` (`NOMS_TITULAIRE_GENERIQUES`).** C'est le
  `PartyName` PLACEHOLDER d'Omni-FI en sandbox (77/87 comptes) : relégué après les
  titulaires réellement nommés (S3, PLAN-selecteur-titulaire-accordeon.md) pour ne pas
  noyer AIRPORT HOTEL/DYOSPOWER/OMNICANE… **Déclencheur** : Omni-FI expose un flag de
  placeholder, OU la production fournit de vrais `PartyName` (le cas générique
  disparaît) → retirer la sentinelle et le tri en 3 strates à ce moment-là.

- [ ] **TITULAIRE-A11Y1 (P2, effort ~0,5 j) — pattern ARIA de l'accordéon dans la
  listbox « Par compte » à valider au lecteur d'écran.** L'en-tête de groupe
  (checkbox tri-état + bouton chevron `aria-expanded`) vit sous un `role="listbox"`
  qui n'admet canoniquement que `option`/`group` — certains lecteurs d'écran en mode
  listbox peuvent sauter ou mal annoncer ces contrôles (constat cross-review
  2026-07-07, confiance 6/10 ; `aria-label`/`aria-expanded`/focus-visible déjà
  posés). **Déclencheur** : premier audit accessibilité du produit, OU toute
  retouche du PerimetreSwitcher — envisager `treegrid` ou sortir l'en-tête de la
  listbox à ce moment-là.

- [ ] **TITULAIRE-GROUPE-FILTRE1 (P2, décision produit, effort ~0 si statu quo) —
  sémantique de la case de groupe PENDANT une recherche : à faire trancher par
  Etienne.** Comportement livré (assumé, pattern « sélectionner les visibles ») :
  tri-état et bascule agissent sur les comptes FILTRÉS du groupe — décocher un
  groupe pendant une recherche ne décoche PAS ses comptes cachés (ils restent
  postés) ; aucun compte invisible n'est jamais (dé)sélectionné par surprise.
  Alternative (position du réviseur, confiance 6/10) : agir sur le groupe ENTIER
  même filtré. **Déclencheur** : arbitrage d'Etienne à la revue de la PR — si
  statu quo, cocher cette entrée ; sinon ~0,25 j (passer les groupes complets au
  handler).

- [ ] **TX-SELECTEUR-A11Y1 (P2, effort ~0,25 j, 2026-07-09) — accordéon
  `CompteSelecteur` (/transactions) : radios dans un `<details>` replié = hors arbre
  d'accessibilité.** Le nouvel accordéon (C2, `src/components/transactions/comptes-selecteur.tsx`)
  est un `role="radiogroup"` où chaque compte est un `role="radio"` posé DANS un
  `<details>` : un volet replié met ses radios hors de l'arbre a11y — un lecteur
  d'écran ne les atteint pas sans d'abord ouvrir le `<summary>`. Mitigations déjà en
  place : « Tous les comptes » toujours visible hors accordéon, et le volet contenant
  la sélection courante est ouvert d'office (`contientSelection`). Distinct de
  [[TITULAIRE-A11Y1]] (qui vise la `listbox` du PerimetreSwitcher). Constat cross-review
  2026-07-09, confiance 6/10. **Déclencheur** : premier audit accessibilité, OU toute
  retouche du sélecteur — envisager un vrai composant divulgation clavier à ce moment.

- [ ] **TX-ISSELECTED-MORT1 (P2, effort ~0,5 j — migration + nettoyage, 2026-07-09) —
  colonne `bank_accounts.is_selected` MORTE-NÉE (toujours `true`).** Diagnostic C1 du
  chantier sélecteur (PLAN-transactions-selecteur-entites.md) : le bug supposé « banque
  invisible » via `listerComptes` filtrant `.where(eq(bankAccounts.isSelected, true))`
  (`src/server/repositories/dashboard.ts:202`, idem `:334`/`:396` et
  `orchestration.ts:971`/`:1270`) est un FAUX suspect. Preuve runtime (base locale
  d'Etienne, 87 comptes) : `is_selected = false` → **0 ligne** ; le filtre ne masque
  rien. Le seul écrivain applicatif est `upsertCompte` (`src/server/repositories/ingestion.ts`)
  qui pose `isSelected: c.isSelected` aux DEUX branches (INSERT `:132` ET UPDATE `:146`),
  avec un call site unique en prod (`orchestration.ts:339`, valeur `true`) + 2 seeds
  dev-only (aussi `true`). AUCUN chemin de désélection (widget/UI/migration) n'existe.
  Colonne `NOT NULL DEFAULT true` (`schema.ts:311`), commentaire « Account Selection
  (consentement) » : vestige d'une feature de sélection de comptes au widget jamais
  livrée. Le vrai « compte noyé » ressenti par Etienne = ergonomie du `<Select>` natif
  (résolu par C2). **Décision** : NE PAS retirer le filtre `isSelected=true` dans ce PR
  (change le contrat de 4 requêtes dashboard, hors périmètre C2 ; le filtre est un
  fail-safe correct tant que la colonne existe). **Déclencheur** : si Omni-FI livre une
  vraie « account selection » au widget → câbler l'écriture `false` ; SINON, à la
  prochaine passe de nettoyage schéma → migration expand-contract retirant la colonne +
  les 6 filtres. Dette d'ergonomie/schéma mort, PAS d'isolation (le filtre n'affecte ni
  le tenant ni l'entity_scope).

- [ ] **TITULAIRE-TEST-SCOPE1 (P2, effort ~0,25 j) — couverture de test : lecture
  titulaire sous `account_scope`/`view_filter` non testée directement.**
  `tests/isolation/dashboard-titulaire-isolation.test.ts` prouve tenant +
  `entity_scope`, mais pas le cas « membre scopé par compte/party (GUC
  `app.current_account_scope`) ou view_filter actif → le titulaire d'un compte
  masqué reste invisible ». Risque résiduel FAIBLE (même mécanique : policy
  RESTRICTIVE 0016 sur `bank_accounts`, héritage par la même jointure que le cas
  entité testé — constat cross-review confiance 5/10). **Déclencheur** : prochaine
  retouche de `listerComptes` ou de la suite d'isolation titulaire — ajouter le cas
  à ce moment-là (raccroché au chantier titulaire, feat/bandeau-titulaire-accordeon).

### Polish dashboard v2 — dettes ouvertes après UI-FLUX-CHART-POLISH (#147 mergée, 2026-06-30)

Chantier graphe de flux livré et mergé (#147 : courbe corrigée — déformation +
hauteur §4.2 ; barres — hauteur, responsive, labels, plafond largeur). Dettes
visuelles restantes ci-dessous. **NOTE DE REGROUPEMENT** : `UI-FLUX-CHART-GABARIT1`
+ `UI-FLUX-CHART-NICE-SCALE1` + `UI-FLUX-BARRE-LARGEUR-PROD1` + `UI-SOLDE-CARD-POLISH1`
sont **tous du polish visuel dashboard** (même validation = l'œil) → à traiter
idéalement en **UN chantier « polish dashboard v2 »** (évite 4 micro-PR et 4 cycles
recon/plan).

- [ ] **UI-FLUX-CHART-GABARIT1 (P2, effort ~0,25 j hors arbitrage) — la DIV conteneur
  du graphe est trop HAUTE → aspect surdimensionné/« enfantin » (le tracé lui-même est
  ok).** Cause = `HAUTEUR_ANCRE = clamp(380px, 55vh, 520px)` introduit en #147
  (`src/components/dashboard/flux-layout.ts`, constante UNIQUE → fix s'applique à la
  courbe ET aux barres d'un coup, trivial une fois la valeur décidée). ⚠️ **ARBITRAGE
  REQUIS** : le `55vh` vient de `UI_GUIDELINES.md` §4.2 — le baisser (ex. ~40-45vh, ou
  plafond plus bas) **s'écarte de la charte**. À trancher : ajuster la valeur **vs**
  respecter le design system (valider avec le mainteneur de la charte si besoin). Repère :
  on était à `300px` fixe le matin du 2026-06-30 (jugé « écrasé ») → viser **entre les
  deux**. **Déclencheur** : décision sur la valeur cible (chiffre + accord charte).

- [ ] **UI-FLUX-CHART-NICE-SCALE1 (P2, effort ~0,5 j) — échelle « nice » non implémentée :
  un mois à fort montant écrase les petits (courbe ET barres).** Reporté VOLONTAIREMENT du
  polish #147 (juger le visuel d'abord). Fix : arrondi du `max` (puissance de 10 / pas
  régulier) dans `flux-bars.tsx` (barres) + domaine Y de la courbe dans `flux-chart-trace.tsx`.
  ⚠️ Isolation : le `max` des barres vient de `maxFenetre` (`flux-projection.ts`) qui n'est
  importé QUE par `flux-bars.tsx` → post-traiter localement ou modifier `maxFenetre` est
  sans effet de bord ; NE PAS toucher `projeterSurGrille`/`MoisAffiche` (partagés avec le
  tableau « Évolution mensuelle »). **Déclencheur** : ce chantier polish dashboard v2.

- [ ] **UI-FLUX-BARRE-LARGEUR-PROD1 (P2, effort ~0,1 j) — `LARGEUR_BARRE_MAX=40px` jugé
  sur données CREUSES.** Le plafond de largeur de barre (`flux-bars.tsx`) a été réglé alors
  que les fenêtres courtes étaient vides (faute de seed 2026 dense au moment du QA).
  Revérifier le rendu des barres sur fenêtre courte avec de **vraies données 2026 denses**
  (seed réparé en #146) et ajuster la constante si besoin. **Déclencheur** : QA visuel sur
  données denses (ce chantier polish dashboard v2).

- [x] **UI-SOLDE-CARD-POLISH1 (P2, effort ~0,25 j) — carte SOLDE mal espacée.** ✅ LIVRÉ (PR #160). « Rs » collé
  au montant (manque de respiration devise↔chiffre — vérifier que l'espace fine insécable
  U+202F de `format-montant.ts` est bien rendue, sinon ajuster l'espacement de la carte) ;
  bloc « il y a Xh » / « Synchroniser » mal aligné/rangé à droite. Composant carte solde du
  side-panel (distinct du graphe). Niveau classes Tailwind a priori. **Déclencheur** : ce
  chantier polish dashboard v2.

- [ ] **UI-SOLDE-MULTIDEVISE-POLISH1 (P2, effort S-M — Front) — la pile « SOLDES PAR
  DEVISE » mélange deux formats et casse l'alignement des décimales.** Constaté sur prod
  réelle (2026-07-02, 5 devises : EUR/GBP/MUR/USD/ZAR). Composant `SoldesMultiDevises`
  (`src/components/dashboard/side-panel-kpi.tsx`). Défauts OBJECTIVÉS : (1) deux formats
  coexistent — les devises à symbole connu (EUR €, MUR Rs, USD $) rendent le symbole en
  COLONNE GAUCHE + montant nu à droite, tandis que les devises SANS symbole (GBP, ZAR)
  n'ont AUCUN symbole gauche et collent le code ISO en SUFFIXE (« 349,20 GBP », « 583,52
  ZAR ») → colonne gauche en dents de scie (2 lignes vides), deux layouts entrelacés ;
  (2) l'alignement des décimales §7-1 est CASSÉ pour les lignes à suffixe : le code ISO
  inline pousse le nombre à gauche, donc « 349,20 » / « 583,52 » ne s'alignent pas sur
  « 774 022,60 » / « 221 862 968,24 » / « 177 427,99 » — l'invariant même pour lequel la
  grille `[auto_1fr]` existe ; (3) devise de base (MUR/Rs) pas en tête (ordre arbitraire) ;
  (4) pas de rythme/séparation entre lignes. CAUSE : `symbolePrefixe` renvoie un symbole
  pour certaines devises et rien pour d'autres → repli `formatMontant(total, currency)`
  (suffixe ISO) pour les inconnues, d'où le mélange. PISTE FIX : UN seul format —
  indicateur de devise TOUJOURS en colonne gauche (symbole si connu, SINON le code ISO),
  montant TOUJOURS « nombre nu » aligné à droite, décimales alignées, jamais de suffixe
  inline → €/GBP/Rs/$/ZAR tous à gauche, tous les nombres alignés. ⚠️ Unifier DU MÊME
  COUP mono (`SoldeMonoDevise`) et multi sur le MÊME helper « nombre nu » ET la MÊME
  logique d'indicateur gauche (absorbe la micro-dette P3 déjà notée : rendu identique
  garanti du même montant ; aujourd'hui le mono d'une devise sans symbole afficherait le
  suffixe ISO, incohérent avec le € mono). ⚠️ NE PAS casser le groupement U+202F ni
  `tabular-nums` ; le « nombre nu » = `formatMontant(total, "")` aujourd'hui (hack chaîne
  vide) → préférer un vrai helper partagé ; ne pas changer le comportement global de
  `format-montant.ts` sans vérifier les autres appelants. Isolation : aucune (rendu).
  **Déclencheur** : cette passe QA sur données réelles multi-devises.

- [ ] **UI-FLUX-HOOK-MIGRATION1 (P3, effort ~0,2 j, NON bloquant) — une seule implémentation
  du ResizeObserver.** La courbe (`flux-chart-trace.tsx`) garde son `ResizeObserver` INLINE ;
  les barres utilisent le hook extrait `use-dimensions-svg.ts` (#147). Migrer la courbe vers
  le hook partagé pour n'avoir qu'une implémentation (anti-duplication). **Déclencheur** :
  prochaine retouche de la courbe OU passage anti-dette. Raccroché au plus tard à un chantier
  nommé (règle 9, P3 ne pourrit pas).

- [ ] **DASH-ETAT-DISCRIMINANT1 (P3, effort ~0,3 j — décision comportementale AVANT code) —
  `page.tsx` appelle encore `cashflowParDevise` dont le SEUL rôle résiduel est d'alimenter le
  champ `flux`, lui-même consommé UNIQUEMENT par `choisirEtatDashboard` (discriminant
  partiel/complet).** Contexte : depuis la PR #150 (fix « courbe effondrée »), la courbe ne
  lit plus `flux` (elle dérive de `serieMensuelle` projetée) → `flux` n'est plus qu'un
  discriminant d'état d'onboarding. Candidat : basculer le discriminant sur `serieMensuelle`
  (ex. `serieMensuelle.length === 0`, ou une variante scopée à la devise de base) puis retirer
  du dashboard le champ `flux` + l'appel `cashflowParDevise` (l.98) + `fromFlux`/`to` (l.76)
  → **une requête SQL en moins par chargement du dashboard**. ⚠️ NE PAS toucher la DÉFINITION
  de `cashflowParDevise` (`insights.ts`, testée en isolation directe) ni son export barrel —
  on retire un APPELANT, pas la capacité. ⚠️ **Touche la logique d'onboarding** (partiel =
  « synchro en cours ») ET un **cas de bord** : un workspace n'ayant QUE des transactions hors
  devise de base (base MUR, tx uniquement USD) passerait de « partiel » à « complet » avec la
  variante simple `serieMensuelle.length` — la variante scopée devise l'évite mais élargit la
  signature de `choisirEtatDashboard`. **Chantier DÉDIÉ logique d'état, JAMAIS un rider d'un
  autre PR** (risque de régression d'onboarding silencieuse). **Déclencheur** : décision
  comportementale sur le cas USD-only (accepter l'écart simple vs préserver la sémantique
  mono-devise), puis chantier nommé. Origine : rebond de la PR #150 (revue Tech Lead 2026-07-01).

### Infra — découverte à clarifier (2026-06-30)

- [ ] **REPO-PARENT-IMBRIQUE1 (P2, effort ~0,25 j, NE PAS toucher à l'aveugle) — un dépôt git
  PARENT existe dans `Desktop/TYGR/`** (branche `feature/epic3-dashboard-ui-states` + dossier
  `worktrees/`), DISTINCT de `Desktop/TYGR/tygr-app/` (le vrai dépôt applicatif). Sans impact
  tant qu'on travaille DEPUIS `tygr-app/`, mais **piège latent** : une commande git lancée du
  mauvais dossier opère sur le parent. À clarifier : que contient-il, encore utile, archiver ?
  **Réflexe immédiat** : `git rev-parse --show-toplevel` AVANT toute commande git sensible
  (doit afficher `…/tygr-app`). **Déclencheur** : avant toute opération git destructive à la
  racine OU revue d'hygiène du poste. (Cohérent avec la directive mémoire « racine git ».)

### Granularité de synchronisation — cadrage par banque (2026-07-16, cf. `PLAN-sync-granularite-par-banque.md`)

Constat confirmé par le code : `synchroniserConnexionsAction` (zéro argument) rafraîchit
**TOUTES** les connexions du workspace d'un coup. La primitive scopée-connexion
`resynchroniserConnexion` (orchestration.ts:1557) existe déjà mais n'est câblée qu'à la
réparation MFA. Amont : `POST /sync/{ConnectionId}` est la SEULE granularité de
déclenchement (pas de sync par compte), cooldown 1/15 min/connexion.

- [ ] **SYNC-COOLDOWN-WATERMARK1 (P1, effort ~0,25 j investigation, 2026-07-16) —
  watermark cooldown non fiable + sync auto post-connexion.** Diagnostic Absa (2026-07-16) :
  `next_sync_available_at = NULL` alors qu'un sync avait tourné, et un sync s'est déclenché
  ~7 min après la connexion **sans déclenchement manuel**. Deux questions : (a) l'onboarding
  auto-déclenche-t-il un premier sync ? (b) pourquoi `NextSyncAvailableAt` n'est-il pas
  persisté ? **Bloquant** pour toute UI qui afficherait un compte-à-rebours de cooldown par
  banque (sinon l'UI ment). **Déclencheur** : avant de câbler l'UI par-banque
  (SYNC-GRANULARITE-BANQUE1), ou premier retour « le bouton reste grisé/actif à tort ».

- [ ] **SYNC-GRANULARITE-BANQUE1 (P2, effort ~1–1,5 j, 2026-07-16) — synchronisation PAR
  BANQUE (grain natif Omni-FI).** Exposer `resynchroniserConnexion` via une Server Action
  utilisateur normale (`synchroniserUneConnexionAction(connectionId)`, zod uuid, RLS tenant,
  gating `peutModifier`, hors-tenant → 404) + UI par carte de banque sur /banques (bouton +
  pastille fraîcheur + cooldown). Garder le sync global sur le dashboard. **NE PAS** offrir
  de refresh « par compte » (impossible amont — `POST /sync` est par connexion ; le « par
  compte » se règle via `is_selected`, inclusion d'ingestion, déjà en base). Bénéfice réel :
  ne plus verrouiller 15 min toutes les banques pour n'en rafraîchir qu'une. **Déclencheur** :
  décision produit d'ouvrir le par-banque, APRÈS résolution de SYNC-COOLDOWN-WATERMARK1.

### Prévisionnel / Scénarios / Ventilation tabulaire — benchmark FYGR (2026-07-16, cf. `PLAN-cadrage-scenario-previsionnel-fygr.md`)

Benchmark des captures `docs/benchmarks/FYGR/` (vue tableau catégories × mois « Réalisé à
date → Prévision », scénarios nommés what-if, échéances = factures Customers/Suppliers
alimentant la prévision). ⚠️ La **playlist YouTube n'a pas pu être analysée** (limite
outil) — cadrage sur captures seules ; visionnage humain requis pour les interactions non
capturées. Chaîne de dépendances, pas un chantier unique → découpage en 4 incréments A→D.

- [ ] **PROD-SCENARIO-FYGR1 (P2, CADRAGE POSÉ — décision produit requise, 2026-07-16) —
  roadmap prévisionnel + scénarios en 4 incréments.** A = vue tableau du RÉALISÉ (cat × mois,
  par devise) ; B = onglet Échéances (registre factures, répond à NAV-ECHEANCES1) ; C =
  prévisionnel simple (dérivé des échéances) ; D = scénarios nommés. Décisions bloquantes
  avant C/D : méthode de projection, matrice par devise vs total converti (DASH-FX1),
  nettage des virements internes, granularité entité. Pré-requis transverse : axe CATÉGORIE
  (`categorySummary`, PROD-GRAPHS-FYGR1). **Déclencheur** : arbitrage produit sur l'ordre
  A→D et la méthode de projection ; OU dépôt de captures FYGR complémentaires (édition
  scénario / saisie prévision). Absorbe la question métier de **NAV-ECHEANCES1** (Échéances =
  factures à venir qui nourrissent la prévision).

### Chantiers PRODUIT à cadrer (pas encore lancés, 2026-06-30)

- [~] **REGLES-OPERATIONNEL1 (P2, effort à chiffrer après recon) — onglet Règles jugé « pas
  opérationnel ».** Amélioration d'EXISTANT (`src/app/(workspace)/regles/`, moteur
  `categorization_rules`) → **recon de l'existant nécessaire** pour comprendre ce qui manque
  AVANT de planifier (point de départ plus clair que les pages neuves). **Déclencheur** : début
  de chantier Règles (recon d'abord). **EN COURS** : chantier « Règles v1 — Édition + Priorité »
  (branche `feature/regles-edition-priorite`, 2026-07-01) livre l'édition, la réactivation via
  édition, le réordonnancement par priorité (drag + flèches) et la garde de rôle serveur.

- [ ] **REGLE-REORDER-CONCUR1 (P2, effort ~0,25 j, 2026-07-01) — réordonnancement des règles en
  last-write-wins.** `reordonnerRegles` (repo) réécrit l'ensemble des priorités des règles
  actives en une transaction, SANS verrou optimiste. Deux gestionnaires qui réordonnent (ou
  créent, cf. défaut `max+1`) en parallèle → le dernier COMMIT gagne. **Pas d'incohérence de
  données** (les priorités restent une permutation valide, l'ordre total `asc(priority),
  asc(createdAt)` reste déterministe) → risque purement cosmétique (un réordre peut être écrasé
  silencieusement). Parade possible : version optimiste (colonne `updated_at`/compteur) ou
  `SELECT … FOR UPDATE` sur l'ensemble actif. **Déclencheur** : premier workspace réel avec
  plusieurs gestionnaires qui éditent les règles simultanément, OU signalement « mon
  réordonnancement a sauté ».

- [ ] **NAV-GRAPHIQUES1 (P2, CADRAGE PRODUIT requis) — activer l'onglet Graphiques** (page à
  créer / aujourd'hui vide ou inactive). **Cadrage produit d'abord** : quel contenu ? quels
  graphes ? réutilise-t-il le moteur flux (`flux-*`, insights) ou autre ? Benchmark/challenger
  à faire. **Déclencheur** : décision produit sur le contenu de la page.

- [ ] **NAV-ECHEANCES1 (P2, CADRAGE PRODUIT requis — décision métier clawdy/Omnicane) — activer
  l'onglet Échéances** (page neuve). Sujet MÉTIER, pas technique : prévisionnel ? factures à
  venir ? rappels ? **Déclencheur** : décision produit/métier sur la nature de l'écran.

### Sélecteur de périmètre (L8b-1) — bug d'auto-amputation corrigé (2026-06-30)

Le `PerimetreSwitcher` ne s'auto-ampute plus : la liste qui le peuple reflète
désormais le DROIT COMPLET du membre (lecture en session sans `viewFilter` dans le
layout), pas le filtre actif. Affordance de reset ajoutée (« Tout effacer » +
option « Groupe » mise en évidence). Dette UI ouverte par ce chantier :

- [ ] **UI-PERIMETRE-ACCORDEON1 (P2, effort ~0,5 j) — sélecteur de périmètre en
  accordéon banque→comptes (tri-state sur la banque : tout / partiel / rien) pour
  gérer les gros volumes de comptes.** Aujourd'hui le sélecteur est une **liste
  PLATE** de comptes (`src/components/shell/perimetre-switcher.tsx`) : parfait à
  faible volume, mais illisible quand un manager a des dizaines de comptes répartis
  sur plusieurs banques. Cible : grouper les comptes par `institutionName`, avec une
  case par banque à **trois états** (tous cochés / partiellement cochés / aucun) qui
  coche/décoche tous ses comptes d'un coup, et une section repliable par banque.
  Pas de changement serveur (la sélection postée reste une liste de `bankAccountId`,
  la RLS intersecte). **Déclencheur** : volumes réels — premier manager avec des
  dizaines de comptes / plusieurs banques (retour terrain « la liste est trop
  longue »). Tant que les workspaces restent à faible volume, la liste plate suffit.

> **RÉVISION UI-PERIMETRE-ACCORDEON1 (clawdy 2026-07-02, données prod réelles)** : l'axe
> de groupement passe de banque→comptes à **Groupe→Entité→comptes** (accordéon, tri-state
> par entité ET par Groupe : tout / partiel / rien). Même mécanique tri-state que la
> version banque, axe différent — cohérent avec UI-ACCOUNTS-ACCORDEON-ENTITE1
> (organisation entity-first). Le sélecteur (`src/components/shell/perimetre-switcher.tsx`)
> est aujourd'hui une liste PLATE ; cible = accordéon par entité, l'option « Groupe »
> restant le niveau haut (tout le périmètre). MÊME DÉPENDANCE : entités peuplées
> (ENTITY-PARTY1) + ENTITY-UI1. Cette entrée ABSORBE la remarque « sélection des entités
> par groupe » — pas de ticket séparé. Cross-ref PERIMETRE-ENTITE-DERIVE1.

- [ ] **PERIMETRE-ENTITE-DERIVE1 (P2, effort ~1 j) — le filtre « par entité » dérive
  si l'ADMIN réassigne un compte.** L'axe Entité du sélecteur (L8b-2, stratégie a) pose
  dans le token la **liste des `bankAccountId` de l'entité à l'instant T** (le token ne
  stocke pas d'`entity_id`). Si l'ADMIN réassigne ensuite un compte à/hors de l'entité,
  la liste figée ne suit pas → le libellé re-dérivé (`entiteDuFiltre`,
  `src/components/shell/perimetre-switcher.tsx`) cesse de correspondre exactement et
  retombe sur « N comptes » (pas de mensonge, mais on perd le nom). **Pas une dette
  d'isolation** (la RLS reste la sécurité ; le filtre ne peut que rétrécir). **Déclencheur** :
  réassignation de compte fréquente OU besoin produit d'un libellé entité stable.
  **Résolution** : stratégie (b) (GUC `view_filter_entity` dédié, axe RLS complet) ou
  recalcul du filtre au login / au changement d'assignation. Tant que les assignations
  sont rares, la dérive est acceptable (péremption assumée par le plan L8b-2).

### Verrou production sur hôte partagé — livré (2026-06-26)

`config.ts` autorise désormais `OMNIFI_ENV="production"` sur l'hôte PARTAGÉ
`api-stage.omni-fi.co` via l'opt-in `OMNIFI_AUTORISER_PRODUCTION="1"` (l'env vient des
clés, pas de l'hôte — confirmé tuteur). Branche `feat/verrou-prod-hote-partage`. Plan :
`PLAN-verrou-prod-hote-partage.md`. Dettes/étapes ouvertes par ce chantier :

- [ ] **PROD-DATA-LOCAL1 (P1, déclencheur : tout usage DURABLE de vraie donnée) —
  vraie donnée bancaire stockée sur base Docker LOCALE.** Constat 2026-06-26 : les clés
  prod pointent vers la stack Postgres conteneurisée du poste de dev → de la PII bancaire
  réelle (soldes, libellés, relevés) vit en local, en clair via `.env`, sans chiffrement
  au repos garanti ni backup ni contrôle d'accès. Viole CLAUDE.md règle 8 (« pas de dump
  de prod en local »). TOLÉRABLE pour une démo/un test ponctuel ; INTERDIT comme usage
  durable. Résolution : base Neon dédiée + pipeline `provision → migrate → deploy`, et ne
  jamais conserver de vraie donnée sur un poste. Effort : ~0,5j (infra base) hors code app.

- [x] **PROD-ENDUSER1 (P1, déclencheur : avant le 1er parcours « connecter une banque »
  en prod) — créer + inscrire l'EndUser de production. 🚧 BLOQUÉ côté Omni-FI (2026-06-26).**
  ✅ **RÉSOLU 2026-07-02** : connexions bancaires RÉELLES établies en environnement prod
  (77 comptes découverts, soldes multi-devises remontés) → le `401 Invalid client
  credentials` est LEVÉ, les clés prod sont désormais reconnues. La bascule vraie-donnée
  est opérationnelle. (Reste historique du blocage ci-dessous pour trace.)
  L'annuaire des EndUsers Omni-FI est rattaché aux CLÉS : l'EndUser sandbox actuel est
  inconnu des clés prod (`link-token` échouerait). Étapes : `POST /clients/end-users` avec
  les clés prod → écrire la valeur reçue dans `workspaces.omnifi_client_user_id` (UPDATE ;
  le code lit la colonne, pas `.env` — `orchestration.ts:109`). Réversible (remettre
  l'EndUser sandbox). Hors code, opérationnel. Cf. `docs/BASCULE-PRODUCTION-OMNIFI.md` § piège n°3.
  **BLOCAGE** : `POST /clients/end-users` avec les clés PROD renvoie `401 Invalid client
  credentials` sur `api-stage.omni-fi.co`. Diagnostiqué : ce n'est PAS notre commande (test
  de contrôle avec les clés SANDBOX du `.env` → `201 Created`), ni une faute de copie (clés
  prod aux bonnes longueurs : client_id 39 car., secret 72 car.). ⇒ Les clés prod ne sont
  pas reconnues par ce serveur (jamais générées / secret périmé — affiché 1 seule fois /
  autre environnement). **Action requise (user + tuteur)** : (re)générer le secret via
  `POST /clients/{ApiClientId}/keys/generate` OU faire confirmer par le tuteur qu'un
  ApiClient de prod ACTIF existe bien sur `api-stage`. Tant que ce 401 n'est pas levé, la
  bascule vraie donnée est impossible (le verrou code, lui, est PRÊT — PR #124 mergée).

- [ ] **PROD-ENDUSER-DIAG-CLEANUP (P2, déclencheur : prochain ménage sandbox) — EndUser de
  contrôle résiduel.** Le diagnostic du 401 (2026-06-26) a créé `tygr-diag-controle-sandbox`
  dans l'annuaire SANDBOX (test prouvant la commande). Omni-FI n'expose pas de `DELETE
  /clients/end-users/{id}` (→ 404 HTML). Résidu inerte (identifiant sans donnée bancaire,
  bac à sable). Le purger si Omni-FI ajoute une route de suppression, sinon l'ignorer.

### Sync incomplet — lecture partielle livrée, ingestion pilotée par webhook à faire (2026-07-13)

Incident prod : « le sync importe 0 transaction » alors que la donnée était lisible chez
Omni-FI (67 transactions sur le 1er compte). Cause RÉELLE (le diagnostic initial pointait un
statut `INTERRUPTED` — **qui n'existe pas** : absent de la doc, du backend Django et du
runtime) : un scrape peut durer BIEN plus longtemps que le plafond de polling de 120 s
(observé : `RETRIEVING` pendant 6 min+, soit 3×). Le job n'étant ni terminal ni en échec, le
`TIMEOUT` était traduit en `SKIP_FAILED (POLL_TIMEOUT)` → la connexion était **sautée** →
aucune transaction ingérée, alors que les données partielles étaient disponibles. Aggravant :
la contrainte amont `unique_active_sync_job_per_account` fait retomber chaque nouveau clic sur
le MÊME job en cours → le symptôme était **permanent**, pas intermittent.

Corrigé (branche `fix/sync-timeout-lecture-partielle`) : le timeout devient `INCOMPLET` (on
LIT quand même — la lecture ne dépend pas de la complétion du job, l'upsert est idempotent/
append-only), la nature partielle remonte jusqu'à l'UI, et l'union des statuts amont est
OUVERTE (un statut inconnu n'est plus un mensonge de typage).

- [ ] **SYNC-WEBHOOK-INGEST1 (P1, déclencheur : premier scrape qui dépasse durablement les
  120 s en prod — donc DÉJÀ atteint ; à traiter avant d'élargir la base d'utilisateurs) —
  ingestion déclenchée par le webhook `sync.completed` au lieu du polling synchrone.**
  Le correctif ci-dessus rend le partiel HONNÊTE, il ne le rend pas COMPLET : tant que
  l'ingestion vit dans une Server Action, elle ne peut pas attendre un scrape de plusieurs
  minutes (timeout de plateforme), donc l'utilisateur devra toujours relancer pour obtenir la
  fin des transactions. La vraie sortie est événementielle : Omni-FI publie déjà
  `sync.completed` / `sync.failed` (`docs/documentation_api.md` § Webhooks) — il faut router
  ces événements vers l'ingestion. Portée : route `/api/webhooks/omnifi` (la résolution
  `connection → workspace_id` sous `tygr_service` est une exception DÉJÀ documentée en
  CLAUDE.md règle 2), idempotence (rejeu d'événement), cas ajouté à la suite isolation IDOR.
  Effort : ~1-1,5j. Tant que ce n'est pas fait, le message « relancez dans quelques minutes »
  est le contrat assumé avec l'utilisateur.

#### Dettes ouvertes par la revue contradictoire de la PR #202 (2026-07-13)

Le faux « Comptes à jour » est fermé sur les 3 parcours qui le produisaient (dashboard,
/banques, chemin réparation) : le TEXTE vient désormais du serveur et le TON de
`registreSynchro` (pur, testé), le vert exigeant zéro réserve. Restent 3 trous NOMMÉS, aucun
ne touchant l'isolation, l'append-only ni les montants (donc consignables, cf. règle 9) :

- [ ] **SYNC-FAILED-COOLDOWN1 (P1, déclencheur : première remontée support « ma banque
  affiche à jour alors qu'elle a planté ») — un dernier job FAILED sous cooldown ressort en
  RATE_LIMITED, donc en VERT.** Mode de défaillance : 1er clic → scrape FAILED → message
  d'échec correct. 2ᵉ clic dans les 15 min → `cooldownActif` → `jobEnCoursNonTerminal` rend
  `null` (le job est terminal) → RATE_LIMITED → aucune réserve → « à jour » en vert, alors
  que le dernier scrape a échoué et que les données affichées datent du scrape précédent.
  C'est le MÊME motif que le 2ᵉ clic corrigé ici, sur l'autre branche. Fix pressenti :
  `jobEnCoursNonTerminal` tient déjà le statut en main — lui faire remonter un dernier job
  FAILED comme réserve (sans repasser en `continue` : on veut lire le cache ET le dire).
  Effort : ~2h + tests. PRÉEXISTANT à la PR #202, non introduit par elle.

- [ ] **SYNC-MFA-COOLDOWN1 (P2, déclencheur : chantier MFA/réparation) — un job en
  `OTP_REQUESTED` sous cooldown ne propose PAS « Reconnecter ».** Il ressort en RATE_LIMITED
  (« déjà synchronisée récemment »), sans `reparation` : l'utilisateur n'a aucun chemin vers
  la vérification qui l'attend. `jobEnCoursNonTerminal` (orchestration.ts) est l'endroit exact
  où ça se referme — la fonction tient le `jobId` et le statut OTP, et les jette aujourd'hui
  (choix DÉLIBÉRÉ de cette PR : ne pas élargir la sémantique du chemin MFA dans un fix de
  timeout). Effort : ~2h. PRÉEXISTANT.

- [ ] **SYNC-INCOMPLET-DURABLE1 (P1, ARBITRÉ le 2026-07-13 — option (b) retenue, PR dédiée) —
  persister l'incomplétude, au lieu de la signaler par un canal volatil.** Aujourd'hui
  « Synchronisation incomplète » est un état React ÉPHÉMÈRE (perdu au reload), tandis que
  `last_synced_at` est PERSISTANT : après rechargement, l'utilisateur passif voit des pastilles
  de fraîcheur VERTES et plus aucune trace du partiel. L'incomplétude est donc dite par un canal
  volatil et masquée par un canal durable.
  **Option (a) — ne pas appeler `marquerSynchronise` sur le chemin INCOMPLET — a été ÉCARTÉE**,
  et la raison doit survivre à cette décision : le SOLDE vient de `GET /accounts` (via
  `upsertCompte`), un chemin DISTINCT du job de scrape qui alimente les transactions. La pastille
  qualifie le solde, or le solde VIENT d'être relu — (a) dégraderait un signal JUSTE (fraîcheur)
  pour compenser l'absence d'un autre (complétude). On écrase deux notions sur un seul champ ;
  la sortie est de les SÉPARER.
  Portée : colonnes `sync_partiel_depuis` + `sync_dernier_statut` sur `bank_connections`
  (éditable, non append-only ; `tenant_isolation` déjà en place ⇒ pas de nouvelle policy, mais
  écriture OBLIGATOIREMENT sous `executer`/`withWorkspace`), remise à NULL au prochain sync
  COMPLETED, badge durable côté dashboard, cas ajouté à la suite isolation. Migration Drizzle.
  Effort : ~2-3h. Exige un plan écrit AVANT toute ligne (règle 1 : changement de schéma).

- [ ] **SYNC-STATUT-SCRAPING1 (P2, déclencheur : l'amont émet `SCRAPING` sur l'API) — le
  widget afficherait « initialisation » pendant un vrai scrape.** `PHASE_PAR_STATUT`
  (machine-mfa.ts) ne mappe que les statuts de `OmniFiSyncStatusConnu` ; `SCRAPING` (que le
  backend Django persiste, là où l'API renvoie `RETRIEVING`) tomberait sur le repli
  `initialisation` au lieu de `synchronisation`. Purement cosmétique (aucun `undefined`,
  aucun faux terminal). À traiter le jour où l'on OBSERVE `SCRAPING` sur le fil — pas avant :
  l'ajouter à l'union fermée sans preuve serait inventer un contrat amont. Effort : 15 min.

### Sync réel Omni-FI — déclenchement de scraping (POST /sync) livré (2026-06-25)

Le bouton « Synchroniser mes comptes » DÉCLENCHE désormais un sync réel
(`POST /sync/{ConnectionId}` ApiKey → job → attente) AVANT la boucle de lecture
existante, au lieu de relire seulement le cache amont (branche
`feat/omnifi-sync-trigger`). Contrat confirmé empiriquement en sandbox
(`scripts/diag-sync.ts` : 201 `{JobId,PENDING}`, COMPLETED parfois à t+0s).
Dettes ouvertes par la revue contradictoire de ce chantier :

- [x] **SYNC-REPAIR-UI1 (P1, point de DÉPLOIEMENT du widget en prod) — LIVRÉ
  (branche `feature/sync-repair-ui`, 2026-06-25) : réouverture du widget natif en mode
  REPAIR quand une banque retombe en MFA.** Le composant
  `src/components/widget/bank-connect-widget.tsx` consomme désormais `r.reparation` (de
  `synchroniserConnexionsAction` / `finaliserConnexionDropinAction`) et affiche un bouton
  « Reconnecter » par connexion (dans `WidgetFeedback`). Au clic :
  `creerLinkTokenRepairAction(connectionId, jobId, redirectOrigin)` → LinkToken `Mode:
  REPAIR` (champs `ConnectionId`/`JobId` ajoutés à `CreerLinkTokenParams`) → remontage du
  MÊME `OmniFiLinkLauncher` (le widget gère l'OTP en interne, cf. vendor README §MFA
  handling) → `onSuccess` relance `resynchroniserConnexionApresReparationAction`
  (re-découverte + `synchroniserCompte`, ingestion INCHANGÉE) et retire la connexion de
  l'état réparation. Sécurité : gating MANAGER/ADMIN + ClientUserId scopé + garde anti-IDOR
  `ReparationContexteInvalideError` (la connexion doit appartenir au tenant) prouvée par
  la suite isolation (`tests/isolation/widget-orchestration-isolation.test.ts`, +7 cas).
  Cas couverts : widget fermé sans finir (état réparation conservé, bouton recliquable) ;
  échec de re-lecture fail-soft ; re-sync re-OTP (re-signalé avec le NOUVEAU jobId).
  **Reste (Human-in-the-Loop, NON une dette de code)** : valider le PARCOURS INTERACTIF
  réel (clic → écran code du widget → re-lecture) sur le serveur HTTPS avec des clés
  sandbox — le widget natif n'est pas capturable en headless (Visual QA des états statiques
  fait via route démo `/demo/banque-connexion` blocs 5–6, cert HTTPS local rejeté par
  Chromium → rendu CSS inliné, cf. [[visual-qa-serveur-https-voisin]]).

- [ ] **SYNC-RATELIMIT-UI1 (P2) — exploiter `EtatFinalisation.rateLimited` côté UI.** Le
  serveur remonte `rateLimited = [{connectionId, nextSyncAt}]` (connexions en cooldown
  « 1 sync / 15 min », non re-déclenchées) et un message texte avec délai relatif. Le
  champ structuré est pour l'instant inerte côté client (seul le texte de `succes` est
  affiché). **À faire** : afficher un compte à rebours / désactiver le bouton jusqu'à
  `nextSyncAt`. **Déclencheur** : retour utilisateur « je clique et il ne se passe
  rien » sur des clics rapprochés. **Effort** : S.

- [ ] **SYNC-LONGRUN1 (P1, point de DÉPLOIEMENT — workspace multi-connexions Omnicane) —
  déporter l'attente du job hors de la Server Action interactive.**
  `synchroniserConnexionsDepuisOmnifi` poll chaque job jusqu'à `POLL_SYNC_PLAFOND_MS`
  (120 s) **séquentiellement** par connexion : sur N connexions lentes, l'action peut
  approcher `N × 120 s` et dépasser le plafond d'exécution de la plateforme (Next/Vercel),
  l'utilisateur reçoit alors le message générique ET perd les imports des connexions
  déjà traitées (le `return` final n'est pas atteint). Le cas métier explicite est
  « 1 connexion = N entités » (CLAUDE.md Entités) → plusieurs connexions par workspace.
  **À faire** : déporter le déclenchement+attente vers un job d'arrière-plan (Inngest est
  au stack) et notifier l'UI à la complétion, ou borner agressivement le plafond +
  paralléliser. **Déclencheur** : premier workspace réel à ≥3 connexions actives, OU
  premier timeout plateforme observé sur ce bouton. **Effort** : M/L (intro d'un job
  Inngest). Lien : la même infra servira un futur trigger automatique / webhooks.

### Parcours utilisateur complet — bilan QA runtime (2026-06-24)

Parcours connecté de bout en bout (navigateur headless, compte `enardou@omni-fi.co`,
base locale 12 comptes / 260+ tx sandbox), branche `feature/regles-form-validation-ux`.
Le cœur métier (consulter la trésorerie, ventiler, automatiser par règles, déconnexion)
est **réel, persistant et correct sur desktop ≥1024px** ; les constats ci-dessous sont
des **trous de complétude / onboarding / responsive**, pas des bugs de logique. **Aucun**
ne touche l'isolation tenant, l'append-only ni les montants (sinon il serait corrigé
immédiatement, pas consigné). Preuves runtime : POST de ventilation `200` → statut
« Complet » ; règle créée `200` + « Ré-analyser » a recatégorisé 7 transactions ;
logout → `/login` et accès direct post-logout re-redirigé.

- [x] **QA-ONBOARD-CATEG1 (P1, point d'ONBOARDING — premier utilisateur) — seeder les
  catégories par défaut à la création d'un workspace.** ✅ RÉSOLU 2026-07-06 (branche
  `feat/onboard-seed-categories`, en attente de revue/merge). Constaté : le picker de
  ventilation affichait « Aucune catégorie ne correspond » sur un champ **vide** — un
  workspace neuf n'avait **aucune** catégorie et rien ne déclenchait le seed à sa création.
  **Livré, deux volets** : (A) `scripts/seed-admin.mjs` et `scripts/seed-omnifi-demo.ts`
  sèment le référentiel à la création du workspace, via une lib partagée
  `scripts/seed-categories-lib.mjs` (idempotente, verrou consultatif) ; le référentiel a
  été déplacé `scripts/categories-referentiel.mjs` → `src/lib/categories-referentiel.mjs`
  (importable côté app). (B) CTA « Importer les catégories standard » dans le picker vide
  → Server Action `importerCategoriesStandardAction` → repository
  `importerReferentielCategories` (sous `withWorkspace`, garde ADMIN, RLS). Preuves :
  `tests/isolation/seed-categories-isolation.test.ts` (9 cas : seed CLI, tout-ou-rien,
  CTA admin/idempotence/refus non-admin/intra-tenant/tout-archivé). Cf. mémoire
  `seed-categories-commande-locale`.

- [ ] **QA-RESPONSIVE-SHELL1 (P1, point de DÉPLOIEMENT si usage tablette/mobile attendu) —
  condenser le header sous le breakpoint (débordement horizontal global).** Mesuré au
  DOM : `scrollWidth` ≈ **950px** quelle que soit la page → débordement de **+575px en
  mobile (375px)** et **+182px en tablette portrait (768px)** ; OK seulement à partir de
  **1024px**. Identique sur toutes les routes (transactions, regles, graphiques,
  admin/entites) → c'est **structurel**, pas une page. Cause exacte :
  `src/components/shell/app-header.tsx:39` est un `flex h-16 items-center gap-6` avec 8+
  items horizontaux (logo + `AppNav` + `WorkspaceSwitcher` + CTA banque + Membres +
  Entités + déconnexion) **sans aucune classe responsive** (`md:`/`hidden`/menu mobile) ;
  `AppNav` (`app-nav.tsx:36`) est lui aussi un `flex` non condensé. Viole la règle UI
  CLAUDE.md « Responsive header : condenser sous le breakpoint (menu/icône), **JAMAIS
  flex-wrap** ». **À faire** : passer le bloc de droite + la nav en menu/burger sous
  `lg` (ou masquer/regrouper). **Déclencheur** : décision produit « l'app doit être
  utilisable < 1024px » (un Financial Manager sur tablette/téléphone). Si desktop-only
  assumé → tracer la décision et **fermer ce ticket explicitement** (ne pas laisser
  pourrir). **Effort** : M. (NB : la mémoire `dashboard-insights-voie-a-livre` notait
  déjà un « overflow mobile préexistant » — c'est lui, généralisé à tout le shell.)

- [ ] **QA-UX-CATEG-COHERENCE1 (P2) — lever l'ambiguïté entre catégorie *prédite Omni-FI*
  et statut de ventilation TYGR.** Sur `/transactions`, une même cellule juxtapose la
  catégorie **prédite** par Omni-FI en sous-texte (« Charges d'exploitation »,
  « Honoraires », « Logement ») ET le statut de ventilation TYGR « Non catégorisé » → une
  ligne intitulée « Charges d'exploitation » est affichée « Non catégorisé », ce qui se
  contredit à l'œil. Après ventilation, la colonne montre « 1 catégorie**s** » (pas
  d'accord singulier/pluriel) **mais pas le nom** de la catégorie posée (il faut rouvrir
  la modale pour la connaître). Cellule par ailleurs **dupliquée** dans le DOM (variantes
  mobile+desktop superposées : « Non catégorisé Non catégorisé »). **À faire** : clarifier
  le vocabulaire (prédiction ≠ ventilation validée), afficher la/les catégorie(s)
  utilisateur dans la colonne, corriger l'accord pluriel, et masquer la variante non
  pertinente au lieu de la dupliquer. **Déclencheur** : prochaine itération UX
  `/transactions`. **Effort** : S–M. Cf. mémoires `cascade-libelle-transaction` +
  `ui-fiabilite-classification-transactions`.

- [ ] **QA-UX-VENTIL-RESTE1 (P2) — « Catégoriser le reste » ne doit pas créer une ligne
  orpheline quand une catégorie est déjà sélectionnée.** Reproduction : ouvrir la modale,
  choisir une catégorie (montant laissé vide), cliquer « + Catégoriser le reste » → au
  lieu de remplir la **ligne courante**, l'action **ajoute une 2ᵉ ligne** pré-remplie au
  montant restant mais **sans catégorie**. Résultat : « Reste Rs 0,00 » (barre pleine)
  mais Valider reste désactivé car une ligne a une catégorie sans montant et l'autre un
  montant sans catégorie — état confus pour l'utilisateur. Le garde-fou (Valider
  désactivé sur état incohérent) est correct ; c'est l'ergonomie du raccourci qui piège.
  **À faire** : « Catégoriser le reste » remplit la dernière ligne **catégorisée mais non
  chiffrée** s'il y en a une, sinon crée la ligne. **Déclencheur** : prochaine itération
  de la modale de ventilation. **Effort** : S. Cf. mémoire `split-allocation-modal-plan`.

- [ ] **QA-ENTITES-CREATION-UI1 (P1, raccroché au chantier Entités multi-tenant) — exposer
  la création d'entité dans l'UI `/admin/entites`.** La page n'offre que l'**assignation**
  (Vision Globale / Vision Entité par membre) et affiche « Aucune entité n'a encore été
  créée pour ce groupe » ; passer un membre en « Vision Entité » mène à un **cul-de-sac**
  (« Sélectionnez au moins une entité » alors qu'aucune n'existe et qu'on ne peut pas en
  créer). **Le backend est pourtant prêt** : `creerEntiteAction` +
  `creerEntiteSchema` existent dans
  `src/app/(workspace)/admin/entites/actions.ts:113`, mais **ne sont câblés nulle part
  dans l'UI** (vérifié : ni `page.tsx` ni `assignation-entites.tsx` ne les importent).
  C'est donc un **trou d'UI**, pas un trou complet. **À faire** : ajouter un formulaire
  « Nouvelle entité » qui appelle `creerEntiteAction` (garde ADMIN déjà côté action).
  **Déclencheur** : le multi-entités est la priorité démo n°1 (roadmap Omnicane) → dû
  avant toute démo « Vision Entité ». **Effort** : S–M. Cf. mémoires
  `ui-admin-entites-maquette`, `roadmap-omnicane-entites`.

- [ ] **QA-LISTES-MANQUANTES1 (P2) — les pages « liste » n'affichent pas l'existant.**
  Trois écrans nommés comme des listes ne montrent que des actions, jamais l'état :
  (a) **`/banques`** (« Banques connectées ») n'affiche **aucune** des 12 banques
  connectées (seulement « + Connecter une banque » / « Synchroniser ») → impossible de
  voir ni déconnecter une connexion ; ~~(b) **`/admin/membres`**~~ **✅ LIVRÉ** (chantier
  `feat/membres-creation-scopes`, 2026-07-06 : la liste des membres — nom/email/rôle/
  périmètre — est rendue sous le formulaire via `listerMembresWorkspace`) ;
  (c) **`/admin/entites`** liste bien les membres mais pas les entités (cf.
  QA-ENTITES-CREATION-UI1). **À faire (reste)** : (a) liste des connexions bancaires avec
  déconnexion. **Déclencheur** : prochaine itération admin / gestion des connexions.
  **Effort** : M (S depuis que (b) est fait).

### Provisioning membres — dettes ouvertes après feat/membres-creation-scopes (2026-07-06)

Chantier « créer un membre + assigner ses entités à la création » livré : formulaire
avec cases entités (Vision Globale / Vision Entité), chaînage atomique
`creerMembreAvecScopes` (création + `definirScopesMembre` dans une seule tx, rollback
total sur entité cross-tenant), liste des membres, message email-existant véridique.
Deux dettes tracées ci-dessous (aucune ne touche l'isolation/append-only/montants →
autorisées, règle 9).

- [x] **AUTH-MDP-TEMPO1 (P1, effort M) — flux « mot de passe temporaire » : LOT A LIVRÉ**
  (2026-07-17, plan `PLAN-auth-mdp-temporaire.md`, décisions D1-D9). Migration 0022
  (`must_change_password` + `password_changed_at`), pose du flag au provisioning (D7),
  gate par-requête modèle E6 (`etatCompte`, `MotDePasseAChangerError` mappée sur 9 sites),
  **invalidation de session** par claim `pwdAt` comparé par égalité stricte (D4 — une
  session ouverte avec le mot de passe temporaire meurt au changement), écran + action
  self-service `/account/password` (copie EN, Q-LANG), lockout E18 mutualisé sous FOR
  UPDATE (D6), `reset-password.mjs` (posage systématique + `RESET_MUST_CHANGE`).
  Dettes filles : lot B ci-dessous + AUTH-AUDIT-EVENT1 / AUTH-INVITATION1 / AUTH-MDP-UX1
  (§10 du plan).

- [ ] **AUTH-MDP-TEMPO1-LOT-B (P1, effort S-M) — expiration TTL 7 j + reset admin,
  indissociables** (2026-07-17). L'expiration seule serait une impasse : provisioning
  anti-écrasement + `reset-password.mjs` refuse la prod → un temporaire expiré bloquerait
  le membre DÉFINITIVEMENT. À livrer ensemble (plan §D8) : check
  `TEMP_PASSWORD_EXPIRED` au login (APRÈS vérification argon2, constante
  `DUREE_VIE_MDP_TEMPORAIRE_MS` = 7 j) + action admin « Issue a new temporary
  password » dans `liste-membres.tsx` (nouveau hash, flag + posage → tue les sessions
  du membre via D4, RAZ lockout). **Déclencheur** : premier onboarding de membres réels
  hors équipe fondatrice (inchangé).

- [ ] **AUTH-AUDIT-EVENT1 (P2, effort S) — événement « password changed »** (2026-07-17).
  `audit.consigner` exige `ctx.workspaceId` (table tenant-scopée) ; le changement de mot
  de passe est un fait USER-global → pas d'événement au lot A (plan §D9), logs structurés
  en attendant. **Déclencheur** : panneau `/audit` / modèle d'événement user-global
  (Epic 1 L3.4).

- [ ] **AUTH-INVITATION1 (P2, effort M-L) — flux « lien d'invitation »** (2026-07-17).
  Posture cible SaaS-ready : l'admin ne détient JAMAIS le secret du membre (plan §2 —
  table `invitation_tokens`, surface publique `/invite/[token]` rate-limitée,
  anti-énumération). Le socle lot A (gate, invalidation D4, reset D8) reste au passage
  aux invitations. **Déclencheur** : infra email posée OU premier workspace
  `EXTERNAL_CLIENT`.

- [ ] **AUTH-MDP-UX1 (P2, effort S) — découvrabilité self-service + blocklist**
  (2026-07-17). `/account/password` existe mais AUCUNE entrée de menu n'y mène (pas de
  menu utilisateur dans le shell — on n'en crée pas pour ça, plan §D5) ; blocklist de
  mots de passe courants (NIST 800-63B, optionnel). **Déclencheur** : refonte du menu
  utilisateur du shell.

- [ ] **PROV-EMAIL-EXISTANT1 (P2, effort S) — durcir la réutilisation d'utilisateur par
  email (léger oracle d'énumération cross-tenant).** `creerUtilisateurEtRattacher` réutilise
  un utilisateur existant par email sur TOUTE la table `users` (hors RLS), y compris un
  utilisateur d'un AUTRE workspace, et le message de succès distingue désormais « créé » de
  « utilisateur existant rattaché » (fix véridique voulu, morceau 3). Un ADMIN peut donc
  déduire qu'un email est déjà un utilisateur TYGR ailleurs. Surface ADMIN-only, risque
  faible, **comportement anti-écrasement conservé** (le mot de passe d'un user existant
  n'est jamais réécrit). **À faire si durcissement** : soit refuser de rattacher un
  utilisateur qui n'est pas déjà membre du workspace courant (casse les users multi-espaces
  légitimes — à peser), soit uniformiser le message (ne plus distinguer créé/existant).
  **Déclencheur** : arrivée de clients multi-tenant réels (aujourd'hui : un seul groupe
  Omnicane). Réfère `PLAN-membres-creation-scopes.md` §6.

- [ ] **QA-NAV-PLACEHOLDERS1 (P2) — Graphiques & Échéances : sections vides au message
  trompeur + incohérence placeholder.** `/graphiques` et `/echeances` sont des
  placeholders « Bientôt… **cette section s'activera dès que vos comptes seront
  synchronisés** » — or les comptes **sont** synchronisés (12 comptes, 260+ tx) : le
  message est **factuellement faux** dans ce contexte et promet une activation qui ne
  viendra pas d'une synchro. De plus, `app-nav.tsx:42` prévoit un mode `placeholder`
  (libellé inerte, non cliquable) **non utilisé** : ces deux items naviguent vers une
  vraie page placeholder (200) au lieu d'être rendus inertes → deux conventions
  « pas encore livré » coexistent. **À faire** : soit livrer ces écrans, soit aligner sur
  UNE convention (item de nav inerte OU page « en construction » au message honnête, sans
  référence à une synchro déjà faite). **Déclencheur** : développement de la section
  Graphiques (90j) / Échéances. **Effort** : S (alignement) à L (livraison réelle).

- Note QA (non bloquante, **données de démo**, pas l'app) : soldes strictement
  identiques sur les 4 banques (fixture sandbox clonée → ressemble à des doublons) ;
  transactions datées dans le futur relatif (22 août / 14 juil. au 24 juin) ; libellés
  « Opération bancaire » résiduels (fallback enrichment, cf. mémoire
  `contrat-enrichment-imbrique`). Limite de la **sandbox**, à garder en tête pour les
  démos. **Parcours bancaire non testable en local HTTP** : le widget Omni-FI refuse
  l'origine `http://localhost` (« Origine sécurisée non autorisée », garde-fou
  `RedirectOrigin` attendu, erreur correctement affichée) — testable seulement en https.

### Insights financiers — module amont non livré, dérivation interne (2026-06-24)

- [ ] **INSIGHTS-AMONT1 (P2) — basculer les Insights sur l'API Omni-FI quand le module
  sera livré.** Audit de faisabilité Staging du 2026-06-24 (cf.
  `PLAN-tech-api-insights.md`) : `/insights/cashflow`, `/insights/vendors`,
  `/insights/alerts` et `/dashboard/insights` renvoient tous **`501 NOT_IMPLEMENTED`**
  (« Insights module is not yet implemented »), 501 même **sans auth** → module non
  branché côté serveur (la route existe : `OPTIONS → 200`, `POST → 405`). On a donc livré
  la **Voie A** : cashflow & vendors **DÉRIVÉS** de `transactions_cache`
  (`src/server/repositories/insights.ts` + DTO internes `src/server/insights/types.ts`),
  zéro dépendance au 501. **Déclencheur de résolution** : passage **501 → 200** de
  `GET /insights/cashflow` en Staging (re-jouer l'audit §1 du plan à chaque sprint tant
  que ce ticket est ouvert). **Effort estimé** : ~1 j (client amont + mapper
  `mapDepuisOmniFi` → MÊME DTO interne + flag `INSIGHTS_SOURCE` + réconciliation
  dérivé↔amont). **Ne PAS coder le client amont avant** : un 501 ne révèle aucun payload
  de succès → on figerait un parseur contre un contrat fantôme (piège `/v1` /
  `Enrichment` déjà payé ×2). NON une dette d'isolation/append-only/montant (la Voie A
  respecte déjà tous ces invariants : RLS tenant + JOIN scope entité + agrégat SQL en
  chaînes décimales). Rappels de contrat amont gravés dans `docs/agent-capabilities.md`
  (§5) : routes à la RACINE (pas `/v1`), param `client_user_id` snake_case (camelCase →
  403), enveloppe d'erreur `{Error:{}}` ≠ OBIE.

- [ ] **INSIGHTS-MATVIEW1 (P2, conditionnelle) — matérialiser le cashflow si la perf
  l'exige.** Les insights sont aujourd'hui calculés À LA LECTURE (agrégat SQL sur
  `transactions_cache`), choix KISS validé (pas de table spéculative, règle 9). Si un
  cap de perf est **démontré** (pas supposé), introduire une vue matérialisée
  `insights_cashflow_*` rafraîchie post-sync, **append-only au DELETE** (trigger +
  liste blanche, comme toute table financière — cf. CLAUDE.md). **Déclencheur** : p95 de
  l'agrégat cashflow > seuil sur jeu de données réel. **Effort** : ~0,5–1 j. **Pas
  avant** une mesure réelle.

### Localisation — identifiant de fuseau Maurice erroné (2026-06-22, Lot 2)

- [x] **TZ-DOC1 (P1, point de DÉPLOIEMENT/fuseau) — corriger « Asia/Port_Louis » →
  « Indian/Mauritius »** — Effort S. **RÉSOLU 2026-06-22** (`hotfix/tz-mauritius-correction`).
  Découvert au Lot 2 (pastille de fraîcheur §3.7) : `Asia/Port_Louis` **n'existe pas**
  comme identifiant IANA et fait planter `Intl` (`RangeError: Invalid time zone
  specified`), y compris sous full-ICU (Node 25, ICU 78). Le bon nom canonique de
  Maurice (UTC+4) est **`Indian/Mauritius`**. Le seul code passant une chaîne de fuseau
  à `Intl` (`src/lib/format-date.ts`, `FUSEAU_MAURICE`) utilisait DÉJÀ le bon
  identifiant — aucune ligne exécutée n'était en cause ; le risque était purement
  documentaire (un futur agent se fiant au commentaire). Correctif : remplacement des
  mentions **affirmatives** trompeuses dans `CLAUDE.md` (« Localisation & temps » +
  « Formatage »), `docs/cahier_des_charges.md` §3.bis, les en-têtes de
  `src/server/ingestion/conversion.ts`, `src/server/db/schema.ts`, `src/lib/format-date.ts`,
  et les libellés de test (`ingestion-conversion.test.ts`, `format-date.test.ts`).
  CONSERVÉES volontairement (citent `Asia/Port_Louis` comme l'erreur À ÉVITER, les
  remplacer les viderait de sens) : les garde-fous `format-date.ts:54,145` et le constat
  historique archivé sur `balanceDate` (cross-review 2026-06-15, plus bas). **Vérifié**
  côté Backend : aucune clause SQL `AT TIME ZONE` n'est exécutée dans `drizzle/` à ce
  jour (la dérivation `transaction_date` se fait en TS par offset fixe UTC+4 dans
  `deriverDateComptableMaurice`) — donc PAS de dette Backend bloquante ; le jour où une
  telle clause SQL sera posée, elle devra employer `Indian/Mauritius`.

### Refus de connexion hors périmètre — constats du mutation-check (2026-07-22, PR `feat/connexion-refus-nomme`)

Lot ENTITY-CONNEXION-REFUS-NOMME1 livré avec sa suite d'isolation
(`tests/isolation/connexion-perimetre-isolation.test.ts`, 11 cas). Le mutation-check a
validé 4 mutations sur 5 (clause `accountScope` retirée → tests 1 et 3 rouges ; garde
amont neutralisée → 2 et 3 ; ceinture devenue catch-all → 8 ; ceinture supprimée → 6 et
7). La cinquième n'a rien fait rougir — c'est le constat ci-dessous.

- [ ] **CONNEXION-SYNC-REESSAI1 (P1, effort ~0,25 j) — sur le chemin SYNCHRO, un membre
  borné lit encore « Réessayez dans un instant », l'invitation que ce lot existe pour
  supprimer.** `ConnexionHorsPerimetreError` n'est PAS dans la liste de re-throw du
  fail-soft de `synchroniserConnexionsDepuisOmnifi`
  (`src/server/widget/orchestration.ts`, bloc de re-throw sélectif) : l'erreur est avalée
  en `echecs`, et `banques/actions.ts` rend `MESSAGE_SYNC_TOUT_ECHOUE`. Aggravant vérifié
  en cross-review : un membre borné prend un 42501 à CHAQUE synchro, même sur un compte
  DÉJÀ dans son périmètre — `upsertCompte` (`INSERT … ON CONFLICT DO UPDATE`) propose une
  ligne à `entity_id` NULL et un `id` neuf, qui violent les deux WITH CHECK quelle que
  soit la ligne existante. La boucle de réessai est donc PERMANENTE pour eux, pas
  ponctuelle. Sur le chemin RÉPARATION l'erreur remonte bien, mais le libellé
  (« connecter une banque ») est faux pour qui répare un OTP sur une banque déjà
  connectée. **Pourquoi ce n'est pas corrigé dans ce lot** : ajouter la classe au
  re-throw change le comportement de la synchro (fail-soft partiel → échec global) et
  mérite un arbitrage explicite — hors périmètre d'une PR qui NOMME un refus (règle 7).
  **Déclencheur** : arbitrage d'Etienne, OU première remontée utilisateur d'un membre
  borné sur la synchro. Constat de cross-review 2026-07-22, confiance 7/10.

- [ ] **PG-CODE-CONVERGENCE1 (P2, effort ~0,5 j) — quatre copies de `codePg` cohabitent.**
  Le module canonique `src/server/db/erreurs-pg.ts` a été créé par le lot
  ENTITY-CONNEXION-REFUS-NOMME1 sans migrer les copies privées préexistantes —
  `repositories/echeances.ts:231`, `repositories/categorisation.ts:501`,
  `repositories/entites.ts:317`, identiques octet pour octet. Report ASSUMÉ à l'époque
  (plusieurs branches en vol sur ces fichiers, conflits gratuits sur une PR de sécurité),
  mais la dette n'avait **jamais été consignée** alors que la docstring l'affirmait — et
  son inventaire annonçait DEUX copies au lieu de trois (défaut relevé en cross-review
  2026-07-22, règle 9 : un TODO sans entrée TODOS.md est un défaut de revue).
  **Déclencheur** : prochaine retouche de l'un de ces trois repositories, ou dès que les
  branches en vol sont mergées — importer depuis `@/server/db/erreurs-pg` et supprimer la
  copie locale. Tout NOUVEL appelant importe déjà du module canonique.

- [ ] **CONNEXION-CLAUSE-ENTITE1 (P2, effort ~0 en statu quo) — la clause
  `ctx.entityScope.mode === "ENTITES"` de `estLecteurBorne` (`src/server/db/tenancy.ts`)
  n'est protégée par AUCUN test.** Mutation vérifiée le 2026-07-22 : la retirer laisse
  **11/11** de la suite du lot ET **727/727** de `tests/isolation` au vert. Ce n'est pas
  un trou de couverture qu'on aurait oublié de boucher : la clause est **logiquement
  redondante**, parce que `withWorkspace` traduit toujours le périmètre entité en
  périmètre compte (`ENTITES ⟹ COMPTES`) — sa propre docstring l'énonce déjà. On la
  **CONSERVE** : c'est une ceinture qui reprendrait son sens si la traduction
  entité→comptes disparaissait, et la supprimer pour « faire propre » créerait
  précisément la régression silencieuse qu'elle prévient. Aucune conséquence de
  sécurité : l'autorité reste la RLS (policies `entity_scope` 0014 / `account_scope`
  0016), et l'axe entité est prouvé par ailleurs (test 2 du lot, suites `entites-*`).
  **Déclencheur** : toute retouche du résolveur de scope de `withWorkspace` touchant la
  traduction entité→comptes — ce jour-là, trancher explicitement entre « la clause
  redevient nécessaire → lui écrire son test » et « elle est définitivement morte → la
  retirer ». Ne pas laisser le mutation-check suivant redécouvrir le même angle mort.

### Entités multi-tenant (Option B) — dettes ouvertes par le plan (2026-06-22)

Plan de référence validé : `PLAN-entites-multi-tenant.md` (§5). Le socle Entités L1→L2
(`entities`, `bank_accounts.entity_id`, `member_entity_scopes`, policy RLS `entity_scope`
+ 3ᵉ GUC) couvre l'**étage 1 (tenant, dur — inattaquable, prouvé en cross-review)** et
pose la garde **étage 2 (entité)** sur `bank_accounts`. Les dettes ci-dessous sont hors
périmètre du socle (anti-scope-creep, règle 7). Aucune ne touche l'isolation **tenant**
(sinon INTERDITE, règle 9) — toutes sont **intra-groupe (étage 2)**.

> 🔓 **GATE D'ACTIVATION — LES DEUX P1 SONT LEVÉES (2026-06-22)**. Historique : la
> cross-review sécu (contexte vierge) avait identifié deux trous **latents** prouvés
> runtime — lecture sans jointure (`ENTITY-READ-JOIN1`) et écriture non scopée
> (`ENTITY-WRITE-SCOPE1`) — et posé une **interdiction formelle** de livrer un chemin
> créant une ligne `member_entity_scopes` tant qu'ils n'étaient pas TOUS DEUX clos.
> ✅ `ENTITY-READ-JOIN1` levée (PR #83, jointure repos) ; ✅ `ENTITY-WRITE-SCOPE1` levée
> (PR `fix/entity-write-scope`, policy `entity_scope` FOR ALL USING+WITH CHECK, migration
> 0009). L'étage 2 borne désormais lecture ET écriture, prouvé par
> `tests/isolation/entites-isolation.test.ts` (blocs « étage 2 hérité par jointure » +
> « écriture bornée par scope »). **Le verrou sécurité est donc OUVERT** ; ce qui reste
> avant une Vision Entité réelle en prod n'est plus de l'isolation mais du **produit** :
> livrer L3/L4 (repo `entites.ts` + Server Actions `definirScopesMembre`/sas, garde
> **ADMIN applicative**) puis L5 (preuve runtime bout-en-bout du parcours VIEWER scopé).

- [x] **ENTITY-READ-JOIN1 (P1) — brancher les repos de LECTURE sur la jointure `bank_accounts` pour hériter du scope entité** —
  ✅ **RÉSOLU 2026-06-22 (PR #83, `fix/entity-read-join1`)**. `innerJoin(bankAccounts)` ajouté aux
  4 fonctions de lecture de `dashboard.ts` (`transactionsRecentes`, `syntheseMois`,
  `courbeTresorerie` + `soldeConsolideCourant` — même fuite latente sur `balance_history`,
  bouchée par cohérence). Jointures sûres (`bank_account_id` NOT NULL) et neutres en Vision
  Globale (policy RESTRICTIVE laisse tout passer GUC vide → agrégats inchangés, zéro régression).
  Tests « fuites latentes 13/13b » INVERSÉS en preuve de levée sur les vraies fonctions repo
  (Vision Entité Sucrière ne voit que Sucrière ; contre-preuve Vision Globale voit tout).
  Reste HISTORIQUE ci-dessous :
  Effort S, gardien Backend. Ouvert 2026-06-22 (découvert pendant l'implémentation L1→L2,
  branche `feat/entities-data-model`). La policy `entity_scope` (étage 2) vit sur
  `bank_accounts` ; transactions/soldes n'en héritent **que via une JOINTURE** sur
  `bank_accounts`. Or des repos de lecture lisent les tables filles SANS cette jointure —
  vérifié : `transactionsRecentes` (`dashboard.ts:238`, `from(transactionsCache)` nu).
  Conséquence : en Vision Entité, ces lectures verraient les transactions d'une autre
  entité du **même** workspace. ⚠️ **Pas une fuite cross-tenant** : `transactions_cache`
  porte sa propre policy `tenant_isolation` (étage 1 intact) — l'écart est **intra-groupe**
  (étage 2). À faire : ajouter `innerJoin(bankAccounts, …)` (ou un `WHERE bank_account_id
  IN (select id from bank_accounts)` qui passe la RLS) à `transactionsRecentes`,
  `courbeTresorerie`, `syntheseMois` et tout repo lisant `transactions_cache`/
  `balance_history` directement, pour que la policy `entity_scope` morde par héritage.
  **Déclencheur** : socle Entités mergé — **BLOQUANT avant le premier déploiement où une
  Vision Entité est activée** (P1, SLA « avant prod »). Tant que personne n'a de ligne
  `member_entity_scopes` (tout le monde en Vision Globale), l'écart est inerte. Corrige
  aussi l'affirmation « masque déjà en lecture par jointure » d'ENTITY-WRITE-SCOPE1 :
  vraie pour les repos QUI joignent, à généraliser par cette dette.

- [ ] **ENTITY-PARTY1 (P2) — pré-remplir la CRÉATION d'entités + l'assignation via les
  « Parties » Omni-FI, dès la phase 1 du widget** — Effort M, gardien Backend. Ouvert
  2026-06-22, **précisé 2026-07-02 (retour terrain prod réelle)**. La doc API expose `GET
  /parties/{PartyId}/accounts` + `OBReadAccount6.PartyId/PartyName/OwnershipType`
  (entités légales API). `party_id`/`party_name` sont **DÉJÀ persistés** à l'ingestion
  (`ingererPartiesDesComptes`, tables `parties` + `account_party_role`) — le socle existe.
  Ce qui manque = le **pont `Party` → `entities` + `bank_accounts.entity_id`** :
    1. À la **phase 1 du widget** (récupération entités/comptes à l'ouverture, événements
       `sync.retrieving_parties`/`sync.parties_retrieved`), DÉRIVER une entité candidate
       par `PartyName` distinct et PRÉ-COCHER le rattachement des comptes de cette party.
    2. Décision PO (2026-07-02, question tranchée) : **PRÉ-REMPLIR + VALIDATION ADMIN**,
       PAS de création/assignation automatique. Le widget PROPOSE ; l'ADMIN confirme dans
       le sas (`/admin/entites`) avant que `entity_id` soit posé.
  ⚠️ **FRONTIÈRE D'ISOLATION — NON NÉGOCIABLE** : l'ingestion NE crée JAMAIS d'entité ni
  ne pose `entity_id` sans le pas de validation ADMIN (invariant CLAUDE.md « l'ingestion ne
  pose jamais entity_id automatiquement » + « l'upsert de re-sync ne réécrase JAMAIS un
  entity_id assigné »). Raison : 1 credential = comptes de N entités → faire autorité du
  découpage amont = **fuite intra-groupe** (compte visible par le mauvais Financial
  Manager). La party Omni-FI est un INDICE de pré-remplissage, jamais l'autorité.
  **Déclencheur** : retour terrain « trop de saisie manuelle » (✅ CONSTATÉ 2026-07-02 :
  77 comptes prod à assigner à la main après reset) **ET** preuve que les Parties sont
  fiablement peuplées en prod → **✅ PROUVÉ 2026-07-02 sur la donnée prod RÉELLE** :
  `28 parties`, **100 % nommées** (ex. `OMNICANE THERMAL ENERGY`, `OMNICANE LIMITED`,
  `AIRPORT HOTEL LTD`, `MERIDIS LIMITED`, `TROPICAL CUBES`…), **77 liens** `account_party_role`
  (chaque compte rattaché à sa party), `entity_id` encore à 0 (pont non câblé). Recon :
  `SELECT p.name, count(apr.bank_account_id) FROM parties p LEFT JOIN account_party_role
  apr ON apr.party_id=p.id GROUP BY p.name`. NB : `parties.entity_id` existe DÉJÀ dans le
  schéma (colonne présente) → le pont est structurellement prêt, il reste à l'alimenter via
  le sas validé. Les deux déclencheurs sont donc levés — dette **mûre pour planification**.
  **NON une dette d'isolation** (le
  pré-remplissage ne relâche aucune garantie ; c'est la création AUTO qui en serait une,
  et elle est écartée). Voir aussi [[PERIMETRE-ENTITE-DERIVE1]] (péremption du libellé si
  réassignation ultérieure).

- [x] **ENTITY-WRITE-SCOPE1 (P1, BLOQUANTE avant prod Vision Entité) — l'étage 2 ne borne PAS l'ÉCRITURE** —
  ✅ **RÉSOLU 2026-06-22 (PR `fix/entity-write-scope`)**. Migration `0009_entity-write-scope.sql` :
  la policy `entity_scope` passe de `FOR SELECT` à **`AS RESTRICTIVE FOR ALL`** (USING + WITH
  CHECK, même expression GUC). USING borne le ciblage (SELECT/UPDATE/DELETE), WITH CHECK borne
  l'état résultant (INSERT/UPDATE) → un membre scopé ne peut ni muter/supprimer un compte hors
  scope, ni l'INSÉRER/déplacer hors scope. **PAS d'« exception ADMIN » dans la RLS** (la dette
  l'évoquait) : inutile et plus sûr ainsi — la RLS ignore le rôle, et l'ADMIN opère en Vision
  Globale (GUC vide → branche TRUE → tout passe). La garde « assignation ADMIN-only » reste
  **applicative** (futur `entites.ts`, L4). Backward-compat N-1 prouvée : ingestion (INSERT
  `entity_id=NULL`) et re-sync tournent en Vision Globale → neutres ; aucune régression sur 397
  tests. Tests d'écriture 14/14b/14c INVERSÉS (preuve : UPDATE sans WHERE ne mute que Sucrière ;
  déplacement hors scope lève 42501 ; INSERT NULL OK en Globale, refusé en Vision Entité).
  **Durcissement `categorisation.ts` NON inclus** (hors périmètre : la catégorisation masque
  déjà en lecture par la jointure #83 ; à rouvrir SI elle devient scopée en écriture). Reste
  HISTORIQUE ci-dessous :
  Effort S-M, gardien Backend. Ouvert 2026-06-22, **sévérité relevée par la cross-review
  sécu (contexte vierge)** : la formulation initiale « durcissement de la catégorisation »
  **sous-évaluait** le fait. La policy `entity_scope` est `FOR SELECT` uniquement → en
  Vision Entité, **l'ÉCRITURE sur `bank_accounts` n'est pas scopée du tout** (seul
  `tenant_isolation`/workspace gouverne). **Prouvé runtime** : un VIEWER scopé Sucrière
  exécutant `UPDATE bank_accounts SET … ` (sans WHERE) mute AUSSI les comptes Énergie +
  le compte non assigné ; un `INSERT` d'un compte assigné à Énergie (hors scope) réussit.
  ⚠️ **NUANCE (ce qui borne le risque)** : ce n'est PAS une fuite de **confidentialité** —
  `UPDATE/DELETE … RETURNING` ne renvoie que les lignes **visibles au SELECT** (donc
  in-scope) ; un `DELETE`/`UPDATE` ciblant une valeur d'Énergie renvoie `[]` et ne
  détruit/altère PAS la ligne hors scope. C'est un trou d'**intégrité/autorisation** (un
  membre borné peut altérer en masse des comptes qu'il ne devrait pas toucher), pas un
  oracle. **Non exploitable dans le socle L1→L2** : aucun chemin ne crée de Vision Entité
  (pas de repo `entites.ts`/`definirScopesMembre`), et l'assignation compte→entité est
  ADMIN-only (Vision Globale). À faire : policy `entity_scope` RESTRICTIVE FOR
  UPDATE/DELETE (USING+WITH CHECK honorant le scope, avec exception ADMIN explicite) sur
  `bank_accounts` ; ET borner l'écriture catégorisation (`categorisation.ts`) si elle
  devient scopée. **Déclencheur** : AVANT tout déploiement livrant un chemin d'écriture
  vers `member_entity_scopes` (cf. GATE d'activation ci-dessus). Couvert par le test
  « écriture VIEWER scopé hors périmètre » (assertion du comportement ACTUEL, à inverser
  quand la dette est levée). Raccroché au chantier « rôles Vision Entité » (ROADMAP §3).

- [ ] **ENTITY×ACCOUNT-DOUBLE-AXIS (P2 fonctionnel, PAS isolation) — l'AND des deux policies
  RESTRICTIVE masque un octroi party hors scope BU** — Effort S, gardien Backend. Ouvert
  2026-06-26, **repéré au cross-review L4** (PR #132, `feat/account-scope-l4`). Un membre cumulant
  `member_entity_scopes` (axe BU) ET `user_scopes` (party/compte) subit l'**AND** des policies
  `entity_scope` et `account_scope` (toutes deux RESTRICTIVE), **pas l'union** : un compte
  légitimement octroyé par party mais dont l'entité est HORS du scope BU du membre devient
  **invisible** pour lui. **Prouvé runtime** (cross-review) : `account_scope` résout bien l'union
  `{S1,H}` mais `entity_scope={ENT_S}` masque `H` (entity NULL) → visible = `{S1}`. **FAIL-CLOSED**
  (sous-ensemble du droit) → **AUCUNE fuite, aucun IDOR** ; c'est une dette FONCTIONNELLE (un
  octroi légitime est silencieusement nié), pas d'isolation. Le commentaire « account_scope
  subsume entity_scope » était trompeur (corrigé docs-only, même PR). **Résolution** : retrait
  d'`entity_scope` en L9 (une fois `account_scope` prouvé en prod) → dissout l'intersection ; OU
  interdire le double octroi côté UI (`entites.ts` : un membre est scopé BU **ou** party/compte,
  pas les deux). **Déclencheur** : activation d'un chemin d'écriture qui permet le double octroi,
  OU lot L9 (retrait `entity_scope`). Non bloquant pour le merge L4 (sûr).
  **Manifestation L5 — incohérence de maille FICHE ≠ FLUX** (repérée au cross-review L5, PR #133) :
  depuis 0017 les tables filles (transactions_cache/balance_history/transaction_categorizations) ne
  portent QUE `account_scope`, alors que la FICHE `bank_accounts` porte AUSSI `entity_scope`. Pour le
  membre double-axe, un compte octroyé par party mais à entité hors scope BU (ex. ACC_S2) est donc
  **masqué sur sa fiche** (intersection `account_scope ∩ entity_scope`) tout en laissant voir ses
  **flux** (les filles, `account_scope` seul) → oracle d'inférence UX BÉNIN (« des flux sans fiche »),
  toujours fail-closed, jamais d'IDOR (un compte hors des DEUX axes reste invisible partout). Couverte
  par le test de non-régression `tests/isolation/account-scope-double-axe-maille.test.ts` (qui ACTE le
  comportement actuel — fiche `{ACC_S1}`, flux `{ACC_S1,ACC_S2}`, ACC_H nulle part). **Résolution : L9**
  (le retrait d'`entity_scope` réaligne la maille fiche↔flux ; le test devra alors être inversé pour
  exiger ACC_S2 sur la fiche).

- [ ] **ENTITY-INGEST1 (P2) — pré-assignation automatique `compte → entité` à l'ingestion** —
  Effort S, gardien Backend. Ouvert 2026-06-22. Au MVP, un compte neuf naît `entity_id =
  NULL` (« non assigné », à trier dans le sas) — comportement voulu (l'humain tranche
  l'affectation). Cette dette = appliquer une règle de pré-assignation à la découverte
  (dépend des Parties, ENTITY-PARTY1, pour la source du mapping). L'upsert d'ingestion
  ne réécrase JAMAIS un `entity_id` déjà posé (invariant du socle, à préserver).
  **Déclencheur** : ENTITY-PARTY1 livrée. **NON une dette d'isolation.**

- [ ] **ENTITY-UI1 (P2, FRONTIÈRE FRONT) — pages admin Entités : référentiel, sas d'assignation, sélecteur de scope** —
  Effort M, **gardien Front**. Ouvert 2026-06-22. Le **Backend L3/L4 est livré** (repo
  `src/server/repositories/entites.ts` + Server Actions `src/app/(workspace)/admin/entites/actions.ts` :
  `creerEntiteAction`, `renommerEntiteAction`, `archiverEntiteAction`, `assignerCompteAction`,
  `definirScopesAction` ; tous ADMIN-only, contrats `EntiteLue`/`EtatAction`). Reste l'UI (calque
  `admin/membres/page.tsx` + `formulaire-provisioning.tsx`) : (1) liste des entités (`listerEntites`)
  + formulaires créer/renommer/archiver ; (2) **sas** « Comptes à assigner » listant `entity_id IS
  NULL` + picker d'entité par compte → `assignerCompteAction` ; (3) sélecteur multi-entités du
  périmètre d'un membre → `definirScopesAction` (cases à cocher `name="entityIds"`, vide = Vision
  Globale). Gating d'affichage : réservé ADMIN (la garde dure est déjà serveur). **Déclencheur** :
  ce chantier L3 mergé → l'UI devient le maillon manquant pour activer une Vision Entité en
  pratique. Ne touche ni l'isolation ni les montants (surface de rendu).

### Redesign « Assignation des comptes » L7 — dette d'ergonomie (2026-07-10)

Section `/admin/entites` → tableau dense groupé par entité + auto-save livrée
(`feat/admin-entites-assignation-comptes`, commit `d66bbe0` ; read `listerComptesAvecEntite`
gardé ADMIN + 25 tests d'isolation verts). Aucune de ces dettes ne touche l'isolation, les
tables append-only ni les montants (surfaces de rendu/UX) → différables. **Visual QA (Gate 4)
NON encore passée sur le redesign** : à faire sur `/demo/assignation-comptes` avant le merge
(action pré-merge Human-in-the-Loop, pas une dette).

- [x] **ENTITY-ASSIGN-BULK1 (P1) — assignation en masse compte → entité.** ✅ **LIVRÉE
  2026-07-13** (`feature/refonte-entites-ia`, lot L3 de `PLAN-refonte-entites.md`).
  `assignerComptesEntite` : 1 SELECT de pré-check + **1 UPDATE groupé** (jamais N UPDATE en
  boucle), atomique, avec comparaison de cardinalité (aucun succès partiel silencieux) et
  refus d'une entité archivée comme cible. UI : cases par ligne, case de groupe tri-état,
  filtre par banque, barre d'action groupée, confirmation sur la dé-assignation en masse.
  7 cas d'isolation (35→41). Énoncé d'origine ci-dessous, conservé pour l'audit trail :
  Le workspace réel porte ~87 comptes, dont 77 sans nom sous la même institution, à rattacher
  aujourd'hui **un par un** (un changement de Select = un appel). Aucune multi-sélection ni
  « assigner tous les comptes de {institution} à {entité} ». C'est la friction opérationnelle
  la plus lourde de l'écran. Ajouter une action groupée (cases par ligne + barre d'action, OU
  bouton par en-tête de groupe/institution) réutilisant `assignerCompteEntite` — soit N appels
  côté client, soit une nouvelle action batch gardée ADMIN + zod + un cas d'isolation dédié si
  batch serveur. **Déclencheur** : mise en service prod / onboarding Etienne sur les 87 comptes.

- [ ] **ENTITY-ASSIGN-REVALIDATE1 (P2, effort ~0,5 j) — LARGEMENT ATTÉNUÉE 2026-07-13
  par le batch (L3)** : ranger N comptes ne pose plus qu'UN `revalidatePath` au lieu de N.
  Le défaut ne subsiste que sur l'auto-save unitaire, ligne à ligne. Re-évaluer après usage
  réel avant d'investir. Énoncé d'origine : `revalidatePath` re-render les 87
  lignes à chaque enregistrement.** `assignerCompteAction` pose `revalidatePath("/admin/entites")` :
  après un succès, le compte ne migre vers son groupe qu'au retour serveur, qui re-render toute
  la liste — efface les coches « Enregistré » et réordonne pendant qu'on édite une autre ligne.
  Cohérent (serveur = vérité) mais sautillant en auto-save dense. Piste : migration optimiste
  locale du compte vers son nouveau groupe + `revalidate` ciblé/différé, ou `useOptimistic`.
  **Déclencheur** : retour d'usage « ça saute quand j'enchaîne les lignes ».

- [x] **ENTITY-ASSIGN-CONFIRM1 (P2) — ✅ SOLDÉE 2026-07-13 (L3 + L5).** La dé-assignation
  exige une confirmation explicite, en MASSE (L3) comme à l'UNITÉ (L5) — modale
  `dismissible={false}`, qui DIT que le compte deviendra invisible aux membres à accès
  restreint. La cible par défaut de la barre d'action groupée n'est plus destructive.
  Énoncé d'origine :
  la dé-assignation **en masse** (L3) exige désormais une confirmation explicite (modale
  `dismissible={false}`), et la cible par défaut de la barre d'action n'est plus destructive.
  Reste dû : la confirmation sur l'auto-save **unitaire** (lot L5). Énoncé d'origine : pas de
  confirmation sur la dé-assignation. Repasser un compte en « — Non assigné — » le rend invisible aux membres en
  Vision Entité (fail-closed) sur un simple changement de Select. Réversible mais silencieux.
  Ajouter une confirmation (ou un undo transitoire) sur la seule transition vers `null`.
  **Déclencheur** : premier incident « un compte a disparu pour un membre ».

- [x] **ENTITY-ASSIGN-STICKY1 (P2) — ✅ SOLDÉE 2026-07-13 (L5).** `sticky` sur le `<tr>`
  de `<thead>` (z-20) ET sur les en-têtes de groupe (z-10, sous le premier) : sur 87 lignes
  qui défilent, on garde à l'écran la colonne qu'on lit ET l'entité dans laquelle on range.
  Énoncé d'origine : en-têtes de tableau/groupe non collants. Sur 87 lignes qui défilent, les colonnes « Compte / Devise / Entité » et les
  en-têtes de groupe disparaissent — contradictoire avec l'objectif de scannabilité. Poser
  `sticky top-0` sur le `<thead>` (et éventuellement les `<th scope="colgroup">`).
  **Déclencheur** : Visual QA ou retour d'usage sur le défilement.

- [ ] **ENTITY-ASSIGN-SCALE1 (P2, effort ~0,5 j) — pas de pagination + jointure INNER
  fail-closed.** Le read charge et rend tous les comptes d'un coup (87 OK ; problématique à
  quelques centaines). De plus la jointure `bank_connections` est INNER : un compte dont la
  connexion manque disparaîtrait de la liste (théorique — `connection_id` NOT NULL — mais
  fail-closed non voulu). Piste : pagination keyset (cf. TX-FILTRE1) + LEFT JOIN avec repli.
  **Déclencheur** : un workspace dépasse ~200 comptes.

- [x] **ENTITY-ASSIGN-POLISH1 (P2) — ✅ SOLDÉE 2026-07-13 (L5).** (a) devise en SYMBOLE
  (`Rs`/`$`/`€`) via `indicateurDevise` — la source unique `format-montant` (aucun montant
  n'est affiché : on n'emprunte que l'indicateur) ; (c) `loading.tsx` écrit EN DERNIER, une
  fois la forme de l'écran définitive (bandeau, liste d'entités, bannière, tableau) — sinon
  il aurait fallu le réécrire à chaque lot. (b) mobile : `overflow-x-auto` conservé sur une
  table passée à 4 colonnes. Énoncé d'origine : finitions visuelles. (a) Devise
  affichée en code ISO brut (« MUR »/« USD ») au lieu du symbole `Rs`/`$`/`€` (raccord
  `format-montant` — même si aucun montant ici) ; (b) mobile : `overflow-x-auto` + Select
  ~200px min → scroll horizontal plutôt qu'un repli responsive ; (c) pas de `loading.tsx` sur
  `/admin/entites` (premier affichage sans skeleton). **Déclencheur** : passe de polish design
  sur l'écran admin.

### Constats résiduels de la cross-review /admin/entites (2026-07-13)

Les trois défauts BLOQUANTS de la revue (garde d'archivage contournable sous ADMIN scopé ;
garde à sens unique ; mapping SQLSTATE 42501 non prouvé) ont été **corrigés dans le lot**,
pas consignés — ils touchaient l'isolation (règle 9 : ça se corrige, ça ne se diffère pas).
Restent deux constats mineurs, sans impact d'isolation :

- [ ] **DEMO-ACTIONS1 (P2, effort ~0,5 j) — les routes `/demo/*` sont PUBLIQUES et montent
  des composants qui importent de vraies Server Actions ADMIN.** `/demo/assignation-comptes`
  et `/demo/admin-gestion-entites` rendent les vrais composants (c'est l'objet du Visual QA,
  Gate 4). Un clic anonyme sur « Create entity » appelle donc `creerEntiteAction`, qui lève
  `NonAuthentifieError` — **fail-closed, aucune écriture possible**, mais l'erreur n'est pas
  attrapée et la décision « /demo public » (PR #43) supposait des « routes pures ». Défaut
  **préexistant** (déjà vrai de `/demo/assignation-comptes` avant ce chantier).
  Pistes : gater `/demo` hors production via le middleware, ou injecter des handlers inertes
  dans les démos. **Déclencheur** : mise en service prod (les routes de démo ne doivent pas
  être servies publiquement en production).

- [ ] **ADMIN-PERIMETRES-MORT1 (P2, effort ~0,25 j) — `admin/perimetres/actions.ts` n'a
  aucun appelant.** `octroyerScopeAction` / `revoquerScopeAction` (maille fine party/compte,
  L6a) existent, sont gardées ADMIN et viennent d'être migrées vers
  `exigerSessionAdministration()` (L0) — mais **aucune page `/admin/perimetres` ne les
  appelle**. Soit on livre la surface UI (elle pilote `account_scope`, le 3ᵉ axe de
  périmètre), soit on retire le code. **Déclencheur** : décision produit sur la maille fine
  (lot L9 du plan Entités), ou revue de dette de fin d'epic.

### Outillage de test — la concurrence n'est PAS prouvée par PGlite (2026-07-13)

- [ ] **TEST-CONCURRENCE1 (P1, effort ~1 j, gardien Backend) — la suite d'isolation ne peut
  structurellement pas attraper un TOCTOU.** ⚠️ **Découverte de la cross-review finale, et
  c'est la dette la plus importante de ce chantier.**
  **Quoi** : `tests/isolation/*` tourne sous **PGlite**, qui est **MONO-CONNEXION**. Aucun
  test ne peut donc ouvrir deux transactions concurrentes — toute la classe des bugs
  *check-then-act* (lire une condition, agir dessus, pendant qu'une autre transaction la
  change) est **invisible** à la suite, alors même qu'elle est verte.
  **Preuve que ce n'est pas théorique** : la revue finale a trouvé, en rejouant le SQL des
  repos sur le **Postgres Docker** du projet, un TOCTOU réel — `exigerEntiteCibleActive`
  lisait `is_active` sans verrou pendant qu'`archiverEntite` archivait, produisant l'état
  interdit « entité ARCHIVÉE portant un compte ». Corrigé (`.for("update")`), mais **la
  correction n'est couverte par aucun test** : la suite ne peut pas l'exercer.
  **À faire** : une suite de concurrence sur le Postgres Docker (déjà décrit dans CLAUDE.md,
  « Dev local — stack de validation »), avec 2 connexions réelles, exerçant au minimum les
  paires : `archiverEntite` ↔ `assignerComptesEntite`, `archiverEntite` ↔
  `definirScopesMembre`. Sans elle, tout verrou `FOR UPDATE` posé dans ce repo est une
  affirmation non vérifiée.
  **Déclencheur** : IMMÉDIAT (P1) — avant le premier déploiement de production, parce que la
  classe de bugs concernée produit des états interdits que les gardes applicatives croient
  avoir fermés. Ne touche ni l'append-only ni les montants ; c'est une dette d'OUTILLAGE, pas
  d'isolation (les invariants, eux, sont posés).

- [ ] **SCOPE-FIN-CULDESAC1 (P2, effort ~0,25 j) — `revoquerScopeFin` ne peut jamais réparer
  un ADMIN portant ≥2 scopes fins hérités.** Il retire UNE cible puis délègue à
  `definirScopesFinsMembre`, qui refuse tout jeu NON VIDE sur un ADMIN (§12) : chaque
  révocation unitaire laisse un reste non vide → `AdminNonScopableError` → aucune révocation
  ne peut aboutir. Seul l'appel groupé « listes vides » répare.
  **Inatteignable aujourd'hui** : `/admin/perimetres` n'a aucune surface UI
  (`ADMIN-PERIMETRES-MORT1`), et l'axe ENTITÉ dispose désormais de son bouton de réparation
  (« Clear restriction » sur la carte d'un ADMIN). Mais c'est un piège ARMÉ pour le jour où
  la maille fine sera livrée. **À faire à ce moment-là** : autoriser une révocation qui
  RÉDUIT strictement le périmètre d'un ADMIN, ou n'exposer que le retrait total.
  **Déclencheur** : ouverture de la surface `/admin/perimetres`.

### Vigilance — promotion de rôle et périmètre (2026-07-13)

- [ ] **ROLE-PROMOTION-SCOPE1 (P2, effort ~0,25 j, gardien Backend) — si un jour on ajoute
  la PROMOTION de rôle, purger ou refuser le périmètre.** Depuis §12 (2026-07-13), un ADMIN
  ne peut PAS être restreint à un périmètre (`AdminNonScopableError`, posée sur les deux
  axes : `definirScopesMembre` et `definirScopesFinsMembre` ; héritée par `octroyerScopeFin`
  et `creerMembreAvecScopes`).
  **Le trou n'est pas atteignable aujourd'hui** : il n'existe AUCUN chemin de promotion de
  rôle dans l'app — le rôle est fixé à la création du membre, aucun `UPDATE
  workspace_members.role` n'existe dans les repositories (vérifié). Mais le jour où on
  ajoutera « changer le rôle d'un membre », promouvoir un MANAGER **scopé** en ADMIN
  recréerait exactement l'état que §12 interdit : ses lectures seraient partielles (bandeau
  « Restricted view ») et ses gardes d'écriture le bloqueraient (`PerimetreReduitError`).
  **À faire à ce moment-là** : soit purger les scopes dans la MÊME transaction que la
  promotion, soit la refuser tant que le membre est scopé (et exiger un déscopage préalable).
  **Déclencheur** : ouverture d'une surface de changement de rôle.

### Langue de l'interface — migration FR → EN (2026-07-13)

- [ ] **I18N-EN1 (P2, effort ~3-5 j, gardien Front) — migrer TOUTE l'interface en anglais.**
  **Quoi** : l'app est intégralement en français (copie en dur dans les composants, les
  Server Actions et les messages d'erreur). **Aucun socle i18n n'existe** : ni `next-intl`,
  ni `react-i18next`, ni dossier `messages/`/`locales/`. **Pourquoi** : décision PO
  (2026-07-13) — les utilisateurs finaux (Financial Managers des BU mauriciennes)
  travaillent **en anglais** ; le français n'est qu'un artefact de développement. C'est donc
  une **dette de destination**, pas une préférence.
  **Chantier NOMMÉ À PART** (règles 7/9 — pas d'expansion de scope dans les refontes en
  cours). Deux options à trancher au démarrage : (a) remplacement direct des chaînes (pas de
  dépendance nouvelle, mais aucune bascule possible), (b) socle i18n (`next-intl`) + clés —
  plus lourd, justifié seulement si un jour on doit servir FR **et** EN.
  ⚠️ **Points d'attention relevés en recon** : les primitives **partagées** portent des
  micro-chaînes FR en dur (`Select` « Aucune option. » `select.tsx:313` ; `Modal`
  `aria-label="Fermer"` `modal.tsx:145` ; `AppErrorState` « Réessayer »
  `app-error-state.tsx:62`) — elles fuiraient dans **toute** page traduite. Le vocabulaire de
  sécurité (« Vision Globale » / « Vision Entité ») vit sur **deux** écrans admin
  (`/admin/entites` **et** `/admin/membres`) : le traduire d'un seul côté ferait parler deux
  dialectes à la même notion.
  **Contrainte immédiate (applicable dès maintenant)** : tout nouveau développement
  **n'ajoute aucune nouvelle copie FR en dur**. La refonte `/admin/entites`
  (`PLAN-refonte-entites.md`, Q-LANG) sert de **pilote** : écran ADMIN-only, surface étroite,
  faible risque de régression.
  **Déclencheur** : avant l'onboarding des premiers utilisateurs finaux (mise en service
  prod réelle). Ne touche ni l'isolation, ni les tables append-only, ni les montants
  (surface de rendu).

### Outillage migrations DB — db:migrate câblé + drift résolu (2026-06-19)

`/investigate` : `/transactions` plantait au runtime sur « relation "categories"
does not exist » (RSC `page.tsx:62` → `listerCategories` → `categorisation.ts:414`).
ROOT CAUSE = **drift de migration** : la base locale était restée à 0003/0004 ;
les migrations **0005 (Pilier 1 : categories, transaction_categorizations,
categorization_audit)** et 0006 n'avaient jamais été appliquées. Cause STRUCTURELLE :
**aucun script `db:migrate` n'existait** (db:generate générait les .sql, rien ne les
APPLIQUAIT) + la table de suivi `drizzle.__drizzle_migrations` n'existait pas (les
0000→0006 avaient été posées à la main). PGlite reconstruit tout le schéma → tests
verts, drift invisible en CI unitaire.

Corrigé (LOCAL prouvé) : 0005 appliquée (owner) + `db:provision` rejoué (GRANT/RLS
sur les 3 tables ; `categorization_audit` reste INSERT/SELECT seul, trigger
append-only 0005 OK). Requête exacte rejouée sous `tygr_app` + RLS → passe (0 row).
Outillage AJOUTÉ (`scripts/migrate.mjs` + `scripts/baseline-migrations.mjs`,
`db:migrate`/`db:baseline` dans package.json) : migrator Drizzle officiel + baseline
idempotent reproduisant à l'identique le format du suivi (sha256 du .sql brut,
schéma `drizzle`, created_at = `when` du journal). Pipeline `db:provision → db:migrate
→ deploy` enfin RÉELLE (avant : étape migrate fantôme, cf. commentaire provision.mjs:6).

- [ ] **DB-MIGRATE1 (P2, point de DÉPLOIEMENT) — baseline+migrate sur la base cloud** —
  Effort S, gardien Backend. ⚠️ **CORRIGÉ 2026-06-19** : il n'existe AUCUNE base Neon cloud
  aujourd'hui. `DATABASE_URL` ET `DATABASE_URL_ADMIN` pointent sur le Docker LOCAL
  (`tygr_postgres:5432` via `NEON_WSPROXY_LOCAL`) ; aucune URL `neon.tech`, aucun
  `.env.production`. « Neon » = juste le driver WebSocket. **La seule base réelle (Docker local)
  est DÉJÀ à jour** (fix appliqué). Donc rien à migrer maintenant. **Dépend du déploiement**
  (point 7 ROADMAP) : le jour où une instance cloud est créée, lancer `db:baseline` UNE FOIS
  (si base pré-existante) puis `db:migrate` — OU sur base NEUVE `db:migrate` direct (PAS de
  baseline) puis re-`db:provision` (GRANT DELETE liste-blanche, cf. #3bis). **Déclencheur** :
  création de l'instance cloud / 1er déploiement réel.
- [ ] **DB-MIGRATE2 (P2) — intégrer `db:migrate` à la CI bloquante** — Effort S. La
  pipeline canonique (CLAUDE.md règle 9 : lint→typecheck→tests→isolation→build→migrations)
  n'a pas d'étape migrate exécutée. Ajouter `db:provision && db:migrate` contre une base
  éphémère au CI pour ATTRAPER ce drift (un .sql généré mais jamais appliqué casserait
  alors le CI, pas le runtime). **Déclencheur** : mise en place du workflow CI/CD.
- [ ] **DB-MIGRATE3 (P2) — `0009_entity-write-scope` absente du journal Drizzle** —
  Effort S, gardien Backend. Découvert 2026-06-22 en générant la migration du moteur de
  règles (`db:generate` a numéroté `0009`, collision). Le fichier
  `drizzle/migrations/0009_entity-write-scope.sql` existe sur `main` (PR #85) mais n'a NI
  entrée dans `meta/_journal.json` NI `meta/0009_snapshot.json` — il a été posé « à la main »
  (comme les 0000→0006 historiques, cf. DB-MIGRATE1). Conséquence : l'état Drizzle est
  désynchronisé du disque ; un futur `db:generate` peut re-collisionner ou diffuser un
  snapshot incohérent. La suite d'isolation applique les `.sql` PAR NOM (pas via le journal)
  → l'exécution réelle est correcte (0009 puis 0010 s'appliquent), seul l'outillage Drizzle
  est en dette. **Contournement appliqué** (PR moteur de règles) : ma migration renommée
  `0010_categorization-rules` + journal à `idx:10` (le trou idx:9 reflète honnêtement le
  0009 hors-journal). **À faire** : régénérer un `meta/0009_snapshot.json` cohérent + entrée
  journal pour `0009_entity-write-scope` (ou rebaseliner proprement). **Déclencheur** :
  prochain `db:generate` qui touche le schéma, ou mise en place de DB-MIGRATE2.
  **NON une dette d'isolation** (n'affecte ni la RLS ni l'append-only — purement outillage).

### Page /transactions — câblée et opérationnelle (UI, 2026-06-17)

L'UI complète de `/transactions` (table dense, pagination, injection
SplitAllocationModal) est livrée ET câblée sur les vraies Server Actions Backend.
La réconciliation des contrats Backend↔UI vit dans
`src/app/(workspace)/transactions/adapter.ts` (statut MAJ→min, compteNom via map
comptes, curseur opaque string + hasMore, libellé non-PII).

- [x] **TX-B1 — `listerTransactionsAction` (lecture paginée + filtres)** — LIVRÉ
      (Backend, PR #45) + CÂBLÉ (PR à suivre). Pagination keyset, filtres
      `bankAccountId` + `statut`.
- [x] **TX-B2 — résumé de ventilation par ligne** — LIVRÉ + CÂBLÉ. Backend renvoie
      `statut` + `nbSplits` (PAS la catégorie unique nommée → l'UI affiche un badge
      de comptage générique « 1 catégorie » / « N catégories »).
- [x] **TX-B3bis — `listerSplitsAction`** — LIVRÉ (Backend) + CÂBLÉ. LÈVE une
      exception en cas d'échec (≠ `[]` faussement vide) ; le conteneur try/catch et
      BLOQUE l'ouverture de la modale (alerte « Erreur de chargement ») —
      anti-écrasement des splits. Vérifié au Visual QA (ligne t5 de la démo).

Dettes ouvertes héritées du câblage :

- [ ] **TX-FILTRE1 (P2) — filtre Sens (Entrées/Sorties) absent** — Effort S
      (gardien Backend). Le schéma de lecture (`listerTransactionsSchema`, `.strict`)
      n'a pas de champ `sens`/`creditDebit` ; le segmented control Sens a donc été
      RETIRÉ de la toolbar v1 (le filtrer côté client casserait la pagination —
      pages tronquées). **Déclencheur** : première demande utilisateur de filtrer
      entrées/sorties. Backend ajoute `sens` au schéma + au WHERE (colonne
      `credit_debit` indexable) ; l'UI ré-active le segmented (commenté dans
      `transactions-toolbar.tsx`) + le champ `FiltresTransactions.sens` + le mapping
      dans `adapter.ts:versInputBackend`.
- [ ] **TX-BADGE1 (P2) — nom de la catégorie unique sur la ligne** — Effort S
      (gardien Backend). Quand `nbSplits===1`, la liste affiche « 1 catégorie »
      générique faute du nom (B2 ne renvoie pas `categorie {id,name}`). **Déclencheur** :
      retour UX « je veux voir la catégorie sans cliquer ». Backend enrichit la ligne
      du `categoryId`/`categoryName` quand il n'y a qu'un split ; l'UI peuple alors
      `TransactionListItem.categorie` (déjà prévu au type) → `CategoryBadge` nommé.
      **Re-confirmé par clawdy (2026-07-01)** : souhait explicite d'afficher le **nom +
      un badge** de la catégorie au lieu du **compteur** « 1 catégorie ». C'est
      exactement ce ticket ; le bug QA remonté sous l'étiquette « TX-QA-CAT-BADGE1 » y
      est **absorbé** (pas de doublon, règle 9). Recoupe aussi la partie « afficher le
      nom + corriger l'accord pluriel » de **QA-UX-CATEG-COHERENCE1**.
- [x] **TECH-DASHBOARD-CASCADE (P2) — aligner la table du DASHBOARD sur la cascade de
      libellé de `/transactions`** — Effort M. Date 2026-06-23. **RÉSOLU 2026-07-10**
      (déclencheur atteint : retour Etienne « j'ai encore des libellés "Opération
      bancaire" sur le dashboard alors que /transactions n'en a plus »). Fait : (1)
      `TransactionRecente` (`server/repositories/dashboard.ts`) porte désormais
      `bankLabelRaw` et la requête `transactionsRecentes` le SELECT (jointure
      `bank_accounts` inchangée → isolation entity/tenant préservée ; colonne déjà
      indexée, aucun coût perf) ; (2) la table dashboard (`transactions-table.tsx`)
      passe `bankLabelRaw={t.bankLabelRaw}` + `categorieFr={null}` (catégorie SAUTÉE
      dans la cascade car le dashboard a une colonne Catégorie DÉDIÉE → pas d'anti-
      doublon à transposer) + `title` au survol → cascade effective marchand → brut →
      repli. On ne tombe plus sur « Opération bancaire » quand un narratif brut existe.
      Note PII : le narratif OBIE `TransactionInformation` reste hors logs/aria
      (interdiction règle 8 intacte), affiché seulement dans l'UI du propriétaire.

Aucune de ces dettes ne touche l'isolation tenant / l'append-only / les montants.
Plan de référence : `PLAN-transactions-page.md`.

### Bugs QA /transactions relevés par clawdy (2026-07-01)

Passe QA visuelle de la page `/transactions` et de la modale de ventilation par clawdy.
Constats d'**ergonomie / affordance / layout** — aucun ne touche l'isolation tenant,
l'append-only ni les montants (sinon corrigé immédiatement, pas consigné). Bugs de fond
sur la catégorie (compteur au lieu du nom, filtre Sens) déjà tracés ailleurs :
**TX-QA-CAT-BADGE1** est absorbé par **TX-BADGE1** (ci-dessus, re-confirmé le 2026-07-01)
et n'est donc PAS ré-ouvert ici (règle 9). Fichiers cités vérifiés en lecture seule.

- [ ] **TX-QA-CURSOR1 (P2) — `cursor: pointer` absent au survol des boutons cliquables**
      — Effort S (gardien Front). Date 2026-07-01. Les éléments cliquables du picker de
      catégorie et de la modale de ventilation n'exposent **aucun** `cursor-pointer` : au
      survol, le curseur reste une flèche → l'utilisateur ne perçoit pas qu'ils sont
      cliquables. Vérifié : les seuls `cursor-*` présents sont des `disabled:cursor-not-allowed`
      (état désactivé). Éléments concernés (tous SANS `cursor-pointer`) : options de
      catégorie et « + Ajouter une catégorie » (`src/components/ui/category/category-picker.tsx:203`,
      `:282`), boutons Créer / Annuler (`category-picker.tsx:324`, `:335`), boutons de la
      modale de ventilation ouvrir/valider/ajouter/retirer/« catégoriser le reste »
      (`src/components/ui/category/split-allocation-modal.tsx:199`, `:207`, `:378`, `:394`,
      `:407`), « Charger plus » et fermeture d'erreur (`src/components/transactions/transactions-feature.tsx:209`,
      `:260`), archiver une catégorie (`src/components/ui/category/category-manager-modal.tsx:234`),
      croix de fermeture de modale (`src/components/ui/modal/modal.tsx:140`). **Exception** :
      la LIGNE du tableau (`<tr>`) porte déjà `cursor-pointer` (`transaction-row.tsx:90`) —
      elle n'est pas concernée. **Déclencheur** : cette passe QA (affordance des contrôles).

- [ ] **TX-QA-CREER-CAT-OVERFLOW1 (P2) — le bloc « créer une catégorie » déborde de son
      conteneur (bouton « Annuler » qui dépasse)** — Effort S (gardien Front). Date
      2026-07-01. Dans le picker de catégorie, le mode déplié de création aligne sur UNE
      seule rangée un `<input>` + les boutons « Créer » et « Annuler » via un
      `flex items-center gap-2`, sans `flex-wrap` ni contrainte de rétrécissement sur le
      champ ; dans la largeur étroite du popover, l'ensemble déborde et « Annuler » sort du
      cadre. Fichier probable : `src/components/ui/category/category-picker.tsx:296-346`
      (conteneur `flex` ligne 298, `input flex-1` ligne 320, boutons lignes 324 et 335).
      **Déclencheur** : cette passe QA (layout du bloc de création inline).

- [x] **TX-QA-FILTRE-CAT1 (P2) — filtre par catégorie absent sur `/transactions`** —
      ✅ LIVRÉ (branche `feat/transactions-filtre-categorie`, 2026-07-22, plan
      `docs/specs/PLAN-transactions-filtre-categorie.md`). Arbitrage §2 : sémantique
      **EXISTS un split de la catégorie** (appartenance — pas la dominante, pas la
      catégorie OBIE amont), prédicat corrélé ajouté à `conditionsFiltres` (partagé
      liste ↔ somme nette : propagation mécanique via `filtresTransactions`).
      Select « Toutes catégories » (hiérarchie Nature → Sous-natures) dans la toolbar,
      options fournies par le conteneur (toolbar pure). `categorieId` + statut « Non
      catégorisé » = ensemble vide PAR CONSTRUCTION (documenté, empty state standard).
      Preuves : schéma/adaptateur/groupeur en unitaire + 6 cas d'isolation (cohérence
      liste↔somme, split minoritaire, AND cumulé, catégorie sans transaction,
      cross-tenant sans oracle).

- [ ] **TX-FILTRE-CAT-SOUSARBRE1 (P2) — filtre catégorie : pas de sémantique
      « sous-arbre » (Nature ⊅ Sous-natures)** — Effort S. Date 2026-07-22. Le filtre
      livré par TX-QA-FILTRE-CAT1 est une égalité STRICTE sur `category_id` : filtrer
      par une Nature ne remonte PAS les splits posés sur ses Sous-natures (choix
      assumé, PLAN-transactions-filtre-categorie §2.2 — le sous-arbre est une
      sémantique différente qui mérite son propre arbitrage produit et son libellé
      UI). Si le besoin « la Nature et tout ce qu'elle contient » émerge, étendre le
      prédicat EXISTS à `category_id IN (X, enfants de X)` côté repository (le
      référentiel est à 2 niveaux, pas de récursion nécessaire) + le documenter dans
      le Select. **Déclencheur** : retour utilisateur demandant qu'une Nature agrège
      ses sous-natures dans le filtre.

- [ ] **TX-FILTRE-RACE1 (P2) — réponses out-of-order entre deux rechargements de la
      page 1 de /transactions** — Effort S-M. Date 2026-07-22 (cross-review du filtre
      catégorie ; défaut PRÉ-EXISTANT, pas introduit par lui). Deux
      `rechargerPremierePage` concurrents ne sont pas séquencés
      (`src/components/transactions/transactions-feature.tsx`, pas de jeton de
      requête/abort) : la toolbar est `disabled` pendant un chargement MAIS le timer
      de debounce de la recherche (`transactions-toolbar.tsx`) peut émettre pendant un
      vol → si la réponse du filtre N arrive APRÈS celle du filtre N+1, liste + bandeau
      affichent un jeu qui ne correspond plus à l'état des filtres. Même famille : le
      nettoyage post-archivage dans `rechargerReferentiel` ré-applique un instantané de
      `filtres` capturé avant un `await` (fenêtre quasi inatteignable — un `filtresRef`,
      idiome déjà présent dans la toolbar, la fermerait). Correctif cible : jeton de
      séquence (ignorer toute réponse qui n'est pas la dernière émise). Occurrence
      rare (exige une inversion réseau). **Déclencheur** : signalement d'une liste
      incohérente avec les filtres affichés, ou prochaine itération sur la toolbar.

- [x] **TX-QA-SPLIT-DOUBLON1 (P1) — deux splits sur la MÊME catégorie autorisés sur une
      transaction ventilée** — ✅ LIVRÉ (branche `feat/tx-split-doublon`, 2026-07-01). Garde
      SERVEUR canonique `CategorieDupliqueeError` (code `CATEGORY_DUPLICATE_IN_SPLIT`) dans
      `remplacerSplits`, insérée AVANT le bloc somme (ordre « doublon d'abord » verrouillé par
      un test dédié : payload 900+200 sur la même catégorie → CategorieDupliquee, PAS
      VentilationDepasse). Défense en profondeur : `.superRefine` d'unicité sur
      `remplacerSplitsSchema` + gating UI (`lignesEnDoublon` pur, marquage `danger` +
      `role="alert"` + « Valider » désactivé). Invariant de somme INCHANGÉ (ajout only).
      Tests : +4 isolation (rejet, contrôle distinct, ordre, non-régression atomicité) avec
      fixture `CAT_A2`, migration chirurgicale des cas de somme (categoryId seul modifié,
      montants/seuils intacts) ; +5 unitaires `lignesEnDoublon`/`peutValider`. Suite complète
      785/785 verte, typecheck+lint+build OK, Visual QA du gating concluant. Effort S/M
      (gardien Backend + Front). Date 2026-07-01.
      Reproduit par clawdy : on peut affecter DEUX parts de ventilation à la même catégorie
      sur une même transaction. Aucun sens métier (fausse tout regroupement par catégorie).
      **Décision clawdy 2026-07-01 : INTERDIRE** (erreur à la validation), **pas** de fusion
      automatique des montants. Garde **REQUISE côté SERVEUR** — la ventilation est écrite par
      `remplacerSplits` (état cible complet, tout-ou-rien), qui est la vérité : une garde UI
      seule est contournable par appel direct de la Server Action. Poser le rejet des
      catégories en double dans le repository, à côté de l'invariant de somme existant
      (`src/server/repositories/categorisation.ts:298` `remplacerSplits`, étape 2 validation
      de l'état cible ; lève actuellement `VentilationDepasseError` — prévoir une erreur
      nommée dédiée, ex. `CategorieDupliqueeError`), et/ou dans le schéma
      (`src/lib/categorisation-schema.ts:66` `remplacerSplitsSchema`, `.array().max(50)`
      sans contrainte d'unicité aujourd'hui). Idéalement AUSSI une erreur inline UI en amont
      (« catégorie déjà utilisée ») dans `src/components/ui/category/split-allocation-modal.tsx`
      pour ne pas amener l'utilisateur jusqu'au rejet serveur. Touche la ventilation → **test
      d'isolation du cas attendu** (2 splits même catégorie → rejet). NB : ce n'est **pas** une
      dette d'isolation tenant / append-only / montants (qui se corrigeraient immédiatement) —
      c'est une **règle d'intégrité de ventilation**. Marqué **P1** car bug de **données**, pas
      du polish. **Déclencheur** : cette passe QA (intégrité de la ventilation).

- [x] **TX-QA-SPLIT-MAX1 (P2) — bouton « Tout le reste » / « Max » pour remplir le montant
      restant d'un split** — ✅ LIVRÉ (branche `feat/tx-split-max`, 2026-07-01). Chaque ligne
      de la modale de ventilation porte un lien « Tout le reste » qui met SON montant = montant
      restant à ventiler, en un clic (fini la saisie manuelle du chiffre exact). Helper PUR
      `montantPourLeReste(montantTotal, lignes, cleLigne)` dans `allocation.ts` : calcul 100 %
      centimes (BigInt, règle 8, aucun float), il EXCLUT la contribution actuelle de la ligne
      (`total − sommeDesAUTRESlignes`) sinon on sous-compterait ; renvoie `null` si ≤ 0 (ligne
      déjà couverte par les autres OU dépassement) → bouton MASQUÉ, jamais de négatif injecté.
      Distinct de `categoriserLeReste` (qui, lui, crée une NOUVELLE ligne). Décision produit :
      autorisé même SANS catégorie choisie (remplit juste le montant ; `peutValider` garde le
      blocage à l'envoi). Gardes #157 (doublon) et invariant de somme intacts — c'est de l'aide
      à la saisie, la validation serveur reste la vérité. Tests : 8 cas ajoutés dans
      `tests/unit/allocation.test.ts` (reste positif, exclusion de la contribution courante,
      décimales exactes, reste 0 → null, dépassement des autres → null, sans catégorie).
      Visual QA `/demo/transactions` : clic remplit au centime près, reste tombe à 0 ; ligne
      couverte / dépassement → bouton off. **Déclencheur** : cette passe QA.

### Findings QA nav + Empty States (UI, 2026-06-17)

- [x] **Routes `/demo/*` redirigées vers `/login` (P1, sécurité/routing)** —
  ✅ RÉSOLU (PR #43, vérifié 2026-06-26). Le matcher `src/proxy.ts:41` exclut
  désormais `demo` de l'allowlist (`(?!login|api/auth|demo|_next/...)`) → `/demo/*`
  est PUBLIC (décision PO + QA B-1 : bac à sable sans DB/auth, n'expose rien). Le
  Visual QA Gate 4 fonctionne. [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [ ] **Empty State de section : débordement header mobile 375px (P2, UI démo)** —
  relevé par /qa 2026-06-17. Effort S. Le chrome reconstitué EN DUR de
  `/demo/dashboard-states` (pas le vrai shell) casse à 375px : badge « Démo · Visual
  QA » sur 3 lignes, nav qui déborde (« Transactions » coupé). **Déclencheur** :
  chantier responsive / TODO P2 UI-ES1. Hors production, n'affecte que la capture.
- [ ] **Header applicatif (`AppHeader`) non responsive — déborde < ~1100px (P2, UI)** —
  relevé au Visual QA du CTA banque, 2026-06-19. Effort M. Le VRAI header
  (`src/components/shell/app-header.tsx`) aligne logo + nav + switcher + CTA + Membres
  + déconnexion en flex SANS `flex-wrap` ni menu hamburger : il débordait DÉJÀ avant ce
  travail (mesuré 471px > 375px viewport mobile, header seul). Le nouveau CTA permanent
  « Connecter une banque » (label long) AGGRAVE la magnitude (→ 925px à 375px) sans
  créer le problème. **Desktop ≥1280px : aucun débordement (parcours FM réel OK).**
  Contexte produit : TYGR cible des Financial Managers en usage desktop ; le mobile
  n'est pas un parcours prioritaire et n'a aucune stratégie responsive à ce jour.
  **Déclencheur de résolution** : premier chantier responsive du shell (menu condensé /
  hamburger < md, ou CTA réduit à une icône `+` seule sur petit écran). Hors périmètre
  de la tâche CTA (refonte responsive = surface nav/switcher large). Signalé à l'humain
  dans la note de PR.
- [ ] **Tableaux dashboard (`MonthlyCashflow` + `TransactionsTable`) débordent < ~430px (P2, UI)** —
  relevé au Visual QA de la PR « dashboard insights » (2026-06-24). Effort S. Mesuré au
  DOM à 390px : `table.w-full` (Évolution mensuelle, en-têtes Mois/Entrées/Sorties/Variation,
  right=475) et l'en-tête « Montant » de `TransactionsTable` (right=508) dépassent le
  viewport → scroll horizontal de page. **PRÉEXISTANT** : ces deux composants ne sont PAS
  modifiés par la PR insights (diff DOM le confirme — mes composants `CashflowMainChart`,
  `CashFlowSummary`, `TopVendorsCard` ne débordent pas, leurs grilles passent en 1 colonne
  sous `sm:`). Même famille et même déclencheur que la dette `AppHeader` ci-dessus : desktop
  ≥1280px sain (parcours FM réel), mobile non prioritaire. **Déclencheur** : premier chantier
  responsive du shell (les tableaux denses passeront en scroll-x encapsulé `overflow-x-auto`
  ou en cartes empilées sous `md`). Signalé à l'humain dans la note de PR.
- [ ] **DASH-CASHFLOW-MULTISERIE — la courbe de flux n'affiche qu'UNE devise (P2, UI/data)** —
  ouvert 2026-06-24 (PR « dashboard insights »). Effort M. `cashflowParDevise` renvoie le
  flux net par (mois, devise) ; la page (`(dashboard)/page.tsx`) filtre sur `base_currency`
  pour rester mono-série (`flux.points.filter(p => p.currency === deviseBase)`). Conséquence :
  un workspace dont les flux sont MAJORITAIREMENT dans une devise ≠ base_currency verra une
  courbe vide (état « partiel ») alors que des transactions existent — les SOLDES et la
  SYNTHÈSE (ventilée, non filtrée) restent affichés, donc pas de perte de donnée, juste la
  courbe muette. **Déclencheur** : premier workspace réellement multi-devise actif en démo.
  Résolution : courbe multi-série (une ligne/devise) ou sélecteur de devise au-dessus de la
  carte. Aucune addition cross-devise (DASH-FX1 reste interdit).
- [ ] **DASH-COURBE-SOLDE-EOD — réintroduire la vue « solde » quand l'API livrera l'historique (P2, data)** —
  ouvert 2026-06-24. Effort M. La courbe consommait `courbeTresorerie` (`balance_history`),
  remplacée par le flux net (`cashflowParDevise`) car `balance_history` est VIDE en Staging
  (Omni-FI n'expose pas `/balances/history`, cf. DASH-SOLDE2 / INSIGHTS-AMONT1). `courbeTresorerie`
  + `PointCourbe` sont CONSERVÉS dans `dashboard.ts` (non supprimés) mais ne sont plus appelés.
  **Déclencheur** : passage 501→200 de `/balances/history` côté Omni-FI. Résolution : décider
  d'une vue « solde EOD » à côté de la vue « flux » (onglet/toggle), ou retirer définitivement
  `courbeTresorerie` si le solde reste hors périmètre.
- [ ] **DASH-VENDORS-DIRECTION — figer/déverrouiller le sens du panneau Top contreparties (P2, UI)** —
  ouvert 2026-06-24. Effort S. `TopVendorsCard` est câblé en dur sur `direction: "outflow"`
  (dépenses) ; `vendorsParConcentration` supporte aussi `inflow` et `both` (le composant gère
  déjà les 3 libellés). **Déclencheur** : retour utilisateur demandant à voir les recettes.
  Résolution : toggle inflow/outflow/both au-dessus du panneau (state client + re-fetch via
  Server Action dédiée, ou pré-charger les 3 sens côté RSC).

### Refonte lisibilité Dashboard (UI, 2026-06-19)

Travail UI livré (branche `feat/ui-dashboard-refactor`) : bouton de re-synchro
renommé « Synchroniser mes comptes » (+ icône ↻) dans `bank-connect-widget.tsx` ;
carte « Comptes connectés » préparée à afficher la PROVENANCE bancaire (contract-first).
Reste deux dettes à la frontière Backend :

- [x] **DASH-INST1 (P1) — persister le nom d'institution (`institution_name`)** —
  ✅ **LIVRÉ 2026-06-19 (Backend, branche `feat/ingestion-institution-name`)**. Les 3
  étapes faites : (1) migration `0006_add-institution-name.sql` (`institution_name`
  varchar(140) nullable, expand-safe) ; (2) ingestion persiste
  `normaliserNomInstitution(conn.InstitutionName)` via `upsertConnexion` (+ rafraîchi
  au `onConflictDoUpdate`) ; (3) `listerComptes` joint `bank_connections` (innerJoin,
  `connection_id` NOT NULL) → `CompteConnecte.institutionName`. Nuance : à la
  finalisation widget (`link-exchange` ne renvoie pas `InstitutionName`) on insère
  `null` ; le nom est renseigné au prochain `ingererConnexions` (GET /connections).
  Fonction pure `normaliserNomInstitution` (trim/null/troncature) + 5 tests. Reste
  HISTORIQUE ci-dessous :
  relevé 2026-06-19, effort M, **gardien Backend**. L'API Omni-FI FOURNIT
  `OmniFiConnection.InstitutionName` (`server/omnifi/types.ts:56`) mais l'ingestion
  (`server/ingestion/index.ts:55` → `upsertConnexion`) ne le persiste PAS : la table
  `bank_connections` n'a que `institution_id` (ID opaque), aucune colonne nom. La carte
  comptes affiche donc « Compte courant » sans la banque. **Côté UI c'est PRÊT**
  (`connected-accounts-card.tsx` : type `CompteAffiche` + `libelleCompte`, dégradation
  propre si absent — affiche « Absa · Compte courant » dès que la donnée arrive, zéro
  retouche UI). **À faire (Backend)** : (1) migration expand `bank_connections.institution_name`
  (varchar, nullable) ; (2) ingestion persiste `conn.InstitutionName` ; (3) `listerComptes`
  (`repositories/dashboard.ts`) jointure `bank_connections` → expose `institutionName`
  dans `CompteConnecte`. **Déclencheur** : cette demande produit (lisibilité provenance,
  2026-06-19) → DÛ. Ne touche PAS l'append-only/montants ; touche le contrat de lecture.
- [x] **DASH-DEDUP1 (P2, investigation) — doublons de comptes signalés en UI** —
  ✅ **AUDITÉ + PROUVÉ 2026-06-19 (Backend, même branche)**. Verdict : l'upsert compte
  est correct — `onConflictDoUpdate({ target: omnifi_account_id })` met à JOUR au lieu
  d'insérer. Plus qu'une présomption : un **test d'isolation dédié** prouve sur PGlite
  qu'un même `omnifi_account_id` re-découvert via une connexion DIFFÉRENTE ne crée
  qu'UNE ligne `bank_accounts` (le 2e upsert rafraîchit libellé/solde). Aucun doublon
  possible au niveau données. SI un doublon réapparaît en UI : ce serait un compte avec
  un `omnifi_account_id` réellement distinct côté Omni-FI (à investiguer alors avec
  capture). Reste HISTORIQUE ci-dessous :
  relevé 2026-06-19, effort S (investigation), gardien Backend. Une demande produit
  évoquait des comptes dupliqués à l'écran. **Analyse UI** : impossible par construction
  côté données — `bank_accounts.omnifi_account_id` est `UNIQUE` (`schema.ts:228`) et
  `upsertCompte` fait `onConflictDoUpdate` sur cette colonne (`repositories/ingestion.ts:112`) ;
  la carte utilise la PK UUID `bankAccountId` comme `key` React. **Décision (PO, 2026-06-19)** :
  NE PAS ajouter de dedupe côté React — il masquerait un éventuel bug d'ingestion au lieu
  de le corriger (anti-pattern). **À faire SI le symptôme se reproduit** : capture + contexte,
  puis investiguer l'ingestion (deux `bank_accounts` distincts pour le même compte réel ?
  `isSelected` mal posé ?). Pas d'action UI. **Déclencheur** : nouvelle observation de doublon
  avec preuve.
- Note : afficher la banque PAR LIGNE de transaction (table dashboard 4 colonnes serrées)
  a été ÉCARTÉ — la provenance vit dans la carte comptes (plus lisible), et `TransactionRecente`
  ne porte pas le nom (que `bankAccountId`). À rouvrir avec DASH-INST1 si besoin produit.
- [ ] **UI-ACCOUNTS-ACCORDEON-ENTITE1 (P2, effort M — Front, DÉPEND d'ENTITY-PARTY1) —
  la carte « Comptes connectés » est trop longue (77 comptes réels → scroll massif) ;
  la grouper en ACCORDÉON PAR ENTITÉ (repliable) et afficher le nom d'ENTITÉ.** Composant
  `src/components/dashboard/connected-accounts-card.tsx`. ⚠️ **DÉPENDANCE DURE** :
  grouper/nommer par entité EXIGE `bank_accounts.entity_id` peuplé → c'est exactement
  **ENTITY-PARTY1** (pont Party→entities→entity_id). Tant que les comptes sont
  `entity_id=NULL`, rien à grouper. DOWNSTREAM d'ENTITY-PARTY1 (+ ENTITY-UI1 pour
  créer/assigner, + QA-ENTITES-CREATION-UI1). ⚠️ **DÉCISION PRODUIT** (ne pas trancher en
  silence) : DASH-INST1 / DR-F2 / TX-PROVENANCE2 exposaient le nom de la BANQUE
  (`institutionName`) ; ici clawdy veut le nom d'ENTITÉ. Reco archi (clawdy 2026-07-02) :
  entête d'accordéon = ENTITÉ, mais garder la BANQUE en secondaire par ligne (sinon on
  perd « ce compte est chez MCB vs Absa »). Recoupe UI-PERIMETRE-ACCORDEON1 (même
  mécanique accordéon) mais AXE et composant différents. Isolation : rendu seulement, mais
  le groupement doit rester borné au scope entité du membre (RLS + jointure #83 /
  ENTITY-READ-JOIN1) — jamais d'entête d'entité hors scope. **Déclencheur** : ENTITY-PARTY1
  livrée ; le scroll est déjà là (77 comptes réels en prod).

### Solde Total dérivé des soldes courants, par devise (2026-06-19)

Le « Solde Total » du dashboard était à 0 et la courbe bloquée sur « en cours de
synchronisation » parce que TOUT dépendait de `balance_history`, VIDE (sa seule source
`/balances/history` est 404 chez Omni-FI, cf. §10). Décision PO (2026-06-19) : dériver le
Solde Total des **soldes courants** (`bank_accounts.current_balance`, bien remplis), **par
devise** (multi-devises, jamais d'addition cross-devise).

- [x] **DASH-SOLDE1 (Backend) — `soldesCourantsParDevise`** — ✅ LIVRÉ
  (branche `feat/dashboard-solde-multidevise`). `repositories/dashboard.ts` : nouvelle
  fonction (somme `current_balance` GROUP BY devise, SQL/numeric, comptes sélectionnés) +
  type `SoldeParDevise { currency, total }`. Indépendant de `balance_history`. 2 tests
  d'isolation (multi-devises MUR+USD, source = current_balance).
- [x] **DASH-SOLDE2 (P1, FRONTIÈRE FRONT) — câbler le Solde Total par devise dans l'UI** —
  ✅ **LIVRÉ + MERGÉ** (Front). Câblage initial **PR #69** (`feat(dashboard): câble le Solde
  Total par devise dans l'UI (DASH-SOLDE2)`, commit `5cb6115`) puis raffiné au **Lot 2 — PR #79**
  (`feat(dashboard): carte SOLDE hybride + pastille de fraîcheur`, commit `4e9e8b0`).
  `(dashboard)/page.tsx:80` appelle `soldesCourantsParDevise(tx)` et passe `SoldeParDevise[]`
  à `SidePanelKpi` ; `side-panel-kpi.tsx` rend une **ligne par devise** (mono → gros montant
  28px/700 `primary` ; multi → `SoldesMultiDevises`, pile égalitaire à virgules décimales
  alignées, grille `[auto_1fr]`), tout en `tabular-nums`, via `formatMontant` (chaînes, zéro
  float). Jamais d'addition cross-devise. Bonus inclus : la méta trompeuse « au JJ/MM »
  (anti-pattern DR-F3) est remplacée par la pastille de fraîcheur sur `lastSyncedAt`.
  L'ancien `soldeConsolide: string` ne sert plus qu'à la COURBE (EOD historique,
  `cashflow-main-chart.tsx`). **Case cochée 2026-06-22** (le code était en `main`, seule la
  case du registre restait ouverte). Reste HISTORIQUE ci-dessous :
  Effort S, **gardien Front**. La carte « SOLDE » (`dashboard-content.tsx` / le KPI haut)
  consomme aujourd'hui `soldeConsolide: string` (un montant unique = 0). À remplacer par la
  consommation de `soldesCourantsParDevise(tx)` → afficher une ligne par devise (« 8 074 400
  MUR » + « 179 200 USD »), `tabular-nums`. La page (`(dashboard)/page.tsx`) doit appeler la
  nouvelle fonction et passer `SoldeParDevise[]` au composant. **Déclencheur** : merge de
  DASH-SOLDE1. Backend prêt (contract-first) ; Front câble le rendu.
- [ ] **DASH-FX1 (P2) — conversion FX vers `base_currency` (un seul « Solde Total »)** —
  Effort M, gardien Backend. Pour afficher UN chiffre consolidé (pas une ligne par devise),
  il faut convertir USD/EUR → MUR (`base_currency` du workspace) avec un **taux + date
  annotés** (CLAUDE.md : conversion FX annotée, jamais de float). EXIGE une source de taux
  (table de taux, API FX). **Déclencheur** : besoin produit d'un total unique cross-devise.
  Tant qu'absent, l'affichage par devise (DASH-SOLDE2) est la voie correcte — aucun taux
  inventé.

### Challenge intégrité/mapping des données (2026-06-22, investigation)

Trois constats remontés (« 0,00 Rs », « tout en Rs », « Main Operating Account » au lieu
de la banque). Diagnostic ci-dessous ; deux corrections Backend livrées
(`syntheseMoisParDevise`, provenance dans `listerTransactions`), le reste tracé.

- [x] **DASH-WSACTIF1 (P1, FRONTIÈRE FRONT/SESSION) — le dashboard lit le MAUVAIS workspace → « 0,00 Rs »** —
  ✅ RÉSOLU (PR #94, vérifié 2026-06-26). Les DEUX correctifs demandés sont en place :
  (1) **workspace par défaut = le plus peuplé en comptes** — `membershipParDefaut`
  (`identite.ts:228-247`) compte les `bank_accounts` par workspace et retourne le gagnant
  (repli déterministe par nom à égalité), au lieu du 1er par UUID ; câblé au login
  (`auth/config.ts:87`). (2) **sélecteur de workspace visible** —
  `components/shell/workspace-switcher.tsx` (100 l.) monté dans `app-header.tsx:51`, câblé
  sur l'action `basculerWorkspace`. L'utilisateur n'atterrit plus sur « Omni-FI HQ » vide.
  [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [x] **DASH-CASHFLOW-DEVISE1 (Backend) — `syntheseMois` sommait cross-devise (« tout en Rs »)** —
  ✅ LIVRÉ. `syntheseMois` additionnait `amount` MUR+USD sans GROUP BY → la carte Cash In/Out
  affichait un total mélangé dans la base_currency (faux dès qu'un workspace a plusieurs devises).
  Ajout de **`syntheseMoisParDevise`** (GROUP BY currency, renvoie `currency`), `syntheseMois`
  conservé @deprecated le temps de la migration Front. Prouvé en isolation (MUR/USD séparés).
- [x] **DASH-CASHFLOW-DEVISE2 (P1, FRONTIÈRE FRONT) — câbler `syntheseMoisParDevise` dans l'UI** —
  ✅ RÉSOLU (PR #115, vérifié 2026-06-26). `cash-flow-summary.tsx:34` reçoit
  `SyntheseMoisDevise[]` (une entrée par devise) et itère `BlocDevise key={s.currency}`
  (`:53`) ; alimenté par `page.tsx:105` (`syntheseMoisParDevise`). `syntheseMois` (déprécié)
  n'est plus consommé par l'UI. Convention multidevise respectée (un bloc par devise, pas
  d'addition cross-devise). [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [x] **TX-PROVENANCE1 (Backend) — exposer le nom d'institution par transaction** —
  ✅ LIVRÉ. `listerTransactions` joint désormais `bank_accounts` + `bank_connections` et expose
  `accountName` + `institutionName` sur `TransactionLigne` (la colonne vit sur
  `bank_connections.institution_name`, PAS `bank_accounts` comme supposé). Bonus : la jointure
  `bank_accounts` fait hériter le scope entité (ENTITY-READ-JOIN1).
- [ ] **TX-PROVENANCE2 (P2, FRONTIÈRE FRONT) — afficher la banque dans la table /transactions** —
  Effort S, gardien Front. La table montre `account_name` (« Main Operating Account ») ; l'adapter
  (`transactions/adapter.ts`) peut maintenant remplir `compteNom` avec `institutionName`
  (« Bank One ») ou l'afficher en sous-texte, la donnée étant exposée par ligne. **Déclencheur** : ce ticket.

### Synchronisation automatique des soldes/transactions (2026-06-19)

À la connexion (Finish → `finaliserConnexionDropinAction`), les COMPTES sont déjà rattachés
auto (découverte `/accounts`). Le bouton « Synchroniser mes comptes »
(`synchroniserConnexionsDepuisOmnifi`) ingère désormais AUSSI les **transactions** de chaque
compte (pagination par page → `upsertTransactions`), ce qui remplit Détails + Transactions
récentes (livré 2026-06-19, branche `feat/dashboard-solde-ui`). Restent automatisation +
soldes EOD :

- [ ] **DASH-AUTOSYNC2 (P2) — ré-ingestion globale à chaque clic** — Effort S, gardien
  Backend. `synchroniserConnexionsDepuisOmnifi` ré-ingère les transactions de TOUS les
  comptes `is_selected` du workspace à chaque appel (pas seulement les connexions
  nouvellement ajoutées) → coût API qui croît avec le nombre de comptes. Acceptable au MVP
  (idempotent, volumes faibles). **Déclencheur** : nombreux comptes en prod / plainte de
  lenteur. Piste : ne synchroniser que les comptes des connexions touchées, ou borner par
  `lastSyncedAt` (skip si récent).
- [ ] **DASH-AUTOSYNC1 (P1) — synchro auto en arrière-plan** — Effort M-L, gardien Backend.
  Éviter que l'utilisateur doive cliquer « Synchroniser » après chaque ajout de banque.
  Pistes : (a) **cron Inngest** périodique (déjà au stack) qui rejoue
  `synchroniserConnexionsDepuisOmnifi` + `synchroniserCompteComplet` par workspace ; (b)
  **webhook Omni-FI** (si disponible) déclenchant la synchro sur événement amont ; (c)
  déclenchement **post-Finish** (enchaîner une synchro légère après finalisation). Contraintes
  NON négociables : rate-limit amont (`sync` 1/15min/connexion, CLAUDE.md), idempotence
  (upserts déjà idempotents), isolation tenant (`withWorkspace`), pas de PII en log. **À
  concevoir dans un chantier dédié** (scheduling + observabilité), PAS dans une PR de feature.
  **Déclencheur** : DÛ pour un MVP production (sinon données « figées » entre deux clics
  manuels). Lié à OMNIFI_API_FEEDBACK.md (la voie curseur `/sync` aiderait pour les deltas).

### Purge locale des données de démo (runbook dev, 2026-06-19)

Question récurrente : « comment repartir d'une base ne contenant QUE mes connexions
manuelles ? ». Réponse : les 4 banques (Absa/Bank One/MCB/SBM) viennent de l'**EndUser
sandbox côté Omni-FI** (provisionné), pas de notre seed. Purger la base LOCALE est
possible, mais la prochaine synchro re-rapatrie tout ce que l'EndUser a côté Omni-FI (le
vrai « reset » serait un EndUser neuf côté Omni-FI, hors de notre portée).

Procédure de purge LOCALE (dev uniquement, JAMAIS en prod — `transactions_cache` est
append-only avec trigger ; on passe par l'owner pour contourner) :
```bash
# Dans le conteneur de validation, rôle owner (le trigger BEFORE DELETE bloque tygr_app) :
docker exec -i tygr_postgres psql -U tygr_owner -d tygr <<'SQL'
  -- ordre = enfants avant parents (FK) ; truncate cascade contourne l'append-only.
  TRUNCATE transactions_cache, balance_history, bank_accounts, bank_connections RESTART IDENTITY CASCADE;
SQL
# Puis re-synchroniser UNIQUEMENT les banques voulues via le widget / bouton.
```
NB : `TRUNCATE … CASCADE` par l'owner outrepasse le trigger `BEFORE DELETE` (qui ne se
déclenche pas sur TRUNCATE) — acceptable EN DEV seulement. En prod, l'effacement reste
logique (`is_removed`), jamais physique.

### Findings /design-review du Dashboard (UI, 2026-06-19)

Audit `--quick` du Dashboard contre `UI_GUIDELINES`/`DESIGN.md` (Visual QA headless
`/demo/dashboard`). **Verdict : Design A− / AI-Slop A** — dashboard propre, layout
asymétrique conforme, typo réelle (Instrument Sans/Geist), ZÉRO pattern slop. 3 findings
mineurs, AUCUN bloquant, NON corrigés (décision PO 2026-06-19 : tracer, le dashboard est
suffisant) :

> **PROGRAMMÉS (2026-06-22)** : DR-F1/F2/F3 sont raccrochés au chantier
> **`PLAN-audit-ergonomie-soldes.md`** (audit ergonomique soldes/totaux, plan validé
> humain le 2026-06-22, arbitrages §7 tranchés). Ils ne sont plus « un jour » mais
> assignés à un lot d'implémentation nommé (règle 9). **Avancement : DR-F3 livré au Lot 2
> (PR #79, mergée), DR-F1 + DR-F2 livrés au Lot 3+4 (branche `feat/lot3-4-polish-ui`).**
> Reste C8 (Lot 6, dette de formateurs de date) ci-dessous.

- [x] **DR-F1 (P2, medium) — catégories de transactions en ANGLAIS dans l'UI française** —
  ✅ **LIVRÉ 2026-06-22** (branche `feat/lot3-4-polish-ui`, Lot 3). Table de correspondance FR
  **côté affichage** : `src/lib/categories-fr.ts` (`categorieFr`, fonction pure) mappe la
  `primaryCategory` OBIE (`Income`→« Revenus », `Utilities`→« Charges », `Rent`→« Loyer »,
  `Insurance`→« Assurances », `Taxes`→« Taxes », `Payroll`→« Salaires », `Banking & Finance`/
  `Bank Charges`→« Frais bancaires »), fallback « Non catégorisé » pour toute clé inconnue/nulle
  (filet anti-anglais). Appliquée dans `components/dashboard/transactions-table.tsx`. Couverture :
  `tests/unit/categories-fr.test.ts` (6 cas, bornes incluses). Visual QA `/demo/dashboard` :
  colonne CATÉGORIE = Revenus/Charges/Loyer, 0 anglais. Catégorie localisée côté service
  REPORTÉE (dette tracée, langue pivot anglaise conservée en base pour export/réconciliation).
  **ÉCART de périmètre vs le finding initial** : le finding citait aussi `/transactions`, MAIS
  cette page n'affiche PAS `primaryCategory` — elle affiche la catégorie de VENTILATION MANUELLE
  (`categorie.name` via `CategorisationStatusBadge`), saisie par l'utilisateur et DÉJÀ en français
  (cf. `types-transactions.ts` : « indépendant de primaryCategory »). La traduire eût été incorrect.
  DR-F1 ne concernait donc que la catégorie OBIE auto, affichée uniquement sur le dashboard.
- [ ] **SPLIT-PERIME1 (P1, effort M, intégrité des données) — une ventilation SURVIT à un
  re-sync qui RÉDUIT le montant de sa transaction** — ouvert 2026-07-21 (revue croisée du
  chantier GRAPHIQUES-CATEG-UTILISATEUR1). **Quoi** : l'invariant `Σ splits ≤ |montant|`
  n'est validé QU'À L'ÉCRITURE du split (`categorisation.ts`, sous `FOR UPDATE`). L'upsert
  d'ingestion écrase `amount` (`ingestion.ts:207-224`, `set: { amount: … }`) et laisse
  délibérément `transaction_categorizations` intacte → une transaction ventilée à 100 %
  dont l'amont corrige le montant à la BAISSE (pré-autorisation carte réglée plus bas,
  correction amont) devient SUR-VENTILÉE. Aucun bug d'écriture nécessaire : le chemin est
  ouvert en fonctionnement normal. **Pourquoi ce n'est pas bloquant** : le donut est
  désormais fail-safe (`axeCategorieEffective`, garde `ventileValide`) — il IGNORE une
  ventilation périmée et impute la transaction à sa catégorie bancaire, donc l'exhaustivité
  `Σ parts = KPI Sorties` tient (prouvé, `graphiques-repartition-isolation.test.ts`,
  mutation-check M7/M8). **Ce qui reste faux** : la DONNÉE. `/transactions` affiche toujours
  la transaction comme « COMPLET » alors qu'elle est sur-ventilée, et l'utilisateur ne voit
  nulle part que sa ventilation ne vaut plus rien. **Correctif attendu** : à l'ingestion,
  quand `amount` baisse sous `Σ splits`, réduire ou invalider les splits AVEC trace
  `categorization_audit` (append-only : on écrit un événement correctif, on ne réécrit pas).
  Décision à prendre : réduire au prorata, ou invalider et laisser l'utilisateur reventiler.
  **Déclencheur** : premier signalement utilisateur d'une ventilation « disparue » du donut,
  OU avant le premier gros import d'historique. **Ne PAS traiter côté lecture** — chaque
  écran qui lit les splits devrait alors reproduire la garde.

- [ ] **STATS-CUMUL-CATEGORIE1 (P2, effort S, lisibilité) — le bandeau de stats raisonne en
  PARTS, pas en catégories cumulées** — ouvert 2026-07-21 (revue croisée, même chantier).
  **Quoi** : depuis l'axe de catégorie effective, une catégorie peut produire DEUX parts (la
  fraction ventilée par l'utilisateur + son reliquat bancaire homonyme). « Poste dominant »
  annonçait donc la plus grosse PART en la faisant passer pour la plus grosse CATÉGORIE — sur
  un jeu réel, « Fournisseurs 29 % » là où « Loyer » pesait 46 % en cumulant ses deux parts.
  **Traité pour l'instant par l'HONNÊTETÉ du libellé** (arbitrage Etienne 2026-07-21) :
  « Plus grosse part », « Parts » — l'écran dit exactement ce qu'il calcule, et ce que le
  donut montre (le plus gros SECTEUR est bien celui-là). **Reste à faire** : exposer le vrai
  cumul par catégorie. Le calcul ne peut PAS se faire côté JS (ce serait additionner des
  montants — règle 8) : il faut un agrégat SQL supplémentaire sur le libellé, dans
  `axeCategorieEffective`. **Déclencheur** : retour utilisateur sur l'écart entre le KPI et
  la lecture du donut, ou ouverture du chantier « matrice catégorie × mois » (qui consommera
  le même fragment et posera la même question).

- [ ] **GRAPH-TX-ZERO1 (P2, effort XS, cardinalité) — une transaction à 0,00 sans ventilation
  disparaît du COMPTE d'opérations du donut** — ouvert 2026-07-21 (revue croisée, même
  chantier). **Quoi** : la branche « reste » filtre `> 0` STRICT (invariant I6, qui interdit
  les parts fantômes à 0,00). Une transaction de montant nul et non ventilée ne produit donc
  AUCUNE ligne d'axe : elle sort de `nbTransactions` et du dénominateur de `montantMoyen`.
  **Portée exacte** : les MONTANTS restent justes (0,00 n'ajoute rien) — seule la cardinalité
  est touchée : « 12 opérations » devient « 11 », et la moyenne par opération monte
  légèrement. Le donut peut donc afficher un nombre d'opérations inférieur à `/transactions`
  sur la même période. **Ce n'est PAS une dette de montant** (règle 9) : rien de faux n'est
  affiché sur un montant. **Correctif attendu** : compter les transactions par un chemin
  distinct des parts affichées — les faire entrer par la branche « reste » recréerait
  exactement la part fantôme que I6 interdit. **Déclencheur** : présence avérée de
  transactions à 0,00 en base (aucune constatée à ce jour), ou écart signalé entre le compte
  d'opérations du donut et celui de `/transactions`.

- [ ] **AXE-CEINTURE-JOIN1 (P2, effort S, défense en profondeur) — la ceinture
  ENTITY-READ-JOIN1 n'est verrouillée par AUCUN test sur l'axe** — ouvert 2026-07-21 (revue
  croisée, même chantier). **Quoi** : mutation-check M9 — retirer les DEUX
  `innerJoin(bankAccounts)` de `axeCategorieEffective` laisse toute la suite VERTE. **Ce
  n'est pas une faiblesse de fixture** : depuis 0017, la policy `account_scope` borne déjà
  ces tables filles, donc la ceinture est REDONDANTE — et une défense redondante ne peut, par
  construction, pas se prouver par le comportement (tant que la bretelle tient, la retirer ne
  change aucun résultat). L'isolation elle-même EST prouvée (test « I4 étage 2 », sous
  `viewFilter`). **Risque réel** : un refactor qui retirerait la jointure ne casserait rien
  aujourd'hui, mais rouvrirait le trou le jour où un chemin échappe à la policy — et
  CLAUDE.md exige la convention aussi pour la CORRECTION des agrégats. **Correctif possible** :
  garde structurelle en CI (liste blanche des lectures de tables filles, sur le modèle de la
  garde de périmètre toolbar — un scan générique produirait des faux positifs). **Déclencheur** :
  troisième repository lisant une table fille de `bank_accounts`, ou premier oubli de jointure
  constaté en revue.

- [ ] **AXE-PERF-SPLITS1 (P2, effort S, performance) — l'axe effectif est exécuté 3 fois par
  affichage, sans index de date sur les splits** — ouvert 2026-07-21 (même chantier).
  **Quoi** : `repartitionParCategorie` instancie `axeCategorieEffective` TROIS fois (parts,
  cardinalité par devise, fenêtre précédente L4), et chaque instance porte un `UNION ALL`
  qui scanne `transactions_cache` deux fois — soit ~6 scans par affichage contre 2 avant ce
  chantier. La cardinalité par devise est en requête séparée parce que `count(distinct …)`
  est INTERDIT en fonction fenêtre par Postgres (et que le raccourci
  `sum(count(distinct …)) over (…)` compterait deux fois une transaction partielle).
  S'ajoute que `transaction_categorizations` n'a AUCUN index dont la tête permette de filtrer
  par `transaction_date` (`(workspace_id, transaction_id, transaction_date)` et
  `(workspace_id, category_id)`) : la table dérivée `ventile` filtre donc par date APRÈS le
  filtre workspace de la RLS. **Sans impact mesuré à ce jour** (volumes de démarrage, fenêtres
  d'un mois). **Correctifs possibles** : `GROUPING SETS`/`ROLLUP` pour fusionner parts et
  totaux en une passe ; index `(workspace_id, transaction_date)` sur les splits.
  **Déclencheur** : premier workspace dépassant ~50 000 transactions, OU une fenêtre « 12
  mois » ressentie comme lente sur /graphiques.

- [ ] **OBIE-CATALOG1 (P2, medium, robustesse données) — catalogue OBIE→FR FIGÉ, désynchronisé
  de l'amont réel** — Effort S, ouvert 2026-06-23 (sonde runtime, branche `fix/categories-fr-catalogue-obie`).
  DR-F1 avait peuplé `CORRESPONDANCE_FR` (`src/lib/categories-fr.ts`) depuis le **seed de démo**
  (8 clés : income/rent/utilities/…). Or la sonde du compte RÉEL montre que l'API émet **11
  catégories distinctes**, dont **10 absentes du mapping** (`Business Expenses` 96 tx,
  `Professional Fees`, `Revenue`, `Administrative Costs`, `Personnel`, `Food & Drink`, `Travel &
  Transport`, `Housing`, `Healthcare`, `Other`) → **96 % des transactions** retombaient sur « Non
  catégorisé » à l'affichage alors que `primary_category` est correctement peuplée en base
  (l'ingestion fait son travail — bug d'AFFICHAGE pur, pas d'ingestion). **Correctif immédiat
  (cette branche)** : les 11 clés observées ajoutées au mapping (`revenue`+`income`→« Revenus »).
  **Fragilité RÉSIDUELLE** : le mapping reste une liste FERMÉE maintenue à la main, alors que
  l'amont émet librement — toute NOUVELLE catégorie OBIE s'affichera silencieusement « Non
  catégorisé » sans alerte. **Déclencheur de résolution** : (a) une localisation côté SERVICE
  (table de mapping en base, langue pivot anglaise conservée) si le volume de catégories grandit ;
  OU (b) ajout d'une catégorie OBIE non cartographiée détecté en prod. Piste low-cost intermédiaire :
  log structuré (sans PII) quand `categorieFr` retombe sur le défaut, pour détecter les trous.
  **MAJ 2026-06-23 (feat auto-categorized)** : l'ingestion NULLifie désormais `primary_category`
  quand la catégorie OBIE est vide ou `Uncategorized` (decision PO ; `versLignePersistee` +
  `scripts/backfill-auto-categorized.mjs`). Conséquence pour CE point : le défaut de `categorieFr`
  ne signale PLUS que de VRAIES catégories inconnues (le bruit `Uncategorized` ne remonte plus) →
  la piste (b)/log devient un signal fiable de trou de catalogue. `primary_category` reste l'OBIE
  brut (anglais) pour les catégories exploitables ; le marqueur de provenance vit dans la nouvelle
  colonne `is_auto_categorized`/`category_source` (cf. migration 0011), distinct de ce mapping FR.
  **MAJ 2026-07-21 (GRAPHIQUES-CATEG-UTILISATEUR1 Lot 0) — le déclencheur (b) s'est RÉALISÉ, et la
  cause n'était pas celle qu'on attendait.** Inventaire exhaustif de la base locale ce jour :
  l'amont n'émet PAS dans la graphie de la sonde du 2026-06-23. Les 4 valeurs réellement présentes
  sont en **SCREAMING_SNAKE_CASE** : `UNCLASSIFIED`, `UTILITIES`, `BANKING_AND_FINANCE`,
  `INTER_ACCOUNT_TRANSFER`. Les clés d'UN SEUL mot matchaient encore par `toLowerCase`
  (`UTILITIES` → `utilities`), mais **toutes les clés COMPOSÉES échouaient** — le catalogue attend
  `banking & finance`, l'amont envoie `BANKING_AND_FINANCE`. Ce n'était donc pas « une nouvelle
  catégorie hors catalogue » mais **une graphie différente pour des catégories DÉJÀ cartographiées**
  — un trou qu'aucun log sur le défaut de `categorieFr` n'aurait qualifié correctement (il aurait
  signalé « catégorie inconnue » là où le mapping existait). **Correctif livré** : normalisation à
  la lecture (`normaliserCleObie` : `_and_` → ` & `, `_` → ` `), qui fait matcher toutes les
  entrées composées sans en dupliquer aucune, + `inter account transfer` → « Virements internes ».
  **Fragilité résiduelle INCHANGÉE** (liste fermée) ; et la piste (b) reste pertinente, mais doit
  logger la clé BRUTE, pas seulement le fait qu'on est retombé sur le défaut.
- [x] **DR-F2 (P3, polish) — carte « Comptes connectés » : nom de compte tronqué** —
  ✅ **LIVRÉ 2026-06-22** (branche `feat/lot3-4-polish-ui`, Lot 4). `connected-accounts-card.tsx`
  refondue sur 2 lignes : banque en LABEL (`text-[11px] text-text-muted uppercase`, `truncate`
  indépendant, omise si `institutionName` null), nom de compte dessous (`text-[13px]`, `truncate`
  indépendant), montant à droite JAMAIS tronqué (`shrink-0 whitespace-nowrap tabular-nums`). Le
  flex parent porte `min-w-0` pour autoriser le `truncate` des enfants. Nettoyage : type
  `CompteAffiche` supprimé (le composant prend `CompteConnecte` directement — `institutionName`
  est dans le contrat depuis DASH-INST1) ; commentaire d'en-tête « contract-first » périmé corrigé.
  Visual QA `/demo/comptes-provenance` (4ᵉ cas « noms TRÈS longs » ajouté à la démo, contrainte
  300px) : « The Mauritius Commercial Bank… » + « Compte courant… » tronquent SÉPARÉMENT, le
  montant `Rs 999 999 999,00` reste intégralement visible. Zéro troncature de chiffre clé.
- [ ] **DR-F3 (P3 → réévalué medium, polish/correction) — méta « au JJ/MM » TROMPEUSE sous un
  solde COURANT** — Effort S, gardien Front. `side-panel-kpi.tsx:55` affiche « au 12/06 »
  (`dateSolde` = **dernier point de courbe**, EOD) alors que le montant est le solde COURANT
  (`current_balance`) → décalage sémantique qui peut induire un FM en erreur. **DÉCISION ACTÉE
  (2026-06-22)** : remplacer la méta par la **pastille fraîcheur §3.7** (success<6h /
  warning<24h / danger≥24h + CTA « Reconnecter ») branchée sur `lastSyncedAt` — pattern DÉJÀ
  spécifié dans `UI_GUIDELINES.md §3.7` mais jamais implémenté. La date du dernier point de
  courbe reste sur la COURBE. **Déclencheur** : chantier `PLAN-audit-ergonomie-soldes.md`
  **Lot 2**.
- [ ] **C8 (P2, medium, maintenabilité) — 3 formateurs de DATE en parallèle alors que
  `format-date.ts` existe** — Effort S, gardien Front. Relevé à l'audit ergonomie 2026-06-22.
  `dashboard-content.tsx:121` (`jourMoisCourt`), `transactions-table.tsx:78-86` (`jourMois`
  AVEC ses propres noms de mois redéfinis EN DUR), `side-panel-kpi.tsx:129` (`moisLisible`) —
  trois découpes ad-hoc de `YYYY-MM-DD` au lieu d'une source unique. Risque de divergence FR
  (abréviations de mois incohérentes entre composants). **DÉCISION ACTÉE (2026-06-22)** :
  router TOUT formatage de date d'affichage vers `src/lib/format-date.ts` (source unique),
  supprimer les 3 implémentations locales. **Déclencheur** : chantier
  `PLAN-audit-ergonomie-soldes.md` **Lot 6** (fusionnable au Lot 1). Critère de clôture :
  `grep` de noms de mois / `split("-")` ad-hoc dans `src/components` = 0.

### Robustesse UX panne DB + savoir tribal Next 16 (2026-06-17)

Symptôme : base injoignable (Neon/wsproxy down) → 500 brut + crash de
sérialisation Next (« Only plain objects can be passed to Client Components »),
car l'erreur du driver Neon porte une `cause: ErrorEvent` (classe DOM non
sérialisable). Corrigé (branche `fix/workspace-db-error-ux`) :
- `ServiceIndisponibleError` (`session.ts`) : `exigerSessionWorkspace` convertit
  l'erreur d'infra du chemin E6 (`estActif`) en une Error PROPRE sérialisable —
  **FAIL-CLOSED conservé** (DB injoignable ⇒ accès refusé, jamais « supposé
  actif »). Vérifié : compte désactivé → /login (métier), DB down → écran infra.
- `(workspace)/layout.tsx` : helper `gererErreurInfra` qui **rend `AppErrorState`
  directement** (« Service momentanément indisponible », `role=alert`, sans fuite
  technique) pour TOUTE erreur d'infra — `ServiceIndisponibleError` du chemin E6
  ET une panne brute survenant pendant `withWorkspace`/`membershipsAvecNom`
  (axe 5 de la cross-review). Garde-fous dans l'ordre : `unstable_rethrow`
  (re-lance redirect/notFound — jamais avalés), `UnsafeDatabaseRoleError`
  re-`throw` (refus de sécurité C6, pas un « réessayez »), reste → écran. Prouvé
  en prod (standalone) : panne (début ET pendant) → HTTP 200 + écran propre ;
  nominal, redirect sans cookie, et fail-closed (compte désactivé → /login)
  intacts.
- `components/ui/states/app-error-state.tsx` : état d'erreur transverse (§3.4).
- `app/global-error.tsx` : filet ultime pour une panne du ROOT layout.

Cross-review Sécurité (contexte frais) : **feu vert**, fail-closed solide sur les
3 axes critiques (estActif lève ⇒ jamais de session retournée ; layout court-
circuite le shell ; désactivé ≠ panne). 1 constat MINEUR non-sécurité (axe 5)
**corrigé** ci-dessus par `gererErreurInfra`.

⚠️ **SAVOIR TRIBAL Next 16.2 (vérifié empiriquement, contre-intuitif)** : un
`error.tsx` / `global-error.tsx` NE capture PAS une exception levée par le
**data-fetching d'un layout pendant le SSR initial**. Testé : `(workspace)/
error.tsx`, `app/error.tsx` (absent du build), `global-error.tsx` — AUCUN ne
monte (leurs `console.error` ne s'exécutent jamais), Next sert sa 500 par
défaut. La seule voie fiable = **le layout gère l'erreur lui-même** (try/catch +
rendu direct), PAS un boundary. Conséquence : ne pas « ajouter un error.tsx »
pour fiabiliser un layout qui fetch — gérer dans le layout, ou sortir le fetch
(approche Next recommandée). `app/error.tsx`/`(workspace)/error.tsx` ont été
RETIRÉS (redondants : le layout court-circuite avant les pages).

- [ ] **UX-ERR1 (P2) — bouton « Réessayer » fonctionnel sur l'écran d'erreur du
  layout** — Effort S (déclencheur : si l'incident DB devient visible en démo).
  L'`AppErrorState` rendu par le layout RSC n'a PAS de `onRetry` (un handler
  client est impossible dans un Server Component). L'utilisateur doit recharger
  la page à la main. Option : un petit Client Component « bouton recharger »
  (`location.reload()`) ou un `<a href>` vers la même URL. Cosmétique ; le
  rechargement manuel marche déjà.

### Empty States transverses (UI, 2026-06-17)

- [x] **UI-ES1 (P2) — faire dériver `DashboardEmptyState` du `EmptyState` générique**
  — ✅ **LIVRÉ 2026-06-22** (Front, branche `feat/empty-state-derive`). `DashboardEmptyState`
  ne reclone plus StateCard + StateIllustration + la classe CTA : il choisit copy/illustration/
  CTA selon son domaine (/banques) puis DÉLÈGUE le rendu à `<EmptyState>` (−62 lignes dupliquées).
  Le générique a été étendu pour l'accueillir, sans casser ses 4 usages réels (layout, échéances,
  graphiques, global-error) : `message` passe à `ReactNode` (nom de compte en gras inline) et `cta`
  devient l'union `EmptyStateCta` (`{label,href}` → `<Link>` | `{label,onClick}` → `<button>`,
  rétrocompat du handler `onConnect`). Contrat public de `DashboardEmptyState` inchangé
  (`accountLabel?`, `onConnect?`). Stop-loss : lint + typecheck + 395 tests verts. Visual QA
  (`/demo/dashboard-states` cas « compte connecté » + `/demo/dashboard` onglet Vide « aucune
  banque ») : rendu visuellement IDENTIQUE à avant le refactor, 0 erreur console. Reste HISTORIQUE
  ci-dessous :
  Effort S (déclencheur : merge de `feat/activate-nav-empty-states`). Le composant
  générique `src/components/ui/states/empty-state.tsx` (livré avec les pages
  graphiques/échéances/transactions) recouvre le markup de `DashboardEmptyState`
  (illustration + titre + message + CTA lien `primary`). `DashboardEmptyState` reste
  couplé au domaine (CTA « Connecter une banque » → /banques) — le réécrire comme une
  fine spécialisation du générique supprime la duplication. Différé pour ne pas toucher
  du code dashboard mergé/QA dans la PR d'activation nav (décision design D3,
  plan-design-review 2026-06-17).

### Vendoring de @omni-fi/react-link (2026-06-16)

- [ ] **VENDOR-1 (P1) — remplacer le vendoring `file:` par le package publié** —
  Effort S (déclencheur : Omni-FI publie `@omni-fi/react-link` sur npm public OU un
  registre privé d'entreprise). `vendor/omni-fi-react-link/` contient un `dist/` tiers
  BUILDÉ localement, NON audité et NON reproductible (cf. `SECURITY_VENDORING.md`),
  intégré pour débloquer la démo (le package n'est sur aucun registre et son dépôt ne
  committe pas le `dist/`). Risque supply-chain assumé pour la démo uniquement, sur app
  qui manipule des secrets bancaires. Sortie : `npm install @omni-fi/react-link@<ver>`,
  supprimer `vendor/` + `SECURITY_VENDORING.md`, re-valider build + flux de connexion.
  Idéal : demander au repo amont un script `prepare` (build à l'install) ou la
  publication du `dist/`. Décision PO 2026-06-16 (« OK démo, dette tracée »).

### Ré-alignement contrat widget sur le code source + cross-review (2026-06-16)

⚠️ La doc Fern « `onSuccess = publicToken seul` » (tranchée 2026-06-15) était FAUSSE.
Code source réel (github.com/omni-fi-app/omni-fi-react-link) : hook `useOmniFILink`,
`onSuccess({ connections: [...] })` (multi-connexions), entrée `token`, script CDN
(`isReady`). URL API : `sandbox.omni-fi.co` = coquille NXDOMAIN → vrai hôte
`stage.omni-fi.co` (vérifié HTTP 200). Câblage ré-aligné + boucle fail-soft multi.

Cross-review Sécurité + QA passée (aucun BLOQUANT/MAJEUR). 3 constats corrigés au
diff (dédoublonnage publicTokens + test, test IDOR dans la boucle, casse stub).
Durcissements différés (déclencheur commun : intégration du VRAI package / mise en prod) :

- [x] **W4-D1 (P1) — `OMNIFI_ENV` découplé de l'hôte de `OMNIFI_BASE_URL`** —
  ✅ RÉSOLU (PR #122 verrou env-piloté + PR #124 hôte partagé, vérifié 2026-06-26).
  `config.ts` LIE désormais env↔hôte (fail-closed) : garde de cohérence
  (`:154-165` — un `production` sur hôte sandbox-only, ou l'inverse, fait échouer le
  démarrage) + verrou production (`:147-168`) + notion d'`HOTES_PARTAGES` (`:74`) pour
  l'hôte api-stage qui sert sand ET prod (l'env y vient des clés + du drapeau
  `OMNIFI_AUTORISER_PRODUCTION`, plus décoratif). `environment` n'est plus décoratif :
  il borne le démarrage. [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [ ] **W4-D2 (P2) — pas de rate-limit applicatif sur `finaliserConnexionsDropin`** —
  Effort S (déclencheur : si la sélection multi-banques devient courante). Boucle
  séquentielle ≤20 connexions × (exchange + pagination /accounts) ; surface
  authentifiée + gating MANAGER/ADMIN + array borné, donc pas un vecteur anonyme,
  mais un re-jeu peut dépasser le 10/IP/60s amont (throttle). Borner totalPages ou
  la durée totale. Relevé par audit sécurité (5/10).
- [ ] **W4-D3 (P2) — `open()` du widget sans garde anti-double-ouverture** — Effort S
  (déclencheur : test du flux réel avec `@omni-fi/react-link` désormais installé).
  `omnifi-link-launcher.tsx` : `useEffect([isReady, open])` peut ré-appeler `open()`
  si l'identité de `open` n'est pas stable dans le package. Le flux normal le masque
  (onSuccess→setFerme→launcher démonté). Ajouter un `useRef` « déjà ouvert » si le
  test révèle une double-ouverture. Relevé par audit QA (5/10).

### Redirection Dashboard post-succès widget (UI, 2026-06-18)

Branche `feat/omnifi-native-success` : au succès COMPLET de la finalisation native
(`onSuccess` → `finaliserConnexionDropinAction`), l'utilisateur est redirigé vers le
Dashboard (`router.push('/')`) ; en succès PARTIEL on reste sur `/banques` pour ne
pas masquer l'échec (bandeau + lien d'action). Le repli manuel « Une banque
n'apparaît pas ? » est conservé (retrait progressif). Liste de courses Backend :

- [x] **WIDGET-RD1 (P1) — exposer un flag `complet` sur `EtatFinalisation`** —
  ✅ RÉSOLU (vérifié 2026-06-26). `EtatFinalisation` porte désormais `complet?: boolean`
  (`banques/actions.ts:52`) et `finaliserConnexionDropinAction` le calcule
  (`:199`, `complet: r.echecs === 0`) → le Front peut déclencher la redirection au succès
  total et rester sur place en partiel. [Audit backlog 2026-06-26 : entrée jamais cochée.]
  CONTEXTE HISTORIQUE conservé ci-dessous :
  Effort S (déclencheur : ce câblage de redirection, dû MAINTENANT). Le contrat
  `EtatFinalisation` (`src/app/(workspace)/banques/actions.ts`) ne renvoie que
  `{ erreur, succes }` (strings) ; le serveur CONNAÎT `echecs`/`reussies`
  (`finaliserConnexionsDropin`, `orchestration.ts`) mais les fond dans le LIBELLÉ.
  Côté client je distingue donc « succès total » de « partiel » uniquement via un
  champ booléen — que je consomme déjà en contract-first (`EtatFinalisationUI =
  EtatFinalisation & { complet?: boolean }`, `bank-connect-widget.tsx`). **Tant que
  Backend ne pose pas le flag, `complet` vaut `undefined` → fallback SÛR : aucune
  redirection automatique**, on reste sur la page avec le lien explicite (jamais de
  navigation qui masquerait un échec). Demande Backend : ajouter `complet: boolean`
  (= `echecs === 0 && reussies.length > 0`) au retour de `finaliserConnexionDropinAction`.
  Frontière respectée (gardien Backend du contrat) — je ne modifie pas la Server Action.
  Anti-pattern à NE PAS faire côté UI : parser le texte de `succes` pour deviner le
  partiel (couplé au libellé, casse au moindre changement de message).

### Conflit d'agents — câblage widget unifié (2026-06-15, RÉSOLU)

Le merge de main dans PR-W4 avait révélé DEUX câblages divergents du widget.
**Tranché (doc Fern) : `onSuccess = publicToken SEUL`.** Unification appliquée :
- `bank-connect-widget.tsx` (agent UI, monté par `banques/page.tsx`) réécrit sur
  le contrat dropin → `onSuccess(publicToken)` + `finaliserConnexionDropinAction`.
- Doublon `connecter-banque.tsx` (backend, non monté) SUPPRIMÉ.
- `finaliserConnexionAction` + son schéma zod (sessionToken/jobId) SUPPRIMÉS de
  `actions.ts`. Stub `omnifi-react.d.ts` nettoyé (plus de sessionToken/jobId).
- `finaliserConnexion` (orchestration, chemin « widget custom » via
  getSyncJobAccounts) CONSERVÉE + testée (réutilisable hors dropin), mais plus
  appelée par aucune action. Un seul chemin runtime : le dropin.
- [x] **5.3 (P2) — RÉSOLU 2026-06-16** — stub `omnifi-react.d.ts` + stub JS + alias
  de build SUPPRIMÉS : le vrai package `@omni-fi/react-link` est vendoré et fournit
  ses propres types (branche `fix/omni-fi-integration`). Voir dette VENDOR-1.

### Cross-review sécurité PR-W4 — intégration widget drop-in (2026-06-15)

Audit OWASP contexte frais. **Aucun bloquant.** Corrigés dans PR-W4 : 3.1
(allowlist serveur du redirectOrigin via `APP_ALLOWED_ORIGINS`, fail-closed) et
5.2 (open() du widget déclenché dans un effect après pose du token, plus de token
vide). Différés / décisions :

- [ ] **1.1 (P1) — Contraintes UNIQUE globales `omnifi_connection_id` /
  `omnifi_account_id` / `(omnifi_txn_id, transaction_date)` (non scopées workspace)** —
  ⚠️ **EN COURS — 2 PRs zéro-fenêtre (expand/contract), PLAN-unique-composites.md.**
  L'hypothèse « unicité globale garantie par Omni-FI » est ABANDONNÉE (durcissement
  défensif, on ne parie plus dessus). Risque réel : couplage de disponibilité + oracle
  cross-tenant (DoS d'ingestion si collision d'id entre 2 tenants), PAS une fuite (la RLS
  tient — l'upsert échoue, il ne lit pas).
  - **EXPAND LIVRÉ** (`fix/unique-composites`, 2026-07-06, lots L1→L3) : migration `0018`
    ajoute les 3 composites `UNIQUE(workspace_id, …)` (bank_connections / bank_accounts /
    transactions_cache) ; les 3 `onConflictDoUpdate` d'`ingestion.ts` infèrent dessus en
    lock-step ; suite `tests/isolation/unique-composites-isolation.test.ts` (idempotence
    intra-tenant + pin transitoire ; verte, ROUGE sans 0018 = preuve d'inversion). Les
    globales sont CONSERVÉES pendant l'expand (backward-compat N-1). Lint/tsc/test/build verts.
  - [ ] **RESTE — CONTRACT (PR2, lot L4, migration `0019`)** — Effort S. `DROP` des 3
    globales (`bank_connections_omnifi_connection_id_unique`,
    `bank_accounts_omnifi_account_id_unique`, `transactions_cache_omnifi_txn_unique`) +
    **inversion des cas C4a/b/c** (la collision cross-tenant, aujourd'hui `rejects.toThrow`,
    devient un succès + « chaque tenant voit sa ligne »). **Déclencheur (arbitrage C du
    plan)** : AVANT l'onboarding du 2ᵉ tenant réel (ou prochaine passe anti-dette), ET
    seulement APRÈS que l'expand soit déployé & vérifié en prod (le code composite doit être
    la version N-1 pour que 0019 soit backward-compat — §5.3, sinon le N-1 mono-colonne
    plante l'ingestion pendant la fenêtre).
- [ ] **WEBHOOK-TENANT-FIRST1 (P1) — garde-fou du futur résolveur `/api/webhooks/omnifi`** —
  Effort S. **Déclencheur : création de la route webhook** (inexistante aujourd'hui —
  `src/app/api/` = auth uniquement). Corollaire du contract 1.1/L4 : une fois les globales
  droppées, `omnifi_connection_id` n'est plus unique GLOBALEMENT → un lookup webhook par ce
  SEUL champ pourrait matcher N workspaces (routage cross-tenant). RÈGLE À GRAVER dans le
  futur plan webhook : résoudre le TENANT d'abord (`ClientUserId`→workspace, unique global
  CONSERVÉ) PUIS la connexion DANS ce workspace — JAMAIS `omnifi_connection_id` seul. Déjà
  posé en commentaire de colonne (`schema.ts`, `omnifiConnectionId`). Aucun code à écrire
  maintenant (anti-scope-creep).
- [ ] **3.1 résolu / suivi** — `APP_ALLOWED_ORIGINS` doit être renseigné en env
  (sinon fail-closed : aucune connexion widget possible). À documenter au déploiement.
- [x] **5.3 (P2) — RÉSOLU 2026-06-16** — stub supprimé, vrai package `@omni-fi/react-link`
  vendoré (ses types réels font foi : `onSuccess(payload)`, pas `onSuccess(string)` —
  l'ancienne hypothèse Fern était fausse). Suivi : dette VENDOR-1 (package publié).

### Cross-review croisée Agent UI — précision financière ingestion (2026-06-15)

Alerte « bloquante » de l'Agent UI sur `ingestion/index.ts` + `dashboard.ts`.
**Les DEUX constats rejetés sur preuve — code maintenu, aucun correctif.**
Désaccord tranché par l'humain en faveur de l'analyse documentaire (règle 6).

- **P1 (prétendu bloquant) — fuseau de `balanceDate` : FAUX POSITIF.** L'Agent UI
  réclamait `AT TIME ZONE 'Asia/Port_Louis'` sur `b.Date` par symétrie avec
  `transaction_date`. PREUVE (doc Fern `get-historical-balances`) : le champ `Date`
  est `format: date` (YYYY-MM-DD **nu**, sans heure ni fuseau) et l'endpoint renvoie
  des « end-of-day balances » = DÉJÀ la date comptable du compte. `AT TIME ZONE` ne
  s'applique qu'à un INSTANT (cas de `transaction_date`, dérivée d'un
  `BookingDateTime` horodaté) ; l'appliquer à une date nue serait un no-op ou un
  DÉCALAGE d'un jour. `balanceDate: b.Date` est correct — le « corriger » créerait
  le bug.
- **P2 — source du KPI solde : DÉJÀ CONFORME.** `soldeConsolideCourant`
  (`dashboard.ts`) somme déjà le dernier EOD de `balance_history`
  (`max(balance_date)` par compte) et NE lit PAS `bank_accounts.current_balance` →
  KPI et courbe partagent la même source. Rien à changer.
- Leçon (méthode) : un constat de cross-review se VÉRIFIE contre la source de vérité
  avant correctif ; une fausse symétrie (date nue vs instant) ne suffit pas. 2e
  faux positif d'affilée tranché par preuve (cf. C1 PR-W1).

> ⚠️ État réel à corriger : `feature/epic3-dashboard-integration` (qui porte
> `dashboard.ts` / `soldeConsolideCourant`) **n'est PAS encore mergée dans `main`**
> au 2026-06-15 (dernier merge = PR-W3 #15). Le socle de lecture du dashboard
> n'est donc pas en prod ; PR-W4 + Visual QA en dépendent. À merger.

### PR-W3 — logique widget MFA côté client (2026-06-15)

- A1 (PR-W1) **respecté** : `widget-runtime.ts` ne logge jamais l'OTP/token ;
  erreurs réduites à un code machine (`OMNIFI_<status>` / `RUNTIME_ERROR`).
- A2 (PR-W1) **respecté** : le watermark est `undefined` tant qu'aucun resend,
  jamais `null` (machine + submitMfaAction omettent le champ).
Cross-review OWASP (contexte frais) — aucun bloquant. #6 (polling infini sur job
bloqué non terminal) **CORRIGÉ** : `clearInterval` dès état terminal + plafond
`MAX_POLLS` (~10 min). Sain confirmé : OTP/token/watermark jamais exposés, gating
avant effet, A2 respecté, codes non-énumérants. Différés :
- [ ] **#3 — détection de rejet OTP best-effort** — Effort S (P2). La transition
  `UserInput présent→absent` peut manquer un snapshot de polling (echecsOtp client
  non incrémenté). Impact sécurité NUL (le serveur tranche au 3e échec → FAILED) ;
  c'est une divergence de COMPTEUR UI. Documenté « vérité = serveur » dans
  machine-mfa.ts. À couvrir par un test du cas snapshot-manqué si testing-library
  est ajouté.
- [ ] **Test du hook React `useOmniFiWidget` non couvert** — Effort S (P2). La
  logique métier MFA est dans la machine PURE (couverte : 11 tests rejet/
  watermark/cooldown/échecs). Le hook reste une coquille (timers/refs polling) —
  non testé car pas de renderer React au projet (testing-library/jsdom = nouvelle
  dépendance, règle 9). Couvert au Visual QA avec l'agent UI. Déclencheur : si on
  ajoute testing-library pour d'autres hooks, brancher un test polling/submit/resend.

### Cross-review sécurité PR-W2 — orchestration serveur widget (2026-06-15)

Audit OWASP/IDOR contexte frais sur les Server Actions démarrer/finaliser.
**1 bloquant corrigé, 1 non-bloquant corrigé, 2 différés.**
- **1.1 (BLOQUANT) CORRIGÉ** : `finaliserConnexion` recoupe désormais
  l'`InstitutionId` des comptes du job avec celui de la connexion échangée →
  `ConnexionDesalignmentError` fail-closed si désalignement (sessionToken/jobId
  d'un autre flux). Test d'isolation du cas ajouté.
- **5.1 CORRIGÉ** : log structuré corrélé (`workspace_id` + code machine, sans
  PII/token) dans les Server Actions (exit-criteria règle 3) ; `instanceof
  OmniFiApiError` mort retiré.
- [ ] **1.2 — Contraintes UNIQUE globales non composites** — Effort M (P1).
  ⚠️ **DOUBLON de `1.1`** (même sujet — audit 2026-06-26). RÉELLEMENT OUVERT :
  `omnifi_connection_id` / `omnifi_account_id` sont UNIQUE globaux (`0003`, vérifié)
  et NON `(workspace_id, …)` ; une collision d'id cross-tenant + `onConflictDoUpdate`
  fait échouer la finalisation (DoS, PAS IDOR silencieux — la RLS masque la ligne
  étrangère). Durcir en contraintes composites. Touche le schéma → migration
  dédiée + cross-review schéma. Lié à la dette #5 (FK composites). À FUSIONNER avec 1.1.
  **→ TRAITÉ SOUS 1.1** : EXPAND livré (`fix/unique-composites`, 2026-07-06) ; reste le
  CONTRACT (PR2). Ne pas ouvrir de chantier séparé — suivre 1.1.
- [x] **3.1 — `redirectOrigin` non allowlisté** —
  ✅ RÉSOLU (vérifié 2026-06-26 ; doublon de l'entrée « 3.1 résolu / suivi » plus haut).
  L'allowlist serveur existe : `src/server/widget/redirect-origin.ts`
  (`autoriserRedirectOrigin`, motif `non_allowliste`, **fail-closed si `APP_ALLOWED_ORIGINS`
  vide**) — une origine hors liste est refusée avant tout appel Omni-FI. Branché dans
  `orchestration.ts`. [Audit backlog 2026-06-26 : entrée jamais cochée.]

### Cross-review sécurité PR-W1 — client widget multi-auth (2026-06-15)

Audit OWASP contexte frais sur la gestion LinkToken/SessionToken/identifiants
bancaires. **Aucun constat bloquant ni non-bloquant valide.**
- Constat « C1 » du réviseur (`historiqueSoldes` sans `clientUserId`) **INFIRMÉ** :
  citation doc erronée (ligne de `latest-job`, pas `balances/history`). La doc
  réelle (`balances/history` : query = from/to/page/pageSize, SANS clientUserId)
  confirme que le client PR 1 est correct. Désaccord tranché par le fait, pas lissé.
- Observations propagées aux PR appelantes (non corrigeables dans le client) :
  - [ ] **A1 — log autour de `connecter()`** : l'appelant (PR-W2/W3) ne doit JAMAIS
    logger l'objet d'erreur + ses arguments ensemble (le body porte le mot de passe
    bancaire). Le client lui-même ne fuite rien. Effort S (P1, déclencheur PR-W2).
  - [ ] **A2 — watermark MFA `undefined` vs `null`** : l'appelant passe `undefined`
    (champ omis) tant qu'aucun resend n'a eu lieu ; ré-émet la valeur lue verbatim
    ensuite. Passer `null` explicite → 409 STALE_INPUT. À documenter côté UI widget.

## P0 — en cours (Semaines 2-3, séquencement C1 restauré par D3)

- [ ] **Epic 1 — Auth.js + consent flow + audit + révocation** — priorité absolue.
  Plan d'implémentation FIGÉ (2026-07-10) : `PLAN-epic1-auth-consent.md` (six
  décisions Q1→Q6 arbitrées). Démontrable en interne sur le workspace démo sandbox.
  - [x] PR 1 `feature/auth-foundation` — FAIT 2026-06-12 (en attente PR humaine).
  - [x] PR 2 — sélecteur de workspace, bascule `activeWorkspaceId`, provisioning
    ADMIN, gating VIEWER serveur : **CONSTATÉ LIVRÉ** à l'audit du 2026-07-10
    (`auth/config.ts:88`, `(workspace)/actions.ts:60`, `provisioning.ts:87`,
    `lib/permissions.ts` appliqué dans 8 repositories). Reliquat → PR 2′.
  - [ ] PR 2′ `feature/epic1-d2-finition` — modal re-login sans perte de contexte
    (bloquant du consent flow : une session expirée pendant le widget MFA perd le
    `SessionToken` Omni-FI), tooltip VIEWER (convention D2 #37 : désactivé +
    tooltip, PAS caché), runbook du premier ADMIN.
  - [ ] L3.1 `feature/epic1-schema-audit` — `consent_records` + `audit_events`
    append-only stricts (migration 0021, trois gardes, snapshots, UNIQUE composite).
  - [ ] L3.2 — émission `GRANTED` + `ACCOUNTS_SELECTED` + `repositories/audit.ts`.
  - [ ] L3.3 — révocation : `DELETE /connections/{ConnectionId}` (⚠️ **PAS**
    `/widget/session/revoke`, qui n'invalide qu'un SessionToken de widget) + purge
    LOGIQUE (`is_removed=true` — l'append-only interdit le DELETE physique).
  - [ ] L3.4 — panneau `/audit` **ADMIN seul** (décision Q1) + export JSON.

#### Dettes ouvertes par le plan Epic 1 (2026-07-10, §10 du plan)

- [ ] **Ouverture du journal d'audit hors ADMIN** — Effort M (**P2**, déclencheur :
  demande client explicite). Décision Q1 : ADMIN-only, fail-closed. `audit_events` et
  `consent_records` ne portent pas `entity_id` (invariant : il vit uniquement sur
  `bank_accounts`) → un membre en Vision Entité y verrait les événements de TOUTES
  les BU du groupe (fuite intra-groupe). Pour l'ouvrir : dériver le scope par
  JOINTURE `connection_id → bank_accounts.entity_id` (ne JAMAIS dénormaliser
  `entity_id` dans l'append-only) + policy RLS `entity_scope` dédiée.
- [ ] **`POST /widget/session/revoke` au `unload` du widget** — Effort S (**P2**,
  déclencheur : polish du widget). **Hygiène de session**, à ne pas confondre avec la
  révocation de consentement (`DELETE /connections/{id}`, lot L3.3). Sans elle, un
  SessionToken de widget survit à la fermeture de l'onglet jusqu'à son expiration.
- [x] **Changement de mot de passe par l'utilisateur** (`AUTH-MDP-TEMPO1`) — **LOT A
  LIVRÉ** (2026-07-17) : page + action self-service `/account/password`, gate
  `must_change_password`, invalidation de session `pwdAt` (D4). Voir l'entrée détaillée
  § « Provisioning membres » et `PLAN-auth-mdp-temporaire.md` ; reste le lot B
  (expiration 7 j + reset admin, entrée AUTH-MDP-TEMPO1-LOT-B).

### Dette relevée au contrat widget natif (UI, 2026-06-15)

- [x] **🔴 `finaliserConnexionAction` désalignée du contrat Fern `publicToken` seul**
  — ✅ **SUPERSEDED / RÉSOLU** (vérifié 2026-07-21). L'entrée décrit du code qui
  **n'existe plus** : `finaliserConnexionAction` ET `finalisationSchema` sont ABSENTS
  de tout `src/` et `tests/` (supprimés dès l'unification du câblage — cf. §
  « Conflit d'agents — câblage widget unifié (2026-06-15, RÉSOLU) » ci-dessus, qui
  actait déjà la suppression ; cette entrée-ci en était le doublon jamais coché).
  Le chemin de finalisation ACTIF n'exige que le(s) publicToken(s), bout en bout :
  1. `banques/page.tsx:69` monte `<BankConnectWidget/>` ;
  2. `bank-connect-widget.tsx:290` `onConnexions={finaliser}` ;
  3. `omnifi-link-launcher.tsx:324-330` `onSuccess(payload)` →
     `publicTokensDepuisPayload` (`:65-70`, n'extrait que `c?.publicToken`) ;
  4. `bank-connect-widget.tsx:148-154` → `finaliserConnexionDropinAction(publicTokens)` ;
  5. `banques/actions.ts:203-207` **`dropinSchema`** `.strict()` = `{ publicTokens:
     string[1..20] }` — **aucun `sessionToken`, aucun `jobId`** ;
  6. `orchestration.ts:1487-1489` → `finaliserConnexionDropin({ publicToken })`
     (`FinaliserDropinParams`, `:467-470` : « ni sessionToken ni jobId ») ;
  7. `orchestration.ts:486-489` **ClientUserId résolu SERVEUR** —
     `clientUserIdDuWorkspace(tx, ctx.workspaceId)`, jamais un paramètre client ;
  8. `orchestration.ts:492` → `client.echangerPublicToken(publicToken, clientUserId)`
     → `client.ts:580-583` `POST /connections/link-exchange` body
     `{ PublicToken, ClientUserId }`.
  Aucun des 5 schémas zod de `banques/actions.ts` (`:143`, `:203`, `:461`, `:516`,
  `:603`) n'exige `sessionToken`/`jobId` pour finaliser — `reparationSchema` (`:461`)
  porte bien un `jobId`, mais c'est le flux **REPAIR** d'une connexion existante, pas
  la finalisation d'un publicToken. Les `sessionTokenSchema`/`jobIdSchema`
  (`widget-runtime.ts:49-50`) survivent sur le chemin **MFA custom MORT** (cf. constat
  CODE-MORT-MFA1 ci-dessous). Prémisse « bloquant avant la démo du widget natif » :
  CADUQUE. **CONTEXTE HISTORIQUE conservé ci-dessous :**
  Décision 2026-06-15 :
  le widget natif Omni-FI (`@omnifi/react`, `onSuccess`) renvoie le **publicToken
  SEUL** (doc Fern `link-connect → PublicToken`). L'UID UI
  (`bank-connect-widget.tsx`) a été aligné : `onSuccess(publicToken: string)`
  n'envoie plus que `publicToken`. MAIS `finaliserConnexionAction`
  (`banques/actions.ts`) garde un `finalisationSchema` zod **`.strict()`** exigeant
  `publicToken + sessionToken + jobId` → avec publicToken seul, la validation
  REJETTE l'appel et la connexion bancaire n'est jamais rattachée. **Action backend** :
  réduire `finalisationSchema` à `{ publicToken }` (le `link-exchange` n'a besoin que
  de `PublicToken` + `ClientUserId`, ce dernier résolu côté serveur depuis le
  workspace). Tant que ce n'est pas fait, le flux de connexion casse à la
  finalisation, même si le widget aboutit.
- [x] **CODE-MORT-MFA1 (P2) — chemin widget MFA « custom » non monté : CONSERVATION
  TRANCHÉE, action = DOCUMENTER** — ✅ documenté 2026-07-21 (commentaire en tête de
  `machine-mfa.ts`). **Ce n'est PAS du code mort à supprimer** : arbitrage Etienne
  2026-07-21 — la pile (`machine-mfa.ts` / `useOmniFiWidget` / `widget-runtime.ts`) est
  le **substrat prévu de `SYNC-LOADER-ETAPES1`** (TODOS `:26-34`, qui pose noir sur
  blanc « le client poll par connexion et **dérive le palier via `machine-mfa.ts`** »).
  La conserver est donc un investissement, pas un oubli — cohérent avec l'arbitrage
  initial de 2026-06-15 (« CONSERVÉE + testée, réutilisable hors dropin ; un seul chemin
  runtime : le dropin »). **Déclencheur de SUPPRESSION** (le seul) : abandon de
  `SYNC-LOADER-ETAPES1` — tant que ce chantier vit, on garde.
  Constat factuel qui reste vrai (relevé à la vérification du 2026-07-21) : `useOmniFiWidget`
  n'est monté par AUCUN composant — seulement ré-exporté par le barrel
  `components/widget/index.ts:7` ; ses Server Actions `pollJobAction`/`submitMfaAction`/
  `resendMfaAction` (`widget-runtime.ts`) ne sont importées que par ce hook ;
  `finaliserConnexion` (orchestration) n'est appelée par aucune action. Reste à surveiller
  (non bloquant) : ces Server Actions sont une surface authentifiée non exercée par le
  produit (elles restent gardées par `exigerSession*`). C'est aussi CE code qui fait
  apparaître des schémas `sessionToken`/`jobId` à un `grep` et a nourri la fausse piste
  ci-dessus — d'où le commentaire d'en-tête, pour que le prochain lecteur ne rejoue pas
  l'enquête.

### Dette acceptée à la PR auth-foundation (2026-06-12)

- [ ] **Purge périodique de `login_attempts`** — Effort S. Les lignes hors
  fenêtre (15 min) s'accumulent ; cron de purge à brancher avec les crons de
  la pipeline (semaines 3-5). Sans purge : croissance lente de la table, aucun
  impact de sécurité (le COUNT est borné par l'index).
- [ ] **Runbook rotation AUTH_SECRET** — Effort S. La rotation invalide toutes
  les sessions actives (stratégie JWT) ; procédure + fenêtre de maintenance à
  documenter au setup du déploiement (avec le choix d'hébergeur, règle 9).
- [ ] **Typographies UI complètes (Instrument Sans + Geist tabular partout)** —
  Effort S. Le login utilise les tokens couleurs §0 mais la famille Geist
  existante ; bascule complète avec le build UI (spec VALIDATED_SHELVED).

### Dette relevée pendant le refacto d'arborescence (2026-06-12)

- [ ] **`@/db` ré-exporte `schema` → porte dérobée à la frontière P0-a** —
  Effort S (P1). La règle lint confine `@/db/schema`, mais `src/db/index.ts`
  ré-exporte `schema`, donc `app/page.tsx:14` importe `{ schema, withWorkspace }`
  et tisse du Drizzle brut (`schema.workspaces`) dans un Server Component. À
  corriger en 2 temps : (a) retirer le ré-export `schema` de l'index DB pour
  fermer la porte ; (b) déplacer la requête de page.tsx dans un repository scopé.
  Code applicatif → hors du refacto mécanique, lot dédié.

### Dette acceptée au schéma financier Epic 3 (2026-06-12)

- [ ] **Roulement automatique des partitions `transactions_cache`** — Effort S
  (P1, déclencheur : premier déploiement de production). La migration 0003 crée
  les partitions annuelles 2024-2027 + DEFAULT ; le plan exige une alerte si la
  partition à J-30 manque + création automatique du roulement. À brancher avec
  les crons de la pipeline de sync (Étape 2). Sans elle : à partir de 2028 les
  lignes tombent dans la partition DEFAULT (fonctionnel mais non perforant) —
  jamais de perte de données.
  **⚠️ SÉCURITÉ NON NÉGOCIABLE** : toute partition créée par ce roulement DOIT
  poser, à sa création, `ENABLE` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY
  tenant_isolation`. La RLS N'est PAS héritée de la mère (cf. constat bloquant
  cross-review 2026-06-15, corrigé dans 0003 pour 2024-2027+DEFAULT) → c'est
  l'invariant que le roulement doit RÉPÉTER. Une partition sans RLS = fuite
  cross-tenant. À traiter comme de l'isolation tenant (non différable).
  NB : le **trigger `BEFORE DELETE` append-only** (migration 0004), lui, EST
  hérité automatiquement par toute partition (présente/future, PostgreSQL ≥ 11,
  vérifié empiriquement) — le roulement n'a PAS à le répéter. Ne pas confondre
  les deux invariants : RLS = à répéter ; trigger = hérité.

### Dette acceptée au schéma Epic 3 — cross-review (2026-06-15)

Cross-review contradictoire (rôle Sécurité, contexte frais) sur la branche
`feature/epic3-schema`. BLOQUANT corrigé dans 0003 (RLS+FORCE+policy sur les 5
partitions de `transactions_cache`, commentaire faux retiré). #3 PARTIELLEMENT
traité (voir ci-dessous). Différés :

- [x] **#3bis — Tombstone non garanti par le seul REVOKE de 0003 — FAIT
  2026-06-17** (branche `fix/tombstone-delete-provisioning`). `tygr_app.sql`
  passe en **liste blanche DELETE (deny-by-default)** : plus aucun `GRANT DELETE
  ON ALL TABLES` ; le GRANT global se limite à `SELECT, INSERT, UPDATE` (idem
  `ALTER DEFAULT PRIVILEGES`), et DELETE est octroyé table par table (bloc
  `DO`/`to_regclass` conditionnel) UNIQUEMENT aux 6 tables normales
  (`workspaces`, `users`, `login_attempts`, `workspace_members`,
  `bank_connections`, `bank_accounts`). `transactions_cache` (+ partitions, y
  compris FUTURES via roulement) et `balance_history` ne reçoivent JAMAIS DELETE
  — garantie indépendante de l'ordre provision/migrate et du nombre de
  re-provisions (prouvé PGlite : invariant `DELETE=false` dans les deux ordres).
  Le `REVOKE` de 0003 demeure (ceinture + intention documentée). Preuve verrouillée :
  `tests/isolation/tombstone-delete-isolation.test.ts` (DELETE refusé sur les 2
  tables + partition directe + DEFAULT ; UPDATE `is_removed` toujours autorisé ;
  contre-preuve DELETE autorisé sur `workspace_members`). Le piège « REVOKE non
  propagé aux partitions » est ainsi clos par construction.
  **2e volet — faille CASCADE colmatée (cross-review Sécurité, 2026-06-17).** La
  liste blanche seule NE suffisait PAS : le grant DELETE légitime sur
  `bank_accounts`/`bank_connections` (déconnexion d'une banque) laissait la
  cascade FK `ON DELETE cascade` effacer PHYSIQUEMENT l'append-only SANS
  re-vérifier son privilège (reproduit : 1 ligne → 0). Migration **0004**
  (`0004_append-only-no-delete.sql`) ajoute une fonction + un **trigger
  BEFORE DELETE** sur la mère `transactions_cache` (HÉRITÉ par ses 5 partitions,
  présentes et futures — PostgreSQL ≥ 11) et sur `balance_history`, qui lève
  `append_only_no_delete` (ERRCODE check_violation) : défense réelle indépendante
  du privilège ET du chemin (direct / partition directe / cascade / code futur).
  L'invariant append-only est désormais vrai par construction (vérifié même SOUS
  l'owner, et sur une partition 2028 créée après la migration). Cas cascade
  verrouillés (tests 8-10 : DELETE `bank_accounts`/`bank_connections` rejeté,
  lignes append-only intactes). Le roulement de partitions n'a PAS à répéter le
  trigger (hérité) — seule la RLS est à répéter (cf. dette roulement ci-dessus).
  - [ ] **Suivi opérationnel (P2, déclencheur : 1er déploiement prod sur base
    NEUVE)** — Effort S. En ordre `provision → migrate` sur base vierge, les
    GRANT DELETE des tables normales sont sautés au 1er provision (tables encore
    absentes) ; ils ne mordent qu'au **re-provision post-migrate**. L'append-only
    reste protégé à tout instant (jamais d'octroi) ; le seul effet est que
    l'offboarding RGPD (DELETE sur tables normales) exige ce re-provision. À
    intégrer dans le runbook de déploiement (étape « db:provision » à rejouer
    après migrate). Aucun impact sur base déjà migrée (cas Neon/local actuel).

- [x] **#2 — Idempotence d'ingestion non garantie par la clé DB** — FAIT 2026-06-15
  (PR 2 ingestion, `feature/epic3-ingestion`). `upsertTransactions`
  (`src/server/repositories/ingestion.ts`) neutralise (is_removed=true) toute
  version antérieure de même `omnifi_txn_id` posée sur un AUTRE
  `transaction_date` AVANT l'upsert sur la clé naturelle → un re-affinement du
  BookingDateTime par l'amont ne crée plus de doublon. RLS scope la mise à jour
  au workspace courant.

### Migration ingestion curseur → PAGE (2026-06-19)

L'orchestrateur d'ingestion est passé du modèle par curseur (`/transactions/sync`,
delta Added/Modified/Removed/NextCursor) au modèle par PAGE (`/transactions`,
`Links.Next`/`Meta.TotalPages`), Omni-FI ayant confirmé que `/sync` est une
extension future NON déployée (cf. OMNIFI_API_FEEDBACK.md §10). Branche
`feat/ingestion-pagination-page`. Conséquences tracées :

> ✅ **RECONFIRMÉ (Slack Omni-FI, 2026-06-26)** : `/transactions/sync` et
> `/balances/history` NE sont PAS déployés ; l'API est page-based
> (`GET /accounts/{id}/transactions`). Audit code 2026-06-26 : l'orchestrateur vise
> bien le page-based (`orchestrateur.ts:167`, boucle `TotalPages`/`Links.Next` avec
> plafond anti-boucle) — AUCUN appel curseur résiduel. Pas de bug, rien à corriger.

- [ ] **INGEST-CURSOR1 (P2) — retirer la colonne orpheline `sync_cursor`** —
  Effort S (déclencheur : prochaine migration touchant `bank_accounts`, ou revue
  de fin d'epic). Depuis la migration page, `bank_accounts.sync_cursor`
  (`schema.ts`) n'est plus écrite ni lue (seul `last_synced_at` est maintenu via
  `marquerSynchronise`). Colonne laissée en place EXPRÈS pour ne pas coupler ce
  changement de code à une migration DB (risque séparé). À dropper proprement
  (migration `ALTER TABLE … DROP COLUMN`, backward-compatible avec le code N-1).
- [ ] **INGEST-DELTA1 (P2) — surcoût du re-téléchargement complet** — Effort M
  (déclencheur : volumes prod réels OU Omni-FI déploie `/transactions/sync`).
  Le modèle par page relit TOUTE la liste des transactions à chaque sync (pas de
  delta) ; l'`upsert` idempotent absorbe les doublons mais le coût réseau/CPU croît
  avec l'historique. Acceptable au MVP (volumes sandbox faibles, arbitrage PO
  2026-06-19). Atténuations possibles : borne `fromBookingDateTime` si l'API la
  supporte, ou repasser au curseur le jour où `/sync` existe (le code était déjà
  écrit pour, cf. historique git).

### Dette résolue / intégrée à la PR 2 ingestion (2026-06-15) — ⚠️ SUPERSEDED par la migration page (2026-06-19)

> Q3 (`bornerCount`/`COUNT_MAX`) et Q4 (`HasMore`/`NextCursor`) ci-dessous étaient
> SPÉCIFIQUES au modèle curseur, désormais abandonné. Q3 devient `bornerPageSize`
> (pageSize borné [1, 100]) ; Q4 devient la garde `MAX_PAGES` sur la boucle par page
> (l'amont peut mentir sur `Links.Next`). Conservé pour historique.

Q3 et Q4 (différées depuis la cross-review PR 1) intégrées dans l'orchestrateur
`src/server/ingestion/orchestrateur.ts` :
- **Q3 (count borné)** : `bornerCount` clampe le `count` du sync dans [1, 500]
  (COUNT_MAX, doc Omni-FI) avant tout appel réseau.
- **Q4 (garde anti-boucle)** : la boucle lève `IngestionBoucleError` si l'amont
  renvoie `HasMore=true` avec un `NextCursor` vide ou identique au précédent
  (sinon re-ingestion infinie de la 1re page) ; plafond `MAX_PAGES` en filet.

- [ ] **Découverte de comptes (connexion → bank_accounts) hors surface PR 1** —
  Effort M (P1, déclencheur : flux widget / consent). L'ingestion PR 2 synchronise
  des comptes DÉJÀ rattachés (`synchroniserCompteComplet`) mais ne crée pas les
  `bank_accounts` à partir d'une connexion : la liste des comptes d'une connexion
  passe par `GET /sync/job/{JobId}/accounts` (SessionTokenAuth) ou `GET
  /parties/{PartyId}/accounts` (ApiKey + PartyId), hors de la surface lecture
  livrée en PR 1. Pour la démo sandbox : rattacher les comptes pré-connectés en
  amont (script/seed). À industrialiser avec le flux widget. `upsertCompte` est
  déjà prêt dans le repository d'ingestion.
- [ ] **#5 — FK non composites → rattachement cross-workspace possible** — Effort
  M (P1). `bank_accounts.connection_id → bank_connections.id` (et FK analogues)
  ne vérifient pas l'égalité de `workspace_id` : une ligne du workspace courant
  peut référencer un parent d'un autre workspace. Atténué par le `WITH CHECK`
  (on n'écrit pas DANS un autre tenant) + `workspace_id` dénormalisé et indexé
  (la lecture reste filtrée). Durcissement : PK/UNIQUE composites `(workspace_id,
  id)` sur les parents + FK composites. À trancher (coût vs bénéfice).
- [ ] **#6 — `ON DELETE no action` sur `created_by`/`workspace_id`** — Effort S
  (P1). Supprimer un user qui a créé une `bank_connection` est bloqué par la FK
  (alors que `workspace_members.user_id` est en cascade) → offboarding RGPD
  heurte une erreur FK. Choix à acter : `SET NULL` sur `created_by` (traçabilité
  via audit_events) vs statu quo (protection de l'historique). Idem suppression
  de workspace, bloquée tant qu'il reste des données financières.

### Dette acceptée à la PR 1 client Omni-FI — cross-review (2026-06-15)

PR 1 `feature/epic3-omnifi-live`. La cross-review contradictoire (rôles Sécurité
+ QA, contexte frais) a produit 7 constats. Corrigés DANS la PR 1 : S1 (SSRF/
fuite de clé — `startsWith` https contournable → `new URL` + rejet userinfo +
allow-list des 3 hôtes doc), Q1 (`{Data:null}` rejeté), S2 (cause réseau réduite
à `{name,code}`), Q5 (`Retry-After` format date HTTP), Q2 (Links/Meta exposés sur
les endpoints page-based). Différés ci-dessous (mordent en PR 2, pas en PR 1) :

- [ ] **Q3 — `count` du sync non borné vs max 500 (doc § Transactions)** — Effort S
  (P1, déclencheur : PR 2 ingestion). `OmniFiClient.syncTransactions` passe `count`
  tel quel ; un `count>500` → soit 400 dur (ingestion bloquée), soit clamp
  silencieux (dérive de pagination). À borner [1,500] côté client ou appelant au
  moment où la boucle d'ingestion est écrite. Sans : risque uniquement si un
  appelant fournit un count hors borne — aucun appelant n'existe avant la PR 2.
- [ ] **Q4 — invariant curseur `NextCursor` vide + `HasMore:true` non défendu** —
  Effort S (P1, déclencheur : PR 2 ingestion). `NextCursor` est typé `string` non
  optionnel ; une boucle naïve sur un `NextCursor:""` renvoyé avec `HasMore:true`
  re-demanderait la 1re page (curseur vide = historique complet) → boucle infinie
  ré-ingérant les mêmes lignes. La garde (refuser `HasMore` sans curseur non vide)
  vit naturellement dans la boucle d'ingestion PR 2. Sans : aucun effet en PR 1
  (le client expose une page, n'itère pas).

### Dette relevée pendant Epic 2 + audit EM (2026-06-12)

- [x] **next-auth épinglé en CARET, viole notre propre règle 9** — FAIT
  2026-06-15 (PR 0 `feature/epic3-omnifi-live`). Pin exact posé dans
  `package.json` ET `package-lock.json` (`"5.0.0-beta.31"`, sans `^`) ; version
  résolue inchangée (`5.0.0-beta.31` déjà installée), `npm ci --dry-run` OK.
  Rappel : re-valider le parcours login à chaque bump manuel futur.
- [ ] **QA visuelle des états Suspense non capturable in situ** — Effort S (P2).
  Le skeleton `loading.tsx` n'a pas pu être capturé via navigation réelle
  (browse attend `load` ; le Suspense streamé échappe au timing ; CDP network
  throttling hors allowlist). Contourné par un **rendu HTML offline** (CSS
  compilé extrait du dev server) — le markup est validé, mais PAS dans le vrai
  flux Suspense. Déclencheur : pour une QA fiable des états de chargement,
  ajouter un harness Playwright qui intercepte le streaming, OU une route de
  test dédiée derrière un flag dev. Le code `loading.tsx` est correct.
  **MAJ 2026-06-15** : la route de démo `/demo/dashboard-states`
  (feature/epic3-dashboard-ui-states-v2) matérialise l'option « route de test
  dédiée » — les 3 états du dashboard y sont capturables in situ (Visual QA
  réussie via segmented control, sans flux Suspense). Reste ouvert pour
  `loading.tsx` du sélecteur (Suspense réel). Reclasser en « partiellement
  adressé » au merge.
- [ ] **CSO findings 1+2 — courses lockout & rate-limit (TOUJOURS OUVERTS)** —
  Effort S-M (P1). Re-validation read-decide-write non atomique : N requêtes
  concurrentes lisent l'état « non verrouillé » avant qu'aucune n'écrive →
  bypass du lockout E18 et du plafond IP E7 sous concurrence. Plus grave que le
  delta de timing ci-dessous. Correction structurelle commune : UPDATE
  conditionnel atomique (lockout) + compteur atomique (IP, Redis en phase 2).
  À traiter en un lot AVANT le premier déploiement production. Rapport CSO du
  2026-06-12 (script d'attaque de preuve disponible).

### Dette relevée en validation locale (2026-06-12, EM run)

- [x] **Provisioning du rôle `tygr_app` non migré (P0-b)** — FAIT 2026-06-12 :
  `drizzle/provisioning/tygr_app.sql` (idempotent, sans mdp) + `npm run
  db:provision` + garde-fou runtime C6 (`UnsafeDatabaseRoleError`) + contre-
  preuve R1 (test C5) + suite isolation consomme le script (source unique).
  Spec : `docs/specs/provisioning-tygr-app.md`. Reste à brancher dans la CI
  (étape provision avant migrate) au setup déploiement — dépend de l'hébergeur.
- [ ] **Delta de timing résiduel ~10-15 ms sur le login** — Effort S. La
  vérification argon2 est égalisée (hash factice) mais l'écriture d'échec
  (transaction FOR UPDATE) n'existe que sur le chemin « compte connu » —
  oracle statistique théorique. Exploitation bornée par la limite 20/IP/15 min.
  Option : écriture factice symétrique côté email inconnu.
- [ ] **`/login` vide les champs après un échec** — Effort S (UX). L'email doit
  survivre au re-rendu de useActionState. À reprendre avec le build UI.
- [ ] **`turbopack.root` à épingler dans next.config.ts** — Effort S. Un
  package-lock.json parasite dans le HOME fait inférer une mauvaise racine
  workspace (warning au boot dev).

## P1 — au scaffold du repo (bloquant pour le premier commit de code)

- [x] **Installer les hooks stop-loss** — FAIT 2026-06-11 : `.husky/pre-commit`
  (prouvé bloquant sur erreur de type) + `.claude/settings.json` PreToolUse
  (`.claude/hooks/stop-loss-commit.sh`). Ajouter `npm test` au pre-commit dès que
  la suite de tests existera.
- [ ] **npm audit : 2 vulnérabilités modérées transitives** (postcss via next,
  toutes versions stables affectées au 2026-06-11) — Effort S. Surveiller le patch
  next et re-auditer à chaque bump (CLAUDE.md règle 9).
- [x] **Règle lint anti accès DB ad-hoc (P0-a)** — FAIT 2026-06-12 (refacto
  d'arborescence, étape 1) : `no-restricted-imports` confine schéma/repositories
  hors `src/server/**`, `allowTypeImports` pour les types partagés ; barrière
  prouvée chirurgicale (import de valeur du schéma depuis `app/` rejeté).
- [x] **Pipeline CI canonique** — FAIT 2026-06-11 : `.github/workflows/ci.yml`
  (lint → typecheck → tests/IDOR bloquant, sur PR vers main). Restent à brancher au
  setup du déploiement : étape build, migrations expand-contract, deploy preview
  (règle 9) — dépend du choix d'hébergeur (Vercel + Neon).

### Chantiers produit prioritaires (revue PM/Architecture, 2026-06-23)

- [ ] **PROD-MERCHANT1 (P1) — afficher le marchand réel + la catégorie amont (tuer « Opération bancaire »)** —
  Effort M, gardien Front + Backend (contrat). Ouvert 2026-06-23. Le fallback
  `"Opération bancaire"` (`transactions/adapter.ts:83`, `transactions-table.tsx:54`)
  s'affiche quand `clean_label` est null. L'enrichissement amont est DÉJÀ ingéré et
  stocké (`orchestrateur.ts:70-72` mappe `CleanMerchantName`/`PrimaryCategory`/
  `SubCategory` ; colonnes `schema.ts:372-373`) — donc le travail est d'EXPOSER en
  lecture, pas de brancher une intégration absente. **PRÉ-REQUIS BLOQUANT (règle 6) :
  vérifier en runtime le niveau du contrat** — le serializer Django réel niche sous
  `Enrichment{}` (`omni-fi-core/.../serializers.py:92-101`) alors que `types.ts:97-99`
  lit les champs À PLAT. Si le sandbox respecte le serializer, `t.CleanMerchantName`
  est toujours `undefined` → 100% des lignes tombent sur le fallback (cause racine
  probable). Logger 1 payload sans PII avant tout code. **Recoupe `GAP-CATEG-NATIVE1`
  (exploitation `primary_category`/`sub_category`)** — PROD-MERCHANT1 en est la tranche
  AFFICHAGE due immédiatement ; GAP-CATEG-NATIVE1 garde le volet score de confiance/
  file de revue (Epic 8.1). **Déclencheur** : ce ticket (irritant visible en démo).

- [ ] **PROD-TRESO-EOD1 (P1) — courbe de trésorerie journalière depuis `RunningBalance`** —
  Effort M, gardien Backend. Ouvert 2026-06-23. PRÉMISSE CORRIGÉE : le « Solde Total »
  n'est PAS déduit des historiques — il vient déjà du `current_balance` instantané ITAV
  (`orchestration.ts:151-153`, `dashboard.ts:179-193`). Le vrai trou = la COURBE 90j
  (`balance_history`) est vide tant qu'Omni-FI ne sert pas `/balances/history` (404
  sandbox). Le serializer transaction expose `RunningBalance` par ligne
  (`omni-fi-core/.../models.py:94-100`) : reconstruire l'EOD réel par compte/devise à
  partir du dernier `RunningBalance` de chaque jour comptable (AT TIME ZONE
  'Indian/Mauritius', E20), sans attendre l'endpoint amont. APPEND-ONLY : `balance_history`
  reste immuable (pas de DELETE). **Lève la décision DR-F3** (solde courant vs EOD) et
  alimente la courbe prévisionnelle. **NON une dette de montants** (lecture/reconstruction,
  pas de FX). **Déclencheur** : ce ticket OU recette « la courbe est vide ».

- [x] **PROD-UX-REVIEW1 (P1) — review UX/UI profonde via /design-review** —
  ✅ **RÉALISÉ en 2 passes** : 2026-07-15 (PR #215 — 19 findings, 9 fixés, 10 différés
  tracés en sous-tickets DESIGN-* datés, score B− → B+) et 2026-07-17 (branche
  `chore/design-review-20260717` — écrans re-audités contre UI_GUIDELINES §6 AU DOM,
  vraie donnée locale ; 4 findings nouveaux, 4 fixés dont 1 HIGH : scroll horizontal de
  page à 1024-1279 causé par la barre globale [F-104], zéros colorés vert/rouge sur
  Synthèse du mois [F-101] et Synthèse prévisionnelle [F-102], formulaire d'échéance non
  réinitialisé au succès [F-103] ; conformités PROUVÉES : tabular-nums, inflow/outflow,
  surface-forecast, focus-visible, header sans flex-wrap, suppression 2 temps #216).
  Rapports : `~/.gstack/projects/tygr-app/designs/design-audit-20260715/` et
  `…/design-audit-20260717/`. Historique : ouvert 2026-06-23, effort L, gardien
  Front + Design ; écrans clés dashboard, /transactions, /regles, sas entités ; écarts
  OBJECTIFS (tokens) bloquants (Gate 4), écarts de goût renvoyés en backlog (faits).

### Sync / widget (2026-07-13) — dettes de code

- [ ] **SYNC-TYPE-STRUCTUREL1 (P1) — `EtatFinalisation` est consommé via des sous-types
  STRUCTURELS qui ignorent les nouveaux champs EN SILENCE.** `dashboard/sync-button.tsx` déclare
  son propre type `Retour` : il avait omis `info`, et **aucun gate ne l'a vu** (`tsc` est content,
  le champ est juste jeté) → l'incident « spinner puis rien » restait entier sur l'écran d'accueil
  alors qu'il était corrigé sur `/banques`. C'est une classe de bug, pas un oubli isolé : tout
  champ ajouté à `EtatFinalisation` peut mourir en route. Piste : faire consommer directement
  `EtatFinalisation` (ou `Pick<EtatFinalisation, …>`) au lieu d'un type redéclaré.
  **Déclencheur** : prochain champ ajouté à `EtatFinalisation`. **Effort** : S.

- [ ] **SYNC-ENV1 (P1) — `.env.prod` : l'étiquette d'environnement ment.** `OMNIFI_ENV="production"`
  et `OMNIFI_AUTORISER_PRODUCTION=1` alors que `OMNIFI_BASE_URL="https://api-stage.omni-fi.co"`.
  L'API répond 200 (les clés matchent l'hôte — l'env se décide par les CLÉS, pas l'hôte), donc
  c'est inoffensif aujourd'hui ; mais un lecteur croit tourner en production. À aligner en même
  temps que **WIDGET-ENV1** (`NEXT_PUBLIC_OMNIFI_ENV="production"` → charge un CDN qui répond 403).
  **Déclencheur** : prochaine bascule d'environnement. **Effort** : XS.

- [ ] **SYNC-DESYNC1 (P1) — reconnecter SBM et MCB (action OPÉRATIONNELLE, pas du code).**
  Diagnostic runtime du 2026-07-13 : `bank_connections` porte 2 connexions (SBM `6a49e45c…`,
  77 comptes ; MCB `307f186e…`, 10 comptes) que `GET /connections` **ne renvoie plus** ; Omni-FI
  n'expose qu'une connexion Bank One (`05358b93…`), **absente de la base** (sa finalisation par
  le widget avait échoué en silence — cf. PR #200). Le correctif
  `fix/sync-spinner-sans-resultat` rend cet état VISIBLE et actionnable, mais ne le répare pas :
  il faut reconnecter les banques via le widget. ⚠️ **Ne PAS supprimer les 87 comptes** — données
  réelles (cf. [[diag-sync-403-enduser-prod]]). **Déclencheur** : immédiat. **Effort** : XS.

## P2 — après le MVP

### Sync / widget (2026-07-13) — dettes différées

- [ ] **SYNC-REVOCATION1 (P2) — une connexion révoquée LOCALEMENT sera encore synchronisée.**
  `connexionsConnues` (le filtre de TRAITEMENT du sync) ignore le statut local — délibéré et
  documenté. Les COMPTEURS, eux, sont protégés (`connuesActives`). Corollaire relevé en
  cross-review : le jour où la révocation (`DELETE /connections/{id}`) arrivera, une connexion
  révoquée chez nous mais encore active côté Omni-FI continuera d'être **synchronisée**.
  **Déclencheur** : livraison de la révocation. **Effort** : XS.

### Widget natif — dettes ouvertes par `fix/widget-erreur-visible` (2026-07-13)

- [ ] **WIDGET-ERR1 (P2) — reprise transparente sur `LINK_TOKEN_EXPIRED`.** Le registre S2
  du plan promettait « régénérer le link-token, relancer le widget » sans clic. Le correctif
  livre la rescue EXPLICITE (message + bouton réarmé, l'utilisateur reclique) : une relance
  automatique boucle si le token expire immédiatement, et masquerait la cause. **Déclencheur** :
  plainte utilisateur sur la friction du re-clic, OU stabilisation du TTL des LinkToken côté
  Omni-FI. **Effort** : S.

- [ ] **WIDGET-ERR4 (P2) — le watchdog du SDK peut être cassé EN SILENCE par une régression
  de dépendances ; aucun gate ne l'attraperait.** Le risque n'est pas « des effets non testés »
  en général : c'est que la correction de `omnifi-link-launcher.tsx` repose **entièrement sur la
  STABILITÉ des dépendances**. `signalerSdkIndisponible` est un `useCallback([])` qui lit
  `onErreurRef.current` **précisément pour ne pas fermer sur `onErreur`** (closure recréée à
  chaque rendu du parent). Quiconque « corrigera » ça en remettant `onErreur` dans les deps
  obtiendra : deps du watchdog changées à chaque rendu → `clearTimeout` + `setTimeout` en
  boucle → **le watchdog ne tire JAMAIS** tant que le parent rerend plus vite que 15 s → retour
  à l'attente infinie et muette. Même piège sur l'effet `open()` : `onErreur` dans ses deps le
  ferait rejouer à chaque rendu → `destroy()` + `connect()` **en boucle sous l'utilisateur**.
  **Ni ESLint (`exhaustive-deps` est SATISFAIT par la version fragile), ni `tsc`, ni les 459
  tests ne verraient la régression** — seul le mapping pur est couvert. **Déclencheur** :
  arrivée d'un renderer React de test au projet (jsdom + `@testing-library` — hors périmètre
  d'un correctif : nouvelle dépendance, règle 9), OU 2ᵉ incident dans un effet du widget.
  **Effort** : M (S une fois le renderer là). **Entre-temps** : les commentaires du fichier
  nomment le piège — les lire avant de toucher aux deps.

- [ ] **WIDGET-ERR5 (P2) — parler INSTANTANÉMENT au 2ᵉ montage après un échec de SDK.**
  Le `<script>` mort restant dans le `<head>`, la condition est **définitive pour ce document** :
  au montage suivant, on inflige quand même 15 s de panneau verrouillé avant de parler. Un
  drapeau module-level poserait le message aussitôt. ⚠️ **Piège** : un drapeau NU
  transformerait un faux positif du watchdog (bénin et auto-réparateur aujourd'hui — le SDK
  finit par charger, le clic suivant marche) en **verrouillage permanent de la page**. Il faut
  le garder par l'état réel : `if (sdkCondamne && !window.OmniFI) signalerSdkIndisponible()`.
  Purement ergonomique ; le watchdog seul est correct. **Déclencheur** : plainte sur l'attente
  de 15 s au 2ᵉ essai. **Effort** : S.

- [ ] **WIDGET-ERR2 (P2) — télémétrie SERVEUR des codes d'échec du widget.** Aujourd'hui le
  code part en `console.warn` navigateur (le launcher est client-only) : en production, on ne
  saura pas quels codes tombent réellement chez les utilisateurs. Une remontée serveur exige
  une Server Action dédiée (surface + rate-limit à penser) — non justifiée pour ce fix.
  **Déclencheur** : premier échec widget non reproductible signalé par le support. **Effort** : S.

- [ ] **WIDGET-ENV1 (P1) — `.env.prod` local pointe le CDN widget en 403.** `.env.prod:39`
  porte `NEXT_PUBLIC_OMNIFI_ENV="production"` → le hook charge `cdn.omni-fi.co/v1/omni-fi-connect.js`,
  qui répond **403** (seul `staging-cdn` est déployé, cf. [[prod-omnifi-pas-deployee]]). Le
  fichier VERSIONNÉ `.env.prod.example:49` porte bien `"staging"`, et `scripts/dev-server.sh:84`
  force `staging` — d'où l'invisibilité en local. Tout chemin de démarrage qui ne passe PAS par
  ce script (Dockerfile, hébergeur, `next start --env-file=.env.prod`) charge le mauvais bundle.
  `fix/widget-erreur-visible` rend désormais l'échec VISIBLE (message + bouton réarmé au lieu
  d'une attente infinie muette) mais **ne répare pas la config** : le widget reste inutilisable
  sous cet env. Fichier non versionné → à corriger à la main (`NEXT_PUBLIC_OMNIFI_ENV="staging"`).
  **Déclencheur** : immédiat — avant toute démo sur un env non piloté par `dev-server.sh`.
  **Effort** : XS.

- [x] **WIDGET-ERR3 (P1) — `WidgetFeedback` viole §3.4 (erreur sans fond ni icône).**
  ✅ **LIVRÉ (2026-07-20, branche `fix/ux-synchro-et-erreur-connexion`)** — arbitrage rendu
  dans le premier sens : **§3.4 s'applique**, aucune exception « feedback inline » (la règle
  ne prévoit pas de dérogation de taille). Les 3 canaux (`erreurDemarrage`, `erreurWidget`,
  `erreurFinalisation`) passent par la primitive `Callout severite="danger"`
  (`src/components/ui/states/callout.tsx`) : fond `danger-bg` + icône + message + `role="alert"`.
  Registre de messages et logique non-énumérante (#229) NON touchés — seul le contenant change.
  **Trouvaille de la passe design** : le motif `text-danger` sur `bg-danger-bg` plafonne à
  **4,40:1** et ÉCHOUE l'AA en corps de texte (mesuré, WCAG 2.1). La primitive met donc le
  MESSAGE en `text-text` (11,46:1) et réserve la couleur de sévérité à l'ICÔNE.
  **Constat d'origine** : l'écart comptait 3 occurrences, assumé dans le JSDoc du composant.

- [ ] **UI-CALLOUT-MIGRATION1 (P2, effort S, 2026-07-20) — 4 callouts ad-hoc à migrer vers
  la primitive `Callout`.** Le markup « fond teinté + icône + message » est dupliqué à
  l'identique dans `components/echeances/echeances-feature.tsx:246`,
  `components/regles/regles-feature.tsx:260`, `components/transactions/transactions-feature.tsx:459`
  et `components/admin/avertissement-vue-restreinte.tsx:38` (variante `warning`). Tous portent
  le défaut de contraste mesuré ci-dessus (`text-danger` sur `danger-bg` = **4,40:1**, sous
  l'AA de 4,5) : ce n'est donc pas qu'une déduplication, c'est une correction d'accessibilité.
  Hors périmètre de WIDGET-ERR3 (livré à 2 jours d'une démo, on ne touche pas 4 écrans
  supplémentaires). **Déclencheur** : prochain chantier UI transverse, OU premier audit a11y.

- [ ] **A11Y-VERT-SUCCES1 (P1, effort S, 2026-07-20) — le token `success` échoue l'AA en
  corps de texte, ET la doc affirme le contraire.** Mesuré au DOM pendant la Gate 4 de
  `fix/ux-synchro-et-erreur-connexion` (WCAG 2.1, sur `surface-card`) :
  `text-success` rendu = **3,46:1**, sous le seuil AA de 4,5. Or `docs/UI_GUIDELINES.md:409`
  annonce « `success` #079455 (AA sur blanc) » en qualifiant l'accessibilité de « non
  négociable (audience régulateur) ». **Deux défauts distincts** :
  1. **dérive de token** — `globals.css:32` livre `--color-success: #1d9e55`, pas le
     `#079455` documenté ;
  2. **l'affirmation de la doc est fausse dans les deux cas** — `#079455` mesure **3,91:1**,
     il échoue l'AA lui aussi. Le seul vert conforme du système est `inflow #157a4a`
     (**5,36:1**), mais il est RÉSERVÉ à la donnée financière : on ne peut pas le recycler
     en couleur d'état système sans casser l'étanchéité sémantique du §3.4.
  **Portée** : tout message de succès de l'app, pas seulement la synchro — `SyncSummary`
  et `widget-feedback` rendent la MÊME phrase serveur, un correctif unilatéral sur un seul
  des deux écrans les ferait diverger (classe de bug tuée par la PR #202).
  **PARTIELLEMENT TRAITÉ (2026-07-20, `fix/ux-synchro-et-erreur-connexion`)** — l'option
  « partage `Callout` » a été retenue et appliquée aux surfaces du feedback de synchro :
  notice de succès (`text-text` sur `success-bg`, vert en fond + coche), pastille de
  fraîcheur (libellé neutre, point coloré), et `widget-feedback` — inclus DÉLIBÉRÉMENT
  malgré son absence du brief, précisément pour ne pas créer la divergence annoncée
  ci-dessus (arbitrage Etienne, 2026-07-20). `docs/UI_GUIDELINES.md:409` est corrigée
  (les deux valeurs annoncées échouaient l'AA) et §3.7 précise que le niveau colore le
  point, pas le libellé.
  **RESTE À FAIRE (le P1 ne se ferme PAS)** : les ~10 `text-success` hors périmètre —
  `admin/entites/{bandeau-recap,assignation-comptes,assignation-entites,propositions}`,
  `admin/membres/formulaire-provisioning`, `echeance-badge` (badge « Payée »),
  `connexions-bancaires` (badge « Connectée »), `workspace-switcher`. Plusieurs sont des
  BADGES `bg-success-bg` + `text-success` : leur ratio est encore plus bas que sur blanc,
  et le partage `Callout` ne s'y applique pas tel quel (un badge n'a pas d'icône). D'où
  l'ajout d'un token **`success-700` AA** à trancher, qui reste le vrai objet de ce P1.
  **Mesure supplémentaire à intégrer au fix** (Gate 4 du 2026-07-20) : l'ICÔNE de la
  notice de succès (`text-success` sur `success-bg`) tombe à **2,93:1**, 0,07 sous le
  seuil 3:1 des objets non textuels — le fond teinté rabote le vert (3,46 sur blanc →
  2,93 sur `success-bg`). Sans conséquence fonctionnelle (icône `aria-hidden`, redondante
  avec un message à 15,1:1, donc hors champ de 1.4.11), mais `success-700` doit être
  choisi en visant **≥3:1 sur `success-bg`**, pas seulement sur blanc — sinon le token
  « corrigé » laissera cet écart en place. Les icônes warning (4,56) et danger (4,40)
  passent déjà.
  **Déclencheur** : après la démo BOM Innov8 (branche dédiée, audience régulateur = a11y
  opposable).

- [x] **WIDGET-ERR6 (P1, effort S, 2026-07-16) — `LOGIN_FAILED` (et la famille des
  échecs de scraping) tombent sur le message générique : on ferme le widget sans dire
  POURQUOI.** ✅ **LIVRÉ (2026-07-20, branche `fix/widget-err6-login-failed`)** — 10
  `SyncJob.Error.Type` mappés au registre S2, lus À LA SOURCE (`omni-fi-core`,
  `apps/sync_engine/orchestrator.py`, appels `_handle_failure`), aucun code inventé.
  Le pont `Error.Type → onError.code` est PROUVÉ, pas supposé : le bundle CDN
  (`staging-cdn.omni-fi.co/v1/omni-fi-connect.js`, relu le 2026-07-20) n'est qu'un
  relais postMessage sans filtrage (`case ERROR: onError({code: t.code || "UNKNOWN"})`),
  et `LOGIN_FAILED` — qui n'existe QUE comme `Error.Type` — a bien été observé en
  console. Trois messages selon l'ACTION possible : identifiants refusés / délai MFA
  dépassé / panne de la chaîne de récupération (« réessayez **plus tard** », jamais
  « dans un instant » : un `SCRAPER_UI_CHANGE` exige un correctif amont). Nuance
  trouvée en implémentant : `LOGIN_FAILED` couvre AUSSI le 3e code MFA erroné
  (`documentation_api.md`) → le message nomme les deux causes sans dire laquelle.
  `UNKNOWN_ERROR` laissé au repli DÉLIBÉRÉMENT (angle mort visible), verrouillé par un
  test. Couverture : 7 cas dans `tests/unit/omnifi-link-erreur.test.ts`. **Reste
  ouvert** : WIDGET-ERR2 (ces codes ne vivent qu'en console client → invisibles en prod
  sans télémétrie serveur) et WIDGET-ERR3 (canal d'erreur §3.4 : fond + icône).
  **Constat d'origine :** Constaté en sandbox sur « Absa Pro » : la connexion passe le login
  (`link-connect` 201) puis le job de sync bascule sur la branche `↘ FAILED` de la
  machine SyncJob (`docs/documentation_api.md` §Sync Engine) ; le CDN émet
  `onError({ code: "LOGIN_FAILED" })` (**vérifié console 2026-07-16** :
  `[widget Omni-FI] échec LOGIN_FAILED`, `omnifi-link-launcher.tsx:271`). Or
  `LOGIN_FAILED` est ABSENT de `MESSAGES_PAR_CODE` → repli sur `MESSAGE_PAR_DEFAUT`
  (« La connexion bancaire a échoué. Réessayez dans un instant. »). L'utilisateur ne
  sait pas que ce sont ses IDENTIFIANTS : il réessaie à l'identique et échoue en
  boucle. **Fix envisagé** : mapper `LOGIN_FAILED` sur un message actionnable
  non-énumérant (p.ex. « Identifiants bancaires incorrects — vérifiez-les et
  réessayez. ») ET auditer les autres codes terminaux du Sync Engine (scraper/timeout)
  pour ne pas laisser d'angle mort ; garder la branche par défaut OBLIGATOIRE (le CDN
  ment sur l'union de types, cf. JSDoc `messageErreurWidget`). Ne JAMAIS afficher/logger
  le `message` amont (anglais, PII bancaire possible — règle 8) : on mappe le CODE.
  **Rappel sandbox** : seuls `sandbox@example.com` / `sandbox.mfa@example.com` sont
  acceptés — un mauvais login y est attendu (mais le message doit quand même être juste).
  Recoupe **WIDGET-ERR2** (ces codes ne sont visibles qu'en console client → invisibles
  en prod sans télémétrie serveur) et **WIDGET-ERR3** (le canal d'erreur doit aussi
  respecter §3.4 : fond + icône). **Déclencheur** : avant la démo BOM Innov8, OU prochain
  passage sur `/banques`.

### Epic 8 — Intelligence Métier (interview Accountant Omnicane/OL, 2026-06-11)
- [ ] **FEAT-8.1 Moteur de catégorisation auto (Nature/Sous-nature + score de
  confiance)** — Effort M. Priorité `USER_RULE > SYSTEM_RULE > ML_FALLBACK` ; le
  score pilote l'application silencieuse vs la file de revue manuelle ; surcharge
  manuelle = audit immuable + nouvelle USER_RULE. Dépend de : transactions_cache
  alimenté (semaines 3-5).
- [ ] **FEAT-8.2 Dettes & Échéanciers (saisie manuelle)** — Effort M. Emprunts +
  conditions (montant/taux/durée/échéancier), projections de décaissement dans la
  courbe prévisionnelle. Source manuelle au MVP ; `/debt/*` API en automatisation
  ultérieure.
- [ ] **FEAT-8.3 Alertes proactives** — Effort M. (a) liquidités dormantes (solde
  excédentaire stagnant, seuil/durée configurables) ; (b) frais bancaires anormaux
  (écart vs moyenne historique de catégorie, cf. `CategoryAnomalies`). Dashboard +
  email, jamais d'action automatique.


- [ ] **FEAT-3.2 Matrice de flux pivot (Accordion Pivot Table)** — Effort M (CC: ~2j).
  Différé au gate CEO, confirmé par D3 (2026-06-11). Dépend de : Epic 3.1 livré,
  catégories exploitables (Epic 2). Contexte : analyse croisée mensuelle pour DAF.
  Acquis réutilisable : spec UI validé (arbitrages A1-A8, top-nav, tokens @theme,
  centimes entiers) — `~/.gstack/projects/tygr-app/specs/20260611-155303-91653-prototype-ui-s2-app-shell-matrice-flux-mockee.md`.
- [ ] **SSO groupe (Entra ID / Google)** — Effort S (CC: ~2h). Provider Auth.js
  additionnel, zéro refonte (architecture JWT prête). Dépend de : réponse Open
  Question 2 (IdP du groupe). Pré-requis pour l'onboarding à grande échelle.
- [ ] **SSE pour le panneau audit** — Effort S (CC: ~3h). Remplace le polling E17.
  Améliore la scène signature (latence perçue). Dépend de : MVP shippé.
- [ ] **Workspace de consolidation (vue holding cross-workspace)** — Effort M-L.
  Statut selon décision T-C2 du gate final. Le besoin n°1 probable du DAF groupe ;
  modèle de permission read-only cross-tenant à concevoir AVANT tout build.
  Ne contredit pas l'isolation : la démontre (membership explicite).

### Gap Analysis — capacités Omni-FI inexploitées (état des lieux 2026-06-23)

> Issue de l'audit « état des lieux » (Staff Engineer, 2026-06-23) — voir
> `docs/CARTOGRAPHIE-EXISTANT.md` §6. **Trous dans la raquette** pour le persona
> Financial Manager multi-BU : des capacités que l'API Omni-FI FOURNIT
> (`docs/documentation_api.md`) mais que TYGR ne consomme pas encore. Les écarts déjà
> tracés ailleurs ne sont PAS re-dupliqués ici — ils sont **raccrochés** en fin de
> section. Aucune de ces dettes ne touche l'isolation tenant / l'append-only / les
> montants (sinon INTERDITE, règle 9) : ce sont des fonctionnalités absentes.

- [ ] **GAP-WEBHOOK1 (P1, FRONTIÈRE BACKEND) — ingestion pilotée par webhook Omni-FI absente** —
  Effort L, gardien Backend. Ouvert 2026-06-23. Le cahier des charges v2.1 (§1, §2.4,
  FEAT-1.2) fait du **webhook HMAC SHA-256** le cœur de l'architecture d'ingestion
  (résolution `connection → workspace_id` via `tygr_service`, dédup `omnifi_event_id`,
  quarantaine `webhook_events_pending`, enqueue Inngest). Or **aucune route
  `/api/webhooks/omnifi` n'existe** (`src/app/api/` ne contient que `auth/`), et l'API
  expose pourtant toute la surface nécessaire (`PUT /dev/webhooks/config` →
  `WebhookSecret`, `POST /dev/webhooks/rotate-secret`, `POST /dev/webhooks/test`, 13+
  `EventType` dont `sync.completed`/`sync.failed`/`sync.mfa_required`). Conséquence
  métier : la synchro ne se déclenche JAMAIS d'elle-même (cf. `DASH-AUTOSYNC1`). **À
  concevoir dans un chantier dédié** (réception HMAC constant-time + dédup +
  quarantaine + worker) — PAS dans une PR de feature ; surface sécurité (HMAC,
  `tygr_service`) → cross-review obligatoire. **Déclencheur** : DÛ pour un MVP
  production avec fraîcheur de données (sinon données figées entre clics manuels) ;
  pré-requis du runbook de déploiement (config webhook = secret distinct sandbox/prod).
  Complète `DASH-AUTOSYNC1` (piste b) côté push ; le cron (piste a) reste l'alternative
  pull si le push amont n'est pas fiable en sandbox.

- [ ] **[P2] - [TECH-API-INSIGHTS] - Intégration `/insights/cashflow` et `/insights/vendors`** —
  Effort M, gardien Backend. Ouvert 2026-06-23 (ex-`GAP-INSIGHTS1`, renommé 2026-06-23). L'API livre clé en main
  `CashflowRibbon`, `TopVendors`, `CategorySummary`, **`CategoryAnomalies`**,
  `RecurringPayments`, `IncomeInsights`, `Alerts` — qui couvrent **directement
  FEAT-8.3** (alertes : liquidités dormantes, frais bancaires anormaux) et enrichissent
  FEAT-3.1, **sans moteur d'analyse interne à écrire**. TYGR ne consomme aujourd'hui
  aucun endpoint `insights`. Décision d'architecture à poser (le pushback de la règle
  10) : **consommer l'amont** (rapide, mais couple TYGR à la qualité analytique
  Omni-FI et au `clientUserId`) **vs. recalculer en interne** (maîtrise, mais réécrit ce
  qui existe). **Déclencheur** : ouverture du chantier Epic 8.3 (alertes) OU demande
  produit « anomalies de frais ». **Raccroché à FEAT-8.3** (ne pas livrer 8.3 sans
  trancher cette option d'abord).

- [ ] **[P3] - [TECH-API-DEBT] - Module Debt Profiling (`/dashboard/debt`, `/debt/exposure/*`, `/debt/.../repayment`)** —
  Effort M-L, gardien Backend. Ouvert 2026-06-23 (ex-`GAP-DEBT1`, renommé + redescendu P2→P3
  le 2026-06-23 pour s'aligner sur `FEAT-3.3` déjà en P3 ; aucun écran dette n'existe, c'est un
  chantier neuf à cadrer en spec dédiée, pas une dette d'un existant). **FEAT-3.3 (mur de la dette)** et une
  partie de **FEAT-8.2 (échéanciers)** sont disponibles amont sans saisie manuelle :
  `TotalDebt`/`UtilizationRate`, instruments (taux, `NextPaymentDate`/`NextPaymentAmount`,
  `IsOverdue`, `MinimumPaymentAmount`), exposition par institution/devise, et
  **prédiction de remboursement** (`/debt/accounts/{id}/repayment`) qui alimenterait la
  courbe prévisionnelle. Le cahier des charges prévoyait la dette en **saisie manuelle**
  au MVP (FEAT-8.2) — cette dette ouvre l'**alternative API** (moins de saisie, dépend de
  `PartyId` et de la fiabilité sandbox des endpoints debt). **Déclencheur** : ouverture du
  chantier FEAT-3.3/8.2 OU preuve sandbox que `/debt/*` est peuplé. **Raccroché à
  FEAT-3.3 (P3) et FEAT-8.2 (P2)** — re-prioriser ces deux entrées si l'API debt est
  retenue comme source.

- [x] **[P1] - [TECH-API-TRACE] - Capture des métadonnées de classification (`ConfidenceLevel`, `ClassificationSource`, `RuleIdMatch`)** —
  ✅ **LIVRÉ & MERGÉ 2026-06-24 (PR #110)** : migration `0012_classification-metadata` (3 colonnes
  varchar(120) nullable, expand-only, SANS CHECK — résilience aux nouveautés API ; écrite à la main +
  journal idx 12 car DB-MIGRATE3 ; héritage partitions vérifié) + `TransactionAUpserter`/`upsertTransactions`
  (INSERT + onConflict) + `versLignePersistee` (mapping via `chaineOuNull`, indépendant de `categorieValide`,
  `"Low"` conservé). Pas de backfill (acté). Pré-requis de `GAP-CATEG-NATIVE1` désormais satisfait.
  Effort S, **gardien Backend** (tâche ATOMIQUE assignable sans collision — touche uniquement la
  couche ingestion + le schéma, zéro surface Front). Ouvert 2026-06-23 (scindé de
  `GAP-CATEG-NATIVE1` le 2026-06-23 : c'en est la première brique, isolée pour être livrable seule).
  **Le fait, prouvé** : le bloc `Enrichment{}` (`server/omnifi/types.ts:94`) porte 6 champs ; on en
  mappe 3 (`CleanMerchantName`/`PrimaryCategory`/`SubCategory` via `versLignePersistee`,
  `orchestrateur.ts:76-94`) et on **JETTE** `ConfidenceLevel`, `ClassificationSource`, `RuleIdMatch` —
  reçus du payload mais aucune colonne en base (`transactions_cache` n'a que `clean_label`/
  `primary_category`/`sub_category`, `schema.ts:372-374`). Même pathologie que le bug `Enrichment`
  imbriqué (PR #101) : la donnée arrive et est perdue. **Valeur** : distinguer une auto-catégo
  fiable d'une douteuse + tracer la source (`USER_RULE>SYSTEM_RULE>ML`), exigée par la roadmap
  (traçabilité MANUAL/RULE) — prolongement direct du fix PR #101, ratio valeur/effort imbattable.
  **À faire (Back uniquement)** : (1) migration expand `transactions_cache` (+ `confidence_level`,
  `classification_source`, `rule_id_match`, varchar nullable, expand-safe — table partitionnée
  append-only, donc colonnes ADD only, jamais de DROP) ; (2) étendre `TransactionAUpserter`
  (`repositories/ingestion.ts:42`) + le SET du `onConflictDoUpdate` (`upsertTransactions`) ;
  (3) mapper les 3 champs dans `versLignePersistee` via `chaineOuNull` (le serializer pose ""
  par défaut — réutiliser la normalisation existante, ne JAMAIS persister "" brut). **NE PAS** y
  inclure l'exposition en lecture/UI ni la file de revue : ça relève de `GAP-CATEG-NATIVE1` (P2,
  ci-dessous). **Déclencheur** : DÛ — première brique de l'exploitation de l'enrichissement amont
  (priorisé P1 le 2026-06-23, gain immédiat, donnée déjà dans le payload). **NON une dette
  d'isolation** ; touche l'append-only en mode expand-only (colonnes additives, aucune suppression).

- [ ] **GAP-CATEG-NATIVE1 (P2) — chaîne de priorité de classification + file de revue (socle FEAT-8.1)** —
  Effort M, gardien Backend. Ouvert 2026-06-23 (**périmètre réduit le 2026-06-23** : la capture des
  champs enrichis amont en est SORTIE → `TECH-API-TRACE` P1, ci-dessus, pré-requis de ce ticket).
  Le moteur de **règles déterministe** (motif→catégorie) est livré (PR #95, `regles-categorisation.ts`)
  — utile, mais ce n'est PAS FEAT-8.1. Une fois `TECH-API-TRACE` livré (les colonnes de confiance/source
  peuplées), restent : (1) la chaîne de priorité `USER_RULE > SYSTEM_RULE > ML_FALLBACK` (doc API
  §Priorité de classification) qui ARBITRE entre la catégo amont, les règles locales et la ventilation
  manuelle ; (2) le **score de confiance** pilotant l'application silencieuse vs une **file de revue
  manuelle** (exposer `confidence_level` en lecture catégorisée, seuil de bascule en file). **Dépend de
  `TECH-API-TRACE`** (sans les colonnes peuplées, pas de score à exploiter). **Déclencheur** : ouverture
  du chantier FEAT-8.1 (Epic 8). **Raccroché à FEAT-8.1** — précise le périmètre « consommer
  l'enrichissement amont avant tout ML interne ».

- [ ] **[P2] - [DECISION-PRODUIT-OVERRIDE] - Arbitrage : moteur de règles LOCAL vs propagation amont (`/transactions/override`)** —
  Effort S (le dev) mais **bloqué sur une DÉCISION produit AVANT tout code** (règle 10),
  gardien Backend (exécution) + PO (arbitrage). Ouvert 2026-06-23 (ex-`GAP-OVERRIDE1`,
  requalifié de dette technique en décision produit le 2026-06-23 : ce n'est pas un correctif
  à planifier mais un choix d'architecture à trancher). **Le fait** : FEAT-2.2 prévoit que la
  correction manuelle « transmette la directive via `POST /accounts/{AccountId}/transactions/override` »,
  or aujourd'hui la ventilation manuelle (`remplacerSplits`, audit append-only) est **purement
  locale** — l'amont Omni-FI ne ré-apprend jamais des corrections, et une re-synchro peut
  ré-imposer une catégorisation auto divergente. **Les deux options à arbitrer** : (A) **garder
  le moteur local comme seule vérité** (maîtrise totale, zéro couplage, mais divergence assumée
  avec la classification Omni-FI sur le même compte) ; (B) **propager** via un appel best-effort
  à l'override amont après chaque split validé (idempotent, sans PII en log, fail-soft — l'échec
  amont ne casse pas la vérité locale) → aligne les deux classifications, au prix d'un couplage
  sortant. **À trancher par le PO** ; l'exécution (option B) est triviale une fois la décision
  prise. **Déclencheur** : retour utilisateur « mes corrections ne tiennent pas après synchro »
  OU industrialisation de la catégorisation (`TECH-API-TRACE` / chaîne de priorité). **NON une
  dette d'isolation** (la vérité locale reste la ventilation manuelle ; l'override est un signal
  sortant).

**Écarts déjà tracés ailleurs (rappel, NON re-dupliqués)** : synchro auto →
`DASH-AUTOSYNC1` (P1) ; UI multi-entités → `ENTITY-UI1` (P2) ; pré-remplissage sas via
Parties → `ENTITY-PARTY1` (P2) ; courbe/soldes EOD sans source amont → constat « Solde
Total dérivé des soldes courants » + dépendance `/balances/history` (404 sandbox) ;
matrice pivot → `FEAT-3.2` (P2) ; import OCR → `FEAT-1.3` (P3). Voir
`docs/CARTOGRAPHIE-EXISTANT.md` §5 pour la correspondance Épiques → état réel complète.

### Chantiers produit P2 (revue PM/Architecture, 2026-06-23)

- [ ] **PROD-I18N-EN1 (P2) — internationalisation anglaise de l'application** —
  Effort L (transverse), gardien Front. Ouvert 2026-06-23. Vital pour la phase finale
  (démo/sales hors francophones). Aujourd'hui 100% des chaînes UI sont en FR en dur
  (interface FR actée, CLAUDE.md). Périmètre : extraction des chaînes, lib i18n (next-intl
  pressenti, Layer 1 — à valider), bascule FR↔EN, et surtout NE PAS internationaliser le
  FORMATAGE financier qui reste piloté par `format-montant.ts`/`format-date.ts` (devise =
  préfixe symbolique, séparateurs ; un changement de locale ne doit pas casser l'espace
  fine insécable ni la virgule décimale). FYGR a un switch de langue (drapeau, captures) —
  parité attendue. **Déclencheur** : préparation de la démo finale / premier prospect
  anglophone. **Raccroché à la phase de polissage pré-démo** (jamais « un jour »).

- [ ] **PROD-GRAPHS-FYGR1 (P2) — aligner/challenger les graphiques sur FYGR (donut + barres + analyse catégorie)** —
  Effort M, gardien Front + Backend. Ouvert 2026-06-23. FYGR expose un donut « analyse
  par catégorie » + des barres mensuelles par catégorie + un moteur de formules cash-flow
  (captures `docs/benchmarks/FYGR/2_graphics/`). L'API Omni-FI fournit CLÉ EN MAIN
  `CategorySummary`, `TopVendors`, `CashflowRibbon`, `CategoryAnomalies` (endpoint
  `/insights`) — qu'on ne consomme pas. **Décision d'architecture à poser AVANT build
  (règle 10) : consommer l'amont (rapide, couple TYGR à la qualité analytique Omni-FI +
  `clientUserId`) vs recalculer en interne (maîtrise, réécrit l'existant).** Le moteur de
  formules custom FYGR est hors MVP (raccrocher à FEAT-3.2 pivot). **Recoupe directement
  `TECH-API-INSIGHTS`** — PROD-GRAPHS-FYGR1 en est le volet VISUALISATION ; ne pas livrer sans
  trancher l'option insights d'abord. **Déclencheur** : ouverture Epic 8.3 OU demande
  produit « graphiques comme FYGR ». **Raccroché à TECH-API-INSIGHTS + FEAT-3.2.**

### Dette UI + tests relevée en cross-review PROD-MERCHANT1 (2026-06-23)

> Issue de la revue QA/cross-review indépendante du commit `4da3411` (branche
> `feat/prod-merchant-1`, ticket PROD-MERCHANT1). Constats C1 et C2 NON bloquants ;
> divergence et absence de test ASSUMÉES temporairement par le PO pour ne pas retarder
> une release à forte valeur métier (affichage marchand + repli élégant). Aucune de ces
> dettes ne touche l'isolation tenant / l'append-only / les montants (sinon INTERDITE,
> règle 9) : ce sont du polissage d'affichage et de la couverture de test.

- [ ] **TECH-MERCHANT-POLISH1 (P2) — unifier l'affichage de la catégorie OBIE par défaut + tester `traduireCategorieBanque`** —
  Effort S, gardien Front. Ouvert 2026-06-23. Regroupe deux constats de cross-review :
  **(C1)** le Dashboard (`transactions-table.tsx:60`) affiche `categorieFr(t.primaryCategory)`
  qui retombe TOUJOURS sur « Non catégorisé » par défaut, alors que la table /transactions
  (`adapter.ts:93` → `traduireCategorieBanque`) renvoie `null` (sous-texte masqué) quand la
  catégorie est absente/non cartographiée — même donnée OBIE, deux rendus. **(C2)** la
  fonction `traduireCategorieBanque` (`adapter.ts:130`) porte une logique conditionnelle
  non triviale (rejet du défaut vers `null`) sans aucun test unitaire (exit-criteria règle 3 :
  chemin heureux + cartographié + absent/non-cartographié). **Déclencheur** : lors du chantier
  de refonte globale UX/UI ou lors du prochain grand refactor des tableaux de données.

### Dettes ouvertes par L8b-1 (sélecteur de périmètre, 2026-06-30)

Relevées en cross-review de `feat/l8b1-perimetre-switcher` (constats #2/#3/#5,
confiance ≤5/10 — nettoyages, non bloquants). Le câblage sécurité (intersection
serveur RLS, fail-closed) est sain ; ces entrées sont de la réutilisation/efficacité.

- [ ] **UI-CN-DEDUP1 (P2) — extraire le helper `cn` local dans `src/lib/cn.ts`.**
  `cn(...)` est redéfini à l'identique dans `components/shell/perimetre-switcher.tsx`
  et `components/ui/category/category-picker.tsx` (2 copies verbatim ; `workspace-switcher.tsx`
  n'en utilise pas, incohérence préexistante). Toujours zéro dépendance externe (règle 9
  respectée — ce n'est PAS clsx). **Déclencheur** : 3e réutilisation du pattern, OU adoption
  future de `clsx`/`cva`. **Effort** : S.

- [ ] **UI-POPOVER-HOOK1 (P2) — factoriser la mécanique popover (clic-extérieur mousedown
  + Échap capture + focus auto rAF) dans un hook partagé `usePopoverDismiss`.** Réimplémentée
  mot pour mot dans `perimetre-switcher.tsx` et `category-picker.tsx:81-114`. Divergence déjà
  constatée : le `stopImmediatePropagation` du CategoryPicker (Échap qui ne ferme pas une
  modale parente) n'est PAS reporté dans le switcher (simple `stopPropagation`) — bénin tant
  que le switcher reste hors modale (header). **Déclencheur** : 3e popover, OU besoin de monter
  le switcher dans une modale. **Effort** : M.

- [ ] **PERF-LISTERCOMPTES-CACHE1 (P2) — mémoïser `listerComptes` par requête via `React.cache`.**
  Sur le dashboard, `listerComptes` tourne 2× par rendu : `(workspace)/layout.tsx` (pour le
  sélecteur de périmètre) ET `(dashboard)/page.tsx` (pour les cartes), dans deux `withWorkspace`
  distincts (RSC ne partagent pas de transaction). Lecture indexée légère, mais redondante.
  `React.cache(listerComptes)` dédoublonnerait sur un même rendu. **Déclencheur** : profilage
  du TTFB dashboard, OU passage de `listerComptes` à une lecture coûteuse. **Effort** : S.

## P3 — plus tard

- [ ] **FEAT-3.3 Console mur de la dette** — endpoints `/debt/*` disponibles côté API.
- [ ] **FEAT-1.3 Import OCR PDF/CSV** — flux Document Upload documenté côté API.
- [ ] **Epics 2, 4, 5, 6, 7** — différés intégralement ; le schéma v2.1 les anticipe
  (catégories en cache, workspaces multi-devises).
- [ ] **Onboarding self-service + billing SaaS externe** — dépend de la décision
  T-C3 (conflit de canal) ; aucune migration de schéma requise.
- [ ] **Réévaluer bases séparées par tenant (C2)** — si une exigence de conformité
  client externe l'impose (taste T1 du gate : RLS partagée retenue au MVP).

### Webhook Omni-FI — lots W3 + W4 LIVRÉS (branche `feat/webhook-ingestion`, 2026-07-23)

Réf. `docs/specs/PLAN-webhook-ingestion.md`, runbook `docs/RUNBOOK-webhook-enrolement.md`.
**`GAP-WEBHOOK1`** (P1, l.3762) et **`WEBHOOK-TENANT-FIRST1`** (P1, l.3013) sont désormais
SUBSTANTIELLEMENT adressés : route `POST /api/webhooks/omnifi` (HMAC-SHA256 constant-time
sur octets bruts, fenêtre de fraîcheur, zod strict, résolution tenant fail-closed sous
`tygr_service`, cross-check env, idempotence 3 étages, quarantaine, 202 uniforme). Ne PAS
les clore tant que W5 (rejeu) et W2 (filet pull) ne sont pas livrés. Décisions actées :
D1 (cross-check env sous tygr_app, D2-parent annulée), D2 (`cleIdempotence`), D3 (enqueue
AVANT audit), D4 (fenêtre 12 h).

Dette DIFFÉRÉE (à traiter à un chantier nommé) :

- [ ] **WEBHOOK-W5 (P1, effort ~1 j) — rejeu de la quarantaine.** `webhook_events_pending`
  s'accumule sans être rejoué (visible en base/log, jamais silencieux). Livrer : enqueue
  `omnifi/webhook.replay.requested` au `link-exchange` + cron filet + purge TTL 30 j avec
  log d'abandon. **Déclencheur** : immédiat (le webhook est en prod sans rejeu).
- [ ] **WEBHOOK-W2 (P1) — cron 06:00 MUT + `sync_runs`.** SANS lui, le webhook n'a AUCUN
  filet pull : un événement perdu (enqueue échoué, secret en rotation, déploiement) ne se
  rattrape que par un clic manuel. Recommandé avant/en parallèle d'un usage prod réel.
- [ ] **WEBHOOK-FENETRE1 (P2, effort ~0,25 j) — resserrer la fenêtre de fraîcheur.**
  Fixée à 12 h (≤ idempotence Inngest 24 h, vérifiée). La resserrer à 10-15 min dès que la
  **politique de retry amont (D4-b)** est connue. Constante `FENETRE_FRAICHEUR_MS`
  (`src/server/webhooks/omnifi/fraicheur.ts`), testée.
- [ ] **WEBHOOK-D4 (P2) — questions amont à confirmer (Etienne → Omni-FI).** (a) l'amont
  émet-il au-delà du mock `POST /dev/webhooks/test` ? (b) politique de retry sur non-2xx
  (dimensionne la fenêtre) ? (c) `Payload{}` porte-t-il des champs utiles ? (d) plage d'IP
  source stable (→ allowlist défense en profondeur, §4.3) + préfixe `sha256=` sur le
  header (déjà absorbé défensivement) ?
- [ ] **WEBHOOK-MIGRATION-NUM (P2, hygiène) — numéro de migration.** Le plan §7.1/§12
  écrivait `0025` ; livré en **`0026`** (0025 réservé à treso-eod ; 0024 dernière
  existante). ⚠️ **Ne JAMAIS réutiliser 0019** (déjà prise, `0019_echeances`). Trou d'idx
  25 dans `_journal.json` (comblé au merge de treso-eod) : la suite de cohérence l'accepte
  (égalité d'ensembles, pas contiguïté).
- [ ] **WEBHOOK-SNAPSHOT-0026 (P2, hygiène Drizzle) — snapshot manquant.** `0026` a été
  hand-write (comme 0020/0021/0024, sans `meta/0026_snapshot.json`). Un futur `db:generate`
  diffe contre le dernier snapshot présent (0023) et pourrait ré-émettre
  `webhook_events_pending`. **Déclencheur** : prochain `db:generate` — régénérer proprement
  les snapshots ou ajouter 0026.
- [ ] **WEBHOOK-LIMIT2-CONTRACT (P2) — test de multiplicité.** La garde SQL `LIMIT 2`
  (résolution ambiguë) n'est exerçable qu'au CONTRACT (retrait de l'unique GLOBALE de
  `omnifi_connection_id`, 0018→CONTRACT) : impossible de seeder 2 lignes pour une clé
  aujourd'hui. La DÉCISION est couverte par le test unitaire pur ; ajouter le test
  d'intégration 2-tenants au CONTRACT.
- [ ] **WEBHOOK-ROTATION-SECRET (P2) — double validité amont.** `rotate-secret` invalide
  l'ancien immédiatement → trou de 401 entre rotation et redéploiement (rattrapé par W2).
  Demander à Omni-FI une fenêtre de double validité (D4). Runbook §5 documente la procédure
  provisoire.
- [ ] **WEBHOOK-RL-MULTIINSTANCE (P3) — rate-limit par instance.** Le seau glissant est en
  mémoire du process (approximatif en multi-instances). Ce n'est PAS le contrôle d'accès
  (c'est l'HMAC), il ne borne que le coût. La mémoire est désormais BORNÉE (balayage des
  buckets périmés au-delà de `MAX_BUCKETS`, constat cross-review W4 C1). À reconsidérer si
  déploiement multi-instances + besoin d'une garantie globale (store partagé).
- [ ] **WEBHOOK-RL-XFF (P3) — IP source de confiance.** `extraireIp` prend la valeur la
  plus À GAUCHE de `x-forwarded-for` ; selon la config edge (Vercel/ALB peuvent AJOUTER
  l'IP réelle en fin de chaîne), un attaquant peut prépender un XFF factice rotatif et
  contourner le plafond par IP. Toléré car (a) ce n'est PAS le contrôle d'accès (HMAC) et
  (b) la mémoire est bornée. À durcir si la plateforme de déploiement expose une position
  d'IP fiable (index depuis la fin, ou en-tête plateforme dédié) — vaut aussi pour le
  rate-limit login (`src/server/auth/rate-limit-ip.ts`, fonction PARTAGÉE : ne pas la
  diverger sans re-valider le login).
