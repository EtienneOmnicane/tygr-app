# Runbook — Enrôlement & exploitation du webhook Omni-FI (lot W4)

> Route : `POST /api/webhooks/omnifi`. Auth = HMAC-SHA256 (pas de session).
> Plan : `docs/specs/PLAN-webhook-ingestion.md`.

## 1. Pré-requis DB — rôle `tygr_service`

Le rôle est créé **NOLOGIN sans mot de passe** par le provisioning (source unique :
`drizzle/provisioning/tygr_app.sql`, section 7). Séquence **non négociable** (identique à
`tygr_app`, cf. CLAUDE.md § « Séquence d'initialisation ») :

```bash
node --env-file=.env scripts/provision.mjs   # crée tygr_service (+ tygr_app)
node --env-file=.env scripts/migrate.mjs      # crée webhook_events_pending (0026)
node --env-file=.env scripts/provision.mjs    # RE-provision : pose les GRANT/policies
                                              # tygr_service (sautés au 1er passage,
                                              # table absente) + REVOKE tygr_app
```

Puis, **hors script** (patron C4, jamais commité), poser LOGIN + mot de passe et le
reporter dans `DATABASE_URL_SERVICE` (`.env`) :

```sql
ALTER ROLE tygr_service LOGIN PASSWORD '<mot de passe de DATABASE_URL_SERVICE>';
```

Vérification (doit renvoyer les 3 colonnes gelées, et ÉCHOUER sur toute autre) :

```sql
SET ROLE tygr_service;
SELECT id, omnifi_connection_id, workspace_id FROM bank_connections LIMIT 1; -- OK
SELECT institution_id FROM bank_connections LIMIT 1;                          -- permission denied
RESET ROLE;
```

## 2. Secrets webhook (`.env`)

Un **seul** secret par déploiement, sélectionné par `OMNIFI_ENV` :
`OMNIFI_WEBHOOK_SECRET_SANDBOX` **ou** `OMNIFI_WEBHOOK_SECRET_PRODUCTION`. Absent/vide pour
l'env courant → la route répond **503** (inerte). Jamais commité, jamais loggé (règle 8).

## 3. Enrôlement amont (sandbox) — le secret n'est retourné qu'UNE FOIS

```
PUT  /dev/webhooks/config           → renvoie { WebhookSecret }   ← COPIER IMMÉDIATEMENT
     (poser OMNIFI_WEBHOOK_SECRET_SANDBOX = ce secret, puis REDÉPLOYER)
POST /dev/webhooks/test             → l'amont envoie un mock `sync.completed`
```

Attendu : réponse **202**, une ligne `audit_events` (`omnifi_event_id` + signature
tronquée), un run Inngest `omnifi/sync.ingest.requested`. Nécessite une **URL publique**
(tunnel éphémère ou déploiement de recette) — impossible en dev local nu.

## 4. Vérifications de sécurité au runtime (bloquantes avant merge)

- Requête **non signée** sur la route → **401**, PAS 307 (preuve que l'exclusion du proxy
  `src/proxy.ts` est en place — sinon aucune signature n'est jamais vérifiée).
- Rejeu du même `EventId` ×5 → **1 seule** ligne d'audit, **1 seul** run Inngest.
- Signature invalide → **401** et **zéro** écrit en base.
- `Timestamp` hors fenêtre (> 12 h ou futur > 5 min) → **400**.

## 5. Rotation du secret — trou de 401 assumé

`POST /dev/webhooks/rotate-secret` invalide l'ancien secret **immédiatement**. Procédure :
**rotation → mise à jour de l'env var → redéploiement dans la foulée**. Les événements
émis pendant la fenêtre (ancien secret rejeté par le nouveau) sont **perdus côté push** —
ils sont rattrapés par le filet pull **W2** : cron `omnifi-sync-cron` quotidien
(06:00 heure de Maurice) qui re-synchronise chaque connexion active de l'environnement,
avec trace par run dans `sync_runs` (RUNNING → COMPLETED/PARTIAL/FAILED/MFA_REQUIRED ;
un RUNNING ancien sans `finished_at` = run mort en vol, à investiguer). La fraîcheur
maximale perdue entre rotation et prochain cron reste < 24 h — planifier la rotation en
fenêtre de faible trafic si ce délai compte.

## 6. Quarantaine (`webhook_events_pending`)

Un événement non résolu (connexion inconnue, ambiguë, ou env mismatch) est conservé en
quarantaine et répond **202** (jamais 404/403 — pas d'oracle). Le **rejeu** est le lot
**W5** (non livré) : d'ici là, les lignes s'accumulent, visibles en base et en log
(`webhook_quarantaine` + `motif`), jamais silencieusement perdues. Purge TTL 30 j = W5.

Inspection (sous `tygr_service`) :

```sql
SET ROLE tygr_service;
SELECT motif, count(*) FROM webhook_events_pending WHERE replayed_at IS NULL GROUP BY motif;
RESET ROLE;
```
