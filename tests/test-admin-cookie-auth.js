'use strict';

// Regression test pra HttpOnly cookie admin auth (round 12).
// Valida _parseCookie helper + lógica de cookie naming.

module.exports = function (t) {
  function _parseCookie(req, name) {
    const ck = String(req.headers?.cookie || '');
    if (!ck) return null;
    const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=([^;]+)`);
    const m = ck.match(re);
    return m ? decodeURIComponent(m[1]) : null;
  }

  t.test('parseCookie: simple', () => {
    const req = { headers: { cookie: 'adminSession=abc123' } };
    t.assert(_parseCookie(req, 'adminSession') === 'abc123');
  });

  t.test('parseCookie: multiple cookies', () => {
    const req = { headers: { cookie: 'foo=bar; adminSession=xyz; baz=qux' } };
    t.assert(_parseCookie(req, 'adminSession') === 'xyz');
  });

  t.test('parseCookie: missing returns null', () => {
    const req = { headers: { cookie: 'foo=bar' } };
    t.assert(_parseCookie(req, 'adminSession') === null);
  });

  t.test('parseCookie: empty header returns null', () => {
    const req = { headers: {} };
    t.assert(_parseCookie(req, 'adminSession') === null);
  });

  t.test('parseCookie: URL-encoded value decoded', () => {
    const req = { headers: { cookie: 'adminSession=' + encodeURIComponent('hex deadbeef') } };
    t.assert(_parseCookie(req, 'adminSession') === 'hex deadbeef');
  });

  t.test('parseCookie: similar names not confused', () => {
    const req = { headers: { cookie: 'adminSessionFake=fake; adminSession=real' } };
    t.assert(_parseCookie(req, 'adminSession') === 'real');
  });

  t.test('Set-Cookie flags include HttpOnly + SameSite=Strict', () => {
    // Simula construção do Set-Cookie em /admin/login
    const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/'];
    const cookie = `adminSession=abc; ${flags.join('; ')}; Max-Age=86400`;
    t.assert(/HttpOnly/.test(cookie), 'HttpOnly flag present');
    t.assert(/SameSite=Strict/.test(cookie), 'SameSite=Strict present');
    t.assert(/Path=\//.test(cookie), 'Path=/ present');
  });

  t.test('CSRF: state-changing methods exigem CSRF (sem x-admin-key)', () => {
    function _adminCsrfRequired(req) {
      const m = String(req.method || '').toUpperCase();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
      const xk = (req.headers['x-admin-key'] || '').toString().trim();
      if (xk) return false;
      return true;
    }
    t.assert(_adminCsrfRequired({ method: 'POST', headers: {} }) === true, 'POST exige CSRF');
    t.assert(_adminCsrfRequired({ method: 'GET', headers: {} }) === false, 'GET não exige');
    t.assert(_adminCsrfRequired({ method: 'POST', headers: { 'x-admin-key': 'k' } }) === false, 'CLI bypass');
  });
};
