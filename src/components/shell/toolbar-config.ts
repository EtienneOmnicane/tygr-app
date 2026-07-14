/**
 * Configuration de la BARRE DE VUE par page (TOOLBAR-GLOBALE-CADRAGE1, lot A2 —
 * matrice validée par Etienne le 2026-07-14 ; plan `PLAN-toolbar-config.md`).
 *
 * Pourquoi ce module existe : `AppTopbar` est montée GLOBALEMENT par
 * `(workspace)/layout.tsx` → jusqu'ici, période + périmètre + CTA s'affichaient sur
 * TOUTES les pages, y compris là où le contrôle n'a AUCUN effet (la période sur
 * /banques, /regles, /admin/*). Un contrôle affiché sur une page qu'il ne filtre pas
 * est un MENSONGE D'AFFICHAGE : l'utilisateur croit borner sa vue, la page ignore le
 * réglage. Même classe de défaut que le bug A4 (topbar annonçant « Sucre » pendant
 * que la table montrait tous les comptes).
 *
 * ⚠️ INVARIANT DE SÉCURITÉ D'USAGE — `perimetre: false` n'est PAS un choix d'esthétique.
 * Le `viewFilter` n'est pas un filtre d'affichage local : c'est un prédicat RLS réel
 * (`app.current_view_filter`, policy `account_scope` RESTRICTIVE en USING **et** WITH
 * CHECK, migrations 0016/0017) porté par le JWT, donc il SUIT l'utilisateur de page en
 * page et mord sur TOUTE page dont la session n'est pas amputée. Donc :
 *
 *   `perimetre: false` n'est légitime QUE si la page ET ses Server Actions tournent sur
 *   une session AMPUTÉE du viewFilter (`exigerSessionAdministration`, session.ts) — ou
 *   si la page vit hors contexte workspace (/selection).
 *
 * Sinon le filtre reste actif, INVISIBLE et INANNULABLE sur place : le sélecteur est le
 * seul moyen de le voir et de le lever. Aujourd'hui seul `/admin/*` est amputé — d'où
 * le périmètre CONSERVÉ sur /banques et /regles (arbitrage Etienne 2026-07-14, cf.
 * TOOLBAR-PERIMETRE-AMPUTATION1 dans TODOS.md ; sur /banques, un filtre actif fait
 * silencieusement attacher 0 compte au sync — bug terrain « spinner puis rien »,
 * documenté dans `banques/actions.ts`).
 *
 * PURE (aucun React, aucun import UI) → c'est LA matrice, et elle est protégée en CI
 * par `tests/unit/toolbar-config.test.ts` (qui vérifie AUSSI l'invariant ci-dessus et
 * qu'aucune route de `src/app/(workspace)/` ne manque à la matrice).
 *
 * ⚠️ Ce module ne GATE que l'affichage de contrôles d'UI : il n'est JAMAIS une garde de
 * SÉCURITÉ (règle 2 — la RLS reste seule autorité de ce qu'une page a le DROIT de lire ;
 * masquer un contrôle ne restreint rien). Il engage en revanche la CORRECTION de
 * l'affichage et la RÉCUPÉRABILITÉ (cf. invariant) : c'est là qu'est le risque.
 */

/** Contrôles montés par la barre de vue pour une page donnée. */
export type ConfigBarreVue = {
  /** Presets de période (`?periode`) — `PeriodeSwitcher`. Pur filtre de LECTURE (URL). */
  periode: boolean;
  /** Périmètre comptes/entités — `PerimetreSwitcher`. Cf. INVARIANT en tête de fichier. */
  perimetre: boolean;
  /** CTA permanent « Connecter une banque » — `BankCtaLink`. */
  cta: boolean;
  /**
   * Bande MINIMALE : fine bande de contexte SANS aucun contrôle, portant le seul repère
   * de TENANT (nom du workspace). Elle existe pour que la colonne de contenu ne démarre
   * pas nue et qu'on sache toujours dans quel espace on agit.
   * INVARIANT : `minimal === true` ⇒ les trois contrôles sont `false`.
   */
  minimal: boolean;
};

/** Barre complète — les contrôles listés sont montés (aucune bande de repère). */
function barre(controles: {
  periode: boolean;
  perimetre: boolean;
  cta: boolean;
}): ConfigBarreVue {
  return { ...controles, minimal: false };
}

/**
 * Bande minimale : repère de tenant seul, AUCUN contrôle.
 * RÉSERVÉE aux surfaces dont la session est amputée du viewFilter (`/admin/*`) — sur une
 * page à session complète, retirer le périmètre piégerait l'utilisateur (cf. INVARIANT).
 */
const MINIMALE: ConfigBarreVue = {
  periode: false,
  perimetre: false,
  cta: false,
  minimal: true,
};

/** Aucune barre du tout : `AppTopbar` ne rend RIEN (pas de `<header>` vide). */
const AUCUNE: ConfigBarreVue = {
  periode: false,
  perimetre: false,
  cta: false,
  minimal: false,
};

