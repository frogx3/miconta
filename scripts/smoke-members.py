#!/usr/bin/env python3
"""
Prueba de humo de miembros e invitaciones (API y pantallas): enlaces de un solo uso, vencimiento, revocación,
roles, aislamiento entre espacios y que quitar a alguien no lo deje sin espacio.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios de prueba (@miconta.test).
"""
import http.cookiejar
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "http://localhost:4321"
PW = "Aa1-" + secrets.token_hex(10)
FAILED = False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def call(self, method, path, body=None, headers=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        merged = {"Content-Type": "application/json", "Origin": BASE, **(headers or {})}
        request = urllib.request.Request(BASE + path, data=data, headers=merged, method=method)
        try:
            with self.opener.open(request) as response:
                payload, status = response.read(), response.status
        except urllib.error.HTTPError as error:
            payload, status = error.read(), error.code
        if raw:
            return status, payload.decode(errors="replace")
        try:
            return status, json.loads(payload)
        except ValueError:
            return status, {"raw": payload.decode(errors="replace")[:200]}


def check(description, expected, actual):
    global FAILED
    ok = expected == actual
    FAILED = FAILED or not ok
    print(f"  {'✓' if ok else '✗'} {description:<78} {actual}" + ("" if ok else f"   (esperado {expected})"))


def d1(sql):
    out = subprocess.run(["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql], cwd=ROOT, capture_output=True, text=True).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


def signup(token, name, email):
    time.sleep(11)  # el registro tiene límite de intentos (3 por 10 s; pocas pausas largas)
    client = Client()
    status, body = client.call("POST", "/api/auth/sign-up/email", {"name": name, "email": email, "password": PW, "locale": "es-MX"}, {"x-invite-token": token} if token else None)
    return client, status, body


def invite(owner, role="member", days=7):
    status, body = owner.call("POST", "/api/members/invitations", {"role": role, "days": days})
    return status, body, (body.get("url", "").rsplit("/", 1)[-1] if status == 201 else "")


print("0) Preparación: admin del sistema y el usuario A (dueño de su espacio)")
admin = Client()
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
_, created = admin.call("POST", "/api/auth/admin/create-user", {"name": "Usuario A", "email": "a@miconta.test", "password": PW, "role": "user", "data": {"locale": "es-MX"}})
a = Client()
check("sign-in de A", 200, a.call("POST", "/api/auth/sign-in/email", {"email": "a@miconta.test", "password": PW})[0])
ws = scalar("SELECT id FROM workspaces WHERE name='Usuario A'")
a.call("POST", "/api/accounts", {"name": "Cuenta de A", "bank": "Banorte"})

print("1) Crear invitaciones: validación y permisos")
check("sin sesión no se puede invitar", 401, Client().call("POST", "/api/members/invitations", {"role": "member", "days": 7})[0])
check("rol 'owner' no existe como invitación", 400, a.call("POST", "/api/members/invitations", {"role": "owner", "days": 7})[0])
check("vigencia fuera de las opciones", 400, a.call("POST", "/api/members/invitations", {"role": "member", "days": 3})[0])
status, body, token_member = invite(a, "member")
check("el dueño crea una invitación de miembro", 201, status)
check("el enlace apunta a /invitacion/<token>", True, body["url"].startswith(BASE + "/invitacion/") and len(token_member) >= 40)
check("la base guarda la huella, no el token", (True, 0), (len(scalar("SELECT token_hash FROM workspace_invitations LIMIT 1")) == 64, scalar(f"SELECT count(*) FROM workspace_invitations WHERE token_hash='{token_member}'")))

print("2) Registro: cerrado sin invitación, abierto con una vigente, de un solo uso")
check("sin invitación el registro sigue cerrado", 403, signup(None, "X", "x@miconta.test")[1])
check("token inventado", 403, signup("inventado", "X", "x@miconta.test")[1])
anon_page = Client().call("GET", f"/invitacion/{token_member}", raw=True)
check("la página de invitación carga y nombra el espacio", (200, True), (anon_page[0], "Usuario A" in anon_page[1]))
check("un token inválido muestra la página de enlace no válido", (200, True), (lambda r: (r[0], "ya no es válido" in r[1]))(Client().call("GET", "/invitacion/inventado", raw=True)))
b, status, _ = signup(token_member, "Usuario B", "b@miconta.test")
check("con la invitación B se registra", 200, status)
check("B quedó como miembro del espacio de A", "member", scalar(f"SELECT m.role FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email='b@miconta.test' AND m.workspace_id='{ws}'"))
check("…y no recibió un espacio propio", 1, scalar("SELECT count(*) FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email='b@miconta.test'"))
check("el rol global de B es 'user'", "user", scalar("SELECT role FROM user WHERE email='b@miconta.test'"))
check("el enlace ya no sirve (un solo uso)", 403, signup(token_member, "Y", "y@miconta.test")[1])
check("la página del enlace usado dice que no es válido", True, "ya no es válido" in Client().call("GET", f"/invitacion/{token_member}", raw=True)[1])
check("usada_por quedó registrado", "b@miconta.test", scalar("SELECT u.email FROM workspace_invitations i JOIN user u ON u.id=i.used_by"))

print("3) B (miembro) ve y escribe en el espacio de A, pero no gestiona")
status, html = b.call("GET", "/app/cuentas", raw=True)
check("B ve las cuentas de A", (200, True), (status, "Cuenta de A" in html))
check("B (miembro) puede crear una cuenta", 201, b.call("POST", "/api/accounts", {"name": "Cuenta de B", "bank": "BBVA"})[0])
check("B no puede crear invitaciones", 403, b.call("POST", "/api/members/invitations", {"role": "viewer", "days": 7})[0])
ids = {r["email"]: r["id"] for r in d1("SELECT id, email FROM user")}
check("B no puede cambiar roles", 403, b.call("PATCH", f"/api/members/{ids['a@miconta.test']}", {"role": "viewer"})[0])
check("la pantalla de miembros carga para B, sin formulario de invitar", (200, False), (lambda r: (r[0], 'id="invite-form"' in r[1]))(b.call("GET", "/app/miembros", raw=True)))
check("la pantalla de miembros carga para A, con formulario de invitar", (200, True), (lambda r: (r[0], 'id="invite-form"' in r[1]))(a.call("GET", "/app/miembros", raw=True)))

print("4) Roles: cambiar, lectura, y el dueño es intocable")
check("A pasa a B a solo lectura", 200, a.call("PATCH", f"/api/members/{ids['b@miconta.test']}", {"role": "viewer"})[0])
check("B (lectura) ya no puede escribir", 403, b.call("POST", "/api/accounts", {"name": "Otra", "bank": "X"})[0])
check("no se puede dar el rol de dueño", 400, a.call("PATCH", f"/api/members/{ids['b@miconta.test']}", {"role": "owner"})[0])
check("nadie puede cambiar al dueño", 403, a.call("PATCH", f"/api/members/{ids['a@miconta.test']}", {"role": "member"})[0])
check("el dueño no puede quitarse a sí mismo", 403, a.call("DELETE", f"/api/members/{ids['a@miconta.test']}")[0])
check("miembro inexistente", 404, a.call("PATCH", "/api/members/no-existe", {"role": "member"})[0])

print("5) Un administrador invitado: invita menos que el dueño y no toca a otros administradores")
_, _, token_admin = invite(a, "admin")
d, status, _ = signup(token_admin, "Usuario D", "d@miconta.test")
check("D se registra con invitación de administrador", 200, status)
check("D invita a un lector", 201, d.call("POST", "/api/members/invitations", {"role": "viewer", "days": 1})[0])
check("D no puede invitar administradores", 400, d.call("POST", "/api/members/invitations", {"role": "admin", "days": 1})[0])
ids = {r["email"]: r["id"] for r in d1("SELECT id, email FROM user")}
check("D no puede cambiar al dueño", 403, d.call("PATCH", f"/api/members/{ids['a@miconta.test']}", {"role": "viewer"})[0])
check("D puede cambiar a B (lector → miembro)", 200, d.call("PATCH", f"/api/members/{ids['b@miconta.test']}", {"role": "member"})[0])
check("D no puede dar el rol de administrador", 403, d.call("PATCH", f"/api/members/{ids['b@miconta.test']}", {"role": "admin"})[0])

print("6) Revocar y vencer")
_, _, token_revoked = invite(a, "viewer")
newest = "SELECT id FROM workspace_invitations WHERE used_at IS NULL AND revoked_at IS NULL ORDER BY rowid DESC LIMIT 1"
revoke_id = scalar(newest)
check("A revoca una invitación pendiente", 200, a.call("DELETE", "/api/members/invitations", {"id": revoke_id})[0])
check("revocar otra vez", 404, a.call("DELETE", "/api/members/invitations", {"id": revoke_id})[0])
check("el enlace revocado no sirve", 403, signup(token_revoked, "W", "w@miconta.test")[1])
_, _, token_old = invite(a, "viewer")
d1(f"UPDATE workspace_invitations SET expires_at = 1000 WHERE id = ({newest})")
check("una invitación vencida no sirve", 403, signup(token_old, "Z", "z@miconta.test")[1])
check("no quedó ningún usuario creado por enlaces inválidos", 0, scalar("SELECT count(*) FROM user WHERE email IN ('w@miconta.test','z@miconta.test','x@miconta.test','y@miconta.test')"))

print("7) Aislamiento entre espacios")
_, created_e = admin.call("POST", "/api/auth/admin/create-user", {"name": "Usuario E", "email": "e@miconta.test", "password": PW, "role": "user", "data": {"locale": "es-MX"}})
e = Client()
time.sleep(11)
check("sign-in de E", 200, e.call("POST", "/api/auth/sign-in/email", {"email": "e@miconta.test", "password": PW})[0])
check("E (dueño de otro espacio) no encuentra a B para cambiarle el rol", 404, e.call("PATCH", f"/api/members/{ids['b@miconta.test']}", {"role": "viewer"})[0])
check("…ni para quitarlo", 404, e.call("DELETE", f"/api/members/{ids['b@miconta.test']}")[0])
pending_a = scalar("SELECT id FROM workspace_invitations WHERE used_at IS NULL AND revoked_at IS NULL LIMIT 1")
if pending_a:
    check("E no puede revocar invitaciones de A", 404, e.call("DELETE", "/api/members/invitations", {"id": pending_a})[0])

print("8) Quitar a un miembro: conserva su cuenta, recibe un espacio propio, ya no ve el de A")
check("A quita a B", 200, a.call("DELETE", f"/api/members/{ids['b@miconta.test']}")[0])
check("B ya no es miembro del espacio de A", 0, scalar(f"SELECT count(*) FROM workspace_members WHERE workspace_id='{ws}' AND user_id='{ids['b@miconta.test']}'"))
check("B tiene ahora un espacio propio donde es dueño", ("owner", 1), (lambda r: (r[0]["role"], len(r)))(d1(f"SELECT role FROM workspace_members WHERE user_id='{ids['b@miconta.test']}'")))
status, html = b.call("GET", "/app/cuentas", raw=True)
check("B sigue pudiendo usar la app (sin bucle) y ya no ve las cuentas de A", (200, False), (status, "Cuenta de A" in html))
check("lo que B registró se queda en el espacio de A", 1, scalar(f"SELECT count(*) FROM accounts WHERE name='Cuenta de B' AND workspace_id='{ws}'"))

print("9) Eliminar desde el panel admin a quien creó invitaciones (sin datos financieros)")
admin.call("POST", "/api/auth/admin/create-user", {"name": "Usuario F", "email": "f@miconta.test", "password": PW, "role": "user", "data": {"locale": "es-MX"}})
time.sleep(11)
f = Client()
check("sign-in de F", 200, f.call("POST", "/api/auth/sign-in/email", {"email": "f@miconta.test", "password": PW})[0])
check("F invita a alguien", 201, f.call("POST", "/api/members/invitations", {"role": "viewer", "days": 1})[0])
fid = scalar("SELECT id FROM user WHERE email='f@miconta.test'")
check("el admin elimina a F pese a su invitación", 200, admin.call("DELETE", f"/api/admin/users/{fid}")[0])
check("su invitación y su espacio ya no existen", (0, 0), (scalar(f"SELECT count(*) FROM workspace_invitations WHERE created_by='{fid}'"), scalar(f"SELECT count(*) FROM workspace_members WHERE user_id='{fid}'")))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
