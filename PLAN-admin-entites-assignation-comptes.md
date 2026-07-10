# PLAN — `/admin/entites` : section « Assignation des comptes »

> **Rattachement** : nouveau lot **L7** de `PLAN-entites-multi-tenant.md` (Option B,
> entités sous le workspace). Ce document est le plan exigé par la règle 1 (séparation
> des phases) : aucune ligne de code applicatif avant qu'il n'existe sur disque.
>
> Date : 2026-07-10 · Branche cible : `feat/admin-entites-assignation-comptes`
> Phase : **conception**. L'implémentation référence ce fichier.

---

## 1. Objectif

Donner à l'ADMIN une surface **à plat** pour réassigner **n'importe quel** compte
bancaire du workspace à une entité (BU), ou le repasser en « non assigné »
(`entity_id = NULL`).

C'est aujourd'hui le **chaînon manquant** : l'ingestion ne pose jamais `entity_id`
(invariant CLAUDE.md), et le seul chemin d'assignation existant est le **sas de
propositions** (section 1 de la page), qui :

- ne couvre que les comptes **rattachés à une Party** Omni-FI ;
- ne sait **qu'assigner**, jamais **dé-assigner** (`entityId = null` inatteignable
  depuis le sas) ;
- travaille par lot (une party → N comptes), pas compte par compte.

Un compte sans party, ou mal rangé, n'a donc **aucune** issue en UI aujourd'hui.

## 2. Nature & périmètre

**Fonctionnalité**, pas un correctif ≤20 lignes (exception fermée de la règle 1 non
applicable) : elle ajoute une lecture serveur, un composant client, une surface UI, et
modifie une Server Action existante. → plan écrit, exit-criteria règle 3, cross-review
règle 6, Human-in-the-Loop.

### Hors périmètre (explicite)

- **Aucun montant / solde affiché.** Nom de compte + devise + entité, rien d'autre.
  Zéro `parseFloat`, zéro formatage monétaire (règle 8 — on n'ouvre pas la porte).
- Aucune migration, aucun changement de schéma, aucune nouvelle policy RLS.
- Aucune modification de `assignerCompteEntite` (écriture serveur) : elle est déjà
  gardée, bornée et prouvée.
- Aucune dépendance externe (règle 9) : `cn` local + SVG inline, composant `Select` maison.

## 3. Ce qui existe déjà — à NE PAS réimplémenter

Audit de l'existant réalisé **avant** ce plan (leçon `epic1-l31-pr2p-livres` : auditer le
code avant de planifier).

| Brique | Emplacement | État |
|---|---|---|
| Écriture gardée | `src/server/repositories/entites.ts` — `assignerCompteEntite` | ✅ complet |
| Server Action | `src/app/(workspace)/admin/entites/actions.ts` — `assignerCompteAction` | ✅ complet (à amender, cf. §7) |
| Composant `Select` maison | `src/components/ui/select` | ✅ complet |
| Primitives d'état | `src/components/ui/states` (`EmptyState`, `StateCard`) | ✅ complet |
| Preuves d'isolation de l'**écriture** | `tests/isolation/entites-admin-isolation.test.ts` (cas 2, 6, 7) | ✅ complet |

`assignerCompteEntite` porte déjà : garde `exigerAdmin(ctx)`, `UPDATE` borné
`workspace_id = ctx.workspaceId`, RLS `tenant_isolation` + `entity_scope`, FK composite
`(entity_id, workspace_id) → entities`, et les erreurs nommées `CompteIntrouvableError` /
`EntiteIntrouvableError` (404, jamais 403). **On ne touche à rien de tout ça.**

### ⚠️ Correction d'une référence du brief

Le brief cite `propositions.tsx` comme référence du pattern « `Select` contrôlé miroité
dans un `<input type="hidden">` ». **Ce pattern n'existe nulle part dans le repo** :
`propositions.tsx` utilise encore un `<select>` **natif** (qui poste tout seul), et les
5 usages actuels de `Select` (`regle-form`, `echeance-form`, `transactions-toolbar`,
`category-manager-modal`, `echeances-list`) passent tous par `onSubmit` + état React,
jamais par `<form action>` + `FormData`.

Le pattern reste **correct et nécessaire** (`Select` rend un `<button role="combobox">`,
il ne poste rien), mais il est **inauguré ici**. Conséquence sur l'implémentation :

- le `<input type="hidden">` est **frère** du `Select`, jamais imbriqué dans un `<label>` ;
- le `<label htmlFor>` pointe l'`id` du trigger (`Select` le pose sur le `<button>`), pas
  le hidden ;
- un `id` unique par ligne : `compte-entite-${bankAccountId}`.

## 4. Décisions tranchées (arbitrage humain, 2026-07-10)

### D1 — Placement : 3ᵉ section, **tous** les comptes

