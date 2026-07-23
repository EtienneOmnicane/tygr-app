# PLAN — Durcissement de l'ingestion webhook Omni-FI (`POST /api/webhooks/omnifi`)

> **Phase : CONCEPTION (règle 1)** — zéro ligne de code applicatif dans cette PR.
> Rédigé le **2026-07-23**, branche `plan/webhook-ingestion`.
>
> **Plan parent (à NE PAS dupliquer)** : `PLAN-ingestion-webhook-omnifi.md` (PR #217,
> décisions D1=C / D2 / D3 / D4 actées le 2026-07-17). Le présent document est le plan
> d'exécution du **reste** : lots **W3 (rôle `tygr_service`)** et **W4 (route HMAC +
> idempotence + résolution tenant)**, plus l'amorce **W5 (rejeu)**. Il **corrige** trois
> points du plan parent, chacun sur un fait vérifié dans le code (§1) et signalé ⚠️.
>
> **Rattachements TODOS** : `GAP-WEBHOOK1` (P1, l.3762) · `WEBHOOK-TENANT-FIRST1` (P1,
> l.3013) · `DASH-AUTOSYNC1` (P1, l.2606) · contract unique-composites (l.3004).
> Cahier des charges v2.1 : §2.4 (ordre de traitement), §4.1, §4.3.
>
> **Surface de sécurité (HMAC + rôle de service + route non authentifiée par session)
> ⇒ cross-review obligatoire à chaque lot d'implémentation** (règle 6), avec mandat
> explicite gravé en §11.4.

---

## 0. Périmètre : ce qui est déjà posé, ce qui reste

### 0.1 Déjà livré — NE RIEN REPLANIFIER (lot W1, PR #220, vérifié sur `main` le 2026-07-23)

| Brique | Emplacement | Ce que ça donne au webhook |
|---|---|---|
| Client + événements typés | `src/server/inngest/client.ts` | `evenementSyncIngest` existe, **`"WEBHOOK"` est déjà dans `declencheursSync`** (l.36) et `omnifiEventId` est déjà dans le schéma de l'événement (l.72) : **le worker n'a rien à changer** pour accueillir le webhook |
| Worker durable | `src/server/inngest/fonctions/sync-ingest.ts:282-290` | `concurrency: [{ key: "event.data.omnifiConnectionId", limit: 1 }]`, `retries: 3`, re-validation zod à la réception, résolution tenant-first sous RLS, ingestion idempotente |
| Primitive système | `src/server/db/systeme.ts` | `executerPourWorkspaceSysteme(workspaceId)` : transaction `tygr_app` + garde owner C6 + GUC tenant, sans session ni membership |
| Route d'exécution | `src/app/api/inngest/route.ts` + `src/proxy.ts` | précédent **exact** d'une route hors session : exclusion du matcher + auth par signature |
| Émission fail-soft | `src/server/inngest/emission.ts` | `demanderIngestionSync()` — réutilisable, mais **pas telle quelle** côté webhook (§6.3) |
| Frontière ESLint | `eslint.config.mjs:47-60`, `:107-109`, `:119-121` | `FRONTIERE_SYSTEME` (3 globs prouvés) — à **élargir précisément**, pas à contourner (§8.1) |

### 0.2 Périmètre du présent plan

- **W3** — rôle `tygr_service` : provisioning, policy RLS dédiée, GRANT column-level, client DB séparé, garde runtime, frontière d'import, suite d'isolation.
- **W4** — route `POST /api/webhooks/omnifi` : gardes transport, rate-limit, HMAC + fenêtre anti-replay, zod strict, résolution tenant fail-closed, idempotence 3 étages, audit, enqueue, quarantaine.
- **W5** — rejeu de la quarantaine (lot suivant, interface figée ici).

### 0.3 Hors périmètre (et pourquoi c'est important de le dire)

- **W2 (cron 06:00 MUT + `sync_runs`) N'EST PAS LIVRÉ** (vérifié : zéro occurrence de `sync_runs` hors commentaires). Conséquence à assumer explicitement : **tant que W2 n'existe pas, le webhook n'a AUCUN filet pull**. Un événement perdu (enqueue en échec, secret en rotation, déploiement) ne se rattrape que par un clic manuel. Cela ne bloque pas W3/W4 — mais cela **change le dimensionnement de la fenêtre anti-replay** (§3.4) et **interdit de considérer la quarantaine comme facultative** (§5.5). Recommandation d'ordonnancement : W2 avant ou en parallèle de W4.
- Curseur `/transactions/sync` amont, insights, UI MFA, `SYNC-INCOMPLET-DURABLE1` : inchangés (plan parent §11).

---

## 1. Faits vérifiés le 2026-07-23 (code réel, pas le brief)

Chaque fait ci-dessous a été lu dans le dépôt à cette date. Trois d'entre eux **invalident ou améliorent** le plan parent.

