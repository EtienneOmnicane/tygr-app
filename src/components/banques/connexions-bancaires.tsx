/**
 * Liste (présentationnelle PURE) des connexions bancaires du workspace — répond à
 * QA-LISTES-MANQUANTES1a : la page /banques ne montrait que « + Connecter une
 * banque », jamais les banques DÉJÀ reliées. Reçoit un tableau `ConnexionBancaire`
 * DÉJÀ résolu par le RSC (`listerConnexionsBancaires`, RLS-scopé) : zéro fetch,
 * zéro état interne, aucun handler (règle « composants d'affichage purs »).
 *
 * Par connexion : nom d'institution, nombre de comptes rattachés, statut (badge),
 * et fraîcheur de la dernière synchro (réutilise `BalanceFreshnessPill` §3.7 —
 * pastille success/warning/danger, source unique `formaterFraicheurRelative`,
 * règle 8). La DÉCONNEXION est volontairement différée (cascade destructive vers
 * l'append-only) : pas d'action ici (cf. TODOS QA-LISTES-MANQUANTES1b).
 */
import { BalanceFreshnessPill } from "@/components/dashboard/balance-freshness-pill";
import { cn } from "@/components/ui/states/primitives";
import { formaterFraicheurRelative } from "@/lib/format-date";
import type { ConnexionBancaire } from "@/server/db";

/** Libellé FR du statut STOCKÉ (varchar) — repli sur la valeur brute si inconnu. */
function libelleStatut(statut: string): { texte: string; classe: string } {
  switch (statut) {
    case "active":
      return { texte: "Connectée", classe: "bg-success-bg text-success" };
    case "revoked":
      return { texte: "Révoquée", classe: "bg-surface-inset text-text-muted" };
    case "error":
      return { texte: "En erreur", classe: "bg-danger-bg text-danger" };
    default:
      return { texte: statut, classe: "bg-surface-inset text-text-muted" };
  }
}

export function ConnexionsBancaires({
  connexions,
}: {
  /** Connexions DÉJÀ résolues (RLS tenant + scope entité par jointure). */
  connexions: ConnexionBancaire[];
}) {
  if (connexions.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text">
        Banques reliées{" "}
        <span className="font-normal text-text-muted">· {connexions.length}</span>
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface-card">
        {connexions.map((c) => {
          const statut = libelleStatut(c.status);
          const fraicheur = c.lastSyncedAt
            ? formaterFraicheurRelative(c.lastSyncedAt)
            : null;
          return (
            <li
              key={c.connectionId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
            >
              {/* Identité : institution + nombre de comptes rattachés. */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-text">
                  {c.institutionName ?? "Banque connectée"}
                </span>
                <span className="text-[13px] text-text-muted tabular-nums">
                  {c.nbComptes} compte{c.nbComptes > 1 ? "s" : ""} rattaché
                  {c.nbComptes > 1 ? "s" : ""}
                </span>
              </div>

              {/* Fraîcheur de la dernière synchro (§3.7) — si au moins un compte. */}
              {fraicheur && (
                <BalanceFreshnessPill
                  fraicheur={fraicheur}
                  compteLabel={c.institutionName}
                  ctaReconnexion={false}
                />
              )}

              {/* Statut de la connexion. */}
              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
                  statut.classe,
                )}
              >
                {statut.texte}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
