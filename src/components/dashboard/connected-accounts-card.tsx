/**
 * Carte « Comptes connectés » (side-panel du dashboard). Liste chaque compte
 * bancaire relié avec sa PROVENANCE (banque) + son libellé et son solde courant —
 * parité avec le benchmark FYGR. Présentationnel pur : reçoit les comptes résolus.
 *
 * Ordre dans la pile aside : SOLDE (SidePanelKpi) → DÉTAILS → COMPTES CONNECTÉS.
 *
 * Provenance des fonds (DR-F2, refonte 2 lignes 2026-06-22, Lot 4) : la banque et le
 * nom de compte vivent sur DEUX lignes distinctes (banque en label `text-muted` 11px
 * AU-DESSUS, nom de compte 13px DESSOUS), chacune tronquée INDÉPENDAMMENT. Avant, les
 * deux étaient fusionnés (« Banque · Compte ») sur une seule ligne `truncate` ~300px :
 * un nom de banque long (« The Mauritius Commercial Bank ») mangeait le nom de compte.
 * Le montant n'est JAMAIS tronqué (chiffre clé, règle de formatage figée 2026-06-22).
 *
 * `institutionName` fait partie du contrat `CompteConnecte` (string | null, résolu via
 * la connexion). Quand il est absent, la ligne banque est simplement OMISE (dégradation
 * propre : aucune mention « banque inconnue », le compte s'affiche seul).
 *
 * Montants : `formatMontant` (décomposition de chaîne, jamais de float — règle 8),
 * `tabular-nums` pour l'alignement des chiffres. `currentBalance` peut être null
 * (compte sans solde encore synchronisé) → tiret cadratin.
 */
import type { CompteConnecte } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

/**
 * Provenance affichée d'un compte : la banque en LABEL (ligne du dessus) et le nom de
 * compte (ligne du dessous), résolus depuis `CompteConnecte`.
 *
 * - Banque connue + nom de compte distinct → banque en label, compte dessous.
 * - Banque connue mais le nom de compte REPREND déjà la banque (ex. fixtures
 *   « MCB — Compte courant ») → on n'affiche PAS le label banque (il ferait doublon) ;
 *   le nom de compte porte déjà la provenance.
 * - Banque absente → pas de label, nom de compte seul.
 */
function provenance(compte: CompteConnecte): {
  banque: string | null;
  nomCompte: string;
} {
  const banque = compte.institutionName?.trim();
  const nomCompte = compte.accountName.trim();
  if (!banque) return { banque: null, nomCompte };
  // Le nom de compte commence déjà par la banque → le label ferait doublon.
  if (nomCompte.toLowerCase().startsWith(banque.toLowerCase())) {
    return { banque: null, nomCompte };
  }
  return { banque, nomCompte };
}

export function ConnectedAccountsCard({ comptes }: { comptes: CompteConnecte[] }) {
  // Aucun compte → la carte ne se monte pas (l'empty GLOBAL du dashboard a déjà
  // pris le relais en amont ; ici on évite une carte vide superflue).
  if (comptes.length === 0) return null;

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          Comptes connectés
        </span>
        <span className="text-xs font-medium tabular-nums text-text-muted">
          {comptes.length}
        </span>
      </div>
      <ul className="mt-4 flex flex-col divide-y divide-line">
        {comptes.map((compte) => {
          const { banque, nomCompte } = provenance(compte);
          return (
            <li
              key={compte.bankAccountId}
              className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              {/* Identité du compte sur 2 lignes — `min-w-0` autorise le `truncate`
                  des enfants à l'intérieur d'un flex (sinon le flex item refuse de
                  rétrécir et le texte déborderait au lieu de tronquer). */}
              <div className="flex min-w-0 flex-col gap-0.5">
                {banque && (
                  <span
                    className="truncate text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted"
                    title={banque}
                  >
                    {banque}
                  </span>
                )}
                <span className="truncate text-[13px] text-text" title={nomCompte}>
                  {nomCompte}
                </span>
              </div>
              {/* Solde — jamais tronqué (chiffre clé) : `whitespace-nowrap`,
                  `tabular-nums`, et `shrink-0` pour qu'il garde toujours sa place. */}
              <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-text">
                {compte.currentBalance
                  ? formatMontant(compte.currentBalance, compte.currency)
                  : "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </StateCard>
  );
}
