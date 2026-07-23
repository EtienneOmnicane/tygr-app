#!/usr/bin/env bash
#
# Nettoyage des branches TYGR — audit du 2026-07-22
# À exécuter dans tygr-app/ depuis TON terminal (permissions normales).
#
# Ce que fait ce script :
#   0. retire le lock git résiduel (laissé par la session Cowork)
#   1. préserve ton TODOS.md non commité (stash) puis resync main -> origin/main
#   2. prune les worktrees "prunable" (dossiers disparus)
#   3. pour chaque branche MERGÉE : si elle est checkout dans un worktree,
#      RETIRE d'abord le worktree (git refuse sinon), PUIS supprime la branche
#      (locale + distante), squash inclus
#   4. NE TOUCHE PAS aux branches ouvertes / borderline (liste en bas), ni à
#      leurs worktrees
#
# Retirer un worktree ne détruit QUE le dossier de travail : la branche et ses
# commits survivent. Seules les modifs NON commitées d'un worktree merged sont
# perdues (assumé — la branche est déjà dans main). Chaque suppression est
# tolérante (|| true) : une branche déjà absente n'interrompt pas le script.
# Un récap est affiché AVANT toute destruction, avec confirmation à taper.
#
set -uo pipefail
cd "$(dirname "$0")"

echo "==> 0. Retrait du lock résiduel"
rm -f .git/index.lock

echo "==> 1. Préservation TODOS.md + resync main"
if ! git diff --quiet TODOS.md 2>/dev/null; then
  git stash push -m "wip-todos-avant-resync-20260722" TODOS.md
  echo "    TODOS.md stashé (git stash list pour le retrouver)."
fi
git checkout main
git fetch --prune origin
# ff-only : n'écrase rien si main a divergé (contrairement à reset --hard)
git merge --ff-only origin/main || echo "    ⚠ main a divergé d'origin/main — resync manuel requis"
echo "    main = $(git log --oneline -n1)"

echo "==> 2. Prune worktrees"
git worktree prune -v

echo "==> 3. Suppression des branches mergées"
DELETE_MERGED=(
  # --- squash-mergées le 2026-07-23 (PR #249 et #253) ---
  feat/connexion-refus-nomme        # #249 refus nommé connexion hors périmètre
  feat/transactions-filtre-categorie # #253 filtre catégorie /transactions
  feat/cat-manager-ergonomie         # #252 ergonomie gestionnaire de catégories
  # --- mergées fast-forward ---
  chore/claude-md-sobriete-diff
  feat/transactions-recherche-et-actions
  feature/refonte-entites-ia
  fix/widget-erreur-visible
  # --- squash-mergées (contenu déjà dans main) ---
  ci/bump-checkout-setup-node-v5
  feat/auth-mdp-temporaire
  feat/autosync-transactions-post-connexion
  feat/banques-liste-connexions
  feat/entity-parties-scope
  feat/entity-parties-scope-impl
  feat/entity-party1-bridge
  feat/ingestion-webhook
  feat/webhook-w1-socle-inngest
  feat/echeances-l2-actions
  feat/flux-prev-axe-encart
  feat/graphiques-camembert
  feat/graphiques-axe-effectif
  feat/graphiques-lot0-fr
  feat/onboard-seed-categories
  feat/polish-front-demo
  feat/previsionnel-c0-recurrence
  feat/refonte-dodo-l1
  feat/select-personnalise
  feat/toolbar-config
  feat/toolbar-date-precise
  feat/transactions-recherche
  feat/tx-somme-nette
  feat/clarte-cycle-connexion-demo
  feature/dashboard-flux-barres-only
  feature/dashboard-tooltip-barres
  feature/epic1-consent-emission
  feature/epic1-schema-audit
  feature/epic1-d2-finition
  chore/plan-refonte-entites
  chore/design-review-20260717
  docs/conception-previsionnel-c
  fix/dashboard-retirer-reconnecter
  fix/dashboard-libelle-cascade
  fix/dashboard-retirer-comptes-connectes
  fix/feedback-0709-topvendors
  fix/flux-bars-largeur-echelle
  fix/ingestion-unclassified-neutralise
  fix/omnifi-403-reconnect-surface
  fix/omnifi-sync-throttle-handling
  fix/periode-persist-nav
  fix/plage-dates-reset-ux
  fix/perimetre-redirect-page
  fix/previsionnel-c0-borne-derivees
  fix/qa-recherche-libelle-echeances
  fix/selecteur-vue-comptes
  fix/select-layout-shift
  fix/toolbar-perimetre-amputation
  fix/transactions-retrait-selecteur-comptes
  fix/transactions-runtime-usserver-capture
  fix/tx-recherche-layout-shift
  fix/tx-toolbar-dedup
  fix/unique-composites
  fix/variation-part-prev-minuscule
  fix/widget-err6-login-failed
  plan/graphiques-categ-utilisateur
  # --- diagnostic / probe jetables ---
  chore/diag-transactions-omnifi
  debug/omnifi-capture
  feat/ingest-delta
  docs/consignation-omnifi-sync
)

