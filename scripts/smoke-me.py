#!/usr/bin/env python3
"""
Prueba de humo de la portada y Tu cuenta: agenda en la portada, avisos del día, ajustes, invitación permanente,
respaldo en cola (CSV), Reboot, borrar cuenta en stand-by (restablecer y eliminar desde admin) y purga a los 30 días.

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
    )
    try:
        return json.loads(out.stdout)[0]["results"]
    except (ValueError, KeyError, IndexError):
        raise SystemExit(f"D1 falló: {sql}\n{out.stdout[-800:]}{out.stderr[-800:]}")


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None



def count(table, ws):
    if table == "plan_tags":
        return scalar(f"SELECT count(*) FROM plan_tags WHERE plan_id IN (SELECT id FROM plans WHERE workspace_id='{ws}')")
    return scalar(f"SELECT count(*) FROM {table} WHERE workspace_id='{ws}'")


def seed(client, ws, user_id, tag):
    """Datos en todas las tablas del espacio, incluidas agenda y saldos (las que el borrado viejo olvidaba)."""
    _, body = client.call("POST", "/api/accounts", {"name": f"Cuenta {tag}", "bank": "Banorte"})
    account = body["id"]
    _, body = client.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "15"})
    card = body["id"]
    for statement in [
        f"INSERT INTO import_profiles (id, workspace_id, account_id, name, config) VALUES ('prof-{tag}', '{ws}', '{account}', 'perfil', '{{}}')",
        f"INSERT INTO import_batches (id, workspace_id, account_id, profile_id, file_name, created_by) VALUES ('batch-{tag}', '{ws}', '{account}', 'prof-{tag}', 'a.csv', '{user_id}')",
        f"INSERT INTO categories (id, workspace_id, name) VALUES ('cat-{tag}', '{ws}', 'Comida')",
        "INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, first_charge_date) "
        f"VALUES ('plan-{tag}', '{ws}', '{card}', 'msi', 'Seguro', 'SEGURO', 'MXN', 120000, 10000, 12, '2026-07-06')",
        "INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, charge_minor, currency, category_id, plan_id, plan_installment_no) "
        f"VALUES ('mov-{tag}', '{ws}', '{account}', '{card}', 'batch-{tag}', 'k#1', '2026-07-06', '=SEGURO, \"AXA\"', 'SEGURO', 123456, 'MXN', 'cat-{tag}', 'plan-{tag}', 1)",
        f"INSERT INTO plan_events (id, workspace_id, plan_id, type, movement_id, batch_id, actor_user_id) VALUES ('ev-{tag}', '{ws}', 'plan-{tag}', 'created', 'mov-{tag}', 'batch-{tag}', '{user_id}')",
        f"INSERT INTO agenda_items (id, workspace_id, kind, description, amount_minor, currency, due_date, card_id) VALUES ('ag-card-{tag}', '{ws}', 'payable', 'Pago tarjeta', 50000, 'MXN', '2026-01-10', '{card}')",
        f"INSERT INTO cash_balances (id, workspace_id, card_id, currency, amount_minor) VALUES ('bal-{tag}', '{ws}', '{card}', 'MXN', 100000)",
    ]:
        d1(statement)
    # Un pago que vence hoy (para el aviso) por la API, como lo captura la persona.
    status, _ = client.call("POST", "/api/agenda/items", {"kind": "payable", "description": f"Luz {tag}", "amount": "850.50", "dueDate": TODAY})
    return status


TODAY = scalar("SELECT date('now')")
TABLES = ["agenda_items", "cash_balances", "backup_exports", "plan_events", "movements", "plans", "categories", "import_batches", "import_profiles", "cards", "accounts"]
admin, a, b, c, d, anon = Client(), Client(), Client(), Client(), Client(), Client()

print("0) Preparación: admin; A y B con datos; C es dueño de un espacio donde D es miembro")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
ids = {}
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test"), ("Usuario C", "c@miconta.test"), ("Usuario D", "d@miconta.test")):
    _, body = admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
    ids[email] = body["user"]["id"]
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test"), (c, "c@miconta.test"), (d, "d@miconta.test")):
    d1("DELETE FROM rate_limit")
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
ws = {k: scalar(f"SELECT id FROM workspaces WHERE name='Usuario {k.upper()}'") for k in "abcd"}
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['d@miconta.test']}'")
d1(f"DELETE FROM workspaces WHERE id='{ws['d']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws['c']}', '{ids['d@miconta.test']}', 'member')")
check("A captura un pago que vence hoy", 201, seed(a, ws["a"], ids["a@miconta.test"], "a"))
seed(b, ws["b"], ids["b@miconta.test"], "b")

print("1) Portada y avisos")
status, html, _ = a.call("GET", "/app", raw=True)
check("la portada muestra la agenda del mes", (200, True), (status, 'class="card home-agenda' in html))
check("…y el aviso de que hoy toca pagar", True, 'notice notice-due' in html and "Luz a" in html)
check("…y ya no muestra el bloque de espacio/rol/moneda", False, 'class="facts"' in html)
status, html, _ = c.call("GET", "/app", raw=True)
check("C (sin agenda) no ve el bloque de agenda ni avisos", (200, False, False), (status, 'class="card home-agenda' in html, 'notice notice-due' in html))
check("ajuste con valor inválido: 400", 400, a.call("PATCH", "/api/me/settings", {"inAppNotifications": "no"})[0])
check("ajuste desde otro origen: 403", 403, a.call("PATCH", "/api/me/settings", {"inAppNotifications": False}, origin="http://evil.test")[0])
check("A apaga los avisos", 200, a.call("PATCH", "/api/me/settings", {"inAppNotifications": False})[0])
check("…y ya no salen", False, 'notice notice-due' in a.call("GET", "/app", raw=True)[1])
a.call("PATCH", "/api/me/settings", {"inAppNotifications": True})
d1(f"UPDATE workspace_members SET role='viewer' WHERE user_id='{ids['d@miconta.test']}'")
check("quien solo lee también cambia sus avisos", 200, d.call("PATCH", "/api/me/settings", {"inAppNotifications": True})[0])

print("2) Tu cuenta y Miembros")
status, html, _ = a.call("GET", "/app/cuenta", raw=True)
check("Tu cuenta carga con estatus, miembros, configuración, respaldo y zona de peligro", (200, True), (status, all(x in html for x in ['id="estatus"', 'id="miembros"', 'id="configuracion"', 'id="respaldo"', 'id="peligro"'])))
status, _, location = a.call("GET", "/app/miembros", raw=True)
check("/app/miembros redirige a Tu cuenta", (301, "/app/cuenta#miembros"), (status, location))
status, body = c.call("POST", "/api/members/invitations", {"role": "member", "days": 0})
check("invitación permanente", (201, "9999"), (status, (body.get("expiresAt") or "")[:4]))
check("…aparece sin vencimiento", True, "Sin vencimiento" in c.call("GET", "/app/cuenta", raw=True)[1])
check("vigencia no permitida: 400", 400, c.call("POST", "/api/members/invitations", {"role": "member", "days": 3})[0])

print("3) Respaldo en cola")
status, body = a.call("POST", "/api/me/backups", {})
check("A pide un respaldo: 202", 202, status)
backup = body.get("id")
for _ in range(30):
    if scalar(f"SELECT status FROM backup_exports WHERE id='{backup}'") in ("ready", "failed"):
        break
    time.sleep(1)
check("la cola lo genera", "ready", scalar(f"SELECT status FROM backup_exports WHERE id='{backup}'"))
status, csv, _ = a.call("GET", f"/api/me/backups/{backup}/gastos", raw=True)
check("descarga gastos.csv con el movimiento escapado y el monto decimal", (200, True, True), (status, "\"'=SEGURO, \"\"AXA\"\"\"" in csv, "1234.56" in csv))
status, csv, _ = a.call("GET", f"/api/me/backups/{backup}/pagos", raw=True)
check("descarga pagos.csv con la agenda", (200, True, True), (status, "Luz a" in csv, "850.50" in csv))
check("otro espacio no lo puede descargar: 404", 404, b.call("GET", f"/api/me/backups/{backup}/gastos", raw=True)[0])
check("archivo desconocido: 404", 404, a.call("GET", f"/api/me/backups/{backup}/otro", raw=True)[0])
check("aviso de respaldo listo", True, "data-notice-backup" in a.call("GET", "/app", raw=True)[1])
a.call("PATCH", "/api/me/backups", {})
check("…marcado como visto ya no sale", False, "data-notice-backup" in a.call("GET", "/app", raw=True)[1])
d1(f"INSERT INTO backup_exports (id, workspace_id, requested_by, status) VALUES ('bk-busy', '{ws['b']}', '{ids['b@miconta.test']}', 'running')")
check("uno a la vez por espacio: 409", (409, "BACKUP_BUSY"), (lambda r: (r[0], r[1].get("code")))(b.call("POST", "/api/me/backups", {})))
d1("DELETE FROM backup_exports WHERE id='bk-busy'")

print("4) Reboot")
check("un miembro no dueño no puede: 403", 403, d.call("POST", "/api/me/reboot", {"confirm": "d@miconta.test"})[0])
check("correo equivocado: 400", 400, a.call("POST", "/api/me/reboot", {"confirm": "otro@miconta.test"})[0])
check("A antes tiene datos en todas las tablas", True, all(count(t, ws["a"]) >= 1 for t in TABLES))
check("A reinicia su espacio", 200, a.call("POST", "/api/me/reboot", {"confirm": "A@miconta.test"})[0])
check("no queda nada (también agenda, saldos y respaldos)", {t: 0 for t in TABLES}, {t: count(t, ws["a"]) for t in TABLES})
check("A conserva su cuenta, su espacio y su sesión", 200, a.call("GET", "/app", raw=True)[0])
check("los datos de B no se tocaron", True, all(count(t, ws["b"]) >= 1 for t in TABLES if t != "backup_exports"))

print("5) Borrar cuenta (stand-by)")
check("C es dueño con miembros: 409", (409, "HAS_MEMBERS"), (lambda r: (r[0], r[1].get("code")))(c.call("POST", "/api/me/delete", {"confirm": "c@miconta.test"})))
check("D borra su cuenta", 200, d.call("POST", "/api/me/delete", {"confirm": "d@miconta.test"})[0])
status, _, location = d.call("GET", "/app", raw=True)
check("D pierde la sesión", (302, "/login"), (status, location))
status, body = Client().call("POST", "/api/auth/sign-in/email", {"email": "d@miconta.test", "password": PW})
check("D no puede entrar: credenciales inválidas", (401, "INVALID_EMAIL_OR_PASSWORD"), (status, body.get("code")))
status, html, _ = admin.call("GET", "/admin", raw=True)
check("el admin la ve en Cuentas por eliminar", True, 'id="pending-deletion"' in html and "d@miconta.test" in html)
check("un usuario no puede restablecer: 403", 403, a.call("POST", f"/api/admin/users/{ids['d@miconta.test']}/deletion", {})[0])
check("el admin la restablece", 200, admin.call("POST", f"/api/admin/users/{ids['d@miconta.test']}/deletion", {})[0])
d1("DELETE FROM rate_limit")
check("D vuelve a entrar", 200, d.call("POST", "/api/auth/sign-in/email", {"email": "d@miconta.test", "password": PW})[0])
check("D la borra otra vez", 200, d.call("POST", "/api/me/delete", {"confirm": "d@miconta.test"})[0])
d1(f"INSERT INTO goals (id, workspace_id, type, name, currency, target_amount_minor, created_by) VALUES ('goal-d', '{ws['c']}', 'savings', 'Ahorro', 'MXN', 500000, '{ids['d@miconta.test']}')")
status, body = admin.call("DELETE", f"/api/admin/users/{ids['d@miconta.test']}/deletion", {})
check("el admin la elimina para siempre (dejó historial en C: queda anónima)", (200, "anonymized"), (status, body.get("result")))
check("D queda sin correo real, sin credenciales y fuera del espacio de C", (f"deleted-{ids['d@miconta.test']}@deleted.invalid", 0, 0), (scalar(f"SELECT email FROM user WHERE id='{ids['d@miconta.test']}'"), scalar(f"SELECT count(*) FROM account WHERE user_id='{ids['d@miconta.test']}'"), scalar(f"SELECT count(*) FROM workspace_members WHERE user_id='{ids['d@miconta.test']}'")))
check("la meta que registró en C se conserva", 1, scalar("SELECT count(*) FROM goals WHERE id='goal-d'"))
check("ya no aparece en Cuentas por eliminar", False, "d@miconta.test" in admin.call("GET", "/admin", raw=True)[1])

print("6) Purga automática a los 30 días")
check("B borra su cuenta", 200, b.call("POST", "/api/me/delete", {"confirm": "b@miconta.test"})[0])
d1(f"UPDATE user SET deleted_at = (unixepoch() - 31*86400) * 1000 WHERE id='{ids['b@miconta.test']}'")
status, _, _ = anon.call("GET", "/cdn-cgi/handler/scheduled", raw=True)
check("el cron corre", 200, status)
time.sleep(2)
check("B y su espacio desaparecen con todos sus datos", (0, 0, 0), (scalar(f"SELECT count(*) FROM user WHERE id='{ids['b@miconta.test']}'"), scalar(f"SELECT count(*) FROM workspaces WHERE id='{ws['b']}'"), count("movements", ws["b"])))
check("A y C siguen", 2, scalar("SELECT count(*) FROM user WHERE email IN ('a@miconta.test','c@miconta.test')"))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
