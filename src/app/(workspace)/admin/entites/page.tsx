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
import {
  AssignationEntites,
  type EntiteVue,
  type MembreVue,
} from "./assignation-entites";
import {
  PropositionsPartyEntite,
  type EntiteCible,
  type PropositionVue,
} from "./propositions";

export const metadata = { title: "Entités — Dodo" };

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

    // L0, résidu PLAN §12 — GARDE FAIL-SAFE. L'amputation du viewFilter ne couvre que
    // l'axe JWT. `entity_scope` et `account_scope` sont résolus EN BASE par withWorkspace
    // (member_entity_scopes / user_scopes) : la session ne peut pas les neutraliser. Or
    // rien n'interdit aujourd'hui de scoper un ADMIN — `definirScopesMembre` ne vérifie
    // que la MEMBERSHIP, jamais le RÔLE — et cet écran expose lui-même l'action qui le
    // permet. Un ADMIN scopé lirait donc des listes PARTIELLES.
    // On ne durcit aucune règle serveur sans arbitrage (§12), mais on refuse de MENTIR :
    // l'écran dit qu'il est restreint plutôt que d'afficher un « 0 non assigné » faux.
    const vueRestreinte =
      ctx.entityScope.mode !== "GLOBALE" || ctx.accountScope.mode !== "GLOBALE";

    return { entites, membres, propositions, comptes, vueRestreinte };
  });

  if (donnees === null) {
    notFound();
  }

  // Restreint aux entités actives (les archivées disparaissent des pickers, cf.
  // archiverEntite côté repo).
  const entitesActives: EntiteVue[] = donnees.entites
    .filter((e) => e.isActive)
    .map((e) => ({ id: e.id, nom: e.name, code: e.code }));

  // Cibles d'entité pour le sas de propositions (entités actives, mêmes que pickers).
  const entitesCibles: EntiteCible[] = entitesActives.map((e) => ({
    id: e.id,
    nom: e.nom,
  }));

  return (
    <main className="flex flex-1 justify-center p-6">
      <div className="flex w-full max-w-3xl flex-col gap-10">
        {/* L0 §12 — l'écran DIT qu'il est partiel plutôt que d'afficher des chiffres faux.
            (L'axe viewFilter, lui, est déjà neutralisé par exigerSessionAdministration.) */}
        {donnees.vueRestreinte && <AvertissementVueRestreinte />}

        <section>
          <h1 className="mb-1 text-lg font-semibold">
            Propositions d’entités (Parties Omni-FI)
          </h1>
          <p className="mb-6 text-sm text-text-muted">
            Chaque proposition est dérivée d’une « Party » Omni-FI. Rien n’est
            enregistré tant que vous n’avez pas confirmé : créez l’entité proposée
            ou choisissez-en une existante, puis rattachez ses comptes.
          </p>
          <PropositionsPartyEntite
            propositions={donnees.propositions}
            entites={entitesCibles}
          />
        </section>

        <section>
          <h2 className="mb-1 text-lg font-semibold">Assignation des entités</h2>
          <p className="mb-6 text-sm text-text-muted">
            Définissez le périmètre de chaque membre : accès à l’ensemble du groupe
            (Vision Globale) ou restreint à certaines entités (Vision Entité).
          </p>
          <AssignationEntites
            entites={entitesActives}
            membres={donnees.membres}
          />
        </section>

        <section>
          <h2 className="mb-1 text-lg font-semibold">Assignation des comptes</h2>
          <p className="mb-6 text-sm text-text-muted">
            Rattachez chaque compte bancaire à une entité, ou repassez-le en
            « non assigné ». Un compte non assigné reste invisible aux membres en
            Vision Entité.
          </p>
          <AssignationComptes
            comptes={donnees.comptes}
            entites={entitesActives}
          />
        </section>
      </div>
    </main>
  );
}
