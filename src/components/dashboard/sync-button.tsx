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
 * MFA, hors de propos ici). Posé dans l'en-tête du dashboard, à côté de la pastille de
 * fraîcheur du solde (`BalanceFreshnessPill`) : l'utilisateur rafraîchit là où il lit
 * l'âge de la donnée.
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
 *
 * ⚠️ CONTRAT D'AFFICHAGE (revue PR #202) — deux sources, à ne jamais confondre :
 *  - le TEXTE du message est celui du SERVEUR (`erreur` / `succes` / `info`). Aucun statut
 *    en dur ici : ce bouton affichait « Comptes à jour. » sans lire `succes`, si bien qu'une
 *    banque en échec dur (fail-soft ⇒ `erreur` reste `null`) ressortait en VERT ;
 *  - le TON vient de `registreSynchro` (module pur, testé), qui décide à partir des signaux
 *    STRUCTURÉS — jamais en parsant la phrase. Le vert exige zéro réserve.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { cn } from "@/components/ui/states/primitives";
import { IconeSynchro } from "@/components/ui/icons/icone-synchro";
import type { EtatFinalisation } from "@/app/(workspace)/banques/actions";
import { synchroniserConnexionsAction } from "@/app/(workspace)/banques/actions";
import { registreSynchro } from "@/components/sync/registre-synchro";

export function SyncButton({ role }: { role: WorkspaceRole }) {
  const router = useRouter();
  const [enCours, demarrer] = useTransition();
  // On consomme le type SOURCE (`EtatFinalisation`), jamais une re-déclaration locale.
  // C'était la dette SYNC-TYPE-STRUCTUREL1 : un sous-type structurel accepte un objet qui
  // porte PLUS de champs, donc omettre un signal n'échouait pas au typecheck — il était
  // ignoré EN SILENCE. `info` en avait déjà fait les frais (bouton muet sur « aucune banque
  // à synchroniser ») ; `echecs` et `rateLimited` y étaient encore, d'où le vert triomphal
  // par-dessus une banque morte. En pointant le type source, tout nouveau signal est
  // visible ici — et le rendu ci-dessous décide de son registre au lieu de l'ignorer.
  const [retour, setRetour] = useState<EtatFinalisation | null>(null);

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
  // TON du message (logique pure, testée) : le vert est réservé à une synchro SANS la
  // moindre réserve. Échec dur, scrape encore en cours, cooldown, réparation, reconnexion
  // → registre NEUTRE. Le TEXTE, lui, vient intégralement du serveur (ci-dessous).
  const registre = registreSynchro(retour ?? null);

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

      {/* MESSAGE DE STATUT — le TEXTE vient du SERVEUR, jamais d'un littéral posé ici.
          C'était la cause racine du faux message de victoire : l'action construit déjà la
          phrase EXACTE (banques à jour, échecs, scrape en cours, cooldown, réparations…),
          et ce bouton la jetait pour afficher « Comptes à jour. » en dur, en vert, dès que
          `succes` était non nul. /banques, lui, l'affichait — d'où deux écrans qui se
          contredisaient sur la même synchro. Le TON vient de `registreSynchro` (pur, testé) :
          vert UNIQUEMENT si aucune réserve ne subsiste. */}
      {registre === "erreur" && (
        <p role="alert" className="max-w-xs text-right text-xs text-danger">
          {retour?.erreur}
        </p>
      )}

      {(registre === "succes" || registre === "neutre") && (
        <p
          role="status"
          className={cn(
            "max-w-xs text-right text-xs",
            registre === "succes" ? "text-success" : "text-text-muted",
          )}
        >
          {retour?.succes}
        </p>
      )}

      {/* CTA — l'ACTION à mener, jamais un statut (le message ci-dessus l'a déjà dit, et il
          COMPTE les banques concernées). Un texte de statut en dur ici doublerait le message
          serveur et finirait par le contredire : on ne garde que le lien. Réparation MFA et
          accès désaligné mènent au MÊME écran — un seul lien suffit. */}
      {registre !== "erreur" && (aReparer || aReconnecter) && (
        <p className="text-right text-xs">
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

      {/* INFORMATION actionnable — le canal qui manquait ICI. Sans lui, une synchro sans rien
          à traiter (`{erreur:null, succes:null}`) ne rendait AUCUN nœud : clic → spinner →
          rien, sur l'écran d'accueil. Il s'affiche AUSSI à côté d'un succès : une banque qui
          ne répond plus resterait sinon invisible derrière le vert « Comptes à jour ».
          Registre neutre (`text-muted`) : ni rouge (rien n'a échoué), ni vert (rien n'a réussi). */}
      {retour?.info && (
        <p role="status" className="max-w-xs text-right text-xs text-text-muted">
          {retour.info}
        </p>
      )}
    </div>
  );
}
