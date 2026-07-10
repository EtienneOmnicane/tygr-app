# Plan — Fignolage layout §1.1 (pages trop étroites / vides)

> Phase : **conception** (Règle 1). Aucune ligne de code applicatif avant validation.
> Source de vérité : `docs/UI_GUIDELINES.md` §1.1 (layout asymétrique full-bleed).
> Déclencheur : retour Etienne — « transactions, échéances, règles : les div ne
> remplissent pas assez la page, trop petites / vides ».

## 1. Diagnostic (fondé, pas esthétique)

Toutes les pages de données coiffent leur contenu d'une colonne centrée étroite
(`mx-auto max-w-3xl` = 768px, `max-w-5xl` = 1024px). Sur un écran large ça laisse
deux gouttières vides → sensation « petit / vide ». C'est une **violation §1.1**
(full-bleed, marges 24px ≥1280px / 16px 768–1280px, pas de colonne centrée pour
un écran de données).

Caps relevés (`grep`) :

| Page | Fichier | Cap actuel | Cible §1.1 |
|---|---|---|---|
| Transactions | `transactions/page.tsx:161` + `loading.tsx:15` | `max-w-5xl` | pleine largeur, **sans** panneau |
| Échéances | `echeances/page.tsx:148` + `loading.tsx:10` | `max-w-3xl` | pleine largeur **avec** panneau 300px |
| Règles | `regles/page.tsx:123` + `loading.tsx:9` | `max-w-3xl` | pleine largeur, sans panneau |
| Banques | `banques/page.tsx:45` | `max-w-3xl` | pleine largeur, sans panneau |
| Graphiques | `graphiques/page.tsx:66` + `loading.tsx:10` | `max-w-3xl` | pleine largeur, sans panneau |

**Hors scope (volontaire)** : `admin/entites`, `admin/membres` (formulaires de
réglages — un `max-w-3xl` y est correct : lire un formulaire en pleine largeur est
une régression de lisibilité). `layout.tsx:76` = état de repli centré (erreur / pas
de workspace), à ne pas toucher. Confirmé avec le périmètre validé (les 5 pages qui
partagent le cap de données), pas les sas de réglages.

## 2. Lot 1 — Élargir les 4 pages sans panneau (quasi-trivial, faible risque)

Transactions, Règles, Banques, Graphiques + leurs `loading.tsx`.

Remplacer le wrapper :
```
- <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">   (transactions)
- <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">   (règles / banques / graphiques)
+ <main className="w-full flex-1 px-6 py-8">
```
`px-6` = marge 24px (§1.1 ≥1280px). On garde la simplicité : pas de marge
responsive fine (16px sous 1280px) au MVP — `px-6` partout est acceptable et
cohérent avec le shell existant (`DashboardShell` utilise `px-6`). Le `loading.tsx`
de chaque page épouse EXACTEMENT la même largeur (§6.5 : pas de saut de layout).

Chaque page garde son en-tête (`<h1>` + sous-titre) tel quel, juste dé-cappé.

Risque : nul (une classe CSS retirée, aucun changement de logique/données).

## 3. Lot 2 — Échéances : layout asymétrique §1.1 (vraie refonte)

§1.1 : Échéances est une page **avec** panneau (KPIs : solde, totaux
clients/fournisseurs/global). On **réutilise `DashboardShell`** (Règle 9 — le shell
§1.1 existe déjà, presentational, `aside` optionnel) plutôt que réinventer :

```
<DashboardShell aside={<aside-échéances/>}>
  <zone-données : bandeau erreur + formulaire + onglets direction + liste dirigée/>
</DashboardShell>
```

- **`aside` (300px sticky)** : la **Synthèse prévisionnelle** déplacée du flux
  principal vers le panneau, en **variante VERTICALE**. La synthèse actuelle
  (`echeances-synthese.tsx`) empile ses 3 horizons en `sm:flex-row` → déborde dans
  300px. On ajoute une prop `orientation?: "auto" | "vertical"` (défaut `auto` =
  comportement actuel, aucune régression ailleurs) ; en `vertical` les BlocHorizon
  s'empilent (`flex-col`, pleine largeur du panneau). Aucun recalcul : mêmes
  données `synthese`, même formatage (Règle 8, `format-montant`).
