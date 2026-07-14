/**
 * Démo / Visual QA (Quality Gate 4) de la BARRE DE VUE (topbar) Dodo. NON destinée à
 * la production : isole le rendu du VRAI `AppTopbar` hors auth/DB (le vrai shell
 * `(workspace)/layout.tsx` dépend de withWorkspace).
 *
 * DEUX blocs, correspondant aux deux choses à valider par vision :
 *
 * 1. MATRICE PAR PAGE (lot A2, TOOLBAR-GLOBALE-CADRAGE1) — une section par route
 *    cadrée : on vérifie que chaque page ne monte QUE les contrôles qui la concernent
 *    (période / périmètre / CTA), que les pages de configuration tombent sur la bande
 *    MINIMALE (repère seul) et que /selection ne rend AUCUNE barre.
 *    `pathnameForce` existe pour ça : sur cette route de démo, `usePathname` vaudrait
 *    `/demo/shell` (page non cadrée → défaut minimal) et on ne verrait rien.
 *
 * 2. GATING DU CTA par rôle (inchangé) — sur la route dashboard, où le CTA est monté :
 *    ADMIN / MANAGER → CTA actif (bouton ink) ; VIEWER → CTA désactivé (inerte + tooltip).
 */
import { AppTopbar } from "@/components/shell/app-topbar";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
import type { WorkspaceRole } from "@/server/db/schema";

export const metadata = { title: "Démo — Barre de vue" };

const WORKSPACE_NOM = "Omnicane";

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

/** La matrice validée (Etienne, 2026-07-14) — l'attendu est écrit, la vision tranche. */
const PAGES: Array<{ pathname: string; titre: string; attendu: string }> = [
  {
    pathname: "/",
    titre: "Dashboard  (/)",
    attendu: "période + périmètre + CTA",
  },
  {
    pathname: "/transactions",
    titre: "Transactions  (/transactions)",
    attendu: "période + périmètre + CTA",
  },
  {
    pathname: "/graphiques",
    titre: "Graphiques  (/graphiques)",
    attendu: "période + périmètre — PAS de CTA",
  },
  {
    pathname: "/echeances",
    titre: "Échéances  (/echeances)",
    attendu: "périmètre seul — PAS de période (horizon futur : chantier séparé)",
  },
  {
    pathname: "/banques",
    titre: "Banques  (/banques)",
    attendu:
      "CTA + périmètre CONSERVÉ (le viewFilter mord encore ici) — pas de période",
  },
  {
    pathname: "/regles",
    titre: "Règles  (/regles)",
    attendu:
      "périmètre CONSERVÉ (« Ré-analyser » suit le filtre) — ni période ni CTA",
  },
  {
    pathname: "/admin/membres",
    titre: "Membres  (/admin/membres)",
    attendu: "bande MINIMALE (repère de tenant seul — session amputée du filtre)",
  },
  {
    pathname: "/admin/entites",
    titre: "Entités  (/admin/entites)",
    attendu: "bande MINIMALE (repère de tenant seul)",
  },
  {
    pathname: "/selection",
    titre: "Sélection  (/selection)",
    attendu: "AUCUNE barre (rien ne doit s'afficher sous ce titre)",
  },
  {
    pathname: "/page-non-cadree",
    titre: "Page non cadrée (défaut)",
    attendu:
      "périmètre seul — défaut fail-safe : la trappe de sortie du filtre reste là",
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

function Etiquette({ titre, attendu }: { titre: string; attendu: string }) {
  return (
    <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
      {titre} — <span className="font-normal normal-case">{attendu}</span>
    </p>
  );
}

export default function DemoShellTopbar() {
  return (
    <div className="min-h-screen bg-surface-page">
      <h1 className="px-6 py-4 text-sm font-semibold text-ink">
        1. Barre de vue par page (matrice A2)
      </h1>
      {PAGES.map(({ pathname, titre, attendu }) => (
        <section key={pathname} className="border-b border-line">
          <Etiquette titre={titre} attendu={attendu} />
          <AppTopbar
            role="ADMIN"
            comptes={COMPTES_FICTIFS}
            entites={ENTITES_FICTIVES}
            viewFilterActif={null}
            workspaceNom={WORKSPACE_NOM}
            pathnameForce={pathname}
          />
        </section>
      ))}

      <h1 className="px-6 py-4 text-sm font-semibold text-ink">
        2. Gating du CTA par rôle (route dashboard)
      </h1>
      {ROLES.map(({ role, titre, attendu }) => (
        <section key={role} className="border-b border-line">
          <Etiquette titre={`Rôle : ${titre}`} attendu={attendu} />
          <AppTopbar
            role={role}
            comptes={COMPTES_FICTIFS}
            entites={ENTITES_FICTIVES}
            viewFilterActif={null}
            workspaceNom={WORKSPACE_NOM}
            pathnameForce="/"
          />
        </section>
      ))}
    </div>
  );
}
