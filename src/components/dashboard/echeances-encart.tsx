/**
 * ENCART « Échéances à venir » — la prévision SORTIE de l'axe du réalisé
 * (FLUX-PREV-AXE1, option E de `PLAN-flux-previsionnel-lisibilite.md` §4.1 ; direction
 * retenue par Etienne le 2026-07-20).
 *
 * ## Le défaut que cet encart supprime
 * Le graphe « Flux de trésorerie » mêlait deux séries sur UN axe : le réalisé — mesure
 * EXHAUSTIVE de `transactions_cache`, en millions de MUR — et la prévision — sous-ensemble
 * DÉCLARÉ, les seules échéances saisies à la main, en milliers. Elles ne sont pas
 * commensurables. Avec un rapport mesuré jusqu'à 1:520, la barre projetée rendait 0,23 px
 * et le lecteur concluait « la trésorerie s'effondre » — un faux constat produit par la
 * mise en regard ELLE-MÊME, qu'aucun habillage ne corrige. Les lots 0-2 (#228) l'ont
 * atténué (mention de couverture, étiquette de valeur) sans le supprimer : tant que l'axe
 * est partagé, la comparaison implicite demeure.
 *
 * Ici, deux échelles légitimes parce que DEUX graphes (c'est ce qui sépare l'option E de
 * l'option G, le double axe, écartée §4.5 : deux échelles dans un seul graphe rendent des
 * hauteurs égales pour des montants sans rapport).
 *
 * ## Pourquoi le MONTANT ÉCRIT est le canal principal, et la barre l'appui
 * L'échelle propre ne suffit pas : l'écart d'ordre de grandeur se REPRODUIT à l'intérieur
 * de la prévision (Rs 10 000 à côté de Rs 3 150 000 = 1:315 — cas couvert par
 * `DEMO_DASHBOARD_PREVISION_CONTRASTEE`). Une barre reste donc parfois sous-pixel. C'est
 * pourquoi chaque ligne PORTE SON MONTANT EXACT, formaté : la valeur passe par un canal
 * qui ne dépend d'aucune échelle. La barre ne sert qu'à la comparaison relative, et quand
 * elle devient irreprésentable elle se réduit à un TICK de présence (`EPAISSEUR_TICK_PX`,
 * réutilisé de `flux-etiquettes.ts`) — jamais à un plancher proportionnel, qui ferait
 * rendre la même largeur à des valeurs d'un facteur 13 (écarté, plan §4.3).
 *
 * Corollaire : le format COMPACT (`formatMontantCompact`) n'est PAS employé ici. Il est
 * approximatif par construction et réservé aux contextes à largeur contrainte (étiquette
 * dans un SVG) ; l'encart a la place d'écrire le montant exact, et un montant ne se
 * tronque jamais (règle 8 / UI_GUIDELINES §0).
 *
 * ## Place dans la hiérarchie (UI_GUIDELINES §6.1 — une seule ancre visuelle)
 * L'ancre reste le graphe de flux. Cet encart est SECONDAIRE et le montre : pas de hauteur
 * d'ancre, barres fines horizontales, typographie de corps, et un renvoi discret vers
 * `/echeances` pour le détail. Il ne devient jamais une seconde ancre.
 *
 * ## Composant d'affichage PUR (CLAUDE.md § Intégration UI)
 * Zéro fetch, zéro état, zéro hook — donc pas de `"use client"` : la prévision arrive dans
 * le MÊME payload serveur que le réalisé. Les états loading et erreur appartiennent à la
 * route (`loading.tsx` / `error.tsx`) ; l'encart porte ses états VIDE et PARTIEL.
 *
 * ⚠️ Le skeleton de `loading.tsx` ne montre DÉLIBÉRÉMENT pas cet encart : sa présence est
 * conditionnelle (`prevision !== null`), donc un skeleton qui l'annonce promettrait une
 * carte qui n'arrive pas — un saut de layout inverse, pire que celui qu'il évite. Le
 * squelette s'arrête à ce qui est toujours rendu.
 *
 * ## Contrastes (Gate 4, §6.6 — mesurés sur le fond RÉEL, jamais sur blanc)
 * La liste est posée sur `surface-forecast` (#efebdd) : c'est le marquage prévisionnel
 * (§6.4, fond + label). Sur CE fond, `text-muted` donne 5,09:1, `inflow-700` 6,75:1 et
 * `outflow-700` 6,18:1 — tous AA. `text-faint` y tombe à 2,70:1 : il est BANNI de ce
 * composant (dette FLUX-PREV-CONTRASTE1, à ne pas aggraver).
 */
