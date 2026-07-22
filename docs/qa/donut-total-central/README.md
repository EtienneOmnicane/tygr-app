# QA — Total central du donut (`DONUT-CENTRE-DEBORDE1`, clôture)

Écran : `/demo/graphiques-states` (sections `#courants`, `#seuil`, `#gros-multi`,
`#gros-mono`). Mesuré à 1440 px sous `next start` HTTP — l'hydratation ne survit pas au
proxy HTTPS, et un `next dev` mesuré donnerait des largeurs qui ne sont pas celles de
la production.

## Ce que le lot précédent avait laissé ouvert

`docs/qa/polish-front-demo/README.md` §3 avait élargi les rayons de l'anneau, puis
consigné une réserve : « un montant à 10 chiffres et plus resterait à l'étroit au
centre du donut. Aucune fixture ne le couvre : signalé plutôt que corrigé à
l'aveugle. » La production a produit le cas (Rs 12 188 030 422,92).

Le point à retenir : **la démo plafonnait à 7 chiffres**, donc la Gate 4 passait au vert
sans mentir — sur un écran qui n'exposait simplement pas le défaut. La fixture manquante
était le maillon, pas la mesure.

## Protocole

Le trou est un **cercle** : une ligne de texte n'y dispose pas du diamètre mais d'une
**corde**. On mesure la largeur du texte (`Range.getBoundingClientRect` — pas le span,
qui est un flex item plus large que son contenu) contre la corde prise au **bord du
texte le plus éloigné du centre**, soit la plus courte que la ligne traverse. Mesure
conservatrice : elle ne peut pas déclarer « ça tient » à tort.

## La correction : un seuil mesuré, pas un compact partout

Le premier jet compactait le total **inconditionnellement**. La revue contradictoire l'a
bloqué, à juste titre : `UI_GUIDELINES` §4.2 réserve le compact aux **axes** et exige le
format complet dans le **readout**, or le centre du donut est un readout. Compacter un
total qui tenait affichait « Rs 4,9 M » pour Rs 4 987 654,32 — 87 654 Rs escamotés sans
signal, sur le chiffre le plus lu de l'écran, et pour rien.

Le seuil de bascule a donc été **calibré par mesure** (montants pleins de 6 à 14
chiffres injectés dans le span réel du centre) :

| Chiffres | Préfixe `Rs …` | Repli `… GBP` |
|---|---|---|
| 7 | 117,7 px ✅ | 133,7 px ✅ |
| **8** | **127,8 px ✅** | **143,7 px ❌** |
| 9 | 137,8 px ❌ | 153,8 px ❌ |

Corde disponible : 135,3 px. D'où **deux** seuils et non un : le code ISO en suffixe
coûte ~16 px de plus que le symbole en préfixe. Les aligner sur le pire cas ferait
résumer des montants à 8 chiffres qui tiennent — or c'est l'ordre de grandeur courant
d'un total mensuel en MUR, précisément celui qu'on ne veut pas dégrader.

> ⚠️ **`tabular-nums` ne garantit PAS une chasse fixe ici.** Mesuré dans le span réel,
> police chargée : « 99 999 999,99 » = 111,1 px mais « 11 111 111,11 » = 106,6 px, soit
> **4,5 px d'écart à cardinalité égale** (la classe est bien appliquée —
> `fontVariantNumeric: tabular-nums` — mais la police effective ne l'honore pas).
> Conséquence pour qui recalibrera : mesurer avec des **9**, jamais avec un montant
> d'exemple, sinon le seuil est optimiste de ~5 px. Le tableau ci-dessus est en 9 ; le
> tableau de résultats plus bas donne les montants réels, donc plus étroits — les deux
> ne sont pas comparables ligne à ligne, et c'est la calibration qui fait foi.

## Résultats (1440 px, montants réels de la démo — cf. l'avertissement ci-dessus)

| Cas | Total | Avant | Après | Verdict |
|---|---|---|---|---|
| MUR courant | `Rs 4 500 000,00` | 113,7 px | **inchangé**, plein | +21,6 |
| USD courant | `$ 128 000,00` | 93,5 px | **inchangé**, plein | +41,8 |
| EUR courant | `€ 24 500,00` | 87,1 px | **inchangé**, plein | +48,2 |
| **Seuil MUR 8 ch.** | `Rs 12 345 678,90` | 123,7 px | plein **conservé** | +11,6 (+7,5 en 9) |
| **Seuil GBP 8 ch.** | `12 345 678,90 GBP` | déborde | `12,3 M GBP` | +51,0 |
| **MUR 11 ch.** | `Rs 12 188 030 422,92` | **−18,9** | `Rs 12,1 Md` | +57,0 |
| **GBP 12 ch.** | `999 888 777 666,55 GBP` | **−45,3** | `999,8 Md GBP` | +30,1 |

