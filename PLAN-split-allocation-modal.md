# Plan — SplitAllocationModal (ventilation d'une transaction)

**Composant** : modale de ventilation d'UNE transaction sur N catégories (Pilier 1).
**Posture** : le composant le plus critique du Pilier 1 — décision PO : `/plan-design-review` ISOLÉE avant tout code. Ce plan est l'objet de cette revue.
**Frontière** : UI pure, actions injectées (`ActionsCategorisation` de `types.ts`). Le Backend juge ; l'UI prévient.

## Contrat data confirmé (lecture du Backend, 2026-06-17)

- **Invariant réel = `somme des splits ≤ |montant de la transaction|`** (repository `ajouterSplit`, comparaison SQL `<=`). PAS `=`. **Conséquence majeure** : la catégorisation PARTIELLE est VALIDE — ventiler 8 000 € d'une transaction de 10 000 € en laissant 2 000 € « non catégorisés » est un état accepté, pas une erreur. (Ceci CORRIGE la décision de revue produit « bouton inactif tant que somme ≠ total ».)
- **Dépassement rejeté** : code `VENTILATION_EXCEEDS_AMOUNT` (classe `VentilationDepasseError`).
- **Montant de split toujours > 0** ; le signe vit sur la transaction (l'UI manipule des valeurs absolues, affiche le sens via contexte).
- **Pas de `modifierSplit`** : le repository expose `ajouter` / `supprimer` / `lister`. Éditer = supprimer + ré-ajouter.
- Montants = chaînes décimales `numeric(15,2)` (règle 8, jamais de float). 2 décimales max.
- Actions disponibles (`ActionsCategorisation`) : `listerSplits(ref)`, `ajouterSplit(input)`, `supprimerSplit(splitId)`, `listerCategories()`.

## Le cœur : réconciliation temps réel des montants

L'enjeu produit (demande PO) : gérer visuellement la réconciliation temps réel SANS frustrer. Principe directeur acté : **le serveur juge, mais l'UI n'amène jamais l'utilisateur jusqu'au rejet.**

### Modèle d'état (logique pure, réutilisable)
Un calcul pur `calculerAllocation(montantTotal, splits)` → `{ alloue, restant, depasse }` :
- `alloue` = somme des montants des splits (chaînes décimales, addition en centimes entiers pour éviter le float — règle 8).
- `restant` = `montantTotal − alloue` (peut être 0 = entièrement catégorisé, ou > 0 = partiel valide).
- `depasse` = `alloue > montantTotal` (état INVALIDE, à empêcher côté UI).
Cette logique est PURE (zéro React), testable aux bornes — modèle [[machine-mfa]]. Réutilisable par la réconciliation 1:N du pilier Échéances (même calcul de « reste »).

### Affichage temps réel (3 zones)
1. **Bandeau de réconciliation** (en tête de modale) : « Montant total : 10 000 € · Alloué : 8 000 € · **Reste : 2 000 €** ». Le « reste » est NEUTRE (pas une erreur) tant que ≥ 0 ; passe en `danger` (fond + icône + message, §3.4) UNIQUEMENT si dépassement.
2. **Barre de progression** : proportion allouée / total. Remplie en `primary` ; le reste en `surface-inset`. Si dépassement, segment de débordement en `danger`. Donne une lecture instantanée « où j'en suis ».
3. **Lignes de splits** : chaque ligne = `CategoryPicker` (catégorie) + champ montant (chaîne décimale) + bouton retirer. Ajout d'une ligne via « + Ajouter une catégorie ».

### Règles d'interaction (anti-frustration)
- **Bouton Valider** : actif tant que `!depasse` (donc actif même en partiel). Inactif SEULEMENT si dépassement OU aucune ligne valide. ≠ ancienne règle « somme = total ».
- **Pré-validation live** : dès qu'une saisie ferait dépasser, le champ fautif passe en `danger` + message « Dépasse le montant de N € » AVANT toute soumission. L'utilisateur voit l'erreur en tapant, pas au rejet serveur.
- **Arrondi** : saisie limitée à 2 décimales (le pattern `\d+(\.\d{1,2})?`). Un montant à 3 décimales est refusé à la saisie (masque), pas au serveur.
- **Édition d'un montant existant** : pas de `modifierSplit` → l'UI retire le split et en ré-ajoute un (ou : édition optimiste locale puis remplacement). À trancher en revue : édition inline vs retirer+recréer explicite.
- **Reste non catégorisé** : affiché comme info bienveillante (« 2 000 € restent non catégorisés — vous pourrez compléter plus tard »), jamais comme un blocage.

### États de la modale (loading/empty/error/success/partiel)
- **Loading** : ouverture → `listerSplits` + `listerCategories` en cours → skeleton des lignes.
- **Empty** : transaction sans aucun split → une ligne vierge prête + reste = montant total.
- **Error** : échec d'une action serveur (`VENTILATION_EXCEEDS_AMOUNT` ou réseau) → message mappé (registre S2), la modale reste ouverte (pas de perte de saisie).
- **Success** : split ajouté/retiré → bandeau se met à jour, pas de fermeture auto (l'utilisateur peut continuer à ventiler).
- **Partiel** : `restant > 0` → état VALIDE, Valider actif.

## Agencement (ASCII — passe 1, fix to 10)

Modale `size="lg"` (720px). 3 zones empilées : bandeau de réconciliation (sticky en
haut), lignes de splits (zone scrollable), pied d'actions.

```
┌─ VENTILER LA TRANSACTION ──────────────────────────────[×]─┐
│ Beachcomber Resorts · 11 juin · entrée                     │  ← contexte txn (libellé, date, sens)
├────────────────────────────────────────────────────────────┤
│  Total 10 000 €   ·   Alloué 8 000 €   ·   Reste 2 000 €  │  ← BANDEAU réconciliation (sticky)
│  [████████████████████░░░░░]  80 %                         │  ← barre de progression (primary / inset)
├────────────────────────────────────────────────────────────┤
│  [Picker ▾ Électricité ]      [  6 000.00 € ]        [🗑]   │  ← ligne split 1
│  [Picker ▾ Matériel    ]      [  2 000.00 € ]        [🗑]   │  ← ligne split 2
│  + Ajouter une catégorie                                   │  ← lien d'action (§2.3)
├────────────────────────────────────────────────────────────┤
│  2 000 € restent non catégorisés (vous compléterez plus tard)│ ← info bienveillante (text-muted), pas erreur
│                                  [ Annuler ]   [ Valider ]  │  ← Valider ACTIF (somme ≤ total)
└────────────────────────────────────────────────────────────┘
```

État DÉPASSEMENT (somme > total) — le seul cas bloquant :
```
│  Total 10 000 €  ·  Alloué 11 000 €  ·  Dépassement 1 000 € │  ← bandeau en danger-bg + icône
│  [██████████████████████████|▓▓]  > 100 %                   │  ← segment de débordement en danger
│  [Picker ▾ Matériel ]      [  5 000.00 € ]⚠               │  ← champ fautif en danger + message
│                                  [ Annuler ]   [ Valider✗ ] │  ← Valider INACTIF
```

Hiérarchie (constraint worship — 3 choses) : 1) où j'en suis (bandeau+barre), 2)
mes allocations (lignes), 3) l'action (Valider). Le « reste » est secondaire, jamais
criant.

