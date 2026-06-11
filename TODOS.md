# TODOS — TYGR

Différés par la revue /autoplan du 2026-06-10 (plan v2.1 multi-tenant Workspace).

## P1 — au scaffold du repo (bloquant pour le premier commit de code)

- [ ] **Installer les hooks stop-loss** (`.claude/settings.json`) — Effort S (CC: ~15min).
  Lint + `tsc --noEmit` + tests forcés avant commit (CLAUDE.md règle 5). Dépend de :
  `git init` + scaffold Next.js + package.json. Tant que non installés : vérification
  manuelle déclarée dans chaque message de commit. Utiliser /update-config.
- [ ] **Règle lint anti accès DB ad-hoc** — Effort S (CC: ~20min). Interdire l'import
  du client DB hors `src/lib/` et `src/repositories/` (CLAUDE.md règle 2).
- [ ] **Pipeline CI canonique** — Effort M (CC: ~1h). lint → typecheck → tests →
  suite IDOR bloquante → build → migrations expand-contract → preview
  (CLAUDE.md règle 9).

## P2 — après le MVP

- [ ] **FEAT-3.2 Matrice de flux pivot (Accordion Pivot Table)** — Effort M (CC: ~2j).
  Différé au gate CEO : hors chemin critique des 3 missions. Dépend de : Epic 3.1 livré,
  catégories exploitables (Epic 2). Contexte : analyse croisée mensuelle pour DAF.
- [ ] **SSO groupe (Entra ID / Google)** — Effort S (CC: ~2h). Provider Auth.js
  additionnel, zéro refonte (architecture JWT prête). Dépend de : réponse Open
  Question 2 (IdP du groupe). Pré-requis pour l'onboarding à grande échelle.
- [ ] **SSE pour le panneau audit** — Effort S (CC: ~3h). Remplace le polling E17.
  Améliore la scène signature (latence perçue). Dépend de : MVP shippé.
- [ ] **Workspace de consolidation (vue holding cross-workspace)** — Effort M-L.
  Statut selon décision T-C2 du gate final. Le besoin n°1 probable du DAF groupe ;
  modèle de permission read-only cross-tenant à concevoir AVANT tout build.
  Ne contredit pas l'isolation : la démontre (membership explicite).

## P3 — plus tard

- [ ] **FEAT-3.3 Console mur de la dette** — endpoints `/debt/*` disponibles côté API.
- [ ] **FEAT-1.3 Import OCR PDF/CSV** — flux Document Upload documenté côté API.
- [ ] **Epics 2, 4, 5, 6, 7** — différés intégralement ; le schéma v2.1 les anticipe
  (catégories en cache, workspaces multi-devises).
- [ ] **Onboarding self-service + billing SaaS externe** — dépend de la décision
  T-C3 (conflit de canal) ; aucune migration de schéma requise.
- [ ] **Réévaluer bases séparées par tenant (C2)** — si une exigence de conformité
  client externe l'impose (taste T1 du gate : RLS partagée retenue au MVP).
