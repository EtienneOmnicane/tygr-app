/**
 * Démo / Visual QA (Quality Gate 4) de la section « Assignation des comptes »
 * (cf. (workspace)/admin/entites/assignation-comptes.tsx, lot L7). NON destinée à la
 * production : isole le rendu du VRAI composant client `AssignationComptes` hors
 * auth/DB — la vraie page `/admin/entites` dépend du gating ADMIN (withWorkspace) et
 * renvoie 404 sans session ADMIN.
 *
 * On monte le composant réel avec des PROPS FICTIVES. ⚠️ Sur /demo (public, sans
 * session), un clic « Enregistrer » appelle la vraie Server Action
 * `assignerCompteAction` → elle exige une session workspace et renverra donc une
 * erreur : c'est ATTENDU (et c'est le moyen de capturer l'état d'erreur par ligne).
 * Cette page sert au rendu, au clavier du Select et au dirty state, pas à l'écriture.
 *
 * Les trois états de la checklist §6.5 sont montés côte à côte : peuplé, vide (aucun
 * compte), vide (aucune entité). Aucun montant n'est affiché — le contrat
 * `CompteVueAssignation` n'en porte pas (règle 8).
 */
import {
  AssignationComptes,
  type CompteVueAssignation,
} from "@/app/(workspace)/admin/entites/assignation-comptes";
import type { EntiteVue } from "@/app/(workspace)/admin/entites/assignation-entites";

export const metadata = { title: "Démo — Assignation des comptes" };

const ENTITES_DEMO: EntiteVue[] = [
  { id: "ent-sucriere", nom: "Omnicane Sucrière", code: "SUC" },
  { id: "ent-energie", nom: "Omnicane Énergie", code: "ENE" },
  { id: "ent-hotellerie", nom: "Omnicane Hôtellerie", code: "HOT" },
  { id: "ent-immobilier", nom: "Omnicane Immobilier", code: "IMM" },
];

// Multi-devise (MUR/USD/EUR) : le corporate mauricien tient couramment des comptes
// en devises. `entityId: null` = « non assigné » (état par défaut à l'ingestion).
const COMPTES_DEMO: CompteVueAssignation[] = [
  {
    bankAccountId: "00000000-0000-4000-8000-0000000000a1",
    accountName: "MCB — Compte courant Sucrière",
    institutionName: "MCB",
    currency: "MUR",
    entityId: "ent-sucriere",
  },
  {
    bankAccountId: "00000000-0000-4000-8000-0000000000a2",
    accountName: "MCB — Compte USD Énergie",
    institutionName: "MCB",
    currency: "USD",
    entityId: "ent-energie",
  },
  {
    // accountName vide : éprouve le repli sur institutionName (cas des 77 comptes
    // sandbox sans nom). Le libellé effectif affiché doit être « SBM ».
    bankAccountId: "00000000-0000-4000-8000-0000000000a3",
    accountName: "",
    institutionName: "SBM",
    currency: "MUR",
    entityId: null, // non assigné : invisible aux membres à accès restreint (fail-closed)
  },
  {
    bankAccountId: "00000000-0000-4000-8000-0000000000a4",
    accountName: "AfrAsia — Compte EUR Hôtellerie",
    institutionName: "AfrAsia",
    currency: "EUR",
    entityId: "ent-hotellerie",
  },
  {
    bankAccountId: "00000000-0000-4000-8000-0000000000a5",
    accountName:
      "Absa — Compte à libellé très long pour éprouver la troncature du nom de compte",
    institutionName: "Absa",
    currency: "MUR",
    entityId: null,
  },

  // L3 — le cas RÉEL : une grappe de comptes SANS NOM, sous la MÊME banque, tous non
  // assignés (77 sur 87 en production). C'est exactement ce que le lot doit rendre
  // rangeable : sans sélection multiple ni filtre banque, il faut 77 menus déroulants.
  // Cette grappe fait aussi que le groupe « — Unassigned — » compte plusieurs lignes,
  // donc que la case de groupe passe réellement en état INDÉTERMINÉ.
  {
    bankAccountId: "5b31a7c0-0000-4000-8000-0000000000b1",
    accountName: "",
    institutionName: "SBM",
    currency: "MUR",
    entityId: null,
  },
  {
    bankAccountId: "9f42d1e8-0000-4000-8000-0000000000b2",
    accountName: "",
    institutionName: "SBM",
    currency: "MUR",
    entityId: null,
  },
  {
    bankAccountId: "c70e5b93-0000-4000-8000-0000000000b3",
    accountName: "",
    institutionName: "SBM",
    currency: "USD",
    entityId: null,
  },
  {
    bankAccountId: "e18b6a24-0000-4000-8000-0000000000b4",
    accountName: "",
    institutionName: "SBM",
    currency: "EUR",
    entityId: null,
  },
];

function Bandeau({ titre }: { titre: string }) {
  return (
    <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
      Démo — {titre}{" "}
      <span className="font-normal normal-case">
        (rendu isolé, hors auth/DB)
      </span>
    </p>
  );
}

export default function DemoAssignationComptes() {
  return (
    <div className="min-h-screen bg-surface-page">
      <Bandeau titre="assignation des comptes" />

      <main className="flex flex-1 justify-center p-6">
        <div className="flex w-full max-w-3xl flex-col gap-10">
          <section id="etat-peuple">
            <h2 className="mb-1 text-lg font-semibold">
              Assignation des comptes
            </h2>
            <p className="mb-6 text-sm text-text-muted">
              Rattachez chaque compte à une entité, ou repassez-le en « non
              assigné » — un compte non assigné reste invisible aux membres à
              accès restreint. L3 : cochez plusieurs lignes (ou une case de
              groupe, qui passe en état indéterminé dès qu’une ligne est
              décochée) puis rangez-les en un geste. La cible « — Unassigned — »
              exige une confirmation.
            </p>
            <AssignationComptes
              comptes={COMPTES_DEMO}
              entites={ENTITES_DEMO}
            />
          </section>

          <section id="etat-vide-comptes">
            <h2 className="mb-1 text-lg font-semibold">
              État vide — aucun compte
            </h2>
            <p className="mb-6 text-sm text-text-muted">
              Aucune banque connectée : CTA vers /banques.
            </p>
            <AssignationComptes comptes={[]} entites={ENTITES_DEMO} />
          </section>

          <section id="etat-vide-entites">
            <h2 className="mb-1 text-lg font-semibold">
              État vide — aucune entité
            </h2>
            <p className="mb-6 text-sm text-text-muted">
              Des comptes, mais aucune entité : les Select n’offriraient que
              « — Non assigné — ».
            </p>
            <AssignationComptes comptes={COMPTES_DEMO} entites={[]} />
          </section>
        </div>
      </main>
    </div>
  );
}
