"use client";

/**
 * Prévisualisation / Visual QA du dashboard assemblé (Epic 3, PR C). NON destinée
 * à la production : monte `DashboardContent` avec les fixtures UI (données
 * fictives `src/lib/`, hors auth/DB) pour capturer succès / partiel / vide avant
 * le câblage réel (PR D). Source de vérité visuelle : docs/UI_GUIDELINES.md.
 *
 * Sélecteur « Fraîcheur » (Lot 2 §3.7) : réécrit `lastSyncedAt` des comptes
 * relativement à MAINTENANT (now − 2h / 12h / 30h) pour capturer les 3 seuils de
 * la pastille (frais / récent / périmé + CTA). Dérivé ici côté client — la fixture
 * partagée garde ses dates fixes (cohérence avec la fixture serveur).
 */
import { useMemo, useState } from "react";

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
type FraicheurDemo = "frais" | "recent" | "perime";

const ONGLETS: Array<{ id: EtatDemo; label: string }> = [
  { id: "succes", label: "Succès" },
  { id: "partiel", label: "Partiel (post-onboarding)" },
  { id: "vide", label: "Vide" },
];

const ONGLETS_FRAICHEUR: Array<{ id: FraicheurDemo; label: string; heures: number }> = [
  { id: "frais", label: "Frais (<6h)", heures: 2 },
  { id: "recent", label: "Récent (<24h)", heures: 12 },
  { id: "perime", label: "Périmé (≥24h)", heures: 30 },
];

/** Réécrit `lastSyncedAt` des comptes à now − `heures` (pour capturer un seuil). */
function avecFraicheur(
  base: DonneesDashboard,
  heures: number,
): DonneesDashboard {
  const ts = new Date(Date.now() - heures * 3_600_000);
  return {
    ...base,
    comptes: base.comptes.map((c) => ({ ...c, lastSyncedAt: ts })),
  };
}

export default function DashboardPreviewPage() {
  const [etat, setEtat] = useState<EtatDemo>("succes");
  const [fraicheur, setFraicheur] = useState<FraicheurDemo>("frais");

  const donnees = useMemo<DonneesDashboard>(() => {
    const heures =
      ONGLETS_FRAICHEUR.find((o) => o.id === fraicheur)?.heures ?? 2;
    const base =
      etat === "succes"
        ? DEMO_DASHBOARD
        : etat === "partiel"
          ? DEMO_DASHBOARD_PARTIEL
          : DEMO_DASHBOARD_VIDE;
    // L'état « vide » n'a pas de compte → la fraîcheur n'a pas d'effet (pas de pastille).
    return etat === "vide" ? base : avecFraicheur(base, heures);
  }, [etat, fraicheur]);

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

      <div className="flex flex-wrap items-center gap-6 px-6 pt-6">
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

        {/* Sélecteur de fraîcheur (§3.7) — inerte en état « vide ». */}
        <div
          role="tablist"
          aria-label="Fraîcheur du solde à prévisualiser"
          className={`inline-flex gap-1 rounded-control bg-surface-inset p-1 ${
            etat === "vide" ? "opacity-50" : ""
          }`}
        >
          {ONGLETS_FRAICHEUR.map((o) => {
            const actif = fraicheur === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="tab"
                aria-selected={actif}
                disabled={etat === "vide"}
                onClick={() => setFraicheur(o.id)}
                className={
                  actif
                    ? "rounded-[6px] bg-ink px-4 py-1.5 text-sm font-semibold text-text-onink disabled:cursor-not-allowed"
                    : "rounded-[6px] px-4 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <DashboardContent donnees={donnees} devise="MUR" />
    </div>
  );
}
