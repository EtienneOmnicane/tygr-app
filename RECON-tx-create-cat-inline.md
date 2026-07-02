# RECON — TX-QA-CREATE-CAT-INLINE1

**Ticket** : permettre de créer une catégorie SANS quitter la modale de ventilation
(`split-allocation-modal`), pour ne plus perdre le contexte de ventilation en cours.
**Passe** : RECON en **lecture seule** — aucune modification de source, aucune branche,
aucun commit. Seule écriture = cette note.
**Date** : 2026-07-01.

---

## ⚠️ Garde-fou git (étape 0)

`git rev-parse --show-toplevel` lancé depuis le répertoire de session affiche
`/Users/clawdy/Desktop/TYGR` (le **dépôt PARENT piège**, conteneur gstack imbriqué),
PAS `…/tygr-app`. **MAIS** `tygr-app/` **possède son propre `.git`** :

```
$ git -C /Users/clawdy/Desktop/TYGR/tygr-app rev-parse --show-toplevel
/Users/clawdy/Desktop/TYGR/tygr-app
$ git -C /Users/clawdy/Desktop/TYGR/tygr-app branch --show-current
main
```

Le `git` initial visait le parent uniquement parce que le shell démarre à la racine.
**Consigne pour toute passe d'implémentation** : préfixer les commandes git par
`git -C /Users/clawdy/Desktop/TYGR/tygr-app …` (ou `cd` d'abord) pour ne jamais opérer
dans le dépôt parent. Le vrai dépôt de travail = `tygr-app/` (branche `main`).

---

## 🟢 CONCLUSION CENTRALE (à lire en premier)

> **Le raccordement inline demandé est DÉJÀ FAIT et fonctionnel sur le chemin réel
> `/transactions`.** Créer une catégorie depuis la modale de ventilation **ne provoque
> aujourd'hui AUCUNE navigation, AUCUN `router.refresh()`, AUCUN démontage de modale et
> AUCUNE perte de contexte de ventilation.** Le flux passe intégralement par le bloc de
> création inline du picker + un ajout local optimiste dans la modale.

Le mécanisme redouté par le ticket (« lancer une création renvoie vers l'écran de gestion
et fait perdre le contexte ») **n'existe pas dans le chemin `/transactions`**. Il n'y a
**aucun** `router.push`, `Link`, ni ouverture de `CategoryManagerModal` depuis la
`SplitAllocationModal`. Le `CategoryManagerModal` (écran de gestion) n'est monté **que**
par les pages `demo/*` et n'est **jamais** déclenché depuis la modale de ventilation.

**Le ticket est donc, à première vue, déjà satisfait.** Recommandation pour l'ouverture de
la passe d'implémentation : traiter ce ticket comme une **vérification runtime + éventuel
polissage**, PAS comme du raccordement neuf. Voir §« Zones à re-tester / hypothèses » plus bas.

---

## 1. Sélection de catégorie dans la modale

`src/components/ui/category/split-allocation-modal.tsx` — chaque ligne de ventilation ouvre
un `CategoryPicker` en popover (contrôlé par l'état local `pickerOuvert`). VERBATIM
(`:335-391`) :

```tsx
{/* Sélecteur de catégorie (large, peut rétrécir sans déborder — #156) */}
<div className="relative min-w-0 sm:flex-1">
  <button
    type="button"
    onClick={() =>
      setPickerOuvert(pickerOuvert === ligne.cle ? null : ligne.cle)
    }
    className={cn(
      `flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-control
      border bg-surface-inset px-3 text-sm text-text
      focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`,
      enDoublon ? "border-danger" : "border-line",
    )}
  >
    {cat ? (
      <span className="min-w-0 truncate">
        <CategoryBadge name={cat.name} colorKey={cat.id} size="sm" />
      </span>
    ) : (
      <span className="truncate text-text-faint">Choisir une catégorie</span>
    )}
    <span aria-hidden className="shrink-0 text-text-muted">▾</span>
  </button>
  {pickerOuvert === ligne.cle && (
    <div className="absolute left-0 top-11 z-20">
      <CategoryPicker
        categories={categoriesLocales}
        selectedId={ligne.categoryId}
        onSelect={(categoryId) => {
          majLigne(ligne.cle, { categoryId });
          setPickerOuvert(null);
        }}
        onClose={() => setPickerOuvert(null)}
        onCreate={
          onCreateCategorie
            ? async (name) => {
                const res = await onCreateCategorie(name);
                // Ajout local (affichage immédiat du badge) ; le
                // picker sélectionne ensuite la nouvelle catégorie.
                if (res.ok) {
                  setCategoriesCreees((prev) => [
                    ...prev,
                    {
                      id: res.data.categoryId,
                      name: name.trim(),
                      parentId: null,
                      isActive: true,
                    },
                  ]);
                }
                return res;
              }
            : undefined
        }
      />
    </div>
  )}
</div>
```

**Oui**, la modale utilise `category-picker.tsx`. La liste passée au picker est
`categoriesLocales` = **props `categories` + catégories créées localement** (voir §5).

---

## 2. Point d'entrée « créer une catégorie » depuis la modale

**Il n'y a PAS de navigation ni d'ouverture d'un autre modal.** La création se fait
**exclusivement** via le bloc inline du picker, câblé par le prop `onCreate` (extrait
ci-dessus, `:367-388`). Le handler exact fait deux choses au succès :

1. **ajout local optimiste** dans `setCategoriesCreees` (badge visible immédiatement) ;
2. **retourne `res`** au picker, qui enchaîne la **sélection** de la nouvelle catégorie.

La modale déclare le prop et le documente (`:96-104`) :

```tsx
/**
 * Crée une catégorie (Nature racine) depuis le picker (→ creerCategorieAction).
 * Optionnel : absent → pas de bouton « Ajouter une catégorie ». La catégorie
 * créée est ajoutée localement (affichage immédiat) puis sélectionnée.
 */
onCreateCategorie?: (
  name: string,
) => Promise<ResultatAction<{ categoryId: string }>>;
```

**Recherche exhaustive de navigation/gestionnaire alternatif** (résultat : néant dans ce
chemin) :
- `router.push` / `router.refresh` / `Link` : **absents** de `split-allocation-modal.tsx`,
  `category-picker.tsx`, `transactions-feature.tsx`.
- `CategoryManagerModal` : monté **uniquement** par `src/app/demo/category-states/page.tsx`
  et `src/app/demo/transactions/page.tsx`. **Jamais** ouvert depuis la modale de
  ventilation ni depuis `/transactions`.

---

## 3. Bloc de création inline du picker

`src/components/ui/category/category-picker.tsx` — composant interne `CreationCategorie`
(rendu en pied de picker seulement si `onCreate` est fourni, `:176-186`).

**Montage conditionnel + relais de sélection après création** (`:176-186`) :

```tsx
{/* Pied : création rapide d'une catégorie (si le conteneur la câble). */}
{onCreate && (
  <CreationCategorie
    nomInitial={recherche}
    onCreate={onCreate}
    onCree={(categoryId) => {
      onSelect(categoryId);
      onClose?.();
    }}
  />
)}
```

**État local + handler de soumission + appel action + gestion erreur** (`:230-277`) :

```tsx
function CreationCategorie({
  nomInitial,
  onCreate,
  onCree,
}: {
  nomInitial: string;
  onCreate: (name: string) => Promise<ResultatAction<{ categoryId: string }>>;
  onCree: (categoryId: string) => void;
}) {
  const [deplie, setDeplie] = useState(false);
  const [nom, setNom] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const champRef = useRef<HTMLInputElement>(null);

  function ouvrir() {
    setNom(nomInitial.trim());
    setErreur(null);
    setDeplie(true);
    // Focus le champ au prochain tick (après rendu).
    requestAnimationFrame(() => champRef.current?.focus());
  }

  function annuler() {
    setDeplie(false);
    setNom("");
    setErreur(null);
  }

  async function soumettre() {
    const valeur = nom.trim();
    if (valeur === "" || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      const res = await onCreate(valeur);
      if (res.ok) {
        annuler();
        onCree(res.data.categoryId);
      } else {
        setErreur(res.message);
      }
    } catch {
      setErreur("La création a échoué. Réessayez.");
    } finally {
      setEnCours(false);
    }
  }
```

### COMMENT la liste est rafraîchie après création (question clé du point 3)

**PAS de refetch, PAS de `router.refresh()`, PAS d'invalidation.** Le rafraîchissement est
une **mise à jour optimiste locale à DEUX niveaux**, sans aucun aller-retour de liste :

1. **Dans le picker** : `onCree(res.data.categoryId)` → `onSelect(categoryId)` + `onClose()`.
   Le `onSelect` du picker est fourni par la modale et fait `majLigne(ligne.cle, { categoryId })`
   (la ligne de ventilation pointe sur la nouvelle catégorie).
2. **Dans la modale** : le wrapper `onCreate` (§1) a **déjà** poussé la nouvelle catégorie
   dans `categoriesCreees`, donc `categoriesLocales` la contient → le `CategoryBadge`
   s'affiche immédiatement.

Le référentiel « source » (`props.categories`, venu du RSC) n'est PAS rechargé pendant la
session de la modale — c'est **assumé** dans le commentaire de la modale (`:119-122`) :

```tsx
// Catégories créées localement (depuis le picker), pas encore dans les props
// (le conteneur recharge le référentiel au prochain rendu). On les CONCATÈNE aux
// props plutôt que de dupliquer tout l'état (évite un setState/effect de synchro).
const [categoriesCreees, setCategoriesCreees] = useState<CategorieUI[]>([]);
const categoriesLocales = useMemo(
  () => [...categories, ...categoriesCreees],
  [categories, categoriesCreees],
);
```

> C'est précisément CE choix (concaténation locale, zéro refetch) qui **préserve** le
> contexte de ventilation : les montants saisis dans `lignes` ne sont jamais réinitialisés.

---

## 4. Server Action de création de catégorie

**Action** : `src/app/(workspace)/transactions/actions.ts:230-247` — VERBATIM :

```tsx
/** Crée une catégorie (Nature si parentId nul, sinon Sous-nature). ADMIN uniquement. */
export async function creerCategorieAction(input: {
  name: string;
  parentId: string | null;
}): Promise<ResultatAction<{ categoryId: string }>> {
  const session = await exigerSessionWorkspace();
  const parsed = creerCategorieSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    const r = await withWorkspace(session, (tx, ctx) =>
      creerCategorie(tx, ctx, parsed.data),
    );
    return { ok: true, data: r };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "creer-categorie");
  }
}
```

**Schéma zod** : `src/lib/categorisation-schema.ts:104-112` — VERBATIM :

```ts
/** Nom de catégorie : non vide après trim, ≤ 120 (aligné varchar(120) en base). */
const nomCategorie = z.string().trim().min(1, "Nom requis").max(120);

export const creerCategorieSchema = z
  .object({
    name: nomCategorie,
    parentId: z.string().uuid().nullable().default(null),
  })
  .strict();
```

**FORME DU RETOUR** : `ResultatAction<{ categoryId: string }>`. Au succès →
`{ ok: true, data: { categoryId } }`. **Renvoie l'`id`, PAS le `name`** : c'est pourquoi la
modale reconstruit l'objet `CategorieUI` côté client à partir du `name` qu'elle a saisi
(`{ id: res.data.categoryId, name: name.trim(), parentId: null, isActive: true }`, §1).

**Garde de rôle / tenant** — le repository porte la garde (l'action ne la duplique pas) :
`src/server/repositories/categorisation.ts:502-517` :

```ts
export async function creerCategorie<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: { name: string; parentId: string | null },
): Promise<{ categoryId: string }> {
  exigerAdminReferentiel(ctx);
  const inserted = await tx
    .insert(categories)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      parentId: input.parentId,
    })
    .returning({ id: categories.id });
  return { categoryId: inserted[0].id };
}
```

avec la garde ADMIN (`:463-467`) :

```ts
function exigerAdminReferentiel(ctx: WorkspaceContext): void {
  if (ctx.role !== "ADMIN") {
    throw new CategorieNonAutoriseeError();  // code "CATEGORY_NOT_AUTHORIZED"
  }
}
```

> ⚠️ **Point d'attention métier (à valider, pas un bug de câblage)** : la création de
> catégorie est **ADMIN-only** (décision PO 2026-06-22 tracée `:441-448`). Un membre
> **non-ADMIN** verra donc le bouton « Ajouter une catégorie » (le prop est câblé
> inconditionnellement, cf. §5) mais recevra `CATEGORY_NOT_AUTHORIZED` au « Créer »,
> affiché inline dans le picker. La modale **reste ouverte** (pas de perte de contexte),
> mais l'UX « bouton visible → échec au clic » pour un non-ADMIN est à arbitrer
> (masquer le bouton si non-ADMIN ? ou l'assumer ?). Hors périmètre strict du ticket,
> à signaler.

---

## 5. Alimentation des catégories

**Source = RSC parent**, `src/app/(workspace)/transactions/page.tsx`. Pas de fetch client.

**Chargement + mapping en `CategorieUI`** (`:63-73`) :

```tsx
// Données serveur : catégories (modale), comptes (filtre + résolution compteNom).
const [categoriesDTO, comptes] = await Promise.all([
  listerCategoriesAction(),
  withWorkspace(session, (tx) => listerComptes(tx)),
]);

const categories: CategorieUI[] = categoriesDTO.map((c) => ({
  id: c.id,
  name: c.name,
  parentId: c.parentId,
  isActive: c.isActive,
}));
```

**Server Action de création, adaptée en Nature racine, passée au conteneur** (`:121-146`) :

```tsx
// Création rapide depuis le picker : une catégorie créée ainsi est une Nature
// (parentId null). Adapte la signature `(name) → action({name, parentId})`.
async function creerCategorieNature(name: string) {
  "use server";
  return creerCategorieAction({ name, parentId: null });
}

return (
  <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
    …
    <TransactionsFeature
      initial={initial}
      categories={categories}
      comptes={comptesFiltre}
      actions={actionsTransactions}
      remplacerSplits={remplacerSplitsAction}
      creerCategorie={creerCategorieNature}
      aucuneBanque={aucuneBanque}
    />
  </main>
);
```

**Relais conteneur → modale**, `src/components/transactions/transactions-feature.tsx:296` :

```tsx
onCreateCategorie={creerCategorie}
```

(Le prop `creerCategorie` du conteneur est optionnel `:73-75` ; ici il est **toujours**
fourni par la page → le bouton « Ajouter une catégorie » est **toujours visible** sur
`/transactions`, y compris pour un non-ADMIN — cf. avertissement §4.)

### Chaîne d'alimentation complète (résumé)

```
RSC page.tsx
  listerCategoriesAction() ─────────────► categories: CategorieUI[]  ─┐
  creerCategorieNature (server action) ─► creerCategorie             ─┤
                                                                      ▼
        <TransactionsFeature categories=… creerCategorie=… />
                                                                      ▼
        <SplitAllocationModal categories=… onCreateCategorie=… />
          categoriesLocales = [...props.categories, ...categoriesCreees]
                                                                      ▼
        <CategoryPicker categories={categoriesLocales} onCreate=… />
          <CreationCategorie onCreate=… onCree={select + close} />
```

Le rafraîchissement « dur » du référentiel n'intervient qu'au **prochain rendu du RSC**
(navigation / rechargement de page), hors session de modale — ce qui est **voulu** et
sans impact sur le contexte de ventilation courant.

---

## QUESTION CENTRALE — qu'est-ce qui fait perdre le contexte aujourd'hui ?

**RÉPONSE : RIEN, sur le chemin `/transactions`.** Preuve :

- **Pas de navigation** : `grep` de `router.push|router.refresh|redirect|Link` dans
  `split-allocation-modal.tsx`, `category-picker.tsx`, `transactions-feature.tsx` →
  **aucune occurrence**.
- **Pas de remplacement de modale** : la création n'ouvre **pas** `CategoryManagerModal`
  (jamais monté depuis `/transactions` ; uniquement dans `demo/*`).
- **Pas de reset d'état** : la nouvelle catégorie est **ajoutée localement**
  (`setCategoriesCreees`) et **sélectionnée** (`majLigne`) ; l'état `lignes` (montants
  saisis) n'est jamais réinitialisé. Le picker se ferme (`onClose`), la modale de
  ventilation **reste montée et ouverte**.

**Hypothèse sur l'origine du ticket** (à confirmer avec l'auteur) : le libellé
« renvoie vers l'écran de gestion » décrit vraisemblablement soit (a) un **état antérieur**
du code déjà corrigé, soit (b) un **autre point d'entrée** de création (p. ex. depuis
la page `/regles` ou un ancien lien vers `CategoryManagerModal`), soit (c) une confusion
avec le **cas non-ADMIN** (le « Créer » échoue avec un message, ce qui peut être *ressenti*
comme « ça n'a rien fait / j'ai perdu ma saisie » alors que la modale reste en fait ouverte).
À trancher en **QA runtime** avant toute implémentation.

---

## À NOTER SANS CORRIGER — débordement du bloc inline (ticket voisin TX-QA-CREER-CAT-OVERFLOW1)

Le conteneur du picker est **fixe à `w-[320px]`** (`category-picker.tsx:130`) :

```tsx
<div
  ref={conteneurRef}
  className="w-[320px] rounded-control bg-surface-card p-2 shadow-popover"
>
```

Le bloc déplié « champ + Créer + Annuler » est une **rangée flex à 3 enfants**
(`category-picker.tsx:297-346`) :

```tsx
<div className="mt-2 border-t border-line pt-2">
  <div className="flex items-center gap-2">
    <input
      …
      className="h-9 min-w-0 flex-1 rounded-control border border-line bg-surface-inset px-3
        text-sm text-text placeholder:text-text-faint focus:border-primary
        focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-48"
    />
    <button …>            {/* Créer  */}
      className="inline-flex h-9 shrink-0 cursor-pointer … bg-primary px-3 …"
    <button …>            {/* Annuler */}
      className="inline-flex h-9 shrink-0 cursor-pointer … px-2 …"
  </div>
```

Analyse (⚠️ **NON corrigée, chantier séparé**) :
- L'`input` a `min-w-0 flex-1` (peut rétrécir) ; les deux boutons ont `shrink-0`.
- Conteneur `w-[320px]` avec `p-2` (16px de padding H) ⇒ ~304px utiles ; `gap-2` (×2 = 16px)
  entre 3 enfants. Reste ~288px pour input + « Créer » + « Annuler ».
- Le risque de débordement pointé par le ticket voisin est **plausible** si les libellés/
  paddings des boutons `shrink-0` dépassent l'espace résiduel (l'input absorbe la
  compression mais les boutons non). Classes exactes ci-dessus pour le chantier dédié.

