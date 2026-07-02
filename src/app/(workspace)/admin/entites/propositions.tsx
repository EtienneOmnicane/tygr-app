"use client";

/**
 * Sas de VALIDATION des propositions Party → entité (ENTITY-PARTY1, décision PO
 * 2026-07-02 : PRÉ-REMPLISSAGE + VALIDATION ADMIN). Composant CLIENT « présentation +
 * confirmation » : il reçoit en props les propositions lues côté serveur
 * (`listerPropositionsPartyEntite`, dans withWorkspace) et n'a AUCUNE logique de
 * décision d'isolation — il PROPOSE, l'ADMIN confirme, et la confirmation passe par la
 * vraie Server Action `confirmerPropositionAction` (./actions.ts).
 *
 * INVARIANT respecté ici : rien n'est écrit tant que l'ADMIN ne clique pas « Confirmer ».
 * Le widget / l'ingestion n'a posé aucun entity_id ; cet écran est le seul chemin.
 *
 * Tokens & conventions UI_GUIDELINES (§1.1/§2.2/§2.3). Pas de dépendance externe
 * (clsx/cva/lucide — règle 9) : micro-helper `cn` local + SVG inline.
 */
import { useMemo, useState } from "react";
import { useActionState } from "react";

import { confirmerPropositionAction, type EtatAction } from "./actions";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Compte porté par une proposition (projection de CompteDeProposition côté serveur). */
export interface CompteVue {
  bankAccountId: string;
  accountName: string;
  currency: string;
  /** entity_id actuel du compte (null = non assigné). */
  entityIdActuel: string | null;
}

/** Une proposition Party→entité (projection de PropositionEntite côté serveur). */
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

export function PropositionsPartyEntite({
  propositions,
  entites,
}: {
  propositions: PropositionVue[];
  entites: EntiteCible[];
}) {
  if (propositions.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
        Aucune proposition : aucune « Party » Omni-FI active n’est disponible pour
        ce workspace, ou toutes ont déjà été traitées.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {propositions.map((p) => (
        <CarteProposition key={p.partyId} proposition={p} entites={entites} />
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Carte d'une proposition : cible d'entité + comptes + confirmation   */
/* ------------------------------------------------------------------ */

function CarteProposition({
  proposition,
  entites,
}: {
  proposition: PropositionVue;
  entites: EntiteCible[];
}) {
  const nomPropose = proposition.partyName ?? "(party sans nom)";

  // Cible par défaut : une entité déjà rattachée > une entité homonyme existante >
  // « créer une nouvelle entité » (valeur sentinelle "__new__").
  const cibleInitiale =
    proposition.entiteDejaRattacheeId ??
    proposition.entiteExistanteId ??
    "__new__";
  const [cible, setCible] = useState<string>(cibleInitiale);

  // Comptes pré-cochés : ceux qui ne sont pas déjà assignés à une autre entité
  // (on ne re-propose pas de déplacer un compte déjà rangé — l'ADMIN peut cocher
  // manuellement s'il le souhaite).
  const [comptesCoches, setComptesCoches] = useState<string[]>(() =>
    proposition.comptes
      .filter((c) => c.entityIdActuel === null)
      .map((c) => c.bankAccountId),
  );

  const [etat, action, enCours] = useActionState(
    confirmerPropositionAction,
    ETAT_INITIAL,
  );

  const creationNouvelle = cible === "__new__";

  // Le nom d'entité proposé n'existe qu'à la création. Une party sans nom ne peut
  // PAS créer d'entité (name NOT NULL borné) → on force le choix d'une entité existante.
  const peutConfirmer = useMemo(() => {
    if (comptesCoches.length === 0 && cible === proposition.entiteDejaRattacheeId)
      return false; // rien à faire (déjà rattachée, aucun compte à bouger)
    if (creationNouvelle && proposition.partyName === null) return false;
    return true;
  }, [comptesCoches, cible, creationNouvelle, proposition]);

  function toggleCompte(id: string) {
    setComptesCoches((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <li className="rounded-card border border-line bg-surface-card p-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="partyId" value={proposition.partyId} />
        {/* Cible : soit une entité existante (entityId), soit création par nom. */}
        {!creationNouvelle && (
          <input type="hidden" name="entityId" value={cible} />
        )}
        {creationNouvelle && proposition.partyName !== null && (
          <input
            type="hidden"
            name="nouvelleEntiteName"
            value={proposition.partyName}
          />
        )}
        {comptesCoches.map((id) => (
          <input key={id} type="hidden" name="bankAccountIds" value={id} />
        ))}

        {/* En-tête : nom proposé + badge « déjà rattachée » */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">{nomPropose}</p>
            <p className="text-xs text-text-muted">
              {proposition.comptes.length} compte
              {proposition.comptes.length > 1 ? "s" : ""} rattaché
              {proposition.comptes.length > 1 ? "s" : ""} à cette party
            </p>
          </div>
          {proposition.entiteDejaRattacheeId !== null && (
            <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs text-success">
              Déjà rattachée
            </span>
          )}
        </div>

        {/* Cible d'entité */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted">Entité cible</span>
          <select
            value={cible}
            onChange={(e) => setCible(e.target.value)}
            className="h-10 rounded-control border border-line bg-white px-3 text-sm
              focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="__new__" disabled={proposition.partyName === null}>
              {proposition.partyName === null
                ? "Créer une entité (nom requis — indisponible)"
                : `Créer l’entité « ${proposition.partyName} »`}
            </option>
            {entites.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nom}
              </option>
            ))}
          </select>
        </label>

        {/* Comptes de la party */}
        {proposition.comptes.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-text-muted">
              Comptes à rattacher
            </legend>
            {proposition.comptes.map((c) => (
              <label
                key={c.bankAccountId}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={comptesCoches.includes(c.bankAccountId)}
                  onChange={() => toggleCompte(c.bankAccountId)}
                  className="size-4 rounded border-line accent-primary"
                />
                <span className="text-ink">{c.accountName}</span>
                <span className="text-xs text-text-faint">{c.currency}</span>
                {c.entityIdActuel !== null && (
                  <span className="text-xs text-warning">déjà assigné</span>
                )}
              </label>
            ))}
          </fieldset>
        )}

        {/* Messages + action */}
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
            disabled={enCours || !peutConfirmer}
            className="h-9 rounded-control bg-primary px-4 text-sm font-medium text-white
              disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enCours ? "Confirmation…" : "Confirmer"}
          </button>
        </div>
      </form>
    </li>
  );
}
