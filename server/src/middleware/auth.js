/** Cookie sessions, one per surface.
 *
 * Desktop and mobile get separate cookies on purpose: on stage the portal and
 * the phone view are open side by side in the same browser, often as
 * different people, and one shared cookie would log one of them out.
 *
 * This is demo auth. It is a random token in a map - not a security control.
 */
import { getSession, touchSession, closeSession } from "../store.js";
import { config } from "../config.js";

export const cookieName = (surface) => `bd_session_${surface}`;

export function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return idx === -1
          ? [part, ""]
          : [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

export function cookieMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  next();
}

export function setSessionCookie(res, surface, token) {
  res.append(
    "Set-Cookie",
    `${cookieName(surface)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
}

export function clearSessionCookie(res, surface) {
  res.append("Set-Cookie", `${cookieName(surface)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Idle time left on a session, in milliseconds. Never negative. */
export function idleRemainingMs(session) {
  const idleFor = Date.now() - Date.parse(session.lastSeenAt ?? session.startedAt);
  return Math.max(0, config.session.idleTimeoutMs - idleFor);
}

/** 401 unless a live session for THIS surface is present and not idle-expired.
 *  An expired session is destroyed, not merely rejected. */
export function requireSession(surface) {
  return (req, res, next) => {
    const token = req.cookies?.[cookieName(surface)];
    const session = getSession(token);
    if (!session || session.surface !== surface) {
      return res.status(401).json({ error: "NOT_AUTHENTICATED", message: "Please sign in again." });
    }
    if (idleRemainingMs(session) === 0) {
      closeSession(token);
      clearSessionCookie(res, surface);
      return res.status(401).json({
        error: "SESSION_EXPIRED",
        message: "Sesi Anda berakhir karena tidak ada aktivitas. Silakan masuk kembali.",
      });
    }
    touchSession(token);
    req.sessionToken = token;
    req.session = session;
    req.userRef = session.userRef;
    next();
  };
}
