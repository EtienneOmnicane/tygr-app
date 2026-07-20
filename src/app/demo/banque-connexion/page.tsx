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
 *   - succès = `text-text` appuyé (jamais de rouge, réservé aux montants sortants ; et
 *     plus de vert en texte non plus — 3,46:1, sous l'AA, A11Y-VERT-SUCCES1) ;
 *   - erreur = `Callout severite="danger"` (fond + icône + message, §3.4) + alerte ;
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
        <span className="text-lg font-bold tracking-tight">Dodo</span>
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
          description="Succès partiel (au moins un échec) OU flag `complet` pas encore exposé par le Backend. On NE redirige PAS (ne pas masquer un échec) : on confirme et on offre un lien d'action explicite vers le Dashboard. Le TON suit le registre : le partiel est NEUTRE (une phrase d'échec en vert, c'était le faux message de victoire), le complet est vert."
        >
          {/* PARTIEL — registre `neutre` : le message DIT l'échec, le ton ne le contredit pas. */}
          <WidgetFeedback
            registre="neutre"
            succes="Connexion établie — 2 compte(s) rattaché(s) sur 3 banque(s). 1 connexion(s) n'ont pas pu être finalisées."
          />
          {/* COMPLET — zéro réserve : le seul cas qui mérite le vert. */}
          <WidgetFeedback
            registre="succes"
            succes="Connexion établie — 3 compte(s) rattaché(s) sur 1 banque(s)."
          />
        </Bloc>

        <Bloc
          titre="3. Erreur de finalisation"
          description="Message déjà mappé S2 (non énumérant), rendu en Callout danger (fond danger-bg + icône, §3.4) avec role=alert. Pas de redirection."
        >
          <WidgetFeedback erreurFinalisation="La connexion n'a pas pu être finalisée. Réessayez dans un instant." />
        </Bloc>

        <Bloc
          titre="4. Erreur de démarrage (LinkToken)"
          description="Échec à l'ouverture du widget (ex. origine non autorisée en dev http). Rendu en Callout danger (§3.4)."
        >
          <WidgetFeedback erreurDemarrage="Paramètres invalides." />
        </Bloc>

        <Bloc
          titre="5. « Aucune banque à synchroniser » — le silence corrigé"
          description="AVANT : le sync renvoyait { erreur: null, succes: null } quand aucune connexion n'était à traiter → spinner puis RIEN, sans que l'utilisateur sache pourquoi (incident 2026-07-13 : 2 banques en base introuvables chez Omni-FI, 1 banque chez Omni-FI jamais rattachée ici). Registre « information » : ni rouge (rien n'a échoué), ni vert (rien n'a réussi). Chaque signal porte son action."
        >
          <WidgetFeedback info="Aucune banque à synchroniser. 1 banque(s) connectée(s) chez votre fournisseur ne sont pas rattachées à cet espace — finalisez la connexion via « Connecter une banque ». 2 banque(s) de cet espace ne répondent plus — reconnectez-les via « Connecter une banque »." />
          <WidgetFeedback info="Aucune banque connectée à synchroniser — connectez-en une pour commencer." />
          {/* Désync signalée MALGRÉ un succès : sans ça, une banque morte resterait
              invisible derrière le message vert, comptes affichés comme à jour. */}
          <WidgetFeedback
            succes="Synchronisation effectuée — 1 banque(s) à jour, 10 compte(s) mis à jour."
            info="2 banque(s) de cet espace ne répondent plus — reconnectez-les via « Connecter une banque »."
          />
        </Bloc>

        <Bloc
          titre="6. Échec DU WIDGET NATIF (onError du CDN)"
          description="Le widget/la banque a refusé. Avant le correctif, onError était aliasé sur onClose : le widget se fermait SANS UN MOT. Le message vient de messageErreurWidget (registre S2) — jamais le texte amont du CDN (anglais, PII possible) ; le code machine, lui, part au log. Une ANNULATION (onExit), elle, reste silencieuse : rien ne s'affiche ici, c'est voulu."
        >
          <WidgetFeedback erreurWidget="La session de connexion a expiré. Recommencez la connexion." />
          <WidgetFeedback erreurWidget="L’accès à cette banque est temporairement bloqué après trop de tentatives. Réessayez plus tard." />
          <WidgetFeedback erreurWidget="La connexion bancaire a échoué. Réessayez dans un instant." />
          {/* Le script CDN n'a même pas pu se charger (403, CSP, bloqueur, hors-ligne,
              requête gelée). Le CDN ne peut PAS signaler celui-là (il n'est jamais
              arrivé) : c'est le hook (`error`) + un WATCHDOG qui l'exposent. Le message
              dit « rechargez » et non « réessayez » : le hook laisse le <script> mort
              dans le <head>, donc un réessai sans rechargement ne peut pas aboutir. */}
          <WidgetFeedback erreurWidget="Le module de connexion bancaire n’a pas pu se charger. Rechargez la page ; si le problème persiste, contactez le support." />
        </Bloc>

        <Bloc
          titre="7. Réparation — bouton « Reconnecter »"
          description="Le re-sync a redemandé une vérification de sécurité (OTP) pour une ou plusieurs banques. Sous le message de synchro, un bouton « Reconnecter » par connexion rouvre le widget natif en mode REPAIR. Action secondaire (lien d'action), jamais en rouge."
        >
          <WidgetFeedback
            succes="Synchronisation effectuée — 4 compte(s) rattaché(s) sur 3 banque(s). 1 banque(s) demandent une nouvelle vérification de sécurité — reconnectez-les pour terminer."
            reparation={[{ connectionId: "cx_demo_1", jobId: "job_demo_1" }]}
            onReconnecter={() => {}}
          />
        </Bloc>

        <Bloc
          titre="8. Réparation — ouverture en cours (bouton désactivé)"
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

        <Bloc
          titre="9. Réparation — widget déjà ouvert (désactivé, SANS « Ouverture… »)"
          description="Un widget (onboarding ou réparation) est ouvert, ou un LinkToken est en vol : « Reconnecter » est désactivé — on ne peut pas ouvrir deux widgets, et le clic démonterait le widget ouvert sous les pieds de l'utilisateur. Le libellé reste « Reconnecter » : rien ne s'ouvre de ce côté-là, écrire « Ouverture… » mentirait (les deux sens sont portés par deux props distinctes)."
        >
          <WidgetFeedback
            reparation={[{ connectionId: "cx_demo_1", jobId: "job_demo_1" }]}
            onReconnecter={() => {}}
            widgetOuvert
          />
        </Bloc>

        <Bloc
          titre="10. Désalignement EndUser (403) — « Reconnecter cette banque »"
          description="La synchro a répondu 403 (PUBLIC_TOKEN_CLIENT_MISMATCH) pour une banque : son accès n'est plus valide (comptes silencieusement vides). État ACTIONNABLE distinct de la réparation MFA — pas de reprise possible, l'utilisateur relance une connexion via « Connecter une banque ». Message status, jamais en rouge de donnée."
        >
          <WidgetFeedback
            succes="Synchronisation effectuée — 1 banque(s) à jour, 2 compte(s) mis à jour. 1 banque(s) doivent être reconnectées — leur accès n'est plus valide."
            aReconnecter={[{ connectionId: "cx_demo_403" }]}
          />
        </Bloc>
      </main>
    </div>
  );
}
