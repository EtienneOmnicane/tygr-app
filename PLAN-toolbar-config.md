# PLAN — Configuration de la barre de vue par page (TOOLBAR-GLOBALE-CADRAGE1, lot A2)

Date : 2026-07-14 · Branche : `feat/toolbar-config` · Effort : ~0,5 j
Référence : TODOS.md § **TOOLBAR-GLOBALE-CADRAGE1** (cadrage A2, question ouverte
« quel sous-ensemble de contrôles par page ? »). **Matrice tranchée par Etienne**
(2026-07-14) — ce plan l'implémente, il ne la re-litige pas (règle 10).

## 1. Problème

`AppTopbar` (`src/components/shell/app-topbar.tsx`) est montée GLOBALEMENT par
`src/app/(workspace)/layout.tsx:233` → elle affiche **période + périmètre + CTA sur
TOUTES les pages** du groupe workspace, y compris là où un contrôle n'a aucun effet :
la période sur `/banques`, `/regles`, `/admin/*` ; le périmètre sur `/banques`.

Un contrôle affiché sur une page qu'il ne filtre PAS est un **mensonge d'affichage** :
l'utilisateur croit borner sa vue, la page ignore le réglage. Sur de la donnée
financière, c'est le même défaut de classe que celui corrigé par A4 (topbar affichant
« Sucre » pendant que la table montrait tous les comptes).

## 2. Périmètre (strict)

Ce lot **GATE les contrôles EXISTANTS**, il n'en ajoute AUCUN.
- Hors périmètre : la plage de dates précise (TOOLBAR-DATE-PRECISE1, lot A1 suivant),
  l'horizon futur de `/echeances` (chantier séparé), TX-TOOLBAR-DEDUP1.
- Aucun changement de schéma, d'API, de RLS ou de Server Action. **Zéro surface de
  sécurité touchée** : la RLS reste seule autorité de périmètre ; on ne fait que
  décider quels contrôles d'UI sont MONTÉS.

## 3. Matrice validée (Etienne, 2026-07-14)

| Page                       | Période | Périmètre  | CTA banque | Bande            |
| -------------------------- | ------- | ---------- | ---------- | ---------------- |
| `/` (dashboard)            | ✅      | ✅         | ✅         | complète         |
| `/transactions`            | ✅      | ✅         | ✅         | complète         |
| `/graphiques`              | ✅      | ✅         | ❌         | complète         |
| `/echeances`               | ❌      | ✅         | ❌         | complète         |
| `/banques`                 | ❌      | ✅ **(a)** | ✅         | complète         |
| `/regles`                  | ❌      | ✅ **(a)** | ❌         | complète         |
| `/admin/membres`           | ❌      | ❌         | ❌         | **minimale**     |
| `/admin/entites`           | ❌      | ❌         | ❌         | **minimale**     |
| `/selection`               | ❌      | ❌         | ❌         | **aucune barre** |
| *(page non cadrée)*        | ❌      | ✅         | ❌         | complète         |

- **(a) AMENDEMENT du 2026-07-14 (arbitrage Etienne, après cross-review).** La matrice
  initiale retirait le périmètre de `/banques` et le réduisait `/regles` à une bande
  minimale. **Refusé en l'état** : le `viewFilter` n'est pas un filtre d'affichage local,
  c'est un prédicat **RLS** (`app.current_view_filter`, policy `account_scope` RESTRICTIVE
  en USING *et* WITH CHECK, migrations 0016/0017) porté par le **JWT** — il suit
  l'utilisateur de page en page et **mord sur toute page dont la session n'est pas
  amputée**. Or `/banques` et `/regles` tournent sur `exigerSessionWorkspace()` (session
  COMPLÈTE) :
  - `/banques` : filtre actif ⇒ le sync **attache 0 compte SANS erreur** (bug terrain
    « spinner puis rien », documenté dans `banques/actions.ts:281-286`) et les compteurs
    de connexions sont faux ;
  - `/regles` : filtre actif ⇒ « Ré-analyser » ne recatégorise **que le périmètre filtré**.

  Retirer le sélecteur là supprimerait le **seul moyen de voir et d'annuler** un filtre
  qui continue d'agir → régression. **INVARIANT retenu** :

  > `perimetre: false` n'est légitime QUE si la page ET ses Server Actions tournent sur
  > une session **amputée du viewFilter** (`exigerSessionAdministration`) — ou hors
  > contexte workspace (`/selection`).

  Seul `/admin/*` satisfait cet invariant aujourd'hui. Le nettoyage serveur (amputer
  `/banques` + `/regles`) est sorti du périmètre de ce lot → dette **P1
  TOOLBAR-PERIMETRE-AMPUTATION1** (TODOS.md), qui rendra ces deux cellules ❌ *et* tuera
  le bug de sync au passage. Option écartée sciemment : masquer quand même (régression).

