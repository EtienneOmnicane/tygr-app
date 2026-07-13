"use client";

/**
 * Formulaire de provisioning ADMIN (Epic 2 L3 + assignation d'entités à la création).
 * États : erreur (champs/refus, message générique) et succès (toast inline). Le
 * périmètre entité est optionnel : Vision Globale (aucune case) par défaut, ou Vision
 * Entité restreinte à un sous-ensemble. Les entités cochées sont postées en champs
 * cachés `entityIds` → l'action les chaîne dans la même transaction. Tokens
 * UI_GUIDELINES §2.3. Pas de dépendance externe (règle 9) : micro-helper `cn` local.
 */
import { useState } from "react";
import { useActionState } from "react";

import { provisionnerMembre, type EtatProvisioning } from "./actions";

/** Entité assignable (projection minimale — pas de couplage au composant entités). */
export interface EntiteOption {
  id: string;
  nom: string;
  code: string | null;
}

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const ETAT_INITIAL: EtatProvisioning = { erreur: null, succes: null };

const champClass =
  "h-10 rounded-control border border-line bg-white px-3 text-sm " +
  "placeholder:text-text-faint focus:outline-none focus:border-primary " +
  "focus:ring-2 focus:ring-primary/30 disabled:opacity-48";

export function FormulaireProvisioning({
  entites,
}: {
  entites: EntiteOption[];
}) {
  const [etat, action, enCours] = useActionState(
    provisionnerMembre,
    ETAT_INITIAL,
  );

  // Périmètre : GLOBALE (défaut) ou ENTITE. La sélection est mémorisée même si on
  // repasse en Globale (confort de saisie).
  const [mode, setMode] = useState<"GLOBALE" | "ENTITE">("GLOBALE");
  const [selection, setSelection] = useState<string[]>([]);
  // §12 — un ADMIN n'est jamais restreint à un périmètre (le serveur refuse :
  // `AdminNonScopableError`). Le rôle passe donc en état contrôlé, pour ne PAS proposer un
  // geste voué au rejet : on explique la règle à la place du sélecteur.
  const [role, setRole] = useState<"ADMIN" | "MANAGER" | "VIEWER">("VIEWER");

  const sansEntite = entites.length === 0;
  const estAdmin = role === "ADMIN";
  // Un ADMIN est TOUJOURS global : ni le mode ni la sélection ne s'appliquent à lui.
  const estGlobale = estAdmin || mode === "GLOBALE" || sansEntite;
  // Champs cachés réellement envoyés (convention serveur : Globale ⇒ []).
  const entityIdsAEnvoyer = estGlobale ? [] : selection;
  // Garde-fou produit : mode ENTITE sans aucune case → envoyer [] rouvrirait tout.
  const entiteSansCase =
    !estAdmin && mode === "ENTITE" && !sansEntite && selection.length === 0;

  function toggleEntite(id: string) {
    setSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Full name</span>
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
        <span className="text-sm font-medium">Initial password</span>
        <input
          name="motDePasse"
          type="password"
          required
          minLength={12}
          maxLength={200}
          disabled={enCours}
          className={champClass}
          placeholder="12 characters minimum"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Role</span>
        <select
          name="role"
          value={role}
          onChange={(e) =>
            setRole(e.target.value as "ADMIN" | "MANAGER" | "VIEWER")
          }
          disabled={enCours}
          className={champClass}
        >
          <option value="VIEWER">Viewer (read-only)</option>
          <option value="MANAGER">Manager</option>
          <option value="ADMIN">Administrator</option>
        </select>
      </label>

      {/* Périmètre entité (optionnel) ------------------------------------------- */}
      {estAdmin ? (
        <p className="border-t border-line pt-4 text-sm text-text-muted">
          <span className="font-medium text-text">Access:</span> the whole group.
          An administrator cannot be limited to specific entities — administering
          means seeing everything.
        </p>
      ) : (
      <fieldset className="flex flex-col gap-2.5 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <legend className="text-sm font-medium">Access</legend>
          {!sansEntite && (
            <div
              role="radiogroup"
              aria-label="Member access"
              className="flex rounded-control border border-line p-0.5 text-xs"
            >
              <button
                type="button"
                role="radio"
                aria-checked={estGlobale}
                disabled={enCours}
                onClick={() => setMode("GLOBALE")}
                className={cn(
                  "rounded-[6px] px-2.5 py-1 font-medium transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  estGlobale ? "bg-primary text-white" : "text-text-muted hover:text-text",
                )}
              >
                Whole group
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!estGlobale}
                disabled={enCours}
                onClick={() => setMode("ENTITE")}
                className={cn(
                  "rounded-[6px] px-2.5 py-1 font-medium transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  !estGlobale ? "bg-primary text-white" : "text-text-muted hover:text-text",
                )}
              >
                Selected entities
              </button>
            </div>
          )}
        </div>

        <p className={cn("text-xs", entiteSansCase ? "text-danger" : "text-text-muted")}>
          {sansEntite
            ? "No entity yet — the member will have access to the whole group."
            : estGlobale
              ? "Access to the whole group (all entities)."
              : entiteSansCase
                ? "Pick at least one entity, or switch back to whole-group access."
                : `Access limited to ${selection.length} ${selection.length > 1 ? "entities" : "entity"}.`}
        </p>

        {!sansEntite && (
          <div
            className={cn(
              "grid grid-cols-1 gap-2 sm:grid-cols-2",
              estGlobale && "pointer-events-none opacity-60",
            )}
          >
            {entites.map((entite) => {
              const cochee = estGlobale || selection.includes(entite.id);
              return (
                <label
                  key={entite.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2 text-sm transition-colors",
                    estGlobale
                      ? "cursor-not-allowed border-line bg-surface-inset"
                      : cochee
                        ? "border-primary bg-primary/5"
                        : "border-line hover:border-primary/50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={cochee}
                    disabled={estGlobale || enCours}
                    onChange={() => toggleEntite(entite.id)}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate">{entite.nom}</span>
                  {entite.code && (
                    <span className="shrink-0 text-[11px] font-medium text-text-faint">
                      {entite.code}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {/* Champs cachés : un input par entité réellement envoyée → getAll("entityIds"). */}
        {entityIdsAEnvoyer.map((id) => (
          <input key={id} type="hidden" name="entityIds" value={id} />
        ))}
      </fieldset>
      )}

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
        disabled={enCours || entiteSansCase}
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
        {enCours ? "Creating…" : "Create and add"}
      </button>
    </form>
  );
}
