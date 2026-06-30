"use client";

/**
 * Page de démo / Visual QA des états du dashboard (Epic 3).
 * NON destinée à la production : sert uniquement à capturer loading / vide /
 * erreur pour la comparaison vision contre docs/UI_GUIDELINES.md (Quality
 * Gate 4) et pour la démo. Hors du groupe (workspace) → aucune dépendance à
 * l'auth ni à la DB (ces composants sont présentationnels purs).
 *
 * Le chrome (header ink, side-panel KPI) est reconstitué EN DUR ici, à partir
 * du benchmark FYGR (docs/benchmarks/FYGR/1_dashboard) et de l'anatomie
 * UI_GUIDELINES §1, à seule fin de contextualiser les états dans un écran
 * réaliste. Ce n'est PAS le vrai shell applicatif.
 */
import { useState } from "react";

import {
  DashboardEmptyState,
  DashboardErrorState,
  DashboardLoadingState,
} from "@/components/dashboard/states";
import { IconeSynchro } from "@/components/ui/icons/icone-synchro";

type EtatDemo = "loading" | "empty" | "error" | "sync";

const ONGLETS: Array<{ id: EtatDemo; label: string }> = [
  { id: "loading", label: "Chargement" },
  { id: "empty", label: "Vide" },
  { id: "error", label: "Erreur" },
  { id: "sync", label: "Bouton Synchroniser" },
];

