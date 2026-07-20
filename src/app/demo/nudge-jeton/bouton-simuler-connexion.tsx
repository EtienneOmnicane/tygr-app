"use client";

/**
 * Entrée de la sonde : reproduit EXACTEMENT le geste du widget après une connexion
 * réussie — `router.push` vers la même route, drapeau en query.
 *
 * Pourquoi un `router.push` et pas un lien : la navigation souple laisse le Router Cache
 * en place, et c'est précisément lui qui pourrait restituer, au retour arrière, le nœud
 * de cache rendu AVEC l'invite. Une entrée par rechargement viderait ce cache et ferait
 * passer la sonde pour de mauvaises raisons.
 */
import { useRouter } from "next/navigation";

import {
  CLE_DRAPEAU_CONNEXION,
  VALEUR_DRAPEAU_CONNEXION,
} from "@/components/sync/drapeau-connexion";

export function BoutonSimulerConnexion() {
  const router = useRouter();

  return (
    <button
      type="button"
      data-test="simuler-connexion"
      onClick={() =>
        router.push(
          `/demo/nudge-jeton?${CLE_DRAPEAU_CONNEXION}=${VALEUR_DRAPEAU_CONNEXION}`,
        )
      }
      className="inline-flex h-10 w-fit items-center rounded-control bg-primary px-4
        text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
        focus-visible:ring-offset-2"
    >
      1. Simuler la fin de connexion (router.push avec le drapeau)
    </button>
  );
}
