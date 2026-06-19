/**
 * CTA permanent « Connecter une banque » du header (UI_GUIDELINES §1.2/§2.3).
 *
 * Pourquoi il existe : la page /banques n'était atteignable que via les CTA
 * contextuels des ÉTATS VIDES (dashboard/graphiques/échéances/transactions). Une
 * fois une première banque connectée, ces états vides disparaissent → un FM ne
 * pouvait plus accéder à /banques pour ajouter un 2ᵉ compte (il fallait taper
 * l'URL). Ce lien d'action permanent dans le header lève ce point dur.
 *
 * Server component présentationnel : aucune donnée, aucun fetch. Le `role` lui est
 * fourni par `AppHeader` (déjà résolu par le layout via withWorkspace). La frontière
 * d'autorité réelle reste serveur (la page /banques re-gate `peutModifier`) ; ce
 * composant ne fait que TRADUIRE le rôle en capacité UI (cf. lib/permissions).
 *
 * Gating (convention permissions.ts) : « action de modification » →
 *   - MANAGER/ADMIN : lien actif vers /banques.
 *   - VIEWER : rendu DÉSACTIVÉ + tooltip (pas caché — seules les surfaces ADMIN se
 *     cachent du DOM ; une action de modif reste visible mais inerte, §gating D2).
 *
 * Palette `onink` (texte clair sur header `ink`), alignée sur les liens « Membres »
 * et « Se déconnecter » du header — PAS `text-primary` (bleu illisible sur ink).
 * L'icône « + » suit le pattern « Lien d'action » du §2.3 (« + Ajouter une facture »).
 */
import Link from "next/link";

import { peutModifier } from "@/lib/permissions";
import type { WorkspaceRole } from "@/server/db/schema";

/** Glyphe « + » décoratif partagé (le label porte déjà le sens accessible). */
function IconePlus() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

const LABEL = "Connecter une banque";

export function BankCtaLink({ role }: { role: WorkspaceRole }) {
  // VIEWER : visible mais inerte (span aria-disabled + tooltip), même pattern que
  // le `placeholder` de app-nav.tsx — jamais un <Link> mort.
  if (!peutModifier(role)) {
    return (
      <span
        aria-disabled
        title="Votre rôle (lecture seule) ne permet pas de connecter une banque."
        className="inline-flex cursor-default items-center gap-1.5 text-sm
          font-medium text-text-onink/40"
      >
        <IconePlus />
        {LABEL}
      </span>
    );
  }

  return (
    <Link
      href="/banques"
      className="inline-flex items-center gap-1.5 text-sm font-medium
        text-text-onink/64 transition-colors hover:text-text-onink
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <IconePlus />
      {LABEL}
    </Link>
  );
}
