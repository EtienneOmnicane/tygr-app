# Démarrer en Sandbox ou en Production — guide express

> But : ne plus jamais « lutter » pour basculer entre le bac à sable et la vraie
> donnée. Deux commandes, c'est tout. Détails techniques & pièges :
> `docs/BASCULE-PRODUCTION-OMNIFI.md`.

## TL;DR — les deux seules commandes à retenir

```bash
npm run start:sandbox    # 🧪 bac à sable (clés de test, données factices)
npm run start:prod       # 🚨 VRAIE donnée bancaire (clés de production)
```

Puis ouvrir **https://localhost:3000** dans Chrome → « Avancé » → « Continuer vers
localhost » (certificat auto-signé, c'est votre serveur local, sans risque).

C'est tout. Le script `scripts/dev-server.sh` fait automatiquement le reste :

1. **Démarre les conteneurs Docker** (`tygr_postgres` / `tygr_wsproxy`) s'ils dorment.
   → C'est la **cause n°1** de « ça ne marche pas » : après un redémarrage du Mac, les
   conteneurs sont arrêtés et la base est injoignable. Le script les rallume pour vous.
2. **Charge le bon fichier de secrets** (`.env` en sandbox, `.env.prod` en prod) — il
   ne les MODIFIE jamais, il ne fait que les lire.
3. **Configure tout correctement** : HTTPS (obligatoire pour le widget bancaire), le bon
   `OMNIFI_ENV`, et le CDN du widget aligné sur l'API.

## Ce qui change entre les deux modes

| | `start:sandbox` | `start:prod` |
|---|---|---|
| Fichier de secrets lu | `.env` | `.env.prod` |
| `OMNIFI_ENV` | `sandbox` | `production` (config honnête : l'app SAIT qu'elle traite du réel) |
| Clés attendues | `sand_…` | `prod_…` (le script avertit si ce n'est pas le cas) |
| API Omni-FI | `api-stage.omni-fi.co` | `api-stage.omni-fi.co` (**même hôte** — voir note) |
| Données | factices (sandbox) | **vraies données bancaires** |

> **Pourquoi la même URL d'API ?** Omni-FI n'a pas d'hôte de prod distinct :
> `api-stage.omni-fi.co` sert pour les deux. Ce qui distingue prod de sandbox, ce sont
> les **clés** + l'**EndUser**, pas l'adresse. Le verrou de sécurité (`config.ts`) a été
> adapté pour ça (PR #124) : il autorise `OMNIFI_ENV=production` sur cet hôte partagé.

## Au quotidien

- **Changer de port** : `PORT=3001 npm run start:prod` (utile pour faire tourner les deux
  en parallèle).
- **Arrêter le serveur** : `Ctrl-C` dans le terminal où il tourne.
- **Le serveur ne démarre pas ?** Dans l'ordre :
  1. Docker Desktop est-il lancé ? (le script le dit sinon)
  2. `docker ps` montre-t-il `tygr_postgres` et `tygr_wsproxy` en `Up` ?
  3. Le fichier d'env (`.env` / `.env.prod`) existe-t-il et contient-il les clés ?
- ⚠️ **Ne demandez le mode prod que si vous avez vraiment besoin de la vraie donnée.**
  En prod, l'app manipule de la PII bancaire réelle (rappel : la base locale Docker n'est
  pas un coffre-fort — dette `PROD-DATA-LOCAL1` dans TODOS.md).

## Première fois / nouvelle machine

Si les conteneurs n'existent pas encore (`❌ Conteneur 'tygr_postgres' inexistant`),
créez d'abord la stack de validation locale : voir `CLAUDE.md` § « Dev local — stack de
validation » (création du réseau + des conteneurs + provisioning de la base).

### Bootstrap du premier ADMIN (Open Question 4, tranchée le 2026-06-12)

Une base fraîchement migrée n'a **aucun utilisateur** : personne ne peut se connecter,
et le provisioning de membres (`/admin/membres`) est lui-même réservé aux ADMIN. Le
premier compte se crée donc **hors application**, par un script d'administration.

C'est `scripts/seed-admin.mjs` (`npm run seed:admin`) : il crée le workspace
« Omni-FI HQ » et l'ADMIN global. Tous les autres comptes se créent ensuite **depuis
l'interface**, par cet ADMIN.

```bash
# Après provision → migrate → provision (ordre non négociable, cf. CLAUDE.md).
SEED_ADMIN_PASSWORD='<mot de passe fort, jamais commité>' \
  node --env-file=.env scripts/seed-admin.mjs
```

Garanties du script (à ne pas contourner) :

- **Rôle owner** (`DATABASE_URL_ADMIN`) : opération d'administration, même statut que
  les migrations — c'est une exception documentée à la règle 2 (CLAUDE.md).
- **Aucun `BYPASSRLS`** : `workspace_members` est sous `FORCE RLS`, donc le script pose
  `app.current_workspace_id` dans sa transaction et satisfait la policy comme n'importe
  quel appelant. Le modèle d'isolation reste entier.
- **Idempotent** : relançable sans effet de bord. Il ne **réécrit jamais** un mot de
  passe existant — pas d'écrasement silencieux d'un compte vivant.
- **Secret par variable d'environnement uniquement**, jamais en dur ni dans un log
  (règle 8). Ne pas le mettre dans `.env` : le passer à la commande.

> ⚠️ **Rotation du mot de passe initial.** L'ADMIN ainsi créé choisit son propre
> mot de passe (le seed ne pose PAS le flag de forçage). Le changement de mot de
> passe self-service existe : **`/account/password`** (AUTH-MDP-TEMPO1 lot A). En
> dev local, `scripts/reset-password.mjs` reste le recours « mot de passe oublié » :
> il pose systématiquement `password_changed_at = now()` — **toute session ouverte
> du compte est invalidée** (voulu) — et `RESET_MUST_CHANGE=1` (défaut `0`) pose en
> plus le flag de forçage, à utiliser quand on resette un **tiers** (il devra choisir
> son propre secret au prochain accès). Les membres provisionnés via `/admin/membres`
> reçoivent, eux, TOUJOURS un mot de passe temporaire : gate vers `/account/password`
> jusqu'au changement.

> `omnifi_client_user_id` est un **placeholder** à ce stade. Il est remplacé lors de
> l'enrôlement Omni-FI réel (`POST /clients/end-users`) — c'est la frontière tenant côté
> API amont, il ne doit jamais rester fictif en production.
