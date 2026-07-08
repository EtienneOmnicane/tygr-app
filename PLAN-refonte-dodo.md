# PLAN — Refonte UX/UI « Dodo »

> Statut : **PROPOSÉ** (phase conception, règle 1). Aucune ligne de code applicatif
> tant que ce plan n'est pas validé + passé en /plan-eng-review ou subagent frais
> (règle 6). Date : 2026-07-07. Auteur : agent. Déclencheur : refonte Claude Design
> reçue (`Refonte Dodo, application trésorerie.zip`).

## 0. Nature du livrable Claude Design (ce que le zip EST et n'est PAS)

Le zip est un **prototype visuel « dc »** : un seul `Dodo.dc.html` piloté par un
runtime Vue (`support.js`), styles **inline**, fausses données (`{{ c.solde }}`),
balises maison (`<sc-if>`), police Red Hat Display, palette Dodo/Omni-FI.

C'est une **maquette de référence / spec visuelle**, pas du code intégrable :
- pas de React / RSC, pas de Tailwind, pas de tokens ;
- aucun lien avec `withWorkspace`, la RLS, `format-montant`, `format-date`, les états
  Loading/Empty/Error/Partiel, l'i18n FR ;
- couleurs en dur partout (violerait règle 8 + « aucune couleur en dur »).

**Décision d'intégration : reskin-IN-PLACE, jamais de drop du HTML généré.** On
transpose la *direction visuelle* sur les composants existants ; on ne remplace
aucun composant par du markup Claude Design. Motif : ne jamais court-circuiter
l'isolation tenant, le flux de données, le formatage financier et les états (règles
2 et 8).

**Périmètre élargi (2026-07-07) : migration de layout.** Au-delà du reskin, on adopte
les EMPLACEMENTS Dodo — notamment la **navbar verticale à gauche** (maquette : `nav`
232px, fond blanc, bord droit `#E8E3D5`) à la place du header horizontal `bg-ink`
actuel. Contrainte absolue d'Etienne : **garder 100 % des features**. Toute feature de
l'app absente de la maquette (module Admin, switcher de groupe…) est **replacée
intelligemment** (carte de réconciliation §7bis). « In-place » reste vrai au niveau des
composants (data-flow intact) — c'est le CHÂSSIS de navigation qui change, pas la
plomberie.

## 1. Objectif

Adopter l'identité Dodo (palette, police, marque) sur l'app existante **sans toucher
au flux de données ni à la logique métier**, écran par écran, avec Visual QA (Gate 4)
à chaque lot.

## 2. Invariants NON négociables (ne pas régresser)

- **Flux de données inchangé** : tout accès reste via `withWorkspace` ; RLS =
  seule frontière tenant (règles 2). Aucune requête déplacée, aucun composant
  d'affichage transformé en fetcher.
- **Formatage financier** : montants via `format-montant.ts`, dates via
  `format-date.ts` UNIQUEMENT. Préfixe devise `Rs`/`$`/`€`, signe `−`, virgule
  décimale FR, `tabular-nums`, jamais de float, pas d'addition cross-devise
  (règle 8). La refonte ne réécrit aucun formateur.
- **`tabular-nums` préservé** : Red Hat Display **expose tnum** (vérifié). Les
  colonnes de montants gardent `tabular-nums` (via `font-variant-numeric` /
  classe Tailwind). À re-confirmer en Visual QA sur rendu réel (alignement des
  virgules décimales sur pile multi-devise).
- **Quatre états** conservés (`loading.tsx` natif + composants `states/`), erreur ≠
  sortie (fond `danger-bg` + icône + `role="alert"`), skeleton neutre.
- **Aucune couleur en dur** : on ne fait que **remapper les tokens** ; aucun hex
  n'entre dans un `.tsx`.
- **UI en français**, libellés inchangés (sauf rebrand TYGR→Dodo).
- **Source de vérité UI** : `docs/UI_GUIDELINES.md §0`. Le remap palette se pose
  **LÀ-BAS d'abord**, puis est recopié dans `globals.css` (le commentaire du fichier
  l'exige : « toute divergence se corrige LÀ-BAS d'abord »). Sinon dette de drift.
- **Zéro feature perdue** (exigence Etienne) : chaque route, entrée de nav, CTA,
  switcher et menu de l'app actuelle a un emplacement dans la nouvelle coquille
  (§7bis). Un élément non replacé = lot incomplet.
- **Gating de rôle préservé** : `peutAdministrer(role)` continue de conditionner
  l'accès Admin ; déplacer les liens Admin dans la sidebar ne change PAS la garde.
