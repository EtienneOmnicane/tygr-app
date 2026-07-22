# Visual QA — POLISH-FRONT-DEMO1 (Gate 4)

Trois retouches cosmétiques relevées en démo. Captures prises en headless sur un
build de production (`next start`, pas `next dev` : l'hydratation y est morte et
les mesures mentiraient), viewport 1440×900.

Chaque défaut a été **mesuré au DOM** avant/après, pas jugé à l'œil : sur ces
trois écrans, le coupable est une largeur qui ne se voit pas sur une capture.

## 1. Sélecteur de compte — `SELECTEUR-COMPTE-NOMS-TRONQUES1`

`AVANT-1-selecteur-compte.png` → `APRES-1-selecteur-compte.png`
Écran : `/demo/perimetre-states`, popover « Vue › Par compte », groupes dépliés.

| | Boîte | Texte complet | Coupé |
|---|---|---|---|
| avant | 185,6 px | 323 px | oui |
| après | 245,6 px | 246 px (sur 2 lignes) | non |

Élargir ne pouvait pas suffire : le design system plafonne les popovers à 360 px
(UI_GUIDELINES §2.2), soit ~245 px utiles pour un nom qui en demande 323. C'est le
passage à la ligne (`break-words`) qui affiche le nom entier ; les 60 px gagnés ne
font qu'économiser des retours à la ligne.

### 1 bis. Les deux autres libellés du même popover

Le premier passage n'avait traité que la ligne de compte. Deux autres libellés du
sélecteur tronquaient pour la même raison, et sont corrigés à l'identique
(`break-words` + case et compteur recalés sur la première ligne).

`AVANT-4-groupe-titulaire-{1440,480}.png` → `APRES-4-…` (en-tête de groupe)
`AVANT-5-entite-480.png` → `APRES-5-…` (onglet « Par entité »)

| Élément | Largeur | Boîte | Texte | Coupé |
|---|---|---|---|---|
| en-tête titulaire | 1440 px | 226,4 px | 258 px | oui → non |
| en-tête titulaire | 480 px | 166,4 px | 258 px | oui → non |
| ligne d'entité | 1440 px | 239,7 px | 240 px | non (limite) |
| ligne d'entité | 480 px | 179,7 px | 187 px | oui → non |

**Ces deux mesures se prennent sous 640 px**, pas seulement en desktop. Le popover
y reste à 300 px (garde `sm:`, cf. Responsive) : la ligne d'entité, qui tient de
justesse à 1440 px, y déborde franchement. Mesurer uniquement en 1440 px aurait
manqué le cas entité.

Le déclencheur fermé (`perimetre-switcher.tsx:374`) garde volontairement son
`truncate` : c'est un résumé dans un header à largeur fixe (`w-[220px]`), où le repli
sur deux lignes ferait grandir la barre — ce que le design system proscrit
(condenser, jamais empiler).

## 2. Total par devise — `FILTRE-TOTAL-DEVISE-TRONQUE1`

`AVANT-2-total-devise.png` → `APRES-2-total-devise.png`
Écran : `/demo/transactions`, bandeau « Total des résultats filtrés » (visible
seulement filtre actif — taper dans la recherche).

| | Colonne devise | Texte | Coupé |
|---|---|---|---|
| avant | 105,8 px | 190 px | oui — « Roupie mauricienn… » |
| après | 365,8 px | 366 px | non |

La table faisait déjà 942 px : `max-w-0` écrasait la colonne à 105 px et hachait le
mot alors que la place était là.

Ce qui est proscrit est le mot **haché**, pas le retour à la ligne. La cellule est
donc laissée **élastique** (aucun `whitespace-nowrap`) : le repli tombe entre
« Roupie » et « mauricienne », les deux mots restent entiers. Un premier jet rendait
le libellé insécable — la colonne devenait alors incompressible et repoussait le NET
hors de l'écran sous 640 px, ce qui inverse la règle du projet (un libellé cède,
jamais un chiffre). Mesuré après correction : plus de défilement ni de Net masqué
dès 480 px.

## 3. Centre du donut — `DONUT-CENTRE-DEBORDE1`

`AVANT-3-donut.png` → `APRES-3-donut.png` (+ `-survol` pour l'état 3 lignes)
Écran : `/demo/graphiques-states`.

Le trou est un **cercle** : une ligne décalée du centre dispose d'une corde, pas du
diamètre. Comparer le texte au diamètre (128 px) concluait à tort que ça tenait.

| | Montant | Corde à sa hauteur | Verdict |
|---|---|---|---|
| avant | 127,9 px | 120,2 px | **7,7 px sur l'anneau** |
| après | 113,7 px | 134,2 px | 20,5 px de marge |

L'épaisseur d'anneau reste 36 unités : le trou s'agrandit, la donnée n'est pas
rognée.

## Responsive

Contrôlé à 375 / 480 / 640 / 1024 / 1440 px. Un premier jet élargissait le popover
à 360 px à toutes les tailles : ancré à droite, il grandit vers la gauche et sortait
du viewport sous 640 px (−44 px à 480 px). Corrigé par un garde `sm:`.

La table du total défile dans son propre conteneur sans jamais faire défiler la page.
Ce défilement ne subsiste qu'à 375 px : trois colonnes de montants insécables plus une
colonne de libellé ne tiennent pas dans 293 px, et raboter un chiffre est exclu. La
zone est donc rendue atteignable au clavier (`role="region"` + `tabIndex=0`), sans
quoi le Net serait inaccessible sans souris.

## Revue contradictoire

Le lot a été revu par un contexte indépendant avant push. Trois constats retenus et
corrigés dans la branche :

- le stub de démo renvoyait ses totaux **inconditionnellement** : le bandeau se
  superposait à l'état vide « aucune transaction ne correspond », un écran que la prod
  ne produit jamais. Seule la cardinalité suit désormais le filtre ;
- la décision tracée dans `types-transactions.ts` nommait la démo comme ne fournissant
  pas `sommeNette` : amendée plutôt que laissée en contradiction ;
- la case à cocher flottait à mi-hauteur des options sur deux lignes (`items-center`).

## Réserves

- ~~Un montant à 10 chiffres et plus (« Rs 999 999 999,00 ») resterait à l'étroit au
  centre du donut. Aucune fixture ne le couvre : signalé plutôt que corrigé à
  l'aveugle.~~ **Levée** — la production a produit le cas (Rs 12 188 030 422,92, qui
  mordait de 18,9 px). La fixture manquante a été ajoutée à la démo et le total central
  passe au format compact : `docs/qa/donut-total-central/README.md`.
- `/demo/perimetre-states` défile horizontalement à 375 px. Le coupable est le faux
  header de la page de démo (`div.ml-auto`, 311 px), pas le sélecteur — préexistant,
  hors périmètre de ce lot.
- Les popovers du design system demandent aussi 16 px de padding (§2.2) ; celui-ci
  est à 8 px. Non touché : l'augmenter reprendrait 16 px de largeur au nom de compte,
  ce que ce lot cherche justement à gagner.
