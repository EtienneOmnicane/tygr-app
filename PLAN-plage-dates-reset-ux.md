# PLAN — PLAGE-DATES-RESET-UX1

> Deux bugs UX sur le « × » de la plage de dates. Fichier :
> `src/components/shell/plage-dates-switcher.tsx` (+ test). Cause racine déjà
> diagnostiquée dans le ticket — non re-cherchée.

## Bugs
1. **Cible trop petite** : le bouton « × » est `h-5 w-5` (20px) avec `text-xs` → dur à viser.
2. **Champs non vidés après reset** : au clic, `ecrire(null)` pose `dernierEcrit = "|"` ET
   nettoie l'URL. La `cleUrl` résultante (`"|"`) == `dernierEcrit` → le bloc de resynchro
   (l.80-86) conclut « écriture interne » et NE réinitialise PAS `du`/`au`. Le filtre
   disparaît mais les `<input>` gardent l'ancienne plage.

## Fix (fichier unique)
- **Bouton** : `h-5 w-5` → `h-6 w-6` (≥24px cliquable), glyphe `text-sm leading-none`
  (plus lisible). Tokens INCHANGÉS (`text-text-muted`/`hover:text-ink`, focus ring
  `primary`). Pas de `flex-wrap` (condensation `lg:flex` préservée).
- **Handler `effacerTout()`** : `setDu(""); setAu(""); ecrire(null);` — le geste « × » est
  un effacement VOLONTAIRE qui force le vidage. Le garde-fou `dernierEcrit` est **CONSERVÉ**
  (il protège la saisie en cours pendant l'édition : vider une borre ne doit pas effacer
  celle qu'on compose). `onClick={effacerTout}`.

## Testabilité (pas de renderer React au projet — logique pure extraite, pattern maison)
Extraire 2 fonctions pures **exportées**, iso-comportement (le composant les utilise) :
- `resyncDepuisUrl(cleUrl, dernierEcrit, plage)` → `{du,au} | null` : le garde-fou (notre
  propre écriture → `null` = ne pas écraser le brouillon ; sinon → réaligner sur l'URL).
- `parametresPlage(base, nouvelle)` → `URLSearchParams` : set/delete `du`/`au` en
  préservant les autres params (extrait de `ecrire`).

## Test (`tests/unit/plage-dates-reset.test.ts`)
- `parametresPlage` : `null` retire `du`/`au` et préserve les autres ; plage → pose `du`/`au`.
- `resyncDepuisUrl` : notre écriture (`cleUrl === dernierEcrit`) → `null` ; changement
  externe → `{du,au}` de la plage.
- **Séquence « × »** (compose les fonctions pures + setDu/setAu modélisés) : après le geste,
  `du=""`, `au=""` ET l'URL n'a plus `du`/`au`. Sans le vidage explicite, ils garderaient
  l'ancienne valeur (le trou).
- **Non-régression édition** : vider `au` (borne `du` remplie) → `du` reste rempli (garde-fou),
  `au` vide, preset rallumé.

## Garde-fous
`lirePlage` reste la source UNIQUE de validation (aucun parsing maison). Zéro serveur/RLS/
URL-contract. Tokens sémantiques uniquement.

## Gates + livraison
lint · typecheck · build · suite. Visual QA : « × » agrandi cliquable, après clic les 2
cases vides + un preset se rallume. Revue contexte frais (règle 6). Branche
`fix/plage-dates-reset-ux` depuis `main`, **stop à la PR poussée** (merge manuel).
