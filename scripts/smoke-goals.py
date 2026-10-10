#!/usr/bin/env python3
"""
Prueba de humo de las metas (API y pantallas): validación por tipo, avance de cada tipo, aportes de ahorro,
archivar y eliminar, roles y aislamiento entre espacios, y el resumen de Inicio.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios y datos de prueba (@miconta.test).
"""
import http.cookiejar
import json
import os
import re
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

    def call(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json", "Origin": BASE}, method=method)
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


print("0) Preparación: A (dueño), B (otro espacio) y C (solo lectura en el espacio de A)")
admin, a, b, c = Client(), Client(), Client(), Client()
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
ids = {}
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test"), ("Usuario C", "c@miconta.test")):
    _, body = admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
    ids[email] = body["user"]["id"]
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test"), (c, "c@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
ws_a = scalar("SELECT id FROM workspaces WHERE name='Usuario A'")
ws_b = scalar("SELECT id FROM workspaces WHERE name='Usuario B'")
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['c@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws_a}', '{ids['c@miconta.test']}', 'viewer')")


def seed(ws, prefix):
    d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-{prefix}', '{ws}', 'Cuenta {prefix}', 'Banorte')")
    d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency, cutoff_day) VALUES ('card-{prefix}', '{ws}', 'acc-{prefix}', 'credit', '4172', 'MXN', 15)")
    d1(f"INSERT INTO import_batches (id, workspace_id, account_id, file_name, status, created_by) VALUES ('batch-{prefix}', '{ws}', 'acc-{prefix}', 'x.csv', 'applied', '{ids['a@miconta.test']}')")
    # 6 pagos de 100.00, primero 2026-08-10, 2 pagados → faltan 4 (oct, nov, dic, ene) y terminan el 2027-01-10
    d1(
        "INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date) "
        f"VALUES ('plan-{prefix}', '{ws}', 'card-{prefix}', 'msi', 'Refri{prefix}', 'Refri', 'MXN', 60000, 10000, 6, 2, '2026-08-10')"
    )


seed(ws_a, "a")
seed(ws_b, "b")
HOY = time.strftime("%Y-%m-%d")


def goal(client, body):
    return client.call("POST", "/api/goals", body)


print("1) Validación por tipo")
check("sin tipo", 400, goal(a, {"name": "x"})[0])
check("tipo inexistente", 400, goal(a, {"type": "magia", "name": "x"})[0])
check("libre de pagos sin fecha", 400, goal(a, {"type": "debt_free", "name": "x"})[0])
status, body = goal(a, {"type": "debt_free", "name": "x", "targetDate": "2020-01-01"})
check("fecha en el pasado", (400, "date_past"), (status, body["errors"][0]["code"]))
check("fecha imposible", 400, goal(a, {"type": "debt_free", "name": "x", "targetDate": "2027-02-31"})[0])
check("nombre vacío", 400, goal(a, {"type": "debt_free", "name": "  ", "targetDate": "2027-02-01"})[0])
check("nombre demasiado largo", 400, goal(a, {"type": "debt_free", "name": "x" * 61, "targetDate": "2027-02-01"})[0])
check("hormiga sin tope", 400, goal(a, {"type": "ant_spend", "name": "x"})[0])
check("ahorro con monto inválido", 400, goal(a, {"type": "savings", "name": "x", "targetAmount": "abc"})[0])
check("ahorro con monto cero", 400, goal(a, {"type": "savings", "name": "x", "targetAmount": "0"})[0])
check("liquidar un plan sin elegirlo", 400, goal(a, {"type": "payoff_plan", "name": "x", "targetDate": "2027-02-01"})[0])
status, body = goal(a, {"type": "payoff_plan", "name": "x", "targetDate": "2027-02-01", "planId": "plan-b"})
check("liquidar el plan de otro espacio se rechaza", (400, "invalid_plan"), (status, body["errors"][0]["code"]))
check("sin sesión", 401, Client().call("POST", "/api/goals", {"type": "debt_free"})[0])
check("C (solo lectura) no puede crear metas", 403, goal(c, {"type": "debt_free", "name": "x", "targetDate": "2027-02-01"})[0])

