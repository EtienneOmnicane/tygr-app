"use client";

/**
 * Bouton « Synchroniser » du dashboard (L8a). Coquille CLIENT autonome qui rappelle
 * la Server Action `synchroniserConnexionsAction` (zéro argument, idempotente) puis
 * rafraîchit les données RSC du dashboard (`router.refresh()`) — les nouveaux soldes /
 * transactions réapparaissent sans rechargement complet de page.
 *
 * Il EXPOSE sur le dashboard l'action de re-synchro qui n'existait jusque-là que dans
 * le widget de /banques (`bank-connect-widget.tsx`). Il appelle la MÊME action ; il
 * n'y a aucun couplage au widget (le widget n'utilisait son retour que pour rouvrir la
 * MFA, hors de propos ici). Posé à côté de la pastille de fraîcheur du solde
 * (`side-panel-kpi.tsx`, carte SOLDE) : l'utilisateur rafraîchit là où il lit l'âge
 * de la donnée.
 *
 * Sécurité (rappel) : la VRAIE garde est SERVEUR — `synchroniserConnexionsDepuisOmnifi`
 * refuse un VIEWER en `ConnexionNonAutoriseeError` (orchestration.ts:759, sous le
 * `ctx.role` re-résolu par withWorkspace). Le gating `peutModifier` ci-dessous n'est
 * qu'un CONFORT UX (VIEWER = bouton visible mais inerte + tooltip), pattern identique à
 * `bank-cta.tsx`.
 *
 * Réparation MFA : si le re-sync redemande un OTP (`reparation`), on NE pilote PAS la
 * MFA ici (le widget natif n'existe qu'en /banques) — on affiche un message + un lien
 * vers /banques (décision plan §3.3, même cible que « Reconnecter » de la pastille).
 *
 * États (plan §3.3) : repos / en cours / succès / erreur / réparation. Couleurs : succès
 * `text-success`, erreur `text-danger` (JAMAIS un rouge de donnée, §3.4) ; le bouton lui-
 * même est un « lien d'action » `text-primary` (§2.3). Aucune couleur de donnée ici.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { cn } from "@/components/ui/states/primitives";
import { IconeSynchro } from "@/components/ui/icons/icone-synchro";
import { synchroniserConnexionsAction } from "@/app/(workspace)/banques/actions";

/** Retour utile pour le rendu (sous-ensemble d'`EtatFinalisation`). */
type Retour = {
  erreur: string | null;
  succes: string | null;
  reparation?: Array<{ connectionId: string; jobId: string }>;
  aReconnecter?: Array<{ connectionId: string }>;
};

export function SyncButton({ role }: { role: WorkspaceRole }) {
  const router = useRouter();
  const [enCours, demarrer] = useTransition();
  const [retour, setRetour] = useState<Retour | null>(null);

  // VIEWER : bouton VISIBLE mais inerte (span aria-disabled + tooltip), jamais un
  // <button> mort — même pattern que `bank-cta.tsx`. La barrière réelle est serveur.
  if (!peutModifier(role)) {
    return (
      <span
        aria-disabled
        title="Votre rôle (lecture seule) ne permet pas de synchroniser les comptes."
        className="inline-flex cursor-default items-center gap-1.5 text-xs
          font-semibold text-text-faint"
      >
        <IconeSynchro className="h-3.5 w-3.5" />
        Synchroniser
      </span>
    );
  }

  function synchroniser() {
    setRetour(null);
    demarrer(async () => {
      const r = await synchroniserConnexionsAction();
      setRetour(r);
      // On rafraîchit les données serveur du dashboard SEULEMENT si la synchro n'a pas
      // échoué « dur » (un échec total garde l'écran tel quel + le message d'erreur).
      if (r.erreur === null) {
        router.refresh();
      }
    });
  }

  // Une réparation MFA a-t-elle été demandée par le re-sync ?
  const aReparer = (retour?.reparation?.length ?? 0) > 0;
  // Une banque a-t-elle un accès désaligné (403) → à RECONNECTER ? Distinct de la
  // réparation MFA : ici on relance un parcours de connexion complet depuis /banques.
  const aReconnecter = (retour?.aReconnecter?.length ?? 0) > 0;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={synchroniser}
        disabled={enCours}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-semibold text-primary",
          "transition-colors hover:text-primary-600 disabled:opacity-48",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          "focus-visible:ring-offset-2 rounded-[2px]",
        )}
      >
        <IconeSynchro
          className={cn("h-3.5 w-3.5", enCours && "motion-safe:animate-spin")}
        />
        {enCours ? "Synchronisation…" : "Synchroniser"}
      </button>

      {/* Feedback inline court, sous le bouton (la carte SOLDE reste compacte).
          Erreur = danger + role=alert ; réparation/succès = status. */}
      {retour?.erreur && (
        <p role="alert" className="text-right text-xs text-danger">
          {retour.erreur}
        </p>
      )}

      {!retour?.erreur && aReparer && (
        <p role="status" className="text-right text-xs text-text-muted">
          Une vérification de sécurité est requise.{" "}
          <Link
            href="/banques"
            className="font-semibold text-primary underline-offset-2 hover:underline
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
              focus-visible:ring-offset-2 rounded-[2px]"
          >
            Reconnecter
          </Link>
        </p>
      )}

      {!retour?.erreur && aReconnecter && (
        <p role="status" className="text-right text-xs text-text-muted">
          L’accès d’une banque n’est plus valide.{" "}
          <Link
            href="/banques"
            className="font-semibold text-primary underline-offset-2 hover:underline
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
              focus-visible:ring-offset-2 rounded-[2px]"
          >
            Reconnecter cette banque
          </Link>
        </p>
      )}

      {!retour?.erreur && !aReparer && !aReconnecter && retour?.succes && (
        <p role="status" className="text-right text-xs text-success">
          Comptes à jour.
        </p>
      )}
    </div>
  );
}