- **Bande minimale** = fine bande de contexte, sans aucun contrôle : elle porte le seul
  **repère de TENANT** (« Espace » + nom du workspace). Le mot « Groupe » est
  volontairement PROSCRIT ici : dans le vocabulaire du projet il signifie « aucun filtre
  de périmètre » — une bande qui l'afficherait pendant qu'un `viewFilter` est actif
  mentirait. Le nom du workspace, lui, est toujours vrai.
- **Aucune barre** = `AppTopbar` ne rend rien (pas de `<header>` vide).
- **Défaut (page non cadrée)** : périmètre SEUL — même logique fail-safe que (a). Le
  filtre suit l'utilisateur partout : une page ajoutée demain sans toucher la matrice doit
  garder sa trappe de sortie. La période, elle, est un vrai no-op tant que la page ne lit
  pas `?periode` → l'afficher serait le mensonge que ce lot combat.

## 4. Contrainte technique dirigeante

`AppTopbar` est un **Server Component** : `usePathname` y est interdit. Le choix par
route doit donc vivre dans un composant **CLIENT**.

Découpage retenu :
1. `src/components/shell/toolbar-config.ts` — fonction **PURE** `toolbarConfig(pathname)`
   → `{ periode, perimetre, cta, minimal }`. Zéro React, zéro import UI → **testable en
   unitaire** (c'est la matrice, et c'est elle qu'on protège en CI).
2. `src/components/shell/barre-vue.tsx` — composant **CLIENT** (`usePathname`) qui lit la
   config et monte les contrôles sous condition. `PeriodeSwitcher` / `PerimetreSwitcher`
   sont DÉJÀ clients → import direct.
3. `src/components/shell/app-topbar.tsx` — reste **SERVER**, devient une coquille : elle
   résout ce qui est serveur et le passe à `BarreVue`. Le `BankCtaLink` (server component)
   est passé en **SLOT** (`cta: ReactNode`) — un client component ne peut pas IMPORTER un
   server component, mais il peut en RECEVOIR un rendu en prop. Ça évite de convertir
   `bank-cta.tsx` en client (pas de régression de nature).

Coût assumé : quand `cta: false`, l'élément CTA est quand même sérialisé dans le payload
RSC (non rendu). C'est ~200 octets de markup d'un `<Link>` sans donnée — non négociable
contre la complexité d'un aller-retour de rôle côté client.

## 5. Règle de résolution (`toolbarConfig`)

- Clé = **premier segment** du pathname (`/transactions/abc` → `transactions`). Une
  sous-route future d'une page cadrée hérite donc de sa config au lieu de tomber dans le
  défaut — comportement voulu.
- `/admin/*` → un seul segment `admin` : membres ET entités sont minimales.
- Normalisation défensive (la fonction est pure et testable seule) : slash final ignoré,
  query/hash ignorés, `""`/`"/"` → dashboard.
- **Défaut EXPLICITE pour toute page non cadrée : périmètre SEUL** (ni période, ni CTA).
  Le raisonnement a été RETOURNÉ par la cross-review, et c'est le cœur du lot :
  - le **périmètre** n'est un no-op sur AUCUNE page à session complète (le `viewFilter` est
    un prédicat RLS porté par le JWT, il mord partout) → le retirer ne « nettoie » rien,
    ça **cache un filtre actif et supprime le moyen de l'annuler**. Fail-safe = le garder ;
  - la **période** est un pur filtre de LECTURE que la page doit lire (`?periode`) : sur une
    page qui ne le lit pas, le contrôle est un vrai no-op → **c'est LUI le mensonge** que ce
    lot combat. Fail-safe = le retirer ;
  - le **CTA** n'a de sens que déclaré (point d'entrée bancaire).

  Une nouvelle page qui veut période/CTA les DÉCLARE — pas de silence, pas d'héritage
  implicite. Et une page qui veut MASQUER le périmètre doit d'abord amputer sa session
  (invariant §3(a)) : c'est vérifié en CI, pas laissé à la vigilance du relecteur.

