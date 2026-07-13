"use client";

/**
 * Gestion des entités — créer / renommer / archiver (L2, PLAN-refonte-entites.md).
 *
 * POURQUOI UNE LISTE DÉDIÉE, et pas des actions posées sur les en-têtes de groupe du
 * tableau (Q-ENTITE-VIDE) : `grouperParEntite` **masque les groupes vides** (exprès, pour
 * que la recherche ne laisse pas des en-têtes orphelins). Une entité fraîchement créée
 * porte 0 compte → elle n'aurait AUCUN en-tête → le CTA « Create entity » aurait produit
 * un objet invisible, ni renommable ni archivable. La liste, elle, montre TOUTES les
 * entités actives, y compris les vides.
 *
 * ZÉRO serveur neuf : les trois Server Actions existent déjà (`creerEntiteAction`,
 * `renommerEntiteAction`, `archiverEntiteAction`) — gardées ADMIN, zod strict, erreurs
 * nommées. Ce lot n'écrit que la surface.
 *
 * ARCHIVAGE — le serveur REFUSE d'archiver une entité qui porte encore des comptes ou des
 * droits de membres (`EntiteNonVideError`, Q-ARCHIVAGE) : archiver ne révoque RIEN, et un
 * membre scopé continuerait de voir les comptes sans que l'admin puisse le constater. On
 * ne réimplémente pas ce contrôle ici — l'UI affiche ce que le serveur refuse. Le bouton
 * est simplement pré-désactivé quand on SAIT déjà que l'entité porte des comptes, pour
 * éviter un aller-retour inutile ; la garde de vérité reste serveur.
 *
 * Pas de `<form action>` avec le Select maison ici (aucun Select) : de simples champs
 * texte. La fermeture de la modale après succès se fait dans le WRAPPER de
 * `useActionState`, jamais dans un `useEffect` (règle `react-hooks/set-state-in-effect`).
 *
 * Tokens sémantiques uniquement. Texte en ANGLAIS (Q-LANG).
 */
import { useActionState, useState } from "react";

import { Modal } from "@/components/ui/modal/modal";
import { cn } from "@/components/ui/states/primitives";

import {
  archiverEntiteAction,
  creerEntiteAction,
  renommerEntiteAction,
  type EtatAction,
} from "./actions";

/** Entité telle que gérée ici : le `nbComptes` vient de l'agrégat SQL de `listerEntites`. */
export interface EntiteGeree {
  id: string;
  nom: string;
  code: string | null;
  nbComptes: number;
}

const ETAT_INITIAL: EtatAction = { erreur: null, succes: null };

type Modale =
  | { mode: "creer" }
  | { mode: "renommer"; entite: EntiteGeree }
  | { mode: "archiver"; entite: EntiteGeree };

