/**
 * Démo / Visual QA (Gate 4) — SONDE du jeton `?connexion=etablie`. NON destinée à la
 * production, ne lit aucune donnée de workspace, n'exige aucune auth.
 *
 * ⚠️ CETTE SONDE REMPLACE UNE PREMIÈRE VERSION QUI NE POUVAIT PAS ÉCHOUER (constat de
 * cross-review, 8/10 — et c'est le piège « fixture de démo trop favorable » : une Gate 4
 * verte qui ne prouve rien). La version précédente était un composant CLIENT qui décidait
 * d'afficher l'invite à partir de `useSearchParams`, et naviguait par `<a href>`. Or la
 * production ne fait NI l'un NI l'autre :
 *
 *   - la décision est prise SERVEUR (`(workspace)/(dashboard)/page.tsx` lit `searchParams`
 *     et passe un booléen), et son résultat est figé dans un payload RSC MIS EN CACHE ;
 *   - l'entrée se fait par `router.push` (widget) et la sortie par `<Link>` — donc des
 *     navigations SOUPLES, servies par le Router Cache, pas des rechargements.
 *
 * Un composant client relit forcément l'URL nettoyée au retour et n'affiche rien : il
 * passait que le cache RSC réintroduise ou non l'invite. Le seul risque réel — que le
 * retour arrière restitue le NŒUD DE CACHE rendu AVEC l'invite — n'était donc pas testé.
 *
 * Cette sonde reproduit les trois propriétés qui comptent :
 *   1. décision SERVEUR (ce fichier est un Server Component, il lit `searchParams`) ;
 *   2. entrée par `router.push` avec le drapeau (comme le widget) ;
 *   3. sortie par `<Link>` (navigation souple), puis bouton Précédent.
 *
 * Ce que la capture doit prouver : après l'aller-retour, l'invite est ABSENTE et l'URL ne
 * porte plus le drapeau — tandis qu'au premier passage elle est bien PRÉSENTE (sans quoi
 * on aurait « corrigé » le défaut en cassant la fonctionnalité).
 */
import Link from "next/link";

import { ConsommerDrapeauConnexion } from "@/components/sync/consommer-drapeau-connexion";
import {
  CLE_DRAPEAU_CONNEXION,
  drapeauConnexionArme,
} from "@/components/sync/drapeau-connexion";
import { BoutonSimulerConnexion } from "./bouton-simuler-connexion";
import { InviteGelee } from "./invite-gelee";

export const metadata = { title: "Démo · Sonde du jeton de connexion" };

export default async function PageSondeJeton({
  searchParams,
}: {
  searchParams: Promise<{ [cle: string]: string | string[] | undefined }>;
}) {
  const parametres = await searchParams;
  // MÊME lecture que le dashboard réel : serveur, via le module partagé.
  const arme = drapeauConnexionArme(parametres[CLE_DRAPEAU_CONNEXION]);

  return (
    <div className="min-h-screen bg-surface-page">
      {/* Monté INCONDITIONNELLEMENT, comme en production : le jeton doit être consommé
          du seul fait d'être arrivé, même quand l'invite n'est pas montrée. */}
      <ConsommerDrapeauConnexion />

      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Sonde du jeton
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Décision SERVEUR + navigations souples — reproduit le parcours réel. Hors
        production.
      </div>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-1 text-base font-semibold text-text">
            Décision serveur
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            Ce bloc est rendu par un Server Component qui lit{" "}
            <code>searchParams</code>, exactement comme le dashboard. Son
            résultat part dans le payload RSC — c’est ce payload que le bouton
            Précédent peut restituer.
          </p>
          <p className="text-sm">
            <span className="font-semibold text-text">
              Drapeau vu par le serveur :{" "}
            </span>
            <span data-test="arme" className="text-text">
              {arme ? "arme" : "absent"}
            </span>
          </p>
        </section>

        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-1 text-base font-semibold text-text">
            L’invite (rendue par le serveur si le drapeau est armé)
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            Au premier passage elle DOIT être là. Après l’aller-retour elle NE
            doit PAS revenir.
          </p>
          {/* Le serveur MONTE le composant (comme en production, où `connexionEtablie`
              conditionne le montage) ; c'est le GEL CLIENT qui tranche l'affichage. Les
              deux étages comptent : au retour arrière le cache RSC restitue `arme`, et
              seul le gel client, relisant l'URL nettoyée au remontage, dit non. */}
          {arme ? (
            <InviteGelee />
          ) : (
            <p data-test="sans-invite" className="text-sm text-text-faint">
              Aucune invite — drapeau absent côté serveur.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="text-base font-semibold text-text">
            Séquence fidèle au parcours réel
          </h2>
          {/* 1. Entrée par `router.push` AVEC le drapeau — ce que fait le widget. */}
          <BoutonSimulerConnexion />
          {/* 2. Sortie par <Link> : navigation SOUPLE servie par le Router Cache, comme
                 la nav de l'application. Un <a href> aurait rechargé la page et vidé le
                 cache — c'est-à-dire testé autre chose. */}
          <Link
            data-test="aller-ailleurs"
            href="/demo/dashboard-states"
            className="text-sm font-semibold text-primary underline-offset-2
              hover:underline focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            2. Naviguer ailleurs (Link, navigation souple) → 3. bouton Précédent
          </Link>
        </section>
      </main>
    </div>
  );
}