La section liste **tous** les comptes du workspace, y compris ceux déjà couverts par le
sas de propositions (section 1). Recouvrement visuel **assumé** : le sas propose un
rattachement par party, cette section fait de l'édition unitaire et est la **seule**
surface permettant `entityId = null`.

Alternative écartée : filtrer les comptes déjà présents dans le sas — coûterait un
couplage de lecture entre les deux sections, et amputerait la dé-assignation.

### D2 — Rafraîchissement : **`revalidatePath`** (option (b) du brief)

Constat qui motive (b) plutôt que le défaut (a) :

- `EntiteLue.nbComptes` **n'est jamais rendu** sur cette page (la page projette en
  `EntiteVue {id, nom, code}` et le jette). Aucun **compteur** n'est donc périmé — (a)
  n'afficherait aucun chiffre faux.
- **Mais** le sas de propositions **pré-coche** ses comptes selon `entityIdActuel`, lu au
  rendu serveur. Après une réassignation dans la nouvelle section, **ces cases mentent**
  jusqu'au prochain F5 — et un clic « Confirmer » sur une case périmée réassignerait un
  compte que l'ADMIN vient de ranger ailleurs. C'est un piège d'écriture, pas un
  cosmétique.

→ `revalidatePath("/admin/entites")` dans `assignerCompteAction`, **après** le
`withWorkspace` et **uniquement en cas de succès**.

