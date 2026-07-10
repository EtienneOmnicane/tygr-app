"use client";

/**
 * Section « Assignation des comptes » (L7). Surface ADMIN dense : un TABLEAU d'une
 * ligne par compte, groupé par entité (BU), avec auto-save au changement de Select.
 * C'est la SEULE surface qui permette la DÉ-assignation (entityId = null) : le sas de
 * propositions (section 1) ne sait qu'assigner, et seulement les comptes portés par
 * une Party Omni-FI.
 *
 * Pourquoi un tableau et plus des cartes : le workspace réel porte ~87 comptes. Empilés
 * en cartes (gabarit CarteMembre), l'écran est inutilisable — d'autant que 77 d'entre
 * eux n'ont AUCUN nom en sandbox, ce qui produisait des cartes quasi vides.
 *
 * Auto-save (plus de bouton « Enregistrer ») : le `onChange` du Select appelle
 * directement `assignerCompteAction`. Le serveur pose `revalidatePath("/admin/entites")`
 * → la page re-rend et le compte MIGRE vers son nouveau groupe. La vérité reste donc la
 * prop serveur ; l'état local ne sert qu'à l'affichage optimiste du Select et au statut.
 *
 * ⚠️ AUCUN montant affiché (règle 8) : libellé + institution + devise. Le contrat
 * serveur `CompteAvecEntite` ne remonte aucun solde.
 *
 * `Select` maison = `<button role="combobox">` : il ne poste RIEN dans un `<form>`. En
 * auto-save on n'utilise donc pas de `<form>` du tout — on construit un `FormData` et on
 * appelle l'action programmatiquement (cf. `useLigneAssignation`).
 *
 * Tokens & conventions UI_GUIDELINES (§2.2 tableau dense, §3.4 erreur ≠ sortie, §4.4
 * états vides). Pas de dépendance externe (règle 9) : SVG inline, `cn` local.
 */
import { useCallback, useMemo, useRef, useState, useTransition } from "react";

import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/states";

import { assignerCompteAction } from "./actions";
import type { EntiteVue } from "./assignation-entites";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Compte + son entité courante (projection de `CompteAvecEntite` côté page). */
export interface CompteVueAssignation {
  bankAccountId: string;
  /** Brut : NOT NULL en base, mais souvent la chaîne vide (77/87 en sandbox). */
  accountName: string;
  currency: string;
  /** Institution de la connexion (nullable). Identifiant de repli. */
  institutionName: string | null;
  /** entity_id actuel ; `null` = non assigné. */
  entityId: string | null;
}

/** Valeur du `Select` pour « non assigné ». La Server Action mappe "" → null. */
const VALEUR_NON_ASSIGNE = "";

/** Clé du groupe « non assigné », distincte d'un entityId (uuid). */
const GROUPE_NON_ASSIGNE = "__non_assigne__";

const LIBELLE_NON_ASSIGNE = "— Non assigné —";

/**
 * Identifiant lisible d'un compte, par ordre de préférence :
 *   1. `accountName` non vide (10 comptes sur 87 en sandbox) ;
 *   2. `institutionName` + suffixe d'id — l'institution SEULE ne suffit pas : les 77
 *      comptes sans nom partagent la même (« State Bank of Mauritius »), ils seraient
 *      indistinguables. Le suffixe est l'id INTERNE (uuid TYGR), jamais un numéro de
 *      compte : il n'existe aucun masque/IBAN en base, et on n'en fabriquerait pas un
 *      (aucune donnée bancaire dans un libellé, règle 8) ;
 *   3. `Compte {8 car. de l'id}` quand l'institution est nulle (expand-compat).
 *
 * Exportée pour être testée et réutilisée sans dupliquer la cascade (même esprit que la
 * règle « source unique de formatage » appliquée aux montants et aux dates).
 */
export function libelleCompte(compte: CompteVueAssignation): string {
  const nom = compte.accountName.trim();
  if (nom !== "") return nom;

  const suffixe = compte.bankAccountId.slice(0, 8);
  const institution = compte.institutionName?.trim();
  if (institution) return `${institution} · ${suffixe}`;

  return `Compte ${suffixe}`;
}

