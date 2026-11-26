#!/usr/bin/env python3
"""
Prueba de humo de la beta pública: pedir invitación en la landing → aparece en «Por aprobar» → aprobar → canjear el
código de acceso → /app/bienvenida. También los rechazos (sin origen, datos inválidos, trampa, correo repetido,
límite de intentos) y que una solicitud pendiente o rechazada no pueda entrar.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios de prueba (@miconta.test); no limpia al terminar. Sin SMTP_PASSWORD local los correos fallan (y se
registran en el log): la prueba inserta su propio código de acceso para canjearlo.
"""
import hashlib
import http.cookiejar
import json
import os
import secrets
import subprocess
import sys
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
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)

    def call(self, method, path, body=None, origin=BASE):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request) as response:
                payload, status, location = response.read(), response.status, None
        except urllib.error.HTTPError as error:
            payload, status, location = error.read(), error.code, error.headers.get("Location")
        text = payload.decode(errors="replace")
        try:
            return status, json.loads(text), location
        except ValueError:
            return status, {"raw": text}, location


def d1(sql):
    out = subprocess.run(["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql], cwd=ROOT, capture_output=True, text=True).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


def check(description, expected, actual):
    global FAILED
    ok = expected == actual
    FAILED |= not ok
    print(f"  {'✓' if ok else '✗'} {description}" + ("" if ok else f" (esperado {expected!r}, real {actual!r})"))


def ask(client, email, **extra):
    body = {"name": "Ana Beta", "email": email, "interest": "cards", "consent": True, **extra}
    return client.call("POST", "/api/invitations", body)[0]


guest, admin, ana = Client(), Client(), Client()
user_of = lambda email: d1(f"SELECT id, approval_status, beta_member, signup_interest FROM user WHERE email='{email}'")

print("0) Preparación: administrador")
check("sign-up admin", 200, admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})[0])

print("1) La landing es pública y quien tiene sesión entra directo")
check("GET / sin sesión = 200", 200, guest.call("GET", "/")[0])
status, _, location = admin.call("GET", "/")
check("GET / con sesión de admin redirige a /admin", (302, "/admin"), (status, location and location.replace(BASE, "")))

print("2) Rechazos del formulario")
check("sin Origin = 403", 403, guest.call("POST", "/api/invitations", {"name": "X", "email": "x@miconta.test", "consent": True}, origin=None)[0])
status, body, _ = guest.call("POST", "/api/invitations", {"name": "", "email": "nada", "consent": False})
check("datos inválidos = 400 con 3 errores", (400, ["name", "email", "consent"]), (status, [e["field"] for e in body.get("errors", [])]))
check("trampa llena = 200 como si nada", 200, ask(guest, "bot@miconta.test", website="http://spam"))
check("…pero no se guarda", [], user_of("bot@miconta.test"))

print("3) Pedir invitación")
check("solicitud válida = 200", 200, ask(guest, "ana@miconta.test"))
row = user_of("ana@miconta.test")
check("queda pendiente, sin beta, con su interés", [("pending", 0, "cards")], [(r["approval_status"], r["beta_member"], r["signup_interest"]) for r in row])
ana_id = row[0]["id"] if row else ""
check("sin contraseña ni espacio", (0, 0), (scalar(f"SELECT count(*) FROM account WHERE user_id='{ana_id}'"), scalar(f"SELECT count(*) FROM workspace_members WHERE user_id='{ana_id}'")))
check("el mismo correo otra vez responde igual (200)", 200, ask(guest, "ANA@miconta.test"))
check("…y no se duplica", 1, scalar("SELECT count(*) FROM user WHERE email='ana@miconta.test'"))
check("un admin ya registrado también responde 200", 200, ask(guest, "admin@miconta.test"))
check("…y sigue aprobado", "approved", scalar("SELECT approval_status FROM user WHERE email='admin@miconta.test'"))
check("pendiente no puede entrar", 401, ana.call("POST", "/api/auth/sign-in/email", {"email": "ana@miconta.test", "password": PW})[0])
check("otra solicitud para rechazar", 200, ask(guest, "beto@miconta.test"))

print("4) Por aprobar en el admin")
status, body, _ = admin.call("GET", "/admin/por-aprobar")
check("la página lista a ana y beto", (200, True, True), (status, "ana@miconta.test" in body["raw"], "beto@miconta.test" in body["raw"]))
status, body, _ = admin.call("GET", "/admin")
check("la lista de usuarios no los muestra", (200, False), (status, "ana@miconta.test" in body["raw"]))
check("un usuario normal no puede aprobar", 401, guest.call("POST", "/api/admin/approvals", {"ids": [ana_id], "action": "approve"})[0])

print("5) Rechazar y aprobar")
beto_id = user_of("beto@miconta.test")[0]["id"]
status, body, _ = admin.call("POST", "/api/admin/approvals", {"ids": [beto_id], "action": "reject", "note": "prueba"})
check("rechazar = 200, 1", (200, 1), (status, body.get("rejected")))
check("beto queda rechazado con nota", ("rejected", "prueba"), tuple(d1(f"SELECT approval_status, review_note FROM user WHERE id='{beto_id}'")[0].values()))
status, body, _ = admin.call("POST", "/api/admin/approvals", {"ids": [ana_id, beto_id], "action": "approve"})
check("aprobar ana (beto ya no está pendiente) = 1", (200, 1), (status, body.get("approved")))
check("ana aprobada y en la beta", [("approved", 1, "cards")], [(r["approval_status"], r["beta_member"], r["signup_interest"]) for r in user_of("ana@miconta.test")])
check("ana tiene contraseña (credential) y su espacio", (1, "owner"), (scalar(f"SELECT count(*) FROM account WHERE user_id='{ana_id}' AND provider_id='credential'"), scalar(f"SELECT role FROM workspace_members WHERE user_id='{ana_id}'")))
status, body, _ = admin.call("POST", "/api/admin/approvals", {"ids": [ana_id], "action": "approve"})
check("aprobar dos veces no duplica nada", (200, 0, 1), (status, body.get("approved"), scalar(f"SELECT count(*) FROM workspace_members WHERE user_id='{ana_id}'")))

print("6) Canjear el código y entrar")
code = "ABCDE-FGHJK"
d1(f"DELETE FROM access_codes WHERE user_id='{ana_id}'")
d1(f"INSERT INTO access_codes (id, user_id, code_hash, expires_at, created_at) VALUES ('{secrets.token_hex(8)}', '{ana_id}', '{hashlib.sha256(code.encode()).hexdigest()}', {(2**41)}, 0)")
status, body, _ = ana.call("POST", "/api/access", {"code": code.lower(), "password": PW})
check("canjear = 200 → /app/bienvenida", (200, "/app/bienvenida"), (status, body.get("next")))
check("con sesión ve su bienvenida", 200, ana.call("GET", "/app/bienvenida")[0])
check("beto (rechazado) no puede entrar", 401, Client().call("POST", "/api/auth/sign-in/email", {"email": "beto@miconta.test", "password": PW})[0])

print("7) Límite de intentos por IP (5 por hora)")
statuses = [ask(guest, f"lote{i}@miconta.test") for i in range(6)]
check("tras 5 solicitudes, la siguiente = 429", 429, statuses[-1])

print("\nFALLÓ" if FAILED else "\nTodo bien")
sys.exit(1 if FAILED else 0)
