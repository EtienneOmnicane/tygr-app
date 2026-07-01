/**
 * Démo / Visual QA (Quality Gate 4) du header applicatif avec le CTA permanent
 * « Connecter une banque » (cf. components/shell/bank-cta.tsx). NON destinée à la
 * production : isole le rendu du VRAI `AppHeader` hors auth/DB, le vrai shell
 * `(workspace)/layout.tsx` dépendant de withWorkspace.
 *
 * On monte le composant réel (pas une reconstitution en dur) avec des props
 * fictives, pour les TROIS rôles — afin de vérifier par vision le gating :
 *   - ADMIN   : CTA actif + lien « Membres » (surface admin visible).
 *   - MANAGER : CTA actif, PAS de « Membres » (surface admin cachée du DOM).
 *   - VIEWER  : CTA DÉSACTIVÉ (inerte + tooltip), PAS de « Membres ».
 *
 * Server component (le vrai AppHeader importe une Server Action de déconnexion) :
 * on fournit une Server Action factice locale. Aucune donnée réelle.
 */
import { AppHeader } from "@/components/shell/app-header";
import type { MembershipAvecNom } from "@/server/repositories/identite";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
import type { WorkspaceRole } from "@/server/db/schema";

export const metadata = { title: "Démo — Header CTA banque" };

async function deconnecterFactice() {
  "use server";
  // Inerte : démo hors production, aucune session à clore.
}

const MEMBERSHIPS_FICTIFS: MembershipAvecNom[] = [
  { workspaceId: "ws-demo-1", nom: "Omnicane HQ", role: "ADMIN", kind: "PROD" },
  { workspaceId: "ws-demo-2", nom: "Sucrière BU", role: "MANAGER", kind: "PROD" },
];

/** Comptes fictifs pour alimenter le sélecteur de périmètre (L8b-1) en démo. */
const COMPTES_FICTIFS: CompteConnecte[] = [
  {
    bankAccountId: "acc-demo-1",
    accountName: "Compte courant MUR",
    institutionName: "Absa",
    currency: "MUR",
    currentBalance: "1250000.00",
    lastSyncedAt: new Date(),
  },
  {
    bankAccountId: "acc-demo-2",
    accountName: "Compte USD",
    institutionName: "MCB",
    currency: "USD",
    currentBalance: "82000.00",
    lastSyncedAt: new Date(),
  },
];

/** Entités fictives pour alimenter l'onglet « Par entité » (L8b-2) en démo. */
const ENTITES_FICTIVES: EntiteVisible[] = [
  {
    entityId: "ent-demo-1",
    name: "Sucre",
    nbComptes: 1,
    bankAccountIds: ["acc-demo-1"],
  },
  {
    entityId: "ent-demo-2",
    name: "Énergie",
    nbComptes: 1,
    bankAccountIds: ["acc-demo-2"],
  },
];

const ROLES: Array<{ role: WorkspaceRole; titre: string; attendu: string }> = [
  {
    role: "ADMIN",
    titre: "ADMIN",
    attendu: "CTA actif · lien « Membres » visible",
  },
  {
    role: "MANAGER",
    titre: "MANAGER",
    attendu: "CTA actif · « Membres » caché",
  },
  {
    role: "VIEWER",
    titre: "VIEWER (lecture seule)",
    attendu: "CTA désactivé (tooltip) · « Membres » caché",
  },
];

export default function DemoHeaderCta() {
  return (
    <div className="min-h-screen bg-surface-page">
      {ROLES.map(({ role, titre, attendu }) => (
        <section key={role} className="border-b border-line">
          <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Rôle&nbsp;: {titre} — <span className="font-normal normal-case">{attendu}</span>
          </p>
          <AppHeader
            workspaceId="ws-demo-1"
            workspaceNom="Omnicane HQ"
            role={role}
            memberships={MEMBERSHIPS_FICTIFS}
            comptes={COMPTES_FICTIFS}
            entites={ENTITES_FICTIVES}
            viewFilterActif={null}
            onDeconnexion={deconnecterFactice}
          />
        </section>
      ))}
    </div>
  );
}
