# Dodo — UI Guidelines (Design System exécutable)

**Source** : benchmark exhaustif FYGR (45 captures, `docs/benchmarks/fygr/`, juin 2026),
mappé sur la navigation principale (Dashboard, Graphiques, Échéances, Transactions,
Catégories, Profil).
**Posture** : *extraire et adapter* — les patterns structurels, la densité et la
sémantique sont repris fidèlement (conventions de catégorie validées par le marché) ;
l'identité de marque (palette Dodo, accent, typographies) est propre à Dodo.
**Chose mémorable** : **clarté financière** — "j'ai compris ma trésorerie en 3 secondes".
Chaque règle ci-dessous sert cette impression ; ce qui ne la sert pas est coupé.
**Stack cible** : Tailwind CSS + shadcn/ui + Tremor. Ce document est la source de
vérité UI (référencé par `CLAUDE.md`). Aucun code applicatif ici — uniquement des
règles et des tokens.

> Lien plan produit : ce document implémente T-D1/T-D2 du plan v2.1 et précise D1-D7
> (addendum design). En cas de conflit avec D4 sur la couleur des sorties, **ce
> document prévaut** (décision explicite : sorties = rouge, voir §3.4).

---

## 0. Tokens de base (Tailwind)

```js
// tailwind.config.ts — extend.colors (référence, à recopier tel quel)
colors: {
  ink: {                       // marque Dodo — Island Night (bleu nuit profond)
    DEFAULT: '#0C1633',        // navbar latérale, segmented actif, onboarding chip
    700: '#1B2A55',            // hover items, boutons sombres
  },
  primary: {                   // actions principales — Lagoon Blue
    DEFAULT: '#2C5FE8',        // boutons primaires, liens d'action, focus ring
    600: '#1E46C4',            // hover
    50:  '#E8EEFF',            // fonds sélection (item actif de dropdown, pill)
  },
  accent: {                    // signature Dodo — Native Amber, JAMAIS pour la donnée
    DEFAULT: '#DFA218',        // soulignement nav active, progress onboarding, focus marque
  },
  inflow: {                    // Entrées — Morne Green, réservé à la donnée financière
    DEFAULT: '#157A4A',        // montants, icônes, barres de graphe
    700: '#0F5C37',            // texte sur fond clair (AA)
    bg:  '#E4EFE6',            // pastille icône, badge
  },
  outflow: {                   // Sorties — rouge corail, réservé à la donnée financière
    DEFAULT: '#BF3B2F',        // montants, icônes, barres de graphe
    700: '#9C2F25',            // texte sur fond clair (AA)
    bg:  '#F6E4DF',            // pastille icône, badge
  },
  danger:  { DEFAULT: '#BF3B2F', bg: '#F6E4DF' },  // erreurs système (≠ sorties : toujours icône + contexte)
  success: { DEFAULT: '#1D9E55', bg: '#E4EFE6' },  // confirmations, toasts succès, coches
  warning: { DEFAULT: '#8A6108', bg: '#F7E8C3' },  // fraîcheur ambre, états partiels
  surface: {
    page:  '#F5F2E9',          // fond de page — Reef White (sable très clair)
    card:  '#FFFFFF',          // cartes
    inset: '#F0ECDF',          // inputs, pills de filtre, cellule éditable
    forecast: '#EFEBDD',       // fond des colonnes/zones PRÉVISIONNEL (§3.5)
  },
  line: { DEFAULT: '#E8E3D5', strong: '#D8D2C2' }, // séparateurs, bordures (sable)
  text: {
    DEFAULT: '#0C1633',        // texte principal (Island Night)
    muted:  '#5C6274',         // labels, méta, en-têtes de table
    faint:  '#8A8F9F',         // placeholders, désactivé, valeurs prévisionnelles
    onink:  '#FFFFFF',         // texte sur navbar ink
    oninkMuted: 'rgba(255,255,255,0.64)', // items nav inactifs
  },
  chart: {
    position: '#2C5FE8',       // ligne de position de trésorerie (Lagoon Blue)
    positionFill: '#D8E4FB',   // aire sous la courbe (réalisé)
    forecastFill: '#EDF2FB',   // aire prévisionnelle (plus claire)
    threshold: '#BF3B2F',      // ligne de seuil/zéro (continue, 1.5px)
    donut: '#5BA8D9',          // séries neutres d'analyse (non sémantiques)
    // Palette CATÉGORIELLE du camembert « Analyse par catégorie ». Teintes
    // distinctes et harmonisées Dodo, réservées aux PARTS de donut. Le vert/rouge
    // sémantique (inflow/outflow) reste réservé aux MONTANTS — jamais à une
    // catégorie. Au-delà de 8 catégories : le reste bascule sur `catNeutral`
    // (queue neutre) ; « Non catégorisé » est TOUJOURS `catNeutral`.
    cat: [
      '#2C5FE8', // 1 — Lagoon Blue (primary)
      '#DFA218', // 2 — Native Amber (accent)
      '#0E9488', // 3 — Teal lagon
      '#7C5CBF', // 4 — Violet
      '#5BA8D9', // 5 — Sky (donut neutre historique)
      '#C65B8A', // 6 — Rose corail
      '#6B8E23', // 7 — Olive
      '#D9772E', // 8 — Terre cuite
    ],
    catNeutral: '#B3B9C9',     // queue « Autres » + « Non catégorisé » (gris ardoise)
  },
}
```

