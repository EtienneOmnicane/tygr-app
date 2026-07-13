/**
 * Écran d'assignation des Entités (BU) aux membres — réservé à l'ADMIN du
 * workspace courant (Groupe « Omnicane »). Epic 3 / Entités L3.
 *
 * Câblage L3/L4 (PR wiring) : les ENTITÉS, les MEMBRES et le PÉRIMÈTRE de chaque
 * membre sont lus côté serveur (listerEntites + listerMembresWorkspace, dans
 * withWorkspace), puis passés en props au composant client. L'enregistrement
 * passe par la vraie Server Action `definirScopesAction` (cf. ./actions.ts).
 *
 * La liste des membres provient désormais de `listerMembresWorkspace(tx, ctx)` :
 * UNE requête jointe (workspace_members ⋈ users ⟕ member_entity_scopes) qui
 * remonte nom/email/rôle/userId ET le scopeInitial de chaque membre — le mock
 * MEMBRES_MOCK et la boucle N+1 (un listerScopesMembre par membre) ont disparu.
 *
 * Gating (D2 #37 + S3) : le rôle est re-validé à chaque requête via
 * withWorkspace. Un non-ADMIN ne reçoit PAS un écran désactivé mais un 404
 * (notFound) — la surface admin est CACHÉE, pas grisée, et non-énumérante.
 */
import { notFound, redirect } from "next/navigation";

import { AvertissementVueRestreinte } from "@/components/admin/avertissement-vue-restreinte";
import { peutAdministrer } from "@/lib/permissions";
import {
  AucunWorkspaceActifError,
  exigerSessionAdministration,
  NonAuthentifieError,
} from "@/server/auth/session";
import {
  listerComptesAvecEntite,
  listerEntites,
  listerMembresWorkspace,
  listerPropositionsPartyEntite,
  withWorkspace,
} from "@/server/db";

import {
  AssignationComptes,
  type CompteVueAssignation,
} from "./assignation-comptes";
import { BandeauRecap } from "./bandeau-recap";
import { GestionEntites, type EntiteGeree } from "./gestion-entites";
import { compterNonAssignes } from "./regles-comptes";
import {
  AssignationEntites,
  type EntiteVue,
  type MembreVue,
} from "./assignation-entites";
import {
  BanniereSuggestions,
  type EntiteCible,
  type PropositionVue,
} from "./propositions";

export const metadata = { title: "Entities — Dodo" };