- **Zone de données (`flex-1 min-w-0`)** : le reste de `EcheancesFeature` inchangé
  (bandeau erreur, formulaire création/édition, onglets À encaisser / À décaisser,
  liste dirigée). La liste respire enfin en pleine largeur → règle le « trop petit ».

### Carte « Solde » du panneau → **différée** (scope, Règle 7)

§1.1 décrit la Carte 1 du panneau Échéances = solde courant. **Mais** la page
Échéances ne charge aujourd'hui AUCUN solde (`echeances/page.tsx` ne fetch que
règles/synthèse/catégories). L'ajouter = nouveau fetch `soldesCourantsParDevise`
sous `withWorkspace` + gestion multi-devise → **expansion de périmètre**. Décision :
**on livre le panneau avec la Synthèse seule** (déjà une vraie carte KPI prévisionnelle),
et on inscrit la carte Solde en **TODOS.md** (P2, déclencheur : prochaine itération
Échéances). Ça évite d'entangler un fetch de solde dans un chantier de layout.

Risque : moyen (restructure d'un container client + nouvelle prop presentational).
Mitigations : réutilisation `DashboardShell` (pas de nouveau shell), prop
`orientation` rétro-compatible (défaut inchangé), zéro changement de données/actions.

## 4. Contraintes transverses

- **Aucune couleur en dur, tokens only** (déjà respecté — on ne touche qu'aux
  largeurs / structure).
- **Montants & dates** : intacts, toujours via `format-montant` / `format-date`
  (Règle 8). Aucun formateur touché.
- **Responsive** : `DashboardShell` masque déjà l'`aside` sous `lg` (`hidden lg:flex`).
  Sous `lg`, la synthèse n'apparaît pas dans le panneau → **à traiter** : soit on
  laisse (dégradé acceptable au MVP), soit on remonte la synthèse en tête du flux
  sous `lg`. Décision MVP : accepter le masquage `lg` (cohérent avec le Dashboard),
  noter en TODOS si Etienne veut la synthèse mobile.

## 5. Vérification (Gates)

- **Sandbox (moi)** : `npm run typecheck` + `npm run lint` verts. (Pas de compilation
  Tailwind ni vitest en sandbox — limite connue.)
- **Mac Etienne (Gate 4, Règle 4)** : captures localhost des états
  loading/vide/liste des 5 pages, comparées §1.1 (marges 24px, pleine largeur, panneau
  300px Échéances, `tabular-nums` intacts). Bloquant avant revue.
- **Revue** : contexte frais (Règle 6) sur le diff.

## 6. Git (Human-in-the-Loop)

Le chantier est **applicatif** (`feat/`) → l'agent s'arrête à la PR poussée, Etienne
merge. Branche : **nouvelle `feat/layout-pleine-largeur` depuis `main` à jour**.
⚠️ L'arbre porte `M src/app/globals.css` (fix camembert, appartient à
`feat/graphiques-camembert`). **Étape 0 avant tout code layout** : committer ce
globals.css sur `feat/graphiques-camembert` (WIP de SA PR), PUIS créer la branche
layout depuis `main` — pour ne pas entangler camembert et layout. À confirmer avec
Etienne (opération git visible).

## 7. Ordre d'exécution

0. Résoudre le git (§6) — confirmer avec Etienne.
1. Lot 1 : dé-capper les 4 pages + leurs `loading.tsx` (5 min, faible risque).
2. Lot 2 : `orientation` sur `echeances-synthese`, refonte `echeances-feature`
   sur `DashboardShell`, dé-capper `echeances/page.tsx` + `loading.tsx`.
3. TODOS.md : carte Solde panneau (P2), synthèse mobile sous `lg` (P2).
4. typecheck + lint.
5. STOP → captures + PR côté Etienne.