**Non modifié** conformément à la consigne.

---

## Zones à re-tester / hypothèses (pour la passe d'implémentation)

1. **QA runtime prioritaire** : ouvrir une ventilation sur `/transactions` **en tant
   qu'ADMIN**, créer une catégorie via le bloc inline, vérifier que (a) le badge apparaît,
   (b) la ligne est sélectionnée, (c) les montants saisis sont intacts, (d) la modale reste
   ouverte. → Si tout est vert, **le ticket est déjà satisfait** ; le clore ou le
   requalifier en « vérifié ».
2. **Cas non-ADMIN** (§4) : décider si le bouton « Ajouter une catégorie » doit être masqué
   quand `ctx.role !== "ADMIN"` (aujourd'hui visible → échec inline au clic). Nécessiterait
   de propager le rôle jusqu'au conteneur (non disponible côté client actuellement).
3. **Overflow** (TX-QA-CREER-CAT-OVERFLOW1) : chantier séparé, classes fournies ci-dessus.
4. **Rappel git** : opérer dans `tygr-app/` (`git -C …/tygr-app`), jamais le dépôt parent.

---

### Fichiers cartographiés (chemins:lignes clés)

| Rôle | Fichier | Lignes |
|---|---|---|
| Modale ventilation (prop + relais + ajout local) | `src/components/ui/category/split-allocation-modal.tsx` | 96-104, 119-126, 335-391 |
| Picker + bloc inline `CreationCategorie` | `src/components/ui/category/category-picker.tsx` | 130, 176-186, 230-277, 297-346 |
| Écran de gestion (NON impliqué ici) | `src/components/ui/category/category-manager-modal.tsx` | 71-84 (create) |
| Conteneur client `/transactions` | `src/components/transactions/transactions-feature.tsx` | 46-77, 272-298 |
| RSC page `/transactions` (alimentation) | `src/app/(workspace)/transactions/page.tsx` | 63-73, 121-146 |
| Server Action de création | `src/app/(workspace)/transactions/actions.ts` | 230-247 |
| Repository `creerCategorie` + garde ADMIN | `src/server/repositories/categorisation.ts` | 441-467, 502-517 |
| Schéma zod | `src/lib/categorisation-schema.ts` | 104-112 |
