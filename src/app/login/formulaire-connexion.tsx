"use client";

/**
 * Formulaire de connexion — états D2 (matrice écrans × états du plan) :
 * LOADING = bouton spinner + champs gelés ; ERROR = message générique unique
 * (non-énumération E18, supersédé par #59 : pas de compte à rebours lockout).
 * Styles : tokens UI_GUIDELINES §2.3 (inputs bordure line, focus ring primary,
 * erreur 12px danger sous le champ, bouton primaire h-10).
 */
import { useActionState } from "react";

import { connecter, type EtatConnexion } from "./actions";

const ETAT_INITIAL: EtatConnexion = { erreur: null };

export function FormulaireConnexion() {
  const [etat, action, enCours] = useActionState(connecter, ETAT_INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          disabled={enCours}
          className="h-10 rounded-control border border-line bg-white px-3 text-sm
            placeholder:text-text-faint focus:outline-none focus:border-primary
            focus:ring-2 focus:ring-primary/30 disabled:opacity-48"
          placeholder="vous@entreprise.mu"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Mot de passe</span>
        <input
          name="motDePasse"
          type="password"
          autoComplete="current-password"
          required
          maxLength={200}
          disabled={enCours}
          className="h-10 rounded-control border border-line bg-white px-3 text-sm
            placeholder:text-text-faint focus:outline-none focus:border-primary
            focus:ring-2 focus:ring-primary/30 disabled:opacity-48"
        />
      </label>

      {etat.erreur !== null && (
        <p role="alert" className="text-xs text-danger">
          {etat.erreur}
        </p>
      )}

      <button
        type="submit"
        disabled={enCours}
        className="mt-2 flex h-10 items-center justify-center gap-2 rounded-control
          bg-primary text-sm font-semibold text-white transition-colors
          hover:bg-primary-600 focus:outline-none focus:ring-2 focus:ring-primary
          focus:ring-offset-2 disabled:opacity-48"
      >
        {enCours && (
          <span
            aria-hidden
            className="size-4 animate-spin rounded-full border-2 border-white/40
              border-t-white"
          />
        )}
        {enCours ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}
