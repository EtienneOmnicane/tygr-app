"use client";

/**
 * Démo / Visual QA du domaine « Échéances prévisionnelles ». NON destinée à la
 * production : monte `EcheancesFeature` avec des échéances FICTIVES et des actions
 * STUB (aucun serveur, aucune DB). Sert à capturer hors auth/DB (Quality Gate 4) :
 *   - la synthèse prévisionnelle multi-devises (fond forecast, net coloré par signe) ;
 *   - la vue DIRIGÉE (bascule « à encaisser » / « à décaisser ») ;
 *   - les statuts (en cours, EN RETARD dérivé, partiel + restant dû, paiement en
 *     cours, payée) et le contrôle inline de changement de statut ;
 *   - le formulaire de création / édition (avec champ Entité, entités fournies).
 * Les stubs simulent la mutation en mémoire pour vérifier que la liste bouge.
 */
import { useRef, useState } from "react";

import type { CategorieUI } from "@/components/ui/category";
import { EcheancesFeature } from "@/components/echeances";
import type {
  ActionsEcheances,
  EcheanceUI,
  SyntheseEcheancesUI,
} from "@/components/echeances";
import type { EntiteOptionUI } from "@/components/echeances";

const CATEGORIES_DEMO: CategorieUI[] = [
  { id: "cat-revenus", name: "Revenus", parentId: null, isActive: true },
  { id: "cat-clients", name: "Paiements clients", parentId: "cat-revenus", isActive: true },
  { id: "cat-charges", name: "Charges", parentId: null, isActive: true },
  { id: "cat-loyer", name: "Loyer", parentId: "cat-charges", isActive: true },
  { id: "cat-fourn", name: "Fournisseurs", parentId: "cat-charges", isActive: true },
];

const ENTITES_DEMO: EntiteOptionUI[] = [
  { id: "ent-1", nom: "Omnicane Sugar" },
  { id: "ent-2", nom: "Omnicane Energy" },
];

// Échéances fictives couvrant les deux directions, plusieurs devises et tous les
// statuts d'affichage (dont le dérivé « en_retard » et un « partiel » avec restant dû).
// « Aujourd'hui » de référence pour la démo ≈ 2026-07-08 (cf. env) : les dates passées
// portent enRetard=true tant que le statut n'est pas terminal.
const ECHEANCES_DEMO: EcheanceUI[] = [
  {
    id: "e-1",
    entityId: "ent-1",
    direction: "encaissement",
    libelle: "Facture client Alpha",
    contrepartie: "Alpha Ltd",
    montant: "1850000.00",
    devise: "MUR",
    dateEcheance: "2026-06-30",
    statut: "en_cours",
    statutAffiche: "en_retard",
    enRetard: true,
    categorieId: "cat-clients",
    recurrence: null,
    montantRegle: null,
  },
  {
    id: "e-2",
    entityId: "ent-1",
    direction: "encaissement",
    libelle: "Acompte projet Beta",
    contrepartie: "Beta Corp",
    montant: "42000.00",
    devise: "USD",
    dateEcheance: "2026-07-20",
    statut: "partiel",
    statutAffiche: "partiel",
    enRetard: false,
    categorieId: "cat-clients",
    recurrence: null,
    montantRegle: "15000.00",
  },
  {
    id: "e-3",
    entityId: "ent-2",
    direction: "encaissement",
    libelle: "Abonnement énergie Gamma",
    contrepartie: "Gamma SA",
    montant: "9500.00",
    devise: "EUR",
    dateEcheance: "2026-08-05",
    statut: "en_cours",
    statutAffiche: "en_cours",
    enRetard: false,
    categorieId: "cat-clients",
    recurrence: "mensuelle",
    montantRegle: null,
  },
  {
    id: "e-4",
    entityId: "ent-1",
    direction: "decaissement",
    libelle: "Loyer entrepôt Port-Louis",
    contrepartie: "SCI Océan",
    montant: "320000.00",
    devise: "MUR",
    dateEcheance: "2026-07-15",
    statut: "en_cours",
    statutAffiche: "en_cours",
    enRetard: false,
    categorieId: "cat-loyer",
    recurrence: "mensuelle",
    montantRegle: null,
  },
  {
    id: "e-5",
    entityId: "ent-2",
    direction: "decaissement",
    libelle: "Fournisseur matériel Delta",
    contrepartie: "Delta GmbH",
    montant: "18750.00",
    devise: "EUR",
    dateEcheance: "2026-07-28",
    statut: "paiement_en_cours",
    statutAffiche: "paiement_en_cours",
    enRetard: false,
    categorieId: "cat-fourn",
    recurrence: null,
    montantRegle: null,
  },
  {
    id: "e-6",
    entityId: "ent-1",
    direction: "decaissement",
    libelle: "Prime d’assurance Q2",
    contrepartie: "Assur Maurice",
    montant: "56000.00",
    devise: "MUR",
    dateEcheance: "2026-06-25",
    statut: "payee",
    statutAffiche: "payee",
    enRetard: false,
    categorieId: "cat-charges",
    recurrence: "trimestrielle",
    montantRegle: null,
  },
];