## Décisions design tranchées (plan-design-review, 2026-06-17)

### D1 — Reste non catégorisé : bienveillant + raccourci (passe 3)
Partiel = état SEREIN. Le reste s'affiche en `text-muted` (« 2 000 € restent non catégorisés, vous compléterez plus tard »), jamais en warning. PLUS un raccourci « + Catégoriser le reste » qui pré-remplit une nouvelle ligne avec le montant restant exact (évite le calcul de tête). Valider actif. (résout Q2)

### D2 — Saisie montant : brut au focus, formaté au blur (passe 5)
Champ libre texte, masque décimal (chiffres + séparateur, max 2 décimales, pattern `\d+(\.\d{1,2})?`), Geist `tabular-nums` aligné droite.
- **Focus (frappe)** : valeur BRUTE (`6000000.50`) — rien ne perturbe curseur/frappe/copier-coller.
- **Blur (perte de focus)** : formatage des milliers (`6 000 000.50`, espaces insécables).
- **Re-focus** : retour instantané au brut pour corriger.
Standard de la saisie financière (robustesse option 1 + lisibilité option 3, sans le piège du formatage live). (résout Q4)

### D3 — Mobile + a11y (passe 6)
- **375px** : bandeau de réconciliation STICKY en haut (toujours visible en scrollant les lignes) ; chaque ligne split passe en VERTICAL (picker au-dessus, montant en-dessous, corbeille à droite). Ventilation ÉDITABLE en mobile (un trésorier ventile en déplacement).
- **a11y** : le bandeau « reste/alloué » porte `aria-live="polite"` → le lecteur d'écran annonce le nouveau reste après chaque saisie, sans interrompre. Touch targets ≥44px.

