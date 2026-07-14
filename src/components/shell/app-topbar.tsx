/**
 * Barre de périmètre (topbar) de la colonne de contenu (UI_GUIDELINES §1.2,
 * refonte Dodo). Server component : reçoit le contexte déjà résolu par le layout
 * et le distribue aux sélecteurs (jamais de fetch ici).
 *
 * Ce qui vivait à droite de l'ancien header `bg-ink` (période, périmètre, CTA
 * banque) descend ici, sur `surface-card`, au-dessus du contenu de chaque page.
 * Le WorkspaceSwitcher + les liens admin migrent, eux, dans `AppSidebar`.
 *
 * DEPUIS LE LOT A2 (TOOLBAR-GLOBALE-CADRAGE1) : les contrôles ne sont plus montés
 * inconditionnellement. Le layout monte cette barre GLOBALEMENT, mais chaque page
 * n'affiche que les contrôles qui ONT un effet sur elle (matrice `toolbar-config.ts`).
 * Comme la décision dépend du pathname (client-only), cette coquille SERVEUR se
 * contente de résoudre ce qui est serveur et de le passer à `BarreVue` (client) :
 *   - les données scopées RLS (comptes, entités, viewFilter, nom du workspace) ;
 *   - le `BankCtaLink` déjà RENDU, passé en slot `cta` — il reste ainsi un server
 *     component (un composant client ne peut pas en importer un, mais peut en
 *     recevoir un rendu en prop).
 */
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
import type { WorkspaceRole } from "@/server/db/schema";

import { BarreVue } from "@/components/shell/barre-vue";
import { BankCtaLink } from "@/components/shell/bank-cta";

export function AppTopbar({
  role,
  comptes,
  entites,
  viewFilterActif,
  workspaceNom,
  pathnameForce,
}: {
  role: WorkspaceRole;
  /** Comptes visibles (scopés RLS) — alimentent le sélecteur de périmètre. */
  comptes: CompteConnecte[];
  /** Entités visibles (scopées RLS) — alimentent l'onglet « Par entité » (L8b-2). */
  entites: EntiteVisible[];
  /** viewFilter courant (ids) ; null = « Groupe ». Pour l'état actif du sélecteur. */
  viewFilterActif: string[] | null;
  /** Nom du workspace courant — repère de contexte de la bande minimale. */
  workspaceNom: string;
  /** Visual QA uniquement (`/demo/shell`) : force la route évaluée. Jamais en prod. */
  pathnameForce?: string;
}) {
  return (
    <BarreVue
      comptes={comptes}
      entites={entites}
      viewFilterActif={viewFilterActif}
      workspaceNom={workspaceNom}
      cta={<BankCtaLink role={role} />}
      pathnameForce={pathnameForce}
    />
  );
}
