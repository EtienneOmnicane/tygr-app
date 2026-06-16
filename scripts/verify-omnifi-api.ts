/**
 * Vérification PRÉ-DÉMO de l'API Omni-FI (à lancer le matin de la démo, sur le
 * POSTE DE DÉMO, après avoir renseigné .env). Donne en ~5 s un GO / NO-GO sur la
 * joignabilité ET l'authentification de l'API, AVANT d'ouvrir le widget en public.
 *
 *   node --env-file=.env node_modules/.bin/tsx scripts/verify-omnifi-api.ts
 *
 * Deux étapes :
 *   1. GET {OMNIFI_BASE_URL}/health/  → l'API répond-elle ? (réseau/DNS/TLS/CDN)
 *   2. POST /connections/link-token (via le VRAI client, ApiKey)  → les clés
 *      sont-elles valides et la frontière B2B opérationnelle ?
 *
 * N'écrit RIEN en base, ne monte aucun widget. Lecture seule côté Omni-FI.
 *
 * Règle 8 : ce script ne logge JAMAIS le secret ApiKey ni le LinkToken obtenu —
 * il confirme seulement leur présence/validité (longueur + préfixe masqué). Aucune
 * donnée bancaire. Les routes sont à la RACINE (pas de /v1 — dump tuteur 2026-06-16).
 */
import { creerClientOmniFi } from "@/server/omnifi";
import { obtenirConfigOmniFi } from "@/server/omnifi/config";

/** Lit une var requise ou stoppe avec un message clair (pas de stack). */
function exiger(nom: string): string {
  const v = process.env[nom];
  if (!v || v.trim() === "") {
    console.error(`✗ ${nom} manquante dans .env — impossible de vérifier.`);
    process.exit(1);
  }
  return v.trim();
}

/** RedirectOrigin https sans path : var dédiée, sinon 1re origine https de l'allowlist. */
function redirectOrigin(): string {
  const direct = process.env.OMNIFI_VERIFY_REDIRECT_ORIGIN?.trim();
  if (direct) return direct;
  const allow = (process.env.APP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const https = allow.find((o) => o.startsWith("https://"));
  if (!https) {
    console.error(
      "✗ Aucune origine https dans APP_ALLOWED_ORIGINS (ni OMNIFI_VERIFY_REDIRECT_ORIGIN).\n" +
        "  Le widget exige https → renseigner une origine https dans .env.",
    );
    process.exit(1);
  }
  return https;
}

/** Masque une valeur sensible : on ne montre que sa présence + longueur. */
function presence(valeur: string): string {
  return `présent (${valeur.length} caractères)`;
}

async function main() {
  console.log("=== Vérification pré-démo API Omni-FI ===\n");

  // Config (lève OmniFiConfigError si .env incomplet/hôte non autorisé).
  let config;
  try {
    config = obtenirConfigOmniFi();
  } catch (e) {
    console.error(`✗ Config invalide : ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  console.log(`Base URL      : ${config.baseUrl}`);
  console.log(`Environnement : ${config.environment}`);
  console.log(`Client ID     : ${config.clientId}`);
  console.log(`Secret ApiKey : ${presence(config.secret)}\n`);

  /* ---- Étape 1 : GET /health/ (réseau/DNS/TLS) ---- */
  const healthUrl = `${config.baseUrl}/health/`;
  console.log(`[1/2] GET ${healthUrl}`);
  try {
    const t0 = Date.now();
    const r = await fetch(healthUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const dt = Date.now() - t0;
    if (!r.ok) {
      console.error(`    ✗ HTTP ${r.status} (${dt} ms) — l'API répond mais /health/ n'est pas OK.`);
      process.exit(2);
    }
    console.log(`    ✓ HTTP ${r.status} en ${dt} ms — API joignable.\n`);
  } catch (e) {
    const nom = e instanceof Error ? e.name : "Erreur";
    console.error(
      `    ✗ Échec réseau (${nom}). Causes probables : DNS non résolu, VPN/firewall\n` +
        `      bloquant la sortie, ou mauvaise OMNIFI_BASE_URL. Rien n'a pu être testé au-delà.`,
    );
    process.exit(2);
  }

  /* ---- Étape 2 : POST /connections/link-token (auth ApiKey, vraies clés) ---- */
  const clientUserId = exiger("OMNIFI_DEMO_CLIENT_USER_ID");
  const origin = redirectOrigin();
  console.log(`[2/2] POST /connections/link-token`);
  console.log(`    ClientUserId   : ${clientUserId}`);
  console.log(`    RedirectOrigin : ${origin}`);
  try {
    const client = creerClientOmniFi();
    const lt = await client.creerLinkToken({
      ClientUserId: clientUserId,
      RedirectOrigin: origin,
      AccountSelectionEnabled: true,
    });
    // On NE logge PAS le LinkToken (règle 8) — seulement sa présence + expiration.
    console.log(`    ✓ LinkToken obtenu : ${presence(lt.LinkToken)}`);
    console.log(`    ✓ Expiration       : ${lt.Expiration}\n`);
    console.log("=== GO ✅ — API joignable ET clés valides. Le widget peut être ouvert. ===");
  } catch (e) {
    // Erreurs nommées du client (OmniFiApiError, etc.) : on affiche le code, jamais
    // le secret ni le détail brut OBIE.
    const code =
      e instanceof Error && "code" in e && typeof e.code === "string"
        ? e.code
        : e instanceof Error
          ? e.name
          : "UNKNOWN";
    const statut =
      e instanceof Error && "status" in e && typeof e.status === "number"
        ? ` (HTTP ${e.status})`
        : "";
    console.error(`    ✗ Échec link-token${statut} — code : ${code}`);
    console.error(
      "      Pistes : 401/403 → Client ID/Secret invalides ou non rotés ; 400 →\n" +
        "      RedirectOrigin/ClientUserId rejeté ; 404 → route (vérifier l'absence de /v1).",
    );
    console.error("\n=== NO-GO ❌ — l'API répond mais l'appel authentifié échoue. ===");
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("\n✗ Vérification interrompue :", e instanceof Error ? e.message : e);
  process.exit(1);
});
