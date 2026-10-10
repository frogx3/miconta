#!/usr/bin/env python3
"""
Prueba de humo de las etiquetas de planes (API y pantallas): se crean al usarlas, no se duplican por mayúsculas,
son de cada espacio, tienen límite, desaparecen al quedar sin planes y respetan los roles.

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


def seed(ws, prefix, names):
    d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-{prefix}', '{ws}', 'Cuenta {prefix}', 'Banorte')")
    d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency, cutoff_day) VALUES ('card-{prefix}', '{ws}', 'acc-{prefix}', 'credit', '4172', 'MXN', 15)")
    for index, name in enumerate(names):
        d1(
            "INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date) "
            f"VALUES ('plan-{prefix}{index}', '{ws}', 'card-{prefix}', 'msi', '{name}', '{name}', 'MXN', 120000, 10000, 12, 2, '2026-08-0{index + 1}')"
        )


seed(ws_a, "a", ["PlanUno", "PlanDos"])
seed(ws_b, "b", ["PlanDeB"])
P1, P2, Q1 = "plan-a0", "plan-a1", "plan-b0"


def tag(client, plan, name):
    return client.call("POST", f"/api/plans/{plan}/tags", {"name": name})


print("1) Crear y reutilizar etiquetas")
status, body = tag(a, P1, "Casa")
check("A pone 'Casa' a PlanUno", 200, status)
casa = body["tag"]["id"]
check("la etiqueta se creó en el espacio de A", (1, "Casa"), (lambda r: (len(r), r[0]["name"]))(d1(f"SELECT name FROM tags WHERE workspace_id='{ws_a}'")))
status, body = tag(a, P1, "casa")
check("repetir con otra mayúscula no duplica (misma etiqueta y mismo vínculo)", (200, casa, 1, 1), (status, body["tag"]["id"], scalar(f"SELECT count(*) FROM tags WHERE workspace_id='{ws_a}'"), scalar(f"SELECT count(*) FROM plan_tags WHERE plan_id='{P1}'")))
status, body = tag(a, P2, "  Casa  ")
check("otro plan reutiliza la misma etiqueta (espacios sobrantes ignorados)", (200, casa, 1, 2), (status, body["tag"]["id"], scalar(f"SELECT count(*) FROM tags WHERE workspace_id='{ws_a}'"), scalar(f"SELECT count(*) FROM plan_tags WHERE tag_id='{casa}'")))
check("el acento sí distingue ('cása' es otra)", (200, 2), (lambda r: (r[0], scalar(f"SELECT count(*) FROM tags WHERE workspace_id='{ws_a}'")))(tag(a, P2, "cása")))
check("nombre vacío", 400, tag(a, P1, "   ")[0])
check("nombre demasiado largo", 400, tag(a, P1, "x" * 31)[0])
check("plan inexistente", 404, tag(a, "no-existe", "Casa")[0])

print("2) Aislamiento entre espacios y roles")
check("B no puede etiquetar el plan de A", 404, tag(b, P1, "Casa")[0])
status, body = tag(b, Q1, "Casa")
check("B crea su propia 'Casa', independiente de la de A", (200, True, 3), (status, body["tag"]["id"] != casa, scalar("SELECT count(*) FROM tags")))
check("C (solo lectura) no puede etiquetar", 403, tag(c, P1, "Viaje")[0])
check("C no puede quitar etiquetas", 403, c.call("DELETE", f"/api/plans/{P1}/tags", {"tagId": casa})[0])
check("B no puede quitar la etiqueta de A", 404, b.call("DELETE", f"/api/plans/{P1}/tags", {"tagId": casa})[0])
check("sin sesión", 401, Client().call("POST", f"/api/plans/{P1}/tags", {"name": "x"})[0])

print("3) Pantallas: la lista muestra y filtra, el detalle muestra")
status, html = a.call("GET", "/app/planes", raw=True)
check("la lista muestra la etiqueta y ambos planes", (200, True, True, True), (status, "Casa" in html, "PlanUno" in html, "PlanDos" in html))
status, html = a.call("GET", f"/app/planes?etiqueta={casa}", raw=True)
check("filtrar por 'Casa' deja ambos planes etiquetados", (True, True), ("PlanUno" in html, "PlanDos" in html))
status, _ = tag(a, P2, "Viaje")
viaje = scalar(f"SELECT id FROM tags WHERE workspace_id='{ws_a}' AND name='Viaje'")
status, html = a.call("GET", f"/app/planes?etiqueta={viaje}", raw=True)
check("filtrar por 'Viaje' deja solo PlanDos", (200, False, True), (status, "PlanUno" in html, "PlanDos" in html))
status, html = a.call("GET", "/app/planes?etiqueta=inventada", raw=True)
check("una etiqueta inventada se ignora (muestra todo)", (200, True), (status, "PlanUno" in html))
status, html = a.call("GET", f"/app/planes/{P1}", raw=True)
check("el detalle de PlanUno muestra 'Casa' y el formulario", (200, True, True), (status, "Casa" in html, 'id="tag-form"' in html))
status, html = c.call("GET", f"/app/planes/{P1}", raw=True)
check("para solo lectura se ve la etiqueta pero no el formulario", (200, True, False), (status, "Casa" in html, 'id="tag-form"' in html))
status, html = b.call("GET", "/app/planes", raw=True)
check("B no ve las etiquetas ni los planes de A", (200, False, False), (status, "Viaje" in html, "PlanUno" in html))

print("4) Límite por plan y limpieza al quedar sin uso")
for n in range(7):  # PlanUno ya tiene 'Casa' (1) → llega a 10 con 9 más
    tag(a, P1, f"extra{n}")
check("PlanUno llega a 9 etiquetas", 8, scalar(f"SELECT count(*) FROM plan_tags WHERE plan_id='{P1}'"))
tag(a, P1, "extra7")
status, body = tag(a, P1, "extra8")
check("la décima entra", 200, status)
check("la undécima se rechaza", 400, tag(a, P1, "extra9")[0])
check("pero repetir una que ya tiene sigue siendo válido", 200, tag(a, P1, "extra0")[0])

check("quitar 'Casa' de PlanUno (PlanDos la sigue usando): la etiqueta se queda", (200, 1), (a.call("DELETE", f"/api/plans/{P1}/tags", {"tagId": casa})[0], scalar(f"SELECT count(*) FROM tags WHERE id='{casa}'")))
check("quitar la misma otra vez", 404, a.call("DELETE", f"/api/plans/{P1}/tags", {"tagId": casa})[0])
check("quitar 'Casa' de PlanDos (ya nadie la usa): la etiqueta desaparece", (200, 0), (a.call("DELETE", f"/api/plans/{P2}/tags", {"tagId": casa})[0], scalar(f"SELECT count(*) FROM tags WHERE id='{casa}'")))
check("la 'Casa' de B no se tocó", 1, scalar(f"SELECT count(*) FROM tags WHERE workspace_id='{ws_b}' AND name='Casa'"))
check("sin tagId", 400, a.call("DELETE", f"/api/plans/{P1}/tags", {})[0])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