import Link from "next/link";

import {
  largeurRelative,
  maxPrevision,
  moisPrevision,
  type MoisAffiche,
  type PrevisionFlux,
} from "@/components/dashboard/flux-projection";
import { EPAISSEUR_TICK_PX } from "@/components/dashboard/flux-etiquettes";
import { StateCard } from "@/components/dashboard/states/primitives";
import { formaterMoisCourt } from "@/lib/format-date";
import { estZero, formatMontant } from "@/lib/format-montant";

/**
 * Encart des échéances projetées. `prevision` n'est JAMAIS `null` ici : c'est l'appelant
 * qui décide de monter l'encart (absence de prévision ⇒ absence d'encart, jamais un encart
 * vide — une prévision vide n'est pas une prévision nulle, plan §5.3).
 */
export function EcheancesEncart({
  prevision,
  devise,
}: {
  prevision: PrevisionFlux;
  /** Devise de base du workspace — mono-devise affichée, aucune conversion (DASH-FX1). */
  devise: string;
}) {
  const mois = moisPrevision(prevision);
  const max = maxPrevision(mois);

  // ZONE MUETTE (plan §5.4) : la prévision EXISTE mais aucune échéance n'y tombe dans la
  // devise de base. Trois situations à ne pas confondre, dont deux arrivent ici — la
  // troisième (`prevision === null`) est traitée par l'appelant :
  //  - tout à zéro, aucune autre devise → il n'y a réellement aucune échéance ;
  //  - tout à zéro PARCE QUE les échéances sont dans une autre devise → dire « aucune
  //    échéance » serait un FAUX constat : la donnée existe, elle n'est pas convertie.
  const aucuneValeur = max === 0;
  const autresDevises = mois.some((m) => m.autresDevises);

  return (
    <StateCard>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Échéances à venir</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {libelleHorizon(mois.length)} · échelle propre, non comparable au réalisé
          </p>
        </div>
        {/* UN seul CTA (§4.4) : le détail vit sur la page Échéances, l'encart n'en est
            que le résumé. Lien discret — l'encart reste secondaire (§6.1).
            `Link` et non `<a>` : navigation client, comme partout ailleurs dans le
            dashboard (un `<a>` interne relancerait un chargement complet de page).
            Cohabite avec le renvoi de `cash-flow-summary.tsx`, qui n'est pas un doublon :
            celui-là est une aide CONDITIONNELLE (« aucune entrée sur la période »), pas le
            renvoi permanent au détail. */}
        <Link
          href="/echeances"
          className="rounded-[2px] text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Voir les échéances
        </Link>
      </div>

      <div className="rounded-control bg-surface-forecast p-4">
        {aucuneValeur ? (
          <p className="text-sm text-text-muted">
            {autresDevises
              ? `Les échéances de ces mois sont dans une autre devise, non converties ici (affichage en ${devise}).`
              : "Aucune échéance sur ces mois."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {mois.map((m, i) => (
              <LigneMois
                key={m.libelleMois}
                mois={m}
                max={max}
                devise={devise}
                // Le mois d'ANCRAGE ne porte que ses échéances RESTANTES (D2) : sans cette
                // mention, il se lirait comme le mois entier alors qu'une partie est déjà
                // passée en banque — et elle, elle est dans le graphe du réalisé.
                ancrage={i === 0}
              />
            ))}
          </ul>
        )}
      </div>

      {/* MENTION DE COUVERTURE — déplacée ici depuis le graphe, dont elle n'a plus lieu
          d'être (il est redevenu 100 % réalisé). Elle qualifie la ZONE, pas les montants :
          elle reste affichée même quand l'encart n'a rien à lister. Libellé validé par
          Etienne (2026-07-20) ; ne pas l'adoucir sans arbitrage. */}
      <p className="mt-3 text-[11px] text-text-muted">
        Prévision : échéances saisies uniquement — partielle, non comparable aux mois
        réalisés.
      </p>
      {/* PARTIEL : des échéances existent hors devise de base. Signalées, jamais sommées
          ni converties (règle 8 / DASH-FX1). Muette si la zone l'a déjà dit ci-dessus. */}
      {autresDevises && !aucuneValeur && (
        <p className="mt-2 text-[11px] text-text-muted">
          Certains mois comportent aussi des échéances dans d’autres devises, non
          additionnées ici (affichage en {devise}).
        </p>
      )}
    </StateCard>
  );
}

/**
 * Une ligne de mois : son libellé, puis une rangée par SENS non nul (entrées, sorties).
 *
 * Un sens à zéro n'est pas rendu — l'étiqueter écrirait « Rs 0,00 » sur chaque mois sans
 * échéance, transformant un silence légitime en bruit (même raison que `estIllisible`
 * ignore les valeurs nulles). Un mois sans aucun sens non nul le dit en toutes lettres
 * plutôt que de laisser une ligne vide, que l'œil lit « la donnée n'a pas chargé ».
 */
function LigneMois({
  mois,
  max,
  devise,
  ancrage,
}: {
  mois: MoisAffiche;
  max: number;
  devise: string;
  ancrage: boolean;
}) {
  const aEntrees = !estZero(mois.entrees);
  const aSorties = !estZero(mois.sorties);

  return (
    <li className="flex flex-col gap-1">
      <p className="text-xs font-medium text-text">
        {formaterMoisCourt(mois.libelleMois)}
        {ancrage && (
          <span className="ml-1.5 font-normal text-text-muted">
            · restant ce mois-ci
          </span>
        )}
      </p>
      {aEntrees || aSorties ? (
        <div className="flex flex-col gap-1">
          {aEntrees && (
            <RangeeSens
              sens="entree"
              valeur={mois.entrees}
              max={max}
              devise={devise}
            />
          )}
          {aSorties && (
            <RangeeSens
              sens="sortie"
              valeur={mois.sorties}
              max={max}
              devise={devise}
            />
          )}
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          {mois.autresDevises
            ? "Échéances dans une autre devise"
            : "Aucune échéance"}
        </p>
      )}
    </li>
  );
}

/**
 * Une rangée « sens + barre + montant » à l'échelle propre de l'encart.
 *
 * Le SENS est écrit (« Entrées » / « Sorties ») : la couleur ne porte JAMAIS seule une
 * information (§3.5, accessibilité) — un daltonien, comme un lecteur d'écran, doit lire le
 * sens sans la teinte. Le vert/rouge reste légitime parce qu'il décrit la DONNÉE (§3.1).
 *
 * La barre est en pourcentage (aucune mesure du conteneur), avec une largeur MINIMALE d'un
 * tick quand la valeur est trop faible pour être représentée : un marqueur de présence, pas
 * une proportion. Le montant exact à droite est la source de vérité de la ligne —
 * `tabular-nums` et `whitespace-nowrap`, un chiffre ne se tronque jamais (règle 8).
 */
function RangeeSens({
  sens,
  valeur,
  max,
  devise,
}: {
  sens: "entree" | "sortie";
  /** Chaîne décimale (jamais un float — règle 8). */
  valeur: string;
  max: number;
  devise: string;
}) {
  const entree = sens === "entree";
  const largeur = largeurRelative(valeur, max);

  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[11px] text-text-muted">
        {entree ? "Entrées" : "Sorties"}
      </span>
      <span className="flex min-w-0 flex-1 items-center">
        <span
          aria-hidden
          className={`block h-2 rounded-sm ${entree ? "bg-inflow" : "bg-outflow"}`}
          style={{ width: `${largeur}%`, minWidth: EPAISSEUR_TICK_PX }}
        />
      </span>
      <span
        className={`shrink-0 whitespace-nowrap text-xs font-semibold tabular-nums ${
          entree ? "text-inflow-700" : "text-outflow-700"
        }`}
      >
        {formatMontant(valeur, devise, { signeExplicite: entree })}
      </span>
    </div>
  );
}

/**
 * Horizon couvert, dit HONNÊTEMENT : la première cellule est le mois d'ancrage (ses
 * échéances restantes), les suivantes sont des mois pleins. Annoncer « 4 prochains mois »
 * pour 1 mois entamé + 3 futurs serait faux.
 */
function libelleHorizon(nbMois: number): string {
  const futurs = Math.max(nbMois - 1, 0);
  if (futurs === 0) return "Ce mois-ci";
  return `Ce mois-ci et ${futurs} mois suivant${futurs > 1 ? "s" : ""}`;
}
