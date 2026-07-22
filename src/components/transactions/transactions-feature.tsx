"use client";

/**
 * Conteneur CLIENT de la page /transactions. Orchestre l'état piloté navigateur :
 * filtres, pagination par curseur (« Charger plus »), et l'ouverture de la
 * SplitAllocationModal au clic sur une ligne.
 *
 * Frontière : présentationnel + état local UNIQUEMENT. Toute la donnée passe par
 * les actions injectées (`ActionsTransactions` + actions de catégorisation) — le
 * conteneur ne touche jamais la DB ni n'importe une Server Action en dur, pour
 * rester testable/démontable hors auth (pattern éprouvé sur la modale).
 *
 * Convention « états » (CLAUDE.md) : la 1re page arrive du RSC (props initiales) ;
 * ICI on gère le CLIENT — chargement de page suivante, filtres, ré-essai, et les
 * états Empty/Error/Loading via les composants présentationnels dédiés.
 */
import { useCallback, useMemo, useState } from "react";

import {
  CategoryManagerModal,
  SplitAllocationModal,
  type ActionsReferentielCategories,
  type CategorieUI,
  type ResultatAction,
  type SplitUI,
} from "@/components/ui/category";
import { AppErrorState, cn, EmptyState } from "@/components/ui/states";

import { TransactionsTable } from "./transactions-table";
import { TransactionsLoading } from "./states/transactions-loading";
import { TransactionsSommeNette } from "./transactions-somme-nette";
import { TransactionsToolbar } from "./transactions-toolbar";
import type {
  ActionsTransactions,
  CurseurTransactions,
  FiltresTransactions,
  SommeNetteDevise,
  TransactionListItem,
} from "./types-transactions";

/** Modale en cours : la transaction + ses splits déjà chargés. */
interface ModaleEnCours {
  transaction: TransactionListItem;
  initialSplits: SplitUI[];
}

/**
 * Un filtre est-il actif ? Pilote l'affichage du TOTAL des résultats filtrés
 * (TX-RECHERCHE-SOMME-NETTE1) : sans filtre, la liste EST tout le workspace — un
 * « total des résultats filtrés » n'y voudrait rien dire (c'est le rôle du dashboard),
 * et on s'épargne un agrégat inutile à chaque montage de la page.
 *
 * DÉRIVÉ de l'objet, jamais énuméré champ par champ : `FiltresTransactions` ne contient
 * QUE des filtres (ni curseur ni limite). Recopier la liste ici la ferait diverger au
 * premier filtre ajouté au contrat — et « filtrer par ce nouveau critère » n'afficherait
 * alors AUCUN total, silencieusement.
 */
function filtreActif(f: FiltresTransactions): boolean {
  return Object.values(f).some((v) => v !== undefined && v !== "");
}