```js
// Rayons, ombres, espacement
borderRadius: { card: '12px', control: '8px', modal: '16px', pill: '9999px' }
boxShadow: {
  card:    '0 1px 2px rgba(12,22,51,0.05)',                  // cartes — JAMAIS plus
  popover: '0 12px 24px -6px rgba(12,22,51,0.16)',           // dropdowns, popovers
  modal:   '0 24px 48px -12px rgba(12,22,51,0.24)',
}
// Échelle d'espacement : base 4px. Valeurs canoniques : 4/8/12/16/24/32.
```

**Typographies.**
- UI & display : **Red Hat Display** (400/500/600/700), variable `--font-red-hat`.
  Pas d'Inter/Roboto/system-ui.
- Montants & tables : **Red Hat Display** avec `font-variant-numeric: tabular-nums`
  (tnum supporté) — obligatoire sur TOUT montant, axe de graphe et cellule numérique
  (alignement vertical des chiffres = clarté financière). Police unifiée UI/montants :
  plus de couple display/chiffres séparé.
- Monospace (réservé aux identifiants techniques, ex. HMAC tronqué du panneau
  audit) : **Geist Mono**, variable `--font-mono`.
- Chargement : `next/font` (Google), `display: swap`.

---

## 1. Layout global — structure asymétrique

### 1.1 Anatomie (reprise FYGR, validée sur 6 sections)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HEADER ink (h-16, full-bleed) :                                              │
│  logo Dodo · [sélecteur workspace + refresh] · nav (active: souligné accent) │
│  · avatar · (badge DEMO si workspace démo — non fermable)                    │
├────────────────┬─────────────────────────────────────────────────────────────┤
│ SIDE-PANEL     │  ZONE DE DONNÉES (scrollable, min-w-0)                      │
│ KPIs FIXE      │  ┌ Toolbar contextuelle (h-10) ────────────────────────┐    │
│ (w-[300px],    │  │ filtres à gauche · vue/exports/CTA primaire à droite│    │
│  sticky        │  └─────────────────────────────────────────────────────┘    │
│  top-16,       │  ┌ Carte de contenu (bg-card, rounded-card, shadow-card)    │
│  collapsible)  │  │  graphe / matrice / table — UNE ancre par écran          │
│                │  └──────────────────────────────────────────────────────    │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

