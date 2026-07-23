"use client";

/**
 * Bascule GRAPHIQUE ↔ TABLEAU d'une carte de flux (item 5 du brief FYGR). Deux
 * représentations d'une MÊME série (invariant : le tableau reçoit exactement la même
 * donnée que le graphe) — l'une donne la FORME, l'autre les VALEURS exactes.
 *
 * S'appuie sur `ControleSegmente` (source unique du motif segmenté) : icône + libellé
 * TEXTE (jamais d'icône seule — a11y). Présentationnel PUR : `onChange` piloté par le
 * conteneur. Aucune couleur en dur (tokens via ControleSegmente).
 */
import { ControleSegmente } from "@/components/ui/controle-segmente";

export type VueFlux = "graphique" | "tableau";

/** Icône « barres » (vue graphique). Trait `currentColor` — hérite la couleur du segment. */
function IconeBarres() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <rect x="2" y="7" width="3" height="7" rx="0.5" />
      <rect x="6.5" y="3" width="3" height="11" rx="0.5" />
      <rect x="11" y="9" width="3" height="5" rx="0.5" />
    </svg>
  );
}

/** Icône « tableau » (vue tableau). */
function IconeTableau() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden
    >
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <line x1="2" y1="6.5" x2="14" y2="6.5" />
      <line x1="7" y1="6.5" x2="7" y2="13" />
    </svg>
  );
}

export function ToggleVue({
  vue,
  onChange,
  disabled,
}: {
  vue: VueFlux;
  onChange: (vue: VueFlux) => void;
  disabled?: boolean;
}) {
  return (
    <ControleSegmente<VueFlux>
      label="Représentation des flux"
      size="sm"
      valeur={vue}
      onChange={onChange}
      disabled={disabled}
      options={[
        { valeur: "graphique", label: "Graphique", icone: <IconeBarres /> },
        { valeur: "tableau", label: "Tableau", icone: <IconeTableau /> },
      ]}
    />
  );
}
