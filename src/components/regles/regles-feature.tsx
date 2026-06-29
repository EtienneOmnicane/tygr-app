"use client";

/**
 * Conteneur CLIENT de la page « Règles de catégorisation ». Orchestre la liste, la
 * création et la suppression (archivage) en s'appuyant sur les Server Actions
 * injectées (`ActionsRegles`) — il ne touche JAMAIS la DB ni ne connaît le
 * workspace (scopé serveur). Recharge la liste après chaque mutation réussie.
 *
 * États (convention §6.5) :
 *   - vide       → EmptyState « aucune règle » + invite à en créer une.
 *   - liste      → RegleForm (création) au-dessus + ReglesList en dessous.
 *   - erreur     → bandeau `role=alert` (fond danger, §3.4) mappé depuis le code S2.
 *   - en cours   → boutons désactivés + libellés « … ».
 *
 * Gating (`peutGerer`) : un VIEWER voit la liste en lecture seule (pas de form, pas
 * de suppression). Le bouton « Ré-analyser » n'apparaît que si `actions.appliquerRegles`
 * est fourni ET `peutGerer` (l'action serveur exige MANAGER/ADMIN — défense en
 * profondeur : la vraie garde reste serveur).
 */
import { useCallback, useMemo, useState } from "react";

import type { CategorieUI } from "@/components/ui/category";
import { EmptyState } from "@/components/ui/states";

import type { ActionsRegles, RegleUI, RuleMatchType } from "./types-regles";
import { RegleForm } from "./regle-form";
import { ReglesList } from "./regles-list";

/** Message d'erreur mappé depuis un code machine serveur (registre S2). */
function messagePourCode(code: string, fallback: string): string {
  switch (code) {
    case "INVALID_PARAMS":
      return "Vérifiez le motif et la catégorie choisie.";
    case "CATEGORY_NOT_FOUND":
      return "La catégorie cible est introuvable.";
    case "RULE_NOT_FOUND":
      return "Règle introuvable (peut-être déjà supprimée).";
    case "FORBIDDEN_ROLE":
      return "Cette action est réservée aux gestionnaires.";
    case "SERVICE_UNAVAILABLE":
      return "Service momentanément indisponible. Réessayez.";
    default:
      return fallback;
  }
}

export function ReglesFeature({
  initiales,
  categories,
  actions,
  peutGerer = true,
}: {
  /** Première page de règles (chargée en RSC), réutilisée puis rafraîchie. */
  initiales: RegleUI[];
  /** Référentiel de catégories (pour le select cible + résolution des noms). */
  categories: CategorieUI[];
  actions: ActionsRegles;
  /** false = VIEWER (lecture seule : pas de création/suppression/ré-analyse). */
  peutGerer?: boolean;
}) {
  const [regles, setRegles] = useState<RegleUI[]>(initiales);
  const [erreur, setErreur] = useState<string | null>(null);
  const [creationEnCours, setCreationEnCours] = useState(false);
  // Incrémenté après une création RÉUSSIE → signale à RegleForm de se vider.
  const [cleResetForm, setCleResetForm] = useState(0);
  const [suppressionEnCours, setSuppressionEnCours] = useState<string | null>(null);
  const [reanalyseEnCours, setReanalyseEnCours] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // id catégorie → nom lisible, pour l'affichage de la liste.
  const nomParCategorie = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  const recharger = useCallback(async () => {
    const fraiches = await actions.listerRegles();
    setRegles(fraiches);
  }, [actions]);

  const creer = useCallback(
    async (input: {
      pattern: string;
      matchType: RuleMatchType;
      categoryId: string;
    }) => {
      setErreur(null);
      setInfo(null);
      setCreationEnCours(true);
      try {
        const res = await actions.creerRegle(input);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        await recharger();
        // Succès : on vide le formulaire (signal via le compteur de reset).
        setCleResetForm((n) => n + 1);
      } catch {
        setErreur("La création a échoué. Réessayez.");
      } finally {
        setCreationEnCours(false);
      }
    },
    [actions, recharger],
  );

  const supprimer = useCallback(
    async (ruleId: string) => {
      setErreur(null);
      setInfo(null);
      setSuppressionEnCours(ruleId);
      try {
        const res = await actions.archiverRegle(ruleId);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        await recharger();
      } catch {
        setErreur("La suppression a échoué. Réessayez.");
      } finally {
        setSuppressionEnCours(null);
      }
    },
    [actions, recharger],
  );

  const reanalyser = useCallback(async () => {
    if (!actions.appliquerRegles) return;
    setErreur(null);
    setInfo(null);
    setReanalyseEnCours(true);
    try {
      const res = await actions.appliquerRegles();
      if (!res.ok) {
        setErreur(messagePourCode(res.code, res.message));
        return;
      }
      setInfo(
        `${res.data.appliquees} transaction(s) catégorisée(s) par les règles.`,
      );
      await recharger();
    } catch {
      setErreur("La ré-analyse a échoué. Réessayez.");
    } finally {
      setReanalyseEnCours(false);
    }
  }, [actions, recharger]);

  const activesDabord = useMemo(
    () =>
      [...regles].sort((a, b) => {
        // Actives en tête, puis priorité décroissante, puis motif (stable).
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.pattern.localeCompare(b.pattern, "fr");
      }),
    [regles],
  );

  const aucuneRegle = regles.length === 0;
  const offreReanalyse = peutGerer && typeof actions.appliquerRegles === "function";

  return (
    <div className="flex flex-col gap-4">
      {/* Bandeau d'erreur (§3.4 : fond danger + role alert, jamais un simple rouge). */}
      {erreur && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-control bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          <span aria-hidden>⚠</span>
          <span>{erreur}</span>
        </div>
      )}

      {/* Confirmation neutre d'une ré-analyse. */}
      {info && (
        <div
          role="status"
          className="rounded-control bg-surface-inset px-4 py-3 text-sm text-text-muted"
        >
          {info}
        </div>
      )}

      {/* Action de ré-analyse (MANAGER/ADMIN) — au-dessus, action globale. */}
      {offreReanalyse && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={reanalyser}
            disabled={reanalyseEnCours}
            className="rounded-control border border-line px-3 py-2 text-sm font-medium text-text
              transition-colors hover:bg-surface-inset focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-[0.48]"
          >
            {reanalyseEnCours ? "Ré-analyse…" : "Ré-analyser les transactions"}
          </button>
        </div>
      )}

      {/* Création (cachée en lecture seule). */}
      {peutGerer && (
        <RegleForm
          categories={categories}
          onCreer={creer}
          enCours={creationEnCours}
          cleReset={cleResetForm}
        />
      )}

      {/* Liste ou état vide. */}
      {aucuneRegle ? (
        <EmptyState
          title="Aucune règle pour l’instant"
          message={
            peutGerer
              ? "Créez une règle pour catégoriser automatiquement les transactions dont le libellé correspond à un motif."
              : "Aucune règle de catégorisation n’a encore été définie pour ce workspace."
          }
          illustration="empty"
        />
      ) : (
        <ReglesList
          regles={activesDabord}
          nomParCategorie={nomParCategorie}
          onSupprimer={supprimer}
          suppressionEnCours={suppressionEnCours}
          peutGerer={peutGerer}
        />
      )}
    </div>
  );
}
