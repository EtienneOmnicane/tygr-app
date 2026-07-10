"use client";

/**
 * Démo / Visual QA (Quality Gate 4) de PR 2′ — NON destinée à la production.
 * Monte hors auth/DB les deux surfaces livrées par le lot :
 *
 *  1. `ModaleReconnexion` (D2 « Transverse ») dans ses deux états : au repos et en
 *     erreur (message non-énumérant E18, fond `danger-bg` + `role="alert"`).
 *  2. `ActionProtegee` / `BoutonProtege` (convention D2 #37) pour les trois rôles :
 *     MANAGER/ADMIN → action active ; VIEWER → action VISIBLE mais inerte, focusable,
 *     avec un tooltip qui explique POURQUOI (jamais cachée — seules les surfaces
 *     d'administration se cachent du DOM).
 *
 * Les actions sont des STUBS (aucun serveur, aucune Server Action) : c'est
 * précisément ce que permet la séparation vue pure / conteneur logique.
 */
import { useState } from "react";

import { BoutonProtege } from "@/components/ui/action-protegee";
import { ModaleReconnexion } from "@/components/shell/modale-reconnexion";
import { peutModifier } from "@/lib/permissions";
import type { WorkspaceRole } from "@/server/db/schema";

const ROLES: Array<{ role: WorkspaceRole; attendu: string }> = [
  { role: "ADMIN", attendu: "actions actives" },
  { role: "MANAGER", attendu: "actions actives" },
  {
    role: "VIEWER",
    attendu: "actions VISIBLES mais inertes + tooltip (jamais cachées)",
  },
];

const RAISON = "Votre rôle (lecture seule) ne permet pas de gérer les échéances.";

/**
 * La modale est `dismissible={false}` et son overlay (`fixed inset-0 z-50`) couvre
 * TOUTE la page : une fois ouverte, plus rien d'autre n'est cliquable — c'est le
 * comportement voulu (une session expirée n'est pas « annulable »), vérifié au QA
 * par `document.elementFromPoint`. La démo doit donc choisir l'état AVANT de la
 * monter, sinon ses propres boutons deviennent inatteignables.
 */
type EtatDemo = "ferme" | "repos" | "erreur";

const MESSAGE_ERREUR =
  "Identifiants invalides. Vérifiez votre email et votre mot de passe.";

export default function DemoSessionStates() {
  const [etatDemo, setEtatDemo] = useState<EtatDemo>("ferme");

  return (
    <div className="min-h-screen bg-surface-page">
      <section className="border-b border-line">
        <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Gating VIEWER — convention D2 #37 (désactivé + tooltip, PAS caché)
        </p>
        <div className="flex flex-col gap-4 p-6">
          {ROLES.map(({ role, attendu }) => (
            <div key={role} className="flex items-center gap-4">
              <span className="w-40 shrink-0 text-xs font-semibold text-text-muted">
                {role}
                <span className="block font-normal">{attendu}</span>
              </span>
              <div className="flex items-center gap-1">
                <BoutonProtege
                  autorise={peutModifier(role)}
                  raison={RAISON}
                  onClick={() => {}}
                  className="rounded-control px-2.5 py-1.5 text-[13px] font-medium text-text-muted
                    transition-colors hover:bg-surface-inset hover:text-text
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Modifier
                </BoutonProtege>
                <BoutonProtege
                  autorise={peutModifier(role)}
                  raison={RAISON}
                  onClick={() => {}}
                  className="rounded-control px-2.5 py-1.5 text-[13px] font-medium text-text-muted
                    transition-colors hover:bg-danger-bg hover:text-danger
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Supprimer
                </BoutonProtege>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Modale de reconnexion — session expirée (D2 « Transverse »)
        </p>
        <div className="flex gap-3 p-6">
          <button
            type="button"
            id="demo-repos"
            onClick={() => setEtatDemo("repos")}
            className="rounded-control bg-ink px-4 py-2 text-sm font-semibold text-text-onink"
          >
            Ouvrir — état repos
          </button>
          <button
            type="button"
            id="demo-erreur"
            onClick={() => setEtatDemo("erreur")}
            className="rounded-control bg-surface-inset px-4 py-2 text-sm font-semibold text-text"
          >
            Ouvrir — état erreur
          </button>
        </div>

        {/* Contenu SOUS la modale : il doit rester monté et lisible — c'est toute
            la promesse « sans perte de contexte ». */}
        <div
          id="contexte-preserve"
          className="mx-6 mb-6 rounded-card bg-surface-card p-6 shadow-card"
        >
          <p className="text-sm text-text-muted">
            Contexte de travail (formulaire, OTP du widget MFA…). La modale se
            superpose : ce bloc n&apos;est jamais démonté.
          </p>
        </div>

        {etatDemo !== "ferme" && (
          <ModaleReconnexion
            action={() => {}}
            erreur={etatDemo === "erreur" ? MESSAGE_ERREUR : null}
            enCours={false}
          />
        )}
      </section>
    </div>
  );
}
