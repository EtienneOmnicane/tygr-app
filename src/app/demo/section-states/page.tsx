"use client";

/**
 * Page de démo / Visual QA des Empty States de SECTION (Graphiques / Échéances /
 * Transactions). NON destinée à la production : sert uniquement à capturer les
 * états présentationnels pour la comparaison vision contre docs/UI_GUIDELINES.md
 * (Quality Gate 4) — les VRAIES pages dépendent de l'auth + DB (withWorkspace),
 * donc on isole ici le rendu pur du composant générique `EmptyState`.
 *
 * Le chrome (header ink, nav) est reconstitué EN DUR (anatomie UI_GUIDELINES §1),
 * à seule fin de contextualiser. Ce n'est PAS le vrai shell applicatif.
 */
import { useState } from "react";

import { EmptyState } from "@/components/ui/states";

type SectionDemo = "graphiques" | "echeances" | "transactions";

const SECTIONS: Array<{
  id: SectionDemo;
  label: string;
  illustration: "chart" | "calendar" | "table";
  title: string;
  message: string;
}> = [
  {
    id: "graphiques",
    label: "Graphiques",
    illustration: "chart",
    title: "Visualisez l’évolution de votre trésorerie",
    message:
      "Bientôt, retrouvez ici vos graphiques de position sur 90 jours, entrées et sorties par période. Cette section s’activera dès que vos comptes seront synchronisés.",
  },
  {
    id: "echeances",
    label: "Échéances",
    illustration: "calendar",
    title: "Suivez vos paiements à venir",
    message:
      "Bientôt, anticipez vos échéances clients et fournisseurs, avec leur statut et leurs montants. Cette section s’activera avec vos premières opérations synchronisées.",
  },
  {
    id: "transactions",
    label: "Transactions",
    illustration: "table",
    title: "Retrouvez toutes vos opérations",
    message:
      "Bientôt, parcourez, recherchez et catégorisez l’ensemble de vos transactions bancaires. Elles apparaîtront ici après la première synchronisation de vos comptes.",
  },
];

export default function SectionStatesDemoPage() {
  const [section, setSection] = useState<SectionDemo>("graphiques");
  // Bascule le CTA conditionnel (D2) : présent si aucune banque connectée.
  const [aucuneBanque, setAucuneBanque] = useState(true);

  const courante = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="min-h-screen bg-surface-page">
      {/* Header ink (UI_GUIDELINES §1.2) — reconstitué pour le contexte visuel */}
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Visual QA
        </span>
        <nav className="ml-6 flex items-center gap-6 text-sm font-medium">
          <span className="text-text-onink/60">Dashboard</span>
          {SECTIONS.map((s) => {
            const actif = s.id === section;
            return (
              <span
                key={s.id}
                className={actif ? "relative pb-1 text-text-onink" : "text-text-onink/60"}
              >
                {s.label}
                {actif && (
                  <span className="absolute inset-x-0 -bottom-[18px] h-1 rounded-[2px] bg-accent" />
                )}
              </span>
            );
          })}
        </nav>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Empty States de section — présentationnels inertes. Sélectionnez une
        section et l’état du CTA pour la capture.
      </div>

      {/* Sélecteurs : section + présence de banque (CTA conditionnel) */}
      <div className="flex flex-wrap items-center gap-4 px-6 pt-6">
        <div
          role="tablist"
          aria-label="Section à prévisualiser"
          className="inline-flex gap-1 rounded-control bg-surface-inset p-1"
        >
          {SECTIONS.map((s) => {
            const actif = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={actif}
                onClick={() => setSection(s.id)}
                className={
                  actif
                    ? "rounded-[6px] bg-ink px-4 py-1.5 text-sm font-semibold text-text-onink"
                    : "rounded-[6px] px-4 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                }
              >
                {s.label}
              </button>
            );
          })}
        </div>

        <label className="inline-flex items-center gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={aucuneBanque}
            onChange={(e) => setAucuneBanque(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Aucune banque connectée (affiche le CTA)
        </label>
      </div>

      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <EmptyState
          headingLevel="h1"
          illustration={courante.illustration}
          title={courante.title}
          message={courante.message}
          cta={
            aucuneBanque
              ? { label: "Connecter une banque", href: "/banques" }
              : undefined
          }
        />
      </main>
    </div>
  );
}
