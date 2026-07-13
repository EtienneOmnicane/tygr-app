/**
 * Démo — bannière de suggestions + panneau de vérification (L4).
 *
 * Ce que la démo doit prouver (Gate 4) :
 *   1. la bannière ne s'affiche QUE s'il y a quelque chose à suggérer (l'ancienne section
 *      affichait « Aucune proposition » en permanence, en tête d'écran) ;
 *   2. le panneau s'OUVRE sur demande — il n'occupe plus l'écran ;
 *   3. le DOUBLON est SURFACÉ, jamais fusionné (Q2-bis) : « SUCRIÈRE » (party) vs
 *      « Sucrière » (entité existante) → on propose de basculer, on ne décide pas ;
 *   4. les comptes SANS NOM portent leur banque (`libelleCompte`, source unique — Q2) ;
 *   5. la case de groupe passe en état indéterminé (« tout cocher » du plan v1).
 *
 * On monte le VRAI composant hors auth/DB. ⚠️ Un clic « Attach » appelle la vraie Server
 * Action, qui échoue sans session : c'est attendu (et c'est le moyen de capturer l'erreur).
 *
 * Hors production.
 */
import {
  BanniereSuggestions,
  type EntiteCible,
  type PropositionVue,
} from "@/app/(workspace)/admin/entites/propositions";

export const metadata = { title: "Démo — Suggestions de rattachement" };

const ENTITES: EntiteCible[] = [
  { id: "11111111-1111-4111-8111-111111111111", nom: "Sucrière" },
  { id: "22222222-2222-4222-8222-222222222222", nom: "Énergie" },
];

const PROPOSITIONS: PropositionVue[] = [
  {
    // DOUBLON DE CASSE : la party s'appelle « SUCRIÈRE », l'entité « Sucrière » existe.
    // Le serveur ne les rapproche pas (match sensible à la casse) → sans la détection
    // client, l'admin créerait un quasi-doublon. On SURFACE, on ne fusionne pas.
    partyId: "aaaa0000-0000-4000-8000-000000000001",
    partyName: "SUCRIÈRE",
    entiteDejaRattacheeId: null,
    entiteExistanteId: null,
    comptes: [
      {
        bankAccountId: "5b31a7c0-0000-4000-8000-0000000000c1",
        accountName: "",
        institutionName: "SBM",
        currency: "MUR",
        entityIdActuel: null,
      },
      {
        bankAccountId: "9f42d1e8-0000-4000-8000-0000000000c2",
        accountName: "",
        institutionName: "SBM",
        currency: "USD",
        entityIdActuel: null,
      },
      {
        bankAccountId: "c70e5b93-0000-4000-8000-0000000000c3",
        accountName: "MCB — Compte courant",
        institutionName: "MCB",
        currency: "MUR",
        entityIdActuel: null,
      },
    ],
  },
  {
    // Party sans nom : on ne peut PAS créer d'entité (name NOT NULL) → l'option de création
    // est désactivée, il faut choisir une entité existante.
    partyId: "bbbb0000-0000-4000-8000-000000000002",
    partyName: null,
    entiteDejaRattacheeId: null,
    entiteExistanteId: null,
    comptes: [
      {
        bankAccountId: "e18b6a24-0000-4000-8000-0000000000c4",
        accountName: "",
        institutionName: "AfrAsia",
        currency: "EUR",
        entityIdActuel: null,
      },
    ],
  },
  {
    // Déjà entièrement rattachée → n'apparaît NI dans le compteur de la bannière, NI dans
    // le panneau (rien à faire).
    partyId: "cccc0000-0000-4000-8000-000000000003",
    partyName: "Énergie",
    entiteDejaRattacheeId: "22222222-2222-4222-8222-222222222222",
    entiteExistanteId: "22222222-2222-4222-8222-222222222222",
    comptes: [
      {
        bankAccountId: "d1d1d1d1-0000-4000-8000-0000000000c5",
        accountName: "MCB — Énergie",
        institutionName: "MCB",
        currency: "MUR",
        entityIdActuel: "22222222-2222-4222-8222-222222222222",
      },
    ],
  },
];

export default function PageDemoSuggestions() {
  return (
    <main className="min-h-screen bg-surface-page p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header>
          <h1 className="text-lg font-semibold text-ink">
            Démo — suggestions de rattachement (L4)
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            4 comptes rattachables sur 5 (le 5ᵉ est déjà lié → il ne compte pas).
            Cliquez « Review » : le doublon « SUCRIÈRE » / « Sucrière » est
            SURFACÉ, jamais fusionné.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            État 1 — des suggestions à traiter
          </h2>
          <BanniereSuggestions
            propositions={PROPOSITIONS}
            entites={ENTITES}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            État 2 — rien à suggérer (la bannière est ABSENTE du DOM)
          </h2>
          <BanniereSuggestions propositions={[]} entites={ENTITES} />
          <p className="rounded-card border border-dashed border-line bg-surface-card p-6 text-center text-sm text-text-muted">
            Aucune bannière : l’écran n’est pas encombré par un bloc vide.
          </p>
        </section>
      </div>
    </main>
  );
}