/* ------------------------------------------------------------------ */
/* Groupement par entité                                               */
/* ------------------------------------------------------------------ */

interface GroupeComptes {
  /** entityId, ou `GROUPE_NON_ASSIGNE`. */
  cle: string;
  titre: string;
  comptes: CompteVueAssignation[];
}

/**
 * Groupe les comptes par entité : entités ACTIVES dans l'ordre reçu (alphabétique,
 * comme `listerEntites`), puis « — Non assigné — » en DERNIER. Les groupes vides ne
 * sont pas rendus (utile quand un filtre de recherche est actif).
 *
 * Un compte dont l'`entityId` ne correspond à aucune entité ACTIVE (entité archivée
 * après coup) retombe dans « non assigné » plutôt que de disparaître de l'écran —
 * sinon l'ADMIN ne pourrait plus jamais le rattacher ailleurs.
 */
function grouperParEntite(
  comptes: CompteVueAssignation[],
  entites: EntiteVue[],
): GroupeComptes[] {
  const connues = new Set(entites.map((e) => e.id));
  const parCle = new Map<string, CompteVueAssignation[]>();

  for (const compte of comptes) {
    const cle =
      compte.entityId !== null && connues.has(compte.entityId)
        ? compte.entityId
        : GROUPE_NON_ASSIGNE;
    const seau = parCle.get(cle);
    if (seau) seau.push(compte);
    else parCle.set(cle, [compte]);
  }

  const groupes: GroupeComptes[] = entites
    .map((e) => ({ cle: e.id, titre: e.nom, comptes: parCle.get(e.id) ?? [] }))
    .filter((g) => g.comptes.length > 0);

  const orphelins = parCle.get(GROUPE_NON_ASSIGNE);
  if (orphelins && orphelins.length > 0) {
    groupes.push({
      cle: GROUPE_NON_ASSIGNE,
      titre: LIBELLE_NON_ASSIGNE,
      comptes: orphelins,
    });
  }
  return groupes;
}

/* ------------------------------------------------------------------ */
/* Composant principal                                                 */
/* ------------------------------------------------------------------ */