export default function DashboardStatesDemoPage() {
  const [etat, setEtat] = useState<EtatDemo>("loading");

  return (
    <div className="min-h-screen bg-surface-page">
      {/* Header ink (UI_GUIDELINES §1.2) — reconstitué pour le contexte visuel */}
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">TYGR</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Visual QA
        </span>
        <nav className="ml-6 flex items-center gap-6 text-sm font-medium">
          <span className="relative pb-1 text-text-onink">
            Dashboard
            <span className="absolute inset-x-0 -bottom-[18px] h-1 rounded-[2px] bg-accent" />
          </span>
          <span className="text-text-onink/60">Graphiques</span>
          <span className="text-text-onink/60">Échéances</span>
          <span className="text-text-onink/60">Transactions</span>
        </nav>
      </header>

      {/* Bandeau de démo (les états ne sont pas pilotés par de la vraie donnée) */}
      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        États présentationnels inertes — sélectionnez un état pour la capture.
      </div>

      {/* Sélecteur d'états : segmented control (§2.3) */}
      <div className="px-6 pt-6">
        <div
          role="tablist"
          aria-label="État du dashboard à prévisualiser"
          className="inline-flex gap-1 rounded-control bg-surface-inset p-1"
        >
          {ONGLETS.map((onglet) => {
            const actif = etat === onglet.id;
            return (
              <button
                key={onglet.id}
                type="button"
                role="tab"
                aria-selected={actif}
                onClick={() => setEtat(onglet.id)}
                className={
                  actif
                    ? "rounded-[6px] bg-ink px-4 py-1.5 text-sm font-semibold text-text-onink"
                    : "rounded-[6px] px-4 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                }
              >
                {onglet.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Layout asymétrique : side-panel KPI (300px) + zone de données (§1.1) */}
      <div className="flex gap-6 px-6 py-6">
        <DemoSidePanel />
        <main className="min-w-0 flex-1">
          {etat === "loading" && <DashboardLoadingState />}
          {etat === "empty" && (
            <DashboardEmptyState accountLabel="Compte courant — BCP" />
          )}
          {etat === "error" && (
            <DashboardErrorState detail="OMNIFI_SYNC_TIMEOUT · connexion expirée après 30 s" />
          )}
          {etat === "sync" && <DemoSyncStates />}
        </main>
      </div>
    </div>
  );
}

/**
 * Vitrine FIGÉE des états du bouton « Synchroniser » (L8a) — reproduit le markup de
 * `SyncButton` dans chacun de ses 5 états + le cas VIEWER, pour la capture headless
 * (les états réels sont pilotés par le retour de la Server Action, non injectable en
 * démo — même approche que `widget-feedback.tsx` monté figé). Couleurs : succès
 * `text-success`, erreur `text-danger` (jamais un rouge de donnée, §3.4) ; le bouton
 * est un lien d'action `text-primary` (§2.3). Aucune couleur de donnée ici.
 */
function DemoSyncStates() {
  return (
    <div className="rounded-card bg-surface-card p-6 shadow-card">
      <h2 className="mb-4 text-base font-semibold text-text">
        Bouton « Synchroniser » — états
      </h2>
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
        <CasSync titre="Repos (MANAGER/ADMIN)">
          <BoutonRepos />
        </CasSync>
        <CasSync titre="En cours">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary opacity-48">
            <IconeSynchro className="h-3.5 w-3.5 motion-safe:animate-spin" />
            Synchronisation…
          </span>
        </CasSync>
        <CasSync titre="Succès">
          <div className="flex flex-col items-start gap-1.5">
            <BoutonRepos />
            <p className="text-xs text-success">Comptes à jour.</p>
          </div>
        </CasSync>
        <CasSync titre="Erreur">
          <div className="flex flex-col items-start gap-1.5">
            <BoutonRepos />
            <p className="text-xs text-danger">Action non autorisée.</p>
          </div>
        </CasSync>
        <CasSync titre="Réparation MFA">
          <div className="flex flex-col items-start gap-1.5">
            <BoutonRepos />
            <p className="text-xs text-text-muted">
              Une vérification de sécurité est requise.{" "}
              <span className="font-semibold text-primary underline">
                Reconnecter
              </span>
            </p>
          </div>
        </CasSync>
        <CasSync titre="VIEWER (inerte)">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-faint">
            <IconeSynchro className="h-3.5 w-3.5" />
            Synchroniser
          </span>
        </CasSync>
      </div>
    </div>
  );
}

/** Bouton « Synchroniser » au repos (lien d'action primary + icône). */
function BoutonRepos() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
      <IconeSynchro className="h-3.5 w-3.5" />
      Synchroniser
    </span>
  );
}

/** Cellule de la vitrine : libellé d'état + rendu. */
function CasSync({
  titre,
  children,
}: {
  titre: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-line/60 pb-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
        {titre}
      </span>
      {children}
    </div>
  );
}

/**
 * Side-panel KPI reconstitué EN DUR (anatomie §1.3) — valeurs brutes figées,
 * pas de donnée réelle. Présent pour situer les états dans le vrai layout.
 * Montants en `tabular-nums` (directive §0). Vert/rouge réservés à la donnée.
 */
function DemoSidePanel() {
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col gap-6 lg:flex">
      {/* Carte SOLDE */}
      <div className="rounded-card bg-surface-card p-6 shadow-card">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Solde
          </span>
          <span className="text-xs text-text-muted">Aujourd’hui</span>
        </div>
        <p className="mt-3 text-[28px] font-bold tabular-nums text-primary">
          7 691 €
        </p>
      </div>

      {/* Carte DÉTAILS */}
      <div className="rounded-card bg-surface-card p-6 shadow-card">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Détails
          </span>
          <span className="text-xs text-text-muted">Juin 2026</span>
        </div>
        <dl className="mt-4 flex flex-col gap-5">
          <KpiRow label="Entrées" valeur="1 000 €" couleur="text-inflow-700" />
          <KpiRow label="Sorties" valeur="274 €" couleur="text-outflow-700" />
          <KpiRow label="Variation" valeur="726 €" couleur="text-text" />
        </dl>
      </div>
    </aside>
  );
}

function KpiRow({
  label,
  valeur,
  couleur,
}: {
  label: string;
  valeur: string;
  couleur: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${couleur}`}>
        {valeur}
      </dd>
    </div>
  );
}