- **Sémantique des switchers intacte** : `PerimetreSwitcher` pilote le scope entité
  RLS (`app.current_entity_scope`, Vision Globale/Entité) côté SERVEUR — on déplace
  son UI, on ne touche NI à son câblage NI à la RLS (règle 2). Idem `PeriodeSwitcher`
  (filtre `?periode` hors RLS) et `WorkspaceSwitcher`.

## 3. Point d'appui architectural

Tous les composants tapent des **tokens sémantiques** définis dans **un seul**
bloc `@theme` de `src/app/globals.css`. Remapper les hex à cet endroit re-skinne
l'app « gratuitement » partout où le token est utilisé. C'est le levier central du
plan.

## 4. Mapping palette (token actuel → valeur Dodo)

Hex Dodo confirmés par extraction de `Dodo.dc.html` (fréquence d'usage à l'appui).

| Token (`globals.css`) | Actuel | → Dodo | Nom marque |
|---|---|---|---|
| `--color-ink` | `#0f1e3d` | `#0c1633` | Island Night |
| `--color-ink-700` | `#1b2d55` | `#1b2a55` | Island Night hover |
| `--color-primary` | `#2447d6` | `#2c5fe8` | Lagoon Blue |
| `--color-primary-600` | `#1d3ab8` | `#1e46c4` *(tint à caler)* | Lagoon foncé |
| `--color-primary-50` | `#eef2ff` | `#e8eeff` *(tint à caler)* | Lagoon clair |
| `--color-accent` | `#f59e0b` | `#dfa218` | Native Amber |
| `--color-inflow` | `#16a34a` | `#157a4a` | Morne Green |
| `--color-inflow-700` | `#15803d` | `#0f5c37` *(dérivé)* | Morne foncé |
| `--color-inflow-bg` | `#e7f6ec` | `#e4efe6` *(tint à caler)* | — |
| `--color-outflow` | `#dc2626` | `#bf3b2f` | rouge Dodo |
| `--color-outflow-700` | `#b91c1c` | `#9c2f25` *(dérivé)* | — |
| `--color-outflow-bg` | `#fdeaea` | `#f6e4df` *(tint à caler)* | — |
| `--color-danger` | `#b42318` | `#bf3b2f` | rouge Dodo |
| `--color-danger-bg` | `#fef3f2` | `#f6e4df` *(tint à caler)* | — |
| `--color-success` | `#079455` | `#1d9e55` | vert clair Dodo |
| `--color-success-bg` | `#ecfdf3` | `#e4efe6` *(tint à caler)* | — |
| `--color-warning` | `#b54708` | `#8a6108` | ambre foncé |
| `--color-warning-bg` | `#fffaeb` | `#f7e8c3` | ambre clair |
| `--color-surface-page` | `#f3f5fa` | `#f5f2e9` | Reef White |
| `--color-surface-card` | `#ffffff` | `#ffffff` *(ou `#fcfbf6`)* | blanc chaud |
| `--color-surface-inset` | `#f2f4f8` | `#f0ecdf` | neutre chaud |
| `--color-surface-forecast` | `#f6f8fb` | `#efebdd` | neutre chaud |
| `--color-line` | `#e6eaf2` | `#e8e3d5` | ligne chaude |
| `--color-line-strong` | `#cbd2e0` | `#d8d2c2` | ligne chaude+ |
| `--color-text` | `#101828` | `#0c1633` | Island Night |
| `--color-text-muted` | `#667085` | `#5c6274` | gris Dodo |
| `--color-text-faint` | `#98a2b3` | `#8a8f9f` | gris clair Dodo |
| `--color-text-onink` | `#ffffff` | `#ffffff` | — |

*(tint à caler)* = valeur dérivée à ajuster au Visual QA / contraste (voir §7).

## 5. Police

- `src/app/layout.tsx` : `Geist`/`Geist_Mono` → **Red Hat Display** (`next/font/google`),
  variable CSS `--font-red-hat`.
- `globals.css` : `--font-sans: var(--font-red-hat)`.
- `--font-mono` : conservé pour le code technique éventuel (aucun montant ne dépend
  du mono ; les montants sont en `--font-sans` + `tabular-nums`).
- Charger les graisses réellement utilisées (400–800 d'après le `<head>` de la
  maquette) ; `display: swap`.
- **Gate tnum** : après swap, capturer une table de montants multi-devise et vérifier
  l'alignement des virgules décimales (règle 8). Bloquant si régression.

## 6. Rebrand TYGR → Dodo (périmètre STRICT — validé 2026-07-07)