print("2) Libre de pagos y liquidar un plan")
status, body = goal(a, {"type": "debt_free", "name": "Libre en febrero", "targetDate": "2027-02-01"})
check("meta libre de pagos a tiempo", 201, status)
debt_ok = body["id"]
status, body = goal(a, {"type": "debt_free", "name": "Libre en diciembre", "targetDate": "2026-12-10"})
check("meta libre de pagos exigente", 201, status)
status, body = goal(a, {"type": "payoff_plan", "name": "Pagar el refri", "targetDate": "2027-02-01", "planId": "plan-a"})
check("liquidar el refri antes de febrero", 201, status)
payoff = body["id"]
status, html = a.call("GET", "/app/metas", raw=True)
check("la pantalla carga con las tres metas", (200, True, True, True), (status, "Libre en febrero" in html, "Libre en diciembre" in html, "Pagar el refri" in html))
check("la de febrero está en camino y la de diciembre atrasada", (True, True), ("En camino" in html, "Atrasada" in html))
check("faltan $400.00 (4 mensualidades de $100.00)", True, "$400.00" in html)
check("abono extra sugerido de $33.34 al mes para diciembre", True, "$33.34" in html)
check("la fecha de fin natural (10 ene 2027) aparece", True, "2027" in html)
d1("UPDATE plans SET status='settled_manual' WHERE id='plan-a'")
html = a.call("GET", "/app/metas", raw=True)[1]
check("al liquidarse el plan la meta pasa a lograda", True, "Lograda" in html)
d1("UPDATE plans SET status='active' WHERE id='plan-a'")

print("3) Gasto hormiga")
status, body = goal(a, {"type": "ant_spend", "name": "Hormiga bajo 150", "targetAmount": "150.00"})
check("meta de gasto hormiga con tope 150.00", 201, status)
ant = body["id"]
n = 0


def movement(day_iso, amount):
    global n
    n += 1
    d1(
        "INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, charge_minor, currency) "
        f"VALUES ('mov-{n}', '{ws_a}', 'acc-a', 'card-a', 'batch-a', 'k{n}', '{day_iso}', 'OXXO', 'OXXO', {amount}, 'MXN')"
    )


month = HOY[:7]
prev1 = time.strftime("%Y-%m", time.gmtime(time.time() - 35 * 86400))
prev2 = time.strftime("%Y-%m", time.gmtime(time.time() - 66 * 86400))
movement(f"{month}-01", 13000)   # 130.00 este mes: cerca del tope (87 %)
movement(f"{prev1}-05", 10000)   # mes cerrado bajo el tope
movement(f"{prev2}-05", 20000)   # mes cerrado sobre el tope
html = a.call("GET", "/app/metas", raw=True)[1]
check("este mes lleva $130.00 de $150.00 y queda cerca del tope", (True, True), ("$130.00" in html, "Cerca del tope" in html))
check("le quedan $20.00", True, "$20.00" in html)
check("1 de 2 meses cerrados estuvo bajo el tope", True, "1 de 2 meses" in html)
movement(f"{month}-02", 5000)    # 180.00 → excedido
html = a.call("GET", "/app/metas", raw=True)[1]
check("al pasarse del tope marca 'Te pasaste' por $30.00", (True, True), ("Te pasaste" in html, "$30.00" in html))

