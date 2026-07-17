"use client";

/**
 * Formulaire de changement de mot de passe (AUTH-MDP-TEMPO1 D5) — calqué sur
 * `login/formulaire-connexion.tsx` : LOADING = bouton spinner + champs gelés ;
 * ERROR = message `role="alert"`. Tokens UI_GUIDELINES §2.3, copie EN (Q-LANG).
 *
 * Composant PUR côté logique : l'action est INJECTÉE en prop (la page passe la
 * Server Action réelle ; la démo /demo/account-password-states passe des stubs
 * et des états initiaux pré-remplis — aucun fetch ni état serveur ici).
 */
import { useActionState } from "react";

import type { EtatChangement } from "./validation";

const ETAT_INITIAL: EtatChangement = { erreur: null };

const CLASSE_INPUT = `h-10 rounded-control border border-line bg-white px-3 text-sm
  placeholder:text-text-faint focus:outline-none focus:border-primary
  focus:ring-2 focus:ring-primary/30 disabled:opacity-48`;

export function FormulaireMotDePasse({
  action,
  etatInitial = ETAT_INITIAL,
}: {
  action: (
    etat: EtatChangement,
    formData: FormData,
  ) => Promise<EtatChangement>;
  /** Pré-seed pour la démo Visual QA uniquement (états d'erreur figés). */
  etatInitial?: EtatChangement;
}) {
  const [etat, soumettre, enCours] = useActionState(action, etatInitial);

  return (
    <form action={soumettre} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Current password</span>
        <input
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          maxLength={200}
          disabled={enCours}
          className={CLASSE_INPUT}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">New password</span>
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          maxLength={200}
          disabled={enCours}
          className={CLASSE_INPUT}
        />
        <span className="text-xs text-text-muted">At least 12 characters.</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Confirm new password</span>
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          maxLength={200}
          disabled={enCours}
          className={CLASSE_INPUT}
        />
      </label>

      {etat.erreur !== null && (
        // Erreur ≠ sortie (UI_GUIDELINES §3.4, plan §7) : fond danger-bg +
        // icône + message — jamais un rouge nu (réservé aux montants outflow).
        <div
          role="alert"
          className="flex items-start gap-2 rounded-control bg-danger-bg p-3"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            fill="none"
            className="mt-0.5 size-4 shrink-0 text-danger"
          >
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10 6.5v4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="10" cy="13.75" r="0.9" fill="currentColor" />
          </svg>
          <p className="text-xs text-danger">{etat.erreur}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={enCours}
        className="mt-2 flex h-10 items-center justify-center gap-2 rounded-control
          bg-ink text-sm font-semibold text-text-onink transition-colors
          hover:bg-ink-700 focus:outline-none focus:ring-2 focus:ring-primary
          focus:ring-offset-2 disabled:opacity-48"
      >
        {enCours && (
          <span
            aria-hidden
            className="size-4 animate-spin rounded-full border-2 border-white/40
              border-t-white"
          />
        )}
        {enCours ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