1. **`bank_connections`** (`src/server/db/schema.ts:237`) : RLS `ENABLE` + **`FORCE`** (`drizzle/migrations/0003_epic3-financial-core.sql:38,95`), **une seule policy** `tenant_isolation` `AS PERMISSIVE FOR ALL TO public` (l.91). **Aucune policy RESTRICTIVE** sur cette table à ce jour ⇒ une policy PERMISSIVE dédiée `TO tygr_service` s'OR-era proprement (§5.2). *Invariant à graver : si une RESTRICTIVE arrive un jour sur `bank_connections`, elle AND-era et cassera la résolution en silence → test de non-régression obligatoire.*
2. **`omnifi_connection_id`** : l'unique **globale** est **toujours en place** (`schema.ts:259-261`, `.unique()` inline) à côté du composite `(workspace_id, omnifi_connection_id)` (0018 EXPAND). L'ambiguïté est donc **impossible aujourd'hui** et **deviendra possible** au CONTRACT.
3. ⚠️ **Correction de numérotation** : le plan parent et TODOS (l.3004, l.3013) appellent la migration de CONTRACT « `0019` ». **`0019` est prise** (`drizzle/migrations/0019_echeances.sql`) ; le dernier numéro est **`0024`**. Le contract sera **`0026`+ selon l'ordre de livraison**, jamais `0019`. À corriger dans TODOS au lot W4 (piège connu : une migration hors journal Drizzle collisionne au `db:generate`).
4. ⚠️ **`workspaces` n'a PAS de RLS** (`schema.ts:48-75` : ni `.enableRLS()`, ni `pgPolicy`, ni `ALTER TABLE … ROW LEVEL SECURITY` dans les migrations). La colonne `omnifi_environment` existe (`schema.ts:58`, CHECK `IN ('sandbox','production')`). **Conséquence décisive : le cross-check d'environnement se lit très bien sous `tygr_app`, APRÈS résolution du tenant — la décision D2 du plan parent (élargir `tygr_service` à `workspaces`) devient INUTILE** (§5.3). C'est un gain net de moindre privilège, et c'est aligné sur la contrainte « ne JAMAIS élargir ce périmètre ».
5. ⚠️ **`webhook_events_pending` ne sera PAS « deny-by-default » pour `tygr_app` toute seule**, contrairement à ce qu'écrit le plan parent §4.1. `drizzle/provisioning/tygr_app.sql:57` fait `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO tygr_app` **et** `:65` `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE ON TABLES TO tygr_app` : **toute table FUTURE naît accessible à `tygr_app`**. Il faut un **REVOKE explicite** (+ RLS sans policy pour `tygr_app`) — deux gardes complémentaires (§7.2).
6. **`audit_events`** (`schema.ts:1366`) : `omnifi_event_id varchar(64)` nullable, `hmac_signature_truncated varchar(8)`, unique **composite** `(workspace_id, omnifi_event_id)`, RLS tenant, append-only strict. **Prêt pour la dédup post-résolution, aucune migration.**
7. **`consigner()`** (`src/server/repositories/audit.ts:258`) écrit `omnifiEventId: null` **en dur** et valide `eventType` contre une liste **fermée** d'événements applicatifs ⇒ **une fonction d'écriture dédiée au webhook est nécessaire** dans ce même repository (seul écrivain autorisé), avec sa propre liste blanche de payload (§7.3).
8. **`tygr_service` n'existe toujours nulle part** (zéro occurrence hors commentaires dans `drizzle/`, `scripts/`, `src/`).
9. **Rate-limit existant réutilisable en MÉCANIQUE, pas en STOCKAGE** : `src/server/auth/rate-limit-ip.ts` est un module de fonctions **pures** (`debutFenetre`, `depasseLimiteIp`, `extraireIp`) ; le comptage vit en table `login_attempts`. Sur une route publique non authentifiée, compter en base **écrirait une ligne par requête non signée** = amplification de DoS (§4).
10. **Contrat amont** (`docs/documentation_api.md`, § Webhooks) : header `x-omnifi-signature` = `HMAC-SHA256(body_bytes, WebhookSecret)` **hex** ; body `{ EventId, EventType, ConnectionId, JobId, Timestamp, Payload{} }` ; **aucun `ClientUserId`** ; 12 `EventType` avec avertissement « tous les scrapers n'émettent pas chaque événement » ⇒ **union ouverte** ; `WebhookSecret` retourné **une seule fois** ; `POST /dev/webhooks/rotate-secret` invalide l'ancien **immédiatement**.
11. **Le SDK Inngest v4 expose bien `idempotency`** (`node_modules/inngest/components/InngestFunction.d.ts:166-170` : « Allow the specification of an idempotency key using event data… overrides the `rateLimit` object »), ainsi que `rateLimit` et `throttle`. **La DURÉE de la fenêtre d'idempotence n'est pas dans les typings** → à vérifier contre la doc du SDK **à l'implémentation** (§6.2), pas à supposer.

### 1.1 Restant à prouver au runtime (questions D4 routées à Omni-FI par Etienne, plan parent §10)

(a) l'amont émet-il réellement au-delà du mock `POST /dev/webhooks/test` ? (b) **politique de retry sur non-2xx** (dimensionne §3.4 et §6.3) ; (c) `Payload{}` porte-t-il des champs utiles non documentés ? — **(d) NOUVEAU : existe-t-il une plage d'IP source stable** (permettrait une allowlist en défense de profondeur, §4.3) **et le header porte-t-il un préfixe (`sha256=…`) ?** (à absorber défensivement de toute façon, §3.2).

---

## 2. Pipeline de la route — ordre, et un seul code de succès

```
POST /api/webhooks/omnifi        runtime = "nodejs"  ·  dynamic = "force-dynamic"
                                 EXCLUE du matcher de src/proxy.ts (sinon 307 → /login)
 │
 ├─ (0) Transport     méthode ≠ POST → 405 · content-length ou octets lus > 64 Ko → 413
 │                    secret absent pour l'env courant → 503 WEBHOOK_NON_CONFIGURE
 ├─ (1) Rate-limit    seau glissant EN MÉMOIRE par IP, AVANT tout calcul → 429   (§4)
 ├─ (2) HMAC          sur les OCTETS BRUTS (arrayBuffer), comparaison constant-time
 │                    échec → 401 · AUCUN écrit DB, aucun parse JSON avant ce point (§3)
 ├─ (3) zod strict    body malformé → 400 WEBHOOK_PAYLOAD_INVALIDE                (§3.5)
 ├─ (4) Fraîcheur     |now − Timestamp| > fenêtre → 400 WEBHOOK_HORS_FENETRE      (§3.4)
 ├─ (5) Résolution    SELECT 3 colonnes sous tygr_service (LIMIT 2)               (§5)
 │        ├─ 0 ligne      → quarantaine (motif CONNEXION_INCONNUE)      → 202
 │        └─ ≥ 2 lignes   → quarantaine (motif AMBIGUE) + alerte        → 202
 ├─ (6) Cross-check   sous tygr_app + GUC tenant : workspaces.omnifi_environment
 │        env          ≠ env du déploiement → quarantaine (ENV_MISMATCH) + alerte → 202
 ├─ (7) Enqueue       Inngest, clé d'idempotence explicite                        (§6)
 ├─ (8) Audit         INSERT audit_events ON CONFLICT (workspace_id, omnifi_event_id)
 │                    DO NOTHING — trace + 2ᵉ étage de dédup                      (§6.2)
 └─ (9) 202 Accepted  toujours, quel que soit le sort interne                     (§2.1)
```

### 2.1 Un seul code de succès : 202 — et pourquoi (règle 3, messages non-énumérants)

Traité, dédupliqué, mis en quarantaine, refusé pour ambiguïté ou mismatch d'environnement : **tous répondent `202` avec un corps vide**. Le plan parent distinguait 200 (rejeu) de 202 (accepté) : c'est un **oracle inutile** (il renseigne sur l'état interne un porteur du secret, et surtout il crée une asymétrie observable qu'aucun consommateur légitime n'exploite — l'amont ne fait rien de la nuance). Une seule sortie ⇒ rien à énumérer, et un test d'observabilité trivialement vérifiable.

Le **diagnostic** vit dans les logs corrélés (§9.2), pas dans la réponse HTTP.

### 2.2 Réponses d'échec (avant acceptation)

| Situation | Code | Corps | Erreur nommée |
|---|---|---|---|
| Méthode ≠ POST | 405 | vide | — |
| Corps > 64 Ko | 413 | vide | `WEBHOOK_TROP_VOLUMINEUX` |
| Rate-limit dépassé | 429 | vide (+ `Retry-After`) | `WEBHOOK_TROP_DE_REQUETES` |
| Signature absente / invalide / mal formée | 401 | vide | `WEBHOOK_SIGNATURE_INVALIDE` |
| Body non conforme au schéma | 400 | vide | `WEBHOOK_PAYLOAD_INVALIDE` |
| `Timestamp` hors fenêtre | 400 | vide | `WEBHOOK_HORS_FENETRE` |
| Aucun secret configuré | 503 | vide | `WEBHOOK_NON_CONFIGURE` |
| Échec d'enqueue ou d'audit | 500 | vide | `WEBHOOK_ENQUEUE_ECHEC` / `WEBHOOK_AUDIT_ECHEC` |