/**
 * Défaut EXPLICITE de toute page non cadrée (règle : « pas de silence »).
 *
 * FAIL-SAFE, et le sens de ce défaut découle de l'INVARIANT en tête de fichier :
 *   - `perimetre: true` — le viewFilter SUIT l'utilisateur partout et mord sur toute page
 *     à session complète. Une page ajoutée demain sans toucher cette matrice tournerait
 *     donc sous un filtre actif : sans le sélecteur, il serait invisible ET inannulable.
 *     On garde la trappe de sortie. (Ce n'est pas un contrôle « qui ment » : il agit bel
 *     et bien sur cette page — c'est précisément le problème.)
 *   - `periode: false` — la période, elle, est un pur filtre de LECTURE que la page doit
 *     lire explicitement (`?periode`). Une page qui ne l'a pas déclarée ne le lit pas :
 *     l'afficher serait un vrai no-op, donc un vrai mensonge.
 *   - `cta: false` — une page n'est un point d'entrée de connexion bancaire que si elle
 *     le déclare.
 */
const DEFAUT: ConfigBarreVue = barre({
  periode: false,
  perimetre: true,
  cta: false,
});

/**
 * Matrice validée (Etienne, 2026-07-14), indexée par le PREMIER SEGMENT du pathname.
 *
 * Segment (pas pathname exact) : une sous-route future (`/transactions/<id>`) hérite de
 * la config de sa page mère au lieu de tomber dans le défaut. `/admin/membres` et
 * `/admin/entites` partagent donc le segment `admin` — les deux sont minimales, ce qui
 * est exactement la matrice.
 *
 * Exportée pour que les tests puissent PARCOURIR la matrice (garde CI de l'invariant
 * `perimetre: false`) — jamais mutée à l'exécution.
 */
export const MATRICE_BARRE_VUE: Readonly<Record<string, ConfigBarreVue>> = {
  // Dashboard (route racine du groupe (workspace) — le route group `(dashboard)`
  // n'apparaît PAS dans le pathname).
  "": barre({ periode: true, perimetre: true, cta: true }),
  transactions: barre({ periode: true, perimetre: true, cta: true }),
  // Graphiques : période + périmètre, mais pas de CTA (l'écran n'est pas un point
  // d'entrée de connexion bancaire — ses états vides portent déjà leur propre CTA).
  graphiques: barre({ periode: true, perimetre: true, cta: false }),
  // Échéances : PAS de période — l'écran regarde le FUTUR, or les presets sont
  // rétrospectifs (Ce mois / 3m / 6m / 12m). Un horizon futur viendra en chantier séparé.
  echeances: barre({ periode: false, perimetre: true, cta: false }),
  // Banques : pas de période (on gère des CONNEXIONS, pas une vue datée). Le CTA reste :
  // c'est la page de destination de l'action.
  // PÉRIMÈTRE CONSERVÉ (≠ matrice initiale — arbitrage Etienne 2026-07-14) : la page et
  // ses Server Actions tournent sur `exigerSessionWorkspace` (session COMPLÈTE) → le
  // viewFilter mord ENCORE ici (sync qui attache 0 compte sans erreur, compteurs de
  // connexions faux). Le retirer supprimerait le seul moyen de voir/annuler le filtre.
  // À retirer SEULEMENT avec l'amputation serveur (TOOLBAR-PERIMETRE-AMPUTATION1, P1).
  banques: barre({ periode: false, perimetre: true, cta: true }),
  // Règles : ni période ni CTA (surface de configuration).
  // PÉRIMÈTRE CONSERVÉ, même raison que /banques : `appliquerReglesAction` tourne sur une
  // session complète → « Ré-analyser » ne recatégorise que le périmètre filtré. Masquer
  // le sélecteur ferait croire à une ré-analyse totale. Idem : lié à l'amputation P1.
  regles: barre({ periode: false, perimetre: true, cta: false }),
  // Admin (membres + entités) : SEULE surface légitimement MINIMALE aujourd'hui — ses
  // pages ET actions passent par `exigerSessionAdministration()` (session amputée du
  // viewFilter, session.ts) → aucun filtre ne mord, il n'y a donc rien à voir ni à
  // annuler. Le repère de tenant y dit la vérité : l'écran porte bien tout le groupe.
  admin: MINIMALE,
  // Sélection de workspace : on n'est encore DANS aucun espace → aucune barre.
  selection: AUCUNE,
};

/**
 * Premier segment du pathname, normalisé. Défensif (la fonction est pure et testée
 * seule) : `usePathname` ne rend ni query ni hash, mais on ne veut pas qu'un appelant
 * futur casse la matrice sur un `?periode=3m` collé au chemin.
 *
 * "" | "/" | "/?x=1" → "" (dashboard).
 */
function segmentRacine(pathname: string): string {
  const chemin = pathname.split("?")[0]!.split("#")[0]!;
  return chemin.split("/").filter(Boolean)[0] ?? "";
}

/** Config de la barre de vue pour un pathname. Page non cadrée → `DEFAUT` (fail-safe). */
export function toolbarConfig(pathname: string): ConfigBarreVue {
  return MATRICE_BARRE_VUE[segmentRacine(pathname)] ?? DEFAUT;
}

/** Le défaut, exporté pour la garde CI (une page non cadrée garde sa trappe de sortie). */
export const CONFIG_DEFAUT: ConfigBarreVue = DEFAUT;
