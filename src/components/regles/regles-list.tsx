"use client";

/**
 * Liste des règles de catégorisation. Présentationnel pur : reçoit les règles +
 * un dictionnaire id→nom de catégorie (résolu par le conteneur) + un handler de
 * suppression. Rend chaque règle en phrase lisible :
 *   « Si le libellé CONTIENT “EDF” → Énergie »
 *
 * Une règle archivée (isActive=false) reste affichée en sourdine avec un badge —
 * « supprimer » côté UI archive côté serveur (jamais de delete dur). Aucune
 * couleur en dur ; badge actif/inactif via tokens neutres (pas de vert/rouge qui
 * sont réservés à la DONNÉE, §3.1).
 */
import { CategoryBadge } from "@/components/ui/category";

import type { RegleUI, RuleMatchType } from "./types-regles";

function libelleMatch(matchType: RuleMatchType): string {
  return matchType === "starts_with" ? "commence par" : "contient";
}

export function ReglesList({
  regles,
  nomParCategorie,
  onSupprimer,
  suppressionEnCours,
  peutGerer = true,
}: {
  regles: RegleUI[];
  /** id catégorie → nom lisible (le conteneur le construit depuis listerCategories). */
  nomParCategorie: Map<string, string>;
  /** Archive la règle (« supprimer »). Le conteneur appelle l'action. */
  onSupprimer: (ruleId: string) => void;
  /** id de la règle en cours de suppression (désactive son bouton), si une. */
  suppressionEnCours?: string | null;
  /** false = lecture seule (VIEWER) : pas de bouton supprimer. */
  peutGerer?: boolean;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-surface-card">
      {regles.map((regle) => {
        const nomCat = nomParCategorie.get(regle.categoryId) ?? "Catégorie inconnue";
        const enCours = suppressionEnCours === regle.id;
        return (
          <li
            key={regle.id}
            className="flex items-center gap-3 px-4 py-3"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="text-text-muted">Si le libellé</span>
              <span className="font-medium text-text">{libelleMatch(regle.matchType)}</span>
              <span className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[13px] text-text">
                {regle.pattern}
              </span>
              <span aria-hidden className="text-text-faint">
                →
              </span>
              <CategoryBadge name={nomCat} colorKey={regle.categoryId} size="sm" />
              {!regle.isActive && (
                <span className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] font-medium text-text-muted">
                  archivée
                </span>
              )}
            </div>

            {peutGerer && regle.isActive && (
              <button
                type="button"
                onClick={() => onSupprimer(regle.id)}
                disabled={enCours}
                className="shrink-0 rounded-control px-2.5 py-1.5 text-xs font-medium text-text-muted
                  transition-colors hover:bg-danger-bg hover:text-danger
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                  disabled:opacity-[0.48]"
              >
                {enCours ? "Suppression…" : "Supprimer"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
