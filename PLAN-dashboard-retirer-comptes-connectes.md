# PLAN — DASH-RETIRER-COMPTES-CONNECTES1

> Retirer la carte « Comptes connectés » du Dashboard et rééquilibrer le layout.
> Ticket Etienne, décision de layout tranchée par Etienne le **2026-07-15**.

## Décision (validée avant tout code)

Deux options remontées à Etienne avec mockup. **Choix : Option A** — le graphe
`FluxTresorerieCard` passe **pleine largeur** (ancre unique, conforté par
UI_GUIDELINES §6.1/§6.7 : pas de KPI contextuel à droite → pleine largeur), et la
« Synthèse du mois » descend en **bandeau horizontal** sous le graphe :
- **mono-devise** → 3 colonnes `Entrées | Sorties | Variation nette` (pas de vide) ;
- **multi-devise** → repli sur l'empilement par devise (jamais d'addition cross-devise,
  règle 8), disposé en grille bornée pour ne pas s'étaler en pleine largeur.

Option B (garder 2fr/1fr, Synthèse seule à droite) écartée : ré-introduit le creux
qu'Etienne avait précisément voulu combler.

## Périmètre (règle 12 — toucher le minimum)

Fichiers modifiés :
1. `src/components/dashboard/dashboard-content.tsx`
   - Retirer l'import (l.48) et le rendu `<ConnectedAccountsCard>` (l.204).
   - Remplacer la grille `lg:grid-cols-3` (2fr/1fr) par : `FluxTresorerieCard` pleine
     largeur **puis** `CashFlowSummary disposition="bandeau"` pleine largeur.
   - **Garder** la prop/fetch `comptes` : encore consommée par `SoldesDevisesRow`,
     `synchroLaPlusRecente` (pastille fraîcheur) et le « N comptes » du sous-titre.
   - Mettre à jour l'en-tête de doc du fichier (la structure décrite change).
2. `src/components/dashboard/cash-flow-summary.tsx`
   - Ajouter une prop `disposition?: "empile" | "bandeau"` (défaut `"empile"` =
     comportement historique **inchangé**, aucun autre usage aujourd'hui). En
     `"bandeau"` mono-devise → 3 colonnes KPI ; multi-devise → blocs devise en grille.
   - Réutiliser `replierSynthesesMois`, `formatMontant`, `estNegatif`, `estZero`
     (source unique de formatage, règle 8). Pas de nouveau formateur.
3. `TODOS.md` — signaler la dette : `connected-accounts-card.tsx` + sa démo
   `demo/comptes-provenance` deviennent **orphelins** (plus montés par le Dashboard).
   À trancher : recycler sur une autre page ou supprimer. Non supprimés ici (règle 12/9).

**Non touchés** : `connected-accounts-card.tsx` (dead code préexistant → signalé, pas
supprimé), `demo/comptes-provenance`, `flux-tresorerie-card.tsx` (déjà responsive via
`FluxBarres`/ResizeObserver → s'élargit seul en pleine largeur). **Zéro** serveur/RLS/schéma.

## Garde-fous

- Composants présentationnels purs (zéro fetch/état/handler), tokens sémantiques
  uniquement (`inflow-700`/`outflow-700`/`text-muted`/`line`…), pas de couleur en dur.
- Pas de `flex-wrap` sur un header. Montants jamais tronqués (`tabular-nums`
  `whitespace-nowrap`) ; seuls les libellés tronquent.
- Bandeau responsive : empile sous `sm`, colonnes ≥ `sm` (pas d'étalement, pas de casse mobile).

## Gates de sortie

- [ ] `npm run lint` vert
- [ ] `npm run typecheck` vert
- [ ] `npm run build` vert
- [ ] Suite complète verte (`npm run test` / isolation incluse)
- [ ] Visual QA (Gate 4) sur `/demo/dashboard` : succès · multi-devise · partiel · vide,
      + `/demo/dashboard-states` (loading/vide/erreur, non impactés) — comparé §UI_GUIDELINES.
- [ ] Revue contradictoire contexte frais (subagent indépendant) avant push.

## Livraison

Branche `fix/dashboard-retirer-comptes-connectes` depuis `main` à jour. Commit(s) par
unité logique. **Stop à la PR poussée** (code applicatif → merge manuel Etienne).
