# PLAN — Changer de périmètre sans quitter la page (A4 / PERIMETRE-REDIRECT-PAGE1)

Branche : `fix/perimetre-redirect-page` (depuis `origin/main` @ 16317a0)
Date : 2026-07-14
Statut : **figé** (arbitrage §4 rendu par l'humain AVANT implémentation — règle 10)
Dette source : `TODOS.md` → PERIMETRE-REDIRECT-PAGE1 (P1, 2026-07-13)

---

## 1. Symptôme (reproduit)

Sur `/transactions` (ou toute page ≠ dashboard) : ouvrir le sélecteur « Vue »,
cocher/décocher un compte, « Appliquer » → **on atterrit sur `/`**. Perte de place
et reset des filtres in-page (recherche / statut / bornes de date, en état CLIENT).

## 2. Cause exacte

Les Server Actions de périmètre finissent par un `redirect("/")` **en dur** :

| Action | Fichier:ligne | Formulaire appelant |
| --- | --- | --- |
| `definirViewFilter` | `src/app/(workspace)/actions.ts:92` | `perimetre-switcher.tsx` (onglet « Par compte » + reset « Groupe ») |
| `definirPerimetreEntite` | `src/app/(workspace)/actions.ts:137` | `perimetre-switcher.tsx` (onglet « Par entité ») |
| `basculerWorkspace` | `src/app/(workspace)/actions.ts:61` | `workspace-switcher.tsx` **et** `selection/liste-workspaces.tsx` |

Le `PerimetreSwitcher` est monté dans `AppTopbar`, elle-même montée **globalement**
par `(workspace)/layout.tsx:206` → le sélecteur s'affiche sur TOUTES les pages, mais
son action ramène toujours au dashboard.

## 3. Découverte de conception — le redirect ne suffit pas (constat de recon)

> ⚠️ C'est le point qui a fait l'objet de l'arbitrage §4. Il n'était pas dans la
> spec initiale ; le livrer en silence aurait transformé un bug **gênant** en bug
> **trompeur**.

Rester sur la même route = un **re-render**, pas un remount (comportement Next
documenté : poser un cookie dans une Server Action « re-renders the current page and
its layouts on the server… **Client state is preserved for re-rendered components** »
— `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:505-507`).

Or les features clientes **sèment leur donnée RSC dans un `useState`**, qui **ne se
re-sème pas** au re-render :

- `src/components/transactions/transactions-feature.tsx:104` — `useState(initial.lignes)`
- `src/components/graphiques/graphiques-feature.tsx:121` — `useState(initiale)`
- `src/components/echeances/echeances-feature.tsx:93-94` — `useState(initiales.echeances)`
- (`regles-feature.tsx:69` — même motif, mais les règles ne sont pas scopées compte)

Conséquence du fix « nu » : après « Appliquer » sur `/transactions`, la topbar
afficherait « Sucre » pendant que **la table montrerait encore tous les comptes**.
Mensonge d'affichage sur de la donnée financière → inacceptable.

Le code CONNAÎT déjà ce piège : `app-topbar.tsx:64` force le remount du
`PerimetreSwitcher` par une `key` dérivée du périmètre, précisément parce que le
redirect seul ne re-sème pas l'état client (cf. commentaire
`perimetre-switcher.tsx:178-182`). Le fix étend ce mécanisme au conteneur de page.

## 4. Arbitrage rendu (règle 10) — « key de périmètre »

Trois options soumises, **option 1 retenue par Etienne (2026-07-14)** :

