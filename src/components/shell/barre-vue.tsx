"use client";

/**
 * BarreVue — rendu CLIENT de la barre de vue, sous condition de la route courante
 * (TOOLBAR-GLOBALE-CADRAGE1, lot A2 ; plan `PLAN-toolbar-config.md`).
 *
 * Pourquoi un composant client : `AppTopbar` est un SERVER component (elle reçoit le
 * contexte déjà résolu par le layout), or la décision « quels contrôles sur cette
 * page » a besoin du pathname → `usePathname`, donc du client. La DÉCISION elle-même
 * ne vit PAS ici : elle est dans la fonction pure `toolbarConfig` (testée en CI). Ce
 * composant ne fait que MONTER ce qu'elle dit de monter.
 *
 * `PeriodeSwitcher` / `PerimetreSwitcher` sont déjà clients → import direct. Le
 * `BankCtaLink`, lui, reste un SERVER component : il est reçu en SLOT (`cta`) — un
 * composant client ne peut pas IMPORTER un composant serveur, mais il peut en RECEVOIR
 * un déjà rendu en prop. (Contrepartie assumée : quand `config.cta` est faux, ce
 * markup est sérialisé dans le payload RSC sans être rendu — quelques centaines
 * d'octets d'un <Link> sans donnée.)
 *
 * ⚠️ Aucune garde de SÉCURITÉ ici : masquer un contrôle ne restreint RIEN. Le périmètre
 * réel des données reste décidé par la RLS (règle 2), et le CTA reste gaté par le rôle
 * DANS `BankCtaLink` (+ re-gating serveur de /banques). En revanche masquer un contrôle
 * engage la CORRECTION de l'affichage : le `viewFilter` continue de MORDRE sur une page
 * dont on a retiré le sélecteur (cf. l'invariant en tête de `toolbar-config.ts` — c'est
 * lui qui décide où `perimetre: false` est légitime, pas ce composant).
 *
 * Pas de `flex-wrap` (règle UI : condenser, jamais wrapper le header). Tokens
 * sémantiques uniquement.
 */
import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { PerimetreSwitcher } from "@/components/shell/perimetre-switcher";
import { PeriodeSwitcher } from "@/components/shell/periode-switcher";
import { PlageDatesSwitcher } from "@/components/shell/plage-dates-switcher";
import { ReinitialiserPeriode } from "@/components/shell/reinitialiser-periode";
import { toolbarConfig } from "@/components/shell/toolbar-config";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";

/** Ancrage au scroll + fond opaque : partagé par la barre complète et la bande minimale. */
const BASE_HEADER =
  "sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface-card px-6";

