"use client";

/**
 * Contexte CLIENT de la synchronisation du dashboard. Il existe pour une raison de
 * MISE EN PAGE : le déclencheur (« Synchroniser ») vit dans le cluster droit du header,
 * tandis que le compte rendu (`SyncSummary`) doit se lire à GAUCHE, sous le header et
 * sur toute la largeur. Deux positions distinctes dans l'arbre, un seul état — d'où le
 * contexte plutôt qu'un composant unique.
 *
 * Avant, tout vivait dans `sync-button.tsx` : le compte rendu était donc contraint de
 * s'afficher sous le bouton, aligné à droite, en `text-xs` — le « mur de texte gris »
 * corrigé ici.
 *
 * Frontière : ce module est le SEUL à appeler la Server Action. `SyncSummary` et
 * `SyncButton` restent des composants d'affichage pilotés par props / hook.
 *
 * ⚠️ Le retour N'EST PLUS remis à `null` au clic (c'était le cas dans `sync-button.tsx`).
 * Le raisonnement d'origine (« le vider fait s'effondrer le bloc, tout le dashboard
 * remonte puis redescend ») ne tient PLUS tel quel depuis que le compte rendu est
 * transitoire par construction : c'est le couple fraîcheur+bouton, ancré dans le header,
 * qui ne bouge plus. La raison actuelle de conserver le retour est autre, et elle
 * suffit : il porte les AVERTISSEMENTS (accès à rétablir, récupération inachevée,
 * banques non rattachées), qui doivent rester lisibles après la synchro — les vider au
 * clic suivant les ferait clignoter. `SyncSummary` bascule en mode « en cours » à partir
 * de `enCours` et masque lui-même les callouts périmés pendant le vol.
 *
 * ⚠️ Chaque synchro produit un NOUVEL objet `retour` : `SyncSummaryConnecte` s'appuie sur
 * cette identité pour ré-afficher la notice de succès après une fermeture. Ne pas
 * introduire de mémoïsation qui réutiliserait le même objet d'une synchro à l'autre.
 */
import {
  createContext,
  useContext,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import type { EtatFinalisation } from "@/app/(workspace)/banques/actions";
import { synchroniserConnexionsAction } from "@/app/(workspace)/banques/actions";

interface ValeurContexteSynchro {
  /** Dernier retour de l'action. `null` = jamais lancée (état de repos). */
  retour: EtatFinalisation | null;
  /** Une synchro est en vol. */
  enCours: boolean;
  /** Déclenche la synchro (idempotente, zéro argument). */
  synchroniser: () => void;
}

const ContexteSynchro = createContext<ValeurContexteSynchro | null>(null);

export function SynchroProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [enCours, demarrer] = useTransition();
  const [retour, setRetour] = useState<EtatFinalisation | null>(null);

  function synchroniser() {
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

  return (
    <ContexteSynchro.Provider value={{ retour, enCours, synchroniser }}>
      {children}
    </ContexteSynchro.Provider>
  );
}

/**
 * Accès au contexte. Lève si le composant est monté hors `SynchroProvider` : un
 * déclencheur muet ou un compte rendu qui n'affiche jamais rien est un défaut
 * silencieux — on préfère l'échec bruyant (règle « catch-all silencieux interdit »).
 */
export function useSynchro(): ValeurContexteSynchro {
  const valeur = useContext(ContexteSynchro);
  if (valeur === null) {
    throw new Error(
      "useSynchro doit être utilisé à l'intérieur d'un <SynchroProvider>.",
    );
  }
  return valeur;
}
