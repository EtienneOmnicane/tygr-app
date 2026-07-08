/**
 * Types UI de la section GRAPHIQUES (analyse par catégorie). On RÉUTILISE les DTO du
 * domaine (`@/server/insights/types` — types purs, erasés au build, importables côté
 * client) et on n'ajoute ICI que les types propres à l'orchestration UI : la sélection
 * (sens + preset) et la Server Action INJECTÉE (le conteneur ne connaît ni la DB ni le
 * workspace — scopé serveur, comme `types-echeances.ts`).
 */
import type { PeriodePresetParam } from "@/lib/insights-schema";
import type { RepartitionCategories, SensFlux } from "@/server/insights/types";

/** Sélection courante des sélecteurs (sens + preset de période). */
export interface SelectionGraphique {
  sens: SensFlux;
  periode: PeriodePresetParam;
}

/** Résultat normalisé du re-fetch client (jamais d'exception au navigateur). */
export type ResultatAnalyse =
  | { ok: true; data: RepartitionCategories }
  | { ok: false; code: string; message: string };

/** Server Action injectée : recalcule la répartition pour une sélection. */
export interface ActionsGraphiques {
  analyser: (selection: SelectionGraphique) => Promise<ResultatAnalyse>;
}
