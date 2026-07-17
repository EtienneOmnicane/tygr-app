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
  DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE,
  DEMO_DASHBOARD_PREVISION_SANS_REALISE,
  DEMO_DASHBOARD_UN_MOIS,
  DEMO_DASHBOARD_VIDE,
  DEMO_MOIS,
} from "@/lib/dashboard-demo-fixtures";
import { formaterMoisAnnee } from "@/lib/format-date";
import {
  DashboardContent,
  type DonneesDashboard,
} from "@/components/dashboard/dashboard-content";

type EtatDemo =
  | "succes"
  | "prevision-sans-realise"
  | "prevision-autre-devise"
  | "sans-prevision"
  | "multi-devise"
  | "un-mois"
  | "partiel"
  | "vide";
type FraicheurDemo = "frais" | "recent" | "perime";

const ONGLETS: Array<{ id: EtatDemo; label: string }> = [
  { id: "succes", label: "Succès (avec prévision)" },
  { id: "prevision-sans-realise", label: "Prévision SEULE (sans réalisé)" },
  { id: "prevision-autre-devise", label: "Prévision autre devise" },
  { id: "sans-prevision", label: "Sans prévision (fenêtre passée)" },
  { id: "multi-devise", label: "Multi-devise (5)" },
  { id: "un-mois", label: "1 mois peuplé (fix courbe)" },
  { id: "partiel", label: "Partiel (post-onboarding)" },
  { id: "vide", label: "Vide" },
];

/**
 * Cas 5 devises (UI-SOLDE-MULTIDEVISE-POLISH1) : mélange devises À symbole
 * (EUR/MUR/USD) et SANS symbole (GBP/ZAR) pour capturer la pile unifiée —
 * indicateur toujours à gauche, décimales toutes alignées, zéro suffixe ISO.
 * Surcharge locale de `soldesParDevise` : la fixture partagée reste intacte.
 */
const DEMO_SOLDES_CINQ_DEVISES: DonneesDashboard["soldesParDevise"] = [
  { currency: "EUR", total: "128450.75" },
  { currency: "GBP", total: "349.20" },
  { currency: "MUR", total: "7691000.00" },
  { currency: "USD", total: "179200.00" },
  { currency: "ZAR", total: "1204360.50" },
];

/**
 * Fixture montée par onglet. Table plutôt que cascade de ternaires : à 8 états, la
 * cascade devenait illisible et un état oublié y passait inaperçu (le Record force
 * l'exhaustivité au typecheck).
 */
const FIXTURE_PAR_ETAT: Record<EtatDemo, DonneesDashboard> = {
  succes: DEMO_DASHBOARD,
  // Défaut n°1 du plan §5.2 : la prévision doit s'afficher SEULE, jamais « Aucun mouvement ».
  "prevision-sans-realise": DEMO_DASHBOARD_PREVISION_SANS_REALISE,
  // §5.3 : colonnes futures à ZÉRO + note — jamais un montant étranger, jamais de FX.
  "prevision-autre-devise": DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE,
  // D4 : fenêtre passée → AUCUNE zone prévisionnelle (l'axe reste celui d'aujourd'hui).
  "sans-prevision": { ...DEMO_DASHBOARD, prevision: null },
  "multi-devise": { ...DEMO_DASHBOARD, soldesParDevise: DEMO_SOLDES_CINQ_DEVISES },
  "un-mois": DEMO_DASHBOARD_UN_MOIS,
  partiel: DEMO_DASHBOARD_PARTIEL,
  vide: DEMO_DASHBOARD_VIDE,
};

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
    const base = FIXTURE_PAR_ETAT[etat];
    // L'état « vide » n'a pas de compte → la fraîcheur n'a pas d'effet (pas de pastille).
    return etat === "vide" ? base : avecFraicheur(base, heures);
  }, [etat, fraicheur]);

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
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

      {/* role ADMIN : la démo montre le bouton « Synchroniser » actif (état complet). */}
      {/* Libellés de période : la démo monte le cas PRESET (la page réelle bascule sur
          l'intervalle « 3 mars → 17 avr. 2026 » et « Synthèse de la période » dès qu'une
          plage `?du`/`?au` prime — cf. TOOLBAR-DATE-PRECISE1). */}
      <DashboardContent
        donnees={donnees}
        devise="MUR"
        libellePeriode="6 derniers mois"
        syntheseTitre="Synthèse du mois"
        syntheseLibelle={formaterMoisAnnee(DEMO_MOIS)}
        role="ADMIN"
      />
    </div>
  );
}