1. ✅ **Key de périmètre sur le conteneur de `{children}`** (layout). Générique et
   fail-safe : toute page — présente ET future — re-sème ses états clients quand le
   périmètre change. Aucune donnée périmée possible. **Contrepartie assumée** : les
   filtres in-page sont réinitialisés **quand on change le périmètre** (plus jamais
   lors d'une navigation ; et on reste sur la page). Dette P2 tracée (§8).
2. ❌ Re-fetch ciblé (prop `clePerimetre` + effet dans les 3 features) : filtres
   préservés, mais +0,5–1 j, 3 composants, double fetch, courses de requêtes, et
   **aucune garde structurelle** pour les futures pages.
3. ❌ Fix nu, sans garde : affichage financier périmé (cf. §3).

## 5. Surface de sécurité — open-redirect

Le chemin de retour vient d'un **champ de formulaire** (`origine`), donc du client,
donc **falsifiable** : c'est la surface qui fait de ce correctif un sujet règle 1
(plan → implémentation → revue par contexte frais).

**Modèle de menace.** Un attaquant qui parvient à faire soumettre le formulaire à une
victime (Server Actions = POST, protégées CSRF par le contrôle Origin/Host de Next)
pourrait tenter de poser `origine = https://evil.example` / `//evil.example` /
`javascript:…` → la victime, en cliquant « Appliquer », serait redirigée hors du site
(phishing : la page d'arrivée imite TYGR et demande des identifiants). C'est le
scénario classique d'**open-redirect**. Impact isolation tenant : **nul** (la RLS
reste la garde du périmètre — cf. `tenancy.ts`) ; impact confiance/phishing : réel.

**Contre-mesure.** Un validateur PUR `src/lib/redirect-interne.ts` :

```ts
validerCheminInterne(brut: unknown): string | null
```

Invariants (fail-closed — tout ce qui n'est pas prouvé interne renvoie `null`, et
l'appelant retombe sur `"/"`, le comportement actuel) :

| # | Règle | Ce qu'elle tue |
| --- | --- | --- |
| 1 | `typeof brut === "string"`, non vide, ≤ 2048 car. | champ absent, `File`, valeur absurde |
| 2 | aucun caractère de contrôle (U+0000-U+001F, U+007F) | CRLF (injection d'en-tête `Location`), NUL/TAB de contournement de parseur |
| 3 | aucun antislash `\` | `/\evil.com` (normalisé en `//evil.com` par les parseurs WHATWG → protocol-relative) |
| 4 | commence par `/` **et pas** par `//` | `//evil.com` (URL protocol-relative), tout schéma (`https:`, `javascript:`, `data:` — aucun ne commence par `/`), tout chemin relatif |
| 5 | **défense en profondeur** : `new URL(brut, "https://tygr.invalid")` doit résoudre sur **exactement** cette origine | toute forme exotique qui s'évaderait des règles 2–4 (le parseur WHATWG est plus permissif qu'une regex) |
| 6 | on ne rend que `pathname + search` | l'origine (jamais concaténée) et le `hash` (client-only, pas transmis au serveur) |
| 7 | **re-validation de la SORTIE** : le `pathname` retourné ne commence **jamais** par `//` | dot-segments (`/..//host`, `/%2e%2e//host`) — normalisés par le parseur en pathname `//host` (protocol-relative) **tout en gardant** l’origine sentinelle (donc règle 5 satisfaite) |

Base sentinelle `https://tygr.invalid` : TLD réservé (RFC 2606) → ne peut jamais
être une origine réelle, donc la comparaison d'origine ne peut pas être satisfaite
par accident.

> ⚠️ **Règle 7 ajoutée en cross-review (2026-07-14) — constat BLOQUANT.** La v1
> validait l'entrée brute (règle 4) mais **retournait la sortie normalisée** : classique
> « valide ce que tu reçois, pas ce que tu utilises ». `/..//evil.example` franchissait
> les règles 1–6 et ressortait en `//evil.example` — un open-redirect prouvé de bout en
> bout dans Next 16.2.9 (le `Location` protocol-relative est suivi vers
> `https://evil.example/`). Deux réviseurs sécurité indépendants ont convergé ; le fix
> (règle 7) a été fuzzé (ferme les 18 variantes `//`/`///`, littérales et `%2e`-encodées,
> préserve tous les cas légitimes dont `/%2F%2Fevil.example`). Leçon : une frontière
> anti-open-redirect DOIT valider sa valeur de sortie, jamais seulement son entrée.

**Pas d'allowlist de routes** (décision) : un chemin **interne** ne peut rien fuiter
(au pire un 404 sur notre propre origine ; l'app n'a aucun GET mutateur — les
mutations sont des Server Actions POST). Une allowlist casserait **silencieusement**
chaque nouvelle route (repli `"/"` = réintroduction du bug qu'on corrige).

**À NE PAS CONFONDRE** avec `src/server/widget/redirect-origin.ts` : celui-là valide
une **origine EXTERNE** (cible `postMessage` du PublicToken Omni-FI, allowlist +
https). Deux frontières distinctes, deux modules distincts.

## 6. Implémentation (5 lots)

### L1 — `src/lib/redirect-interne.ts` (nouveau, PUR)

Module sans React / sans réseau / sans env, testable unitairement (pattern
`machine-mfa.ts`, `view-filter.ts`). Exporte `validerCheminInterne` + la constante
de longueur max. Ne logge rien (règle 8 : le chemin peut contenir des filtres).

### L2 — `src/app/(workspace)/actions.ts`

`definirViewFilter` (:92) et `definirPerimetreEntite` (:137) :

```ts
// Capturé AVANT la mutation de session (fail-fast, aucune écriture si l'entrée est absurde).
const destination = validerCheminInterne(formData.get("origine")) ?? "/";
await unstable_update({ viewFilter: … });
redirect(destination, RedirectType.replace);
```

`basculerWorkspace` (:61) : **INCHANGÉ** (décision D2, §7).

### L3 — `src/components/shell/perimetre-switcher.tsx`

`<input type="hidden" name="origine" value={origine} />` dans les **DEUX** `<form>`
(onglet compte + onglet entité).

```ts
// Souscription STABLE (module-level) — une closure recréée re-souscrirait en boucle.
function souscrireHistorique(surChangement: () => void): () => void {
  window.addEventListener("popstate", surChangement);
  return () => window.removeEventListener("popstate", surChangement);
}

function useChaineRequete(): string {
  return useSyncExternalStore(
    souscrireHistorique,
    () => window.location.search,   // client : relu à CHAQUE rendu
    () => "",                       // SSR + hydratation : "" des deux côtés
  );
}

const origine = `${usePathname()}${useChaineRequete()}`;  // PAS useSearchParams (bail-out CSR)
```

**Correction en cours d'implémentation** (le plan prévoyait `useState` + `useEffect`) :
`react-hooks/set-state-in-effect` **rejette** un `setState` dans un effet (cascades de
rendus) — et la règle a raison. `useSyncExternalStore` est l'API prévue pour lire une
source externe mutable (`window.location`) : snapshot relu à chaque rendu — donc à
l'**ouverture du popover**, le seul instant qui compte (le `<form>`, donc le champ
caché, n'existe QUE popover ouvert). SSR/hydratation : `""` des deux côtés → aucun
mismatch. Le snapshot est une **chaîne** (primitive) → comparaison par valeur, pas de
boucle « getSnapshot should be cached ».

C'est ce qui rattrape `?periode`, écrit par `PeriodeSwitcher` via `router.replace`
**sans changer le pathname** (`periode-switcher.tsx:69`) : un effet dépendant de
`[pathname]` aurait laissé la query périmée. Limite résiduelle assumée : §8.
Le serveur RE-VALIDE de toute façon (le champ est falsifiable).

### L4 — `src/app/(workspace)/layout.tsx` (la garde du §4)

```tsx
const clePerimetre = viewFilterActif?.join(",") ?? "groupe";
…
<div key={clePerimetre} className="min-w-0 flex-1">{children}</div>
```

Remonte le sous-arbre de page quand — et seulement quand — le périmètre change. La
`key` du `PerimetreSwitcher` (`app-topbar.tsx:64`) reste **inchangée** : les deux
clés sont indépendantes (chacune n'a besoin que d'être une signature stable de
`viewFilterActif`, elles n'ont pas à être identiques → aucun couplage à maintenir).

### L5 — `tests/unit/redirect-interne.test.ts`

Acceptations : `/`, `/transactions`, `/transactions?periode=3m` (**query préservée**),
chemin encodé exotique (reste interne), hash retiré.
Rejets : `//evil.example`, `/\evil.example`, `https://evil.example`, `javascript:alert(1)`,
`data:text/html,x`, chemin relatif (`transactions`, `../x`), CRLF / caractères de
contrôle, non-string (`null`, `File`), chaîne vide, > 2048 caractères.

## 7. Décisions (règle 10)

- **D1 — Retour-page UNIQUEMENT sur les 2 actions de périmètre.** `basculerWorkspace`
  garde `redirect("/")` : changer de **workspace** purge le `viewFilter`
  (`actions.ts:55-60`) → le dashboard est la destination légitime. Argument
  supplémentaire trouvé en recon : cette action est AUSSI appelée depuis
  `selection/liste-workspaces.tsx` — y rester après avoir choisi un workspace serait
  absurde. Aucun champ `origine` n'est ajouté à ce formulaire (surface non ouverte).
- **D2 — `RedirectType.replace`** (léger écart à la spec, assumé) : en Server Action,
  `redirect` **pousse** par défaut (`redirect.md:30`) → chaque « Appliquer »
  empilerait une entrée d'historique **vers la même URL**, et le bouton « Précédent »
  paraîtrait cassé. `replace` évite d'introduire ce défaut avec le correctif. À
  vetoer en revue si désaccord.
- **D3 — Pas d'allowlist de routes** (justifié §5).

## 8. Limites assumées & dette

- **Filtres in-page réinitialisés au changement de périmètre** (contrepartie de
  l'option 1). → **TODOS P2 `TX-FILTRES-URL1`** : porter les filtres de
  `/transactions` (recherche / statut / bornes de date) dans les searchParams. Ils
  survivraient alors au remount (l'URL est préservée par le retour-page) ET la page
  deviendrait deep-linkable. Déclencheur : prochain chantier `/transactions`.
- **Query périmée, cas résiduel** : changer la période **au clavier** (Tab + Entrée)
  *pendant* que le popover « Vue » est ouvert (à la souris, le clic ferme le popover).
  `router.replace` ne déclenche ni `popstate` ni forcément un re-rendu du switcher →
  le `?periode` posté serait celui du dernier rendu. Conséquence : la période
  revient à sa valeur précédente. **Aucun impact sécurité** (chemin interne, serveur
  re-valide), non bloquant, résolu de fait par `TX-FILTRES-URL1`/`useSearchParams`
  sous Suspense si on y revient.

## 9. Exit criteria (règle 3)

- [ ] Authz inchangée : `exigerSessionWorkspace()` en tête des 2 actions ; aucun accès
      DB ajouté ; la RLS reste la garde du périmètre (le `viewFilter` n'est qu'une
      intention, `tenancy.ts:391-419`).
- [ ] Validation d'entrée : `origine` passe par un validateur **fail-closed** ; rejet
      silencieux mais **non énumérant** → repli `"/"` (jamais d'erreur qui révélerait
      la forme attendue). Le schéma Zod des deux actions est `.strict()` sur un objet
      construit champ par champ → l'ajout d'`origine` au FormData ne le casse pas.
- [ ] Audit ciblé (OWASP ASVS) : open-redirect (tableau §5), pas d'injection (aucune
      requête), pas d'IDOR (aucune ressource adressée), pas de log du chemin (règle 8).
- [ ] Erreur nommée : le validateur ne jette pas — il renvoie `null` (contrat total).
- [ ] Tests : chemin heureux (internes, query préservée) + chemins d'échec spécifiques
      (6 familles de payloads) + cas limites (vide, non-string, trop long).
- [ ] Logs : aucun ajout (le chemin peut porter des filtres → PII potentielle).

## 10. Vérification (Gate 4 — Visual QA, à faire par l'humain avant merge)

Scénarios, sur `/transactions` :

1. « Vue » → cocher un compte → Appliquer → **on reste sur `/transactions`**, la
   table est **re-semée et scopée**, la topbar affiche le bon libellé.
2. Idem depuis `/transactions?periode=3m` → on revient sur `/transactions?periode=3m`
   (**la période survit**).
3. Onglet « Par entité » → Appliquer → même comportement.
4. « Toutes les entités » / « Tous les comptes » (reset) → même comportement.
5. Dashboard (`/`) : aucun changement de comportement (non-régression).
6. `/selection` → choisir un workspace → arrive sur `/` (non-régression D1).
7. Bouton « Précédent » du navigateur après un Appliquer → revient à la page
   **précédente** (pas à la même URL empilée) — vérifie D2.

## 11. Registre de revue (règle 6 — contextes FRAIS indépendants, 2026-07-14)

Deux réviseurs à contexte frais, mandat de chercher des modes de défaillance, avant push.

**Revue A — sécurité / open-redirect.** 1 constat **BLOQUANT** : contournement du
validateur par dot-segments (`/..//host` → sortie `//host` protocol-relative, prouvé
bout-en-bout dans Next 16.2.9). **Corrigé** (règle 7 du validateur + 10 cas de test).
Confirmé de mon côté par reproduction puis re-fuzz via vitest (20/20). Le réviseur a
aussi listé ce qu'il a jugé SAIN (ordre validation→mutation, pas de fuite PII, pas de
SSRF, borne de longueur avant `new URL`, homoglyphes de slash inertes).

**Revue B — mécanique Next/React.** **Aucun constat bloquant.** Validé avec preuves :
fraîcheur de `origine` à l'ouverture (snapshot relu à chaque render), absence de
mismatch d'hydratation (champ sous `{ouvert && …}`, absent du HTML SSR), `key`
injective et sans collision `null`/`[]`/ordre, non-remount à la navigation normale,
non-interférence avec la topbar sticky + la garde de session en portail, `replace` vs
`push` (doc Next citée), `build` sans bail-out CSR. Deux **nits non bloquants** :
- **Nit 1** — `useChaineRequete` ne s'abonne qu'à `popstate`, pas à `pushState`/
  `replaceState`. Inatteignable aujourd'hui (le seul mutateur de query, PeriodeSwitcher,
  ferme le popover au clic) → tracé sur `TX-FILTRES-URL1` (patcher la souscription le
  jour où des filtres in-page muteront l'URL sans fermer le popover). Cf. §8.
- **Nit 2** — l'état d'erreur des actions de périmètre n'est pas affiché (`useActionState`
  dont le state est ignoré). **Pré-existant**, hors périmètre de ce fix, chemin
  quasi-inatteignable (ids déjà validés UUID). Non corrigé (règle 1 : pas d'élargissement).

## 12. Livraison

`lint` + `typecheck` + `vitest` verts (règle 5) → commit sur `fix/perimetre-redirect-page`
→ push → **STOP à la PR** (Human-in-the-Loop règles 2-4 : PR applicative → l'humain
ouvre, valide et merge).
