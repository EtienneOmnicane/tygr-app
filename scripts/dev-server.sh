#!/usr/bin/env bash
#
# dev-server.sh — lance le serveur de dev TYGR en SANDBOX ou en PRODUCTION (vraie
# donnée), en HTTPS, sans rien retenir. Usage :
#
#   npm run start:sandbox      # clés sandbox (.env), bac à sable
#   npm run start:prod         # clés prod (.env.prod), VRAIE donnée bancaire
#
# Ce que le script garantit (pour ne plus jamais « lutter ») :
#   1. Démarre les conteneurs Docker (tygr_postgres / tygr_wsproxy) s'ils dorment —
#      cause n°1 de « ça ne marche pas » : la base est injoignable (cf. TODOS).
#   2. Charge le BON fichier d'env (.env sandbox / .env.prod prod) SANS jamais le
#      modifier — il ne fait que le consommer (zéro risque de corrompre vos secrets).
#   3. En prod : force OMNIFI_ENV=production + OMNIFI_AUTORISER_PRODUCTION=1 (le verrou
#      mergé PR #124 l'autorise sur l'hôte partagé api-stage) → config HONNÊTE, l'app
#      SAIT qu'elle traite du réel. Vérifie que les clés sont bien des clés prod.
#   4. Force NEXT_PUBLIC_OMNIFI_ENV=staging (le CDN du widget doit matcher l'API jointe,
#      api-stage) et APP_ALLOWED_ORIGINS=https://localhost:3000 (le widget exige HTTPS).
#   5. Lance `next dev --experimental-https` (certificat auto-signé : Chrome « Avancé »
#      → « Continuer vers localhost »).
#
# Réf : docs/BASCULE-PRODUCTION-OMNIFI.md (procédure + pièges).
set -euo pipefail

MODE="${1:-}"
PORT="${PORT:-3000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── 1. Choix du mode + fichier d'env ────────────────────────────────────────────
case "$MODE" in
  sandbox)
    ENV_FILE=".env"
    echo "🧪 Mode SANDBOX (bac à sable, clés de test)"
    ;;
  prod|production)
    ENV_FILE=".env.prod"
    echo "🚨 Mode PRODUCTION — VRAIE donnée bancaire"
    ;;
  *)
    echo "❌ Usage : npm run start:sandbox  |  npm run start:prod"
    echo "   (reçu : '${MODE:-<vide>}')"
    exit 1
    ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Fichier d'environnement '$ENV_FILE' introuvable."
  [[ "$MODE" == "sandbox" ]] && echo "   → copiez .env.example vers .env et remplissez-le."
  [[ "$MODE" != "sandbox" ]] && echo "   → copiez .env.prod.example vers .env.prod et remplissez-le."
  exit 1
fi

# ── 2. Conteneurs Docker (cause n°1 de panne : base à l'arrêt) ───────────────────
echo "🐳 Vérification des conteneurs Docker…"
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker n'est pas démarré. Lancez Docker Desktop puis relancez."
  exit 1
fi
for c in tygr_postgres tygr_wsproxy; do
  if [[ -z "$(docker ps -q -f name="^${c}$")" ]]; then
    if [[ -n "$(docker ps -aq -f name="^${c}$")" ]]; then
      echo "   ↻ démarrage de $c (était arrêté)…"
      docker start "$c" >/dev/null
    else
      echo "❌ Conteneur '$c' inexistant. Créez la stack de validation locale d'abord"
      echo "   (cf. CLAUDE.md § Dev local — stack de validation)."
      exit 1
    fi
  else
    echo "   ✓ $c déjà actif"
  fi
done

# ── 3. Chargement de l'env (sans modifier le fichier) ───────────────────────────
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a
unset NODE_OPTIONS  # incompatible avec next dev sur Node 25 (cf. BASCULE doc)

# ── 4. Réglages spécifiques au mode ─────────────────────────────────────────────
# Le CDN du widget DOIT matcher l'API jointe (api-stage) → toujours "staging", même
# en prod (mettre "production" chargerait le mauvais CDN → widget jamais initialisé).
export NEXT_PUBLIC_OMNIFI_ENV="staging"
# Le widget exige un RedirectOrigin HTTPS (Omni-FI rejette http en 400).
export APP_ALLOWED_ORIGINS="https://localhost:${PORT}"

if [[ "$MODE" != "sandbox" ]]; then
  # Config HONNÊTE : l'app doit savoir qu'elle traite du réel. Le verrou (PR #124)
  # autorise production sur l'hôte partagé dès que le drapeau est posé.
  export OMNIFI_ENV="production"
  export OMNIFI_AUTORISER_PRODUCTION="1"
  # Garde-fou : en prod on veut de VRAIES clés prod (préfixe prod_). Avertir sinon.
  if [[ "${OMNIFI_SECRET:-}" != prod_* ]]; then
    echo "⚠️  Le secret de $ENV_FILE ne commence pas par 'prod_'. Êtes-vous sûr que"
    echo "    ce sont les clés de PRODUCTION ? (lancement quand même dans 3 s, Ctrl-C pour annuler)"
    sleep 3
  fi
fi

# ── 5. Récapitulatif + lancement ────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────────────────"
echo " Mode          : $MODE  (env: $ENV_FILE)"
echo " OMNIFI_ENV    : ${OMNIFI_ENV:-?}"
echo " API Omni-FI   : ${OMNIFI_BASE_URL:-?}"
echo " Clé           : ${OMNIFI_CLIENT_ID:0:6}…  secret: ${OMNIFI_SECRET:0:5}…"
echo " CDN widget    : $NEXT_PUBLIC_OMNIFI_ENV"
echo " URL locale    : https://localhost:${PORT}"
echo "────────────────────────────────────────────────────────"
echo "👉 Ouvrez Chrome sur https://localhost:${PORT} (« Avancé » → « Continuer vers localhost »)"
echo ""

exec node_modules/.bin/next dev --experimental-https -p "$PORT"
