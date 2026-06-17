"use client";

/**
 * Filet d'erreur ULTIME (doc node_modules/next : global-error.js). Capture les
 * erreurs que rien d'autre n'attrape — notamment celles levées par le ROOT
 * layout ET par les layouts de groupe (ex. `(workspace)/layout.tsx`, où
 * `exigerSessionWorkspace` interroge la base) : un `error.tsx` de segment ne
 * couvre jamais SON propre layout. C'est ce boundary qui transforme une panne
 * d'infra dans le layout (workspace) — base injoignable — en écran propre plutôt
 * qu'en 500 brut + crash de sérialisation Next.
 *
 * Contrainte Next : global-error REMPLACE le root layout quand il est actif —
 * il DOIT donc fournir ses propres <html>/<body> et (re)charger les styles
 * globaux, car le root layout n'est pas monté ici.
 *
 * PII (règle 8) : jamais `error.message` brut — message générique + `digest`.
 * `metadata` non supporté dans un Client Component → on n'en exporte pas.
 */
import { useEffect } from "react";

import "./globals.css";
import { AppErrorState } from "@/components/ui/states";

export default function GlobalError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Next ≥ 16.2 : re-fetch + re-render. Fallback `reset` si absent. */
  unstable_retry?: () => void;
}) {
  useEffect(() => {
    console.error("Global render error", error.digest);
  }, [error]);

  return (
    <html lang="fr" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-surface-page">
        <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-6 py-8">
          <AppErrorState
            reference={error.digest}
            onRetry={unstable_retry ?? reset}
          />
        </main>
      </body>
    </html>
  );
}
