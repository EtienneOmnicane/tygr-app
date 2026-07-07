/**
 * Démo / Visual QA (Quality Gate 4) de la topbar de périmètre Dodo avec le CTA
 * permanent « Connecter une banque » (cf. components/shell/bank-cta.tsx). NON
 * destinée à la production : isole le rendu du VRAI `AppTopbar` hors auth/DB (le
 * vrai shell `(workspace)/layout.tsx` dépend de withWorkspace).
 *
 * On monte le composant réel (pas une reconstitution en dur) avec des props
 * fictives, pour les TROIS rôles — afin de vérifier par vision le gating du CTA :
 *   - ADMIN   : CTA actif (bouton ink).
 *   - MANAGER : CTA actif (bouton ink).
 *   - VIEWER  : CTA DÉSACTIVÉ (inerte + tooltip).
 * (Le gating des liens admin « Membres / Entités » vit désormais dans la sidebar
 *  `AppSidebar`, capturé dans le QA du shell réel.)
 */
import { AppTopbar } from "@/components/shell/app-topbar";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
import type { WorkspaceRole } from "@/server/db/schema";

export const metadata = { title: "Démo — Topbar périmètre" };

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
  { role: "ADMIN", titre: "ADMIN", attendu: "CTA actif (bouton ink)" },
  { role: "MANAGER", titre: "MANAGER", attendu: "CTA actif (bouton ink)" },
  {
    role: "VIEWER",
    titre: "VIEWER (lecture seule)",
    attendu: "CTA désactivé (tooltip)",
  },
];

export default function DemoShellTopbar() {
  return (
    <div className="min-h-screen bg-surface-page">
      {ROLES.map(({ role, titre, attendu }) => (
        <section key={role} className="border-b border-line">
          <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Rôle&nbsp;: {titre} —{" "}
            <span className="font-normal normal-case">{attendu}</span>
          </p>
          <AppTopbar
            role={role}
            comptes={COMPTES_FICTIFS}
            entites={ENTITES_FICTIVES}
            viewFilterActif={null}
          />
        </section>
      ))}
    </div>
  );
}