export function TransactionsFeature({
  initial,
  categories,
  actions,
  remplacerSplits,
  creerCategorie,
  importerCategoriesStandard,
  actionsReferentiel,
  /** Y a-t-il au moins une banque connectée ? (oriente l'Empty State.) */
  aucuneBanque,
}: {
  /** Première page (chargée en RSC) + son curseur. */
  initial: { lignes: TransactionListItem[]; curseurSuivant: CurseurTransactions | null };
  /** Référentiel de catégories (pour la modale de ventilation). */
  categories: CategorieUI[];
  /** Lecture paginée + chargement des splits (B1/B3bis). */
  actions: ActionsTransactions;
  /** Action atomique de remplacement des splits (remplacerSplitsAction). */
  remplacerSplits: (
    ref: { transactionId: string; transactionDate: string },
    splits: Array<{ categoryId: string; amount: string }>,
  ) => Promise<ResultatAction>;
  /**
   * Crée une catégorie (Nature) depuis le picker de la modale (creerCategorieAction).
   * Optionnel : absent (p. ex. démo) → pas de bouton « Ajouter une catégorie ».
   */
  creerCategorie?: (
    name: string,
  ) => Promise<ResultatAction<{ categoryId: string }>>;
  /**
   * Importe le référentiel STANDARD depuis le picker VIDE (QA-ONBOARD-CATEG1).
   * Optionnel et réservé ADMIN : la page ne passe la closure QUE si l'utilisateur
   * est admin (règle D2) — absent ⇒ pas de CTA d'import dans le picker.
   */
  importerCategoriesStandard?: () => Promise<
    ResultatAction<{ imported: number; categories: CategorieUI[] }>
  >;
  /**
   * Surface d'actions du RÉFÉRENTIEL (créer/renommer/archiver/lister) pour le
   * gestionnaire de catégories (FB0709-CAT-RENOMMER1). Fournie UNIQUEMENT à l'ADMIN
   * (la page ne passe la closure que si `peutAdministrer` — surface ABSENTE du DOM
   * pour un non-admin, pas juste grisée) ; absente ⇒ pas de bouton « Gérer les
   * catégories » DANS LA TOOLBAR. Le serveur reste la vraie garde (repository
   * ADMIN-only).
   */
  actionsReferentiel?: ActionsReferentielCategories;
  aucuneBanque: boolean;
}) {
  // Référentiel de catégories tenu en ÉTAT LOCAL (FB0709-CAT-PICKER-FRAICHEUR1).
  // La 1re valeur vient du RSC (prop `categories`) ; toute catégorie créée depuis
  // le picker d'une modale est APPENDUE ici → elle reste visible pour TOUTES les
  // ouvertures suivantes (modale d'une autre transaction, gestionnaire). Sans ce
  // remonté, la création vivait dans le `useState` LOCAL de chaque SplitAllocationModal,
  // perdu à sa fermeture → « la catégorie créée n'apparaît pas ailleurs » (bug Etienne).
  const [categoriesLocales, setCategoriesLocales] =
    useState<CategorieUI[]>(categories);
  /** Gestionnaire de catégories (renommer/archiver/créer) — ADMIN seul. */
  const [managerOuvert, setManagerOuvert] = useState(false);

  const [lignes, setLignes] = useState<TransactionListItem[]>(initial.lignes);
  const [curseur, setCurseur] = useState<CurseurTransactions | null>(
    initial.curseurSuivant,
  );
  const [filtres, setFiltres] = useState<FiltresTransactions>({});
  // Nature du chargement en cours (plutôt qu'un booléen nu) : on sépare le
  // (re)chargement de la 1re page — qui REMPLACE la liste (filtres/recherche/
  // après-sauvegarde) — de la pagination « Charger plus » (append). `chargement`
  // (dérivé) garde son sens PARTOUT (toolbar/bouton/skeleton) ; seul un
  // REMPLACEMENT (`rafraichissement`) estompe la liste déjà affichée pendant le
  // refetch — la pagination, elle, ne l'estompe pas (les lignes en place ne
  // changent pas, seul le bas s'allonge → estomper serait un artefact).
  const [chargementEnCours, setChargementEnCours] = useState<
    "page" | "plus" | null
  >(null);
  const chargement = chargementEnCours !== null;
  const rafraichissement = chargementEnCours === "page";
  const [erreur, setErreur] = useState(false);
  /** Erreur de pagination (page suivante) — n'efface pas ce qui est affiché. */
  const [erreurPagination, setErreurPagination] = useState(false);
  /**
   * TOTAL des résultats filtrés, par devise (agrégat SERVEUR — le client ne détient
   * qu'une page, sommer ici serait faux : TX-FILTRE1). `null` = rien à afficher : aucun
   * filtre actif, surface sans agrégat (démo), ou échec de l'agrégat. Fail-closed
   * assumé : PAS de chiffre plutôt qu'un chiffre faux ou périmé.
   */
  const [sommeNette, setSommeNette] = useState<SommeNetteDevise[] | null>(null);

  const [modale, setModale] = useState<ModaleEnCours | null>(null);
  const [ouvertureEnCours, setOuvertureEnCours] = useState<string | null>(null);
  /** Échec de chargement des splits à l'ouverture → on N'OUVRE PAS la modale. */
  const [erreurOuverture, setErreurOuverture] = useState(false);

  // Enrobe la closure serveur `creerCategorie` : au succès, APPEND la catégorie
  // créée à l'état local (Nature racine → parentId null, cohérent avec la closure
  // serveur `creerCategorieNature` de la page). Dédoublonné par id (re-append sûr).
  // Le picker/la modale restent PURS : ils reçoivent `categoriesLocales` à jour et
  // remontent la création via cette closure — aucun fetch, aucun état de référentiel
  // chez eux. Retour `ResultatAction` relayé tel quel (l'UI mappe l'erreur).
  const creerCategorieEtRafraichir = useMemo(
    () =>
      creerCategorie
        ? async (name: string) => {
            const res = await creerCategorie(name);
            if (res.ok) {
              const nouvelle: CategorieUI = {
                id: res.data.categoryId,
                name: name.trim(),
                parentId: null,
                isActive: true,
              };
              setCategoriesLocales((prev) =>
                prev.some((c) => c.id === nouvelle.id) ? prev : [...prev, nouvelle],
              );
            }
            return res;
          }
        : undefined,
    [creerCategorie],
  );

  // Enrobe l'import du référentiel standard (picker VIDE, ADMIN) : au succès, on
  // FUSIONNE la liste fraîche renvoyée par le serveur dans l'état local (dédoublonné
  // par id) → le référentiel importé peuple aussitôt tous les pickers, et persiste
  // au-delà de la modale courante (même logique de fraîcheur que la création).
  const importerStandardEtRafraichir = useMemo(
    () =>
      importerCategoriesStandard
        ? async () => {
            const res = await importerCategoriesStandard();
            if (res.ok) {
              setCategoriesLocales((prev) => {
                const connues = new Set(prev.map((c) => c.id));
                const fraiches = res.data.categories.filter(
                  (c) => !connues.has(c.id),
                );
                return fraiches.length > 0 ? [...prev, ...fraiches] : prev;
              });
            }
            return res;
          }
        : undefined,
    [importerCategoriesStandard],
  );

  // Recharge le RÉFÉRENTIEL de catégories depuis le serveur (source de vérité)
  // après une mutation du gestionnaire (renommage/archivage/création). Remplace
  // l'état local par la liste fraîche (les archivées disparaissent, les renommées
  // s'actualisent) → les pickers reflètent immédiatement l'état réel.
  const rechargerReferentiel = useCallback(async () => {
    if (!actionsReferentiel) return;
    const fraiches = await actionsReferentiel.listerCategories();
    setCategoriesLocales(fraiches);
  }, [actionsReferentiel]);

  /** (Re)charge la PREMIÈRE page pour un jeu de filtres donné (reset curseur). */
  const rechargerPremierePage = useCallback(
    async (f: FiltresTransactions) => {
      setChargementEnCours("page");
      setErreur(false);
      setErreurPagination(false);

      // Liste ET total demandés EN PARALLÈLE sur le MÊME instantané de filtres `f` :
      // le total affiché correspond donc toujours aux lignes affichées. (Les tirer de
      // deux jeux de filtres différents ferait mentir l'écran — un total qui ne totalise
      // pas ce qu'on voit.) L'agrégat n'est demandé que si un filtre est actif ET si la
      // surface l'expose : `sommeNette` est OPTIONNELLE (la démo ne la fournit pas).
      const demanderSomme = actions.sommeNette;
      const [res, resSomme] = await Promise.all([
        actions.listerTransactions({ curseur: null, filtres: f }),
        // `.catch(() => null)` — le total est un CONFORT : il ne doit JAMAIS pouvoir
        // emporter la liste avec lui. Une Server Action REJETTE (au lieu de renvoyer
        // `{ok:false}`) quand la session expire ou que le serveur tombe : sans ce catch,
        // `Promise.all` rejetterait, la liste ne serait jamais posée ET
        // `setChargementEnCours(null)` jamais appelé → page définitivement figée
        // (toolbar grisée, liste estompée, plus rien ne répond) à cause d'un total.
        demanderSomme && filtreActif(f)
          ? demanderSomme({ filtres: f }).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (res.ok) {
        setLignes(res.data.lignes);
        setCurseur(res.data.curseurSuivant);
      } else {
        setErreur(true);
      }
      // Fail-closed — et surtout : le total n'est posé QUE SI LA LISTE l'est aussi
      // (`res.ok`). Sinon, dans le cas « liste en échec, agrégat OK », les lignes du
      // filtre PRÉCÉDENT restent à l'écran (elles ne sont pas effacées) et on les
      // surmonterait du total du NOUVEAU filtre : un chiffre exact, parfaitement
      // crédible… et rattaché aux mauvaises lignes. C'est le pire résultat possible sur
      // un écran financier — pire qu'une absence de chiffre. Filtres retirés, agrégat en
      // échec OU liste en échec ⇒ AUCUN total.
      setSommeNette(res.ok && resSomme && resSomme.ok ? resSomme.data : null);
      setChargementEnCours(null);
    },
    [actions],
  );

  /** Applique un changement de filtre : recharge depuis la page 1. */
  function appliquerFiltres(f: FiltresTransactions) {
    setFiltres(f);
    void rechargerPremierePage(f);
  }

  /** Charge la page SUIVANTE et l'ajoute à la liste (append). */
  async function chargerPlus() {
    if (!curseur || chargement) return;
    setChargementEnCours("plus");
    setErreurPagination(false);
    const res = await actions.listerTransactions({ curseur, filtres });
    if (res.ok) {
      setLignes((prev) => [...prev, ...res.data.lignes]);
      setCurseur(res.data.curseurSuivant);
    } else {
      setErreurPagination(true);
    }
    setChargementEnCours(null);
  }

  /**
   * Clic sur une ligne : charge ses splits PUIS ouvre la modale. `chargerSplits`
   * (→ listerSplitsAction) LÈVE en cas d'échec plutôt que de renvoyer [] : on NE
   * DOIT PAS ouvrir la modale sur un état faussement vide, sinon un « Valider »
   * écraserait des splits existants (perte de données). En cas d'exception : alerte
   * et abandon de l'ouverture.
   */
  async function ouvrirVentilation(transaction: TransactionListItem) {
    const cle = `${transaction.transactionId}:${transaction.transactionDate}`;
    setOuvertureEnCours(cle);
    setErreurOuverture(false);
    try {
      const splits = await actions.chargerSplits({
        transactionId: transaction.transactionId,
        transactionDate: transaction.transactionDate,
      });
      setModale({ transaction, initialSplits: splits });
    } catch {
      // Échec de chargement → on bloque l'ouverture (anti-écrasement).
      setErreurOuverture(true);
    } finally {
      setOuvertureEnCours(null);
    }
  }

  /** Après un remplacement réussi : recharger la page courante de façon ciblée. */
  function apresSauvegarde() {
    // Rafraîchit le résumé (statut/badge) de la ligne modifiée sans tout recharger
    // visuellement : on relit la 1re page avec les filtres courants.
    void rechargerPremierePage(filtres);
  }

  const aDesResultats = lignes.length > 0;
  const enChargementInitial = chargement && !aDesResultats;

  const corps = useMemo(() => {
    if (enChargementInitial) return <TransactionsLoading />;
    if (erreur && !aDesResultats) {
      return <AppErrorState onRetry={() => void rechargerPremierePage(filtres)} />;
    }
    if (!aDesResultats) {
      // Empty : trois cas distincts.
      // 1) Aucune banque connectée → CTA de connexion.
      if (aucuneBanque) {
        return (
          <EmptyState
            illustration="table"
            title="Connectez une banque pour voir vos opérations"
            message="Dès votre première synchronisation, toutes vos transactions s’afficheront ici, prêtes à être catégorisées."
            cta={{ label: "Connecter une banque", href: "/banques" }}
          />
        );
      }
      // 2) Recherche active sans résultat → message ciblé citant le terme (variante
      //    MESSAGE de l'empty existant, pas un nouvel état). Le terme affiché vient de
      //    l'état des filtres (UI), pas d'un log — aucune fuite PII.
      if (filtres.recherche) {
        return (
          <EmptyState
            illustration="table"
            title="Aucune transaction ne correspond à votre recherche"
            message={`Aucune opération ne contient « ${filtres.recherche} » dans son libellé. Vérifiez l’orthographe ou élargissez les autres filtres.`}
          />
        );
      }
      // 3) Filtre statut sans résultat, période (barre globale) sans opération, ou sync
      //    en cours. La fenêtre de dates vient désormais de la barre de vue (TX-TOOLBAR-
      //    DEDUP1) : une plage étroite sans transaction retombe légitimement ici.
      return (
        <EmptyState
          illustration="table"
          title="Aucune transaction pour ces critères"
          message="Aucune opération ne correspond à la période et aux filtres sélectionnés, ou la première synchronisation est encore en cours."
        />
      );
    }
    return (
      <TransactionsTable transactions={lignes} onOpen={ouvrirVentilation} />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enChargementInitial, erreur, aDesResultats, aucuneBanque, lignes, filtres]);

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar UNIQUE : filtres à gauche, action du référentiel à droite. L'accès au
          gestionnaire de catégories (seul chemin en prod pour renommer/archiver,
          FB0709-CAT-RENOMMER1) y est passé en closure — et SEULEMENT si l'utilisateur
          est ADMIN (`actionsReferentiel` n'est fourni qu'à lui par la page, règle D2).
          Non-admin ⇒ prop `undefined` ⇒ bouton ABSENT du DOM, pas grisé. */}
      <TransactionsToolbar
        filtres={filtres}
        onChange={appliquerFiltres}
        disabled={chargement}
        onOuvrirGestionCategories={
          actionsReferentiel ? () => setManagerOuvert(true) : undefined
        }
      />

      {/* TOTAL des résultats filtrés (TX-RECHERCHE-SOMME-NETTE1) — agrégat SERVEUR, monté
          seulement sous filtre. Estompé pendant un re-fetch, EXACTEMENT comme la liste
          ci-dessous : le total et les lignes sont issus du même instantané de filtres, ils
          doivent donc vieillir ENSEMBLE (un total net qui resterait vif au-dessus d'une
          liste estompée laisserait croire qu'il est déjà à jour). On garde la valeur
          précédente pendant le re-fetch au lieu de la vider : sinon le bandeau se
          démonterait/remonterait à chaque frappe et ferait sauter le tableau
          (TX-RECHERCHE-LAYOUTSHIFT1). Le wrapper n'est monté QUE s'il y a une devise à
          afficher : un `totaux` VIDE (recherche sans résultat) rendrait un <div> de
          hauteur nulle qui consommerait quand même un `gap-4` — 16 px de décalage
          fantôme au moment où la recherche cesse de matcher. */}
      {sommeNette && sommeNette.length > 0 && (
        <div
          className={cn(
            "transition-opacity",
            rafraichissement && "pointer-events-none opacity-60",
          )}
        >
          <TransactionsSommeNette totaux={sommeNette} />
        </div>
      )}

      {/* Zone de résultats à hauteur PLANCHER (~8 lignes = gabarit du skeleton
          TransactionsLoading) : skeleton / table / petite liste / empty partagent
          ce plancher, donc la zone ne se « collapse » plus au fil de la recherche
          → fin des sauts de layout (TX-RECHERCHE-LAYOUTSHIFT1). Pendant un RE-fetch
          de la 1re page AVEC des résultats déjà affichés (recherche/filtre/après-
          sauvegarde), on GARDE la liste montée et on l'estompe (« en cours » :
          opacité réduite + aria-busy + non-cliquable) au lieu de la laisser figée
          sans retour — même idiome que GraphiquesFeature. La pagination « Charger plus »
          (append) N'estompe PAS : `rafraichissement` ne vaut que pour le refetch
          page 1. `enChargementInitial` garde le skeleton réservé au cas SANS lignes
          → jamais de clignotement vers le skeleton quand on avait déjà des lignes. */}
      <div
        aria-busy={rafraichissement && aDesResultats}
        className={cn(
          "min-h-[512px] transition-opacity",
          rafraichissement &&
            aDesResultats &&
            "pointer-events-none opacity-60",
        )}
      >
        {corps}
      </div>

      {/* Pagination « Charger plus » — masquée si dernière page ou liste vide. */}
      {aDesResultats && curseur && (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => void chargerPlus()}
            disabled={chargement}
            className="inline-flex h-10 cursor-pointer items-center rounded-control border border-line
              bg-surface-inset px-4 text-sm font-medium text-text transition-colors
              hover:bg-surface-card disabled:cursor-not-allowed disabled:opacity-[0.48] focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {chargement ? "Chargement…" : "Charger plus"}
          </button>
          {erreurPagination && (
            <p className="text-xs text-danger" role="alert">
              Impossible de charger la suite. Réessayez.
            </p>
          )}
        </div>
      )}

      {/* Indicateur discret d'ouverture (chargement des splits). */}
      {ouvertureEnCours && (
        <p className="sr-only" role="status">
          Ouverture de la ventilation…
        </p>
      )}

      {/* Échec de chargement des splits → la modale ne s'est PAS ouverte. Erreur
          système (§3.4) : fond danger-bg + icône + message, jamais un simple rouge. */}
      {erreurOuverture && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-card bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="mt-0.5 h-5 w-5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="13" />
            <line x1="12" y1="16" x2="12" y2="16" />
          </svg>
          <span className="flex-1">
            Erreur de chargement de la ventilation. La transaction n’a pas été
            ouverte — réessayez dans un instant.
          </span>
          <button
            type="button"
            onClick={() => setErreurOuverture(false)}
            className="shrink-0 cursor-pointer font-medium underline underline-offset-2
              focus:outline-none focus-visible:ring-2 focus-visible:ring-danger"
          >
            Fermer
          </button>
        </div>
      )}

      {/* Modale de ventilation — montée quand une transaction est sélectionnée. */}
      {modale && (
        <SplitAllocationModal
          open
          onClose={() => setModale(null)}
          transaction={{
            transactionId: modale.transaction.transactionId,
            transactionDate: modale.transaction.transactionDate,
            label: modale.transaction.label,
            // cleanLabel NON-PII → seul motif autorisé pour le deep-link « Créer une
            // règle » (jamais bankLabelRaw). Null ⇒ pas de lien côté modale.
            cleanLabel: modale.transaction.cleanLabel,
            montantAbs: modale.transaction.montantAbs,
            devise: modale.transaction.devise,
            sens: modale.transaction.sens,
          }}
          categories={categoriesLocales}
          initialSplits={modale.initialSplits}
          onReplace={(splits) =>
            remplacerSplits(
              {
                transactionId: modale.transaction.transactionId,
                transactionDate: modale.transaction.transactionDate,
              },
              splits,
            )
          }
          onSaved={apresSauvegarde}
          onCreateCategorie={creerCategorieEtRafraichir}
          onImportStandard={importerStandardEtRafraichir}
        />
      )}

      {/* Gestionnaire de catégories (ADMIN seul) : créer / renommer / archiver.
          Monté uniquement si les actions du référentiel sont fournies. Au succès
          d'une mutation (`onChanged`), on recharge le référentiel depuis le serveur
          → les pickers reflètent l'état réel (renommage/archivage inclus). */}
      {actionsReferentiel && (
        <CategoryManagerModal
          open={managerOuvert}
          onClose={() => setManagerOuvert(false)}
          categories={categoriesLocales}
          actions={actionsReferentiel}
          onChanged={() => void rechargerReferentiel()}
        />
      )}
    </div>
  );
}
