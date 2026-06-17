"use client";

/**
 * Démo / Visual QA des fondations de catégorisation (Pilier 1) : CategoryBadge,
 * CategoryPicker, CategoryManagerModal. NON destinée à la production — sert à
 * capturer les composants hors auth/DB (Quality Gate 4), avec des données
 * FICTIVES et des actions STUB (le câblage réel passe par les Server Actions du
 * Backend). Permet de vérifier : palette catégorielle (aucun vert/rouge),
 * contrastes AA, hiérarchie du picker, focus-trap de la modale.
 */
import { useState } from "react";

import {
  CategoryBadge,
  CategoryPicker,
  CategoryManagerModal,
  type ActionsReferentielCategories,
  type CategorieUI,
} from "@/components/ui/category";

// Référentiel fictif : 3 Natures + sous-natures (hiérarchie 2 niveaux).
const CATEGORIES_DEMO: CategorieUI[] = [
  { id: "cat-income", name: "Revenus", parentId: null, isActive: true },
  { id: "cat-income-clients", name: "Paiements clients", parentId: "cat-income", isActive: true },
  { id: "cat-income-autres", name: "Autres revenus", parentId: "cat-income", isActive: true },
  { id: "cat-charges", name: "Charges", parentId: null, isActive: true },
  { id: "cat-charges-elec", name: "Électricité", parentId: "cat-charges", isActive: true },
  { id: "cat-charges-loyer", name: "Loyer", parentId: "cat-charges", isActive: true },
  { id: "cat-charges-presta", name: "Prestations", parentId: "cat-charges", isActive: true },
  { id: "cat-charges-mat", name: "Matériel", parentId: "cat-charges", isActive: true },
  { id: "cat-taxes", name: "Taxes & impôts", parentId: null, isActive: true },
];

// Actions STUB (inertes) — la démo ne touche pas le serveur.
const ACTIONS_STUB: ActionsReferentielCategories = {
  listerCategories: async () => CATEGORIES_DEMO,
  creerCategorie: async () => ({ ok: true, data: { categoryId: "cat-stub" } }),
  renommerCategorie: async () => ({ ok: true, data: undefined }),
  archiverCategorie: async () => ({ ok: true, data: undefined }),
};

export default function CategoryStatesDemoPage() {
  const [selectionnee, setSelectionnee] = useState<string | null>("cat-charges-elec");
  const [managerOuvert, setManagerOuvert] = useState(false);

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">TYGR</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Catégorisation (Pilier 1)
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Fondations de catégorisation — données fictives, actions inertes.
      </div>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
        {/* 1. CategoryBadge — toutes les teintes pour vérifier l'absence de vert/rouge */}
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            CategoryBadge — palette catégorielle
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            Couleur déterministe par catégorie. AUCUN vert ni rouge (réservés aux
            entrées/sorties, §3.1) : palette indigo / violet / ambre / bleu-acier /
            brun / rose / ardoise / fuchsia.
          </p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES_DEMO.map((c) => (
              <CategoryBadge key={c.id} name={c.name} colorKey={c.id} />
            ))}
          </div>
          <h3 className="mb-2 mt-6 text-[13px] text-text-muted">Taille sm (table dense)</h3>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES_DEMO.slice(0, 5).map((c) => (
              <CategoryBadge key={c.id} name={c.name} colorKey={c.id} size="sm" />
            ))}
          </div>
        </section>

        {/* 2. CategoryPicker — popover hiérarchique */}
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            CategoryPicker — sélection hiérarchique
          </h2>
          <p className="mb-4 text-sm text-text-muted">
            Sélectionnée :{" "}
            <CategoryBadge
              name={
                CATEGORIES_DEMO.find((c) => c.id === selectionnee)?.name ?? "—"
              }
              colorKey={selectionnee ?? "none"}
              size="sm"
            />
          </p>
          <CategoryPicker
            categories={CATEGORIES_DEMO}
            selectedId={selectionnee}
            onSelect={setSelectionnee}
          />
        </section>

        {/* 3. CategoryManagerModal */}
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            CategoryManagerModal
          </h2>
          <button
            type="button"
            onClick={() => setManagerOuvert(true)}
            className="inline-flex h-10 items-center rounded-control bg-primary px-4
              text-sm font-semibold text-text-onink transition-colors
              hover:bg-primary-600 focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Ouvrir le gestionnaire
          </button>
          <CategoryManagerModal
            open={managerOuvert}
            onClose={() => setManagerOuvert(false)}
            categories={CATEGORIES_DEMO}
            actions={ACTIONS_STUB}
          />
        </section>
      </main>
    </div>
  );
}
