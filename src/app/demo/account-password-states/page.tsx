"use client";

/**
 * Démo / Visual QA (Quality Gate 4) — AUTH-MDP-TEMPO1, NON destinée à la
 * production. Monte HORS auth/DB l'écran /account/password dans ses états :
 * forcé (bandeau), self-service (lien retour), erreurs nommées du registre S2,
 * et pending (stub jamais résolu — cliquer « Update password » fige le spinner).
 *
 * Les actions sont des STUBS purs (aucune Server Action importée) : le
 * formulaire reçoit son action en prop — invariant /demo : zéro accès réel.
 */
import { FormulaireMotDePasse } from "@/app/account/password/formulaire-mot-de-passe";
import {
  MESSAGES_CHANGEMENT,
  type EtatChangement,
} from "@/app/account/password/validation";

const stubInerte = async (etat: EtatChangement): Promise<EtatChangement> =>
  etat;

const stubPending = (): Promise<EtatChangement> =>
  new Promise<EtatChangement>(() => {
    // Jamais résolu : fige l'état pending pour la capture headless.
  });

function CarteDemo({
  titre,
  bandeauForcage,
  lienRetour,
  etatInitial,
  action = stubInerte,
}: {
  titre: string;
  bandeauForcage?: boolean;
  lienRetour?: boolean;
  etatInitial?: EtatChangement;
  action?: (etat: EtatChangement, formData: FormData) => Promise<EtatChangement>;
}) {
  return (
    <section className="border-b border-line">
      <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {titre}
      </p>
      <div className="flex justify-center p-6">
        <div className="w-full max-w-md rounded-card bg-surface-card p-8 shadow-card">
          <h1 className="text-lg font-semibold">
            Dodo<span className="text-accent">.</span>
          </h1>
          <p className="mt-1 mb-6 text-sm text-text-muted">
            Change your password.
          </p>

          {bandeauForcage && (
            <div className="mb-6 rounded-control bg-surface-inset p-4">
              <p className="text-sm text-text-muted">
                Your password was set by an administrator. Choose a new one to
                continue — you will be the only person who knows it.
              </p>
            </div>
          )}
          {lienRetour && (
            <p className="mb-6 text-sm">
              <span className="text-primary hover:underline">
                ← Back to dashboard
              </span>
            </p>
          )}

          <FormulaireMotDePasse action={action} etatInitial={etatInitial} />
        </div>
      </div>
    </section>
  );
}

export default function DemoAccountPasswordStates() {
  return (
    <div className="min-h-screen bg-surface-page">
      <CarteDemo
        titre="Forçage (must_change_password) — bandeau explicatif, idle"
        bandeauForcage
      />
      <CarteDemo
        titre="Self-service (flag levé) — lien retour, idle"
        lienRetour
      />
      <CarteDemo
        titre="Erreur — CURRENT_PASSWORD_INCORRECT"
        bandeauForcage
        etatInitial={{ erreur: MESSAGES_CHANGEMENT.CURRENT_PASSWORD_INCORRECT }}
      />
      <CarteDemo
        titre="Erreur — ACCOUNT_LOCKED (jamais la durée exacte)"
        bandeauForcage
        etatInitial={{ erreur: MESSAGES_CHANGEMENT.ACCOUNT_LOCKED }}
      />
      <CarteDemo
        titre="Erreur — PASSWORDS_DO_NOT_MATCH"
        lienRetour
        etatInitial={{ erreur: MESSAGES_CHANGEMENT.PASSWORDS_DO_NOT_MATCH }}
      />
      <CarteDemo
        titre="Pending — cliquer « Update password » (stub jamais résolu)"
        bandeauForcage
        action={stubPending}
      />
    </div>
  );
}
