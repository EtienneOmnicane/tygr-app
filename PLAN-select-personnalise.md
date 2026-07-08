# PLAN — Select personnalisé (menus déroulants + fix scroll banques)

Statut : conception (Règle 1). Aucune ligne de composant avant ce fichier.
Date : 2026-07-08 · Effort estimé : ~2 h CC · Déclencheur : retour Etienne
(« les menus déroulants ne sont pas beaux » + « bug de scroll sur les banques
dans Transactions »).

## 1. Contexte & diagnostic

Les deux remontées ont **une seule cause** : ce sont des `<select>` **natifs**.
La liste ouverte d'un `<select>` est dessinée par l'OS (macOS), donc :

- **Non stylable** : ni tokens, ni `rounded-control`, ni `shadow-popover` — d'où
  « pas beaux ». Le contrôle fermé est stylé, mais la liste déroulée ne l'est jamais.
- **Bug de scroll (Transactions → compte)** : le filtre par compte liste ~12
  banques × N comptes en `<optgroup>`. Le popup natif devient très haut et son
  défilement est géré par l'OS (comportement erratique signalé). Un popup maison à
  hauteur bornée (`max-h-72` + `overflow-y-auto`) supprime le problème.

Correctif unique : un composant liste maison (div `role="listbox"`), qui règle
l'esthétique **et** le scroll d'un coup.

## 2. Pushback (Règle 10)

- **Coût réel** : un `<select>` maison n'est pas un one-liner CSS. Il faut
  reprendre à la main ce que le natif offre gratuitement : navigation clavier,
  focus, ARIA, clic-extérieur, typeahead, positionnement. Risque = régression
  d'accessibilité si bâclé.
- **Mitigation** : on ne part PAS de zéro. On **généralise le pattern déjà en
  prod** `CategoryPicker` (popover `role="listbox"`, clic-extérieur `mousedown`,
  Échap en capture, `max-h-72 overflow-y-auto`, `shadow-popover`). On ajoute la
  nav clavier (flèches/Entrée/Home/End) + typeahead que le picker n'avait pas.
- **Zéro nouvelle dépendance** (Règle 9) : pas de Radix/Headless UI. `cn` local,
  SVG inline.
- **Alternative écartée** : styliser le natif (impossible pour la liste ouverte)
  ou n'ajuster que la hauteur (ne résout pas l'esthétique). Décision : composant.

## 3. API du composant (`src/components/ui/select/select.tsx`)

Contrôlé (miroir du natif `value` / `onChange`) :

```ts
interface OptionSelect { value: string; label: string; disabled?: boolean }
interface GroupeSelect { label: string; options: OptionSelect[] }  // label "" = sans en-tête

function Select({
  value: string;
  onChange: (value: string) => void;
  options?: OptionSelect[];   // liste plate…
  groups?: GroupeSelect[];    // …OU groupée (compte par institution)
  placeholder?: string;       // libellé du trigger si value ne matche rien
  disabled?: boolean;
  size?: "sm" | "md";         // h-8 text-xs / h-10 text-sm (défaut md)
  id?: string;                // association <label htmlFor>
  ariaLabel?: string;
  className?: string;         // largeur/layout additionnel sur le trigger
}): JSX.Element
```

- **Trigger** = `<button type="button">` stylé comme les champs actuels
  (`border-line bg-surface-card rounded-control` + chevron), aria-haspopup=listbox,
  aria-expanded. Le libellé affiché = option dont `value` matche (sinon `placeholder`).
- **Popup** = `absolute z-50 mt-1 max-h-72 min-w-full overflow-y-auto
  rounded-control border border-line bg-surface-card p-1 shadow-popover`.
  En-tête de groupe si `label` non vide (`text-[11px] uppercase text-text-faint`).
- **Option** = `<button role="option" aria-selected>` ; sélectionnée →
  `bg-primary-50`, sinon `hover:bg-surface-inset` ; `disabled` inerte/atténué.

## 4. Comportement (parité natif)

- **Ouverture/fermeture** : clic trigger toggle ; clic-extérieur (`mousedown` doc)
  et Échap ferment (Échap en capture + `stopImmediatePropagation` pour ne pas
  fermer une modale parente — repris de CategoryPicker). Fermeture → refocus trigger.
- **Clavier** : Entrée/Espace/Flèche ouvre ; Flèches ↑/↓ déplacent le surlignage
  (sautent les `disabled`) ; Entrée/Espace valide ; Échap ferme ; Home/End ;
  **typeahead** (frappe → 1re option qui commence par le tampon). Option active
  `scrollIntoView({ block: "nearest" })`.
- **Désactivé** : trigger `disabled` (opacité + non cliquable), aucune ouverture.

## 5. Portée (cette itération)

Les 3 écrans vus par Etienne (4 fichiers, 10 selects contrôlés) :

- `transactions/transactions-toolbar.tsx` — compte (groupé institution) + statut.
- `echeances/echeance-form.tsx` — sens, devise, catégorie, récurrence, entité.
- `echeances/echeances-list.tsx` — statut (taille sm).
- `regles/regle-form.tsx` — matchType + catégorie cible (option placeholder disabled).

**Hors périmètre (fast-follow, non vus par Etienne)** : `category-manager-modal.tsx`,
`admin/entites/propositions.tsx`, `admin/membres/formulaire-provisioning.tsx`
(ce dernier = select non contrôlé de `<form>` → nécessite input caché, refacto à part).
Tracé pour ne pas laisser d'incohérence pourrir (Règle 9).

## 6. Critères de sortie

- `npm run typecheck` + `npm run lint` verts.
- Aucune couleur en dur, tokens uniquement ; erreurs/désactivé conformes.
- Parité clavier/ARIA avec le natif (listbox/option, flèches, Échap, focus).
- Visual QA des écrans modifiés par Etienne sur son Mac (Gate 4) avant merge.
- Human-in-the-Loop : je m'arrête à la PR poussée (changement applicatif).
