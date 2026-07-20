/**
 * COMPTE RENDU DE SYNCHRONISATION du dashboard — présentationnel PUR (zéro fetch, zéro
 * état, handlers en props). Remplace le « mur de texte gris » qui vivait dans
 * `sync-button.tsx` : 4 canaux empilés en `text-xs`, alignés à droite, tous gris sauf
 * l'erreur, avec les deux ACTIONS noyées dedans.
 *
 * ⚠️ DEUX DURÉES DE VIE, DEUX TRAITEMENTS (retour Etienne 2026-07-20) — c'est L'axe de
 * conception de ce composant, ne pas le réunifier :
 *
 *   1. Le SUCCÈS est le résultat du dernier clic : ÉPHÉMÈRE. Notice `success` FERMABLE.
 *      Il n'a rien à faire en mobilier permanent — une fois lu, il ne doit plus disputer
 *      la place aux soldes et au graphe, qui sont le héros de l'écran.
 *   2. Les AVERTISSEMENTS (récupération inachevée, accès à rétablir, banques non
 *      rattachées) décrivent une CONDITION qui dure : ils restent, compacts, et ne sont
 *      **PAS fermables**. Fermer un avertissement encore vrai masquerait le problème
 *      réel — précisément l'échec silencieux que `messages-sync.ts` existe pour
 *      surfacer. Ils disparaissent quand la condition disparaît, jamais sur un clic.
 *      (Si un jour on les rend fermables, la fermeture doit valoir pour CE retour-là et
 *      ne jamais être persistée : la condition suivante doit se ré-annoncer.)
 *
 * La PASTILLE DE FRAÎCHEUR a quitté ce bloc : elle a rejoint le cluster statut+action du
 * header, à côté de « Synchroniser » (même objet mental, elle était à l'opposé). Ce
 * composant ne monte donc plus rien au repos — et c'est voulu : il ne subsiste que
 * lorsqu'il a quelque chose à dire. Le garde « anti-effondrement » que portait l'ancienne
 * ligne d'état permanente (cf. `sync-contexte.tsx`) devient sans objet, puisque le bloc
 * est désormais transitoire par construction ; ce qui ne bouge plus, lui, c'est le
 * couple fraîcheur+bouton, qui est ancré dans le header.
 *
 * ⚠️ D'OÙ VIENT LE TEXTE (contrat hérité de la PR #202, à ne pas casser) :
 *  - on affiche `succes` / `erreur` **VERBATIM du serveur**. On ne découpe JAMAIS cette
 *    phrase : elle est concaténée côté action (base + partiel + reconnexion + cooldown
 *    + réparation) et la re-parser recréerait une seconde source de vérité — la classe
 *    de bug que `registre-synchro.ts` a été écrit pour tuer ;
 *  - les callouts portent un libellé d'ACTION court, **sans compteur**. Les nombres
 *    restent dans la phrase serveur : deux sources qui comptent ne peuvent pas diverger
 *    si une seule compte ;
 *  - le TON vient de `registreSynchro` (pur, testé), jamais de la phrase.
 *
 * Les compteurs de désynchronisation (`nonRattachees` / `inutilisables`) ne franchissent
 * PAS la frontière serveur → client : l'action les aplatit dans `info` via
 * `supplementsDesync`. On rend donc `info` tel quel dans UN callout — les deux messages
 * amont pointent déjà vers le même geste (« Connecter une banque »).
 */
import Link from "next/link";

import type { EtatFinalisation } from "@/app/(workspace)/banques/actions";
import { registreSynchro } from "@/components/sync/registre-synchro";
import { Callout } from "@/components/ui/states/callout";

/** Cible commune des gestes de réparation : le parcours de connexion vit sur /banques. */
const ROUTE_BANQUES = "/banques";

