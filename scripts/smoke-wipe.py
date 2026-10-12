#!/usr/bin/env python3
"""
Prueba de humo del borrado de datos de un usuario desde el panel de administración: que se vaya toda la
información financiera de su espacio (respetando las llaves foráneas), que el usuario, su acceso y su espacio
se conserven, que no toque a otros usuarios, y los permisos y bloqueos (no admin, uno mismo, espacio compartido).

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios y datos de prueba (@miconta.test).
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
TABLES = [
    "plan_events", "movements", "plan_tags", "goal_entries", "goals", "plans", "category_rules", "categories",
    "tags", "statement_cutoffs", "import_batches", "import_profiles", "cards", "accounts",
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def call(self, method, path, body=None, origin=BASE, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request) as response:
                payload, status, location = response.read(), response.status, None
        except urllib.error.HTTPError as error:
            payload, status, location = error.read(), error.code, error.headers.get("Location")
        if raw:
            return status, payload.decode(errors="replace"), location
        try:
            return status, json.loads(payload)
        except ValueError:
            return status, {"raw": payload.decode(errors="replace")[:200]}


def check(description, expected, actual):
    global FAILED
    ok = expected == actual
    FAILED = FAILED or not ok
    print(f"  {'✓' if ok else '✗'} {description:<76} {actual}" + ("" if ok else f"   (esperado {expected})"))


def d1(sql):
    out = subprocess.run(
        ["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


def count(table, ws):
    if table == "plan_tags":
        return scalar(f"SELECT count(*) FROM plan_tags WHERE plan_id IN (SELECT id FROM plans WHERE workspace_id='{ws}')")
    return scalar(f"SELECT count(*) FROM {table} WHERE workspace_id='{ws}'")


def counts(ws):
    return {table: count(table, ws) for table in TABLES}


def seed(client, ws, user_id, tag):
    """Una fila en cada tabla de datos del espacio; las referencias cruzadas son las reales."""
    _, body = client.call("POST", "/api/accounts", {"name": f"Cuenta {tag}", "bank": "Banorte"})
    account = body["id"]
    _, body = client.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "15"})
    card = body["id"]
    sql = [
        f"INSERT INTO import_profiles (id, workspace_id, account_id, name, config) VALUES ('prof-{tag}', '{ws}', '{account}', 'perfil', '{{}}')",
        f"INSERT INTO import_batches (id, workspace_id, account_id, profile_id, file_name, created_by) VALUES ('batch-{tag}', '{ws}', '{account}', 'prof-{tag}', 'a.csv', '{user_id}')",
        f"INSERT INTO categories (id, workspace_id, name) VALUES ('cat-{tag}', '{ws}', 'Comida')",
        f"INSERT INTO category_rules (id, workspace_id, category_id, pattern) VALUES ('rule-{tag}', '{ws}', 'cat-{tag}', 'OXXO')",
        f"INSERT INTO tags (id, workspace_id, name) VALUES ('tag-{tag}', '{ws}', 'Casa')",
        "INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, first_charge_date) "
        f"VALUES ('plan-{tag}', '{ws}', '{card}', 'msi', 'Seguro', 'SEGURO', 'MXN', 120000, 10000, 12, '2026-07-06')",
        f"INSERT INTO plan_tags (plan_id, tag_id) VALUES ('plan-{tag}', 'tag-{tag}')",
        "INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, charge_minor, currency, category_id, plan_id, plan_installment_no) "
        f"VALUES ('mov-{tag}', '{ws}', '{account}', '{card}', 'batch-{tag}', 'k#1', '2026-07-06', 'SEGURO', 'SEGURO', 10000, 'MXN', 'cat-{tag}', 'plan-{tag}', 1)",
        "INSERT INTO plan_events (id, workspace_id, plan_id, type, movement_id, batch_id, actor_user_id) "
        f"VALUES ('ev-{tag}', '{ws}', 'plan-{tag}', 'created', 'mov-{tag}', 'batch-{tag}', '{user_id}')",
        f"INSERT INTO statement_cutoffs (id, workspace_id, account_id, cutoff_date) VALUES ('cut-{tag}', '{ws}', '{account}', '2026-10-02')",
        f"INSERT INTO goals (id, workspace_id, type, name, currency, target_date, plan_id, created_by) VALUES ('goal-{tag}', '{ws}', 'payoff_plan', 'Liquidar', 'MXN', '2027-01-01', 'plan-{tag}', '{user_id}')",
        f"INSERT INTO goals (id, workspace_id, type, name, currency, target_amount_minor, created_by) VALUES ('sav-{tag}', '{ws}', 'savings', 'Ahorro', 'MXN', 500000, '{user_id}')",
        f"INSERT INTO goal_entries (id, workspace_id, goal_id, amount_minor, date, created_by) VALUES ('ent-{tag}', '{ws}', 'sav-{tag}', 10000, '2026-10-01', '{user_id}')",
    ]
    for statement in sql:
        d1(statement)


admin, a, b, c, anon = Client(), Client(), Client(), Client(), Client()

print("0) Preparación: admin; A y B con datos propios; C comparte su espacio con D")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
ids = {}
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test"), ("Usuario C", "c@miconta.test"), ("Usuario D", "d@miconta.test")):
    _, body = admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
    ids[email] = body["user"]["id"]
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test"), (c, "c@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
admin_id = scalar("SELECT id FROM user WHERE email='admin@miconta.test'")
ws = {k: scalar(f"SELECT id FROM workspaces WHERE name='Usuario {k.upper()}'") for k in "abcd"}
# D entra al espacio de C como miembro y borra el suyo, para que C sea compartido.
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['d@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws['c']}', '{ids['d@miconta.test']}', 'member')")
for tag, client, email in (("a", a, "a@miconta.test"), ("b", b, "b@miconta.test"), ("c", c, "c@miconta.test")):
    seed(client, ws[tag], ids[email], tag)
before_b = counts(ws["b"])
check("A tiene datos en las 14 tablas", True, all(n >= 1 for n in counts(ws["a"]).values()))

print("1) Permisos y bloqueos")
url = lambda email: f"/api/admin/users/{ids[email]}/data"
check("sin sesión: 401", 401, anon.call("DELETE", url("a@miconta.test"))[0])
check("un usuario normal no puede: 403", 403, b.call("DELETE", url("a@miconta.test"))[0])
check("origen ajeno: 403", 403, admin.call("DELETE", url("a@miconta.test"), origin="http://evil.test")[0])
check("el admin no puede borrarse los datos a sí mismo: 400", 400, admin.call("DELETE", f"/api/admin/users/{admin_id}/data")[0])
check("usuario inexistente: 404", 404, admin.call("DELETE", "/api/admin/users/no-existe/data")[0])
status, body = admin.call("DELETE", url("c@miconta.test"))
check("espacio compartido: 409 SHARED_WORKSPACE", (409, "SHARED_WORKSPACE"), (status, body.get("code")))
check("…y no se tocó nada", True, all(n >= 1 for n in counts(ws["c"]).values()))
check("A sigue intacto tras los intentos fallidos", True, all(n >= 1 for n in counts(ws["a"]).values()))

print("2) Borrar los datos de A")
status, body = admin.call("DELETE", url("a@miconta.test"))
check("el admin borra los datos de A", (200, True), (status, body.get("ok")))
check("no queda nada en las 14 tablas del espacio de A", {t: 0 for t in TABLES}, counts(ws["a"]))
check("el usuario A sigue existiendo", 1, scalar("SELECT count(*) FROM user WHERE email='a@miconta.test'"))
check("…con su espacio y su membresía de dueño", ("Usuario A", "owner"), (scalar(f"SELECT name FROM workspaces WHERE id='{ws['a']}'"), scalar(f"SELECT role FROM workspace_members WHERE workspace_id='{ws['a']}' AND user_id='{ids['a@miconta.test']}'")))
check("los datos de B no cambiaron", before_b, counts(ws["b"]))
check("A sigue pudiendo iniciar sesión", 200, a.call("POST", "/api/auth/sign-in/email", {"email": "a@miconta.test", "password": PW})[0])
status, html, _ = a.call("GET", "/app/cuentas", raw=True)
check("la pantalla de cuentas de A carga y ya no muestra su cuenta", (200, False), (status, "Cuenta a" in html))
check("A puede volver a crear una cuenta", 201, a.call("POST", "/api/accounts", {"name": "Nueva", "bank": "BBVA"})[0])
check("repetir el borrado es inocuo (idempotente)", 200, admin.call("DELETE", url("a@miconta.test"))[0])

print("3) Pantalla del panel")
status, html, _ = admin.call("GET", f"/admin/users/{ids['b@miconta.test']}", raw=True)
check("la ficha de B ofrece borrar datos", (200, True), (status, 'id="wipe-data"' in html))
status, html, _ = admin.call("GET", f"/admin/users/{ids['c@miconta.test']}", raw=True)
check("la ficha de C (espacio compartido) no ofrece el botón", (200, False), (status, 'id="wipe-data"' in html))
check("la ficha del propio admin no ofrece el botón", False, 'id="wipe-data"' in admin.call("GET", f"/admin/users/{admin_id}", raw=True)[1])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
