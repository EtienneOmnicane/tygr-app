# PLAN — Chantier E : migration de comptes entre entités, drag & drop (feedback 0709)

- **Branche** : `feat/entites-reassignation-dragdrop` (worktree `.worktrees/entites-dnd`, depuis `main`)
- **Source** : `docs/specs/FEEDBACK-retours-etienne-2026-07-09.md` (item 9)
- **ID TODOS** : FB0709-ENTITES-DRAGDROP1 (P1, ~1-2 j, surface sécurité)
- **Statut grounding** : fait (2026-07-09) sur `main`.

## Contexte métier

Omni-FI remonte des BU dupliquées (« airport lmt » vs « airport limited » =
même BU). L'ADMIN doit pouvoir MIGRER des comptes d'une entité à l'autre,
simplement et élégamment → vue drag & drop.

## Existant (réutiliser, ne pas dupliquer)

- **Server Action** `assignerCompteAction`
  (`src/app/(workspace)/admin/entites/actions.ts:215-246`) → repo
  `assignerCompteEntite` (`src/server/repositories/entites.ts:490-514`), garde
  applicative `exigerAdmin` (`entites.ts:177-180`, `ctx.role !== "ADMIN"` →
  `EntiteNonAutoriseError`) EN PLUS de la RLS `entity_scope` FOR ALL
  (WITH CHECK borne le déplacement au périmètre — un ADMIN est en Vision
  Globale, la policy passe). **Cette action couvre déjà compte→entité, y
  compris le CHANGEMENT d'entité** (pas seulement depuis le sas). Le chantier
  est donc à ~90 % une vue UI.
- Pages admin : `admin/entites/page.tsx` (liste), `assignation-entites.tsx`
  (sas des non-assignés), `propositions.tsx`.
- Invariant : la re-sync ne réécrase jamais un `entity_id` assigné
  (`schema.ts:327-329`, entity_id omis de l'onConflictDoUpdate) — la migration
  par UPDATE dédié est le seul chemin d'écriture. Ne pas y toucher.
- **Lot 2 wip d'Etienne** (`wip/vue-complete-20260708`, commit `9a4a816`
  « sélecteur Entité cible via ui/select », NON mergé) : picker d'entité cible
  à base de `ui/select` pour la ré-assignation ponctuelle. La vue drag & drop
  est **complémentaire** (migration visuelle en masse) — ce plan la référence
  et ne la duplique pas ; si le Lot 2 est mergé avant ce chantier, le drag &
  drop cohabite avec le select (le select reste le chemin accessible/mobile).

## E1 — Vue « Migration des comptes » (drag & drop natif)

**Aucune dépendance nouvelle** (règle 9 vérifiée : aucune lib DnD au
package.json) → **HTML5 natif** : `draggable`, `onDragStart/Over/Drop`.

Conception :
1. Nouvelle section sur `admin/entites/page.tsx` (ou onglet) : **colonnes par
   entité** (entités actives du workspace + colonne « Non assignés » = le sas),
   chaque colonne liste ses comptes (cartes compactes : nom, banque, devise,
   solde via `formatMontant`).
2. Drag d'une carte compte → drop sur une colonne entité cible → confirmation
   inline (« Migrer {compte} vers {entité} ? ») → `assignerCompteAction`
   existante → revalidation/refresh de la vue. Pas d'écriture optimiste sans
   retour serveur (surface sécurité : l'état affiché reflète la DB).
3. **Accessibilité / repli sans drag** : chaque carte porte aussi un menu
   « Migrer vers… » (réutilise le pattern select du Lot 2 s'il est mergé,
   sinon `<select>` natif) — le drag & drop est un enrichissement, pas le seul
   chemin.
4. États : loading (skeleton colonnes), vide (aucune entité → CTA créer une
   entité), erreur (StateCard `danger-bg` + retry), succès partiel après
   migration (toast/inline). Tokens sémantiques uniquement, primitives
   `states/primitives.tsx`.
5. Visibilité : vue ADMIN-only côté UI (le serveur garde avec `exigerAdmin` —
   la vraie frontière). Un non-ADMIN ne voit pas la section.

## E2 — Sécurité (exit criteria règle 3, dans le même PR)

- Aucune NOUVELLE Server Action si `assignerCompteAction` suffit (préférence
  forte). Si une action « migration en lot » s'avère nécessaire : zod strict
  (uuid[] bornée), `exigerAdmin`, 404 cross-tenant (jamais 403), cas ajouté à
  la suite isolation (compte d'un autre workspace → 404 ; entité d'un autre
  workspace → rejet FK composite), logs structurés `workspace_id` sans PII.
- Test authz : MANAGER/VIEWER → `EntiteNonAutoriseError` sur le chemin de
  migration (étendre le test existant si le cas manque).
- Contre-preuve invariant : une re-sync post-migration ne réécrase pas
  l'entity_id migré (test existant :327-329 à étendre si nécessaire).

## Gates & HITL

- Gates sandbox : lint, tsc, build, vitest non-DB (grouping/preparation de la
  vue testables purs ; tests DB lus en revue, exécutés en CI).
- Revue contradictoire à contexte frais, mandat : IDOR, écriture optimiste,
  drag & drop cross-colonne vers entité inactive, comptes hors scope.
- Visual QA Gate 4 (drag, drop, confirmation, repli select, responsive) =
  **Etienne** — PR applicative + surface sécurité → merge humain OBLIGATOIRE.
- Commits locaux, pas de push sandbox.

## Hors périmètre

Fusion/suppression d'ENTITÉS dupliquées (archive `is_active=false` existante
suffit après migration des comptes) ; pré-remplissage via PartyId Omni-FI
(dette ENTITY-PARTY1, P2) ; migration des parties (le sas parties existe).
