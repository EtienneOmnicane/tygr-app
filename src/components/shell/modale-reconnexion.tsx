"use client";

/**
 * `ModaleReconnexion` — VUE PURE de la garde de session (plan §4.1, D2 « Transverse »).
 *
 * Séparée de `GardeSession` (qui porte la logique : timers, comparaison d'identité,
 * appel de la Server Action) pour respecter la convention des composants d'affichage :
 * zéro fetch, zéro état interne, handlers en props. C'est aussi ce qui permet de la
 * capturer hors auth/DB au Visual QA (`/demo/session-states`).
 *
 * `dismissible={false}` : une session expirée n'est pas « annulable » — ni Échap, ni
 * clic sur l'overlay. Il faut agir. La primitive `Modal` (§4.4) porte déjà le portail,
 * le focus-trap et `role="dialog"` : aucun markup de modale n'est dupliqué ici.
 */
import { Modal } from "@/components/ui/modal/modal";

export function ModaleReconnexion({
  action,
  erreur,
  enCours,
}: {
  /** Server Action (ou stub de démo) liée par le conteneur. */
  action: (formData: FormData) => void;
  /** Message d'échec, déjà non-énumérant (E18). `null` = pas d'erreur. */
  erreur: string | null;
  enCours: boolean;
}) {
  return (
    <Modal
      open
      dismissible={false}
      onClose={() => {}}
      title="Session expirée"
      size="sm"
    >
      <form action={action} className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Votre session a expiré. Reconnectez-vous pour continuer — votre travail
          en cours est conservé.
        </p>

        {/* Erreur ≠ sortie (§3.4) : fond `danger-bg` + `role="alert"`, jamais un
            simple rouge (réservé aux montants `outflow`). */}
        {erreur !== null && (
          <p
            role="alert"
            className="rounded-control bg-danger-bg px-3 py-2 text-xs text-danger"
          >
            {erreur}
          </p>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-text">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="username"
            autoFocus
            className="rounded-control border border-line bg-white px-3 py-2 text-sm
              focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-text">Mot de passe</span>
          <input
            type="password"
            name="motDePasse"
            required
            autoComplete="current-password"
            className="rounded-control border border-line bg-white px-3 py-2 text-sm
              focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </label>

        <button
          type="submit"
          disabled={enCours}
          className="mt-1 rounded-control bg-ink px-4 py-2 text-sm font-semibold
            text-text-onink transition-colors hover:bg-ink-700 focus:outline-none
            focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-[0.48]"
        >
          {enCours ? "Reconnexion…" : "Se reconnecter"}
        </button>
      </form>
    </Modal>
  );
}
