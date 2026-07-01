"use client";

/**
 * Démo / Visual QA (Gate 4) du feedback de connexion bancaire — en particulier les
 * états AJOUTÉS par feat/omnifi-native-success : succès COMPLET (redirection vers
 * le Dashboard) vs succès SANS redirection (partiel ou flag `complet` pas encore
 * exposé → bandeau + lien d'action). NON destinée à la production : monte le
 * composant présentationnel pur `WidgetFeedback` avec des états FIGÉS, hors
 * auth/DB/CDN (le vrai widget appelle des Server Actions et charge un script CDN,
 * donc incapturable en headless).
 *
 * À vérifier par vision :
 *   - succès = `text-success` (jamais de rouge, réservé aux montants sortants) ;
 *   - erreur = `text-danger` + alerte ;
 *   - le lien « Voir mon tableau de bord » a une cible (#) et un focus visible ;
 *   - le message de redirection est bref et neutre.
 */
import { WidgetFeedback } from "@/components/widget/widget-feedback";

function Bloc({
  titre,
  description,
  children,
}: {
  titre: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card bg-surface-card p-6 shadow-card">
      <h2 className="mb-1 text-base font-semibold text-text">{titre}</h2>
      <p className="mb-4 max-w-2xl text-sm text-text-muted">{description}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export default function BanqueConnexionDemoPage() {
  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">TYGR</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Connexion bancaire (feedback)
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Feedback du widget — états figés, liens inertes (cible #). Hors production.
      </div>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
        <Bloc
          titre="1. Succès COMPLET — redirection Dashboard"
          description="Toutes les banques rattachées (echecs === 0). Le widget réel lance router.push('/') ; ici on montre le message bref affiché pendant la navigation."
        >
          <WidgetFeedback redirection />
        </Bloc>

        <Bloc
          titre="2. Succès SANS redirection — bandeau + lien"
          description="Succès partiel (au moins un échec) OU flag `complet` pas encore exposé par le Backend. On NE redirige PAS (ne pas masquer un échec) : on confirme et on offre un lien d'action explicite vers le Dashboard."
        >
          <WidgetFeedback succes="Connexion établie — 2 compte(s) rattaché(s) sur 3 banque(s). 1 connexion(s) n'ont pas pu être finalisées." />
          <WidgetFeedback succes="Connexion établie — 3 compte(s) rattaché(s) sur 1 banque(s)." />
        </Bloc>

        <Bloc
          titre="3. Erreur de finalisation"
          description="Message déjà mappé S2 (non énumérant), affiché en text-danger avec role=alert. Pas de redirection."
        >
          <WidgetFeedback erreurFinalisation="La connexion n'a pas pu être finalisée. Réessayez dans un instant." />
        </Bloc>

        <Bloc
          titre="4. Erreur de démarrage (LinkToken)"
          description="Échec à l'ouverture du widget (ex. origine non autorisée en dev http). Affiché en text-danger."
        >
          <WidgetFeedback erreurDemarrage="Paramètres invalides." />
        </Bloc>

        <Bloc
          titre="5. Réparation — bouton « Reconnecter »"
          description="Le re-sync a redemandé une vérification de sécurité (OTP) pour une ou plusieurs banques. Sous le message de synchro, un bouton « Reconnecter » par connexion rouvre le widget natif en mode REPAIR. Action secondaire (lien d'action), jamais en rouge."
        >
          <WidgetFeedback
            succes="Synchronisation effectuée — 4 compte(s) rattaché(s) sur 3 banque(s). 1 banque(s) demandent une nouvelle vérification de sécurité — reconnectez-les pour terminer."
            reparation={[{ connectionId: "cx_demo_1", jobId: "job_demo_1" }]}
            onReconnecter={() => {}}
          />
        </Bloc>

        <Bloc
          titre="6. Réparation — ouverture en cours (bouton désactivé)"
          description="Entre le clic « Reconnecter » et l'obtention du token REPAIR : le bouton passe en « Ouverture… » et se désactive (anti-double-clic). Deux connexions à réparer."
        >
          <WidgetFeedback
            succes="Synchronisation effectuée — 2 compte(s) rattaché(s) sur 2 banque(s). 2 banque(s) demandent une nouvelle vérification de sécurité — reconnectez-les pour terminer."
            reparation={[
              { connectionId: "cx_demo_1", jobId: "job_demo_1" },
              { connectionId: "cx_demo_2", jobId: "job_demo_2" },
            ]}
            onReconnecter={() => {}}
            reparationEnCours
          />
        </Bloc>
      </main>
    </div>
  );
}
