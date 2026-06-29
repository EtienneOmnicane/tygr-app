"use client";

/**
 * Démo / Visual QA du formulaire de création de règle (`RegleForm`). NON destinée
 * à la production — capture le composant hors auth/DB (Quality Gate 4), avec des
 * catégories FICTIVES et un `onCreer` STUB. Permet de vérifier la refonte
 * ergonomique de la validation (2026-06-24) : bouton toujours cliquable, messages
 * d'erreur rouges sous les champs au clic à vide, effacement à la correction,
 * focus du premier champ fautif. Aucune couleur en dur, tokens UI_GUIDELINES.
 */
import { useState } from "react";

import type { CategorieUI } from "@/components/ui/category";
import { RegleForm } from "@/components/regles";

// Référentiel fictif : 2 Natures + sous-natures (hiérarchie 2 niveaux), comme la
// vraie page /regles (option group Nature → Sous-nature).
const CATEGORIES_DEMO: CategorieUI[] = [
  { id: "cat-income", name: "Revenus", parentId: null, isActive: true },
  { id: "cat-income-clients", name: "Paiements clients", parentId: "cat-income", isActive: true },
  { id: "cat-charges", name: "Charges", parentId: null, isActive: true },
  { id: "cat-charges-elec", name: "Électricité", parentId: "cat-charges", isActive: true },
  { id: "cat-charges-loyer", name: "Loyer", parentId: "cat-charges", isActive: true },
];

export default function RegleFormDemoPage() {
  // Trace les créations « réussies » (stub) pour vérifier visuellement qu'une
  // soumission VALIDE passe bien (et que les erreurs n'apparaissent qu'à vide).
  const [creees, setCreees] = useState<string[]>([]);
  // Reproduit le signal de reset du conteneur réel : incrémenté à chaque création
  // stub → RegleForm se vide (vérifie le reset au succès au Visual QA).
  const [cleReset, setCleReset] = useState(0);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-4 rounded-control bg-surface-inset px-4 py-3 text-sm text-text-muted">
        Démo (fixtures) — formulaire de règle isolé pour le Visual QA. Cliquez
        « Créer la règle » sans remplir pour voir les messages d’erreur.
      </div>

      <h1 className="mb-4 text-xl font-semibold text-text">
        Formulaire de règle — états de validation
      </h1>

      <RegleForm
        categories={CATEGORIES_DEMO}
        cleReset={cleReset}
        onCreer={(input) => {
          setCreees((prev) => [
            `${input.matchType} « ${input.pattern} » → ${input.categoryId}`,
            ...prev,
          ]);
          setCleReset((n) => n + 1); // succès stub → vide le formulaire
        }}
      />

      {creees.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
            Créations (stub)
          </p>
          <ul className="flex flex-col gap-1 text-sm text-text">
            {creees.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
