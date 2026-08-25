'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { findUserById, upsertGoogleUser } = require('./db.js');

const COOKIE_NAME = 'phonics_session';
const SESSION_DAYS = 30;

function googleClient() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID chưa được cấu hình trên server.');
  return { clientId, client: new OAuth2Client(clientId) };
}

function jwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (secret.length < 32) throw new Error('JWT_SECRET phải có ít nhất 32 ký tự.');
  return secret;
}

async function verifyGoogleCredential(credential) {
  const { clientId, client } = googleClient();
  const ticket = await client.verifyIdToken({ idToken: String(credential || ''), audience: clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('Google chưa xác minh được email của tài khoản.');
  }
  return payload;
}

async function exchangeGoogleCode(code) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth server chưa được cấu hình đủ GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET.');
  }
  if (!String(code || '').trim()) throw new Error('Google không trả về mã đăng nhập.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code'
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id_token) {
    throw new Error(result.error_description || 'Không đổi được mã Google thành phiên đăng nhập.');
  }
  return verifyGoogleCredential(result.id_token);
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret(), { expiresIn: `${SESSION_DAYS}d` });
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function readToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function authenticateRequest(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Chưa đăng nhập.' });
    const payload = jwt.verify(token, jwtSecret());
    const user = await findUserById(payload.sub);
    if (!user || user.disabled) return res.status(401).json({ ok: false, error: 'Phiên đăng nhập không còn hiệu lực.' });
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: error.message || 'Phiên đăng nhập không hợp lệ.' });
  }
}

function adminSecretMatches(value) {
  const expected = String(process.env.ADMIN_SECRET || '');
  const supplied = String(value || '');
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  const authorization = String(req.headers.authorization || '');
  const supplied = req.headers['x-admin-secret'] || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  if (!adminSecretMatches(supplied)) return res.status(403).json({ ok: false, error: 'Không có quyền quản trị.' });
  return next();
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  const sameSite = secure ? 'SameSite=None' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${sameSite}; ${secure ? 'Secure; ' : ''}Max-Age=${SESSION_DAYS * 86400}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  const sameSite = secure ? 'SameSite=None' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; ${sameSite}; ${secure ? 'Secure; ' : ''}Max-Age=0`);
}

module.exports = {
  COOKIE_NAME,
  verifyGoogleCredential,
  exchangeGoogleCode,
  issueToken,
  authenticateRequest,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie
};