**Effet de bord à couvrir en revue** : `assignerCompteAction` est partagée avec le sas
(`confirmerPropositionAction` appelle `assignerCompteEntite` **en direct**, pas l'action —
donc le sas n'est pas impacté par la revalidation ; à re-vérifier au code). La
revalidation ne doit ni casser le sas, ni être appelée dans un chemin d'erreur.

## 5. Lecture serveur — `listerComptesAvecEntite`

Fichier : `src/server/repositories/entites.ts`, calquée sur `listerEntites` (l. 194).

```
exigerAdmin(ctx)                              ← garde ADMIN portée par le REPO
SELECT id, account_name, currency, entity_id  ← AUCUN montant (règle 8)
FROM bank_accounts
WHERE workspace_id = ctx.workspaceId          ← défense en profondeur (RLS mord déjà)
ORDER BY account_name, id                     ← tri déterministe
```

- Type de sortie exporté **`CompteAvecEntite`** — contrat possédé par le backend :
  `{ bankAccountId: string; accountName: string; currency: string; entityId: string | null }`.
- `current_balance` **jamais** sélectionné (ni `syncCursor`, ni `omnifiAccountId`).
- Deux étages d'isolation mordent : `tenant_isolation` (workspace) **et** `entity_scope`
  (RESTRICTIVE FOR ALL sur `bank_accounts`). Comme la fonction est ADMIN-only, l'ADMIN est
  en Vision Globale (GUC vide) → il voit tout **son** tenant. Le `WHERE workspace_id` est
  redondant **volontairement** (défense en profondeur, cohérent avec `assignerCompteEntite`).
- **Frontière P0-a** : ré-export de la fonction **et** du type via `src/server/db/index.ts`.
  La page importe depuis `@/server/db`, jamais `@/server/repositories/*`.

## 6. Page — `src/app/(workspace)/admin/entites/page.tsx`

Dans le `withWorkspace` **déjà présent**, après le `if (!peutAdministrer(ctx.role)) return null` :

```ts
const comptes = await listerComptesAvecEntite(tx, ctx);
return { entites, membres, propositions, comptes };
```

Puis une 3ᵉ `<section>` au même gabarit que les deux existantes (`<h2>` +
`<p className="text-sm text-text-muted">` + composant), alimentée par `entitesActives`
(déjà calculé l. 85 — on ne recalcule rien).

Le non-ADMIN reçoit déjà `notFound()` : la lecture n'est **jamais** atteinte.

## 7. Server Action — amendement minimal

`assignerCompteAction` (`actions.ts:215`) : ajouter `revalidatePath("/admin/entites")`
**après** le `try/catch`, sur le chemin de succès uniquement. Import
`import { revalidatePath } from "next/cache";` (déjà le pattern de
`admin/membres/actions.ts:12`).

Rien d'autre ne change : schéma Zod, mapping d'erreurs, `withWorkspace` restent intacts.

## 8. Composant client — `assignation-comptes.tsx`

`src/app/(workspace)/admin/entites/assignation-comptes.tsx`, `"use client"`.

- Une **carte par compte** (`<li>` + `<form action={assignerCompteAction}>`), calquée sur
  `CarteMembre` de `assignation-entites.tsx`.
- `Select` **contrôlé** (`value` / `onChange`) + `<input type="hidden" name="entityId">`
  **frère** portant la valeur, + `<input type="hidden" name="bankAccountId">`.
- Options : `[{ value: "", label: "— Non assigné —" }, ...entites.map(e => ({value: e.id, label: e.nom}))]`.
  La chaîne vide `""` → `null` côté action (déjà géré : `rawEntity ? String(rawEntity) : null`).
- **Dirty state** : bouton « Enregistrer » désactivé tant que
  `entiteChoisie === (compte.entityId ?? "")` — ou `enCours`.
- **Statut par ligne** : zone `aria-live="polite"` reprenant le bloc `etat.erreur` /
  `etat.succes` de `CarteMembre` (`role="alert"` sur l'erreur, `role="status"` sur le succès).
- Barre de **recherche par nom de compte**, calquée sur celle d'`AssignationEntites`.

### États d'affichage (checklist UI_GUIDELINES §6.5)

| État | Rendu |
|---|---|
| Peuplé | liste de cartes |
| **Vide (aucun compte)** | `EmptyState` (`@/components/ui/states`), CTA « Connecter une banque » → `/banques` |
| **Vide (aucune entité)** | `EmptyState` — « Créez une entité d'abord » ; les `Select` n'auraient que « — Non assigné — » |
| Filtre sans résultat | ligne `text-text-muted` (comme `AssignationEntites`) |
| Erreur / succès | par ligne, zone `aria-live` |

Pas de carte ad-hoc : on réutilise les primitives `states/`. Tokens UI_GUIDELINES
uniquement, zéro couleur en dur (`text-danger`, `text-success`, `text-text-muted`…).

## 9. Exit-criteria (règle 3 — dans le MÊME PR)

- [ ] Lecture via `withWorkspace` ; garde ADMIN portée par le repo (`exigerAdmin`).
- [ ] Non-ADMIN → 404 au niveau page (`withWorkspace` retourne `null` → `notFound()`).
- [ ] **Test d'isolation (bloquant CI)**, ajouté à `tests/isolation/entites-admin-isolation.test.ts` :
  - [ ] `listerComptesAvecEntite` sous un **MANAGER** → `EntiteNonAutoriseError` ;
  - [ ] depuis WS_B, ne remonte **que** `ACC_B` — jamais `ACC_A` (cross-workspace → 0 ligne) ;
  - [ ] symétrie depuis WS_A ;
  - [ ] contre-preuve : un ADMIN voit bien son compte, avec l'`entityId` courant ;
  - [ ] l'écriture cross-tenant (`ACC_B` depuis WS_A → `CompteIntrouvableError`) est **déjà**
        prouvée (cas 6) — **ne pas dupliquer**, seulement vérifier qu'elle passe toujours.
- [ ] Erreurs nommées → messages UI génériques (déjà en place), aucun catch-all silencieux.
- [ ] Aucun montant affiché ni manipulé.
- [ ] Visual QA (Gate 4) : captures des états (peuplé, dropdown ouvert, succès, erreur, vide)
      comparées aux tokens de `docs/UI_GUIDELINES.md` ; clavier (↑/↓, Échap, typeahead) hérité
      du `Select`, vérifié.

## 10. Garde-fous de livraison

- **Stop-loss (règle 5)** : `npm run lint` + `npm run typecheck` verts avant tout commit.
  Aucun test rouge commité.
- **Suite d'isolation** exécutée localement (mémoire `sandbox-vitest-build-marchent` :
  PGlite/vitest **tournent** en sandbox — ne pas se contenter de lint+tsc).
- **Cross-review (règle 6)** : contexte frais mandaté de chercher **IDOR / fuite
  intra-groupe** sur la nouvelle lecture, et l'effet de bord de `revalidatePath` sur le sas.
- **Human-in-the-Loop** : branche `feat/admin-entites-assignation-comptes`, commit, push,
  **STOP à la PR**. PR applicative → l'humain ouvre et merge. L'agent ne merge pas.

## 11. Risques identifiés

| # | Risque | Mitigation |
|---|---|---|
| R1 | `revalidatePath` appelé dans un chemin d'erreur → re-rend inutile / masque l'état | Appel **après** le `try/catch`, sur le succès seulement |
| R2 | Le hidden input imbriqué dans un `<label>` casserait le `htmlFor` du trigger | Hidden **frère** du `Select` ; `htmlFor` → `id` du trigger |
| R3 | Un `id` de `Select` dupliqué entre lignes casserait `aria-activedescendant` | `id` dérivé du `bankAccountId` (unique par ligne) |
| R4 | Tentation d'afficher le solde (« utile pour identifier le compte ») | Interdit — §2 hors périmètre, règle 8 |
| R5 | Collision d'`uuid` de fixture dans le test d'isolation (cf. mémoire `rebase-collision-fixture-uuid`) | Réutiliser `ACC_A` / `ACC_B` **existants**, ne pas en créer |