**Corps vides partout** : jamais de message, jamais de `cause`, jamais d'écho du payload. Le code d'erreur nommé vit dans le log et dans le nom de la classe d'erreur — pas sur le fil.

---

## 3. Vérification HMAC

### 3.1 Octets bruts, jamais un JSON re-sérialisé

`const octets = Buffer.from(await request.arrayBuffer())` **avant tout parse**. L'HMAC se calcule sur ces octets exacts ; `JSON.parse` puis `JSON.stringify` change les octets (ordre des clés, échappements, espaces) et casse la signature. Le parse zod se fait **ensuite**, sur `octets.toString("utf8")`.

La borne de taille se vérifie **deux fois** : `content-length` s'il est présent (rejet précoce, coût nul), puis `octets.byteLength` (un `content-length` menteur ne passe pas).

### 3.2 Extraction et normalisation de l'en-tête

- En-tête : `x-omnifi-signature`. Absent → 401 immédiat.
- Tolérance défensive : préfixe `sha256=` accepté et retiré (le contrat amont dit « hex nu », mais c'est la variante la plus courante et la tolérance ne coûte rien ; question (d) de §1.1).
- Validation stricte avant toute crypto : `/^[0-9a-fA-F]{64}$/`. Non conforme → 401 **sans** `timingSafeEqual` (qui lève sur longueurs inégales ; la longueur d'un HMAC est publique, aucune fuite).

### 3.3 Sélection du secret — **un seul secret par déploiement** (simplification vs plan parent)

Le plan parent calculait **deux** HMAC (sandbox + production) et **déduisait** l'environnement du secret qui matche. Fait qui rend ce mécanisme inutile : **un déploiement ne porte qu'un seul jeu de clés Omni-FI** (`OMNIFI_ENV`, `OMNIFI_CLIENT_ID`, `OMNIFI_SECRET`, verrou `OMNIFI_AUTORISER_PRODUCTION`) — le worker rappellerait de toute façon l'amont avec CES clés-là. Ingérer un événement de l'autre environnement ne mènerait nulle part.

Conception retenue :

- Deux variables déclarées, **distinctes et jamais partagées** (règle 8) : `OMNIFI_WEBHOOK_SECRET_SANDBOX` et `OMNIFI_WEBHOOK_SECRET_PRODUCTION`.
- La route **sélectionne celle qui correspond à `OMNIFI_ENV`** et ne calcule **qu'un** HMAC. Un événement signé avec le secret de l'autre environnement échoue naturellement au 401 — fail-closed par construction, sans logique d'aiguillage.
- Secret absent (ou chaîne vide) pour l'env courant → **503**, route **inerte** : jamais de dégradation en « on accepte sans vérifier ».
- Le secret n'est **jamais** loggé, jamais mis dans un message d'erreur, jamais en fixture ; les fixtures de test génèrent leur propre secret local (`crypto.randomBytes`).

Comparaison : `crypto.timingSafeEqual(Buffer.from(attendu, "hex"), Buffer.from(recu, "hex"))`, longueurs déjà garanties égales par §3.2.

### 3.4 Fenêtre anti-replay (fraîcheur)

Le `Timestamp` **est à l'intérieur du corps signé** : un attaquant ne peut pas le modifier sans invalider l'HMAC. C'est donc un ancrage temporel exploitable — le mécanisme standard.

- Règle : rejet si `|maintenant − Timestamp| > FENETRE`, en **instants UTC**. *Aucune conversion `Indian/Mauritius` ici* : on compare des instants, pas des dates comptables (la règle de fuseau CLAUDE.md vise les clôtures, pas les fenêtres de fraîcheur). `Timestamp` non parsable ou absent → `WEBHOOK_HORS_FENETRE` (400), fail-closed.
- Tolérance de dérive d'horloge **symétrique** : un `Timestamp` dans le futur au-delà de la tolérance est rejeté aussi (sinon une horloge amont décalée ouvre une fenêtre illimitée).
- **Valeur recommandée : `FENETRE = 24 h`, `DERIVE_FUTUR = 5 min`.** Justification chiffrée, et pourquoi pas 5 minutes comme chez Stripe :
  - la **politique de retry amont n'est pas documentée** (question D4-b) ; une fenêtre serrée transformerait un retry légitime à +30 min en perte définitive ;
  - **W2 n'existe pas** (§0.3) : aucun filet pull ne rattraperait cette perte ;
  - la vraie protection anti-replay n'est pas la fenêtre mais la **dédup permanente** (§6.2) — la fenêtre borne l'exposition d'une requête signée capturée et **empêche la ré-entrée en quarantaine après purge TTL** (invariant : `FENETRE ≤ TTL quarantaine = 30 j`, largement respecté).
  - Resserrer à 10-15 min **dès que D4-b est répondu** : entrée TODOS à ouvrir au lot W4, avec la valeur en constante nommée et testée.

### 3.5 Validation zod stricte (règle 3)

```
EventId      z.string().uuid()
EventType    z.string().trim().min(1).max(60)     // union OUVERTE, jamais un enum fermé
ConnectionId z.string().trim().min(1).max(64)     // pas .uuid() : ancrage sur le TYPE de la colonne
JobId        z.string().trim().min(1).max(64).nullable().optional()
Timestamp    z.string().datetime({ offset: true })
Payload      z.record(z.unknown()).default({})    // borné par la limite de 64 Ko du corps
             .strict() sur l'objet racine
```

Deux choix explicites : `ConnectionId` n'est **pas** validé en `uuid()` (la doc le dit uuid, la colonne est `varchar(64)` — se caler sur la colonne évite un rejet de masse si l'amont dérive, leçon de l'union ouverte) ; `Payload` **n'est consommé par aucune logique au MVP** — il est stocké en quarantaine tel quel et **filtré par liste blanche** avant d'entrer dans `audit_events.payload` (§7.3).

---

## 4. Rate-limit — obligatoire (règle 3 : surface non authentifiée par session)

### 4.1 Étage 1 — en mémoire, par IP, AVANT le HMAC

- **Pourquoi pas en base** : compter en table (patron `login_attempts`) écrirait **une ligne par requête non signée**. Sur une route publique, c'est une **amplification** : l'attaquant paie un POST, la base paie un INSERT. Interdit ici — l'invariant « aucun écrit DB avant signature valide » (§11.1) est aussi une propriété anti-DoS.
- **Mécanique** : seau glissant en mémoire du processus (`Map<ip, timestamps[]>` élaguée), **fonctions pures réutilisées** de `src/server/auth/rate-limit-ip.ts` (`debutFenetre`, `extraireIp`) — pas de nouvelle dépendance (règle 9).
- **Valeurs proposées** : `60 requêtes / IP / minute`. Ordre de grandeur légitime : un scrape émet ≤ 12 événements ; 60/min couvre des dizaines de connexions simultanées avec deux ordres de grandeur de marge.
- **Limite assumée et documentée** : sur une plateforme multi-instances, un compteur en mémoire est **par instance** — donc approximatif. C'est **acceptable et explicitement borné** : le rate-limit n'est pas le contrôle d'accès (c'est l'HMAC), il ne sert qu'à borner le coût. Ne jamais le présenter comme une garantie.
- IP via `x-forwarded-for` (même caveat que `rate-limit-ip.ts` : fiable derrière un proxy de confiance) ; absente → bucket commun `"ip-inconnue"`, jamais une exemption.

### 4.2 Étage 2 — par connexion, APRÈS signature valide

Borne le coût d'ingestion qu'un émetteur légitime (ou une boucle amont) peut déclencher. **Ne pas le coder à la main** : le SDK expose `throttle` / `rateLimit` sur la fonction (`InngestFunction.d.ts:171-190`), et `concurrency: 1` par connexion sérialise déjà. Retenu : `throttle` clé `event.data.omnifiConnectionId` (met en file, ne jette pas) plutôt que `rateLimit` (**lossy** — il *skippe* les runs, ce qui perdrait une synchro en silence : contraire à « no silent caps »). Valeur proposée : `limit: 6, period: "1m"` par connexion.

### 4.3 Étage 0 (optionnel, différé) — allowlist d'IP source

Si Omni-FI publie une plage stable (question D4-d), une allowlist en amont du rate-limit ajoute une couche gratuite. **Ne jamais en faire le contrôle d'accès** (NAT, changement d'infra) : défense en profondeur uniquement. Différé tant que la réponse n'est pas là.

---

## 5. Résolution `connection → workspace_id` — fail-closed

### 5.1 La règle, et le fait qui la ré-arme

`WEBHOOK-TENANT-FIRST1` exige : résoudre le TENANT d'abord, jamais router sur `omnifi_connection_id` seul. Le payload amont **ne porte pas de `ClientUserId`** (§1.10) : la lettre est inapplicable, l'**esprit** est tenu par la garde de multiplicité ci-dessous, écrite **dès le premier jour** pour le monde d'après le CONTRACT (§1.2/1.3).

### 5.2 La requête — l'unique exception documentée hors `withWorkspace`

```sql
-- Sous le rôle tygr_service, connexion DATABASE_URL_SERVICE. Paramètre lié.
SELECT id, omnifi_connection_id, workspace_id
FROM bank_connections
WHERE omnifi_connection_id = $1
LIMIT 2;                      -- LIMIT 2, jamais 1 : détecter la multiplicité EST le but
```

**Périmètre GELÉ : ces 3 colonnes, cette table, `FOR SELECT`, rien d'autre — jamais.** Toute extension future (autre colonne, autre table) est une modification de CLAUDE.md règle 2 et exige son propre arbitrage humain. Le présent plan **ne l'élargit pas** (§5.3 montre comment s'en passer).

Décision sur le résultat :

| Lignes | Décision | Sortie |
|---|---|---|
| 0 | quarantaine `CONNEXION_INCONNUE` (webhook avant `link-exchange` — cas nominal du premier sync) | 202 |
| ≥ 2 | quarantaine `AMBIGUE` + **alerte log** — **jamais** de choix arbitraire : router au hasard EST le cross-tenant que la règle interdit | 202 |
| 1 | candidate → cross-check §5.3 | — |

La policy RLS rendue nécessaire par le `FORCE ROW LEVEL SECURITY` de `bank_connections` (§1.1) :

```sql
CREATE POLICY webhook_resolution ON bank_connections
  AS PERMISSIVE FOR SELECT TO tygr_service USING (true);
```

Elle est acceptable **parce que** trois bornes indépendantes la confinent : (a) `GRANT` **column-level** sur 3 colonnes non métier, (b) `FOR SELECT` seul, (c) rôle sans autre privilège, `NOLOGIN` dans le script (LOGIN/mot de passe hors script, patron C4). C'est le compromis explicite : **la résolution webhook est cross-tenant par nature** (on cherche *à qui* est l'événement) — on la confine par le **privilège**, pas par la RLS. `AS PERMISSIVE` est délibéré (une RESTRICTIVE ne donne aucun droit, elle en retire) — et `TO tygr_service` la rend invisible à `tygr_app`.

### 5.3 Cross-check d'environnement **sans élargir `tygr_service`** (annule la décision D2)

Le plan parent élargissait `tygr_service` à `workspaces (id, omnifi_environment)`. **Inutile** : `workspaces` n'a pas de RLS (§1.4), et surtout le cross-check n'a **aucune raison de vivre avant** la résolution. Séquence retenue :

1. `tygr_service` rend `workspace_id` (3 colonnes, périmètre gelé) ;
2. on ouvre `executerPourWorkspaceSysteme(workspaceId)` — transaction `tygr_app`, garde owner C6, GUC tenant posé ;
3. **dans cette transaction**, lecture de `workspaces.omnifi_environment` pour cet `id` ;
4. `≠ OMNIFI_ENV` du déploiement → **quarantaine `ENV_MISMATCH` + alerte**, aucun enqueue, aucun audit.

Bénéfices : **moindre privilège strictement meilleur** (le périmètre de `tygr_service` reste 1 table / 3 colonnes), une seule connexion privilégiée à auditer, et la lecture reste correcte si une RLS tenant est un jour posée sur `workspaces` (le GUC est déjà celui du workspace résolu). **Conséquence de gouvernance : la mise à jour de CLAUDE.md règle 2 promise par D2 n'a plus lieu d'être ; la liste fermée reste telle quelle.** → décision **D1** (§13).

### 5.4 Ce que la garde de multiplicité coûte aujourd'hui, et pourquoi on la paie quand même

Aujourd'hui l'unique globale (§1.2) rend `≥ 2 lignes` **inatteignable** : la branche est du code mort *jusqu'au CONTRACT*. On l'écrit quand même parce que l'alternative (l'ajouter « le jour venu ») fait dépendre l'isolation tenant d'un futur geste humain — dette interdite (règle 9). Preuve associée : **test unitaire sur la fonction pure de décision** (elle prend N lignes en entrée), **plus** un test d'intégration à 2 tenants **raccroché à l'entrée TODOS du CONTRACT** qui l'activera (cf. correction de numérotation §1.3).

