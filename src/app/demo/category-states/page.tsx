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
  SplitAllocationModal,
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

/**
 * Référentiel VOLUMINEUX (8 Natures × 4 sous-catégories = 40 lignes). Sa raison d'être
 * est de faire ÉCHOUER la modale si elle régresse : `Modal` verrouille le scroll du body
 * et centre son panneau, donc une liste non bornée déborderait au-dessus du bord haut du
 * viewport — titre et recherche deviendraient inatteignables. Un jeu de démo confortable
 * ne peut pas capturer ce défaut, c'est pourquoi celui-ci existe.
 */
const CATEGORIES_VOLUMINEUSES: CategorieUI[] = [
  "Revenus",
  "Charges d’exploitation",
  "Taxes & impôts",
  "Personnel",
  "Investissements",
  "Financement",
  "Frais généraux",
  "Divers",
].flatMap((nature, i) => {
  const idNature = `vol-nature-${i}`;
  return [
    { id: idNature, name: nature, parentId: null, isActive: true },
    ...["Électricité", "Loyer", "Prestations", "Matériel"].map((sous, j) => ({
      id: `vol-sous-${i}-${j}`,
      name: `${sous} ${i + 1}`,
      parentId: idNature,
      isActive: true,
    })),
  ];
});

/**
 * Stub d'ÉCHEC : chaque écriture répond un code du registre S2. Sert à capturer l'état
 * d'erreur au CONTACT du geste (un échec d'archivage doit se rendre sur la ligne
 * concernée, jamais sous le bouton « Créer » comme le faisait la version précédente).
 */
const ACTIONS_STUB_ECHEC: ActionsReferentielCategories = {
  listerCategories: async () => CATEGORIES_DEMO,
  creerCategorie: async () => ({
    ok: false,
    code: "CATEGORIE_DEJA_EXISTANTE",
    message: "Conflit serveur.",
  }),
  renommerCategorie: async () => ({
    ok: false,
    code: "CATEGORY_NOT_AUTHORIZED",
    message: "Refus serveur.",
  }),
  archiverCategorie: async () => ({
    ok: false,
    code: "CATEGORY_NOT_FOUND",
    message: "Introuvable côté serveur.",
  }),
};

// Sous-ensemble « importé » simulé pour la démo du picker VIDE (QA-ONBOARD-CATEG1).
const REFERENTIEL_IMPORTE_DEMO: CategorieUI[] = [
  { id: "cat-imp-revenus", name: "Revenus", parentId: null, isActive: true },
  { id: "cat-imp-ventes", name: "Ventes", parentId: "cat-imp-revenus", isActive: true },
  { id: "cat-imp-charges", name: "Charges d’exploitation", parentId: null, isActive: true },
  { id: "cat-imp-loyer", name: "Loyer", parentId: "cat-imp-charges", isActive: true },
];

/** Variante du gestionnaire à monter (null = fermé). */
type VarianteManager = "peuple" | "volumineux" | "vide" | "erreur";

function BoutonDemo({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-10 cursor-pointer items-center rounded-control bg-primary px-4
        text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
        focus-visible:ring-offset-2"
    >
      {children}
    </button>
  );
}

