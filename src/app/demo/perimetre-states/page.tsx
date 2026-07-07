/**
 * Démo / Visual QA (Quality Gate 4) du sélecteur de périmètre (L8b-1). NON
 * destinée à la production : isole le rendu du VRAI `PerimetreSwitcher` hors
 * auth/DB, sur un fond `bg-ink` reproduisant le header réel (pour juger les
 * tokens du déclencheur sur fond sombre).
 *
 * On monte le composant réel (pas une reconstitution) dans plusieurs états :
 *   - Groupe (défaut, 0 coché → libellé « Groupe »).
 *   - 1 banque cochée (libellé = nom du compte).
 *   - N banques cochées (libellé « N comptes »).
 * Le 4e cas (popover ouvert) et le 5e (non-débordement header) se capturent en
 * INTERACTION via le navigateur headless (clic sur le déclencheur) — cf. le
 * scénario Visual QA. Le rôle VIEWER se vérifie sur la démo header-cta (le
 * sélecteur n'est PAS gaté par rôle : confort de lecture pour tous).
 *
 * Le submit « Appliquer » est inerte ici (definirViewFilter exige une session
 * réelle) : la démo capture le RENDU des états, pas le canal serveur (couvert par
 * les tests + le vrai dashboard).
 */
import { PerimetreSwitcher } from "@/components/shell/perimetre-switcher";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";

export const metadata = { title: "Démo — Sélecteur de périmètre" };

// Titulaires (D6) : « Sucre SA » porte 2 comptes, le compte USD reste SANS
// titulaire → la listbox « Par compte » montre 2 sous-en-têtes (« Sucre SA »
// puis « Non regroupé » en dernier). Sémantique de sélection inchangée.
const COMPTES: CompteConnecte[] = [
  {
    bankAccountId: "11111111-1111-4111-8111-111111111111",
    accountName: "Compte courant",
    institutionName: "Absa",
    currency: "MUR",
    currentBalance: "1250000.00",
    lastSyncedAt: new Date(),
    holderId: "demo-party-sucre",
    holderName: "Sucre SA",
  },
  {
    bankAccountId: "22222222-2222-4222-8222-222222222222",
    accountName: "Compte USD",
    institutionName: "MCB",
    currency: "USD",
    currentBalance: "82000.00",
    lastSyncedAt: new Date(),
    holderId: null,
    holderName: null,
  },
  {
    bankAccountId: "33333333-3333-4333-8333-333333333333",
    accountName: "Épargne",
    institutionName: "SBM",
    currency: "MUR",
    currentBalance: "540000.00",
    lastSyncedAt: new Date(),
    holderId: "demo-party-sucre",
    holderName: "Sucre SA",
  },
];

// Entités mock pour l'onglet « Par entité » (L8b-2). « Sucre » groupe les deux
// comptes MUR ; « Énergie » le compte USD — pour juger le picker d'entités et le
// libellé re-dérivé (C5) sur fond réel.
const ENTITES: EntiteVisible[] = [
  {
    entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Sucre",
    nbComptes: 2,
    bankAccountIds: [COMPTES[0].bankAccountId, COMPTES[2].bankAccountId],
  },
  {
    entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Énergie",
    nbComptes: 1,
    bankAccountIds: [COMPTES[1].bankAccountId],
  },
];

const CAS: Array<{ titre: string; viewFilterActif: string[] | null }> = [
  { titre: "Groupe (défaut — 0 coché)", viewFilterActif: null },
  {
    titre: "1 banque (libellé = nom du compte)",
    viewFilterActif: [COMPTES[0].bankAccountId],
  },
  {
    titre: "N banques (libellé « N comptes »)",
    viewFilterActif: [COMPTES[0].bankAccountId, COMPTES[1].bankAccountId],
  },
];

export default function DemoPerimetreStates() {
  return (
    <div className="min-h-screen bg-surface-page">
      {CAS.map(({ titre, viewFilterActif }) => (
        <section key={titre} className="border-b border-line">
          <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {titre}
          </p>
          {/* Mini-header reproduisant le chrome réel (bg-ink h-16, zone ml-auto). */}
          <header className="flex h-16 items-center gap-6 bg-ink px-6 text-text-onink">
            <span className="text-lg font-bold tracking-tight">
              TYGR<span className="text-accent">.</span>
            </span>
            <div className="ml-auto flex items-center gap-3">
              <PerimetreSwitcher
                comptes={COMPTES}
                entites={ENTITES}
                viewFilterActif={viewFilterActif}
              />
              <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
                Omnicane HQ · ADMIN
              </span>
            </div>
          </header>
        </section>
      ))}
    </div>
  );
}
