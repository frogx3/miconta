#!/usr/bin/env python3
"""
Prueba de humo del alta manual de movimientos (POST /api/movements y el formulario de la pantalla): cargo y abono,
categoría existente o creada en el momento, aislamiento entre espacios, roles y que el lote manual no cuente como carga de CSV.

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
for ws, p in ((ws_a, "a"), (ws_b, "b")):
    d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-{p}', '{ws}', 'Cuenta {p}', 'Banorte')")
    d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency, cutoff_day) VALUES ('card-{p}', '{ws}', 'acc-{p}', 'credit', '4172', 'MXN', 15)")
d1(f"INSERT INTO categories (id, workspace_id, name) VALUES ('cat-a', '{ws_a}', 'Comida')")
d1(f"INSERT INTO categories (id, workspace_id, name) VALUES ('cat-b', '{ws_b}', 'Ajena')")


def add(client, **over):
    body = {"cardId": "card-a", "kind": "charge", "date": "2026-10-05", "description": "Tacos  del   centro", "amount": "1,250.50", "categoryId": "", "newCategory": ""}
    body.update(over)
    return client.call("POST", "/api/movements", body)


print("1) Cargo con categoría existente")
status, body = add(a, categoryId="cat-a")
check("A captura un cargo", 201, status)
row = d1(f"SELECT * FROM movements WHERE id='{body.get('id')}'")[0]
check("monto en centavos, sin abono, tarjeta/cuenta/moneda de la tarjeta", (125050, 0, "card-a", "acc-a", "MXN"), (row["charge_minor"], row["credit_minor"], row["card_id"], row["account_id"], row["currency"]))
check("concepto con espacios colapsados y normalizado", ("Tacos del centro", "TACOS DEL CENTRO", "cat-a"), (row["description"], row["description_norm"], row["category_id"]))

print("2) Categoría creada en el mismo formulario")
status, body = add(a, description="Cine", newCategory="Ocio")
check("crea el movimiento y la categoría", (201, 1), (status, scalar(f"SELECT count(*) FROM categories WHERE workspace_id='{ws_a}' AND name='Ocio'")))
check("el movimiento quedó en la categoría nueva", "Ocio", scalar(f"SELECT c.name FROM movements m JOIN categories c ON c.id=m.category_id WHERE m.id='{body.get('id')}'"))
status, body = add(a, description="Teatro", newCategory="ocio")
check("repetir el nombre reutiliza la categoría, no duplica", (201, 2), (status, scalar(f"SELECT count(*) FROM categories WHERE workspace_id='{ws_a}'")))

print("3) Abono")
status, body = add(a, kind="credit", description="Pago recibido", amount="300", categoryId="cat-a")
row = d1(f"SELECT * FROM movements WHERE id='{body.get('id')}'")[0]
check("abono: crédito y sin cargo; la categoría se ignora", (201, 0, 30000, None), (status, row["charge_minor"], row["credit_minor"], row["category_id"]))

print("4) Lote manual: uno por cuenta y fuera del historial de cargas")
check("un solo lote manual para la cuenta", 1, scalar("SELECT count(*) FROM import_batches WHERE account_id='acc-a' AND source='manual'"))
status, html = a.call("GET", "/app/importar/historial", raw=True)
check("el historial de cargas no lo lista", (200, False), (status, "Manual" in html))

print("5) Validaciones, aislamiento y roles")
check("sin concepto", 400, add(a, description="  ")[0])
check("monto cero", 400, add(a, amount="0")[0])
check("monto inválido", 400, add(a, amount="abc")[0])
check("fecha inválida", 400, add(a, date="2026-02-31")[0])
check("tipo inválido", 400, add(a, kind="otro")[0])
check("sin tarjeta", 400, add(a, cardId="")[0])
check("tarjeta de otro espacio", 400, add(a, cardId="card-b")[0])
check("categoría de otro espacio", 400, add(a, categoryId="cat-b")[0])
check("C (solo lectura) no puede", 403, add(c)[0])
check("sin sesión", 401, add(Client())[0])
check("nada raro se guardó", 4, scalar(f"SELECT count(*) FROM movements WHERE workspace_id='{ws_a}'"))

print("6) Pantalla")
status, html = a.call("GET", "/app/gastos/movimientos?mes=todo", raw=True)
check("A ve el formulario y sus movimientos", (200, True, True, True), (status, 'id="movement-form"' in html, "Tacos del centro" in html, "Cine" in html))
status, html = c.call("GET", "/app/gastos/movimientos?mes=todo", raw=True)
check("C (solo lectura) ve los movimientos pero no el formulario", (200, True, False), (status, "Tacos del centro" in html, 'id="movement-form"' in html))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
