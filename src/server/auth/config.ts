/**
 * Configuration Auth.js v5 (plan E6, décision #48) — stratégie JWT.
 *
 * Pourquoi JWT et pas sessions DB : l'adaptateur DB et le provider Credentials
 * ne sont pas supportés ensemble par Auth.js (E6). La fraîcheur est garantie
 * autrement : withWorkspace re-valide la MEMBERSHIP à chaque requête (E14) et
 * le bridge session re-valide users.is_active à chaque requête (E6) — un
 * compte désactivé ou retiré perd l'accès à la requête suivante, pas à
 * l'expiration du token.
 *
 * AUTH_SECRET : lu depuis l'environnement par Auth.js (jamais en dur — règle 8).
 */
import argon2 from "argon2";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { identite, listerComptes, withWorkspace } from "@/server/db";
import { extraireIp } from "@/server/auth/rate-limit-ip";
import { normaliserViewFilter } from "@/server/auth/view-filter";
import {
  extraireIdentifiants,
  verifierIdentifiants,
} from "@/server/auth/verifier-identifiants";

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        motDePasse: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials, request) {
        // x-forwarded-for : fiable derrière un proxy de confiance uniquement
        // (Vercel/ALB) — limite documentée dans rate-limit-ip.ts.
        const ip = extraireIp(request.headers.get("x-forwarded-for"));
        const resultat = await verifierIdentifiants(
          {
            identite,
            verifierMotDePasse: (hash, motDePasse) =>
              argon2.verify(hash, motDePasse).catch(() => false),
            maintenant: () => new Date(),
          },
          extraireIdentifiants(credentials),
          ip,
        );

        if (!resultat.ok) {
          // Log structuré (règle 3) : code machine + IP, JAMAIS l'email ni le
          // mot de passe (logs sans PII, règle 8). L'UI reçoit null → message
          // générique unique, quel que soit le code (non-énumération E18).
          console.warn(
            JSON.stringify({
              evenement: "connexion_refusee",
              code: resultat.code,
              ip,
            }),
          );
          return null;
        }

        console.info(
          JSON.stringify({
            evenement: "connexion_reussie",
            userId: resultat.utilisateur.id,
          }),
        );
        return {
          id: resultat.utilisateur.id,
          email: resultat.utilisateur.email,
          name: resultat.utilisateur.fullName,
          // Claim d'invalidation D4 (AUTH-MDP-TEMPO1) : dernier posage de mot
          // de passe en epoch ms, null = jamais posé depuis la migration 0022.
          pwdAt: resultat.utilisateur.passwordChangedAt?.getTime() ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      // `user` n'est défini qu'à la connexion : on fige userId et on résout le
      // workspace actif par défaut = celui qui contient LE PLUS de comptes
      // bancaires (DASH-WSACTIF1), repli déterministe par nom à égalité. Évite le
      // « 0,00 Rs » d'un workspace « groupe » vide qui gagnait par hasard sur une
      // BU pleine (l'ancien choix = 1er membership trié par UUID, arbitraire).
      // Lu sous RLS (own_memberships_select + tenant_isolation), jamais un
      // paramètre client. Null si aucun membership → AucunWorkspaceActifError.
      if (user?.id) {
        token.userId = user.id;
        token.activeWorkspaceId = await identite.membershipParDefaut(user.id);
        // pwdAt (D4) : figé à la connexion depuis la valeur DB lue par
        // authorize. Toute session dont ce claim divergera de la base mourra
        // à sa prochaine requête gardée (exigerCompteValide, session.ts).
        token.pwdAt = user.pwdAt ?? null;
      }

      // Bascule de workspace (Epic 2 / unstable_update) — DÉFENSE EN PROFONDEUR
      // anti-IDOR (S1) : on ne fige JAMAIS un activeWorkspaceId dans le token
      // sans RE-VALIDER que l'utilisateur est membre du workspace visé. La
      // Server Action basculerWorkspace l'a déjà vérifié, mais le callback est
      // la dernière barrière côté écriture du JWT : un appel forgé à
      // update({ activeWorkspaceId }) ne peut pas injecter un tenant étranger.
      if (
        trigger === "update" &&
        typeof token.userId === "string" &&
        session?.activeWorkspaceId
      ) {
        const cible = session.activeWorkspaceId as string;
        const memberships = await identite.membershipsDe(token.userId);
        if (memberships.some((m) => m.workspaceId === cible)) {
          token.activeWorkspaceId = cible;
        }
        // Sinon : silencieusement ignoré — le token garde l'ancien workspace,
        // aucune exposition cross-tenant possible.
      }

      // viewFilter (L8b-1) — sélecteur de périmètre. BLOC SÉPARÉ du précédent
      // (NE PAS fusionner : workspace et filtre ont des signaux et des gardes
      // distincts). Le signal est la PRÉSENCE de la clé `viewFilter` dans le
      // payload d'update (`"viewFilter" in session`), pour distinguer :
      //   • clé ABSENTE   → update non concerné par le filtre → on ne touche à rien
      //                      (p.ex. un futur update qui ne porte que d'autres champs).
      //   • viewFilter = null / [] → RESET explicite → « Groupe » (champ retiré).
      //     (basculerWorkspace envoie `null` pour purger le filtre au changement
      //      de workspace : un filtre d'un autre tenant donnerait un dashboard vide.)
      //   • viewFilter = [ids] → INTENTION du sélecteur. On RE-VALIDE (hygiène de
      //     token, PAS la sécurité — la RLS intersecte de toute façon) : on
      //     n'écrit que les comptes RÉELLEMENT visibles du membre (listerComptes
      //     sous RLS dans le workspace courant du token). Liste vide après
      //     intersection → champ retiré (« Groupe »). Calque de la re-validation
      //     membership ci-dessus : un id forgé ne peut pas s'installer dans le token.
      if (
        trigger === "update" &&
        typeof token.userId === "string" &&
        session !== null &&
        session !== undefined &&
        "viewFilter" in session
      ) {
        const demande = (session as { viewFilter?: unknown }).viewFilter;
        if (
          Array.isArray(demande) &&
          demande.length > 0 &&
          typeof token.activeWorkspaceId === "string"
        ) {
          // Demande non vide : on lit les comptes visibles puis on intersecte.
          // withWorkspace re-valide la membership + applique la RLS (le token a
          // déjà un activeWorkspaceId re-validé). En cas d'échec DB on retombe
          // FAIL-CLOSED sur « Groupe » (champ retiré) plutôt que de persister une
          // demande non vérifiée.
          try {
            const comptes = await withWorkspace(
              {
                userId: token.userId,
                activeWorkspaceId: token.activeWorkspaceId,
              },
              (tx) => listerComptes(tx),
            );
            token.viewFilter = normaliserViewFilter(
              demande as string[],
              comptes.map((c) => c.bankAccountId),
            );
          } catch {
            token.viewFilter = undefined;
          }
        } else {
          // null / [] / non-tableau / pas de workspace résolu → reset « Groupe ».
          token.viewFilter = undefined;
        }
      }

      // pwdAt (AUTH-MDP-TEMPO1 D4) — survie de la session courante après un
      // changement de mot de passe réussi : l'action /account/password appelle
      // unstable_update({ pwdAt }). MÊME discipline que activeWorkspaceId
      // ci-dessus : on n'écrit JAMAIS la valeur cliente — on RE-LIT la base et
      // on pose la valeur DB. Sur échec de lecture, le claim reste inchangé :
      // fail-closed (la garde par-requête comparera et déconnectera au pire).
      if (
        trigger === "update" &&
        typeof token.userId === "string" &&
        session !== null &&
        session !== undefined &&
        "pwdAt" in session
      ) {
        try {
          const etat = await identite.etatCompte(token.userId);
          if (etat) {
            token.pwdAt = etat.passwordChangedAt?.getTime() ?? null;
          }
        } catch {
          // Base injoignable : claim conservé — jamais la valeur cliente.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === "string") {
        session.userId = token.userId;
      }
      session.activeWorkspaceId = token.activeWorkspaceId ?? null;
      // viewFilter (L8b-1) : restitué pour exigerSessionWorkspace (session.ts).
      // null/absent du token ⇒ null ⇒ « Groupe » côté lecture.
      session.viewFilter = token.viewFilter ?? null;
      // pwdAt (D4) : restitué pour la comparaison par-requête (session.ts).
      session.pwdAt = token.pwdAt ?? null;
      return session;
    },
  },
});