### D4 — Édition optimiste locale, sync atomique au Valider (passe 7a + 4)
L'utilisateur édite les montants/catégories en ÉTAT LOCAL (aucun appel serveur pendant l'édition → fluide, pas de latence par frappe). Au Valider, l'UI envoie l'ÉTAT CIBLE COMPLET en UNE requête.
- **EXIGENCE BACKEND (nouvelle Server Action)** : `remplacerSplits(ref, splits[])` ATOMIQUE — supprime+insère le diff en UNE transaction, valide la somme ≤ |montant| une seule fois, tout-ou-rien. Élimine l'état partiel par construction (≠ boucle ajouter/supprimer non atomique). À livrer côté serveur. (résout Q1 + le risque d'atomicité Q3)
- **Pré-validation UI totale** : l'UI garantit somme cible ≤ total AVANT d'envoyer (le seul rejet résiduel = course concurrente → recharge + message mappé `VENTILATION_EXCEEDS_AMOUNT`).

### Granularité pré-validation (Q3) — saisie permissive + signal immédiat
On LAISSE saisir un montant qui dépasse (pas de masque dur qui bloque la frappe), mais le champ fautif passe en `danger` + message « Dépasse de N € » INSTANTANÉMENT, et Valider devient inactif. L'utilisateur voit l'erreur en tapant, jamais au rejet serveur. (le masque ne contraint que le FORMAT — 2 décimales —, pas la valeur)

## NOT in scope
- Réconciliation 1:N avec les échéances (pilier Échéances) — la logique pure d'allocation est conçue pour être réutilisée, mais le câblage échéances est hors P1.
- Édition d'une catégorie depuis la modale (passe par CategoryManagerModal séparé).

## What already exists (réutilisé)
- Primitive `Modal` (§4.4, focus-trap, Escape) — `size="lg"`.
- `CategoryPicker` (sélection catégorie par ligne) + `CategoryBadge`.
- Pattern logique pure testable ([[machine-mfa]]) pour `calculerAllocation`.
- Tokens UI_GUIDELINES (danger §3.4 pour dépassement, primary barre, tabular-nums montants).

## Implementation Tasks
Synthétisées des décisions de cette revue.

- [ ] **T1 (P1)** — `calculerAllocation(montantTotal, splits)` pur (centimes entiers, règle 8) — logique d'allocation, testable aux bornes (réutilisable réconcil 1:N)
- [ ] **T2 (P1)** — `SplitAllocationModal` : bandeau réconciliation (alloué/reste/barre), lignes (Picker + champ montant), pied. État LOCAL optimiste.
- [ ] **T3 (P1)** — Champ montant : brut au focus / formaté milliers au blur (D2), masque 2 décimales, Geist tabular.
- [ ] **T4 (P1)** — Pré-validation live : dépassement → champ `danger` + message instantané + Valider inactif (D-Q3). Reste partiel → `text-muted` + raccourci « catégoriser le reste » (D1).
- [ ] **T5 (P1)** — Responsive 375px (bandeau sticky, lignes verticales) + `aria-live=polite` sur le reste (D3).
- [ ] **T6 (P1, BACKEND)** — Server Action atomique `remplacerSplits(ref, splits[])` (tout-ou-rien) — EXIGENCE à transmettre au Backend (D4).
- [ ] **T7 (P2)** — Démo `/demo/split-allocation` + Visual QA (dépassement, partiel, mobile) avant câblage.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score 8/10 → 10/10, 5 décisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE VOICE :** non exécutée (Codex CLI absent ; subagent de repli non lancé). Le challenge contradictoire a eu lieu en continu sur les 5 décisions (passes 3/4/5/6/7).
- **VERDICT :** DESIGN CLEARED (8→10/10, 5 décisions verrouillées, 0 non résolue). Exige côté Backend : Server Action atomique `remplacerSplits`. La SplitAllocationModal peut être codée sur cette base (avec /verify ou Visual QA des états dépassement/partiel/mobile à la clôture).

NO UNRESOLVED DECISIONS