**Règle d'or : « Dodo » à l'affichage, « tygr » dans la plomberie.** Le rebrand ne
touche QUE ce que l'utilisateur voit. Toucher la tuyauterie technique casserait
l'isolation tenant et la CI (règle 2).

**DANS le périmètre (affichage) :**
- Nom produit dans l'UI : header, `<title>`, `metadata`, copy du login
  (« La trésorerie de votre groupe, en clair »), e-mails/PDF si présents.
- Logo + favicon : source de vérité = **l'asset original d'Etienne** (SVG ou PNG
  haute-déf si dispo — « exactement le même » ET net en retina). À défaut,
  `assets/logo-dodo.png` du zip (badge bleu + dodo blanc, **109×126**, correct mais
  soft à l'agrandissement). → `public/`.
- Occurrences « TYGR » dans les **chaînes d'affichage** uniquement.

**HORS périmètre — NE JAMAIS renommer (casse RLS/provisioning/CI) :**
- Rôles DB `tygr_app` / `tygr_owner` / `tygr_service` (référencés en dur dans
  `drizzle/provisioning/tygr_app.sql`, garde-fou `UnsafeDatabaseRoleError`, liste
  blanche DELETE append-only, suites d'isolation).
- `DATABASE_URL` / `DATABASE_URL_ADMIN`, variables d'env, secrets webhook.
- Dossier de travail `tygr-app/`, noms de fichiers, branches git, `package.json name`.
- Ces identifiants sont **invisibles pour l'utilisateur** → aucun gain à les renommer,
  risque maximal. Interdit.

## 7. Risques (règle 10) — à trancher AVANT L1

1. **Contraste WCAG** : Lagoon Blue `#2c5fe8` sur Reef White `#f5f2e9`, ambre
   `#dfa218` sur clair, texte muted `#5c6274`. Re-checker les paires sémantiques
   (AA texte / 3:1 UI). Les tints `#e4efe6`/`#f6e4df` doivent garder leur texte
   inflow/outflow/danger lisible. Ajuster les *(tint à caler)* ici.
2. **inflow vs success / outflow vs danger** : la maquette mutualise le rouge
   (`#bf3b2f`) et des verts proches. Ta règle sépare **donnée** (vert/rouge) et
   **erreur système** (fond + icône + message). On garde la séparation par
   *traitement* (danger-bg + icône), même si la teinte se rapproche. À valider.
3. **Décision de marque** : adopter la palette Omni-FI/Dodo sur tout le produit est
   un choix **produit**, pas technique. Ce plan l'exécute mais ne le tranche pas —
   go/no-go attendu.
4. **UI_GUIDELINES.md** devient la nouvelle réf : une fois le remap validé, §0 est
   réécrit → toute la doc UI parle « Dodo ». Impact sur les captures de référence
   existantes (à re-générer).

## 7bis. Migration de layout & carte de réconciliation (features → emplacements)

**État actuel** : header horizontal `bg-ink h-16` (`AppHeader`) = logo + nav
horizontale (`AppNav`) + cluster droit (`PeriodeSwitcher`, `PerimetreSwitcher`,
`WorkspaceSwitcher`, `BankCtaLink`, liens Admin role-gated, déconnexion). Contenu via
`DashboardShell` (aside KPI 300px + main).

**Cible Dodo** : `nav` verticale **232px, fond blanc `#FFFFFF`, bord droit
`#E8E3D5`**, flex colonne, à GAUCHE. Zone contenu à droite avec **bandeau haut**
(titre d'écran + ligne de contexte « Groupe · période · N comptes » + switcher
**Période** — natifs Dodo). Bloc **COMPTE** en bas de sidebar.

**Carte de réconciliation** (rien ne se perd — exigence Etienne) :

| Élément actuel | Emplacement actuel | → Emplacement Dodo |
|---|---|---|
| Dashboard, Graphiques, Échéances, Transactions, Règles | nav horizontale | **nav sidebar** (natif Dodo) |
| Banques | CTA header (`BankCtaLink`) | **item de nav sidebar « Banques »** (natif Dodo) ; le CTA subsiste en empty-state |
| `PeriodeSwitcher` (Ce mois/3m/6m/12m/Tout) | cluster droit header | **bandeau haut du contenu** (natif Dodo « Période ») |
| `PerimetreSwitcher` (Vision Globale/Entité/banques) | cluster droit header | **bandeau haut / ligne de contexte** (« Groupe · … · N comptes ») — câblage RLS INCHANGÉ |
| `WorkspaceSwitcher` (groupe) | cluster droit header | **haut de sidebar** (identité groupe) ou bloc **COMPTE** — à caler au build |
| Admin : Membres / Entités / Périmètres (role-gated) | liens header | **groupe « Administration » en bas de sidebar**, role-gated (ORPHELIN maquette) |
| Se déconnecter | header | bloc **COMPTE** (bas de sidebar) |
| `selection` (choix du workspace) | écran pré-coquille | **inchangé** (avant la sidebar) |
| `DashboardShell` (aside KPI 300px + main) | zone contenu | conservé DANS la zone droite |

**Vrais orphelins** (absents de la maquette, placés par jugement, règle 10) : le
**module Admin** (3 écrans) → section « Administration » role-gated en bas de sidebar ;
le **`WorkspaceSwitcher`** multi-groupe → haut de sidebar / COMPTE. Placement
intelligent tracé ici, jamais suppression.

## 8. Découpage en lots (incrémental, un lot = une PR reviewable)

- **L1 — Fondations + Connexion** (démarre maintenant) : remap tokens
  (`UI_GUIDELINES §0` → `globals.css`), swap police Red Hat Display, rebrand
  (nom/copy/favicon ; logo = placeholder jusqu'à réception de l'asset), + **écran
  Connexion** (split-panel bleu). Risque données **nul**. Ne dépend PAS de la
  réconciliation nav → valide le levier tokens en premier.
- **L2 — Coquille / navigation (lot pivot)** : header horizontal → **sidebar gauche
  232px** selon la carte §7bis (nav + « Administration » role-gated + bloc COMPTE +
  bandeau haut Période/Périmètre). Tous les écrans vivent dedans → à faire tôt.
  Câblage des switchers/Admin **déplacé, jamais modifié** (règle 2).
- **L3 — Dashboard** : cartes solde/flux, pastille fraîcheur, KPI (dans la coquille L2).
- **L4 — Transactions** : table, tags flux, badges catégorie/fiabilité.
- **L5 — Échéances** (prévisionnel).
- **L6 — Graphiques** : courbe 90j, barres flux (tokens de série).
- **L7 — Banques** : connexions, widget MFA (visuel only, machine MFA intacte).
- **L8 — Règles de catégorisation** + accordéons.
- **Admin (Membres/Entités/Périmètres)** : nav rattachée à L2 ; contenu reskinné
  token-only au fil (role-gated).

L3–L8 = ajustements layout/espacement sur composants existants, **jamais** de nouveau
flux de données. **L2 est le seul lot à refonte structurelle de la coquille.**

## 9. Critères de sortie par lot (sinon PR incomplète)

- [ ] Zéro hex en dur ajouté dans un `.tsx` (grep de garde).
- [ ] `format-montant`/`format-date` toujours seuls formateurs ; `tabular-nums`
      intact sur les montants.
- [ ] Les 4 états rendus et capturés (route `demo/<domaine>-states`).
- [ ] **Visual QA** headless de chaque état modifié comparé par vision à
      `UI_GUIDELINES.md` (Gate 4). Écart token objectif = bloquant.
- [ ] `lint` + `tsc --noEmit` + `build` verts (stop-loss, règle 5).
- [ ] **Suite d'isolation IDOR intacte** (aucune régression) — la refonte ne touche
      pas la tenancy, mais la CI reste bloquante.
- [ ] Contraste WCAG des paires sémantiques modifiées vérifié (§7.1).

## 10. Séquence Git / Human-in-the-Loop

- Branche fraîche depuis `main` à jour : `feat/refonte-dodo-l1` (puis un `feat/` par
  lot), travaillée exclusivement dans `tygr-app/`.
- PR **applicative** (change le rendu produit) → l'agent **s'arrête à la PR poussée** ;
  validation humaine (Visual QA + devises/fuseaux) puis **merge par l'humain**.
- Pas d'auto-merge (règle Human-in-the-Loop nuancée : applicatif = humain).

## 11. Décisions

**Actées (2026-07-07) :**
- ✅ **Go marque** : palette Dodo/Omni-FI adoptée sur tout le produit.
- ✅ **Rebrand TYGR→Dodo** : à l'affichage uniquement, périmètre strict §6 (plomberie
  technique intacte).

**Reste à trancher avant L1 :**
1. **Logo source** : Etienne fournit l'original (SVG / PNG HD) ? Sinon `logo-dodo.png`
   du zip (109×126) utilisé tel quel.
2. **Périmètre L1** : démarrer par L1 seul (fondations + Connexion), valider le rendu,
   puis dérouler L2→L7 ? (reco) — ou autre premier écran ?
3. **Blanc de carte** : `#ffffff` pur ou blanc chaud `#fcfbf6` sur Reef White ?
