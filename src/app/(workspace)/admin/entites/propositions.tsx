"use client";

/**
 * Suggestions de rattachement, dérivées des données bancaires (L4 de
 * `PLAN-refonte-entites.md`). Anciennement « sas de propositions Party → entité ».
 *
 * CE QUI CHANGE : la surface, pas la logique. C'était une SECTION jargonneuse en tête
 * d'écran (« Propositions d'entités (Parties Omni-FI) ») — un directeur financier n'a
 * jamais entendu parler d'une « Party ». C'est désormais une **bannière contextuelle**
 * dans l'étape « ranger les comptes », là où le geste a du sens ; le détail vit dans un
 * **panneau** qu'on ouvre pour vérifier.
 *
 * 🔒 INVARIANT INCHANGÉ (ENTITY-PARTY1) : rien n'est écrit sans confirmation EXPLICITE de
 * l'admin. L'ingestion ne pose jamais d'`entity_id` ; `confirmerPropositionAction` reste
 * le seul chemin qui en pose un dérivé d'une party, sous garde ADMIN. On a déplacé un
 * rendu, on n'a pas ouvert une porte.
 *
 * PRINCIPE MÉTIER (Q2-bis, Etienne) : les données Omni-FI sont prises À L'EXACTITUDE.
 * **Jamais d'auto-fusion** : quand une entité au nom PROCHE existe déjà (« Sucrière » vs
 * « SUCRIÈRE »), on **SURFACE** le doublon et on laisse l'admin **basculer** — on ne
 * décide pas à sa place, et on ne refuse pas non plus (Q-CASSE : aucune migration,
 * l'unicité de `entities` reste sensible à la casse).
 *
 * Correctifs de cross-review intégrés (§11-S3) :
 *  - le panneau est **monté à l'ouverture** (`{ouvert && …}`), jamais caché en CSS ;
 *  - un **compteur de mutations** entre dans la `key` des cartes. Sans lui : après une
 *    confirmation, `revalidatePath` re-rend l'arbre mais NE REMONTE PAS les composants
 *    (même type, même position, même `key`) → l'initialiseur de `useState` ne rejoue pas,
 *    et les cases survivent PÉRIMÉES. Un « Attach » sur cet état réassignerait des comptes
 *    que l'admin vient de ranger ailleurs ;
 *  - `peutConfirmer` se dérive des **props**, jamais du seul état monté.
 *
 * Texte en ANGLAIS (Q-LANG). Tokens sémantiques uniquement, zéro dépendance externe.
 */
import { useActionState, useMemo, useState } from "react";

import { Modal } from "@/components/ui/modal/modal";
import { Select, type OptionSelect } from "@/components/ui/select";
import { basculerGroupe, etatSelectionGroupe } from "@/lib/selection-groupe";

import { confirmerPropositionAction, type EtatAction } from "./actions";
import { libelleCompte } from "./assignation-comptes";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Compte porté par une suggestion (projection de `CompteDeProposition`). */
export interface CompteVue {
  bankAccountId: string;
  accountName: string;
  currency: string;
  /** Identifiant de repli — requis par `libelleCompte()`, la source unique (Q2). */
  institutionName: string | null;
  /** entity_id actuel du compte (null = non assigné). */
  entityIdActuel: string | null;
}

/** Une suggestion (projection de `PropositionEntite`). */
export interface PropositionVue {
  partyId: string;
  partyName: string | null;
  entiteDejaRattacheeId: string | null;
  entiteExistanteId: string | null;
  comptes: CompteVue[];
}

/** Entité active (cible possible d'un rattachement). */
export interface EntiteCible {
  id: string;
  nom: string;
}

const ETAT_INITIAL: EtatAction = { erreur: null, succes: null };

/** Sentinelle « créer l'entité proposée » — conservée du sas d'origine. */
const CREER = "__new__";

/** Comptes qu'une suggestion peut encore rattacher (ceux qui ne le sont pas déjà). */
function comptesRattachables(p: PropositionVue): CompteVue[] {
  return p.comptes.filter((c) => c.entityIdActuel === null);
}

/* ------------------------------------------------------------------ */
/* Bannière — le point d'entrée, dans l'étape « ranger les comptes »   */
/* ------------------------------------------------------------------ */

