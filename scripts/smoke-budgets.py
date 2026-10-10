#!/usr/bin/env python3
"""
Prueba de humo de los presupuestos por categoría (API y pantallas): se escriben en el formato del locale, se
quitan con vacío, no cambian si la petición no los trae, son de cada espacio y el Resumen los compara con el gasto.

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
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['c@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws_a}', '{ids['c@miconta.test']}', 'viewer')")

print("1) Crear y editar presupuestos")
status, body = a.call("POST", "/api/categories", {"name": "Super", "color": "#0f6b4f", "budget": "1,000.00"})
check("crear 'Super' con presupuesto 1,000.00", 201, status)
super_id = body["id"]
check("se guardó en centavos", 100000, scalar(f"SELECT budget_minor FROM categories WHERE id='{super_id}'"))
status, body = a.call("POST", "/api/categories", {"name": "Café", "color": "#d97706"})
cafe_id = body["id"]
check("una categoría sin presupuesto queda en nulo", (201, None), (status, scalar(f"SELECT budget_minor FROM categories WHERE id='{cafe_id}'")))
check("editar el presupuesto a 500", (200, 50000), (a.call("PATCH", f"/api/categories/{super_id}", {"name": "Super", "color": "#0f6b4f", "budget": "500"})[0], scalar(f"SELECT budget_minor FROM categories WHERE id='{super_id}'")))
check("editar el nombre sin mandar presupuesto no lo toca", (200, 50000, "Super 2"), (a.call("PATCH", f"/api/categories/{super_id}", {"name": "Super 2", "color": "#0f6b4f"})[0], scalar(f"SELECT budget_minor FROM categories WHERE id='{super_id}'"), scalar(f"SELECT name FROM categories WHERE id='{super_id}'")))
a.call("PATCH", f"/api/categories/{super_id}", {"name": "Super", "color": "#0f6b4f"})
for bad in ("abc", "0", "-5", "1.2.3"):
    status, body = a.call("PATCH", f"/api/categories/{super_id}", {"name": "Super", "budget": bad})
    check(f"presupuesto inválido '{bad}' se rechaza", (400, "invalid_amount"), (status, body["errors"][0]["code"]))
check("…y el presupuesto no cambió", 50000, scalar(f"SELECT budget_minor FROM categories WHERE id='{super_id}'"))
check("un presupuesto vacío lo quita", (200, None), (a.call("PATCH", f"/api/categories/{cafe_id}", {"name": "Café", "budget": ""})[0], scalar(f"SELECT budget_minor FROM categories WHERE id='{cafe_id}'")))
check("crear con un monto inválido se rechaza", 400, a.call("POST", "/api/categories", {"name": "X", "budget": "xx"})[0])

print("2) Roles y aislamiento")
check("C (solo lectura) no puede cambiar presupuestos", 403, c.call("PATCH", f"/api/categories/{super_id}", {"name": "Super", "budget": "1"})[0])
check("B no puede tocar la categoría de A", 404, b.call("PATCH", f"/api/categories/{super_id}", {"name": "Super", "budget": "1"})[0])
check("…y el presupuesto de A sigue igual", 50000, scalar(f"SELECT budget_minor FROM categories WHERE id='{super_id}'"))
check("B puede tener su propia 'Super' con otro presupuesto", (201, 2), (b.call("POST", "/api/categories", {"name": "Super", "budget": "99"})[0], scalar("SELECT count(*) FROM categories WHERE name='Super'")))

print("3) El Resumen compara el gasto del mes con el presupuesto")
d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-a', '{ws_a}', 'Cuenta A', 'Banorte')")
d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency, cutoff_day) VALUES ('card-a', '{ws_a}', 'acc-a', 'credit', '4172', 'MXN', 15)")
d1(f"INSERT INTO import_batches (id, workspace_id, account_id, file_name, status, created_by) VALUES ('batch-a', '{ws_a}', 'acc-a', 'x.csv', 'applied', '{ids['a@miconta.test']}')")
n = 0


def movement(category, amount, day, description="COMPRA", plan=False):
    global n
    n += 1
    cat = f"'{category}'" if category else "NULL"
    d1(
        "INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, charge_minor, currency, category_id) "
        f"VALUES ('mov-{n}', '{ws_a}', 'acc-a', 'card-a', 'batch-a', 'k{n}', '2026-09-{day:02d}', '{description}', '{description}', {amount}, 'MXN', {cat})"
    )


movement(super_id, 45000, 3)   # 450.00 de 500.00 → 90 %, aviso
movement(cafe_id, 20000, 4)    # sin presupuesto
a.call("PATCH", f"/api/categories/{cafe_id}", {"name": "Café", "budget": "100"})  # ahora 200.00 de 100.00 → excedido
html = a.call("GET", "/app/gastos?mes=2026-09", raw=True)[1]
check("Super: 90 % de $500.00 con el aviso", (True, True), ("90%" in html, "$500.00" in html))
check("Café: 200 % de $100.00", (True, True), ("200%" in html, "$100.00" in html))
check("resumen: $650.00 gastado de $600.00 y se pasó $50.00", (True, True), ("$650.00 / $600.00" in html, "$50.00" in html and "pasaste" in html))
html_b = b.call("GET", "/app/gastos?mes=2026-09", raw=True)[1]
check("B no ve ni el presupuesto ni el gasto de A", (False, False), ("$600.00" in html_b, "$650.00" in html_b))
a.call("PATCH", f"/api/categories/{cafe_id}", {"name": "Café", "budget": ""})
html = a.call("GET", "/app/gastos?mes=2026-09", raw=True)[1]
check("sin presupuesto en Café solo cuenta Super ($450.00 / $500.00, quedan $50.00)", (True, True, False), ("$450.00 / $500.00" in html, "Te quedan" in html, "200%" in html))
html = a.call("GET", "/app/gastos?mes=2026-08", raw=True)[1]
check("un mes sin gastos no rompe la pantalla", 200, a.call("GET", "/app/gastos?mes=2026-08", raw=True)[0])

print("4) La pantalla de categorías muestra el presupuesto guardado")
status, html = a.call("GET", "/app/gastos/categorias", raw=True)
check("el campo trae 500.00 para Super", (200, True), (status, "500.00" in html))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
