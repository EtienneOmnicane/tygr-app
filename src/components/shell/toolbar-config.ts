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
 * seul moyen de le voir et de le lever. Surfaces amputées à ce jour : `/admin/*`
 * (`exigerSessionAdministration`) ET `/banques` + `/regles` (`exigerSessionSansPerimetre`,
 * TOOLBAR-PERIMETRE-AMPUTATION1, livré) — leurs pages ET leurs Server Actions
 * reconstruisent la session sans viewFilter (session.ts), d'où le périmètre RETIRÉ. Sur
 * `/banques` un filtre résiduel faisait attacher 0 compte au sync (bug « spinner puis
 * rien ») ; sur `/regles` « Ré-analyser » ne portait que sur le périmètre filtré.
 *
 * PURE (aucun React, aucun import UI) → c'est LA matrice, et elle est protégée en CI
 * par `tests/unit/toolbar-config.test.ts` (qui vérifie AUSSI l'invariant ci-dessus et
 * qu'aucune route de `src/app/(workspace)/` ne manque à la matrice).
 *
 * ⚠️ INVARIANT ANTI-MENSONGE (lot A1, 2026-07-14) — `periode: true` ou `plageDates: true`
 * n'est légitime QUE si la `page.tsx` du segment LIT réellement les params, c.-à-d.
 * appelle `resoudrePeriode(searchParams)`. Sinon le contrôle est un NO-OP : l'utilisateur
 * croit borner sa vue, la page ignore le réglage — le mensonge que ce lot combat.
 *
 * Ce n'est pas une consigne de vigilance : c'est une GARDE CI (toolbar-config.test.ts,
 * « une page qui MONTE la période doit la LIRE ») qui relit le source des pages. Elle est
 * née d'un défaut RÉEL : A2 avait mis `periode: true` sur `/graphiques` ET `/transactions`,
 * or AUCUNE des deux ne lit `?periode` (les deux ont leur propre filtre IN-PAGE) → deux
 * PeriodeSwitcher qui ne filtraient rien. Corrigé ici pour `/graphiques` ; `/transactions`
 * est une exemption NOMMÉE de la garde jusqu'à A3 (TX-TOOLBAR-DEDUP1).
 *
 * ⚠️ Ce module ne GATE que l'affichage de contrôles d'UI : il n'est JAMAIS une garde de
 * SÉCURITÉ (règle 2 — la RLS reste seule autorité de ce qu'une page a le DROIT de lire ;
 * masquer un contrôle ne restreint rien). Il engage en revanche la CORRECTION de
 * l'affichage et la RÉCUPÉRABILITÉ (cf. invariants) : c'est là qu'est le risque.
 */

/** Contrôles montés par la barre de vue pour une page donnée. */
export type ConfigBarreVue = {
  /** Presets de période (`?periode`) — `PeriodeSwitcher`. Pur filtre de LECTURE (URL). */
  periode: boolean;
  /**
   * Plage de dates PRÉCISE (`?du`/`?au`) — `PlageDatesSwitcher` (lot A1,
   * TOOLBAR-DATE-PRECISE1). Une plage valide PRIME sur le preset (`lib/periode.ts`).
   *
   * ⚠️ INVARIANT `plageDates: true` ⇒ `periode: true` : la plage prime SUR un preset ;
   * sans le groupe de presets affiché, « primer » n'a pas de sens et l'utilisateur perd
   * le retour arrière en un clic. Gardé en CI.
   *
   * ⚠️ Et surtout : ne l'activer que sur une page qui LIT réellement `?du`/`?au`
   * (cf. l'invariant ANTI-MENSONGE ci-dessous). Aujourd'hui : le dashboard seul.
   */
  plageDates: boolean;
  /** Périmètre comptes/entités — `PerimetreSwitcher`. Cf. INVARIANT en tête de fichier. */
  perimetre: boolean;
  /** CTA permanent « Connecter une banque » — `BankCtaLink`. */
  cta: boolean;
  /**
   * Bande MINIMALE : fine bande de contexte SANS aucun contrôle, portant le seul repère
   * de TENANT (nom du workspace). Elle existe pour que la colonne de contenu ne démarre
   * pas nue et qu'on sache toujours dans quel espace on agit.
   * INVARIANT : `minimal === true` ⇒ TOUS les contrôles sont `false`.
   */
  minimal: boolean;
};

/**
 * Barre complète — les contrôles listés sont montés (aucune bande de repère).
 * `plageDates` est OPT-IN explicite (défaut `false`) : un contrôle de dates ne s'ajoute
 * jamais par inadvertance à une page dont le serveur ne lit pas `?du`/`?au`.
 */
function barre(controles: {
  periode: boolean;
  plageDates?: boolean;
  perimetre: boolean;
  cta: boolean;
}): ConfigBarreVue {
  return { plageDates: false, ...controles, minimal: false };
}

/**
 * Bande minimale : repère de tenant seul, AUCUN contrôle.
 * RÉSERVÉE aux surfaces dont la session est amputée du viewFilter (`/admin/*`) — sur une
 * page à session complète, retirer le périmètre piégerait l'utilisateur (cf. INVARIANT).
 */
const MINIMALE: ConfigBarreVue = {
  periode: false,
  plageDates: false,
  perimetre: false,
  cta: false,
  minimal: true,
};

/** Aucune barre du tout : `AppTopbar` ne rend RIEN (pas de `<header>` vide). */
const AUCUNE: ConfigBarreVue = {
  periode: false,
  plageDates: false,
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
  // Corollaire direct de `periode: false` (une plage EST un filtre de période, en plus
  // précis) ET de l'invariant `plageDates ⇒ periode` : une page non cadrée ne lit ni
  // `?periode` ni `?du`/`?au`.
  plageDates: false,
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
  // SEULE page câblée sur `?periode` ET `?du`/`?au` (`(dashboard)/page.tsx` →
  // `resoudrePeriode(searchParams)`) → seule page où la plage précise est montée (A1).
  "": barre({ periode: true, plageDates: true, perimetre: true, cta: true }),
  // Transactions : barre COMPLÈTE avec PLAGE — config identique au Dashboard depuis A3
  // (TX-TOOLBAR-DEDUP1, 2026-07-15). Les dates in-page ont été RETIRÉES et la page LIT
  // désormais la fenêtre globale (`resoudrePeriode(await searchParams)` dans
  // transactions/page.tsx, injectée côté serveur) → la barre de vue est la SOURCE UNIQUE
  // de la fenêtre de dates. Fin du NO-OP hérité d'A2 : `transactions` n'est PLUS une
  // exemption de la garde CI anti-mensonge (toolbar-config.test.ts).
  transactions: barre({ periode: true, plageDates: true, perimetre: true, cta: true }),
  // Graphiques : périmètre SEUL. La période a été RETIRÉE (≠ matrice A2, arbitrage
  // Etienne 2026-07-14) : `graphiques/page.tsx` ne prend même pas `searchParams` — son
  // PeriodeSwitcher ne filtrait donc RIEN, pendant que le vrai filtre (segmenté
  // « Ce mois-ci / 30 j / 90 j / 12 mois ») vit IN-PAGE dans `graphiques-feature.tsx`.
  // Retrait = zéro régression (un no-op ne filtre rien) et fin du mensonge. L'unification
  // sur la barre est la dette GRAPHIQUES-PERIODE-DEDUP1 (P2) — elle devra trancher le
  // conflit de vocabulaire (la barre n'a pas de fenêtre glissante 30 j/90 j ; Graphiques
  // n'a pas de « Tout »). Pas de CTA non plus (l'écran n'est pas un point d'entrée
  // bancaire — ses états vides portent déjà leur propre CTA).
  graphiques: barre({ periode: false, perimetre: true, cta: false }),
  // Échéances : PAS de période — l'écran regarde le FUTUR, or les presets sont
  // rétrospectifs (Ce mois / 3m / 6m / 12m). Un horizon futur viendra en chantier séparé.
  echeances: barre({ periode: false, perimetre: true, cta: false }),
  // Banques : pas de période (on gère des CONNEXIONS, pas une vue datée). Le CTA reste :
  // c'est la page de destination de l'action.
  // PÉRIMÈTRE RETIRÉ (TOOLBAR-PERIMETRE-AMPUTATION1, livré) : la page (`banques/page.tsx`)
  // ET toutes ses Server Actions (`banques/actions.ts` ×6, `widget-runtime.ts`) tournent
  // sur `exigerSessionSansPerimetre` (session amputée du viewFilter) → aucun filtre ne
  // mord ici. C'est une surface de GESTION tenant-wide : une connexion attache les comptes
  // de N entités, un filtre résiduel faisait attacher 0 compte au sync (« spinner puis
  // rien »). Rien à voir ni à annuler → pas de sélecteur.
  banques: barre({ periode: false, perimetre: false, cta: true }),
  // Règles : ni période ni CTA (surface de configuration), et périmètre RETIRÉ
  // (TOOLBAR-PERIMETRE-AMPUTATION1, livré) → PLUS AUCUN contrôle. La page ET ses Server
  // Actions d'ÉCRITURE (créer/modifier/archiver/réordonner/ré-analyser) tournent amputées.
  // La seule réellement distordue par un filtre était « Ré-analyser » (`appliquerReglesAction`,
  // INNER JOIN bank_accounts → recatégorisation partielle) ; désormais elle porte sur tout
  // le tenant. (La lecture `listerReglesAction` reste en session complète : règles
  // workspace-global, immunes au viewFilter — rien à amputer.)
  // Sans aucun contrôle à monter, `/regles` rejoint `/admin/*` en bande MINIMALE (repère de
  // tenant seul) : on reste DANS un workspace, la colonne ne doit pas démarrer nue (une
  // barre « tout à false » non-minimale ne rendrait RIEN — réservé à /selection).
  regles: MINIMALE,
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
