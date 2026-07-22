"use client";

/**
 * Conteneur CLIENT de la page « Règles de catégorisation ». Orchestre la liste, la
 * création, la suppression (archivage) et la réactivation en s'appuyant sur les Server Actions
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
  creationInitiale,
}: {
  /** Première page de règles (chargée en RSC), réutilisée puis rafraîchie. */
  initiales: RegleUI[];
  /** Référentiel de catégories (pour le select cible + résolution des noms). */
  categories: CategorieUI[];
  actions: ActionsRegles;
  /** false = VIEWER (lecture seule : pas de création/suppression/ré-analyse). */
  peutGerer?: boolean;
  /**
   * Pré-remplissage du formulaire de CRÉATION (deep-link depuis la catégorisation,
   * FB0709-REGLES-LIEN1) : motif et/ou catégorie proposés à l'arrivée. Déjà validé
   * côté page (motif borné, catégorie appartenant au tenant). Absent = formulaire
   * de création vierge, comportement inchangé.
   */
  creationInitiale?: { pattern?: string; categoryId?: string };
}) {
  const [regles, setRegles] = useState<RegleUI[]>(initiales);
  const [erreur, setErreur] = useState<string | null>(null);
  const [creationEnCours, setCreationEnCours] = useState(false);
  const [suppressionEnCours, setSuppressionEnCours] = useState<string | null>(null);
  const [reactivationEnCours, setReactivationEnCours] = useState<string | null>(null);
  const [reanalyseEnCours, setReanalyseEnCours] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  /** Règle en cours d'édition (null = formulaire en mode création). */
  const [regleEnEdition, setRegleEnEdition] = useState<RegleUI | null>(null);
  const [editionEnCours, setEditionEnCours] = useState(false);
  const [reordreEnCours, setReordreEnCours] = useState(false);

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

  /**
   * Réactive une règle archivée depuis la LISTE (chemin direct, sans passer par le
   * formulaire). Même idiome que `supprimer` ; côté serveur c'est la même action que
   * l'édition (`modifierRegle`), dont la garde de rôle re-résout MANAGER/ADMIN dans
   * la transaction — `peutGerer` n'est qu'une défense en profondeur.
   */
  const reactiver = useCallback(
    async (ruleId: string) => {
      setErreur(null);
      setInfo(null);
      setReactivationEnCours(ruleId);
      try {
        const res = await actions.modifierRegle({ ruleId, isActive: true });
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        await recharger();
        // Anti-illusion : réactiver ne reclasse RIEN rétroactivement — la ré-analyse
        // ne touche que les transactions SANS ventilation (MANUAL prime, jamais
        // écrasé). On ne cite le bouton que s'il est réellement offert.
        setInfo(
          typeof actions.appliquerRegles === "function"
            ? "Règle réactivée. Lancez « Ré-analyser les transactions » pour l’appliquer aux transactions non catégorisées."
            : "Règle réactivée. Elle s’appliquera aux prochaines transactions non catégorisées.",
        );
      } catch {
        setErreur("La réactivation a échoué. Réessayez.");
      } finally {
        setReactivationEnCours(null);
      }
    },
    [actions, recharger],
  );

  const demarrerEdition = useCallback((regle: RegleUI) => {
    setErreur(null);
    setInfo(null);
    setRegleEnEdition(regle);
  }, []);

  const annulerEdition = useCallback(() => {
    setRegleEnEdition(null);
  }, []);

  const modifier = useCallback(
    async (input: {
      ruleId: string;
      pattern?: string;
      matchType?: RuleMatchType;
      categoryId?: string;
      isActive?: boolean;
    }) => {
      setErreur(null);
      setInfo(null);
      setEditionEnCours(true);
      try {
        const res = await actions.modifierRegle(input);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        setRegleEnEdition(null);
        await recharger();
      } catch {
        setErreur("La modification a échoué. Réessayez.");
      } finally {
        setEditionEnCours(false);
      }
    },
    [actions, recharger],
  );

  const reordonner = useCallback(
    async (nouvelOrdreActifs: string[]) => {
      setErreur(null);
      setInfo(null);
      // Optimisme UI : on réordonne localement d'abord (feedback immédiat), puis on
      // confirme au serveur. En cas d'échec, on recharge pour resynchroniser.
      const avant = regles;
      const parId = new Map(regles.map((r) => [r.id, r]));
      const actifsReordonnes = nouvelOrdreActifs
        .map((id) => parId.get(id))
        .filter((r): r is RegleUI => r !== undefined)
        .map((r, i) => ({ ...r, priority: i }));
      const archivees = regles.filter((r) => !r.isActive);
      setRegles([...actifsReordonnes, ...archivees]);
      setReordreEnCours(true);
      try {
        const res = await actions.reordonnerRegles(nouvelOrdreActifs);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          setRegles(avant); // rollback visuel
          await recharger(); // resync avec la vérité serveur
          return;
        }
        await recharger();
      } catch {
        setErreur("Le réordonnancement a échoué. Réessayez.");
        setRegles(avant);
      } finally {
        setReordreEnCours(false);
      }
    },
    [actions, recharger, regles],
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

  // Ordre d'affichage = ordre d'APPLICATION réel. Le serveur renvoie DÉJÀ les règles
  // triées par `asc(priority), asc(createdAt)` (listerRegles) — l'ordre total qui
  // décide quelle règle matche. On ne le RECALCULE pas côté client (RegleUI ne porte
  // pas createdAt → un tri client se tromperait sur les ex æquo de priorité, très
  // fréquents tant que les priorités valent 0). On se contente d'une PARTITION STABLE :
  // actives d'abord (dans l'ordre serveur), archivées ensuite (dans l'ordre serveur).
  // La position visuelle d'une règle active = sa priorité réelle → le réordonnancement
  // par glisser ne ment jamais.
  const activesDabord = useMemo(() => {
    const actives = regles.filter((r) => r.isActive);
    const archivees = regles.filter((r) => !r.isActive);
    return [...actives, ...archivees];
  }, [regles]);

  /** ids des règles ACTIVES dans l'ordre affiché (source pour le réordonnancement). */
  const idsActifsOrdonnes = useMemo(
    () => activesDabord.filter((r) => r.isActive).map((r) => r.id),
    [activesDabord],
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

      {/* Formulaire (caché en lecture seule) : création OU édition d'une règle.
          `key` remonte le composant quand la règle éditée change → pré-remplissage
          par initialisation d'état (pas de synchro d'effet). */}
      {peutGerer &&
        (regleEnEdition ? (
          <RegleForm
            key={regleEnEdition.id}
            mode="edition"
            valeurInitiale={regleEnEdition}
            categories={categories}
            onCreer={creer}
            onModifier={modifier}
            onAnnuler={annulerEdition}
            enCours={editionEnCours}
          />
        ) : (
          <RegleForm
            // `key` intègre le pré-remplissage : si le deep-link change (motif/
            // catégorie), le formulaire se ré-initialise proprement (pas d'effet).
            key={`creation:${creationInitiale?.pattern ?? ""}:${creationInitiale?.categoryId ?? ""}`}
            categories={categories}
            onCreer={creer}
            creationInitiale={creationInitiale}
            enCours={creationEnCours}
          />
        ))}

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
        <div className="flex flex-col gap-2">
          {/* Aide de priorité (FB0709-REGLES-PRIORITE-AIDE1) : explique l'ordre
              d'application (haut → bas, première correspondance gagne — le serveur
              persiste priority = index, cf. reordonnerReglesAction). */}
          <p className="text-[13px] text-text-muted">
            Les règles s’appliquent de haut en bas : pour chaque transaction, la
            première règle dont le motif correspond attribue la catégorie — les
            suivantes sont ignorées.
            {peutGerer &&
              " Glissez une règle (ou utilisez les flèches) pour changer sa priorité."}
          </p>
          <ReglesList
            regles={activesDabord}
            nomParCategorie={nomParCategorie}
            onSupprimer={supprimer}
            suppressionEnCours={suppressionEnCours}
            onReactiver={reactiver}
            reactivationEnCours={reactivationEnCours}
            onModifier={demarrerEdition}
            onReordonner={reordonner}
            idsActifsOrdonnes={idsActifsOrdonnes}
            reordreEnCours={reordreEnCours}
            idEnEdition={regleEnEdition?.id ?? null}
            peutGerer={peutGerer}
          />
        </div>
      )}
    </div>
  );
}
