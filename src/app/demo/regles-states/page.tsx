"use client";

/**
 * Démo / Visual QA du domaine « Règles de catégorisation » — édition + priorité.
 * NON destinée à la production : monte `ReglesFeature` avec des règles FICTIVES et des
 * actions STUB (aucun serveur, aucune DB). Sert à capturer hors auth/DB (Quality
 * Gate 4) : formulaire d'édition (pré-remplissage + case « Règle active » + microcopy
 * anti-illusion), poignées de glisser + flèches ↑/↓, bouton « Modifier » y compris sur
 * une règle archivée, focus visibles. Les stubs simulent le réordonnancement en
 * mémoire pour vérifier que la liste bouge.
 */
import { useRef, useState } from "react";

import type { CategorieUI } from "@/components/ui/category";
import { ReglesFeature } from "@/components/regles";
import type { ActionsRegles, RegleUI } from "@/components/regles";

const CATEGORIES_DEMO: CategorieUI[] = [
  { id: "cat-charges", name: "Charges", parentId: null, isActive: true },
  { id: "cat-elec", name: "Électricité", parentId: "cat-charges", isActive: true },
  { id: "cat-loyer", name: "Loyer", parentId: "cat-charges", isActive: true },
  { id: "cat-revenus", name: "Revenus", parentId: null, isActive: true },
  { id: "cat-clients", name: "Paiements clients", parentId: "cat-revenus", isActive: true },
];

const REGLES_DEMO: RegleUI[] = [
  { id: "r-1", pattern: "EDF", matchType: "contains", categoryId: "cat-elec", isActive: true, priority: 0 },
  { id: "r-2", pattern: "VIR LOYER", matchType: "starts_with", categoryId: "cat-loyer", isActive: true, priority: 1 },
  { id: "r-3", pattern: "SALAIRE", matchType: "contains", categoryId: "cat-clients", isActive: true, priority: 2 },
  { id: "r-4", pattern: "ANCIENNE", matchType: "contains", categoryId: "cat-charges", isActive: false, priority: 5 },
];

export default function ReglesStatesDemoPage() {
  // Source de vérité de la démo. `state` alimente le rendu (initiales) ; `ref` (miroir
  // synchrone) est lu par les STUBS pour que `listerRegles` — appelé par recharger()
  // JUSTE APRÈS une mutation — renvoie la valeur À JOUR sans dépendre du timing de
  // re-render. Le ref n'est JAMAIS lu pendant le render (règle lint react-hooks/refs) :
  // le rendu lit `regles` (state) ; seuls les callbacks async lisent `reglesRef.current`.
  const [regles, setRegles] = useState<RegleUI[]>(() =>
    REGLES_DEMO.map((r) => ({ ...r })),
  );
  const reglesRef = useRef<RegleUI[]>(regles);

  /** Applique une mutation au ref (synchrone) ET au state (rendu). */
  function appliquer(maj: (prev: RegleUI[]) => RegleUI[]) {
    const suivant = maj(reglesRef.current);
    reglesRef.current = suivant;
    setRegles(suivant);
  }

  const actions: ActionsRegles = {
    listerRegles: async () => reglesRef.current.map((r) => ({ ...r })),
    creerRegle: async () => ({ ok: true, data: { ruleId: "r-stub" } }),
    modifierRegle: async (input) => {
      appliquer((prev) =>
        prev.map((r) =>
          r.id === input.ruleId
            ? {
                ...r,
                pattern: input.pattern ?? r.pattern,
                matchType: input.matchType ?? r.matchType,
                categoryId: input.categoryId ?? r.categoryId,
                isActive: input.isActive ?? r.isActive,
              }
            : r,
        ),
      );
      return { ok: true, data: undefined };
    },
    archiverRegle: async (ruleId) => {
      appliquer((prev) =>
        prev.map((r) => (r.id === ruleId ? { ...r, isActive: false } : r)),
      );
      return { ok: true, data: undefined };
    },
    reordonnerRegles: async (ordre) => {
      appliquer((prev) => {
        const parId = new Map(prev.map((r) => [r.id, r]));
        const actifsReordonnes = ordre
          .map((id) => parId.get(id))
          .filter((r): r is RegleUI => r !== undefined)
          .map((r, i) => ({ ...r, priority: i }));
        const archivees = prev.filter((r) => !r.isActive);
        return [...actifsReordonnes, ...archivees];
      });
      return { ok: true, data: undefined };
    },
    appliquerRegles: async () => ({ ok: true, data: { appliquees: 3 } }),
  };

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">TYGR</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Règles (édition + priorité)
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Domaine Règles — données fictives, actions inertes. Édition, réordonnancement
        (glisser + flèches), réactivation d’une règle archivée.
      </div>

      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text">Règles de catégorisation</h1>
          <p className="mt-1 text-sm text-text-muted">
            Glissez une règle (ou utilisez ▲/▼) pour changer sa priorité — la règle du
            haut l’emporte. « Modifier » ouvre le formulaire (y compris pour réactiver
            une règle archivée).
          </p>
        </div>
        <ReglesFeature
          initiales={regles.map((r) => ({ ...r }))}
          categories={CATEGORIES_DEMO}
          actions={actions}
          peutGerer
        />
      </main>
    </div>
  );
}
