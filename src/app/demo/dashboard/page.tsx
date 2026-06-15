"use client";

/**
 * Prévisualisation / Visual QA du dashboard assemblé (Epic 3, PR C). NON destinée
 * à la production : monte `DashboardContent` avec les fixtures UI (données
 * fictives `src/lib/`, hors auth/DB) pour capturer succès / partiel / vide avant
 * le câblage réel (PR D). Source de vérité visuelle : docs/UI_GUIDELINES.md.
 */
import { useState } from "react";

import {
  DEMO_DASHBOARD,
  DEMO_DASHBOARD_PARTIEL,
  DEMO_DASHBOARD_VIDE,
} from "@/lib/dashboard-demo-fixtures";
import {
  DashboardContent,
  type DonneesDashboard,
} from "@/components/dashboard/dashboard-content";

type EtatDemo = "succes" | "partiel" | "vide";

const JEUX: Record<EtatDemo, DonneesDashboard> = {
  succes: DEMO_DASHBOARD,
  partiel: DEMO_DASHBOARD_PARTIEL,
  vide: DEMO_DASHBOARD_VIDE,
};

const ONGLETS: Array<{ id: EtatDemo; label: string }> = [
  { id: "succes", label: "Succès" },
  { id: "partiel", label: "Partiel (post-onboarding)" },
  { id: "vide", label: "Vide" },
];

export default function DashboardPreviewPage() {
  const [etat, setEtat] = useState<EtatDemo>("succes");

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">TYGR</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Dashboard
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Données fictives (fixtures) — sélectionnez un état pour la capture.
      </div>

      <div className="px-6 pt-6">
        <div
          role="tablist"
          aria-label="État du dashboard à prévisualiser"
          className="inline-flex gap-1 rounded-control bg-surface-inset p-1"
        >
          {ONGLETS.map((o) => {
            const actif = etat === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="tab"
                aria-selected={actif}
                onClick={() => setEtat(o.id)}
                className={
                  actif
                    ? "rounded-[6px] bg-ink px-4 py-1.5 text-sm font-semibold text-text-onink"
                    : "rounded-[6px] px-4 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <DashboardContent donnees={JEUX[etat]} devise="MUR" />
    </div>
  );
}
