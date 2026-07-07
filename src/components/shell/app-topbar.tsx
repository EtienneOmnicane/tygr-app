/**
 * Barre de périmètre (topbar) de la colonne de contenu (UI_GUIDELINES §1.2,
 * refonte Dodo). Server component : reçoit le contexte déjà résolu par le layout
 * et le distribue aux sélecteurs (jamais de fetch ici).
 *
 * Ce qui vivait à droite de l'ancien header `bg-ink` (période, périmètre, CTA
 * banque) descend ici, sur `surface-card`, au-dessus du contenu de chaque page.
 * Le WorkspaceSwitcher + les liens admin migrent, eux, dans `AppSidebar`.
 *
 * ANCRAGE AU SCROLL (demande Etienne) : la barre est `sticky top-0` avec un
 * `z-30` — elle reste collée en haut de la colonne de contenu quand le dashboard
 * défile (période/périmètre/CTA toujours atteignables). Fond `surface-card` opaque
 * (jamais translucide) pour que le contenu qui passe dessous ne transparaisse pas.
 *
 * Pas de `flex-wrap` (règle UI CLAUDE.md : condenser, jamais wrapper le header).
 */
import { Suspense } from "react";

import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";
import type { WorkspaceRole } from "@/server/db/schema";

import { PerimetreSwitcher } from "@/components/shell/perimetre-switcher";
import { PeriodeSwitcher } from "@/components/shell/periode-switcher";
import { BankCtaLink } from "@/components/shell/bank-cta";

export function AppTopbar({
  role,
  comptes,
  entites,
  viewFilterActif,
}: {
  role: WorkspaceRole;
  /** Comptes visibles (scopés RLS) — alimentent le sélecteur de périmètre. */
  comptes: CompteConnecte[];
  /** Entités visibles (scopées RLS) — alimentent l'onglet « Par entité » (L8b-2). */
  entites: EntiteVisible[];
  /** viewFilter courant (ids) ; null = « Groupe ». Pour l'état actif du sélecteur. */
  viewFilterActif: string[] | null;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface-card px-6">
      {/* Sélecteur de PÉRIODE (L8c) : presets Ce mois / 3m / 6m / 12m / Tout. Lit/écrit
          `?periode` (filtre de lecture, hors RLS) côté client. Sous <Suspense> car
          useSearchParams force le bail-out CSR au prerender (recommandation Next 16) —
          fallback inerte aux mêmes dimensions pour éviter le saut de layout. */}
      <Suspense
        fallback={
          <div
            aria-hidden
            className="h-7 w-[260px] rounded-full bg-surface-inset"
          />
        }
      >
        <PeriodeSwitcher />
      </Suspense>
      {/* Sélecteur de périmètre d'affichage (L8b-1) : Groupe / banque(s). La
          `key` dérivée du périmètre actif force un remount propre quand le
          serveur change le viewFilter (après Appliquer + redirect) — la
          sélection locale repart alors sur la nouvelle vérité sans effet. */}
      <PerimetreSwitcher
        key={viewFilterActif?.join(",") ?? "groupe"}
        comptes={comptes}
        entites={entites}
        viewFilterActif={viewFilterActif}
      />
      {/* CTA permanent vers /banques : seul accès à la connexion bancaire une
          fois les états vides disparus (cf. bank-cta.tsx). Gating role à l'intérieur. */}
      <div className="ml-auto flex items-center gap-3">
        <BankCtaLink role={role} />
      </div>
    </header>
  );
}