## 6. Visual QA (Gate 4)

`/demo/shell` monte le VRAI `AppTopbar` hors auth/DB. Sur cette route, `usePathname` vaut
`/demo/shell` → défaut minimal → la démo du gating CTA (ADMIN/MANAGER/VIEWER) serait
cassée. Correctif : prop optionnelle `pathnameForce?: string` (documentée « Visual QA
uniquement »), qui court-circuite `usePathname`. La démo en profite pour rendre **toute la
matrice** (une section par route) → Etienne valide les 9 lignes du tableau sur un seul
écran, sans naviguer.

Pas de `flex-wrap` sur la barre (règle UI : condenser). Tokens sémantiques uniquement
(`surface-card`, `line`, `text-muted`, `ink`) — aucune couleur en dur, aucun vert/rouge
(réservés aux montants).

## 7. Tests (`tests/unit/toolbar-config.test.ts`)

- Une assertion par ligne de la matrice (9 pages) + le défaut.
- Sous-route (`/transactions/xyz`) → hérite de `/transactions` ; `/admin/*` reste minimal.
- Normalisation : slash final, query, hash, pathname vide.
- **Gardes d'invariants (issues de la cross-review — c'est ce qui compte)** :
  - `perimetre: false` ⇒ le segment DOIT être dans la liste blanche des surfaces amputées
    du viewFilter (`admin`, `selection`). Le test échoue si quelqu'un masque le périmètre
    d'une nouvelle page sans avoir amputé sa session serveur — **le défaut qu'a failli
    livrer ce lot est désormais impossible à re-livrer en silence**.
  - `minimal` ⇒ aucun contrôle monté.
  - « barre vide » (0 contrôle, `minimal:false`) ⇒ ne peut être QUE `/selection` (sinon une
    page future disparaîtrait sans chrome par simple erreur d'encodage).
  - COUVERTURE : toute route réelle de `src/app/(workspace)/` (lue au `fs`) est une clé
    EXPLICITE de la matrice — une faute de frappe ne peut plus faire tomber une page
    existante dans le défaut sans que la CI rougisse.

## 8. Exit criteria

- [x] `lint`, `typecheck`, build, suite de tests verts (règle 5).
- [x] Aucune Server Action / route / requête DB touchée (→ pas de nouveau cas d'isolation).
      Tenu, y compris après l'amendement (a) : c'est précisément pour tenir cette ligne que
      l'amputation serveur est différée en P1 plutôt que faite ici.
- [x] Revue contradictoire (contexte frais) passée → 1 BLOQUANT + 2 IMPORTANTS remontés,
      arbitrage humain rendu (option « garder le sélecteur »), constats traités.
- [x] TODOS.md : TOOLBAR-GLOBALE-CADRAGE1 → lot A2 livré (gating), reste renvoyé
      explicitement ; nouvelle entrée P1 TOOLBAR-PERIMETRE-AMPUTATION1.
- [ ] **Visual QA humain (Gate 4)** : `/demo/shell` (matrice complète sur un écran) + les
      9 pages réelles.
- [ ] STOP à la PR poussée (PR applicative → Human-in-the-Loop).
