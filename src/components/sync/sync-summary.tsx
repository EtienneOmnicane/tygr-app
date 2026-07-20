/**
 * COMPTE RENDU DE SYNCHRONISATION du dashboard — présentationnel PUR (zéro fetch, zéro
 * état, handlers en props). Remplace le « mur de texte gris » qui vivait dans
 * `sync-button.tsx` : 4 canaux empilés en `text-xs`, alignés à droite, tous gris sauf
 * l'erreur, avec les deux ACTIONS noyées dedans.
 *
 * Structure (UI_GUIDELINES §3.4 / §3.7 / §6.5) :
 *
 *   1. LIGNE D'ÉTAT primaire — pastille de fraîcheur + résultat de la synchro. Montée
 *      EN PERMANENCE : au repos elle ne porte que la pastille. C'est ce qui empêche le
 *      bloc de s'effondrer entre deux synchros (le dashboard sautait à chaque clic).
 *   2. CALLOUTS actionnables — un par état, chacun avec SON action explicite.
 *
 * ⚠️ D'OÙ VIENT LE TEXTE (contrat hérité de la PR #202, à ne pas casser) :
 *  - la ligne d'état affiche `succes` / `erreur` **VERBATIM du serveur**. On ne découpe
 *    JAMAIS cette phrase : elle est concaténée côté action (base + partiel + reconnexion
 *    + cooldown + réparation) et la re-parser recréerait une seconde source de vérité —
 *    la classe de bug que `registre-synchro.ts` a été écrit pour tuer ;
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
import type { Fraicheur } from "@/lib/format-date";
import { registreSynchro } from "@/components/sync/registre-synchro";
import { BalanceFreshnessPill } from "@/components/dashboard/balance-freshness-pill";
import { Callout } from "@/components/ui/states/callout";
import { cn } from "@/components/ui/states/primitives";

/** Cible commune des gestes de réparation : le parcours de connexion vit sur /banques. */
const ROUTE_BANQUES = "/banques";

export function SyncSummary({
  fraicheur,
  compteLabel,
  retour,
  enCours = false,
  peutRelancer = false,
  onRelancer,
}: {
  /** Fraîcheur du solde courant déjà calculée (`formaterFraicheurRelative`). */
  fraicheur: Fraicheur | null;
  /** Compte concerné — enrichit le tooltip de la pastille. */
  compteLabel?: string | null;
  /** Dernier retour de l'action. `null` = jamais lancée (repos). */
  retour: EtatFinalisation | null;
  /** Une synchro est en vol : on annonce l'attente et on masque les callouts périmés. */
  enCours?: boolean;
  /**
   * Le rôle courant autorise-t-il de relancer ? Un VIEWER lit la ligne d'état (la
   * fraîcheur est une information de lecture) mais n'obtient pas le bouton « Relancer ».
   */
  peutRelancer?: boolean;
  /** Relance la synchro. Inerte si absent (route de démo / Visual QA). */
  onRelancer?: () => void;
}) {
  const registre = registreSynchro(retour ?? null);

  // Signaux STRUCTURÉS uniquement — jamais la phrase (cf. docstring).
  const aReparer = (retour?.reparation?.length ?? 0) > 0;
  const aReconnecter = (retour?.aReconnecter?.length ?? 0) > 0;
  const accesARetablir = aReparer || aReconnecter;
  const incomplet = retour?.incomplet === true;
  const info = retour?.info;

  // Rien à dire ET rien à dater : on ne monte pas un bloc vide.
  if (!fraicheur && !retour && !enCours) return null;

  return (
    <section
      aria-label="État de la synchronisation"
      className="flex max-w-2xl flex-col gap-2"
    >
      {/* 1. LIGNE D'ÉTAT — toujours montée (cf. docstring : anti-saut de layout). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {fraicheur && (
          <BalanceFreshnessPill
            fraicheur={fraicheur}
            compteLabel={compteLabel}
            // Décision produit livrée (dashboard-content.tsx) : la réparation ne
            // s'amorce pas depuis la pastille. Les callouts ci-dessous portent le geste.
            ctaReconnexion={false}
          />
        )}
        {enCours ? (
          <p role="status" className="text-sm text-text-muted">
            Synchronisation en cours…
          </p>
        ) : (
          registre !== "muet" &&
          registre !== "erreur" && (
            <p
              role="status"
              className={cn(
                // `tabular-nums` : la phrase porte des compteurs (banques, comptes,
                // transactions) — §0.
                "text-sm tabular-nums",
                registre === "succes" ? "text-success" : "text-text-muted",
              )}
            >
              {retour?.succes}
            </p>
          )
        )}
      </div>

      {/* 2. CALLOUTS — masqués pendant une synchro en vol : proposer « Reconnecter »
          pour un état qu'on est justement en train de recalculer serait trompeur.
          Ordre FIXE, du plus grave au plus informatif (sinon l'ordre dépendrait de
          l'ordre des champs et bougerait d'une synchro à l'autre). */}
      {!enCours && (
        <>
          {/* ERREUR — §3.4 : fond + icône + message, jamais un rouge nu. */}
          {registre === "erreur" && retour?.erreur && (
            <Callout severite="danger" role="alert">
              {retour.erreur}
            </Callout>
          )}

          {/* ACCÈS À RÉTABLIR — réparation MFA et accès désaligné (403) mènent au MÊME
              écran : un seul callout, un seul geste. */}
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
