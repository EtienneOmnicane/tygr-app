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
(UI_GUIDELINES §221), soit ~245 px utiles pour un nom qui en demande 323. C'est le
passage à la ligne (`break-words`) qui affiche le nom entier ; les 60 px gagnés ne
font qu'économiser des retours à la ligne.

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

La table du total défile dans son propre conteneur sur mobile (520 px de contenu
dans 293 px de large) sans faire défiler la page.

## Réserves

- Un montant à 10 chiffres et plus (« Rs 999 999 999,00 ») resterait à l'étroit au
  centre du donut. Aucune fixture ne le couvre : signalé plutôt que corrigé à
  l'aveugle.
- `/demo/perimetre-states` défile horizontalement à 375 px. Le coupable est le faux
  header de la page de démo (`div.ml-auto`, 311 px), pas le sélecteur — préexistant,
  hors périmètre de ce lot.
- Les popovers du design system demandent aussi 16 px de padding (§221) ; celui-ci
  est à 8 px. Non touché : l'augmenter reprendrait 16 px de largeur au nom de compte,
  ce que ce lot cherche justement à gagner.