export function BarreVue({
  comptes,
  entites,
  viewFilterActif,
  workspaceNom,
  cta,
  pathnameForce,
}: {
  /** Comptes visibles (scopés RLS) — alimentent le sélecteur de périmètre. */
  comptes: CompteConnecte[];
  /** Entités visibles (scopées RLS) — alimentent l'onglet « Par entité » (L8b-2). */
  entites: EntiteVisible[];
  /** viewFilter courant (ids) ; null = « Groupe ». Pour l'état actif du sélecteur. */
  viewFilterActif: string[] | null;
  /** Nom du workspace courant = le REPÈRE de la bande minimale. */
  workspaceNom: string;
  /** `BankCtaLink` déjà rendu côté serveur (slot — cf. en-tête). */
  cta: ReactNode;
  /**
   * Visual QA UNIQUEMENT (`/demo/shell`) : force la route évaluée, hors router réel —
   * la démo monte le vrai composant sur `/demo/shell`, qui n'est pas une page cadrée.
   * Jamais utilisé en production.
   */
  pathnameForce?: string;
}) {
  const pathnameReel = usePathname();
  const config = toolbarConfig(pathnameForce ?? pathnameReel);

  // Aucune barre (ex. /selection) : on ne rend PAS un <header> vide (il laisserait une
  // bande + bordure fantômes en haut de la colonne de contenu).
  if (
    !config.minimal &&
    !config.periode &&
    !config.plageDates &&
    !config.perimetre &&
    !config.cta
  ) {
    return null;
  }

  // Bande MINIMALE (aujourd'hui : /admin/* uniquement — seule surface dont la session est
  // amputée du viewFilter) : aucun contrôle, juste le repère de TENANT — le shell garde
  // son ancrage et on sait toujours dans quel espace on agit. Plus fine (h-12) que la
  // barre complète : moins de chrome là où il n'y a rien à régler.
  //
  // Le repère dit « Espace <workspace> » et NON « Groupe » : dans le vocabulaire du
  // projet, « Groupe » = « aucun filtre de périmètre » (layout.tsx, PerimetreSwitcher).
  // Une bande qui affirmerait « Groupe » alors qu'un viewFilter est actif dans le JWT
  // mentirait sur le périmètre. Le nom du workspace, lui, est TOUJOURS vrai : ce repère
  // ne prétend rien sur le filtre, il ancre le tenant.
  if (config.minimal) {
    return (
      <header className={`${BASE_HEADER} h-12`} aria-label="Contexte courant">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          Espace
        </span>
        <span
          className="min-w-0 truncate text-sm font-medium text-ink"
          title={workspaceNom}
        >
          {workspaceNom}
        </span>
      </header>
    );
  }

  return (
    <header className={`${BASE_HEADER} h-16`}>
      {/* PÉRIODE (L8c) : presets Ce mois / 3m / 6m / 12m / Tout, via `?periode`.
          Sous <Suspense> car useSearchParams force le bail-out CSR au prerender
          (recommandation Next 16) — fallback inerte aux mêmes dimensions pour éviter
          le saut de layout. */}
      {config.periode && (
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
      )}

      {/* PLAGE DE DATES PRÉCISE (A1) : `?du`/`?au`, en COMPLÉMENT des presets — elle PRIME
          sur eux (resoudrePeriode). Montée uniquement sur une page qui LIT réellement ces
          params (invariant anti-mensonge de `toolbar-config.ts` ; aujourd'hui : dashboard).
          Même <Suspense> que ci-dessus (useSearchParams → bail-out CSR au prerender). */}
      {config.plageDates && (
        <Suspense
          fallback={
            <div
              aria-hidden
              className="h-7 w-[280px] rounded-full bg-surface-inset"
            />
          }
        >
          <PlageDatesSwitcher />
        </Suspense>
      )}

      {/* RÉINITIALISER LA PÉRIODE (TX/DASH-PERIODE-PERSIST1) : ramène le groupe période
          ENTIER au défaut « 6 mois » (efface ?periode/?du/?au). Distinct du « × » du
          PlageDatesSwitcher (qui n'efface que la plage). Gaté `config.periode` (monté dès que
          le groupe période l'est) ; le composant se rend lui-même `null` tant qu'on est au
          défaut (pas de bouton leurre). Sous <Suspense> car useSearchParams — fallback `null`,
          c'est un contrôle secondaire (aucune dimension réservée à préserver). */}
      {config.periode && (
        <Suspense fallback={null}>
          <ReinitialiserPeriode />
        </Suspense>
      )}

      {/* PÉRIMÈTRE (L8b-1/2) : Groupe / comptes / entité. La `key` dérivée du périmètre
          actif force un remount propre quand le serveur change le viewFilter (après
          Appliquer + redirect) — la sélection locale repart alors sur la nouvelle
          vérité sans effet. */}
      {config.perimetre && (
        <PerimetreSwitcher
          key={viewFilterActif?.join(",") ?? "groupe"}
          comptes={comptes}
          entites={entites}
          viewFilterActif={viewFilterActif}
        />
      )}

      {/* CTA permanent vers /banques : seul accès à la connexion bancaire une fois les
          états vides disparus (cf. bank-cta.tsx). Gating de rôle À L'INTÉRIEUR du slot. */}
      {config.cta && <div className="ml-auto flex items-center gap-3">{cta}</div>}
    </header>
  );
}
