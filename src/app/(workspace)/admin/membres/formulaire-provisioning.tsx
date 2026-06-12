"use client";

/**
 * Formulaire de provisioning ADMIN (Epic 2 L3). États : erreur (champs/refus,
 * message générique) et succès (toast inline). Tokens UI_GUIDELINES §2.3.
 */
import { useActionState } from "react";

import {
  provisionnerMembre,
  type EtatProvisioning,
} from "./actions";

const ETAT_INITIAL: EtatProvisioning = { erreur: null, succes: null };

const champClass =
  "h-10 rounded-control border border-line bg-white px-3 text-sm " +
  "placeholder:text-text-faint focus:outline-none focus:border-primary " +
  "focus:ring-2 focus:ring-primary/30 disabled:opacity-48";

export function FormulaireProvisioning() {
  const [etat, action, enCours] = useActionState(
    provisionnerMembre,
    ETAT_INITIAL,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Nom complet</span>
        <input name="fullName" required maxLength={120} disabled={enCours} className={champClass} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Email</span>
        <input
          name="email"
          type="email"
          required
          maxLength={254}
          disabled={enCours}
          className={champClass}
          placeholder="membre@entreprise.mu"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Mot de passe initial</span>
        <input
          name="motDePasse"
          type="password"
          required
          minLength={12}
          maxLength={200}
          disabled={enCours}
          className={champClass}
          placeholder="12 caractères minimum"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Rôle</span>
        <select name="role" defaultValue="VIEWER" disabled={enCours} className={champClass}>
          <option value="VIEWER">Lecteur (lecture seule)</option>
          <option value="MANAGER">Gestionnaire</option>
          <option value="ADMIN">Administrateur</option>
        </select>
      </label>

      {etat.erreur !== null && (
        <p role="alert" className="text-xs text-danger">
          {etat.erreur}
        </p>
      )}
      {etat.succes !== null && (
        <p role="status" className="text-xs text-success">
          {etat.succes}
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
            className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        )}
        {enCours ? "Création…" : "Créer et rattacher"}
      </button>
    </form>
  );
}
