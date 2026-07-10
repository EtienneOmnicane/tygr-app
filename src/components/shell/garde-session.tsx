"use client";

/**
 * `GardeSession` — modale de reconnexion SANS perte de contexte (plan §4.1,
 * matrice D2 ligne « Transverse » : « session expirée en plein flow : modal
 * re-login SANS perte du contexte (retour à l'étape) »).
 *
 * CE QUE ÇA RÉSOUT (ce n'est pas du polish). Le JWT porte le pont vers Omni-FI.
 * S'il expire pendant que l'utilisateur saisit son OTP dans le widget MFA, la
 * Server Action lève `NonAuthentifieError`, l'utilisateur est éjecté vers /login,
 * et au retour le `SessionToken` Omni-FI est mort avec le job de sync. Le consent
 * flow d'Epic 1 casse. Ici, on superpose une modale : **le DOM sous-jacent n'est
 * jamais démonté**, donc l'OTP saisi, le formulaire rempli, l'étape en cours
 * survivent à la reconnexion.
 *
 * CE QUE ÇA NE FAIT PAS : aucun polling. On s'arme sur `expiresAt` (déjà connu du
 * serveur) moins une marge, et on revérifie au retour d'onglet (`visibilitychange`)
 * — un onglet en arrière-plan voit ses timers étranglés par le navigateur, donc le
 * seul timer ne suffit pas.
 *
 * SÉCURITÉ — le cas qui fabrique une fuite si on l'oublie. Si Alice laisse expirer
 * sa session et que Bob se reconnecte dans la modale, l'écran SOUS la modale affiche
 * encore les données d'Alice (RSC déjà rendu). On compare donc le `userId` retourné
 * par la Server Action à celui affiché : identités différentes → `router.refresh()`
 * forcé (re-rendu RSC sous la nouvelle identité) + purge du périmètre d'affichage
 * (`viewFilter`, qui référence des comptes de l'ancien contexte). Sans cela, on
 * livre une fuite intra-workspace VISUELLE.
 *
 * A11y / UI : réutilise la primitive `Modal` (§4.4) en `dismissible={false}` — une
 * session expirée ne se ferme pas par Échap ou clic-overlay, il faut agir. Tokens
 * UI_GUIDELINES uniquement.
 */
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ModaleReconnexion } from "@/components/shell/modale-reconnexion";
import {
  reconnecter,
  type EtatReconnexion,
} from "@/app/(workspace)/session-actions";

const ETAT_INITIAL: EtatReconnexion = { erreur: null, userId: null };

/**
 * Marge d'anticipation : on ouvre la modale AVANT l'expiration réelle, pour que
 * l'utilisateur puisse se reconnecter sans qu'une action parte en erreur entre-temps.
 */
const MARGE_MS = 60_000;

/** Borne du timer : `setTimeout` déborde au-delà de ~24,8 jours (int32 en ms). */
const DELAI_MAX_MS = 2_147_483_647;

export function GardeSession({
  userIdActuel,
  expiresAt,
}: {
  /** `userId` de la session qui a rendu l'écran actuellement affiché. */
  userIdActuel: string;
  /** Expiration de la session, en millisecondes epoch (sérialisable RSC → client). */
  expiresAt: number;
}) {
  const router = useRouter();

  /**
   * DEUX COMPTEURS MONOTONES — la modale est OUVERTE ssi `echeances > reconnexions`
   * (une échéance non encore « soldée »). Ce montage rouvre naturellement la modale
   * à une 2ᵉ expiration dans la même page, ce qu'un booléen `expiree` remis à false
   * ne ferait pas : le layout (donc `expiresAt`) n'est pas re-rendu par un re-login
   * à identité constante.
   *
   * Les deux `setState` vivent hors du corps d'un effet — l'un dans un timer, l'autre
   * dans le wrapper d'action ci-dessous : aucun rendu en cascade
   * (règle `react-hooks/set-state-in-effect`).
   */
  const [echeances, setEcheances] = useState(0);
  const [reconnexions, setReconnexions] = useState(0);

  const [etat, action, enCours] = useActionState(
    /*
     * Wrapper de la Server Action : c'est un GESTIONNAIRE (pas un effet), donc
     * l'endroit légitime pour réagir au résultat.
     *
     * - Identité DIFFÉRENTE (Alice a laissé expirer, Bob se reconnecte) : l'écran
     *   sous la modale affiche encore les données d'Alice (RSC déjà rendu).
     *   `router.refresh()` re-rend les Server Components sous la nouvelle session ;
     *   le périmètre d'affichage de l'ancien contexte n'est pas restitué (le
     *   callback jwt ne le rétablit pas pour un autre userId). Sans cela, on livre
     *   une fuite intra-workspace VISUELLE.
     * - Même identité : on ne rafraîchit surtout PAS — c'est exactement ce qui
     *   préserve le contexte (OTP saisi dans le widget MFA, formulaire rempli).
     */
    async (precedent: EtatReconnexion, formData: FormData) => {
      const resultat = await reconnecter(precedent, formData);
      if (resultat.userId !== null) {
        if (resultat.userId !== userIdActuel) router.refresh();
        setReconnexions((n) => n + 1); // solde l'échéance → referme la modale
      }
      return resultat;
    },
    ETAT_INITIAL,
  );

  const ouverte = echeances > reconnexions;

  /* Armement : un timer calé sur l'expiration + une revérification au retour
     d'onglet. Le calcul vit dans l'effet (client) : faire `Date.now()` au rendu
     désynchroniserait l'hydratation serveur/client. */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function echoir() {
      // `setState` appelé depuis un timer ou un écouteur — jamais dans le corps
      // synchrone de l'effet : pas de rendu en cascade.
      setEcheances((n) => n + 1);
    }

    function armer() {
      const restant = expiresAt - Date.now() - MARGE_MS;
      clearTimeout(timer);
      timer = setTimeout(echoir, Math.max(0, Math.min(restant, DELAI_MAX_MS)));
    }

    function auRetourDOnglet() {
      // Un onglet en arrière-plan voit ses timers étranglés : on re-mesure.
      if (document.visibilityState === "visible") armer();
    }

    armer();
    document.addEventListener("visibilitychange", auRetourDOnglet);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", auRetourDOnglet);
    };
    // `reconnexions` en dépendance : après un re-login, on RÉARME la garde sur la
    // nouvelle fenêtre de session.
  }, [expiresAt, reconnexions]);

  if (!ouverte) return null;

  // Vue PURE (capturable hors auth/DB au Visual QA, cf. /demo/session-states).
  return (
    <ModaleReconnexion action={action} erreur={etat.erreur} enCours={enCours} />
  );
}
