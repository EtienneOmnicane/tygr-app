"use client";

/**
 * Câblage du widget natif Omni-FI (@omnifi/react) — PR-W4. Drop-in officiel :
 * c'est LUI qui gère la connexion bancaire et toute la machine MFA en interne ;
 * il ne nous expose que le PublicToken via `onSuccess`. On ne réimplémente donc
 * pas la MFA ici (la logique maison PR-W3 reste dans le repo, hors chemin drop-in).
 *
 * Flux : bouton « Connecter une banque » → demarrerConnexionAction (LinkToken,
 * serveur) → useOmniFi({ token }).open() → onSuccess(publicToken) →
 * finaliserConnexionDropinAction (exchange + GET /accounts, serveur).
 *
 * ⚠️ Le vrai package @omnifi/react vit sur un registre npm privé (non installé
 * dans cet environnement — voir src/types/omnifi-react.d.ts). Le typage est stubé ;
 * le runtime utilise le vrai widget sur le poste de l'utilisateur.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useOmniFi } from "@omnifi/react";

import {
  demarrerConnexionAction,
  finaliserConnexionDropinAction,
  type EtatDemarrage,
  type EtatFinalisation,
} from "./actions";

const ETAT_DEMARRAGE: EtatDemarrage = { erreur: null, linkToken: null };

export function ConnecterBanque({ peutConnecter }: { peutConnecter: boolean }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [message, setMessage] = useState<EtatFinalisation>({ erreur: null, succes: null });
  const [enCours, startTransition] = useTransition();
  // 5.2 : on ne déclenche open() qu'APRÈS que le hook ait reçu le vrai token,
  // jamais avec "". Ce drapeau marque qu'une ouverture est demandée.
  const ouvertureDemandee = useRef(false);

  // Widget natif : initialisé avec le LinkToken une fois obtenu. onSuccess ne
  // reçoit que le publicToken → on le passe à la Server Action de finalisation.
  const { open } = useOmniFi({
    token: linkToken ?? "",
    onSuccess: (publicToken: string) => {
      startTransition(async () => {
        const r = await finaliserConnexionDropinAction(publicToken);
        setMessage(r);
      });
    },
  });

  // 5.2 : open() est appelé dans un effect, après que `linkToken` (donc la prop
  // `token` du hook) a été mise à jour — jamais avec un token vide (race de
  // setState évitée). Une seule ouverture par token obtenu.
  useEffect(() => {
    if (linkToken && ouvertureDemandee.current) {
      ouvertureDemandee.current = false;
      open();
    }
  }, [linkToken, open]);

  function lancer() {
    setMessage({ erreur: null, succes: null });
    startTransition(async () => {
      // 1. Obtenir un LinkToken (serveur). FormData minimal : RedirectOrigin du site.
      const fd = new FormData();
      fd.set("redirectOrigin", window.location.origin);
      const r: EtatDemarrage = await demarrerConnexionAction(ETAT_DEMARRAGE, fd);
      if (r.erreur || !r.linkToken) {
        setMessage({ erreur: r.erreur ?? "Échec du démarrage.", succes: null });
        return;
      }
      // 2. Armer le widget ; l'ouverture se fait dans l'effect quand le token est posé.
      ouvertureDemandee.current = true;
      setLinkToken(r.linkToken);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={!peutConnecter || enCours}
        onClick={lancer}
        className="h-10 rounded-control bg-primary px-4 text-sm font-semibold
          text-white transition-colors hover:bg-primary-600 focus:outline-none
          focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-48"
        title={peutConnecter ? undefined : "Réservé aux managers et administrateurs"}
      >
        {enCours ? "Connexion…" : "+ Connecter une banque"}
      </button>

      {message.succes && (
        <p role="status" className="text-[13px] text-success">
          {message.succes}
        </p>
      )}
      {message.erreur && (
        <p role="alert" className="text-[13px] text-danger">
          {message.erreur}
        </p>
      )}
    </div>
  );
}