print("4) Ahorro con aportes")
status, body = goal(a, {"type": "savings", "name": "Fondo", "targetAmount": "1,000.00", "targetDate": "2027-06-01"})
check("meta de ahorro con fecha", 201, status)
sav = body["id"]
check("sin aportes: 0 de $1,000.00", True, "$1,000.00" in a.call("GET", "/app/metas", raw=True)[1])
check("aporte de 400.00", 201, a.call("POST", f"/api/goals/{sav}/entries", {"amount": "400.00", "note": "quincena"})[0])
check("retiro de -100", 201, a.call("POST", f"/api/goals/{sav}/entries", {"amount": "-100"})[0])
check("el ahorro suma $300.00", 30000, scalar(f"SELECT sum(amount_minor) FROM goal_entries WHERE goal_id='{sav}'"))
html = a.call("GET", "/app/metas", raw=True)[1]
check("la pantalla muestra $300.00 de $1,000.00 (30%) y la nota", (True, True, True), ("$300.00" in html, "30%" in html, "quincena" in html))
check("monto cero", 400, a.call("POST", f"/api/goals/{sav}/entries", {"amount": "0"})[0])
check("monto inválido", 400, a.call("POST", f"/api/goals/{sav}/entries", {"amount": "abc"})[0])
check("aporte con fecha futura", 400, a.call("POST", f"/api/goals/{sav}/entries", {"amount": "10", "date": "2099-01-01"})[0])
check("aportes en una meta que no es de ahorro", 409, a.call("POST", f"/api/goals/{ant}/entries", {"amount": "10"})[0])
check("C (solo lectura) no puede aportar", 403, c.call("POST", f"/api/goals/{sav}/entries", {"amount": "10"})[0])
check("B no puede aportar a la meta de A", 404, b.call("POST", f"/api/goals/{sav}/entries", {"amount": "10"})[0])
entry_id = scalar(f"SELECT id FROM goal_entries WHERE goal_id='{sav}' AND amount_minor=-10000")
check("quitar el retiro", (200, 40000), (a.call("DELETE", f"/api/goals/{sav}/entries", {"entryId": entry_id})[0], scalar(f"SELECT sum(amount_minor) FROM goal_entries WHERE goal_id='{sav}'")))
check("quitar un aporte inexistente", 404, a.call("DELETE", f"/api/goals/{sav}/entries", {"entryId": "no-existe"})[0])
a.call("POST", f"/api/goals/{sav}/entries", {"amount": "600"})
check("al llegar al monto la meta queda lograda", True, "Alcanzaste la meta" in a.call("GET", "/app/metas", raw=True)[1])

print("5) Editar, archivar y eliminar; aislamiento")
check("editar nombre y tope de la meta hormiga", (200, "Hormiga bajo 200", 20000), (a.call("PATCH", f"/api/goals/{ant}", {"name": "Hormiga bajo 200", "targetAmount": "200"})[0], scalar(f"SELECT name FROM goals WHERE id='{ant}'"), scalar(f"SELECT target_amount_minor FROM goals WHERE id='{ant}'")))
check("editar con un monto inválido se rechaza", 400, a.call("PATCH", f"/api/goals/{ant}", {"name": "x", "targetAmount": "abc"})[0])
check("C no puede editar", 403, c.call("PATCH", f"/api/goals/{ant}", {"name": "x", "targetAmount": "1"})[0])
check("B no puede editar la meta de A", 404, b.call("PATCH", f"/api/goals/{ant}", {"name": "x", "targetAmount": "1"})[0])
check("B no puede eliminarla", 404, b.call("DELETE", f"/api/goals/{ant}", {})[0])
html_b = b.call("GET", "/app/metas", raw=True)[1]
check("B no ve las metas de A", (False, False), ("Fondo" in html_b, "Libre en febrero" in html_b))
check("archivar la meta de febrero", 200, a.call("PATCH", f"/api/goals/{debt_ok}", {"archived": True})[0])
check("archivada deja de verse por defecto", False, "Libre en febrero" in a.call("GET", "/app/metas", raw=True)[1])
check("…y aparece con 'Ver archivadas'", True, "Libre en febrero" in a.call("GET", "/app/metas?archivadas=1", raw=True)[1])
check("restaurarla", (200, True), (a.call("PATCH", f"/api/goals/{debt_ok}", {"archived": False})[0], "Libre en febrero" in a.call("GET", "/app/metas", raw=True)[1]))

print("6) Resumen en Inicio")
status, html = a.call("GET", "/app", raw=True)
check("Inicio muestra las metas", (200, True), (status, "Fondo" in html or "Libre en febrero" in html))
check("Inicio de B no las muestra", False, "Fondo" in b.call("GET", "/app", raw=True)[1])

print("7) Eliminar borra la meta y sus aportes, no los planes")
check("eliminar la meta de ahorro", (200, 0, 0), (a.call("DELETE", f"/api/goals/{sav}", {})[0], scalar(f"SELECT count(*) FROM goals WHERE id='{sav}'"), scalar(f"SELECT count(*) FROM goal_entries WHERE goal_id='{sav}'")))
check("eliminar otra vez", 404, a.call("DELETE", f"/api/goals/{sav}", {})[0])
check("el plan sigue intacto", 1, scalar("SELECT count(*) FROM plans WHERE id='plan-a'"))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