export default function CategoryStatesDemoPage() {
  const [selectionnee, setSelectionnee] = useState<string | null>("cat-charges-elec");
  const [managerOuvert, setManagerOuvert] = useState<VarianteManager | null>(null);
  const [splitOuvert, setSplitOuvert] = useState(false);
  // État local pour la section CategoryPicker (la création y ajoute une catégorie).
  const [categoriesDemo, setCategoriesDemo] =
    useState<CategorieUI[]>(CATEGORIES_DEMO);
  // État local pour la section « picker VIDE + import standard » : démarre à zéro,
  // l'import stub injecte le référentiel (comme le fait le conteneur réel).
  const [categoriesVides, setCategoriesVides] = useState<CategorieUI[]>([]);
  const [selectionVide, setSelectionVide] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
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
                categoriesDemo.find((c) => c.id === selectionnee)?.name ?? "—"
              }
              colorKey={selectionnee ?? "none"}
              size="sm"
            />
          </p>
          <CategoryPicker
            categories={categoriesDemo}
            selectedId={selectionnee}
            onSelect={setSelectionnee}
            onCreate={async (name) => {
              // Stub démo : fabrique un id local et l'ajoute à la liste pour que
              // la nouvelle catégorie apparaisse et soit sélectionnable.
              const categoryId = `cat-demo-${Date.now()}`;
              setCategoriesDemo((prev) => [
                ...prev,
                { id: categoryId, name: name.trim(), parentId: null, isActive: true },
              ]);
              return { ok: true, data: { categoryId } };
            }}
          />
        </section>

        {/* 2bis. CategoryPicker VIDE — CTA « Importer les catégories standard » */}
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            CategoryPicker — état vide (import du référentiel standard)
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            Onboarding (QA-ONBOARD-CATEG1) : un workspace neuf n’a aucune
            catégorie. Le picker propose l’import du référentiel standard (CTA
            réservé ADMIN côté serveur). Après import, les catégories
            apparaissent et le CTA disparaît.
          </p>
          <CategoryPicker
            categories={categoriesVides}
            selectedId={selectionVide}
            onSelect={setSelectionVide}
            onImportStandard={async () => {
              // Stub démo : simule le seed serveur en injectant le référentiel.
              setCategoriesVides(REFERENTIEL_IMPORTE_DEMO);
              return {
                ok: true,
                data: {
                  imported: REFERENTIEL_IMPORTE_DEMO.length,
                  categories: REFERENTIEL_IMPORTE_DEMO,
                },
              };
            }}
          />
        </section>

        {/* 3. CategoryManagerModal — les états capturés au Gate 4 */}
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            CategoryManagerModal — refonte ergonomique
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            Accordéons repliés par défaut (compteur de sous-catégories comme sommaire),
            recherche insensible aux accents, création CONTEXTUELLE sous chaque Nature,
            archivage sous confirmation inline, actions en boutons-icônes 32×32. Chaque
            variante ci-dessous isole un état à capturer.
          </p>
          <div className="flex flex-wrap gap-3">
            <BoutonDemo onClick={() => setManagerOuvert("peuple")}>
              Peuplé (3 Natures)
            </BoutonDemo>
            <BoutonDemo onClick={() => setManagerOuvert("volumineux")}>
              Volumineux (8 Natures / 40 lignes)
            </BoutonDemo>
            <BoutonDemo onClick={() => setManagerOuvert("vide")}>
              Référentiel vide
            </BoutonDemo>
            <BoutonDemo onClick={() => setManagerOuvert("erreur")}>
              Erreur serveur (toutes actions en échec)
            </BoutonDemo>
          </div>
          <CategoryManagerModal
            open={managerOuvert !== null}
            onClose={() => setManagerOuvert(null)}
            categories={
              managerOuvert === "vide"
                ? []
                : managerOuvert === "volumineux"
                  ? CATEGORIES_VOLUMINEUSES
                  : CATEGORIES_DEMO
            }
            actions={managerOuvert === "erreur" ? ACTIONS_STUB_ECHEC : ACTIONS_STUB}
          />
        </section>

        {/* 4. SplitAllocationModal — ventilation + réconciliation temps réel */}
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            SplitAllocationModal — ventilation (10 000 MUR)
          </h2>
          <button
            type="button"
            onClick={() => setSplitOuvert(true)}
            className="inline-flex h-10 items-center rounded-control bg-primary px-4
              text-sm font-semibold text-text-onink transition-colors
              hover:bg-primary-600 focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Ventiler la transaction
          </button>
          <SplitAllocationModal
            open={splitOuvert}
            onClose={() => setSplitOuvert(false)}
            transaction={{
              transactionId: "11111111-1111-4111-8111-111111111111",
              transactionDate: "2026-06-11",
              label: "Beachcomber Resorts",
              montantAbs: "10000.00",
              devise: "MUR",
              sens: "Credit",
            }}
            categories={CATEGORIES_DEMO}
            initialSplits={[
              {
                id: "split-1",
                categoryId: "cat-charges-elec",
                amount: "6000.00",
                source: "MANUAL",
                ruleId: null,
              },
              {
                id: "split-2",
                categoryId: "cat-charges-mat",
                amount: "2000.00",
                source: "MANUAL",
                ruleId: null,
              },
            ]}
            onReplace={async () => ({ ok: true, data: undefined })}
            onCreateCategorie={(name) =>
              ACTIONS_STUB.creerCategorie({ name, parentId: null })
            }
          />
        </section>
      </main>
    </div>
  );
}