Règles :
- **Side-panel** : `aside` de **300px** fixes (`w-[300px] shrink-0`), sticky sous le
  header, **scroll indépendant** de la zone de données. Collapsible (chevron « en
  haut à droite du panel ; état persisté par utilisateur). Gouttière entre panel et
  zone : **24px**. Marges de page : 24px (≥1280px), 16px (768-1280px).
- Le side-panel est une **pile de cartes blanches** (gap 24px), jamais une surface
  continue. Carte 1 = solde ; cartes suivantes = KPIs contextuels de la page.
- **Zone de données** : toolbar SANS carte (posée sur le fond de page), contenu DANS
  des cartes. Une seule ancre visuelle par écran (la courbe sur le dashboard, la
  table sur Transactions) — pas de mosaïque de cartes égales.
- Pages **avec** side-panel : Dashboard, Échéances (KPIs : solde, totaux clients/
  fournisseurs/global). Pages **sans** : Transactions, Catégories, Admin (la table
  pleine largeur EST l'écran). Ne pas forcer le panel là où il n'apporte rien.
- Breakpoints : 1280px = layout complet ; 768-1280 = side-panel replié par défaut ;
  <768 (mobile lecture seule) = KPIs du panel deviennent une rangée scrollable de
  cartes au-dessus du contenu, nav = bottom-nav 4 entrées.

### 1.2 Header (top-nav)

- Fond `ink`, hauteur 64px, texte `text-onink`.
- Ordre : logo (gauche) → sélecteur de workspace (pill claire `surface-inset`,
  largeur ~200px, recherche intégrée + "+ Ajouter") → icône refresh → liens de nav →
  avatar/menu profil.
- **État actif** : texte blanc 600 + barre `accent` de 4px, rayon 2px, collée au bas
  du header, largeur du label. Inactif : `text-oninkMuted`, hover → blanc.
  (Divergence assumée vs FYGR : FYGR souligne en vert, couleur qu'il réutilise pour
  les entrées ; TYGR réserve le vert à la donnée → soulignement ambre `accent`.)
- Le **badge workspace actif** (nom + kind) reste visible dans le header sur toutes
  les pages ; workspace DEMO → bandeau ambre permanent sous le header :
  "Données fictives — environnement de démonstration".

### 1.3 Carte KPI du side-panel (anatomie exacte)

```
┌─────────────────────────────────┐
│ SOLDE              Aujourd'hui  │  label: 11px/600 uppercase tracking +0.08em
│                                 │         text-muted · méta à droite 12px
│ [icône] 7 691 €      [œil]      │  icône 32×32 rounded-lg bg primary-50
│                                 │  montant: 28px/700 Geist tabular, text-ink
├─────────────────────────────────┤  (carte solde : montant en primary)
│ DÉTAILS              Juin 2026  │
│ [↓] Entrées      1 000 €        │  rangée KPI : icône 32×32 rounded-lg
│ [↑] Sorties        274 €        │  (bg inflow-bg / outflow-bg, icône 700),
│ [▦] Variation      726 €        │  label 13px text-muted au-dessus,
└─────────────────────────────────┘  montant 18px/600 tabular coloré (700)
```
Padding carte : **24px**. Gap entre rangées KPI : 20px. Masquage du solde : icône
œil → montant remplacé par "••••" (état persisté).

---

## 2. Typographie, espacements, densité

### 2.1 Échelle typographique (tout en Instrument Sans sauf mention)

| Rôle | Taille/Graisse | Usage |
|---|---|---|
| Solde principal | 28px / 700, Geist tabular | carte SOLDE, centre du donut |
| KPI side-panel | 18px / 600, Geist tabular | Entrées/Sorties/Variation |
| Titre de carte | 16px / 600 | "Analyse par catégorie" |
| Sous-titre / période | 13px / 400, text-muted | "01/01/2026 - 31/12/2026" |
| Label de section | 11px / 600, uppercase, +0.08em, text-muted | SOLDE, DÉTAILS, FILTRES |
| Nav header | 14px / 500 | liens de navigation |
| En-tête de table | 12px / 600, uppercase, +0.04em, text-muted | DATE, LIBELLÉ… |
| Cellule de table | 13px / 400 | libellés ; montants en Geist tabular 13px |
| Ligne de synthèse (matrice) | 13px / 700 | Position début/fin de période |
| Corps / formulaires | 14px / 400 | modales, paramètres |
| Bouton | 14px / 600 | tous boutons |
| Tooltip / méta | 12px / 400 | infobulles, horodatages |

Plancher absolu : 11px (uniquement labels uppercase). Jamais de corps <13px.

### 2.2 Densité et padding

- **Carte de résumé / KPI** : padding **24px** ; gap interne 20px.
- **Carte de contenu** (graphe, table) : padding 24px ; le graphe peut déborder à
  16px du bord pour maximiser la zone de dessin.
- **Tables denses** (transactions, échéances) : `py-14px px-16px` par cellule,
  hauteur de ligne ~44px, séparateur `line` 1px ; PAS de zébrage — le blanc + les
  séparateurs fins suffisent à la densité voulue.
- **Matrice de flux** : lignes de **40px** (plus dense que les tables), cellules
  `py-10px px-12px`, montants alignés à droite.
- **Toolbar** : contrôles h-40px, gap 12px ; pills de filtre `surface-inset`
  rounded-control, padding 8/12.
- **Modales** : largeur 480px (formulaire simple) / 720px (tableaux de règles),
  padding 32px, titre 15px/600 uppercase centré, +0.04em.
- **Popovers** (filtres, sélecteurs de colonnes) : largeur 320-360px, padding 16px,
  ancrés au déclencheur, shadow-popover.

### 2.3 Boutons et contrôles (hiérarchie stricte)

| Rang | Style | Usage |
|---|---|---|
| Primaire | fond `primary`, texte blanc, h-40, rounded-control | 1 max par toolbar ("+ Ajouter une banque", "Scénario") |
| Validation de modale | fond `success`, texte blanc | "Valider", "Importer" — uniquement DANS les surfaces de confirmation |
| Secondaire | fond `surface-inset`, texte ink, bordure `line` | exports, toggles de vue |
| Lien d'action | texte `primary` 600, icône "+" optionnelle | "+ Ajouter une facture", "Voir mes règles", "Annuler" |
| Destructif | texte/`danger`, confirmation obligatoire | suppression, révocation |

- Segmented control (Comptes/Périodicité, Clients/Fournisseurs) : conteneur
  `surface-inset` rounded-control, segment actif = **pill `ink` texte blanc**.
- Checkbox cochée = `success` ; radio sélectionné = `success` ; switch actif =
  `success`. Focus visible : ring 2px `primary` offset 2px, partout.
- États désactivés : opacité 48%, jamais de suppression d'élément (sauf surfaces
  admin, cachées selon le rôle — règle D2 du plan).
