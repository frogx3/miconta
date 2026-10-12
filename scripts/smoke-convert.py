#!/usr/bin/env python3
"""
Prueba de humo de "convertir un movimiento en plan" y de la vista de movimientos de una carga: validación,
permisos, aislamiento entre espacios, que el cargo quede vinculado al plan y que deshacer la carga se lleve el plan.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios y datos de prueba (@miconta.test); no limpia al terminar.
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



admin, a, b, anon = Client(), Client(), Client(), Client()

print("0) Preparación: A con una cuenta, una tarjeta y una carga de 3 movimientos; B ajeno")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
ids = {}
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test")):
    _, body = admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
    ids[email] = body["user"]["id"]
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
ws = scalar("SELECT id FROM workspaces WHERE name='Usuario A'")
uid = ids["a@miconta.test"]
_, body = a.call("POST", "/api/accounts", {"name": "Mi Banorte", "bank": "Banorte"})
account = body["id"]
_, body = a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "15"})
card = body["id"]
d1(f"INSERT INTO import_batches (id, workspace_id, account_id, file_name, created_by) VALUES ('b1', '{ws}', '{account}', 'octubre.csv', '{uid}')")
d1(f"INSERT INTO import_batches (id, workspace_id, account_id, file_name, created_by) VALUES ('b0', '{ws}', '{account}', 'septiembre.csv', '{uid}')")


def movement(mid, batch, key, desc, charge, credit=0, card_id=card):
    cid = f"'{card_id}'" if card_id else "NULL"
    d1(
        "INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, charge_minor, credit_minor, currency) "
        f"VALUES ('{mid}', '{ws}', '{account}', {cid}, '{batch}', '{key}', '2026-10-05', '{desc}', '{desc.upper()}', {charge}, {credit}, 'MXN')"
    )


movement("m1", "b1", "k1", "Liverpool", 90236)
movement("m2", "b1", "k2", "Oxxo", 5000)
movement("m3", "b1", "k3", "Pago recibido", 0, 100000)
movement("m4", "b0", "k4", "Antigua", 1000)
d1(f"UPDATE import_batches SET created_at = created_at - 100000 WHERE id='b0'")
payload = {"type": "msi", "name": "Liverpool", "matchText": "LIVERPOOL", "installmentAmount": "902.36", "currentInstallment": "3", "totalInstallments": "12", "totalAmount": "", "interestRate": ""}

print("1) Permisos y validación")
check("sin sesión: 401", 401, anon.call("POST", "/api/movements/m1/plan", payload)[0])
check("B no ve el movimiento de A: 404", 404, b.call("POST", "/api/movements/m1/plan", payload)[0])
check("origen ajeno: 403", 403, a.call("POST", "/api/movements/m1/plan", payload, origin="http://evil.test")[0])
status, body = a.call("POST", "/api/movements/m1/plan", {**payload, "currentInstallment": "13"})
check("pago actual mayor al total: 400", (400, "current_exceeds_total"), (status, body["errors"][0]["code"]))
check("nombre vacío: 400", 400, a.call("POST", "/api/movements/m1/plan", {**payload, "name": ""})[0])
check("un abono no se puede convertir: 409", 409, a.call("POST", "/api/movements/m3/plan", payload)[0])
check("nada se creó con los intentos fallidos", 0, scalar("SELECT count(*) FROM plans"))

print("2) Pantalla de la carga (antes)")
status, html, _ = a.call("GET", "/app/gastos/movimientos?lote=b1", raw=True)
check("con ?lote= se ven solo los movimientos de esa carga", (200, True, True, False), (status, "Liverpool" in html, "Oxxo" in html, "Antigua" in html))
check("la vista de la carga muestra el nombre del archivo", True, "octubre.csv" in html)
check("cada cargo sin plan ofrece 'Convertir en plan' (2 cargos; el abono no)", 2, html.count('class="link-button convert-plan"'))
check("un lote ajeno no filtra nada (B)", True, "Liverpool" not in b.call("GET", "/app/gastos/movimientos?lote=b1&mes=todo", raw=True)[1])

print("3) Convertir")
status, body = a.call("POST", "/api/movements/m1/plan", payload)
check("A convierte el cargo en plan", (201, True), (status, bool(body.get("planId"))))
plan_id = body.get("planId")
p = d1(f"SELECT card_id, status, paid_installments, total_installments, first_charge_date, installment_amount_minor, total_amount_minor, currency FROM plans WHERE id='{plan_id}'")[0]
check("plan en la tarjeta del cargo, pago 3 de 12, mensualidad 902.36", (card, "active", 3, 12, "2026-08-05", 90236, 90236 * 12, "MXN"), tuple(p.values()))
m = d1("SELECT plan_id, plan_installment_no, category_id FROM movements WHERE id='m1'")[0]
check("el movimiento quedó vinculado como mensualidad 3", (plan_id, 3), (m["plan_id"], m["plan_installment_no"]))
check("eventos 'created' e 'installment_recorded' ligados a la carga", ["created", "installment_recorded"], [r["type"] for r in d1(f"SELECT type FROM plan_events WHERE plan_id='{plan_id}' AND batch_id='b1' ORDER BY rowid")])
check("convertir otra vez el mismo cargo: 409", 409, a.call("POST", "/api/movements/m1/plan", payload)[0])
html = a.call("GET", "/app/gastos/movimientos?lote=b1", raw=True)[2:] and a.call("GET", "/app/gastos/movimientos?lote=b1", raw=True)[1]
check("ahora el cargo muestra la insignia de plan y ya no el botón (queda 1)", (True, 1), (f"/app/planes/{plan_id}" in html, html.count('class="link-button convert-plan"')))
status, html, _ = a.call("GET", f"/app/planes/{plan_id}", raw=True)
check("el detalle del plan carga", 200, status)
check("pago 12 de 12 cierra el plan", "completed_natural", (lambda r: scalar(f"SELECT status FROM plans WHERE id='{r.get('planId')}'"))(a.call("POST", "/api/movements/m2/plan", {**payload, "name": "Oxxo", "matchText": "OXXO", "installmentAmount": "50.00", "currentInstallment": "2", "totalInstallments": "2"})[1]))

print("4) Deshacer la carga se lleva los planes creados desde ella")
status, body = a.call("POST", "/api/import/batches/b1/revert", {})
check("la carga se deshace", (200, 2), (status, body.get("plansDeleted")))
check("sin planes ni movimientos de esa carga", (0, 0), (scalar("SELECT count(*) FROM plans"), scalar("SELECT count(*) FROM movements WHERE batch_id='b1'")))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