export function BanniereSuggestions({
  propositions,
  entites,
}: {
  propositions: PropositionVue[];
  entites: EntiteCible[];
}) {
  const [ouvert, setOuvert] = useState(false);

  const nbRattachables = useMemo(
    () => propositions.reduce((n, p) => n + comptesRattachables(p).length, 0),
    [propositions],
  );

  // Rien à suggérer → pas de bannière du tout. L'ancienne section affichait « Aucune
  // proposition » en permanence, en TÊTE d'écran : du bruit à la place du reste-à-faire.
  if (nbRattachables === 0) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-accent/30 bg-accent/5 px-4 py-3">
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="size-5 shrink-0 text-accent"
        >
          <path
            d="M10 2.5a5 5 0 0 0-3 9v1.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V11.5a5 5 0 0 0-3-9Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M8.25 17h3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>

        <p className="flex-1 text-sm text-text">
          <span className="font-semibold tabular-nums">
            {nbRattachables} account{nbRattachables > 1 ? "s" : ""}
          </span>{" "}
          can be attached automatically, based on who owns them in your bank
          data. Nothing is saved until you confirm.
        </p>

        <button
          type="button"
          onClick={() => setOuvert(true)}
          className="h-10 shrink-0 rounded-control bg-primary px-4 text-sm font-semibold
            text-white transition-colors hover:bg-primary-600 focus:outline-none
            focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Review
        </button>
      </div>

      {/* MONTÉ à l'ouverture, jamais caché en CSS : l'état des cases se reconstruit donc
          depuis des props fraîches à chaque ouverture (§11-S3). */}
      {ouvert && (
        <PanneauVerification
          propositions={propositions}
          entites={entites}
          onFerme={() => setOuvert(false)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Panneau de vérification                                             */
/* ------------------------------------------------------------------ */

function PanneauVerification({
  propositions,
  entites,
  onFerme,
}: {
  propositions: PropositionVue[];
  entites: EntiteCible[];
  onFerme: () => void;
}) {
  // Compteur de mutations : incrémenté à chaque confirmation réussie. Il entre dans la
  // `key` des cartes → React les REMONTE, et leur état (cases, cible) se reconstruit depuis
  // les props que `revalidatePath` vient de rafraîchir (§11-S3).
  const [mutations, setMutations] = useState(0);

  const aTraiter = propositions.filter((p) => comptesRattachables(p).length > 0);

  return (
    <Modal open onClose={onFerme} title="Suggested attachments" size="xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Each suggestion groups the accounts your bank reports under the same
          owner. Review them and attach — or leave an account out: it simply
          stays unassigned.
        </p>

        {aTraiter.length === 0 ? (
          <p className="rounded-card border border-dashed border-line p-8 text-center text-sm text-text-muted">
            Nothing left to review — every suggested account is already attached
            to an entity.
          </p>
        ) : (
          <ul className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {aTraiter.map((p) => (
              <CarteSuggestion
                key={`${p.partyId}-${mutations}`}
                proposition={p}
                entites={entites}
                onConfirme={() => setMutations((n) => n + 1)}
              />
            ))}
          </ul>
        )}

        {/* Compromis assumé (décision D2, 8 juillet) : aucune mémoire du « non ». Le dire
            plutôt que de le laisser découvrir au sync suivant. */}
        <p className="rounded-control bg-surface-inset px-3 py-2 text-xs text-text-muted">
          An account you leave out stays unassigned — and invisible to members
          with restricted access. It will be suggested again after the next bank
          sync: we do not record a refusal.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Une suggestion                                                      */
/* ------------------------------------------------------------------ */

/** Normalisation pour DÉTECTER un doublon — jamais pour le fusionner (Q2-bis). */
function normaliser(nom: string): string {
  return nom.trim().toLocaleLowerCase();
}

function CarteSuggestion({
  proposition,
  entites,
  onConfirme,
}: {
  proposition: PropositionVue;
  entites: EntiteCible[];
  onConfirme: () => void;
}) {
  const nomPropose = proposition.partyName;
  const rattachables = comptesRattachables(proposition);

  /**
   * DOUBLON SURFACÉ, jamais fusionné (Q2-bis + Q-CASSE).
   *
   * Le serveur ne rapproche une party d'une entité que sur un nom STRICTEMENT identique
   * (`entiteExistanteId`). L'unicité de `entities` est sensible à la casse, et on a décidé
   * de NE PAS la durcir : « SUCRIÈRE » et « Sucrière » peuvent coexister. Plutôt que de
   * créer un quasi-doublon en silence — ou de refuser sans rien expliquer — on MONTRE à
   * l'admin que l'entité existe déjà, et on lui laisse le geste.
   */
  const doublon = useMemo(() => {
    if (nomPropose === null || proposition.entiteExistanteId !== null) {
      return null;
    }
    const cible = normaliser(nomPropose);
    return entites.find((e) => normaliser(e.nom) === cible) ?? null;
  }, [nomPropose, proposition.entiteExistanteId, entites]);

  const [cible, setCible] = useState<string>(
    proposition.entiteDejaRattacheeId ??
      proposition.entiteExistanteId ??
      doublon?.id ??
      CREER,
  );

  const [coches, setCoches] = useState<ReadonlySet<string>>(
    () => new Set(rattachables.map((c) => c.bankAccountId)),
  );

  const [etat, action, enCours] = useActionState(
    async (prec: EtatAction, formData: FormData) => {
      const res = await confirmerPropositionAction(prec, formData);
      // La mutation est remontée dans le WRAPPER de l'action (jamais dans un useEffect —
      // règle `react-hooks/set-state-in-effect`) → la carte est remontée avec des props
      // fraîches.
      if (res.succes !== null) onConfirme();
      return res;
    },
    ETAT_INITIAL,
  );

  const creationNouvelle = cible === CREER;

  /**
   * Dérivé des PROPS (`rattachables`), pas d'un état monté qui pourrait être périmé.
   * Le bouton n'est actif que s'il y a un VRAI changement à appliquer : l'ancien restait
   * actif même sans rien à faire, d'où l'impression de « réassigner à l'infini sans
   * effet » (Lot 3 du plan v1).
   */
  const peutConfirmer =
    !enCours &&
    coches.size > 0 &&
    !(creationNouvelle && nomPropose === null);

  const etatGroupe = etatSelectionGroupe(rattachables, coches);

  const optionsCible = useMemo<OptionSelect[]>(
    () => [
      {
        value: CREER,
        label:
          nomPropose === null
            ? "Create an entity (a name is required — unavailable)"
            : `Create the entity “${nomPropose}”`,
        disabled: nomPropose === null,
      },
      ...entites.map((e) => ({ value: e.id, label: e.nom })),
    ],
    [nomPropose, entites],
  );

  return (
    <li className="rounded-card border border-line bg-surface-card p-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="partyId" value={proposition.partyId} />
        {!creationNouvelle && (
          <input type="hidden" name="entityId" value={cible} />
        )}
        {creationNouvelle && nomPropose !== null && (
          <input type="hidden" name="nouvelleEntiteName" value={nomPropose} />
        )}
        {[...coches].map((id) => (
          <input key={id} type="hidden" name="bankAccountIds" value={id} />
        ))}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {nomPropose ?? "(unnamed owner)"}
            </p>
            <p className="text-xs text-text-muted tabular-nums">
              {rattachables.length} account
              {rattachables.length > 1 ? "s" : ""} to attach
            </p>
          </div>
          {proposition.entiteDejaRattacheeId !== null && (
            <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs text-success">
              Already linked
            </span>
          )}
        </div>

        {/* Doublon SURFACÉ — on montre, on ne fusionne pas. */}
        {doublon && (
          <div className="flex flex-wrap items-center gap-2 rounded-control bg-warning-bg px-3 py-2 text-xs text-warning">
            <span className="flex-1">
              An entity named <strong>{doublon.nom}</strong> already exists.
              Attach to it rather than creating a near-duplicate?
            </span>
            <button
              type="button"
              onClick={() => setCible(doublon.id)}
              className="shrink-0 rounded-control bg-warning/15 px-2 py-1 font-medium
                underline focus:outline-none focus-visible:ring-2
                focus-visible:ring-warning/40"
            >
              Use “{doublon.nom}”
            </button>
          </div>
        )}

        <div className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted">Attach to</span>
          <Select
            value={cible}
            onChange={setCible}
            options={optionsCible}
            ariaLabel="Attach to"
            className="w-full"
          />
        </div>

        {rattachables.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Accounts to attach</legend>

            {/* « Tout cocher » tri-état : sans lui, écarter 1 compte sur 40 impose 39 clics
                (Lot 1 du plan v1). L'état indéterminé se pose sur la PROPRIÉTÉ DOM, via une
                ref — ce n'est pas un attribut HTML. */}
            <label className="flex items-center gap-2 text-xs font-medium text-text-muted">
              <input
                type="checkbox"
                checked={etatGroupe === "tous"}
                ref={(el) => {
                  if (el) el.indeterminate = etatGroupe === "partiel";
                }}
                onChange={() =>
                  setCoches((prev) => basculerGroupe(prev, rattachables))
                }
                className="size-4 rounded border-line accent-primary"
              />
              <span className="tabular-nums">
                Select all · {coches.size} of {rattachables.length} selected
              </span>
            </label>

            {/* Défilable : une party à 40 comptes ne doit pas dérouler tout le panneau. */}
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-control border border-line p-2">
              {rattachables.map((c) => (
                <label
                  key={c.bankAccountId}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={coches.has(c.bankAccountId)}
                    onChange={() =>
                      setCoches((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.bankAccountId)) {
                          next.delete(c.bankAccountId);
                        } else {
                          next.add(c.bankAccountId);
                        }
                        return next;
                      })
                    }
                    className="size-4 shrink-0 rounded border-line accent-primary"
                  />
                  {/* Libellé par la SOURCE UNIQUE (Q2). Sans `institutionName`, les 77
                      comptes sans nom s'afficheraient « Account 1a2b3c4d » et perdraient
                      leur banque — précisément ceux qu'on cherche à identifier. */}
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {libelleCompte(c)}
                  </span>
                  <span className="shrink-0 text-xs text-text-faint">
                    {c.currency}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex items-center justify-between gap-3">
          <p
            className={cn(
              "text-xs",
              etat.erreur && "text-danger",
              etat.succes && "text-success",
            )}
            role={etat.erreur ? "alert" : undefined}
          >
            {etat.erreur ?? etat.succes ?? ""}
          </p>
          <button
            type="submit"
            disabled={!peutConfirmer}
            className="h-10 rounded-control bg-primary px-4 text-sm font-semibold text-white
              transition-colors hover:bg-primary-600 focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2
              disabled:cursor-not-allowed disabled:opacity-[0.48]"
          >
            {enCours ? "Attaching…" : "Attach"}
          </button>
        </div>
      </form>
    </li>
  );
}
