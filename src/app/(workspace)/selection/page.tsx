/**
 * Sélecteur de workspace (Epic 2 L1) — états D2.
 *
 * - SKIP AUTO : 0 workspace → écran « aucun workspace » ; 1 seul → redirect
 *   accueil (pas d'écran de choix superflu, plan D2).
 * - La liste vient EXCLUSIVEMENT de membershipsAvecNom (sous RLS, S2) — jamais
 *   d'un paramètre client : pas d'énumération de workspaces d'autrui.
 *
 * Le skeleton (état loading D2) est porté par loading.tsx (Suspense RSC).
 */
import { redirect } from "next/navigation";

import { auth } from "@/server/auth/config";
import { identite } from "@/server/db";

import { ListeWorkspaces } from "./liste-workspaces";

export const metadata = { title: "Choisir un workspace — Dodo" };

export default async function PageSelection() {
  const session = await auth();
  if (!session?.userId) {
    redirect("/login");
  }

  const memberships = await identite.membershipsAvecNom(session.userId);

  // SKIP AUTO (D2) : un seul workspace → on bascule droit vers l'accueil.
  if (memberships.length === 1) {
    redirect("/");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-card bg-surface-card p-8 shadow-card">
        <h1 className="text-lg font-semibold">
          Dodo<span className="text-accent">.</span>
        </h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Choisissez l&apos;espace de trésorerie à consulter.
        </p>

        {memberships.length === 0 ? (
          // ÉTAT VIDE (D2) : aucun workspace rattaché.
          <div className="rounded-control bg-surface-inset p-6 text-center">
            <p className="text-sm text-text-muted">
              Aucun workspace n&apos;est rattaché à votre compte. Contactez
              votre administrateur pour obtenir un accès.
            </p>
          </div>
        ) : (
          <ListeWorkspaces memberships={memberships} />
        )}
      </div>
    </main>
  );
}
