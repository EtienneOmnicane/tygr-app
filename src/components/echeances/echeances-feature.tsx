"use client";

/**
 * Conteneur CLIENT de la page « Échéances » (cadrage §3). Orchestre la synthèse, le
 * formulaire (création / édition), la liste DIRIGÉE (une direction à la fois) et les
 * transitions de statut / suppression, en s'appuyant sur les Server Actions injectées
 * (`ActionsEcheances`). Il ne touche JAMAIS la DB et ne connaît pas le workspace
 * (scopé serveur). Recharge la vue (liste + synthèse) après chaque mutation réussie.
 *
 * Vue DIRIGÉE (§3.1.2) : un sélecteur « À encaisser » / « À décaisser » choisit la
 * direction affichée ; la liste ne mélange jamais les deux sens. La synthèse, elle,
 * reste globale (les deux directions par horizon/devise) car elle EST la vue nette.
 *
 * États (convention §6.5) :
 *   - vide      → EmptyState « aucune échéance » (illustration calendrier) + invite.
 *   - liste     → synthèse + formulaire (si gestionnaire) + liste dirigée.
 *   - erreur    → bandeau `role=alert` (fond danger §3.4) mappé depuis le code S2.
 *   - en cours  → contrôles désactivés + libellés « … » (création/édition/statut/suppr).
 *
 * Gating (`peutGerer`) : un VIEWER voit la synthèse + la liste en lecture seule (pas
 * de formulaire, pas de contrôle de statut, pas de suppression). La vraie garde reste
 * serveur (les actions échouent `FORBIDDEN_ROLE` pour un VIEWER).
 */
import { useCallback, useMemo, useState } from "react";

import { DashboardShell } from "@/components/shell/dashboard-shell";
import type { CategorieUI } from "@/components/ui/category";
import { EmptyState } from "@/components/ui/states";

import { EcheanceForm, type EntiteOptionUI } from "./echeance-form";
import { EcheancesList } from "./echeances-list";
import { EcheancesSynthese } from "./echeances-synthese";
import type {
  ActionsEcheances,
  ChangerStatutInputUI,
  CreerEcheanceInputUI,
  DirectionEcheance,
  EcheanceUI,
  EcheancesVueUI,
  ModifierEcheanceInputUI,
  SyntheseEcheancesUI,
} from "./types-echeances";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Message d'erreur mappé depuis un code machine serveur (registre S2 / actions.ts). */
function messagePourCode(code: string, fallback: string): string {
  switch (code) {
    case "INVALID_PARAMS":
      return "Vérifiez les champs saisis (montant, date, libellé).";
    case "ECHEANCE_NOT_FOUND":
      return "Échéance introuvable (peut-être déjà supprimée).";
    case "FORBIDDEN_ROLE":
      return "Cette action est réservée aux gestionnaires.";
    case "REFERENCE_NOT_FOUND":
      return "Entité ou catégorie introuvable dans cet espace.";
    case "ENTITY_OUT_OF_SCOPE":
      return "Cette échéance est hors de votre périmètre d’entités.";
    case "SETTLED_AMOUNT_INVALID":
      return "Le montant réglé doit être compris entre 0 et le montant total.";
    case "SERVICE_UNAVAILABLE":
      return "Service momentanément indisponible. Réessayez.";
    default:
      return fallback;
  }
}

const VUES: Array<{ valeur: DirectionEcheance; label: string }> = [
  { valeur: "encaissement", label: "À encaisser" },
  { valeur: "decaissement", label: "À décaisser" },
];

