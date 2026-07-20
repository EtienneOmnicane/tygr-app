"use client";

/**
 * Error boundary du GROUPE (workspace) — filet pour tous les segments qui n'en ont pas
 * (banques, transactions, règles, échéances, graphiques, admin). Le dashboard garde le
 * sien, plus spécifique (`(dashboard)/error.tsx`) : Next choisit toujours la frontière la
 * plus proche.
 *
 * ⚠️ POURQUOI CE FICHIER EXISTE (constat de cross-review, 8/10) : il n'y en avait AUCUN
 * entre `/banques` et `global-error.tsx`. Or `global-error` REMPLACE le root layout — il
 * rend son propre `<html>/<body>` — donc la moindre exception non rattrapée sur l'écran
 * de connexion bancaire faisait disparaître le header, la navigation et tout le contexte,
 * pour un écran générique. Le docstring de `(dashboard)/error.tsx` affirmait d'ailleurs
 * que « admin/banques ont leur propre gestion » : c'était faux.
 *
 * Ça devient déterminant depuis qu'on a RETIRÉ les `catch` génériques de
 * `bank-connect-widget.tsx` : un rejet de transport ou une session expirée y remonte
 * désormais délibérément jusqu'à une frontière d'erreur, plutôt que de se déguiser en
 * « Réessayez dans un instant ». Encore faut-il que la frontière atteinte préserve
 * l'application autour — c'est le rôle de ce fichier. Sans lui, on aurait remplacé un
 * message trompeur par une sortie de route.
 *
 * `reset()` re-tente le rendu du segment : sur un échec transitoire (réseau, timeout),
 * l'utilisateur repart sans recharger ni reperdre sa navigation.
 *
 * PII (règle 8) : jamais `error.message` brut — il peut porter un libellé bancaire ou un
 * détail technique. Seul le `digest` (identifiant opaque de log Next) est affiché, pour
 * corréler avec les journaux serveur.
 */
import { useEffect } from "react";

import { AppErrorState } from "@/components/ui/states/app-error-state";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log client SANS PII — la stack complète est déjà capturée côté serveur.
    console.error("Workspace render error", error.digest);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <AppErrorState reference={error.digest} onRetry={reset} />
    </main>
  );
}