### 5.5 Quarantaine : pourquoi elle n'est pas facultative ici

Sans W2 (§0.3), un événement non résolu qui n'est pas conservé est **définitivement perdu**, et le symptôme métier (« la synchro ne se fait pas ») est indiagnosticable. La table de quarantaine est donc livrée **avec** W4 ; le **rejeu** est W5 (§12). Risque résiduel entre les deux, explicitement assumé et journalisé : les événements en attente s'accumulent sans être rejoués — visible en base et en log, jamais silencieux.

---

## 6. Idempotence — trois étages, et un ordre de pipeline corrigé

### 6.1 Les trois étages et ce que chacun garantit

| Étage | Mécanisme | Portée | Durée |
|---|---|---|---|
| 1 — fraîcheur | fenêtre `Timestamp` (§3.4) | rejette les rejeux anciens avant tout travail | 24 h (paramétrable) |
| 2 — dédup DB | `audit_events` `ON CONFLICT (workspace_id, omnifi_event_id) DO NOTHING` | **permanente** (table append-only, jamais purgée), **par tenant** | ∞ |
| 3 — enqueue | clé d'idempotence Inngest + `concurrency: 1` par connexion + upserts idempotents du job | « 1 événement → 1 run » | fenêtre SDK (§1.11) |

Composition à vérifier à l'implémentation : **fenêtre de fraîcheur ≤ fenêtre d'idempotence Inngest** ⇒ aucun trou entre l'étage 1 et l'étage 3. Si la doc du SDK annonce 24 h, ramener la fenêtre de fraîcheur à **12 h** pour garder une marge. **C'est un point de vérification bloquant du lot W4**, pas une hypothèse.

