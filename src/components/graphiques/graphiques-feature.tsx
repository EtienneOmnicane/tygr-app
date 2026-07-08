"use client";

/**
 * Conteneur CLIENT de la section « Analyse par catégorie » (camembert). Orchestre
 * les deux sélecteurs — SENS (sorties / entrées) et PÉRIODE (preset) — et recharge
 * la répartition via la Server Action INJECTÉE (`ActionsGraphiques.analyser`) à
 * chaque changement. Il ne touche JAMAIS la DB et ne connaît pas le workspace
 * (scopé serveur, comme `EcheancesFeature`).
 *
 * Le client n'envoie qu'un PRESET de période (jamais des dates) : les bornes [from,
 * to] sont dérivées à Maurice côté serveur (E20). Multi-devise (règle 8) : une carte
 * par devise, jamais d'addition cross-devise — le rendu délègue à
 * `RepartitionDeviseCard`.
 *
 * États (convention §6.5) :
 *   - vide     → EmptyState (illustration graphique). CTA « Connecter une banque »
 *                UNIQUEMENT si aucun compte n'est connecté (sinon : pas de donnée sur
 *                la période, pas de CTA creux — décision design D2).
 *   - données  → une carte par devise (donut + légende).
 *   - erreur   → bandeau `role=alert` (fond danger §3.4), mappé depuis le code S2.
 *   - en cours → sélecteurs désactivés + cartes estompées (aria-busy), données
 *                précédentes conservées (pas de saut de layout au re-fetch).
 */
import { useCallback, useState } from "react";

import type { PeriodePresetParam } from "@/lib/insights-schema";
import { LIBELLE_PERIODE, PERIODES } from "@/lib/periode-analyse";
import type { RepartitionCategories, SensFlux } from "@/server/insights/types";

import { EmptyState } from "@/components/ui/states";

import { RepartitionDeviseCard } from "./repartition-devise-card";
import type { ActionsGraphiques, SelectionGraphique } from "./types-graphiques";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Message d'erreur mappé depuis un code machine serveur (registre S2 / actions.ts). */
function messagePourCode(code: string, fallback: string): string {
  switch (code) {
    case "INVALID_PARAMS":
      return "Sélection invalide. Réessayez.";
    case "SERVICE_UNAVAILABLE":
      return "Service momentanément indisponible. Réessayez.";
    default:
      return fallback;
  }
}

/** Sens d'analyse (défaut métier = SORTIES, cas d'usage FYGR « category analysis »). */
const SENS_OPTIONS: Array<{ valeur: SensFlux; label: string }> = [
  { valeur: "outflow", label: "Sorties" },
  { valeur: "inflow", label: "Entrées" },
];

/**
 * Contrôle segmenté générique (radiogroup, motif §2 / periode-switcher). Segment
 * actif = `bg-primary text-text-onink`. Désactivé en bloc pendant un re-fetch.
 */
function ControleSegmente<T extends string>({
  label,
  options,
  valeur,
  onChange,
  disabled,
}: {
  label: string;
  options: Array<{ valeur: T; label: string }>;
  valeur: T;
  onChange: (valeur: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-fit rounded-full border border-line bg-surface-card p-0.5"
    >
      {options.map((o) => {
        const actif = o.valeur === valeur;
        return (
          <button
            key={o.valeur}
            type="button"
            role="radio"
            aria-checked={actif}
            disabled={disabled}
            onClick={() => onChange(o.valeur)}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              "disabled:cursor-not-allowed disabled:opacity-60",
              actif ? "bg-primary text-text-onink" : "text-text-muted hover:text-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function GraphiquesFeature({
  initiale,
  selectionInitiale,
  aucuneBanque,
  actions,
}: {
  /** Répartition du premier paint (chargée en RSC, défauts sorties/mois-courant). */
  initiale: RepartitionCategories;
  /** Sélection correspondant au premier paint (pour aligner les sélecteurs). */
  selectionInitiale: SelectionGraphique;
  /** Aucun compte connecté → CTA « Connecter une banque » sur l'état vide (D2). */
  aucuneBanque: boolean;
  actions: ActionsGraphiques;
}) {
  const [selection, setSelection] = useState<SelectionGraphique>(selectionInitiale);
  const [data, setData] = useState<RepartitionCategories>(initiale);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);

  const appliquer = useCallback(
    async (nouvelle: SelectionGraphique) => {
      setErreur(null);
      setSelection(nouvelle);
      setChargement(true);
      try {
        const res = await actions.analyser(nouvelle);
        if (!res.ok) {
          setErreur(messagePourCode(res.code, res.message));
          return;
        }
        setData(res.data);
      } catch {
        setErreur("Le chargement a échoué. Réessayez.");
      } finally {
        setChargement(false);
      }
    },
    [actions],
  );

  const changerSens = useCallback(
    (sens: SensFlux) => {
      if (sens !== selection.sens) void appliquer({ ...selection, sens });
    },
    [appliquer, selection],
  );

  const changerPeriode = useCallback(
    (periode: PeriodePresetParam) => {
      if (periode !== selection.periode) void appliquer({ ...selection, periode });
    },
    [appliquer, selection],
  );

  const aucuneDonnee = data.devises.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Sélecteurs (sens + période). Wrap autorisé : contenu de page, pas un header. */}
      <div className="flex flex-wrap items-center gap-3">
        <ControleSegmente
          label="Sens des flux analysés"
          options={SENS_OPTIONS}
          valeur={selection.sens}
          onChange={changerSens}
          disabled={chargement}
        />
        <ControleSegmente
          label="Période d’analyse"
          options={PERIODES.map((p) => ({ valeur: p, label: LIBELLE_PERIODE[p] }))}
          valeur={selection.periode}
          onChange={changerPeriode}
          disabled={chargement}
        />
      </div>

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

      {/* Contenu : état vide OU une carte par devise (estompée pendant un re-fetch). */}
      {aucuneDonnee ? (
        <EmptyState
          illustration="chart"
          title={
            aucuneBanque
              ? "Connectez une banque pour visualiser vos catégories"
              : "Aucun mouvement sur cette période"
          }
          message={
            aucuneBanque
              ? "Dès qu’un compte sera synchronisé, cette section répartira vos entrées et sorties par catégorie."
              : "Aucune opération ne correspond au sens et à la période choisis. Essayez une autre période."
          }
          cta={
            aucuneBanque
              ? { label: "Connecter une banque", href: "/banques" }
              : undefined
          }
        />
      ) : (
        <div
          aria-busy={chargement}
          className={cn(
            "flex flex-col gap-4 transition-opacity",
            chargement && "pointer-events-none opacity-60",
          )}
        >
          {data.devises.map((devise) => (
            <RepartitionDeviseCard key={devise.currency} devise={devise} />
          ))}
        </div>
      )}
    </div>
  );
}