- Inputs : fond `surface-inset` OU blanc + bordure `line` ; focus → bordure
  `primary` + ring ; placeholder `text-faint` ; erreur → bordure `danger` + message
  12px `danger` sous le champ (jamais d'erreur silencieuse).

---

## 3. Couleurs sémantiques de la donnée financière

### 3.1 Règle d'or
**Le vert et le rouge appartiennent à la donnée.** Aucun élément de chrome (nav,
boutons secondaires, décorations) n'utilise `inflow`/`outflow`. Le seul vert hors
donnée est `success` (validation), visuellement distinct (plus foncé, contexte
bouton/coche). La marque s'exprime en `ink` + `accent` ambre.

### 3.2 Entrées (vert)
- Montant texte : `inflow-700` (#15803D) sur blanc — contraste AA.
- Icône : flèche ↓ dans pastille 32px `inflow-bg`, glyphe `inflow-700`.
- Graphe (barres d'entrées) : `inflow` (#16A34A), opacité 100% réalisé / 45% prévu.
- Format : `+1 000 €` dans les tooltips et variations ; sans signe dans les listes
  où la colonne est explicitement "Entrées".

### 3.3 Sorties (rouge)
- Montant texte : `outflow-700` (#B91C1C) sur blanc.
- Icône : flèche ↑ pastille `outflow-bg`.
- Graphe : `outflow` (#DC2626), mêmes règles d'opacité.
- Format : `-274 €` partout où le contexte n'est pas explicite ; signe moins
  typographique, jamais de parenthèses comptables.

### 3.4 Distinction sorties vs erreurs (décision explicite)
Les sorties (rouge #DC2626) et les erreurs système (`danger` #B42318 + fond
`danger-bg` + icône + message) ne se confondent jamais : une erreur a TOUJOURS un
fond teinté, une icône et un texte ; une sortie n'est qu'un montant/une barre.
*Cette règle remplace la note D4 du plan v2.1 ("débit neutre") — le benchmark et la
demande produit tranchent pour le rouge.*

### 3.5 Prévisionnel vs Réalisé (traitement visuel différencié)
Repris de FYGR (vue tableau du dashboard) et généralisé :

| Surface | Réalisé | Prévisionnel |
|---|---|---|
| Colonnes de matrice | fond blanc, valeurs `text` | **fond `surface-forecast`** continu sur toute la colonne, valeurs `text-faint`, sous-label d'en-tête "Prévision" 11px italique `text-faint` |
| Colonne pivot (mois courant) | sous-label "Réalisé à date" 11px en `primary` | — |
| Courbe de position | trait `chart-position` 2px plein + aire `chart-positionFill` | même trait à 40% d'opacité + aire `chart-forecastFill` ; **séparateur vertical "aujourd'hui"** : pointillé 1px `line-strong` sur toute la hauteur |
| Barres entrées/sorties | opacité 100% | opacité 45% |
| Badge | — | badge "Prévision" 11px `surface-forecast` bordure `line` si une valeur isolée est projetée |

Le basculement réalisé→prévisionnel est TOUJOURS marqué par les deux signaux
(fond/opacité + label) — jamais par la couleur seule (accessibilité).

### 3.6 Statuts d'échéances (badges)
`En cours` primary-50/primary · `En retard` outflow-bg/outflow-700 ·
`Partiel` warning-bg/warning · `Paiement en cours` primary-50/primary ·
`Payée` success-bg/success · `Annulée` surface-inset/text-muted.
Badge : 12px/500, padding 2/8, rounded-pill, fond pastel + texte 700 — jamais de
fond saturé.

### 3.7 Fraîcheur des données (lien SLO, règle D4 du plan)
Pastille + horodatage relatif près du solde : vert `success` <6h · ambre `warning`
<24h · rouge `danger` ≥24h avec CTA "Reconnecter" (mode Repair). Tooltip :
horodatage absolu + compte concerné.

---

## 4. Composants complexes

### 4.1 Matrice de flux (tableau pivot horizontal à lignes extensibles)

Structure exacte (reprise de la vue tableau FYGR, adaptée aux tokens TYGR) :

```
                 │ DÉC.25   JAN.26 … │ JUIN.26        ║ JUIL.26   AOÛT.26 …
                 │                   │ Réalisé à date ║ Prévision Prévision   ← en-têtes
═════════════════╪═══════════════════╪════════════════╬═════════════════════
 Position début  │  3 548    1 694   │   6 965        ║  6 965     7 691      ← synthèse (700)
 ↓ Entrées       │    500   13 500   │   1 000        ║      0         0      ← vert
 ↑ Sorties       │ -2 354   -5 051   │    -274        ║      0         0      ← rouge
 ~ Variation     │ -1 854   +8 449   │    +726        ║      0         0
 Position fin    │  1 694   10 143   │   7 691        ║  7 691     7 691      ← synthèse (700)
─────────────────┼───────────────────┼────────────────╫─────────────────────
 ▼ Incomes       │      0        0   │       0        ║      0         0      ← catégorie niv.1
    Main incomes │      0        0   │       0        ║      0         0      ← sous-ligne
    Others       │      0        0   │       0        ║      0         0
 ▶ Suppliers     │      0        0   │       0        ║      0         0      ← repliée
 …
                 └──── [scrollbar horizontale persistante] ────┘
                                       ║ = début de la zone PRÉVISION (fond grisé)
```

Règles normatives :
1. **Colonne 0 sticky** (`position: sticky; left: 0`, fond blanc, ombre portée
   1px `line` quand la matrice scrolle horizontalement). Largeur 220px.
2. **Bloc de synthèse sticky** : les 5 lignes de synthèse restent visibles
   (`sticky top` sous l'en-tête) quand on scrolle verticalement les catégories.
   Position début/fin en 700 ; séparateur `line-strong` 1px sous le bloc.
3. **Colonnes de mois** : largeur fixe 96px, en-tête `MMM.AA` uppercase 12px ;
   navigation par chevrons ‹ › aux extrémités de l'en-tête ; le mois courant porte
   le sous-label "Réalisé à date" (`primary`) et marque la frontière
   réalisé/prévision (§3.5 : fond `surface-forecast` à partir de la colonne
   suivante, jusqu'au bout).
4. **Lignes extensibles** : chevron ▶/▼ 16px à gauche du libellé (zone cliquable =
   toute la cellule libellé) ; sous-lignes indentées de 24px, 13px/400 ;
   profondeur max 2 (catégorie → sous-catégorie, aligné sur le plan analytique).
   Animation d'ouverture : height 150ms ease-out, pas de fade.
5. **Montants** : Geist tabular 13px alignés à droite ; zéro = "0" en `text-faint` ;
   négatifs avec signe moins ; pas de symbole € dans les cellules (le contexte le
   porte — règle de densité), symbole présent dans tooltips et exports.
6. **Hover de ligne** : fond `#FAFBFE` ; hover de cellule : tooltip après 400ms
   avec le détail (mois, catégorie, valeur formatée avec €, réalisé/prévision).
7. **Édition prévisionnelle** (Epic 4, anticipé) : cellule prévisionnelle
   double-cliquable → input inline `surface-inset` ; valeur saisie = 600 + petit
   point `accent` en coin (marqueur "saisie manuelle").
8. Accessibilité : `<table>` sémantique, `aria-expanded` sur les lignes parentes,
   navigation clavier (flèches entre cellules, Enter pour déplier), focus visible.

### 4.2 Courbe de trésorerie (ancre du dashboard — Tremor ComboChart)
- Hauteur ~55vh (min 380px). Ligne de position `chart-position` + aire ; barres
  entrées/sorties par période ; ligne de seuil `chart-threshold` continue 1.5px
  (seuil d'alerte configurable, 0 par défaut) ; séparateur "aujourd'hui" (§3.5).
- Tooltip (pattern FYGR repris) : carte blanche shadow-popover, en-tête mois
  uppercase 12px, rangées Début / Entrées (vert) / Sorties (rouge) / Variation /
  Fin, valeurs tabular alignées à droite, format complet avec €.
- Légende : pastilles 8px + libellés 12px, au-dessus du graphe à droite.
- Axe Y : Geist tabular 11px, format compact (`12 k€`) ; axe X : `MMM AA`.

### 4.3 Panneau audit temps réel (spécifique TYGR — pas dans FYGR)
Colonne droite 360px (consent flow) / repliable en icône header (dashboard).
Ligne d'événement : pastille type (8px, `success`/`primary`/`danger`) + libellé
13px + horodatage 12px `text-muted` + HMAC tronqué 8 chars JetBrains Mono 11px
`text-faint`. Insertion : slide+fade 200ms. `aria-live="polite"`. Cap 200 lignes +
lien "Exporter pour tout voir". États : vide ("En attente du premier événement…"),
flux interrompu (bandeau warning + retry auto).

### 4.4 Patterns transverses (repris du benchmark)
- **Empty states** : illustration outline légère (style nuage FYGR, à redessiner
  aux couleurs TYGR), message 14px `text-muted`, UN CTA (lien bleu ou bouton
  primaire). Jamais de texte seul type "No data".
- **Dropdown riche** (sélecteur workspace, catégories) : recherche en tête
  (focus auto), liste hiérarchique avec indentation 24px, item actif fond
  `primary` texte blanc OU coche `success` (multi-select), pied avec lien
  "+ Ajouter…" et/ou bouton Valider `success`.
- **Popover de filtres** : ancré à droite, sections labellisées uppercase 11px,
  montant min/max, plage de dates, multi-selects ; bouton `success` "Valider" ;
  compteur de filtres actifs sur l'icône (badge `primary` 16px).
- **Sélecteur de colonnes** : popover checkboxes + "Colonnes par défaut" (lien) —
  pattern FYGR repris pour la table des échéances.
- **Toasts** : coin bas-droit, fond blanc, liseré 3px (success/danger/warning),
  auto-dismiss 5s sauf erreurs (manuel).
- **Modales** : titre uppercase centré, corps 14px, bouton `success` centré +
  lien "Annuler" `primary` dessous (pattern FYGR) ; croix en haut à droite ;
  overlay `rgba(15,30,61,0.48)` ; Escape + clic-overlay ferment (sauf
  destructif : confirmation explicite requise, double confirmation pour la
  révocation de consentement — règle D2 du plan).
- **Onboarding chip** (guide de démarrage) : carte `ink` bas-gauche, 13px blanc,
  progress bar `accent` 4px, réductible. Réservé au premier parcours.

---

## 5. Ce qu'on ne reprend PAS de FYGR (divergences assumées)

| Pattern FYGR | Décision TYGR | Pourquoi |
|---|---|---|
| Vert utilisé à la fois pour nav active, validation ET entrées | Vert = donnée + validation uniquement ; nav active = `accent` ambre | Le vert "marque" dilue le vert "donnée" — la clarté financière exige des canaux sémantiques étanches |
| Bleu roi (#2D5BFF) + navy comme identité | `ink` #0F1E3D + `primary` #2447D6 + signature ambre | Identité distincte (trade dress), même famille de sobriété |
| Boutons mint clair (#5CD99B) parfois à faible contraste | `success` #079455 (AA sur blanc) | Accessibilité AA non négociable (audience régulateur) |
| Drapeau de langue dans le header | Pas de sélecteur visible au MVP (FR seul, T-D3) | Chaînes externalisées, EN en phase 2 |
| Donut "Category analysis" en première position des rapports | Donut disponible mais jamais comme ancre d'écran | Une ancre par écran ; le donut est secondaire |
| Intercom bubble bas-gauche | Position réservée à l'onboarding chip ; support → menu profil | Deux éléments flottants = bruit |

---

## 6. Checklist d'application (pour toute nouvelle vue)

1. Une seule ancre visuelle ; hiérarchie solde → tendance → détail respectée ?
2. Tous les montants en Geist `tabular-nums`, alignés à droite dans les tables ?
3. Vert/rouge uniquement sur la donnée ; erreurs avec fond + icône + message ?
4. Prévisionnel marqué par fond `surface-forecast` OU opacité 45% ET label ?
5. États loading (skeleton) / vide (CTA) / erreur (recovery) / partiel spécifiés ?
6. Focus ring visible, contrastes AA, `aria-live` sur les flux temps réel ?
7. Side-panel seulement si des KPIs contextuels existent ; sinon pleine largeur ?
8. Workspace visible (badge header) ; bandeau DEMO si kind=DEMO ?
```
