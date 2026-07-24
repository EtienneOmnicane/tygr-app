# Runbook — Enrôlement & exploitation du webhook Omni-FI (lots W4 + W5 + W2)

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

## 6. Quarantaine (`webhook_events_pending`) — rejeu W5

Un événement non résolu (connexion inconnue, ambiguë, ou env mismatch) est conservé en
quarantaine et répond **202** (jamais 404/403 — pas d'oracle). Le **rejeu (W5)** le
reprend par le **pipeline complet** (résolution → cross-check env → enqueue → audit,
aucun raccourci), sur deux déclencheurs :

- **`link-exchange`** : à chaque connexion créée (widget custom ou drop-in), un événement
  `omnifi/webhook.replay.requested` (fail-soft) rejoue la quarantaine de CETTE connexion —
  le cas nominal « webhook arrivé avant la connexion » se résorbe seul.
- **Cron filet quotidien** (`omnifi-webhook-replay-cron`, 05:30 heure de Maurice) :
  balayage complet + **purge TTL 30 j**. ⚠️ Ce cron n'est PAS le filet pull W2
  (`omnifi-sync-cron` 06:00 MUT + `sync_runs`, cf. §5) : il ne rejoue que ce qui a
  été REÇU ; W2 rattrape ce qui ne l'a jamais été.

Issues d'un rejeu : livré (`replayed_at` posé, audit `WEBHOOK_REJEU`, signature tronquée
NULL — la signature n'est pas conservée en quarantaine) ; toujours pas résolvable
(`replay_count` +1, **plafond 10** puis sortie du balayage — log
`webhook_rejeu_plafond_atteint`) ; panne d'infra (le step Inngest retente, sans compter).
La purge journalise chaque **abandon** (`webhook_quarantaine_abandon`) — jamais de
suppression silencieuse.

Inspection (sous `tygr_service`) :

```sql
SET ROLE tygr_service;
SELECT motif, count(*) FROM webhook_events_pending WHERE replayed_at IS NULL GROUP BY motif;
-- Bloquées au plafond (attendront la purge TTL — investiguer le motif) :
SELECT omnifi_event_id, motif, replay_count FROM webhook_events_pending
WHERE replayed_at IS NULL AND replay_count >= 10;
RESET ROLE;
```

**Ré-armement après correction de la cause** (ex. `ENV_MISMATCH` corrigé côté config,
`AMBIGUE` tranchée en base) : remettre le compteur à zéro — l'événement réintègre le
balayage du prochain cron. ⚠️ Le plafond compte des CONSTATS, pas du temps : chaque
`link-exchange` sur la connexion consomme une tentative si la cause persiste — ré-armer
APRÈS avoir corrigé, sinon le compteur se re-épuise.

```sql
SET ROLE tygr_service;
UPDATE webhook_events_pending SET replay_count = 0
WHERE omnifi_event_id = '<EventId>' AND replayed_at IS NULL;
RESET ROLE;
```
