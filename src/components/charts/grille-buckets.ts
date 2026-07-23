/**
 * Axe temporel CONTINU d'un graphe de flux, par granularité (L2). Module NEUTRE
 * (`.ts`, aucun `"use client"`, aucun import serveur) : appelé côté SERVEUR par la
 * Server Action de flux (qui en dérive la grille et refuse les fenêtres trop fines).
 *
 * PENDANT de `grilleMois` (dashboard.ts) pour les granularités jour/semaine : même
 * rôle (combler les buckets sans transaction — `cashflowParDevise` OMET un bucket vide,
 * il ne saurait pas dans quelle devise mettre un 0 multi-devise), même arithmétique
 * calendaire ENTIÈRE sur dates « nues » déjà à Maurice (E20 : aucune conversion, aucun
 * `new Date()` local — que `Date.UTC`, qui neutralise le fuseau).
 *
 * ⚠️ Les ÉTIQUETTES produites doivent être IDENTIQUES à celles de `cashflowParDevise`
 * (`FORMAT_BUCKET`, insights.ts) — sinon la jointure grille↔série échoue en silence et
 * un bucket réel apparaît en double (une fois vide via la grille, une fois plein via la
 * série) :
 *  - jour    → "YYYY-MM-DD" (chaque jour) ;
 *  - semaine → "YYYY-MM-DD" du LUNDI de la semaine ISO (= `date_trunc('week', …)` PG) ;
 *  - mois    → "YYYY-MM" (parité prouvée avec `grilleMois`).
 */

export type GranulariteBucket = "jour" | "semaine" | "mois";

/** "YYYY-MM-DD" → instant UTC minuit (date « nue », aucun fuseau). */
function versUtc(iso: string): number {
  const [a, m, j] = iso.split("-").map(Number);
  return Date.UTC(a, m - 1, j);
}

/** Instant UTC → "YYYY-MM-DD". */
function jourIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

const UN_JOUR_MS = 86_400_000;

/**
 * Lundi (ISO) de la semaine contenant `t` (instant UTC), en ms. `getUTCDay()` rend
 * 0=dimanche..6=samedi ; `(jour + 6) % 7` = nombre de jours écoulés depuis lundi. On
 * recule d'autant. Aligné sur `date_trunc('week')` de Postgres (semaine ISO, lundi).
 */
function lundiDeLaSemaine(t: number): number {
  const jour = new Date(t).getUTCDay();
  const depuisLundi = (jour + 6) % 7;
  return t - depuisLundi * UN_JOUR_MS;
}

/**
 * Grille des buckets couvrant [from, to] (dates comptables Maurice "YYYY-MM-DD",
 * bornes INCLUSIVES, from ≤ to), du plus ancien au plus récent. Entrée non valide →
 * `[]` (défensif ; la Server Action valide en amont). Semaine : tous les LUNDIS dont
 * la semaine intersecte [from, to] (le lundi de la semaine de `from` peut précéder
 * `from`, exactement comme le bucket que `date_trunc('week')` produit pour une
 * transaction du milieu de semaine).
 */
export function grilleBuckets(
  granularite: GranulariteBucket,
  from: string,
  to: string,
): string[] {
  if (!estIso(from) || !estIso(to) || from > to) return [];

  if (granularite === "mois") {
    const grille: string[] = [];
    let [a, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const [aFin, mFin] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
    while (a < aFin || (a === aFin && m <= mFin)) {
      grille.push(`${a}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m === 13) {
        m = 1;
        a += 1;
      }
    }
    return grille;
  }

  const finUtc = versUtc(to);
  const pasMs = granularite === "jour" ? UN_JOUR_MS : 7 * UN_JOUR_MS;
  // Semaine : on démarre au LUNDI de la semaine de `from` (bucket réel de PG), qui peut
  // précéder `from`. Jour : on démarre à `from`.
  let t = granularite === "semaine" ? lundiDeLaSemaine(versUtc(from)) : versUtc(from);

  const grille: string[] = [];
  while (t <= finUtc) {
    grille.push(jourIso(t));
    t += pasMs;
  }
  return grille;
}

/** Forme stricte "YYYY-MM-DD" (sans re-valider le calendrier : la Server Action l'a fait). */
function estIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Fenêtre [from, to] (dates comptables Maurice "YYYY-MM-DD", INCLUSIVES) d'UN bucket —
 * pour le drill (L4). Pendant de `grilleBuckets` : mêmes conventions de bord.
 *  - mois    "YYYY-MM"    → 1er au dernier jour du mois ;
 *  - jour    "YYYY-MM-DD" → le jour lui-même ;
 *  - semaine "YYYY-MM-DD" → le lundi (from) au dimanche (from + 6 j).
 * ⚠️ L'appelant (la Server Action) INTERSECTE cette fenêtre avec la fenêtre GLOBALE : un
 * bucket d'extrémité est PARTIEL, et le détail doit couvrir exactement ce que la barre
 * agrège (bornes de la fenêtre écran), pas le bucket entier.
 */
export function bornesBucket(
  granularite: GranulariteBucket,
  bucket: string,
): { from: string; to: string } {
  if (granularite === "mois") {
    const [a, m] = bucket.split("-").map(Number);
    const dernier = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
    return { from: `${bucket}-01`, to: dernier };
  }
  if (granularite === "semaine") {
    const fin = jourIso(versUtc(bucket) + 6 * UN_JOUR_MS);
    return { from: bucket, to: fin };
  }
  return { from: bucket, to: bucket };
}
