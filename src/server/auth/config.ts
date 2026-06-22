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

import { identite } from "@/server/db";
import { extraireIp } from "@/server/auth/rate-limit-ip";
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
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === "string") {
        session.userId = token.userId;
      }
      session.activeWorkspaceId = token.activeWorkspaceId ?? null;
      return session;
    },
  },
});
