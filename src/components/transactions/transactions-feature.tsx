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
  SplitAllocationModal,
  type CategorieUI,
  type ResultatAction,
  type SplitUI,
} from "@/components/ui/category";
import { AppErrorState, EmptyState } from "@/components/ui/states";

import { TransactionsTable } from "./transactions-table";
import { TransactionsLoading } from "./states/transactions-loading";
import {
  TransactionsToolbar,
  type CompteFiltre,
} from "./transactions-toolbar";
import type {
  ActionsTransactions,
  CurseurTransactions,
  FiltresTransactions,
  TransactionListItem,
} from "./types-transactions";

/** Modale en cours : la transaction + ses splits déjà chargés. */
interface ModaleEnCours {
  transaction: TransactionListItem;
  initialSplits: SplitUI[];
}

export function TransactionsFeature({
  initial,
  categories,
  comptes,
  actions,
  remplacerSplits,
  /** Y a-t-il au moins une banque connectée ? (oriente l'Empty State.) */
  aucuneBanque,
}: {
  /** Première page (chargée en RSC) + son curseur. */
  initial: { lignes: TransactionListItem[]; curseurSuivant: CurseurTransactions | null };
  /** Référentiel de catégories (pour la modale de ventilation). */
  categories: CategorieUI[];
  /** Comptes connectés (filtre par compte). */
  comptes: CompteFiltre[];
  /** Lecture paginée + chargement des splits (B1/B3bis). */
  actions: ActionsTransactions;
  /** Action atomique de remplacement des splits (remplacerSplitsAction). */
  remplacerSplits: (
    ref: { transactionId: string; transactionDate: string },
    splits: Array<{ categoryId: string; amount: string }>,
  ) => Promise<ResultatAction>;
  aucuneBanque: boolean;
}) {
  const [lignes, setLignes] = useState<TransactionListItem[]>(initial.lignes);
  const [curseur, setCurseur] = useState<CurseurTransactions | null>(
    initial.curseurSuivant,
  );
  const [filtres, setFiltres] = useState<FiltresTransactions>({});
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState(false);
  /** Erreur de pagination (page suivante) — n'efface pas ce qui est affiché. */
  const [erreurPagination, setErreurPagination] = useState(false);

  const [modale, setModale] = useState<ModaleEnCours | null>(null);
  const [ouvertureEnCours, setOuvertureEnCours] = useState<string | null>(null);
  /** Échec de chargement des splits à l'ouverture → on N'OUVRE PAS la modale. */
  const [erreurOuverture, setErreurOuverture] = useState(false);

  /** (Re)charge la PREMIÈRE page pour un jeu de filtres donné (reset curseur). */
  const rechargerPremierePage = useCallback(
    async (f: FiltresTransactions) => {
      setChargement(true);
      setErreur(false);
      setErreurPagination(false);
      const res = await actions.listerTransactions({ curseur: null, filtres: f });
      if (res.ok) {
        setLignes(res.data.lignes);
        setCurseur(res.data.curseurSuivant);
      } else {
        setErreur(true);
      }
      setChargement(false);
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
    setChargement(true);
    setErreurPagination(false);
    const res = await actions.listerTransactions({ curseur, filtres });
    if (res.ok) {
      setLignes((prev) => [...prev, ...res.data.lignes]);
      setCurseur(res.data.curseurSuivant);
    } else {
      setErreurPagination(true);
    }
    setChargement(false);
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
      // Empty : distingue « aucune transaction » de « aucune banque connectée ».
      return aucuneBanque ? (
        <EmptyState
          illustration="table"
          title="Connectez une banque pour voir vos opérations"
          message="Dès votre première synchronisation, toutes vos transactions s’afficheront ici, prêtes à être catégorisées."
          cta={{ label: "Connecter une banque", href: "/banques" }}
        />
      ) : (
        <EmptyState
          illustration="table"
          title="Aucune transaction pour ces critères"
          message="Aucune opération ne correspond aux filtres sélectionnés, ou la première synchronisation est encore en cours."
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
      <TransactionsToolbar
        filtres={filtres}
        comptes={comptes}
        onChange={appliquerFiltres}
        disabled={chargement}
      />

      {corps}

      {/* Pagination « Charger plus » — masquée si dernière page ou liste vide. */}
      {aDesResultats && curseur && (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => void chargerPlus()}
            disabled={chargement}
            className="inline-flex h-10 items-center rounded-control border border-line
              bg-surface-inset px-4 text-sm font-medium text-text transition-colors
              hover:bg-surface-card disabled:opacity-[0.48] focus:outline-none
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
            className="shrink-0 font-medium underline underline-offset-2
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
            montantAbs: modale.transaction.montantAbs,
            devise: modale.transaction.devise,
            sens: modale.transaction.sens,
          }}
          categories={categories}
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
        />
      )}
    </div>
  );
}