Part survolée (3 lignes, montant plus centré, corde 138,3 px) : `600 Md GBP` = 90,2 px,
marge 48,1. En plein la même part écrirait `600 000 000 000,00 GBP` : c'est ce qui a
tranché la question laissée ouverte au brief — le même seuil s'applique à la part, qui
occupe le même trou.

Le donut est borné par `max-w-[220px]` : rendu **identique** à 375 / 768 / 1440 px
(vérifié). Le mono-devise ne diffère donc pas du multi, malgré sa carte pleine largeur.

### La fixture qui discrimine

`#seuil` porte le même montant (8 chiffres) dans les **deux** gabarits de devise, et
attend deux rendus différents. C'est le seul jeu capable de prouver que les deux seuils
existent : avec des cardinalités différentes de part et d'autre, un seuil unique
passerait le test sans qu'on le voie. Ne pas le retirer.

## Le piège du lot : une infobulle morte

Le montant exact devait rester accessible quand on résume, donc `title`. Mais l'overlay
du centre porte `pointer-events-none` (il couvre des secteurs) : **une infobulle native
n'y est jamais déclenchée** — verte au lint, invisible à l'usage, et aucun gate ne
l'aurait dit.

Corrigé par `pointer-events-auto` sur le seul span concerné, puis **prouvé** via
`elementFromPoint` sur chaque donut : `montant_recoit_pointeur: true` partout (l'infobulle
se déclenche) et `anneau_reste_path: true` partout (le span ne vole pas le pointeur aux
secteurs).

⚠️ Deux artefacts de mesure, notés parce qu'ils font conclure faux :
`elementFromPoint` rend `null` **hors viewport** — sans scroller chaque donut avant de
sonder, tout donut sous la ligne de flottaison rend un faux « personne ne reçoit le
pointeur » ; et sur le cas mono-catégorie (EUR) l'anneau est un `<circle>`, pas un
`<path>`, donc une assertion `tagName === 'path'` y échoue sans qu'il y ait de défaut.

## Accessibilité

Quand — et seulement quand — le montant est résumé, l'exact reste atteignable par
l'infobulle et par un `sr-only` posé en **frère** du span visible (imbriqué, il serait
agrégé au nom accessible et ferait annoncer le montant deux fois : convention retenue en
cross-review, cf. `components/ui/action-protegee.tsx`). Pour les parts, la légende
affiche de toute façon chaque montant en entier, sans changement.

**Limite connue, non résolue ici** : au-delà du seuil, un utilisateur voyant **sur
tactile** n'a pas de chemin vers le total exact (`title` est une affordance souris). Le
montant ne peut alors physiquement pas s'écrire en entier dans l'anneau ; le résoudre
demande d'exposer le total ailleurs dans la carte, ce qui est un arbitrage de maquette.
Consigné en TODOS (`DONUT-TOTAL-TACTILE1`, P2).

## Rebase sur #241 (axe catégorie effective)

La branche a été rebasée sur `main` après le merge de #241, qui rend `origine` et
`categorieId` **obligatoires** sur `PartCategorie`. Les 4 fixtures de ce lot ont été
complétées part par part, selon l'invariant du type :

- `estNonCategorise: false` → `origine: "AMONT"`, `categorieId: null` — ce sont des
  totaux bancaires bruts, sans ventilation TYGR (un `categorieId` n'existe que pour
  `origine: "TYGR"`) ;
- `estNonCategorise: true` → `origine: "AUCUNE"`, `categorieId: null` — l'invariant est
  une équivalence : `estNonCategorise === true ⟺ origine === "AUCUNE"`.

Vérifié programmatiquement sur les **33 parts** du fichier (pas seulement les 11 de ce
lot) : aucune violation des deux invariants, aucun `categorieId` dupliqué. Les mesures
du centre sont **inchangées** après rebase — #241 ne touche pas le donut.

**Observation hors périmètre, pour le QA humain** : avec les badges « banque » de #241,
une légende qui combine des libellés longs et des montants à 12 chiffres tronque très
fort le libellé (« F… », « In… » sur la carte GBP — cf. `APRES-gros-multi.png`). La
règle est respectée (un libellé cède, jamais un chiffre), mais la lisibilité est faible
sur ce cas. Il n'est pas créé par ce lot ; il est seulement **rendu visible** par ses
fixtures à gros montants. À arbitrer côté légende, pas côté donut.

## Gates

`lint` ✅ · `typecheck` ✅ · `build` ✅ · 781 tests unitaires ✅ ·
suite isolation complète 716/716 ✅ (post-rebase)

La bascule elle-même est couverte par `tests/unit/format-centre.test.ts` : muter un
seuil d'un rang casse un test. Elle ne dépend plus du seul Visual QA — c'était le
défaut relevé en seconde revue (les 771 tests d'alors restaient verts avec un seuil
faux).
