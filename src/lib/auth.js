"use strict";

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isAuthorized(request, expectedToken) {
  if (!expectedToken) return true;
  const header = request.headers["authorization"] || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match && timingSafeEqual(match[1].trim(), expectedToken)) return true;
  try {
    const url = new URL(request.url, "http://localhost");
    const tokenParam = url.searchParams.get("token");
    if (tokenParam && timingSafeEqual(tokenParam, expectedToken)) return true;
  } catch { /* ignore */ }
  const cookie = request.headers["cookie"] || "";
  const cookieMatch = cookie.match(/(?:^|;\s*)mc_token=([^;]+)/);
  if (cookieMatch && timingSafeEqual(decodeURIComponent(cookieMatch[1]), expectedToken)) return true;
  return false;
}

function isPublicPath(pathname) {
  return pathname === "/health" || pathname === "/login" || pathname === "/login.html"
    || pathname === "/styles.css" || pathname === "/login.css";
}

module.exports = { isAuthorized, isPublicPath };
