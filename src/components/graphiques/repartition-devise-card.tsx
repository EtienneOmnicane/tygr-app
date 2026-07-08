"use client";

/**
 * Carte de répartition par catégorie POUR UNE devise (le camembert + sa légende).
 * DÉTENTRICE de l'état de survol partagé : le donut et la légende sont deux vues de
 * la MÊME donnée, le survol de l'un met en avant la part de l'autre. C'est le seul
 * état local de la section graphiques (le reste — sens/période — vit dans la feature).
 *
 * Multi-devise (CLAUDE.md Localisation / règle 8) : UNE carte par devise, jamais
 * d'addition cross-devise. Le total au centre du donut est le total MONO-devise
 * (chaîne SQL). L'en-tête nomme la devise et compte ses opérations.
 *
 * Présentationnel : aucun fetch, aucune Server Action. Compose des briques inertes.
 */
import { useState } from "react";

import { nomDevise } from "@/lib/format-montant";
import type { RepartitionDevise } from "@/server/insights/types";

import { StateCard } from "@/components/ui/states";

import { DonutCategories } from "./donut-categories";
import { LegendeCategories } from "./legende-categories";
import { StatsDevise } from "./stats-devise";

export function RepartitionDeviseCard({ devise }: { devise: RepartitionDevise }) {
  // Survol partagé donut ↔ légende. null = rien de survolé (centre = total).
  const [survol, setSurvol] = useState<number | null>(null);

  const nbOperations =
    devise.nbTransactions === 1
      ? "1 opération"
      : `${devise.nbTransactions} opérations`;

  return (
    <StateCard>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold text-text">
          {nomDevise(devise.currency)}
        </h3>
        <span className="shrink-0 text-xs tabular-nums text-text-faint">
          {nbOperations}
        </span>
      </div>

      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
        {/* Donut : total mono-devise au centre, secteurs annulaires. */}
        <div className="w-full max-w-[220px] shrink-0">
          <DonutCategories
            parts={devise.parts}
            total={devise.total}
            devise={devise.currency}
            survol={survol}
            onSurvol={setSurvol}
          />
        </div>

        {/* Légende : toutes les parts, survol miroir. */}
        <div className="w-full min-w-0 flex-1">
          <LegendeCategories
            parts={devise.parts}
            devise={devise.currency}
            survol={survol}
            onSurvol={setSurvol}
          />
        </div>
      </div>

      {/* Stats d'en-tête (moyenne/op, couverture, poste dominant, concentration). */}
      <div className="mt-6">
        <StatsDevise devise={devise} />
      </div>
    </StateCard>
  );
}
