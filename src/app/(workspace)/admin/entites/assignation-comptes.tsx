"use client";

/**
 * Section « Assignation des comptes » (L7, PLAN-admin-entites-assignation-comptes.md).
 * Surface ADMIN à plat : chaque compte bancaire du workspace porte un `Select` d'entité
 * (BU), incluant « — Non assigné — ». C'est la SEULE surface qui permette la
 * DÉ-assignation (entityId = null) : le sas de propositions (section 1) ne sait
 * qu'assigner, et seulement les comptes portés par une Party Omni-FI.
 *
 * Données reçues en props depuis la page RSC (`listerComptesAvecEntite`, lu sous
 * withWorkspace + garde ADMIN du repo). L'enregistrement passe par la vraie Server
 * Action `assignerCompteAction` (./actions.ts), PAR compte, via <form> + useActionState.
 * Aucune logique d'isolation ici : le composant affiche et poste, la RLS + la garde
 * ADMIN décident.
 *
 * ⚠️ AUCUN montant affiché (règle 8) : nom de compte + devise, jamais de solde. Le
 * contrat serveur `CompteAvecEntite` ne le remonte pas — on n'ouvre pas de surface de
 * manipulation de float sur cet écran d'administration.
 *
 * PATTERN INAUGURÉ ICI — `Select` maison + <form action> : `Select` rend un
 * `<button role="combobox">`, PAS un champ natif : il ne poste rien tout seul. Sa valeur
 * est donc miroitée dans un `<input type="hidden" name="entityId">` qui lui est FRÈRE
 * (jamais imbriqué dans le <label>, qui doit pointer l'`id` du trigger via htmlFor).
 *
 * Tokens & conventions UI_GUIDELINES (§1.1/§2.2/§2.3/§4.4). Pas de dépendance externe
 * (clsx/cva/lucide — règle 9) : SVG inline, classes statiques.
 */
import { useMemo, useState } from "react";
import { useActionState } from "react";

import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/states";

import { assignerCompteAction, type EtatAction } from "./actions";
import type { EntiteVue } from "./assignation-entites";

/** Compte + son entité courante (projection de `CompteAvecEntite` côté page). */
export interface CompteVueAssignation {
  bankAccountId: string;
  accountName: string;
  currency: string;
  /** entity_id actuel ; `null` = non assigné. */
  entityId: string | null;
}

const ETAT_INITIAL: EtatAction = { erreur: null, succes: null };

/** Valeur du `Select` pour « non assigné ». La Server Action mappe "" → null. */
const VALEUR_NON_ASSIGNE = "";

