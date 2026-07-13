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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { Modal } from "@/components/ui/modal/modal";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/states";
import { basculerGroupe, etatSelectionGroupe } from "@/lib/selection-groupe";

import {
  assignerCompteAction,
  assignerComptesAction,
  type EtatAction,
} from "./actions";
import type { EntiteVue } from "./assignation-entites";
import { estNonAssigne } from "./regles-comptes";

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

const LIBELLE_NON_ASSIGNE = "— Unassigned —";

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

  return `Account ${suffixe}`;
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
 *
 * La condition n'est PAS réécrite ici : elle vient de `estNonAssigne` (regles-comptes.ts),
 * la source unique partagée avec le compteur du bandeau récap. Les deux surfaces ne
 * peuvent donc pas diverger (constat C1 des cross-reviews).
 */
function grouperParEntite(
  comptes: CompteVueAssignation[],
  entites: EntiteVue[],
): GroupeComptes[] {
  const connues = new Set(entites.map((e) => e.id));
  const parCle = new Map<string, CompteVueAssignation[]>();

  for (const compte of comptes) {
    // `entityId` est non-null dès que le compte n'est pas « non assigné » (invariant de
    // `estNonAssigne`) — le `?? GROUPE_NON_ASSIGNE` n'est qu'un garde de typage.
    const cle = estNonAssigne(compte, connues)
      ? GROUPE_NON_ASSIGNE
      : (compte.entityId ?? GROUPE_NON_ASSIGNE);
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
  /** `""` = toutes les banques. Le filtre sert le geste « tous les comptes de {banque} ». */
  const [banque, setBanque] = useState("");
  const [coches, setCoches] = useState<ReadonlySet<string>>(() => new Set());

  // Les banques présentes, dérivées des comptes déjà chargés — aucune requête (le contrat
  // `CompteAvecEntite` porte déjà `institutionName`).
  const banques = useMemo(() => {
    const noms = new Set<string>();
    for (const c of comptes) {
      const n = c.institutionName?.trim();
      if (n) noms.add(n);
    }
    return [...noms].sort((a, b) => a.localeCompare(b));
  }, [comptes]);

  // Filtre sur l'identifiant AFFICHÉ (ce que l'ADMIN lit), pas sur `accountName` brut :
  // chercher « State Bank » doit trouver les comptes dont c'est le libellé de repli.
  const comptesFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return comptes.filter((c) => {
      if (banque !== "" && c.institutionName?.trim() !== banque) return false;
      if (q !== "" && !libelleCompte(c).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [recherche, banque, comptes]);

  const groupes = useMemo(
    () => grouperParEntite(comptesFiltres, entites),
    [comptesFiltres, entites],
  );

  /**
   * ⚠️ La sélection SOUMISE est l'intersection « coché ∩ visible ».
   *
   * Sans ça : l'ADMIN coche 50 comptes, filtre sur une banque qui n'en montre que 5, clique
   * « Assign » — et en range 50. On n'envoie JAMAIS au serveur un compte que l'ADMIN n'a pas
   * sous les yeux. La sélection n'est pas PURGÉE pour autant : ré-élargir le filtre la fait
   * réapparaître (cocher, chercher, cocher encore reste possible).
   */
  const idsVisibles = useMemo(
    () => new Set(comptesFiltres.map((c) => c.bankAccountId)),
    [comptesFiltres],
  );
  const selection = useMemo(
    () => new Set([...coches].filter((id) => idsVisibles.has(id))),
    [coches, idsVisibles],
  );

  const basculerCompte = useCallback((id: string) => {
    setCoches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
        title="No account to organise"
        message="Connect a bank: the accounts it returns will show up here, ready to be attached to an entity."
        illustration="empty"
        cta={{ label: "Connect a bank", href: "/banques" }}
      />
    );
  }

  // Des comptes, mais aucune entité : le Select n'offrirait que « — Non assigné — ».
  if (entites.length === 0) {
    return (
      <EmptyState
        title="No entity yet"
        message="Create an entity first: without one, accounts cannot be attached to any business unit."
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
        banque={banque}
        onBanque={setBanque}
        banques={banques}
      />

      {/* Barre d'action groupée — le gain du lot : ranger N comptes en un geste, au lieu
          de N menus déroulants (dette P1 ENTITY-ASSIGN-BULK1). N'apparaît que s'il y a
          quelque chose à ranger. */}
      {selection.size > 0 && (
        <BarreAction
          selection={selection}
          entites={entites}
          onEfface={() => setCoches(new Set())}
        />
      )}

      {comptesFiltres.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
          No account matches your filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface-card shadow-card">
          {/* table-fixed : impose les largeurs du <colgroup> → `truncate` opère et la
              table ne déborde pas (même convention que TransactionsTable, §2.2). */}
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[44px]" />
              <col />
              <col className="w-[72px] sm:w-[88px]" />
              <col className="w-[200px] sm:w-[260px]" />
            </colgroup>

            <thead>
              <tr className="border-b border-line-strong bg-surface-card">
                <th scope="col" className="px-3 py-3 sm:px-4">
                  <span className="sr-only">Select</span>
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
                >
                  Account
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
                >
                  Currency
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
                >
                  Entity
                </th>
              </tr>
            </thead>

            {/* Un <tbody> par groupe : c'est le regroupement sémantique natif d'un
                tableau (une seule <table>, donc une seule structure de colonnes). */}
            {groupes.map((groupe) => (
              <tbody key={groupe.cle} className="divide-y divide-line">
                <tr>
                  <th scope="col" className="border-y border-line bg-surface-inset px-3 py-2 sm:px-4">
                    <CaseGroupe
                      groupe={groupe}
                      coches={selection}
                      onBascule={() =>
                        setCoches((prev) => basculerGroupe(prev, groupe.comptes))
                      }
                    />
                  </th>
                  <th
                    scope="colgroup"
                    colSpan={3}
                    className="border-y border-line bg-surface-inset px-3 py-2 text-left text-xs font-semibold text-text sm:px-4"
                  >
                    {groupe.titre}
                    <span className="ml-2 font-normal text-text-muted">
                      {groupe.comptes.length} account
                      {groupe.comptes.length > 1 ? "s" : ""}
                    </span>
                  </th>
                </tr>

                {groupe.comptes.map((compte) => (
                  <LigneCompte
                    key={compte.bankAccountId}
                    compte={compte}
                    options={options}
                    coche={selection.has(compte.bankAccountId)}
                    onBascule={basculerCompte}
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
  banque,
  onBanque,
  banques,
}: {
  valeur: string;
  onChange: (v: string) => void;
  nbTotal: number;
  nbFiltres: number;
  banque: string;
  onBanque: (v: string) => void;
  banques: string[];
}) {
  const filtreActif = valeur.trim() !== "" || banque !== "";

  // Le filtre banque sert LE geste opérationnel du lot : « ranger tous les comptes de la
  // State Bank dans Sucrière ». 77 des 87 comptes réels partagent la même banque et n'ont
  // pas de nom — les retrouver un par un dans la recherche est illusoire.
  const optionsBanque = useMemo(
    () => [
      { value: "", label: "All banks" },
      ...banques.map((b) => ({ value: b, label: b })),
    ],
    [banques],
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1 sm:max-w-xs">
          <span className="sr-only">Search accounts</span>
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
            placeholder="Search accounts…"
            className="h-10 w-full rounded-control border border-line bg-white pl-9 pr-3
              text-sm placeholder:text-text-faint focus:border-primary focus:outline-none
              focus:ring-2 focus:ring-primary/30"
          />
        </label>

        {banques.length > 1 && (
          <Select
            value={banque}
            onChange={onBanque}
            options={optionsBanque}
            ariaLabel="Filter by bank"
            className="w-full sm:w-56"
          />
        )}
      </div>

      <p className="shrink-0 text-sm text-text-muted" aria-live="polite">
        {filtreActif
          ? `${nbFiltres} of ${nbTotal} account${nbTotal > 1 ? "s" : ""}`
          : `${nbTotal} account${nbTotal > 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sélection multiple : case de groupe (tri-état) + case de ligne      */
/* ------------------------------------------------------------------ */

/**
 * Case « tout cocher » d'un groupe. L'état INDÉTERMINÉ n'est pas un attribut HTML : il se
 * pose sur la propriété DOM, via une ref (même parade que `perimetre-switcher.tsx`).
 * La règle tri-état vient de `@/lib/selection-groupe` — pure, partagée, testée.
 */
function CaseGroupe({
  groupe,
  coches,
  onBascule,
}: {
  groupe: GroupeComptes;
  coches: ReadonlySet<string>;
  onBascule: () => void;
}) {
  const etat = etatSelectionGroupe(groupe.comptes, coches);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = etat === "partiel";
  }, [etat]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={etat === "tous"}
      onChange={onBascule}
      aria-label={`Select every account in ${groupe.titre}`}
      className="size-4 cursor-pointer rounded border-line accent-primary"
    />
  );
}

/**
 * Barre d'action groupée. Le `Select` maison ne poste rien (c'est un `<button>`) : on
 * construit donc un `FormData` et on appelle l'action programmatiquement — même parade que
 * l'auto-save unitaire.
 *
 * La DÉ-assignation en masse passe par une confirmation : repasser N comptes en « non
 * assigné » les rend INVISIBLES aux membres à accès restreint (fail-closed). Sur un seul
 * compte c'est déjà silencieux (dette CONFIRM1) ; sur cinquante, c'est un incident.
 */
function BarreAction({
  selection,
  entites,
  onEfface,
}: {
  selection: ReadonlySet<string>;
  entites: EntiteVue[];
  onEfface: () => void;
}) {
  const [cible, setCible] = useState<string>("");
  const [confirmation, setConfirmation] = useState(false);
  const [statut, setStatut] = useState<Statut>({ phase: "repos" });
  const [, demarrerTransition] = useTransition();

  const n = selection.size;
  const nomCible = entites.find((e) => e.id === cible)?.nom;
  const desassigne = cible === VALEUR_NON_ASSIGNE;

  const options = useMemo(
    () => [
      { value: VALEUR_NON_ASSIGNE, label: LIBELLE_NON_ASSIGNE },
      ...entites.map((e) => ({ value: e.id, label: e.nom })),
    ],
    [entites],
  );

  function envoyer() {
    setConfirmation(false);
    setStatut({ phase: "envoi" });
    demarrerTransition(async () => {
      const formData = new FormData();
      for (const id of selection) formData.append("bankAccountIds", id);
      formData.set("entityId", cible);

      let res: EtatAction;
      try {
        res = await assignerComptesAction(
          { erreur: null, succes: null },
          formData,
        );
      } catch {
        res = { erreur: "Could not save.", succes: null };
      }

      if (res.erreur !== null) {
        setStatut({ phase: "erreur", message: res.erreur });
        return;
      }
      setStatut({ phase: "succes" });
      // `revalidatePath` re-rend la page : les comptes migrent vers leur nouveau groupe.
      // On vide la sélection, sinon elle désignerait des lignes qui ont bougé.
      onEfface();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-primary/30 bg-primary-50 px-4 py-3">
      <p className="text-sm font-medium text-ink tabular-nums">
        {n} account{n > 1 ? "s" : ""} selected
      </p>

      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        <Select
          value={cible}
          onChange={setCible}
          options={options}
          ariaLabel="Move selected accounts to"
          className="w-full sm:w-56"
        />

        <button
          type="button"
          onClick={() => (desassigne ? setConfirmation(true) : envoyer())}
          disabled={statut.phase === "envoi"}
          className="h-10 rounded-control bg-primary px-4 text-sm font-semibold text-white
            transition-colors hover:bg-primary-600 focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2
            disabled:cursor-not-allowed disabled:opacity-[0.48]"
        >
          {statut.phase === "envoi" ? "Moving…" : "Move"}
        </button>

        <button
          type="button"
          onClick={onEfface}
          className="h-10 rounded-control px-3 text-sm font-medium text-text-muted
            transition-colors hover:text-text focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary/40"
        >
          Clear
        </button>
      </div>

      <div className="w-full">
        <StatutLigne statut={statut} />
      </div>

      {confirmation && (
        <Modal
          open
          onClose={() => setConfirmation(false)}
          title="Unassign accounts"
          size="sm"
          // Surface destructive : ni Échap ni le clic sur l'overlay ne ferment (§4.4).
          dismissible={false}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text">
              Set <span className="font-semibold">{n}</span> account
              {n > 1 ? "s" : ""} back to unassigned? They become{" "}
              <span className="font-semibold">invisible</span> to members whose
              access is limited to specific entities — including the people who
              can see them today.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmation(false)}
                className="h-10 rounded-control px-4 text-sm font-medium text-text-muted
                  transition-colors hover:text-text focus:outline-none focus-visible:ring-2
                  focus-visible:ring-primary/40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={envoyer}
                className="h-10 rounded-control bg-danger px-4 text-sm font-semibold text-white
                  transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2
                  focus-visible:ring-danger focus-visible:ring-offset-2"
              >
                Unassign
              </button>
            </div>
          </div>
        </Modal>
      )}

      {nomCible && !desassigne && statut.phase === "repos" && (
        <span className="sr-only" aria-live="polite">
          {n} accounts will move to {nomCible}.
        </span>
      )}
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
          resultat = { erreur: "Could not save.", succes: null };
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
  coche,
  onBascule,
}: {
  compte: CompteVueAssignation;
  options: Array<{ value: string; label: string }>;
  coche: boolean;
  onBascule: (id: string) => void;
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
        <input
          type="checkbox"
          checked={coche}
          onChange={() => onBascule(compte.bankAccountId)}
          aria-label={`Select ${libelle}`}
          className="size-4 cursor-pointer rounded border-line accent-primary"
        />
      </td>

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
            Entity for {libelle}
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
          Saving…
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
          Saved
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
