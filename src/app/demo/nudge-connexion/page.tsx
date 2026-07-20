"use client";

/**
 * Démo / Visual QA (Gate 4) de la CONSOMMATION du jeton `?connexion=etablie`.
 * NON destinée à la production.
 *
 * Pourquoi une route dédiée : le vrai parcours (connexion → synchro → nav → retour)
 * exige auth + DB + CDN, donc il n'est pas capturable en headless. Ce banc isole la
 * seule mécanique que la correction introduit — la durée de vie du jeton — et monte le
 * VRAI `ConsommerDrapeauConnexion`, jamais une copie de sa logique (la copie de markup
 * est précisément ce qui a fini par mentir dans `demo/dashboard-states`).
 *
 * Ce que la capture doit prouver, dans l'ordre :
 *   1. arrivée sur `?connexion=etablie` → le drapeau est LU (l'invite s'affiche) ;
 *   2. immédiatement après → l'URL ne porte PLUS le drapeau (jeton consommé) ;
 *   3. navigation puis bouton Précédent → l'URL revient SANS drapeau, donc l'invite ne
 *      peut plus se réarmer. C'est le défaut 8/10 de la cross-review.
 *   4. la période (`?periode=…`) SURVIT à la consommation — sinon on aurait corrigé un
 *      mensonge en faisant sauter la fenêtre de l'utilisateur.
 *
 * L'invite rendue ici est la vraie (`NudgePremiereSynchro`, pur) ; son état d'affichage
 * est FIGÉ par `arme`, puisque le contexte de synchro n'est pas montable hors workspace.
 */
import { Suspense, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { ConsommerDrapeauConnexion } from "@/components/sync/consommer-drapeau-connexion";
import {
  drapeauConnexionArme,
  CLE_DRAPEAU_CONNEXION,
} from "@/components/sync/drapeau-connexion";
import { NudgePremiereSynchro } from "@/components/sync/nudge-premiere-synchro";

export default function NudgeConnexionDemoPage() {
  // `useSearchParams` impose une frontière Suspense sur une route prérendue.
  return (
    <Suspense fallback={null}>
      <BancJeton />
    </Suspense>
  );
}

function BancJeton() {
  const params = useSearchParams();
  const pathname = usePathname();

  // Le drapeau était-il présent À L'ARRIVÉE ? FIGÉ par l'initialiseur paresseux, qui
  // s'exécute pendant le RENDU — donc avant que l'effet de consommation n'ait nettoyé
  // l'URL, et sans jamais poser d'état depuis un effet (`react-hooks/set-state-in-effect`).
  // Sans ce gel, on lirait l'URL déjà nettoyée et le banc n'afficherait jamais l'invite.
  const [armeALArrivee] = useState(() =>
    drapeauConnexionArme(params.get(CLE_DRAPEAU_CONNEXION) ?? undefined),
  );

  // URL courante, RÉACTIVE : `replaceState` est synchronisé avec le routeur App Router,
  // donc cet affichage bascule sur l'URL nettoyée dès que le jeton est consommé. La
  // preuve qui fait foi reste toutefois l'URL réelle du navigateur, assertée hors React.
  const query = params.toString();
  const urlObservee = query ? `${pathname}?${query}` : pathname;

  return (
    <div className="min-h-screen bg-surface-page">
      <ConsommerDrapeauConnexion />

      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Jeton de connexion
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Banc de vérification du jeton `?connexion=etablie` — hors production.
      </div>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-1 text-base font-semibold text-text">
            État observé après consommation
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            L’URL ci-dessous est lue APRÈS le passage de l’effet. Si le jeton a
            été consommé, elle ne porte plus <code>connexion=etablie</code> — et
            le bouton Précédent ne peut donc plus le restaurer.
          </p>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex gap-2">
              <dt className="font-semibold text-text">Drapeau à l’arrivée :</dt>
              <dd data-test="arme" className="text-text">
                {armeALArrivee ? "armé" : "absent"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-semibold text-text">URL après effet :</dt>
              <dd data-test="url" className="text-text tabular-nums">
                {urlObservee}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-1 text-base font-semibold text-text">
            L’invite, telle qu’elle s’affiche au premier passage
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-text-muted">
            Montée uniquement si le drapeau était armé À L’ARRIVÉE. Au retour
            arrière, le drapeau a disparu de l’entrée d’historique : ce bloc
            reste vide, ce qui EST la correction.
          </p>
          {armeALArrivee ? (
            <NudgePremiereSynchro peutSynchroniser onSynchroniser={() => {}} />
          ) : (
            <p data-test="sans-invite" className="text-sm text-text-faint">
              Aucune invite — drapeau absent.
            </p>
          )}
        </section>

        <section className="rounded-card bg-surface-card p-6 shadow-card">
          <h2 className="mb-4 text-base font-semibold text-text">
            Séquence à dérouler
          </h2>
          {/* Lien SORTANT vers une autre route de démo : il crée l'entrée d'historique
              suivante, sans laquelle le bouton Précédent n'a rien à remonter. */}
          <a
            data-test="aller-ailleurs"
            href="/demo/dashboard-states"
            className="text-sm font-semibold text-primary underline-offset-2
              hover:underline focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            1. Aller sur une autre page → 2. bouton Précédent → 3. relire l’URL
            ci-dessus
          </a>
        </section>
      </main>
    </div>
  );
}
