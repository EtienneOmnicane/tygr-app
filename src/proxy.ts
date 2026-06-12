/**
 * Proxy Next.js 16 (ex-middleware) — redirection « optimiste » vers /login.
 *
 * ATTENTION, FRONTIÈRE DOCUMENTÉE : ceci n'est PAS la barrière de sécurité.
 * Conformément au guide Next (authentication → optimistic checks), le proxy ne
 * fait qu'un test de PRÉSENCE du cookie de session pour l'UX (pas de
 * déchiffrement, pas de DB — un cookie forgé passe ce stade). L'autorisation
 * réelle est appliquée à chaque requête par exigerSessionWorkspace()
 * (re-validation is_active, E6) puis withWorkspace() (membership + RLS, E14).
 */
import { NextResponse, type NextRequest } from "next/server";

const COOKIES_SESSION = [
  "__Secure-authjs.session-token", // HTTPS (production)
  "authjs.session-token", // HTTP (dev local)
];

export function proxy(request: NextRequest) {
  const aUnCookieDeSession = COOKIES_SESSION.some(
    (nom) => request.cookies.get(nom) !== undefined,
  );
  if (!aUnCookieDeSession) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Tout est protégé SAUF : /login, les endpoints Auth.js, les assets Next
  // et les fichiers publics (favicon, images).
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon|.*\\.(?:svg|png|ico|webp)$).*)",
  ],
};
