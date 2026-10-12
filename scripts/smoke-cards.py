#!/usr/bin/env python3
"""
Prueba de humo de la tarjeta al importar un CSV que no la trae (estilo Banamex, sin referencia ni terminación):
el archivo se puede importar sin tarjeta, con una tarjeta nueva creada en el momento, con una tarjeta elegida para
todos los movimientos y con una distinta por movimiento; y los rechazos (tarjeta inválida, repetida o ajena).

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



def csv(tag):
    return "Fecha,Descripcion,Cargo,Abono\n" + "\n".join([
        f"05/10/2026,SUPER {tag},120.50,0",
        f"06/10/2026,GASOLINERA {tag},500.00,0",
        f"07/10/2026,PAGO RECIBIDO {tag},0,1000.00",
    ]) + "\n"


admin, a, b = Client(), Client(), Client()
print("0) Preparación: A con una cuenta Banamex SIN tarjetas; B con una cuenta y una tarjeta")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test")):
    admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
_, body = a.call("POST", "/api/accounts", {"name": "Mi Banamex", "bank": "Banamex"})
account = body["id"]
_, body = b.call("POST", "/api/accounts", {"name": "Cuenta B", "bank": "BBVA"})
_, body = b.call("POST", f"/api/accounts/{body['id']}/cards", {"kind": "debit", "isDigital": False, "last4": "9999", "currency": "MXN"})
b_card = body["id"]

print("1) Vista previa: avisa que faltan tarjetas, sin bloquear")
status, body = a.call("POST", "/api/import/preview", {"accountId": account, "text": csv("A")})
p = body["preview"]
check("preview ok, sin errores ni campos faltantes", (200, 0, []), (status, len(p["errors"]), p["missingFields"]))
check("3 movimientos sin tarjeta; la cuenta no tiene tarjetas y el archivo tampoco las trae", (3, [], []), (p["missingCard"], p["accountCards"], p["cards"]))
profile = p["profile"]
base = lambda tag, **extra: {"accountId": account, "text": csv(tag), "fileName": f"{tag}.csv", "profile": profile, "cutoffDate": "2026-10-15", **extra}
cards_of = lambda tag: [r["card_id"] for r in d1(f"SELECT card_id FROM movements WHERE description LIKE '% {tag}' ORDER BY date")]

print("2) Importar sin tarjeta sigue siendo posible")
status, body = a.call("POST", "/api/import/apply", base("A"))
check("importa los 3 movimientos sin tarjeta", (201, 3, [None, None, None]), (status, body["counts"]["movements"], cards_of("A")))
check("deshacer la carga", 200, a.call("POST", f"/api/import/batches/{body['batchId']}/revert", {})[0])

print("3) Crear la tarjeta en el momento y usarla para todos")
new_card = {"kind": "credit", "last4": "1234", "label": "Oro", "cutoffDay": "15", "paymentDueDay": "5"}
status, body = a.call("POST", "/api/import/apply", base("B1", cardAssignment={"defaultCard": "new", "newCard": new_card, "byMovement": {}}))
card_id = scalar(f"SELECT id FROM cards WHERE account_id='{account}' AND last4='1234'")
check("importa y crea la tarjeta (1 tarjeta nueva)", (201, 1), (status, body["counts"]["cardsCreated"]))
check("la tarjeta tiene el tipo, la etiqueta, el corte y la moneda de la cuenta", ("credit", "Oro", 15, 5, "MXN"), tuple(d1(f"SELECT kind, label, cutoff_day, payment_due_day, currency FROM cards WHERE id='{card_id}'")[0].values()))
check("los 3 movimientos quedaron en la tarjeta nueva", [card_id] * 3, cards_of("B1"))
a.call("POST", f"/api/import/batches/{body['batchId']}/revert", {})

print("4) Elegir una tarjeta existente para todos y cambiarla en un movimiento")
_, body = a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "5678", "currency": "MXN", "cutoffDay": "20"})
other = body["id"]
status, preview = a.call("POST", "/api/import/preview", {"accountId": account, "text": csv("C"), "profile": profile})
check("ahora la vista previa ofrece las 2 tarjetas de la cuenta", 2, len(preview["preview"]["accountCards"]))
first_key = [m for m in preview["preview"]["movements"] if "SUPER" in m["description"]][0]["key"]
status, body = a.call("POST", "/api/import/apply", base("C", cardAssignment={"defaultCard": card_id, "newCard": None, "byMovement": {first_key: other}}))
check("el primero va a la tarjeta elegida para él y los demás a la de todos", (201, [other, card_id, card_id]), (status, cards_of("C")))
a.call("POST", f"/api/import/batches/{body['batchId']}/revert", {})

print("5) Rechazos (no deben escribir nada)")
before = scalar("SELECT count(*) FROM movements")
rejected = lambda assignment: a.call("POST", "/api/import/apply", base("D", cardAssignment=assignment))
check("tarjeta inexistente para todos: 400 INVALID_CARD", (400, "INVALID_CARD"), (lambda r: (r[0], r[1].get("code")))(rejected({"defaultCard": "no-existe", "newCard": None, "byMovement": {}})))
check("tarjeta de otro espacio: 400", 400, rejected({"defaultCard": b_card, "newCard": None, "byMovement": {}})[0])
check("'new' sin describir la tarjeta nueva: 400", 400, rejected({"defaultCard": "new", "newCard": None, "byMovement": {}})[0])
check("terminación inválida: 400", 400, rejected({"defaultCard": "new", "newCard": {**new_card, "last4": "12"}, "byMovement": {}})[0])
check("crédito sin día de corte: 400", 400, rejected({"defaultCard": "new", "newCard": {**new_card, "last4": "4321", "cutoffDay": ""}, "byMovement": {}})[0])
check("terminación que la cuenta ya tiene: 400", (400, "duplicate"), (lambda r: (r[0], r[1]["details"][0]["code"]))(rejected({"defaultCard": "new", "newCard": new_card, "byMovement": {}})))
check("movimiento que no existe en el archivo: 400", 400, rejected({"defaultCard": None, "newCard": None, "byMovement": {"x#1": card_id}})[0])
check("nada se guardó", before, scalar("SELECT count(*) FROM movements"))

print("6) Un plan creado desde un movimiento sin tarjeta usa la tarjeta elegida")
status, preview = a.call("POST", "/api/import/preview", {"accountId": account, "text": csv("E"), "profile": profile})
gas = [m for m in preview["preview"]["movements"] if "GASOLINERA" in m["description"]][0]["key"]
draft = {"movementKey": gas, "type": "msi", "name": "Gasolina", "matchText": "GASOLINERA", "installmentAmount": "500.00", "currentInstallment": "1", "totalInstallments": "6", "totalAmount": "", "interestRate": ""}
status, body = a.call("POST", "/api/import/apply", base("E", planDrafts=[draft]))
check("con 2 tarjetas de crédito y sin elegir, el plan pide una tarjeta: 400 INVALID_PLAN", (400, "INVALID_PLAN"), (status, body.get("code")))
status, body = a.call("POST", "/api/import/apply", base("E", planDrafts=[draft], cardAssignment={"defaultCard": other, "newCard": None, "byMovement": {}}))
check("eligiendo la tarjeta, se crea el plan en ella", (201, other), (status, scalar("SELECT card_id FROM plans WHERE name='Gasolina'")))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
