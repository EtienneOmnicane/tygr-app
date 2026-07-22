/**
 * État « AUCUN COMPTE VISIBLE SOUS MON PÉRIMÈTRE » du dashboard (NUDGE-VISION-ENTITE1).
 * Fine SPÉCIALISATION du `EmptyState` générique, comme `DashboardEmptyState` : ce
 * composant ne choisit que sa copy et son CTA, tout le rendu est délégué (UI-ES1).
 *
 * POURQUOI CET ÉTAT EXISTE — il corrige un écran qui se contredisait lui-même. Un membre
 * dont le périmètre est borné (Vision Entité, ou droit par compte) voit `listerComptes`
 * renvoyer 0 ligne tant que les comptes du tenant ne lui sont pas rattachés — l'ingestion
 * les crée avec `entity_id = NULL` et ne les assigne jamais. Le dashboard lui affichait
 * alors « Aucune banque n'est encore connectée à cet espace », alors que /banques, dans
 * la même session, LUI MONTRE cette banque (bank_connections ne porte pas le scope
 * entité). L'écran niait donc une connexion visible deux clics plus loin.
 *
 * CE QU'IL NE DIT PAS, ET POURQUOI (contrainte de conception, pas de rédaction) :
 * la copy reste muette sur la CAUSE. On ne peut pas savoir, depuis ce périmètre, si les
 * comptes existent et sont masqués ou si la connexion n'en a rattaché aucun : le
 * distinguer exigerait de compter `bank_accounts` hors du scope entité, donc de contourner
 * l'étage 2 d'isolation — interdit (CLAUDE.md règle 2). On décrit donc ce que
 * l'utilisateur CONSTATE (« aucun compte ne vous est accessible »), jamais une cause
 * qu'on n'a pas le droit de vérifier.
 *
 * Ce n'est PAS un état d'erreur (UI_GUIDELINES §3.4) : aucune panne, aucun `danger-bg`,
 * aucun `role="alert"` — la situation est nominale, seul l'accès manque. Le CTA mène à
 * /banques : c'est là que la connexion apparaît, ce qui referme la contradiction.
 */
import { EmptyState } from "@/components/ui/states";

export function DashboardHorsPerimetreState() {
  return (
    <EmptyState
      title="Aucun compte visible dans votre périmètre"
      message={
        <>
          Cet espace a au moins une banque connectée, mais aucun de ses comptes
          n’est rattaché à votre périmètre. Un administrateur peut vous y donner
          accès.
        </>
      }
      cta={{
        label: "Voir les banques connectées",
        href: "/banques",
        // Consultation, pas création : le « + » par défaut annoncerait un ajout.
        glyphe: "→",
      }}
    />
  );
}