export function SyncSummary({
  retour,
  enCours = false,
  peutRelancer = false,
  onRelancer,
  succesMasque = false,
  onFermerSucces,
}: {
  /** Dernier retour de l'action. `null` = jamais lancée (repos). */
  retour: EtatFinalisation | null;
  /** Une synchro est en vol : on annonce l'attente et on masque les callouts périmés. */
  enCours?: boolean;
  /**
   * Le rôle courant autorise-t-il de relancer ? Un VIEWER lit les avertissements (c'est
   * une information de lecture) mais n'obtient pas le bouton « Relancer ».
   */
  peutRelancer?: boolean;
  /** Relance la synchro. Inerte si absent (route de démo / Visual QA). */
  onRelancer?: () => void;
  /**
   * La notice de succès a-t-elle été fermée POUR CE RETOUR ? L'état vit chez l'appelant
   * (`SyncSummaryConnecte`), qui le rattache à l'identité du retour — ainsi la synchro
   * suivante se ré-annonce toujours. Ne concerne QUE le succès : les avertissements ne
   * sont pas fermables (cf. docstring).
   */
  succesMasque?: boolean;
  /** Ferme la notice de succès. Absent = notice non fermable (démo / Visual QA). */
  onFermerSucces?: () => void;
}) {
  const registre = registreSynchro(retour ?? null);

  // Signaux STRUCTURÉS uniquement — jamais la phrase (cf. docstring).
  const aReparer = (retour?.reparation?.length ?? 0) > 0;
  const aReconnecter = (retour?.aReconnecter?.length ?? 0) > 0;
  const accesARetablir = aReparer || aReconnecter;
  const incomplet = retour?.incomplet === true;
  const info = retour?.info;
  // La phrase de succès n'est montrée que si le serveur en a une ET qu'elle n'a pas été
  // fermée. `registre` distingue un vrai succès d'un compte rendu au ton neutre.
  const succesVisible =
    !succesMasque &&
    !enCours &&
    registre !== "muet" &&
    registre !== "erreur" &&
    Boolean(retour?.succes);
  const erreurVisible =
    !enCours && registre === "erreur" && Boolean(retour?.erreur);

  // Rien à dire → on ne monte RIEN (pas même une `<section>` vide : le parent l'espace
  // en `gap-6`, un conteneur de hauteur nulle y creuserait un trou visible). Au repos,
  // la fraîcheur se lit dans le header — ce bloc n'a plus de rôle de socle, il n'existe
  // que quand il porte un message. Le succès fermé fait donc bien disparaître le bloc.
  const aQuelqueChoseADire =
    enCours ||
    succesVisible ||
    erreurVisible ||
    accesARetablir ||
    incomplet ||
    Boolean(info);
  if (!aQuelqueChoseADire) return null;

  return (
    <section
      aria-label="État de la synchronisation"
      className="flex max-w-2xl flex-col gap-2"
    >
      {/* EN COURS — remplace tout le reste : proposer « Reconnecter » pour un état
          qu'on est justement en train de recalculer serait trompeur. */}
      {enCours && (
        <p role="status" className="text-sm text-text-muted">
          Synchronisation en cours…
        </p>
      )}

      {/* Ordre FIXE (sinon il dépendrait de l'ordre des champs et bougerait d'une
          synchro à l'autre) : le RÉSULTAT du geste d'abord — c'est ce que
          l'utilisateur vient de demander — puis les CONDITIONS, de la plus grave à la
          plus informative. */}
      {!enCours && (
        <>
          {/* SUCCÈS — éphémère, donc FERMABLE (cf. docstring §1). Le message est en
              `text-text` sur `success-bg` : le vert ne porte plus le texte (il échoue
              l'AA à 3,46:1), seulement le fond et la coche. Même traitement que
              l'erreur, §3.4. */}
          {succesVisible && (
            <Callout
              severite="success"
              role="status"
              onFermer={onFermerSucces}
              libelleFermer="Masquer le compte rendu de synchronisation"
              // `tabular-nums` : la phrase porte des compteurs (banques, comptes,
              // transactions) — §0.
              className="tabular-nums"
            >
              {retour?.succes}
            </Callout>
          )}

          {/* ERREUR — §3.4 : fond + icône + message, jamais un rouge nu. NON fermable :
              un échec dur reste à l'écran tant qu'il n'a pas été re-tenté. */}
          {erreurVisible && (
            <Callout severite="danger" role="alert">
              {retour?.erreur}
            </Callout>
          )}

          {/* ACCÈS À RÉTABLIR — réparation MFA et accès désaligné (403) mènent au MÊME
              écran : un seul callout, un seul geste. NON fermable : la condition dure
              tant que l'accès n'est pas rétabli (cf. docstring §2). */}
          {accesARetablir && (
            <Callout
              severite="warning"
              role="status"
              action={<LienAction href={ROUTE_BANQUES}>Reconnecter</LienAction>}
            >
              L’accès d’une ou plusieurs banques doit être rétabli.
            </Callout>
          )}

          {/* SYNCHRO PARTIELLE — le scrape tourne ENCORE chez la banque. Relancer reste
              un geste valide et idempotent même quand le relais de fond (W1) est parti :
              le serveur ne distingue pas les deux cas dans un signal structuré. */}
          {incomplet && (
            <Callout
              severite="warning"
              role="status"
              action={
                peutRelancer && onRelancer ? (
                  <BoutonAction onClick={onRelancer}>Relancer</BoutonAction>
                ) : undefined
              }
            >
              La récupération n’est pas terminée chez la banque.
            </Callout>
          )}

          {/* INFORMATION — désynchronisations base ↔ amont, « aucune banque à
              synchroniser ». Texte serveur VERBATIM (les compteurs ne traversent pas). */}
          {info && (
            <Callout
              severite="warning"
              role="status"
              action={
                <LienAction href={ROUTE_BANQUES}>Connecter une banque</LienAction>
              }
            >
              {info}
            </Callout>
          )}
        </>
      )}
    </section>
  );
}

/** Style commun des actions de callout (§2.3 lien d'action). */
const CLASSES_ACTION =
  "inline-flex items-center whitespace-nowrap rounded-[2px] text-sm font-semibold " +
  "text-primary underline-offset-2 transition-colors hover:text-primary-600 " +
  "hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
  "focus-visible:ring-offset-2";

function LienAction({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={CLASSES_ACTION}>
      {children}
    </Link>
  );
}

function BoutonAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={CLASSES_ACTION}>
      {children}
    </button>
  );
}