### 6.2 Clé d'idempotence : un champ explicite dans le contrat d'événement

`syncIngest` ne pose **pas** `idempotency` aujourd'hui, et le commentaire de W1 explique pourquoi : `omnifiEventId` est absent des émetteurs cron/manuel, et une clé vide partagée **dédupliquerait à tort des événements distincts**. Le raisonnement est juste ; la solution est d'ajouter un champ **toujours présent** :

```
cleIdempotence : z.string().trim().min(1).max(120)   // ajout au schéma de l'événement
  webhook  → `wh:${EventId}`
  cron     → `cron:${omnifiConnectionId}:${dateDuRun}`   (déjà prévu, plan parent §6.2)
  manuel   → `man:${crypto.randomUUID()}`                (jamais dédupliqué)
```

puis `idempotency: "event.data.cleIdempotence"` sur la fonction. Modification **additive et petite** (`client.ts`, `emission.ts`, l'appelant du relais manuel), mais elle touche le contrat W1 → à faire **dans le lot W4**, avec re-validation du chemin manuel. → décision **D2** (§13).

### 6.3 ⚠️ Ordre du pipeline : enqueue **avant** audit (pushback règle 10 sur le cahier §2.4)

Le cahier §2.4 et le plan parent posent l'ordre **HMAC → résolution → dédup → enqueue**. Mode de défaillance concret :

> La dédup pose la ligne `audit_events`. L'enqueue Inngest échoue ensuite (réseau, clé, panne). On répond 500 ; l'amont retente ; **le retry retombe sur la ligne d'audit déjà posée → « déjà vu » → aucun enqueue**. L'événement est **définitivement perdu**, et `audit_events` étant **append-only strict**, on ne peut ni corriger la ligne ni la retirer. Sans W2, aucun filet ne rattrape.

Ce n'est pas théorique : c'est le comportement nominal d'un `ON CONFLICT DO NOTHING` utilisé comme verrou de traitement.

**Correction proposée — inverser (7) et (8)** :

1. **enqueue** avec la clé d'idempotence (étage 3) ;
2. **puis** `INSERT audit_events … ON CONFLICT DO NOTHING` (trace + étage 2).

Propriétés obtenues :

- rejeu ×5 → 5 enqueues **collapsés en 1 run** par Inngest, **1 seule ligne** d'audit par `ON CONFLICT` → **le critère du cahier §4.3 est tenu** ;
- échec d'enqueue → 500, **aucune trace posée** → le retry amont **fonctionne réellement** ;
- échec d'audit après enqueue réussi → 500 → le retry ré-enqueue (collapsé) et repose la trace : **auto-réparant** ;
- coût : la garantie « exactement 1 run » repose sur l'idempotence Inngest plutôt que sur la base — d'où la vérification bloquante §6.1.

**Alternative conservatrice** (si l'on refuse de dévier du cahier) : garder l'ordre du cahier et, sur échec d'enqueue, écrire une **seconde** ligne d'audit `webhook.enqueue_failed` avec `omnifi_event_id = NULL` (l'unique composite l'autorise ; l'`EventId` va dans le `payload`, c'est un identifiant opaque sans PII), répondre 500 et **compter sur W2**. Le défaut reste : l'événement n'est pas rejouable par l'amont. → décision **D3** (§13). Recommandation : **inverser**, et consigner l'écart au cahier dans TODOS.

### 6.4 Ce que l'émission webhook ne partage PAS avec le relais manuel

`demanderIngestionSync()` est **fail-soft** (retourne `false` et journalise) — correct pour une Server Action dont le travail principal a réussi. **Interdit ici** : côté webhook, un enqueue raté doit devenir un **500 bruyant** pour déclencher le retry amont. Le lot W4 ajoute donc une variante **fail-loud** (ou un paramètre explicite), sans toucher au comportement du chemin manuel.

---

## 7. Modèle de données, migrations, provisioning

### 7.1 `webhook_events_pending` (nouvelle table, migration `0025_webhook-events-pending.sql`)

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `omnifi_event_id` | varchar(64) **UNIQUE** | dédup **pré-tenant**. Unicité globale acceptable **ici** (table système, invisible des tenants, jamais exposée par une API ⇒ pas d'oracle exploitable) — à ne pas confondre avec la décision Q4 sur `audit_events` |
| `omnifi_connection_id` | varchar(64), index | clé de rejeu |
| `event_type` | varchar(60) | union ouverte |
| `omnifi_job_id` | varchar(64) NULL | |
| `omnifi_environment` | varchar(10) | env du déploiement qui a reçu (CHECK aligné sur `workspaces`) |
| `motif` | varchar(30) | `CONNEXION_INCONNUE` / `AMBIGUE` / `ENV_MISMATCH` |
| `payload` | jsonb | body validé zod, borné ; le payload amont ne porte que des identifiants techniques |
| `received_at` | timestamptz | |
| `replayed_at` | timestamptz NULL | NULL = en attente |
| `replay_count` | integer NOT NULL default 0 | plafond anti-boucle (10) |

Pas de `workspace_id` (le tenant est inconnu **par définition**), donc **pas de RLS tenant**. Table système, **non financière, non append-only** : le DELETE de purge est légitime, et elle **ne rejoint PAS** la liste blanche DELETE de `tygr_app` (qui ne doit pas la voir du tout).

### 7.2 ⚠️ Deux gardes complémentaires contre `tygr_app` (le plan parent n'en avait aucune qui morde)

Rappel du fait §1.5 : le provisioning donne `SELECT/INSERT/UPDATE` sur **toutes** les tables, présentes (`:57`) **et futures** (`:65`). Une table « sans GRANT » n'existe pas ici. Donc :

1. **Privilège** — bloc idempotent ajouté à `drizzle/provisioning/tygr_app.sql`, **après** le GRANT global (patron exact du bloc `REVOKE UPDATE, DELETE` append-only, `:186`) :
   `REVOKE ALL ON public.webhook_events_pending FROM tygr_app;` (conditionnel à l'existence via `to_regclass`, comme les blocs voisins). Il **doit** être rejoué au `db:provision` post-`migrate` — l'ordre `provision → migrate → provision` du runbook le fait déjà.
2. **RLS** — `ENABLE` + `FORCE ROW LEVEL SECURITY` + **une seule policy** `FOR ALL TO tygr_service USING (true) WITH CHECK (true)`. Aucune policy ne s'applique à `tygr_app` ⇒ **0 ligne** même si un GRANT réapparaissait par accident.

Aucune des deux ne suffit seule (leçon append-only : la première garde a été contournée par une seconde voie). Conséquence assumée du `FORCE` : une réparation de données sous le rôle owner exige un `SET ROLE tygr_service` explicite — c'est voulu, et cohérent avec 0001/0003.

### 7.3 Écriture d'audit webhook — nouvelle fonction dans le repository (seul écrivain autorisé)

`consigner()` est inutilisable telle quelle (§1.7). Ajouter dans `src/server/repositories/audit.ts` :

```
consignerEvenementWebhook(tx, ctx, {
  omnifiEventId, eventType,          // eventType amont VERBATIM (varchar 60, union ouverte)
  connectionId,                       // uuid INTERNE, issu de la résolution
  hmacSignatureTruncated,             // 8 premiers hexa — jamais la signature entière (rejouable)
  payload,                            // liste blanche DÉDIÉE (§ ci-dessous)
}) → { insere: boolean }              // false = conflit = rejeu
```

Points non négociables :

- `actor_user_id` = **`null`**, **jamais `ctx.userId`** : le contexte système porte la sentinelle UUID-nul, l'écrire imputerait un acte système à un « utilisateur » fantôme dans l'audit trail (valeur probante BOM Innov8).
- `workspace_id` vient de `ctx`, jamais d'un paramètre (invariant existant du repository).
- **Liste blanche de payload distincte des événements applicatifs** : clés autorisées `{ omnifiJobId?, declencheur }` — **rien d'autre**. `Payload{}` amont **n'entre pas** dans `audit_events` au MVP (il part en quarantaine seulement, et il n'est jamais loggé).
- `ON CONFLICT (workspace_id, omnifi_event_id) DO NOTHING … RETURNING id` : l'absence de ligne rendue **est** le signal « déjà vu ». Aucun UPDATE, aucun DELETE (append-only strict).
- **TOUS les `EventType` sont tracés** (cahier §2.4), y compris les intermédiaires ; **seuls** `sync.completed`, `sync.failed`, `sync.mfa_required` déclenchent un enqueue.

### 7.4 Rôle `tygr_service` (lot W3)

- Bloc **idempotent** ajouté à `drizzle/provisioning/tygr_app.sql` (source unique des rôles, pipeline inchangé) : `CREATE ROLE tygr_service NOLOGIN` **sans mot de passe**, `GRANT USAGE ON SCHEMA public`, `GRANT SELECT (id, omnifi_connection_id, workspace_id) ON public.bank_connections`, GRANTs sur `webhook_events_pending`, policies §5.2 et §7.2. **Jamais `BYPASSRLS`.** LOGIN + mot de passe posés hors script (patron C4), rotation au runbook.
- `DATABASE_URL_SERVICE` : connexion dédiée (Pool/WebSocket ou TCP mode transaction — **jamais le mode HTTP**, E16), module `src/server/db/service.ts`.
- **Garde runtime miroir de C6, fail-closed** : refuser de servir si `current_user <> 'tygr_service'` (erreur nommée `RoleServiceInattenduError`, mappée 500). Un `DATABASE_URL_SERVICE` pointant l'owner ou `tygr_app` **fait échouer la route**, il ne la fait pas fonctionner « en mieux ».

---

## 8. Frontières de code (ce qui empêche la prochaine régression)

### 8.1 ESLint — élargir précisément, jamais contourner

- `FRONTIERE_SYSTEME` autorise aujourd'hui `src/server/inngest/**`. La logique webhook vit dans **`src/server/webhooks/omnifi/**`** (module serveur) — c'est **lui** qu'on ajoute aux `ignores`, **pas** `src/app/**`. La route App Router reste une **coquille de transport** : lecture des octets, appel du module, mapping du code HTTP — **aucun accès DB** (règle 2 : pas de client DB hors `src/server/`).
- Nouvelle `FRONTIERE_SERVICE` sur `src/server/db/service.ts`, **même mécanique** : constante **répétée** dans chaque bloc `no-restricted-imports` (⚠️ en flat config, redéclarer la règle la **remplace** — c'est ainsi qu'une frontière P0 s'est déjà désactivée en silence), et **3 globs** (`**/server/db/service`, `**/db/service`, `**/service`) car un import relatif (`../db/service`, `./service`) ne contient pas les préfixes.
- **Chaque glob est PROUVÉ au lint par un fichier-test négatif** avant d'être considéré comme posé (leçon W1 : deux des trois globs ne mordaient pas).

### 8.2 Proxy

Ajouter `api/webhooks` à l'exclusion du matcher de `src/proxy.ts`, **avec le commentaire de justification** au même format que `/api/inngest` (appelée par un serveur tiers, jamais par un navigateur ; sans l'exclusion, le proxy répond une redirection vers `/login` et **aucune signature n'est jamais vérifiée** — panne silencieuse, la plus coûteuse à diagnostiquer). Vérification au runtime exigée dans le PR : une requête non signée sur la route renvoie **401, pas 307**.

### 8.3 Runtime

`export const runtime = "nodejs"` (jamais Edge : `node:crypto`, driver DB WebSocket) et `export const dynamic = "force-dynamic"`. Conventions Next 16 à **relire dans `node_modules/next/dist/docs/`** à l'implémentation (AGENTS.md) plutôt que supposées.

---

## 9. Erreurs nommées et observabilité

### 9.1 Registre S2 (règle 3 : chaque erreur a un nom, catch-all interdit)

`WEBHOOK_NON_CONFIGURE` (503) · `WEBHOOK_TROP_VOLUMINEUX` (413) · `WEBHOOK_TROP_DE_REQUETES` (429) · `WEBHOOK_SIGNATURE_INVALIDE` (401) · `WEBHOOK_PAYLOAD_INVALIDE` (400) · `WEBHOOK_HORS_FENETRE` (400) · `WEBHOOK_ENQUEUE_ECHEC` (500) · `WEBHOOK_AUDIT_ECHEC` (500) · `ROLE_SERVICE_INATTENDU` (500).

Motifs **internes** (jamais un code HTTP à eux seuls, ils sortent tous en 202) : `CONNEXION_INCONNUE`, `AMBIGUE`, `ENV_MISMATCH`.

Aucune de ces valeurs n'apparaît dans une réponse HTTP (§2.2) : elles nomment des classes d'erreur TypeScript et des champs de log.

### 9.2 Logs structurés corrélés, sans PII (règle 8)

Champs communs à **toutes** les lignes d'une requête : `requestId` (généré à l'entrée, `crypto.randomUUID()`), `evt`, `eventId`, `eventType`, `env`, `sigTronquee` (8 hexa), et, dès qu'ils sont connus : `workspaceId`, `connectionId` (uuid interne), `omnifiConnectionId`.

**Interdits absolus** : le corps brut, `Payload{}`, la signature complète, le secret, toute valeur d'en-tête non listée. Le payload amont ne porte que des identifiants opaques — ce n'est pas une raison pour le journaliser.

Événements de log nommés (grep-ables) : `webhook_recu`, `webhook_signature_invalide`, `webhook_hors_fenetre`, `webhook_rate_limite`, `webhook_quarantaine` (+`motif`), `webhook_deja_vu`, `webhook_enqueue`, `webhook_enqueue_echec`. **Les cas `AMBIGUE` et `ENV_MISMATCH` sont des alertes** (niveau `error`), pas des `info` : ce sont des signaux d'isolation.

---

## 10. Tests

### 10.1 Unitaires — fonctions pures (`tests/unit/webhook-*.test.ts`)

1. **Chemin heureux** : corps forgé + signature calculée avec un secret de test → signature valide, zod OK, fenêtre OK.
2. **Signature invalide** : (a) en-tête absent ; (b) hex de bonne longueur mais faux ; (c) mauvaise longueur (49 caractères) — vérifie qu'on **ne passe pas** par `timingSafeEqual` ; (d) signature valide pour un **autre** corps (mutation d'un octet du payload) ; (e) préfixe `sha256=` accepté ; (f) casse hexadécimale mixte acceptée.
3. **Replay / fenêtre** : `Timestamp` à −25 h → rejet ; à −23 h → accepté ; à +6 min → rejet (dérive future) ; `Timestamp` absent/non ISO → rejet.
4. **Décision de résolution** (fonction pure prenant N lignes) : 0 → `CONNEXION_INCONNUE` ; 1 → candidate ; 2 → `AMBIGUE` **sans jamais choisir**.
5. **Rate-limit** : 60 passent, la 61ᵉ est refusée ; après la fenêtre, le seau se vide ; IP absente → bucket commun (pas d'exemption).
6. **Bornes** : corps à 64 Ko − 1 accepté, à 64 Ko + 1 rejeté ; `content-length` menteur (déclare 10, envoie 100 Ko) rejeté à la lecture.

### 10.2 Isolation — suite BLOQUANTE en CI (`tests/isolation/webhook-resolution-isolation.test.ts`)

Cas ajoutés à la suite IDOR (règle 3), sous PGlite/Postgres avec les vrais rôles :

1. Sous `tygr_service` : `SELECT institution_id` (ou `created_by`) sur `bank_connections` → **permission denied**.
2. Sous `tygr_service` : `SELECT` sur `transactions_cache`, `users`, **`workspaces`** → **permission denied** (preuve que D2 n'a pas été appliquée en douce).
3. Sous `tygr_service` : `INSERT` / `UPDATE` / `DELETE` sur `bank_connections` → **permission denied**.
4. Sous `tygr_service` : la résolution **voit** les connexions des **deux** tenants de test (comportement voulu, borné aux 3 colonnes) — et **rien d'autre**.
5. **Contre-preuve** : la même requête sous `tygr_app` **sans GUC** → **0 ligne** (la policy `webhook_resolution` est bien bornée par rôle et ne fuit pas vers l'app).
6. `webhook_events_pending` : sous `tygr_app` → refus (REVOKE) **et** 0 ligne (RLS sans policy) — les deux gardes testées **séparément** ; sous `tygr_service` → INSERT/SELECT/UPDATE/DELETE OK.
7. **Routage** : un événement dont la connexion appartient au workspace A ne produit **aucune** ligne dans `audit_events` du workspace B.
8. Ambiguïté : test d'intégration 2 tenants **raccroché à l'entrée TODOS du CONTRACT** (inatteignable tant que l'unique globale vit — §5.4), avec le numéro de migration **corrigé** (§1.3).
9. **Non-régression policy** : la présence d'une policy RESTRICTIVE sur `bank_connections` casserait la résolution → assertion explicite sur le fait qu'aucune RESTRICTIVE ne s'y applique.

**Protocole de mutation obligatoire** (sinon un test vert ne prouve rien) : commiter d'abord, puis **muter** chaque garde une par une (retirer le REVOKE, retirer la policy, élargir le GRANT à 4 colonnes, remplacer `LIMIT 2` par `LIMIT 1`) et vérifier que **le test correspondant rougit**. Une garde dont la mutation laisse la suite verte n'est pas prouvée.

### 10.3 Route en in-process (`tests/unit/webhook-route.test.ts`)

Requêtes forgées passées au handler exporté : chemin heureux → **202** + 1 ligne d'audit + 1 enqueue (émetteur injecté/espionné) ; **rejeu ×5 du même `EventId`** → **1 seule ligne d'audit, 1 seul enqueue effectif** ; signature invalide → **401** et **zéro écrit en base** (assertion sur le compte de lignes **avant/après**, pas sur un espion) ; secret absent → 503 ; connexion inconnue → 202 + 1 ligne de quarantaine ; env mismatch → 202 + quarantaine + log d'alerte.

### 10.4 Bout en bout (sandbox, au moment de l'enrôlement)

`PUT /dev/webhooks/config` → **copier le `WebhookSecret` immédiatement** (retourné une seule fois) → poser l'env var → `POST /dev/webhooks/test` → attendre 202 → vérifier la ligne `audit_events` et le run Inngest. Nécessite une **URL publique** (tunnel éphémère ou déploiement de recette) : impossible en dev local nu — à planifier, pas à découvrir le jour J.

---

## 11. Critères de sortie règle 3, appliqués ligne à ligne

### 11.1 Checklist de la route

- [ ] **Authz** — l'authentification **est** l'HMAC (§3) ; il n'y a pas de session. Ressource inconnue → **202 + quarantaine, jamais 404 ni 403** : aucun oracle d'existence (§2.1). Tout accès aux données passe par `executerPourWorkspaceSysteme` (RLS tenant) **sauf** l'unique résolution `tygr_service` — exception **documentée et gelée** (§5.2).
- [ ] **Validation** — zod **strict** sur le corps racine, bornes de longueur et de taille partout (§3.5), rejet bruyant à code nommé.
- [ ] **Audit ASVS** — injection : paramètres liés uniquement, zéro concaténation SQL ; IDOR : garde de multiplicité + cross-check env + **cas ajoutés à la suite isolation** (§10.2) ; messages **non-énumérants** (corps vides, §2.2) ; **rate-limit** présent car surface non authentifiée (§4) ; CSRF sans objet (pas de cookie, pas de session) ; **aucun écrit DB avant signature valide** (propriété testée).
- [ ] **Erreurs nommées** — registre §9.1 complet, mapping code → HTTP explicite, **catch-all interdit** ; les gardes de tenancy (`UnsafeDatabaseRoleError`, `RoleServiceInattenduError`) sont **re-levées**, jamais absorbées par un fail-soft.
- [ ] **Tests** — heureux + échecs spécifiques + cas limites (nil/vide/concurrence) : §10.
- [ ] **Logs structurés corrélés** (`requestId`, `workspaceId`, `connectionId`) **sans PII** : §9.2.

### 11.2 Critères mesurables du chantier (règle 7)

1. `POST /dev/webhooks/test` en sandbox → **202** + 1 ligne `audit_events` portant `omnifi_event_id` et la signature tronquée.
2. **Rejeu du même `EventId` ×5 → 1 seule ligne d'audit, 1 seul run Inngest** (critère cahier §4.3, verbatim).
3. **Signature invalide → 401 et ZÉRO écrit en base** (prouvé par comptage avant/après).
4. `Timestamp` hors fenêtre → 400, zéro écrit.
5. Flood de 200 requêtes non signées → **429 à partir du seuil**, zéro écrit, zéro appel amont.
6. Événement d'une connexion inconnue → 202 + 1 ligne de quarantaine ; **aucun** événement quarantiné n'est jamais routé vers un workspace.
7. Suite d'isolation `tygr_service` (§10.2) **verte et bloquante**, chaque garde **prouvée par mutation**.
8. Une requête non signée sur `/api/webhooks/omnifi` renvoie **401 et non 307** (preuve que l'exclusion du proxy est en place).

### 11.3 Stop-loss et livraison

`lint`, `tsc --noEmit`, `npm run test`, `npm run test:isolation`, `build` verts avant tout commit (règle 5). Une PR par lot, plan référencé, **Human-in-the-Loop absolu** (code + sécurité + DB : aucun auto-merge).

### 11.4 Mandat de cross-review (règle 6 — contexte frais, par lot)

- **W3** : périmètre **réel** de `tygr_service` (la policy `USING (true)` + les GRANT column-level tiennent-ils sous un `SELECT *`, une jointure, une sous-requête ?), efficacité **réelle** du REVOKE face à `ALTER DEFAULT PRIVILEGES`, garde runtime contournable ?
- **W4** : octets exacts de l'HMAC, canaux temporels, oracles dans les codes de réponse, **ordre du pipeline** (§6.3) et perte d'événement, fuite de la primitive système vers une surface utilisateur, comportement sous rotation de secret.
- Constat = `fichier:ligne` + mode de défaillance concret + confiance /10. Désaccord non résolu → remonté à l'humain, jamais lissé.

---

## 12. Découpage en lots

| Lot | Contenu | Estimation | Gates |
|---|---|---|---|
| **W3** | Rôle `tygr_service` : provisioning idempotent, policy `webhook_resolution`, GRANT column-level, `DATABASE_URL_SERVICE`, `src/server/db/service.ts` + garde runtime, `FRONTIERE_SERVICE` (3 globs prouvés), suite isolation §10.2 (cas 1-6) | **1-1,5 j** | cross-review · suite isolation bloquante |
| **W4** | Migration `0025` quarantaine + REVOKE/RLS (§7.2), `consignerEvenementWebhook`, module `src/server/webhooks/omnifi/**`, route + proxy, HMAC + fenêtre, rate-limit, `cleIdempotence` (§6.2) + `idempotency` sur le job, tests §10.1/10.3, cas isolation 7-9, `.env*.example`, runbook d'enrôlement, correction TODOS (numéro de migration du CONTRACT) | **2-2,5 j** | cross-review · isolation · preuve `POST /dev/webhooks/test` |
| **W5** | Rejeu de la quarantaine : enqueue `omnifi/webhook.replay.requested` au `link-exchange` + cron filet quotidien + purge TTL 30 j avec log d'abandon explicite | **1 j** | revue standard |

**Total ~4-5 j.** Dépendance signalée : **W2 (cron + `sync_runs`) reste dû** — sans lui, aucun filet pull (§0.3).

Le rejeu (W5) **repasse chaque événement par le pipeline complet** (résolution → cross-check → enqueue → audit) : **aucun raccourci**, le rejeu ne contourne jamais une garde.

---

## 13. Décisions ouvertes (arbitrage humain requis avant implémentation)

- **D1 — Cross-check d'environnement : lire `workspaces.omnifi_environment` sous `tygr_app` après résolution (§5.3), et donc ANNULER la décision D2 du plan parent ?**
  *Recommandation : OUI.* Le périmètre de `tygr_service` reste **1 table / 3 colonnes**, conforme à la contrainte « ne jamais élargir », et CLAUDE.md règle 2 **n'a plus besoin d'être modifiée**. Fait déclencheur (règle 10) : `workspaces` n'a pas de RLS (§1.4) — la lecture sous `tygr_app` est possible et suffisante. Coût : nul. **Si NON**, le lot W3 doit inclure la mise à jour explicite de CLAUDE.md règle 2 (condition posée par Etienne le 2026-07-17).

- **D2 — Ajouter `cleIdempotence` au contrat d'événement Inngest (§6.2) ?**
  *Recommandation : OUI.* C'est ce qui rend « rejeu ×5 → 1 seul run » **structurel** plutôt que dépendant du hasard de la concurrence. Coût : ~20 lignes sur `client.ts`/`emission.ts` + re-validation du chemin manuel. **Si NON**, l'idempotence d'enqueue repose uniquement sur `concurrency: 1` et les upserts — le critère du cahier §4.3 devient « 1 seul **effet** », pas « 1 seul **run** » : à acter explicitement, car le critère est écrit littéralement dans le cahier.

- **D3 — Inverser l'ordre enqueue/audit (§6.3), en écart assumé au cahier §2.4 ?**
  *Recommandation : OUI, inverser*, avec la trace de l'écart dans TODOS. Le mode de défaillance (perte définitive d'un événement sur échec d'enqueue, non rattrapable par retry, non corrigeable car append-only) est concret et non hypothétique. **Si NON** : retenir l'alternative conservatrice (seconde ligne d'audit `webhook.enqueue_failed` + 500 + dépendance à W2), et **prioriser W2 avant W4**.

- **D4 — Valeur de la fenêtre anti-replay (§3.4) : 24 h maintenant, resserrée après réponse D4-b ?**
  *Recommandation : 24 h, avec contrainte `fenêtre ≤ fenêtre d'idempotence Inngest` vérifiée à l'implémentation (§6.1) — ramenée à 12 h si le SDK annonce 24 h.* Alternative si l'on privilégie la rigueur crypto sur la robustesse : 15 min immédiatement, en acceptant de perdre les retries amont tardifs **tant que W2 n'existe pas**.

- **D5 — Ordonnancement W2 vs W4.**
  *Recommandation : livrer W2 (cron + `sync_runs`) avant ou en parallèle de W4.* Le webhook sans filet pull fait reposer la fraîcheur sur un canal dont la fiabilité d'émission **n'est toujours pas prouvée** (§1.1-a). C'est la même logique que la décision D1=C du plan parent, appliquée à ce qu'il reste.

---

## 14. Hors périmètre — à ouvrir en dette si non traité

- **Rotation de secret sans fenêtre de 401** : `POST /dev/webhooks/rotate-secret` invalide l'ancien **immédiatement** ⇒ trou entre la rotation et le redéploiement. Runbook : rotation → env var → redéploiement **dans la foulée** ; les événements de la fenêtre sont perdus (rattrapés par W2). Double validité côté amont : à demander (D4).
- Allowlist d'IP source (§4.3) — conditionnée à la réponse amont.
- Confirmation amont `GET /connections?clientUserId=` (D3 du plan parent) — reste **différée**, inscrite dans l'entrée TODOS du CONTRACT.
- Consommation de `Payload{}` (aucune clé lue au MVP) — dépend de la réponse D4-c.
- `sync_runs`, cron 06:00 MUT, insights, curseur amont : chantiers propres, inchangés.