# Renvoie le chemin du worktree qui a $1 en checkout, ou rien.
worktree_of() {
  git worktree list --porcelain | awk -v b="refs/heads/$1" '
    $1=="worktree"{wt=$2}
    $1=="branch" && $2==b {print wt}
  '
}

# --- Récap AVANT destruction : ce qui va réellement partir ---
echo
echo "==> Récap : branches présentes qui vont être supprimées"
TO_DELETE=()
for b in "${DELETE_MERGED[@]}"; do
  here_local=$(git show-ref --verify --quiet "refs/heads/$b" && echo local || echo -)
  here_remote=$(git show-ref --verify --quiet "refs/remotes/origin/$b" && echo remote || echo -)
  wt=$(worktree_of "$b")
  [ "$here_local" = "-" ] && [ "$here_remote" = "-" ] && continue
  TO_DELETE+=("$b")
  printf "    %-45s [%s/%s]%s\n" "$b" "$here_local" "$here_remote" \
    "${wt:+  ← worktree: $wt}"
done

if [ "${#TO_DELETE[@]}" -eq 0 ]; then
  echo "    (rien à supprimer — déjà propre)"
else
  echo
  read -r -p "Supprimer ces ${#TO_DELETE[@]} branche(s) + leurs worktrees ? [oui/non] " REP
  if [ "$REP" != "oui" ]; then
    echo "    Abandon — rien n'a été supprimé."
    exit 0
  fi
  echo "==> 3. Suppression (worktree d'abord, puis branche)"
  for b in "${TO_DELETE[@]}"; do
    wt=$(worktree_of "$b")
    if [ -n "$wt" ]; then
      # -f -f : force même si verrouillé ou modifs non commitées (branche mergée)
      git worktree remove --force --force "$wt" 2>/dev/null \
        && echo "    worktree retiré  : $wt ($b)" \
        || echo "    ⚠ worktree non retiré : $wt ($b) — vérifie à la main"
    fi
    git branch -D "$b"           2>/dev/null && echo "    local  supprimée : $b" || true
    git push origin --delete "$b" 2>/dev/null && echo "    remote supprimée : $b" || true
  done
  git worktree prune -v
fi

echo "==> Terminé."
echo
echo "CONSERVÉES (à PR / à trancher) — NON supprimées :"
cat <<'KEEP'
  Ouvertes (code non mergé) :
    fix/donut-total-central          (petit fix donut)
    feat/membres-creation-scopes     (provisioning + scopes RLS)
    feat/bandeau-titulaire-accordeon (accordéon titulaire)
    fix/nudge-vision-entite          (nudge hors périmètre)
    fix/sync-timeout-lecture-partielle
    plan/treso-eod                   (plan seul, pas de code)
  À TRANCHER (NON mergée, contient un apport unique absent de main) :
    fix/connexion-refus-perimetre    (doublon de #249 ; garde le bloc doc
                                      deny-only de tenancy.ts, PAS dans main —
                                      reporter avant suppression, sinon perdu)
  Borderline (probablement supersédées, à vérifier) :
    feat/polish-layout, feature/dashboard-insights-voie-a,
    feature/regles-form-validation-ux, feat/previsionnel-c1-dashboard,
    fix/ux-synchro-et-erreur-connexion, feat/auth-mdp-tempo-impl,
    fix/design-review-20260715, feat/flux-previsionnel-lisibilite-lots012
  Intouchées : origin/staging, origin/backup/*
KEEP
