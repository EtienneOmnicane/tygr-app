/**
 * Étiquettes d'AXE d'un bucket de flux selon la granularité (L2). Module NEUTRE.
 *
 * ⚠️ RÉUTILISE `format-date.ts` (SOURCE UNIQUE de formatage de date, dette C8) — aucun
 * nom de mois en dur, aucune découpe ad-hoc de "YYYY-MM-DD" ici : on ne fait que CHOISIR
 * le bon formateur existant selon la granularité. Deux formes par bucket :
 *  - `court`   : axe dense (sous la barre) ;
 *  - `complet` : tooltip / colonne du tableau (année explicite, pas d'ambiguïté).
 *
 * Semaine : le bucket est le LUNDI de la semaine ("YYYY-MM-DD") — on le préfixe
 * (« Sem. » / « Semaine du ») pour dire que l'étiquette désigne une SEMAINE, pas un jour.
 */
import {
  formaterDateComptable,
  formaterDateComptableLongue,
  formaterMoisAnnee,
  formaterMoisCourt,
} from "@/lib/format-date";

import type { GranulariteBucket } from "./grille-buckets";

export interface EtiquetteBucket {
  court: string;
  complet: string;
}

export function etiquetteBucket(
  granularite: GranulariteBucket,
  bucket: string,
): EtiquetteBucket {
  switch (granularite) {
    case "mois":
      return {
        court: formaterMoisCourt(bucket),
        complet: formaterMoisAnnee(bucket),
      };
    case "jour":
      return {
        court: formaterDateComptable(bucket),
        complet: formaterDateComptableLongue(bucket),
      };
    case "semaine":
      return {
        court: `Sem. ${formaterDateComptable(bucket)}`,
        complet: `Semaine du ${formaterDateComptableLongue(bucket)}`,
      };
  }
}
