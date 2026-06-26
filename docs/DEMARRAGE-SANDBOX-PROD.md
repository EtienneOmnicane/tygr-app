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
