/**
 * Panneau de SYNTHÈSE prévisionnelle des échéances (cadrage §3.2). Présentationnel
 * PUR : reçoit la synthèse DÉJÀ agrégée par le serveur (`synthetiserHorizon`) — une
 * entrée par horizon (30 / 60 / 90 j), chacune portant ses lignes PAR DEVISE. Ne
 * fetch rien, ne calcule aucune somme (règle 8 : toute agrégation est faite en SQL,
 * l'UI met juste en forme des chaînes décimales déjà prêtes).
 *
 * Traitement PRÉVISIONNEL (UI_GUIDELINES §3.5) : la synthèse est par nature une
 * projection → fond `surface-forecast` + pastille « Prévision ». Les montants gardent
 * néanmoins leur COULEUR DE SENS (§3.1) — `encaissement` en `inflow`, `decaissement`
 * en `outflow`, `net` coloré par son signe — car perdre le sens entrée/sortie sur une
 * donnée financière est une régression (§3.1 prime : le vert/rouge EST l'information).
 * EXCEPTION zéro (§4.1, même règle que le dashboard — FINDING-007/102) : un montant
 * NUL n'est pas une donnée verte/rouge, c'est une absence → `text-faint`.
 *
 * JAMAIS d'addition cross-devise (règle 8 « Formatage ») : chaque devise a sa propre
 * ligne, ses propres virgules décimales alignées (`tabular-nums`). Un horizon sans
 * échéance affiche une invite neutre, pas un « 0 » trompeur.
 */
import {
  estNegatif,
  estZero,
  formatMontant,
  nomDevise,
} from "@/lib/format-montant";

import type { SyntheseEcheancesUI, SyntheseHorizonDeviseUI } from "./types-echeances";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Teinte du NET selon son signe (sens §3.1) : positif=entrée, négatif=sortie, 0=absence. */
function classeNet(net: string): string {
  if (estZero(net)) return "text-text-faint";
  return estNegatif(net) ? "text-outflow" : "text-inflow";
}

/** Couleur de SENS d'un montant : zéro = donnée absente → `text-faint` (§4.1). */
function classeSens(montant: string, classe: string): string {
  return estZero(montant) ? "text-text-faint" : classe;
}

/** Une ligne de devise dans un horizon : à encaisser / à décaisser / net. */
function LigneDevise({ ligne }: { ligne: SyntheseHorizonDeviseUI }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
        {nomDevise(ligne.devise)}
      </span>
      <dl className="flex flex-col gap-0.5 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">À encaisser</dt>
          <dd
            className={cn(
              "whitespace-nowrap font-medium tabular-nums",
              classeSens(ligne.encaissement, "text-inflow"),
            )}
          >
            {formatMontant(ligne.encaissement, ligne.devise)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">À décaisser</dt>
          <dd
            className={cn(
              "whitespace-nowrap font-medium tabular-nums",
              classeSens(ligne.decaissement, "text-outflow"),
            )}
          >
            {formatMontant(ligne.decaissement, ligne.devise)}
          </dd>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-line pt-1">
          <dt className="font-medium text-text">Net</dt>
          <dd
            className={cn(
              "whitespace-nowrap font-semibold tabular-nums",
              classeNet(ligne.net),
            )}
          >
            {formatMontant(ligne.net, ligne.devise, { signeExplicite: true })}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Un bloc d'horizon (30 / 60 / 90 j) avec ses lignes par devise. */
function BlocHorizon({ jours, lignes }: { jours: number; lignes: SyntheseHorizonDeviseUI[] }) {
  return (
    <div className="flex flex-1 flex-col gap-3 rounded-control border border-line bg-surface-card p-3">
      <p className="text-xs font-semibold text-text">
        {jours} jours
        <span className="ml-1 font-normal text-text-muted">à venir</span>
      </p>
      {lignes.length === 0 ? (
        <p className="text-xs text-text-faint">Aucune échéance sur cet horizon.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {lignes.map((l) => (
            <LigneDevise key={l.devise} ligne={l} />
          ))}
        </div>
      )}
    </div>
  );
}

export function EcheancesSynthese({
  synthese,
  orientation = "auto",
}: {
  synthese: SyntheseEcheancesUI;
  /**
   * Disposition des blocs d'horizon :
   *   - "auto" (défaut) : empilés en colonne, côte à côte dès `sm` (flux plein largeur).
   *   - "vertical" : TOUJOURS empilés — pour le side-panel §1.1 (300px), où une
   *     rangée horizontale déborderait.
   */
  orientation?: "auto" | "vertical";
}) {
  return (
    <section
      aria-label="Synthèse prévisionnelle des échéances"
      className="rounded-card border border-line bg-surface-forecast p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-text">Synthèse prévisionnelle</h2>
        <span className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] font-medium text-text-muted">
          Prévision
        </span>
      </div>
      <p className="mb-4 text-xs text-text-muted">
        Restant dû par horizon (30 / 60 / 90 jours) et par devise — jamais additionné
        entre devises.
      </p>

      <div
        className={cn(
          "flex flex-col gap-3",
          orientation === "auto" && "sm:flex-row",
        )}
      >
        {synthese.map((h) => (
          <BlocHorizon key={h.jours} jours={h.jours} lignes={h.lignes} />
        ))}
      </div>
    </section>
  );
}