export function GestionEntites({ entites }: { entites: EntiteGeree[] }) {
  const [modale, setModale] = useState<Modale | null>(null);
  const fermer = () => setModale(null);

  return (
    <section className="rounded-card border border-line bg-surface-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Entities</h2>
          <p className="text-xs text-text-muted">
            The business units accounts are attached to.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModale({ mode: "creer" })}
          className="h-10 shrink-0 rounded-control bg-primary px-4 text-sm font-semibold
            text-white transition-colors hover:bg-primary-600 focus:outline-none
            focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Create entity
        </button>
      </div>

      {entites.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-text-muted">
          No entity yet. Create one to start grouping your bank accounts.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {entites.map((entite) => (
            <li
              key={entite.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {entite.nom}
                  {entite.code && (
                    <span className="ml-2 text-xs font-normal text-text-faint">
                      {entite.code}
                    </span>
                  )}
                </p>
                <p className="text-xs text-text-muted tabular-nums">
                  {entite.nbComptes} account{entite.nbComptes === 1 ? "" : "s"}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setModale({ mode: "renommer", entite })}
                  className="h-8 rounded-control px-3 text-xs font-medium text-text-muted
                    transition-colors hover:bg-surface-inset hover:text-text
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => setModale({ mode: "archiver", entite })}
                  // Pré-désactivé quand on SAIT déjà que le serveur refusera (l'entité
                  // porte des comptes). Ce n'est qu'un raccourci d'UX : la garde de vérité
                  // est serveur (EntiteNonVideError), et elle voit AUSSI les droits des
                  // membres, que cet écran ne connaît pas.
                  disabled={entite.nbComptes > 0}
                  title={
                    entite.nbComptes > 0
                      ? "Move its accounts elsewhere first — archiving would not revoke anyone's access."
                      : undefined
                  }
                  className={cn(
                    "h-8 rounded-control px-3 text-xs font-medium transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40",
                    entite.nbComptes > 0
                      ? "cursor-not-allowed text-text-faint opacity-[0.48]"
                      : "text-danger hover:bg-danger-bg",
                  )}
                >
                  Archive
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {modale?.mode === "creer" && <ModaleCreer onFerme={fermer} />}
      {modale?.mode === "renommer" && (
        <ModaleRenommer entite={modale.entite} onFerme={fermer} />
      )}
      {modale?.mode === "archiver" && (
        <ModaleArchiver entite={modale.entite} onFerme={fermer} />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Retour d'action : erreur (fond + icône + message, §3.4)             */
/* ------------------------------------------------------------------ */

function Erreur({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control bg-danger-bg px-3 py-2 text-sm text-danger"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M8 4.75v3.75M8 11.1v.05"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      {message}
    </p>
  );
}

function ChampTexte({
  nom,
  libelle,
  defaut,
  autoFocus,
  maxLength,
  requis = true,
  aide,
}: {
  nom: string;
  libelle: string;
  defaut?: string;
  autoFocus?: boolean;
  maxLength: number;
  requis?: boolean;
  aide?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text">{libelle}</span>
      <input
        name={nom}
        type="text"
        defaultValue={defaut}
        autoFocus={autoFocus}
        required={requis}
        maxLength={maxLength}
        className="h-10 rounded-control border border-line bg-white px-3 text-sm
          placeholder:text-text-faint focus:border-primary focus:outline-none
          focus:ring-2 focus:ring-primary/30"
      />
      {aide && <span className="text-xs text-text-faint">{aide}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Modales                                                             */
/* ------------------------------------------------------------------ */

function PiedModale({
  enCours,
  libelle,
  libelleEnCours,
  onAnnuler,
  destructif = false,
}: {
  enCours: boolean;
  libelle: string;
  libelleEnCours: string;
  onAnnuler: () => void;
  destructif?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onAnnuler}
        disabled={enCours}
        className="h-10 rounded-control px-4 text-sm font-medium text-text-muted
          transition-colors hover:text-text focus:outline-none focus-visible:ring-2
          focus-visible:ring-primary/40 disabled:opacity-[0.48]"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={enCours}
        className={cn(
          "h-10 rounded-control px-4 text-sm font-semibold text-white transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-[0.48]",
          destructif
            ? "bg-danger hover:opacity-90 focus-visible:ring-danger"
            : "bg-primary hover:bg-primary-600 focus-visible:ring-primary",
        )}
      >
        {enCours ? libelleEnCours : libelle}
      </button>
    </div>
  );
}

function ModaleCreer({ onFerme }: { onFerme: () => void }) {
  // La fermeture vit dans le WRAPPER de l'action, pas dans un useEffect : réagir au succès
  // depuis un effet déclencherait `react-hooks/set-state-in-effect` et ferait clignoter
  // l'erreur précédente avant la fermeture.
  const [etat, action, enCours] = useActionState(
    async (prec: EtatAction, formData: FormData) => {
      const res = await creerEntiteAction(prec, formData);
      if (res.succes !== null) onFerme();
      return res;
    },
    ETAT_INITIAL,
  );

  return (
    <Modal
      open
      onClose={onFerme}
      title="Create entity"
      size="sm"
      libelleFermer="Close"
    >
      <form action={action} className="flex flex-col gap-4">
        <ChampTexte
          nom="name"
          libelle="Name"
          autoFocus
          maxLength={120}
          aide="For example: Sucrière, Energy, Logistics."
        />
        <ChampTexte
          nom="code"
          libelle="Code (optional)"
          maxLength={40}
          requis={false}
          aide="A short label, if your group uses one."
        />
        {etat.erreur !== null && <Erreur message={etat.erreur} />}
        <PiedModale
          enCours={enCours}
          libelle="Create"
          libelleEnCours="Creating…"
          onAnnuler={onFerme}
        />
      </form>
    </Modal>
  );
}

function ModaleRenommer({
  entite,
  onFerme,
}: {
  entite: EntiteGeree;
  onFerme: () => void;
}) {
  const [etat, action, enCours] = useActionState(
    async (prec: EtatAction, formData: FormData) => {
      const res = await renommerEntiteAction(prec, formData);
      if (res.succes !== null) onFerme();
      return res;
    },
    ETAT_INITIAL,
  );

  return (
    <Modal
      open
      onClose={onFerme}
      title="Rename entity"
      size="sm"
      libelleFermer="Close"
    >
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="entityId" value={entite.id} />
        <ChampTexte
          nom="name"
          libelle="Name"
          defaut={entite.nom}
          autoFocus
          maxLength={120}
        />
        {etat.erreur !== null && <Erreur message={etat.erreur} />}
        <PiedModale
          enCours={enCours}
          libelle="Rename"
          libelleEnCours="Renaming…"
          onAnnuler={onFerme}
        />
      </form>
    </Modal>
  );
}

function ModaleArchiver({
  entite,
  onFerme,
}: {
  entite: EntiteGeree;
  onFerme: () => void;
}) {
  const [etat, action, enCours] = useActionState(
    async (prec: EtatAction, formData: FormData) => {
      const res = await archiverEntiteAction(prec, formData);
      if (res.succes !== null) onFerme();
      return res;
    },
    ETAT_INITIAL,
  );

  return (
    // `dismissible={false}` : surface destructive — Échap et le clic sur l'overlay ne
    // ferment pas (UI_GUIDELINES §4.4). L'admin tranche explicitement.
    <Modal
      open
      onClose={onFerme}
      title="Archive entity"
      size="sm"
      libelleFermer="Close"
      dismissible={false}
    >
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="entityId" value={entite.id} />
        <p className="text-sm text-text">
          Archive <span className="font-semibold">{entite.nom}</span>? It
          disappears from every picker. Accounts already attached to it, and
          members whose access is limited to it, must be moved first — archiving
          does not revoke anyone’s access on its own.
        </p>
        {etat.erreur !== null && <Erreur message={etat.erreur} />}
        <PiedModale
          enCours={enCours}
          libelle="Archive"
          libelleEnCours="Archiving…"
          onAnnuler={onFerme}
          destructif
        />
      </form>
    </Modal>
  );
}
