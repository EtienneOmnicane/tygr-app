"use client";

/**
 * Démo / Visual QA (Gate 4) de la carte « Comptes connectés » avec PROVENANCE
 * bancaire, refonte 2 lignes (DR-F2, Lot 4). NON destinée à la production : isole le
 * rendu de `ConnectedAccountsCard` hors auth/DB, données 100 % fictives.
 *
 * La carte affiche désormais la banque en LABEL au-dessus, le nom de compte dessous
 * (2 lignes, chacune tronquée indépendamment). Cas couverts (contrainte 300px = la
 * largeur réelle du side-panel) :
 *   1. Banque connue + nom de compte distinct → label « Absa » / « Compte courant ».
 *   2. Banque ABSENTE (null) → pas de label, nom de compte seul (dégradation propre).
 *   3. Nom de compte reprenant déjà la banque → pas de label doublon « MCB » sur « MCB — … ».
 *   4. NOMS TRÈS LONGS (banque + compte) → la refonte 2 lignes doit empêcher toute
 *      troncature disgracieuse : chaque ligne tronque seule, le montant reste intact.
 */
import type { CompteConnecte } from "@/server/repositories/dashboard";

import { ConnectedAccountsCard } from "@/components/dashboard/connected-accounts-card";

type CompteAffiche = CompteConnecte;

const CAS: Array<{ titre: string; comptes: CompteAffiche[] }> = [
  {
    titre: "1. Provenance connue (institutionName fourni) — cible #2",
    comptes: [
      {
        bankAccountId: "d1",
        institutionName: "Absa",
        accountName: "Compte courant",
        currency: "MUR",
        currentBalance: "5230000.00",
        lastSyncedAt: new Date("2026-06-18T08:00:00Z"),
      },
      {
        bankAccountId: "d2",
        institutionName: "MCB",
        accountName: "Compte opérations USD",
        currency: "USD",
        currentBalance: "84200.00",
        lastSyncedAt: new Date("2026-06-18T07:00:00Z"),
      },
    ],
  },
  {
    titre: "2. Provenance ABSENTE (contrat actuel) — dégradation propre",
    comptes: [
      {
        bankAccountId: "d3",
        institutionName: null, // cas « provenance absente » — dégradation propre
        accountName: "Compte courant",
        currency: "MUR",
        currentBalance: "1200000.00",
        lastSyncedAt: new Date("2026-06-18T06:00:00Z"),
      },
    ],
  },
  {
    titre: "3. Nom reprenant déjà la banque (legacy) — pas de doublon",
    comptes: [
      {
        bankAccountId: "d4",
        institutionName: "MCB",
        accountName: "MCB — Compte courant business",
        currency: "MUR",
        currentBalance: "2461000.00",
        lastSyncedAt: new Date("2026-06-18T05:00:00Z"),
      },
    ],
  },
  {
    titre: "4. Noms TRÈS longs — 2 lignes, zéro troncature disgracieuse (DR-F2)",
    comptes: [
      {
        bankAccountId: "d5",
        institutionName: "The Mauritius Commercial Bank Limited",
        accountName: "Compte courant opérations groupe Ebène Cybercity",
        currency: "MUR",
        currentBalance: "999999999.00",
        lastSyncedAt: new Date("2026-06-18T04:00:00Z"),
      },
      {
        bankAccountId: "d6",
        institutionName: "State Bank of Mauritius (International)",
        accountName: "Compte devises USD — filiale import/export",
        currency: "USD",
        currentBalance: "1284350.00",
        lastSyncedAt: new Date("2026-06-18T03:00:00Z"),
      },
    ],
  },
];

export default function DemoComptesProvenance() {
  return (
    <div className="min-h-screen bg-surface-page px-6 py-8">
      <p className="mb-6 text-sm text-text-muted">
        Démo · Visual QA — carte « Comptes connectés » avec provenance bancaire
        (données fictives).
      </p>
      <div className="grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-3">
        {CAS.map((cas) => (
          <div key={cas.titre} className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-muted">{cas.titre}</span>
            {/* Side-panel réel = 300px : on contraint la largeur pour refléter le rendu. */}
            <div className="w-[300px]">
              <ConnectedAccountsCard comptes={cas.comptes} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