export default async function PageEntites() {
  // L0 (§3.3) : session AMPUTÉE du viewFilter. Le sélecteur de périmètre du header est
  // monté sur CETTE page ; sans amputation, la policy account_scope filtrerait les comptes
  // et le récap mentirait (« 0 non assigné » alors que 77 le sont).
  let session;
  try {
    session = await exigerSessionAdministration();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    if (erreur instanceof AucunWorkspaceActifError) redirect("/selection");
    throw erreur;
  }

  // Lecture serveur sous RLS : rôle + référentiel d'entités + membres (avec leur
  // périmètre joint), dans une seule transaction scopée workspace.
  const donnees = await withWorkspace(session, async (tx, ctx) => {
    if (!peutAdministrer(ctx.role)) {
      // S3 / D2 #37 : surface admin CACHÉE (404, pas 403). On sort AVANT toute
      // lecture pour ne rien divulguer.
      return null;
    }

    const entites = await listerEntites(tx, ctx);
    // Une seule requête jointe : membres du workspace + scopeInitial de chacun
    // (plus de boucle N+1 ni de mock). Le contrat MembreScope mappe MembreVue.
    const membres: MembreVue[] = await listerMembresWorkspace(tx, ctx);
    // Sas ENTITY-PARTY1 : propositions Party→entité dérivées des parties persistées.
    const propositions: PropositionVue[] = await listerPropositionsPartyEntite(
      tx,
      ctx,
    );
    // L7 : tous les comptes du workspace + leur entité (null = non assigné). Lecture
    // ADMIN-only (garde du repo), sans aucun montant.
    const comptes: CompteVueAssignation[] = await listerComptesAvecEntite(
      tx,
      ctx,
    );

    // GARDE FAIL-SAFE (§12). Depuis l'arbitrage du 2026-07-13, scoper un ADMIN est REFUSÉ
    // (`AdminNonScopableError`) : la cause est fermée. Cette garde reste néanmoins — elle
    // couvre les états HÉRITÉS (une ligne `member_entity_scopes` déjà en base, posée avant
    // la règle, ou par une insertion directe). L'amputation du viewFilter (L0) ne peut rien
    // pour eux : `entity_scope` / `account_scope` sont résolus EN BASE, pas dans la session.
    // On refuse de MENTIR : l'écran DIT qu'il est partiel plutôt que d'afficher un « 0 non
    // assigné » faux. Défense en profondeur : la garde applicative empêche de créer l'état,
    // elle n'efface pas ceux qui existent déjà.
    const vueRestreinte =
      ctx.entityScope.mode !== "GLOBALE" || ctx.accountScope.mode !== "GLOBALE";

    return { entites, membres, propositions, comptes, vueRestreinte };
  });

  if (donnees === null) {
    notFound();
  }

  // Restreint aux entités actives (les archivées disparaissent des pickers, cf.
  // archiverEntite côté repo).
  const actives = donnees.entites.filter((e) => e.isActive);

  const entitesActives: EntiteVue[] = actives.map((e) => ({
    id: e.id,
    nom: e.name,
    code: e.code,
  }));

  // L2 — la liste GÉRABLE porte en plus le nombre de comptes (agrégat SQL déjà calculé
  // par listerEntites : aucune requête de plus). Elle montre TOUTES les entités actives,
  // y compris celles à 0 compte — que le tableau, lui, ne rend pas (il masque les groupes
  // vides). Sans elle, une entité fraîchement créée serait ingérable (Q-ENTITE-VIDE).
  const entitesGerees: EntiteGeree[] = actives.map((e) => ({
    id: e.id,
    nom: e.name,
    code: e.code,
    nbComptes: e.nbComptes,
  }));

  // Cibles d'entité pour le sas de propositions (entités actives, mêmes que pickers).
  const entitesCibles: EntiteCible[] = entitesActives.map((e) => ({
    id: e.id,
    nom: e.nom,
  }));

  // L1 — compteurs du bandeau. ZÉRO requête : tout se dérive des listes déjà lues dans le
  // withWorkspace ci-dessus. Le « non assigné » vient de la règle PARTAGÉE avec le tableau
  // (regles-comptes.ts) : bandeau et groupement ne peuvent pas se contredire (constat C1).
  const idsEntitesActives = new Set(entitesActives.map((e) => e.id));
  const nbNonAssignes = compterNonAssignes(donnees.comptes, idsEntitesActives);

  return (
    // Pleine largeur (UI_GUIDELINES §1.1 : « Admin — la table pleine largeur EST l'écran »).
    // Même gabarit que /transactions. L'ancien max-w-3xl écrasait un tableau de 87 lignes
    // dans une colonne étroite.
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <div className="flex flex-col gap-8">
        {/* L0 §12 — l'écran DIT qu'il est partiel plutôt que d'afficher des chiffres faux.
            (L'axe viewFilter, lui, est déjà neutralisé par exigerSessionAdministration.) */}
        {donnees.vueRestreinte && <AvertissementVueRestreinte />}

        <header>
          <h1 className="text-xl font-semibold text-ink">Entities</h1>
          <p className="mt-1 text-sm text-text-muted">
            Group your bank accounts into entities, then choose who can see what.
          </p>
        </header>

        <BandeauRecap
          nbEntites={entitesActives.length}
          nbComptes={donnees.comptes.length}
          nbNonAssignes={nbNonAssignes}
          nbMembres={donnees.membres.length}
        />

        {/* L2 — créer / renommer / archiver. Surface DÉDIÉE (Q-ENTITE-VIDE) : piloter une
            entité depuis un en-tête de groupe du tableau la rendrait ingérable dès qu'elle
            ne porte aucun compte, puisque les groupes vides ne sont pas rendus. */}
        <GestionEntites entites={entitesGerees} />

        {/* ÉTAPE 1 — LE CŒUR. Passe AVANT l'accès des membres : on range les comptes,
            PUIS on donne les clés. L'ordre inverse (l'ancien) faisait décider qui voit
            quoi avant même que quoi que ce soit soit rangé. */}
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">
              Step 1 — Organise accounts
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Attach each bank account to an entity. An account left unassigned
              stays invisible to members with restricted access.
            </p>
          </div>

          {/* L4 — les suggestions ne sont plus une SECTION jargonneuse en tête d'écran :
              une bannière, ici, là où le geste a du sens. Elle disparaît quand il n'y a
              rien à suggérer. Le détail vit dans un panneau qu'on ouvre pour vérifier.
              🔒 INVARIANT : rien n'est écrit sans confirmation explicite (ENTITY-PARTY1). */}
          <BanniereSuggestions
            propositions={donnees.propositions}
            entites={entitesCibles}
          />

          <AssignationComptes
            comptes={donnees.comptes}
            entites={entitesActives}
          />
        </section>

        {/* ÉTAPE 2 — l'accès des membres, une fois les comptes rangés. */}
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">
              Step 2 — Who sees what
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Choose each member’s access: the whole group, or only the entities
              you pick.
            </p>
          </div>

          <AssignationEntites
            entites={entitesActives}
            membres={donnees.membres}
          />
        </section>
      </div>
    </main>
  );
}
