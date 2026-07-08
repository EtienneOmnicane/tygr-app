/**
 * Page « Banques » (Epic 3, PR-W4) — point d'accueil de la connexion bancaire via
 * le WIDGET NATIF Omni-FI. RSC : résout la chaîne auth + le rôle (gating
 * MANAGER/ADMIN) et monte le conteneur client `BankConnectWidget`.
 *
 * Le chrome (header/nav) vient de `(workspace)/layout.tsx`. Cette page ne rend que
 * son contenu. Le câblage final du widget natif (échange LinkToken) est porté par
 * les Server Actions de `banques/actions.ts` + la PR de l'Agent Backend.
 *
 * Mapping erreurs (règle 3) : non authentifié → /login ; aucun workspace →
 * /selection. Identique au reste du groupe (chaque RSC re-valide).
 */
import { redirect } from "next/navigation";

import { peutModifier } from "@/lib/permissions";
import { listerConnexionsBancaires, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";

import { ConnexionsBancaires } from "@/components/banques/connexions-bancaires";
import { BankConnectWidget } from "@/components/widget/bank-connect-widget";

export const metadata = { title: "Connecter une banque — Dodo" };

export default async function PageBanques() {
  let session;
  try {
    session = await exigerSessionWorkspace();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) {
      redirect("/login");
    }
    if (erreur instanceof AucunWorkspaceActifError) {
      redirect("/selection");
    }
    throw erreur;
  }

  // Rôle (gating MANAGER/ADMIN) + connexions déjà reliées, dans le MÊME contexte
  // RLS (une seule transaction scopée workspace, règle 2).
  const { role, connexions } = await withWorkspace(session, async (tx, ctx) => ({
    role: ctx.role,
    connexions: await listerConnexionsBancaires(tx),
  }));
  const peutConnecter = peutModifier(role);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-text">Banques connectées</h1>
        <p className="mt-1 text-sm text-text-muted">
          Connectez un compte bancaire via Omni-FI pour alimenter votre
          trésorerie. La connexion s’effectue dans l’interface sécurisée de la
          banque.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <ConnexionsBancaires connexions={connexions} />

        <div className="rounded-card bg-surface-card p-6 shadow-card">
          <BankConnectWidget peutConnecter={peutConnecter} />
        </div>
      </div>
    </main>
  );
}