// Synthèse statique (le serveur l'agrège normalement en SQL) : restant dû par horizon
// et par devise, jamais additionné entre devises.
const SYNTHESE_DEMO: SyntheseEcheancesUI = [
  {
    jours: 30,
    lignes: [
      { devise: "MUR", encaissement: "1850000.00", decaissement: "320000.00", net: "1530000.00" },
      { devise: "USD", encaissement: "27000.00", decaissement: "0.00", net: "27000.00" },
      { devise: "EUR", encaissement: "0.00", decaissement: "18750.00", net: "-18750.00" },
    ],
  },
  {
    jours: 60,
    lignes: [
      { devise: "MUR", encaissement: "1850000.00", decaissement: "320000.00", net: "1530000.00" },
      { devise: "USD", encaissement: "27000.00", decaissement: "0.00", net: "27000.00" },
      { devise: "EUR", encaissement: "9500.00", decaissement: "18750.00", net: "-9250.00" },
    ],
  },
  {
    jours: 90,
    lignes: [
      { devise: "MUR", encaissement: "1850000.00", decaissement: "320000.00", net: "1530000.00" },
      { devise: "USD", encaissement: "27000.00", decaissement: "0.00", net: "27000.00" },
      { devise: "EUR", encaissement: "9500.00", decaissement: "18750.00", net: "-9250.00" },
    ],
  },
];

export default function EcheancesStatesDemoPage() {
  // `state` alimente le rendu (initiales) ; `ref` (miroir synchrone) est lu par les
  // STUBS pour que `listerEcheances` — appelé par recharger() juste après une mutation —
  // renvoie la valeur à jour sans dépendre du timing de re-render (même pattern que la
  // démo Règles). Le ref n'est jamais lu pendant le render.
  const [echeances, setEcheances] = useState<EcheanceUI[]>(() =>
    ECHEANCES_DEMO.map((e) => ({ ...e })),
  );
  const echeancesRef = useRef<EcheanceUI[]>(echeances);

  function appliquer(maj: (prev: EcheanceUI[]) => EcheanceUI[]) {
    const suivant = maj(echeancesRef.current);
    echeancesRef.current = suivant;
    setEcheances(suivant);
  }

  const actions: ActionsEcheances = {
    listerEcheances: async () => ({
      echeances: echeancesRef.current.map((e) => ({ ...e })),
      synthese: SYNTHESE_DEMO,
    }),
    creerEcheance: async () => ({ ok: true, data: { echeanceId: "e-stub" } }),
    modifierEcheance: async (input) => {
      appliquer((prev) =>
        prev.map((e) =>
          e.id === input.echeanceId
            ? {
                ...e,
                direction: input.direction ?? e.direction,
                libelle: input.libelle ?? e.libelle,
                contrepartie: input.contrepartie ?? e.contrepartie,
                montant: input.montant ?? e.montant,
                devise: input.devise ?? e.devise,
                dateEcheance: input.dateEcheance ?? e.dateEcheance,
                categorieId:
                  input.categorieId !== undefined ? input.categorieId : e.categorieId,
                recurrence:
                  input.recurrence !== undefined ? input.recurrence : e.recurrence,
                entityId: input.entityId !== undefined ? input.entityId : e.entityId,
              }
            : e,
        ),
      );
      return { ok: true, data: undefined };
    },
    changerStatut: async (input) => {
      appliquer((prev) =>
        prev.map((e) =>
          e.id === input.echeanceId
            ? {
                ...e,
                statut: input.statut,
                statutAffiche: input.statut, // le stub abandonne le dérivé « en_retard »
                enRetard: false,
                montantRegle:
                  input.statut === "partiel" ? (input.montantRegle ?? null) : null,
              }
            : e,
        ),
      );
      return { ok: true, data: undefined };
    },
    supprimerEcheance: async (echeanceId) => {
      appliquer((prev) => prev.filter((e) => e.id !== echeanceId));
      return { ok: true, data: undefined };
    },
  };

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Échéances prévisionnelles
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Domaine Échéances — données fictives, actions inertes. Synthèse multi-devises,
        vue dirigée (encaisser / décaisser), statuts (dont « en retard » et « partiel »),
        formulaire création / édition.
      </div>

      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text">Échéances prévisionnelles</h1>
          <p className="mt-1 text-sm text-text-muted">
            Anticipez vos encaissements et décaissements à venir : suivez leur statut,
            leur montant et leur exigibilité, avec une synthèse par horizon.
          </p>
        </div>

        <EcheancesFeature
          initiales={{ echeances, synthese: SYNTHESE_DEMO }}
          categories={CATEGORIES_DEMO}
          entites={ENTITES_DEMO}
          actions={actions}
          peutGerer
        />
      </main>
    </div>
  );
}