export function AssignationComptes({
  comptes,
  entites,
}: {
  comptes: CompteVueAssignation[];
  entites: EntiteVue[];
}) {
  const [recherche, setRecherche] = useState("");

  // Filtre sur l'identifiant AFFICHÉ (ce que l'ADMIN lit), pas sur `accountName` brut :
  // chercher « State Bank » doit trouver les comptes dont c'est le libellé de repli.
  const comptesFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    if (q === "") return comptes;
    return comptes.filter((c) => libelleCompte(c).toLowerCase().includes(q));
  }, [recherche, comptes]);

  const groupes = useMemo(
    () => grouperParEntite(comptesFiltres, entites),
    [comptesFiltres, entites],
  );

  const options = useMemo(
    () => [
      { value: VALEUR_NON_ASSIGNE, label: LIBELLE_NON_ASSIGNE },
      ...entites.map((e) => ({ value: e.id, label: e.nom })),
    ],
    [entites],
  );

  // État vide « métier » : aucune banque connectée → rien à assigner (§4.4).
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

  // Des comptes, mais aucune entité : le Select n'offrirait que « — Non assigné — ».
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
      <BarreRecherche
        valeur={recherche}
        onChange={setRecherche}
        nbTotal={comptes.length}
        nbFiltres={comptesFiltres.length}
      />

      {comptesFiltres.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
          Aucun compte ne correspond à « {recherche} ».
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface-card shadow-card">
          {/* table-fixed : impose les largeurs du <colgroup> → `truncate` opère et la
              table ne déborde pas (même convention que TransactionsTable, §2.2). */}
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col />
              <col className="w-[72px] sm:w-[88px]" />
              <col className="w-[200px] sm:w-[260px]" />
            </colgroup>

            <thead>
              <tr className="border-b border-line-strong bg-surface-card">
                <th
                  scope="col"
                  className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
                >
                  Compte
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
                >
                  Devise
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
                >
                  Entité
                </th>
              </tr>
            </thead>

            {/* Un <tbody> par groupe : c'est le regroupement sémantique natif d'un
                tableau (une seule <table>, donc une seule structure de colonnes). */}
            {groupes.map((groupe) => (
              <tbody key={groupe.cle} className="divide-y divide-line">
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={3}
                    className="border-y border-line bg-surface-inset px-3 py-2 text-left text-xs font-semibold text-text sm:px-4"
                  >
                    {groupe.titre}
                    <span className="ml-2 font-normal text-text-muted">
                      {groupe.comptes.length} compte
                      {groupe.comptes.length > 1 ? "s" : ""}
                    </span>
                  </th>
                </tr>

                {groupe.comptes.map((compte) => (
                  <LigneCompte
                    key={compte.bankAccountId}
                    compte={compte}
                    options={options}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Barre de recherche                                                  */
/* ------------------------------------------------------------------ */

function BarreRecherche({
  valeur,
  onChange,
  nbTotal,
  nbFiltres,
}: {
  valeur: string;
  onChange: (v: string) => void;
  nbTotal: number;
  nbFiltres: number;
}) {
  const filtreActif = valeur.trim() !== "";
  return (
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
          value={valeur}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Rechercher un compte…"
          className="h-10 w-full rounded-control border border-line bg-white pl-9 pr-3
            text-sm placeholder:text-text-faint focus:border-primary focus:outline-none
            focus:ring-2 focus:ring-primary/30"
        />
      </label>
      <p className="text-sm text-text-muted" aria-live="polite">
        {filtreActif
          ? `${nbFiltres} sur ${nbTotal} compte${nbTotal > 1 ? "s" : ""}`
          : `${nbTotal} compte${nbTotal > 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Une ligne : Select auto-save + statut                               */
/* ------------------------------------------------------------------ */

type Statut =
  | { phase: "repos" }
  | { phase: "envoi" }
  | { phase: "succes" }
  | { phase: "erreur"; message: string };

/**
 * Auto-save d'une ligne, avec sémantique « DERNIER GAGNE ».
 *
 * Le problème : l'ADMIN peut enchaîner deux changements sur la même ligne avant que le
 * premier appel ne réponde. Sans garde, la réponse LENTE du premier écraserait le
 * statut du second, et afficherait « Enregistré » pour une valeur qui n'est plus celle
 * du Select.
 *
 * La parade : un compteur MONOTONE par ligne (`useRef`). Chaque envoi capture son
 * numéro ; à la réponse, on jette tout ce qui n'est pas le dernier émis. On ne désactive
 * donc PAS le Select pendant l'envoi (ce qui ferait « coller » l'UI sur 87 lignes) :
 * l'ADMIN peut corriger immédiatement.
 *
 * (Un compteur monotone, pas un booléen « en cours » : deux envois rapides partagent le
 * même booléen, mais jamais le même numéro.)
 */
function useLigneAssignation(bankAccountId: string, valeurServeur: string) {
  const [statut, setStatut] = useState<Statut>({ phase: "repos" });
  const [, demarrerTransition] = useTransition();

  // Valeur affichée : optimiste pendant l'envoi, sinon la vérité serveur.
  const [valeurLocale, setValeurLocale] = useState<string | null>(null);
  const dernierEnvoi = useRef(0);

  const envoyer = useCallback(
    (entityId: string) => {
      setValeurLocale(entityId);
      const numero = dernierEnvoi.current + 1;
      dernierEnvoi.current = numero;
      setStatut({ phase: "envoi" });

      demarrerTransition(async () => {
        const formData = new FormData();
        formData.set("bankAccountId", bankAccountId);
        // "" = « non assigné » : l'action mappe la chaîne vide sur null.
        formData.set("entityId", entityId);

        let resultat: { erreur: string | null; succes: string | null };
        try {
          resultat = await assignerCompteAction(
            { erreur: null, succes: null },
            formData,
          );
        } catch {
          // Message GÉNÉRIQUE : jamais de libellé bancaire ni de cause brute dans l'UI
          // (règle 8 — pas de PII dans un message d'erreur ni dans la télémétrie).
          resultat = { erreur: "Enregistrement impossible.", succes: null };
        }

        // Réponse périmée (un envoi plus récent l'a doublée) → on la jette.
        if (dernierEnvoi.current !== numero) return;

        if (resultat.erreur !== null) {
          setStatut({ phase: "erreur", message: resultat.erreur });
        } else {
          setStatut({ phase: "succes" });
        }
        // Dans les deux cas on relâche l'optimisme : après un succès, `revalidatePath`
        // re-rend la page avec la nouvelle prop (le compte migre de groupe) ; après un
        // échec, le Select doit retomber sur la vérité serveur plutôt que de mentir.
        setValeurLocale(null);
      });
    },
    [bankAccountId],
  );

  return { valeur: valeurLocale ?? valeurServeur, statut, envoyer };
}

function LigneCompte({
  compte,
  options,
}: {
  compte: CompteVueAssignation;
  options: Array<{ value: string; label: string }>;
}) {
  const valeurServeur = compte.entityId ?? VALEUR_NON_ASSIGNE;
  const { valeur, statut, envoyer } = useLigneAssignation(
    compte.bankAccountId,
    valeurServeur,
  );

  // `id` dérivé du bankAccountId : unique par ligne (sinon `aria-activedescendant` et
  // le `listboxId` du Select collisionneraient d'une ligne à l'autre).
  const idSelect = `compte-entite-${compte.bankAccountId}`;
  const libelle = libelleCompte(compte);
  // Le repli affiche DÉJÀ l'institution : ne pas la répéter en sous-titre.
  const sousTitre =
    compte.accountName.trim() !== "" ? compte.institutionName?.trim() : null;

  return (
    <tr className="align-middle">
      <td className="px-3 py-2 sm:px-4">
        <p className="truncate text-sm text-text" title={libelle}>
          {libelle}
        </p>
        {sousTitre && (
          <p className="truncate text-xs text-text-faint">{sousTitre}</p>
        )}
      </td>

      <td className="px-3 py-2 text-sm text-text-muted sm:px-4">
        {compte.currency}
      </td>

      <td className="px-3 py-2 sm:px-4">
        <div className="flex flex-col gap-1">
          {/* Pas de <label> visible (l'en-tête de colonne « Entité » le porte) : un
              nom accessible par ligne reste nécessaire pour le lecteur d'écran. */}
          <label htmlFor={idSelect} className="sr-only">
            Entité de {libelle}
          </label>
          <Select
            id={idSelect}
            value={valeur}
            onChange={envoyer}
            options={options}
            size="sm"
            className="w-full"
          />
          <StatutLigne statut={statut} />
        </div>
      </td>
    </tr>
  );
}

/**
 * Statut d'une ligne. `aria-live="polite"` : annoncé sans voler le focus (l'ADMIN peut
 * enchaîner les lignes au clavier). Hauteur minimale réservée pour éviter le saut de
 * layout à l'apparition du message.
 *
 * L'erreur porte fond `danger-bg` + icône + message (§3.4 « erreur ≠ sortie ») : un
 * simple texte rouge se confondrait avec la couleur d'un montant sortant.
 */
function StatutLigne({ statut }: { statut: Statut }) {
  return (
    <div aria-live="polite" className="min-h-[1.125rem]">
      {statut.phase === "envoi" && (
        <span className="flex items-center gap-1.5 text-xs text-text-faint">
          <span
            aria-hidden
            className="size-3 animate-spin rounded-full border-2 border-line border-t-text-muted"
          />
          Enregistrement…
        </span>
      )}

      {statut.phase === "succes" && (
        <span
          role="status"
          className="flex items-center gap-1 text-xs text-success"
        >
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0">
            <path
              d="M3.5 8.5l3 3 6-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Enregistré
        </span>
      )}

      {statut.phase === "erreur" && (
        <span
          role="alert"
          className={cn(
            "flex items-center gap-1 rounded-control bg-danger-bg px-1.5 py-0.5",
            "text-xs text-danger",
          )}
        >
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0">
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
          {statut.message}
        </span>
      )}
    </div>
  );
}