export function EcheancesFeature({
  initiales,
  categories,
  entites = [],
  actions,
  peutGerer = true,
}: {
  /** Vue initiale (chargée en RSC) : liste triée + synthèse par horizon. */
  initiales: EcheancesVueUI;
  /** Référentiel de catégories (select du formulaire + résolution des noms). */
  categories: CategorieUI[];
  /** Entités assignables (opt, sas ADMIN) — vide → champ entité masqué. */
  entites?: EntiteOptionUI[];
  actions: ActionsEcheances;
  /** false = VIEWER (lecture seule : pas de formulaire, statut ni suppression). */
  peutGerer?: boolean;
}) {
  const [echeances, setEcheances] = useState<EcheanceUI[]>(initiales.echeances);
  const [synthese, setSynthese] = useState<SyntheseEcheancesUI>(initiales.synthese);
  const [vue, setVue] = useState<DirectionEcheance>("encaissement");
  const [erreur, setErreur] = useState<string | null>(null);
  const [creationEnCours, setCreationEnCours] = useState(false);
  const [editionEnCours, setEditionEnCours] = useState(false);
  const [suppressionEnCours, setSuppressionEnCours] = useState<string | null>(null);
  const [statutEnCours, setStatutEnCours] = useState<string | null>(null);
  /** Échéance en cours d'édition (null = formulaire en mode création). */
  const [echeanceEnEdition, setEcheanceEnEdition] = useState<EcheanceUI | null>(null);
  /**
   * Génération du formulaire de CRÉATION : incrémentée à chaque création réussie pour
   * REMONTER le formulaire (via `key`) et le vider — sans ça, les champs gardent la
   * saisie précédente et un second clic recréerait la même échéance (FINDING-103).
   * Même mécanique que l'édition : remount par `key`, jamais de synchro d'effet.
   */
  const [generationCreation, setGenerationCreation] = useState(0);

  // id catégorie → nom lisible, pour l'affichage de la liste.
  const nomParCategorie = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  // Sous-ensemble DIRIGÉ : la liste ne montre qu'une direction à la fois. L'ordre
  // (exigibilité croissante, retards en tête) est DÉJÀ posé par le serveur — on filtre
  // seulement, on ne re-trie pas.
  const echeancesVue = useMemo(
    () => echeances.filter((e) => e.direction === vue),
    [echeances, vue],
  );

  const recharger = useCallback(async () => {
    const fraiche = await actions.listerEcheances();
    setEcheances(fraiche.echeances);
    setSynthese(fraiche.synthese);
  }, [actions]);

  const creer = useCallback(
    async (input: CreerEcheanceInputUI) => {
      setErreur(null);
      setCreationEnCours(true);
      try {
        const res = await actions.creerEcheance(input);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        setGenerationCreation((g) => g + 1); // succès → formulaire vidé (remount)
        await recharger();
      } catch {
        setErreur("La création a échoué. Réessayez.");
      } finally {
        setCreationEnCours(false);
      }
    },
    [actions, recharger],
  );

  const demarrerEdition = useCallback((echeance: EcheanceUI) => {
    setErreur(null);
    setEcheanceEnEdition(echeance);
  }, []);

  const annulerEdition = useCallback(() => {
    setEcheanceEnEdition(null);
  }, []);

  const modifier = useCallback(
    async (input: ModifierEcheanceInputUI) => {
      setErreur(null);
      setEditionEnCours(true);
      try {
        const res = await actions.modifierEcheance(input);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        setEcheanceEnEdition(null);
        await recharger();
      } catch {
        setErreur("La modification a échoué. Réessayez.");
      } finally {
        setEditionEnCours(false);
      }
    },
    [actions, recharger],
  );

  const changerStatut = useCallback(
    async (input: ChangerStatutInputUI) => {
      setErreur(null);
      setStatutEnCours(input.echeanceId);
      try {
        const res = await actions.changerStatut(input);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        await recharger();
      } catch {
        setErreur("Le changement de statut a échoué. Réessayez.");
      } finally {
        setStatutEnCours(null);
      }
    },
    [actions, recharger],
  );

  const supprimer = useCallback(
    async (echeanceId: string) => {
      setErreur(null);
      setSuppressionEnCours(echeanceId);
      try {
        const res = await actions.supprimerEcheance(echeanceId);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        if (echeanceEnEdition?.id === echeanceId) setEcheanceEnEdition(null);
        await recharger();
      } catch {
        setErreur("La suppression a échoué. Réessayez.");
      } finally {
        setSuppressionEnCours(null);
      }
    },
    [actions, recharger, echeanceEnEdition],
  );

  const aucuneEcheance = echeances.length === 0;

  return (
    <DashboardShell
      aside={<EcheancesSynthese synthese={synthese} orientation="vertical" />}
    >
      <div className="flex flex-col gap-4">
        {/* En-tête de page — vit DANS la zone de données du shell (§1.1 : le titre est
            posé sur le fond de page, jamais au-dessus de la coquille asymétrique). */}
        <header>
          <h1 className="text-xl font-semibold text-text">
            Échéances prévisionnelles
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Anticipez vos encaissements et décaissements à venir : suivez leur statut,
            leur montant et leur exigibilité, avec une synthèse par horizon.
          </p>
        </header>

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

        {/* Synthèse prévisionnelle : dans le side-panel §1.1 (aside, ≥lg). Le shell
            masque l'aside sous lg → on la REMONTE inline ici (rangée horizontale via
            orientation "auto") pour ne pas la perdre sur tablette/mobile. */}
        <div className="lg:hidden">
          <EcheancesSynthese synthese={synthese} />
        </div>

        {/* Formulaire (caché en lecture seule) : création OU édition. `key` remonte le
            composant quand l'échéance éditée change → pré-remplissage par init d'état. */}
        {peutGerer &&
        (echeanceEnEdition ? (
          <EcheanceForm
            key={echeanceEnEdition.id}
            mode="edition"
            valeurInitiale={echeanceEnEdition}
            categories={categories}
            entites={entites}
            onCreer={creer}
            onModifier={modifier}
            onAnnuler={annulerEdition}
            enCours={editionEnCours}
          />
        ) : (
          <EcheanceForm
            key={`creation-${generationCreation}`}
            categories={categories}
            entites={entites}
            directionInitiale={vue}
            onCreer={creer}
            enCours={creationEnCours}
          />
        ))}

        {/* Liste dirigée. Le sélecteur de direction EST l'en-tête de la liste :
            groupés dans UNE section (gap serré) pour qu'ils ne « flottent » plus
            entre le formulaire et la liste. Masqué dans l'état vide global — pas
            de direction à filtrer tant qu'aucune échéance n'existe (§3.1.2). */}
        {aucuneEcheance ? (
          <EmptyState
            illustration="calendar"
            title="Aucune échéance pour l’instant"
            message={
              peutGerer
                ? "Ajoutez une échéance client ou fournisseur pour suivre vos encaissements et décaissements à venir."
                : "Aucune échéance n’a encore été enregistrée pour ce workspace."
            }
          />
        ) : (
          <section className="flex flex-col gap-3">
            <div
              role="tablist"
              aria-label="Direction des échéances"
              className="inline-flex w-fit rounded-control border border-line bg-surface-card p-0.5"
            >
              {VUES.map((v) => {
                const actif = v.valeur === vue;
                return (
                  <button
                    key={v.valeur}
                    type="button"
                    role="tab"
                    aria-selected={actif}
                    onClick={() => setVue(v.valeur)}
                    className={cn(
                      "rounded-control px-3.5 py-1.5 text-sm font-medium transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      actif
                        ? "bg-primary text-text-onink"
                        : "text-text-muted hover:text-text",
                    )}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>

            {echeancesVue.length === 0 ? (
              <p className="rounded-control border border-line bg-surface-card px-4 py-6 text-center text-sm text-text-muted">
                {vue === "encaissement"
                  ? "Aucune échéance à encaisser."
                  : "Aucune échéance à décaisser."}
              </p>
            ) : (
              <EcheancesList
                echeances={echeancesVue}
                nomParCategorie={nomParCategorie}
                peutGerer={peutGerer}
                onModifier={demarrerEdition}
                onSupprimer={supprimer}
                suppressionEnCours={suppressionEnCours}
                onChangerStatut={changerStatut}
                statutEnCours={statutEnCours}
                idEnEdition={echeanceEnEdition?.id ?? null}
              />
            )}
          </section>
        )}
      </div>
    </DashboardShell>
  );
}
