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
import type { Fraicheur } from "@/lib/format-date";
import { SyncSummary } from "@/components/sync/sync-summary";

type EtatDemo = "loading" | "empty" | "error" | "sync";

const ONGLETS: Array<{ id: EtatDemo; label: string }> = [
  { id: "loading", label: "Chargement" },
  { id: "empty", label: "Vide" },
  { id: "error", label: "Erreur" },
  { id: "sync", label: "Compte rendu de synchro" },
];

export default function DashboardStatesDemoPage() {
  const [etat, setEtat] = useState<EtatDemo>("loading");

  return (
    <div className="min-h-screen bg-surface-page">
      {/* Header ink (UI_GUIDELINES §1.2) — reconstitué pour le contexte visuel */}
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
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
 * Vitrine des états du COMPTE RENDU de synchro — monte le VRAI `SyncSummary` avec des
 * retours figés, pour la capture headless (Gate 4).
 *
 * Avant, cette vitrine REPRODUISAIT le markup de `sync-button.tsx`. Ça a fini par
 * mentir : elle affichait encore « Comptes à jour. », littéral supprimé du vrai
 * composant par la PR #202 (c'était précisément le faux message de victoire corrigé).
 * `SyncSummary` étant pur et piloté par props, la copie n'a plus lieu d'être — ce qui
 * est capturé ici est ce qui est rendu en production.
 *
 * `onRelancer` est fourni mais inerte (aucune Server Action hors du workspace).
 */
function DemoSyncStates() {
  const fraicheurFraiche: Fraicheur = {
    niveau: "frais",
    libelle: "il y a 12 min",
    horodatageAbsolu: "20/07/2026 à 09:42",
  };
  const fraicheurPerimee: Fraicheur = {
    niveau: "perime",
    libelle: "il y a 3 j",
    horodatageAbsolu: "17/07/2026 à 08:15",
  };

  return (
    <div className="rounded-card bg-surface-card p-6 shadow-card">
      <h2 className="mb-4 text-base font-semibold text-text">
        Compte rendu de synchronisation — états
      </h2>
      <div className="flex flex-col gap-6">
        <CasSync titre="Repos (jamais synchronisé dans cette session)">
          <SyncSummary fraicheur={fraicheurFraiche} compteLabel="MCB" retour={null} />
        </CasSync>

        <CasSync titre="En cours">
          <SyncSummary
            fraicheur={fraicheurFraiche}
            compteLabel="MCB"
            retour={null}
            enCours
          />
        </CasSync>

        <CasSync titre="Succès (aucune réserve)">
          <SyncSummary
            fraicheur={fraicheurFraiche}
            compteLabel="MCB"
            retour={{
              erreur: null,
              succes:
                "Synchronisation effectuée — 3 banque(s) à jour, 8 compte(s) mis à jour. 142 transaction(s) importée(s).",
            }}
          />
        </CasSync>

        <CasSync titre="Partiel (scrape encore en cours chez la banque)">
          <SyncSummary
            fraicheur={fraicheurFraiche}
            compteLabel="MCB"
            peutRelancer
            onRelancer={() => {}}
            retour={{
              erreur: null,
              succes:
                "Synchronisation effectuée — 2 banque(s) à jour, 5 compte(s) mis à jour. 1 banque(s) sont encore en cours de synchronisation — les transactions déjà disponibles ont été importées ; relancez dans quelques minutes pour récupérer le reste.",
              incomplet: true,
            }}
          />
        </CasSync>

        <CasSync titre="Banques à reconnecter (accès désaligné + réparation MFA)">
          <SyncSummary
            fraicheur={fraicheurPerimee}
            compteLabel="ABSA"
            retour={{
              erreur: null,
              succes:
                "Synchronisation effectuée — 1 banque(s) à jour, 2 compte(s) mis à jour. 1 banque(s) doivent être reconnectées — leur accès n’est plus valide.",
              aReconnecter: [{ connectionId: "cx-demo-1" }],
            }}
          />
        </CasSync>

        <CasSync titre="Banques non rattachées (désynchronisation base ↔ amont)">
          <SyncSummary
            fraicheur={fraicheurPerimee}
            compteLabel="ABSA"
            retour={{
              erreur: null,
              succes: null,
              info: "Aucune banque à synchroniser. 1 banque(s) connectée(s) chez votre fournisseur ne sont pas rattachées à cet espace — finalisez la connexion via « Connecter une banque ». 2 banque(s) de cet espace ne répondent plus — reconnectez-les via « Connecter une banque ».",
            }}
          />
        </CasSync>

        <CasSync titre="Erreur (échec dur de toutes les banques)">
          <SyncSummary
            fraicheur={fraicheurPerimee}
            compteLabel="ABSA"
            retour={{
              erreur:
                "La synchronisation a échoué pour toutes vos banques. Réessayez dans un instant.",
              succes: null,
            }}
          />
        </CasSync>

        <CasSync titre="VIEWER (partiel, sans bouton Relancer)">
          <SyncSummary
            fraicheur={fraicheurFraiche}
            compteLabel="MCB"
            peutRelancer={false}
            retour={{
              erreur: null,
              succes:
                "Synchronisation effectuée — 2 banque(s) à jour, 5 compte(s) mis à jour.",
              incomplet: true,
            }}
          />
        </CasSync>
      </div>
    </div>
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