export function AssignationComptes({
  comptes,
  entites,
}: {
  comptes: CompteVueAssignation[];
  entites: EntiteVue[];
}) {
  const [recherche, setRecherche] = useState("");

  const comptesFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    if (q === "") return comptes;
    return comptes.filter((c) => c.accountName.toLowerCase().includes(q));
  }, [recherche, comptes]);

  // État vide « métier » : aucune banque connectée → rien à assigner. Un CTA utile
  // (D2 de EmptyState : pas de bouton creux).
  if (comptes.length === 0) {
    return (
      <EmptyState
        title="Aucun compte à assigner"
        message="Connectez une banque : les comptes remontés apparaîtront ici, prêts à être rattachés à une entité."
        illustration="empty"
        cta={{ label: "Connecter une banque", href: "/banques" }}
      />
    );
  }

  // Des comptes, mais aucune entité : les Select n'offriraient que « — Non assigné — ».
  // On oriente vers la création d'entité plutôt que d'afficher des menus inertes.
  if (entites.length === 0) {
    return (
      <EmptyState
        title="Aucune entité"
        message="Créez une entité d’abord : sans elle, les comptes ne peuvent être rattachés à aucune business unit."
        illustration="empty"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Barre d'outils : recherche par nom de compte */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative flex-1 sm:max-w-xs">
          <span className="sr-only">Rechercher un compte</span>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher un compte…"
            className="h-10 w-full rounded-control border border-line bg-white pl-9 pr-3
              text-sm placeholder:text-text-faint focus:border-primary focus:outline-none
              focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <p className="text-sm text-text-muted">
          {comptes.length} compte{comptes.length > 1 ? "s" : ""}
        </p>
      </div>

      {/* Une carte par compte — chaque carte gère son propre enregistrement */}
      <ul className="flex flex-col gap-3">
        {comptesFiltres.map((compte) => (
          <CarteCompte
            key={compte.bankAccountId}
            compte={compte}
            entites={entites}
          />
        ))}

        {comptesFiltres.length === 0 && (
          <li className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
            Aucun compte ne correspond à « {recherche} ».
          </li>
        )}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Carte d'un compte : Select d'entité + enregistrement (par compte)   */
/* ------------------------------------------------------------------ */

function CarteCompte({
  compte,
  entites,
}: {
  compte: CompteVueAssignation;
  entites: EntiteVue[];
}) {
  // `null` (non assigné) est représenté par "" côté formulaire (mappé null par l'action).
  const valeurInitiale = compte.entityId ?? VALEUR_NON_ASSIGNE;
  const [entiteChoisie, setEntiteChoisie] = useState<string>(valeurInitiale);

  const [etat, action, enCours] = useActionState(
    assignerCompteAction,
    ETAT_INITIAL,
  );

  // Dirty state : rien à enregistrer tant que la sélection vaut l'entité courante.
  const modifie = entiteChoisie !== valeurInitiale;

  // `id` dérivé du bankAccountId : unique par ligne (sinon `aria-activedescendant`
  // et `htmlFor` pointeraient la même cible sur plusieurs cartes).
  const idSelect = `compte-entite-${compte.bankAccountId}`;

  const options = useMemo(
    () => [
      { value: VALEUR_NON_ASSIGNE, label: "— Non assigné —" },
      ...entites.map((e) => ({ value: e.id, label: e.nom })),
    ],
    [entites],
  );

  return (
    <li className="rounded-card bg-surface-card p-5 shadow-card">
      <form
        action={action}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <input
          type="hidden"
          name="bankAccountId"
          value={compte.bankAccountId}
        />
        {/* Le `Select` maison n'est pas un champ natif : sa valeur est postée par ce
            hidden, qui lui est FRÈRE (jamais dans le <label>). */}
        <input type="hidden" name="entityId" value={entiteChoisie} />

        {/* Identité du compte — nom + devise, JAMAIS de solde (règle 8) */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">
            {compte.accountName}
          </p>
          <p className="text-xs text-text-faint">{compte.currency}</p>
        </div>

        {/* Entité cible */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idSelect} className="text-xs text-text-muted">
            Entité
          </label>
          <Select
            id={idSelect}
            value={entiteChoisie}
            onChange={setEntiteChoisie}
            disabled={enCours}
            options={options}
            className="min-w-[240px]"
          />
        </div>

        <button
          type="submit"
          disabled={!modifie || enCours}
          className="flex h-10 items-center justify-center gap-2 rounded-control bg-primary
            px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-600
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
            focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-48"
        >
          {enCours && (
            <span
              aria-hidden
              className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {enCours ? "Enregistrement…" : "Enregistrer"}
        </button>

        {/* Retour de l'action, par ligne. `aria-live` : annoncé sans voler le focus. */}
        <div aria-live="polite" className="min-h-[1rem] w-full text-xs">
          {etat.erreur !== null && (
            <span role="alert" className="text-danger">
              {etat.erreur}
            </span>
          )}
          {etat.succes !== null && (
            <span role="status" className="text-success">
              {etat.succes}
            </span>
          )}
          {etat.erreur === null && etat.succes === null && modifie && (
            <span className="text-text-faint">Modification non enregistrée.</span>
          )}
        </div>
      </form>
    </li>
  );
}
