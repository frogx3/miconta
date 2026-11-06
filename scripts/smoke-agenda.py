#!/usr/bin/env python3
"""
Prueba de humo de la agenda de pagos (API, pantalla y webhook de Kapso) y, opcionalmente, del cron de recordatorios.

Requiere:
  1. En .dev.vars (no se commitea) WhatsApp encendido con valores de prueba:
       WHATSAPP_NOTIFICATIONS=true, KAPSO_API_KEY=test-key, KAPSO_PHONE_NUMBER_ID=000,
       KAPSO_WEBHOOK_SECRET=<aleatorio>, KAPSO_REMINDER_TEMPLATE=recordatorio_pago, KAPSO_BUSINESS_PHONE=5210000000000
     y `pnpm exec astro dev --background` (reiniciarlo tras editar .dev.vars).
  2. SMOKE_KAPSO_SECRET=<el mismo KAPSO_WEBHOOK_SECRET> en el entorno.
  3. Opcional, para el cron: `pnpm build && pnpm exec wrangler dev --local --persist-to .wrangler/state --port 8788` (misma D1 que astro dev) y
     SMOKE_CRON_URL=http://localhost:8788. Sin esa variable la sección del cron se salta.
No necesita una D1 vacía: crea espacios y usuarios nuevos (@miconta.test, correos aleatorios) con invitaciones
insertadas en la base, así que funciona con el registro público cerrado. Las respuestas salientes a Kapso fallan
(llave falsa); solo se verifica el estado en D1.
"""
import base64
import calendar
import datetime
import hashlib
import hmac
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
import zoneinfo

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "http://localhost:4321"
PW = "Aa1-" + secrets.token_hex(10)
RUN = secrets.token_hex(4)
SECRET = os.environ.get("SMOKE_KAPSO_SECRET", "")
CRON_URL = os.environ.get("SMOKE_CRON_URL", "")
FAILED = False
if not SECRET:
    sys.exit("Falta SMOKE_KAPSO_SECRET (debe coincidir con KAPSO_WEBHOOK_SECRET de .dev.vars)")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def call(self, method, path, body=None, raw=False, headers=None, data=None):
        if data is None and body is not None:
            data = json.dumps(body).encode()
        request = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json", "Origin": BASE, **(headers or {})}, method=method)
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


def text_of(html):
    """Texto visible aproximado: sin etiquetas (y sus atributos data-astro-source-*) ni espacios repetidos."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


print("0) Preparación: A (dueño), B (dueño de otro espacio) y V (solo lectura en el espacio de A)")
if scalar("SELECT count(*) FROM user") == 0:  # D1 vacía: el primer registro es el admin y abre la base
    Client().call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": f"admin-{RUN}@miconta.test", "password": PW})
creator = scalar("SELECT id FROM user LIMIT 1")


def new_user(label, workspace, role):
    """Registro con una invitación insertada en la base (el registro público puede estar cerrado)."""
    token = secrets.token_urlsafe(24)
    expires = int((datetime.datetime.now().timestamp() + 3600) * 1000)
    d1(f"INSERT INTO workspace_invitations (id, workspace_id, token_hash, role, created_by, expires_at) VALUES ('inv-{RUN}-{label}', '{workspace}', '{hashlib.sha256(token.encode()).hexdigest()}', '{role}', '{creator}', {expires})")
    client = Client()
    email = f"agenda-{label}-{RUN}@miconta.test"
    status, body = client.call("POST", "/api/auth/sign-up/email", {"name": f"Agenda {label}", "email": email, "password": PW}, headers={"x-invite-token": token})
    check(f"registro de {email}", 200, status)
    return client, body.get("user", {}).get("id")


ws_a, ws_b = f"ws-a-{RUN}", f"ws-b-{RUN}"
for ws in (ws_a, ws_b):
    d1(f"INSERT INTO workspaces (id, name, locale, default_currency) VALUES ('{ws}', 'Agenda {ws}', 'es-MX', 'MXN')")
a, id_a = new_user("a", ws_a, "admin")
b, id_b = new_user("b", ws_b, "admin")
v, id_v = new_user("v", ws_a, "viewer")
d1(f"UPDATE workspace_members SET role='owner' WHERE user_id IN ('{id_a}', '{id_b}')")

today = datetime.date.today()
month = today.strftime("%Y-%m")
prev = (today.replace(day=1) - datetime.timedelta(days=1))
prev_31 = prev.replace(day=31) if prev.day == 31 else None
# Pago mensual con ancla en el 31: el del mes pasado si tuvo 31 días; si no, el de hace dos meses (siempre lo tiene).
anchor = prev_31 or (prev.replace(day=1) - datetime.timedelta(days=1))
month_end = datetime.date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
next_after_anchor = datetime.date(anchor.year + anchor.month // 12, anchor.month % 12 + 1, 1)
next_after_anchor = next_after_anchor.replace(day=calendar.monthrange(next_after_anchor.year, next_after_anchor.month)[1])

print("1) Saldos, pagos y cobros del dueño")
d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-deb-{RUN}', '{ws_a}', 'Nómina', 'Banorte')")
d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency) VALUES ('card-deb-{RUN}', '{ws_a}', 'acc-deb-{RUN}', 'debit', '1111', 'MXN')")
status, body = a.call("PUT", "/api/agenda/balances", {"cardId": f"card-deb-{RUN}", "amount": "10,000.00"})
check("saldo de la tarjeta de débito", 200, status)
check("quitar la débito con saldo: 409 CARD_IN_USE (no 500)", 409, a.call("DELETE", f"/api/accounts/acc-deb-{RUN}/cards/card-deb-{RUN}", {})[0])
status, body = a.call("PUT", "/api/agenda/balances", {"label": "Efectivo", "amount": "2000"})
check("renglón libre de saldo", 200, status)
free_balance = body.get("id")
status, body = a.call("POST", "/api/agenda/items", {"kind": "payable", "description": "Renta", "amount": "5,000.00", "dueDate": anchor.isoformat(), "recurrence": "monthly"})
check(f"pago mensual el {anchor.isoformat()}", 201, status)
rent = body.get("id")
status, body = a.call("POST", "/api/agenda/items", {"kind": "receivable", "description": "Cobro cliente", "amount": "3000", "dueDate": month_end.isoformat()})
check("cobro a fin de mes", 201, status)
receivable = body.get("id")
check("validación: monto inválido", 400, a.call("POST", "/api/agenda/items", {"kind": "payable", "description": "x", "amount": "abc", "dueDate": month_end.isoformat()})[0])
check("validación: fecha imposible", 400, a.call("POST", "/api/agenda/items", {"kind": "payable", "description": "x", "amount": "1", "dueDate": "2026-02-31"})[0])

# Renta vencida + sus ocurrencias proyectadas hasta fin de mes.
rent_count = 1
d = next_after_anchor
while d <= month_end:
    rent_count += 1
    nxt = datetime.date(d.year + d.month // 12, d.month % 12 + 1, 1)
    d = nxt.replace(day=calendar.monthrange(nxt.year, nxt.month)[1])
expected = 12000 + 3000 - 5000 * rent_count
status, html = a.call("GET", "/app/agenda", raw=True)
page = text_of(html)
check("la página carga", 200, status)
check("muestra Renta y Cobro cliente", (True, True), ("Renta" in page, "Cobro cliente" in page))
check(f"disponible $12,000.00 + por cobrar $3,000.00 − por pagar ${5000 * rent_count:,}.00", True, bool(re.search(rf"disponible \$12,000\.00 \+ por cobrar \$3,000\.00 − por pagar \${5000 * rent_count:,}\.00", page)))
answer = f"te sobran ${expected:,}.00" if expected > 0 else f"te faltan ${-expected:,}.00"
check(f"resultado: {answer}", True, answer in page)

print("2) Ya lo pagué, deshacer y la siguiente ocurrencia")
status, body = a.call("POST", f"/api/agenda/items/{rent}/done", {})
check("marcar Renta como pagada", (200, "done"), (status, body.get("result")))
status, body = a.call("POST", f"/api/agenda/items/{rent}/done", {})
check("marcarla otra vez responde already", (200, "already"), (status, body.get("result")))
children = d1(f"SELECT due_date, status FROM agenda_items WHERE previous_id='{rent}'")
check(f"exactamente un siguiente, el {next_after_anchor.isoformat()} (fin de mes)", [{"due_date": next_after_anchor.isoformat(), "status": "pending"}], children)
check("quedó hecha por web y por A", ("done", "web", id_a), tuple(d1(f"SELECT status, done_via, done_by_user_id FROM agenda_items WHERE id='{rent}'")[0].values()))
status, body = a.call("POST", f"/api/agenda/items/{rent}/undo", {})
check("deshacer", (200, "reopened"), (status, body.get("result")))
check("el siguiente desaparece y la renta vuelve a pendiente", (0, "pending"), (scalar(f"SELECT count(*) FROM agenda_items WHERE previous_id='{rent}'"), scalar(f"SELECT status FROM agenda_items WHERE id='{rent}'")))
check("deshacer otra vez", 409, a.call("POST", f"/api/agenda/items/{rent}/undo", {})[0])
a.call("POST", f"/api/agenda/items/{rent}/done", {})
child = scalar(f"SELECT id FROM agenda_items WHERE previous_id='{rent}'")
check("re-marcar crea de nuevo un solo siguiente", 1, scalar(f"SELECT count(*) FROM agenda_items WHERE previous_id='{rent}'"))
check("editar el siguiente", 200, a.call("PATCH", f"/api/agenda/items/{child}", {"kind": "payable", "description": "Renta depto", "amount": "5,500", "dueDate": next_after_anchor.isoformat(), "recurrence": "monthly"})[0])
check("…guarda descripción y monto", ("Renta depto", 550000), tuple(d1(f"SELECT description, amount_minor FROM agenda_items WHERE id='{child}'")[0].values()))

print("3) Pago de tarjeta sugerido")
d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-tdc-{RUN}', '{ws_a}', 'TDC Oro', 'Banorte')")
d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency, cutoff_day, payment_due_day) VALUES ('card-tdc-{RUN}', '{ws_a}', 'acc-tdc-{RUN}', 'credit', '4172', 'MXN', 10, 30)")
d1(f"INSERT INTO import_batches (id, workspace_id, account_id, file_name, status, created_by) VALUES ('batch-{RUN}', '{ws_a}', 'acc-tdc-{RUN}', 'x.csv', 'applied', '{id_a}')")
for n, days_ago in enumerate((70, 40, 15, 3)):
    day = (today - datetime.timedelta(days=days_ago)).isoformat()
    d1("INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, charge_minor, currency) "
       f"VALUES ('mov-{RUN}-{n}', '{ws_a}', 'acc-tdc-{RUN}', 'card-tdc-{RUN}', 'batch-{RUN}', 'k-{RUN}-{n}', '{day}', 'SUPER', 'SUPER', 123400, 'MXN')")
html = a.call("GET", "/app/agenda", raw=True)[1]
bodies = [json.loads(m.replace("&quot;", '"')) for m in re.findall(r'data-body="([^"]*card-tdc[^"]*)"', html)]
done_body = next((x for x in bodies if x.get("action") == "done"), None)
check("la página sugiere el pago de la tarjeta", True, done_body is not None)
if done_body:
    due = done_body["dueDate"]
    s1, r1 = a.call("POST", "/api/agenda/card-payments", done_body)
    s2, r2 = a.call("POST", "/api/agenda/card-payments", done_body)
    check("pagar el sugerido dos veces: done y already", (200, "done", 200, "already"), (s1, r1.get("result"), s2, r2.get("result")))
    check("queda una sola fila guardada y hecha", [{"n": 1, "status": "done"}], d1(f"SELECT count(*) AS n, max(status) AS status FROM agenda_items WHERE card_id='card-tdc-{RUN}' AND due_date='{due}'"))
    check("B no puede pagar la tarjeta de A", 404, b.call("POST", "/api/agenda/card-payments", done_body)[0])
check("tarjeta de débito no es pago sugerido", 404, a.call("POST", "/api/agenda/card-payments", {"cardId": f"card-deb-{RUN}", "dueDate": month_end.isoformat(), "action": "done"})[0])
check("fecha que no es de un sugerido", 404, a.call("POST", "/api/agenda/card-payments", {"cardId": f"card-tdc-{RUN}", "dueDate": "2020-01-01", "action": "done"})[0])

print("4) Solo lectura y aislamiento entre espacios")
check("V ve la página", 200, v.call("GET", "/app/agenda", raw=True)[0])
check("V no crea pagos", 403, v.call("POST", "/api/agenda/items", {"kind": "payable", "description": "x", "amount": "1", "dueDate": month_end.isoformat()})[0])
check("V no edita", 403, v.call("PATCH", f"/api/agenda/items/{receivable}", {"kind": "receivable", "description": "x", "amount": "1", "dueDate": month_end.isoformat()})[0])
check("V no cancela", 403, v.call("DELETE", f"/api/agenda/items/{receivable}", {})[0])
check("V no marca como hecho", 403, v.call("POST", f"/api/agenda/items/{receivable}/done", {})[0])
check("V no guarda saldos", 403, v.call("PUT", "/api/agenda/balances", {"label": "x", "amount": "1"})[0])
check("V no quita saldos", 403, v.call("DELETE", f"/api/agenda/balances/{free_balance}", {})[0])
html_b = text_of(b.call("GET", "/app/agenda", raw=True)[1])
check("B no ve los registros de A", (False, False), ("Renta" in html_b, "Cobro cliente" in html_b))
check("B no edita el cobro de A", 404, b.call("PATCH", f"/api/agenda/items/{receivable}", {"kind": "receivable", "description": "x", "amount": "1", "dueDate": month_end.isoformat()})[0])
check("B no lo cancela", 404, b.call("DELETE", f"/api/agenda/items/{receivable}", {})[0])
check("B no lo marca como hecho", 404, b.call("POST", f"/api/agenda/items/{receivable}/done", {})[0])
check("B no lo deshace", 404, b.call("POST", f"/api/agenda/items/{rent}/undo", {})[0])
check("B no edita el saldo libre de A", 404, b.call("PUT", "/api/agenda/balances", {"id": free_balance, "label": "x", "amount": "1"})[0])
check("B no quita el saldo libre de A", 404, b.call("DELETE", f"/api/agenda/balances/{free_balance}", {})[0])
check("B no guarda saldo en la débito de A", 404, b.call("PUT", "/api/agenda/balances", {"cardId": f"card-deb-{RUN}", "amount": "1"})[0])
check("el cobro de A sigue intacto", ("Cobro cliente", "pending"), tuple(d1(f"SELECT description, status FROM agenda_items WHERE id='{receivable}'")[0].values()))
check("cancelar el cobro (A)", (200, "cancelled"), (a.call("DELETE", f"/api/agenda/items/{receivable}", {})[0], scalar(f"SELECT status FROM agenda_items WHERE id='{receivable}'")))
check("quitar el saldo libre (A)", 200, a.call("DELETE", f"/api/agenda/balances/{free_balance}", {})[0])

print("5) Webhook de Kapso")
PHONE_A, PHONE_V = f"52100{secrets.randbelow(10**8):08d}", f"52100{secrets.randbelow(10**8):08d}"


def sign_item(item_key):
    mac = hmac.new(SECRET.encode(), item_key.encode(), hashlib.sha256).digest()
    return f"{item_key}.{base64.urlsafe_b64encode(mac).decode().rstrip('=')}"


def webhook(message, signature=None):
    raw = json.dumps({"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {"messaging_product": "whatsapp", "messages": [{"id": "wamid." + secrets.token_hex(4), "timestamp": "1762300000", **message}]}}]}]}).encode()
    sig = signature or hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return Client().call("POST", "/api/kapso/webhook", data=raw, headers={"X-Webhook-Signature": sig})[0]


def text_msg(phone, body):
    return {"from": phone, "type": "text", "text": {"body": body}}


def button(phone, payload):
    return {"from": phone, "type": "button", "button": {"payload": payload, "text": "Ya lo pagué"}}


check("firma inválida", 401, webhook(text_msg(PHONE_A, "hola"), signature="00" * 32))
check("sin firma", 401, Client().call("POST", "/api/kapso/webhook", {"entry": []})[0])
for client, uid, phone, who in ((a, id_a, PHONE_A, "A"), (v, id_v, PHONE_V, "V")):
    status, body = client.call("POST", "/api/agenda/whatsapp/link", {})
    check(f"código de vinculación para {who}", (200, True), (status, bool(re.fullmatch(r"[A-Z2-9]{6}", body.get("code", "")))))
    check(f"'Vincular CÓDIGO' liga el número de {who}", 200, webhook(text_msg(phone, f"vincular {body.get('code', '').lower()}")))
    check(f"…user.whatsapp_phone de {who} quedó guardado", phone, scalar(f"SELECT whatsapp_phone FROM user WHERE id='{uid}' AND whatsapp_verified_at IS NOT NULL"))
check("el mismo código ya no sirve para otro número", 200, webhook(text_msg("5210000000001", f"Vincular {body.get('code', '')}")))
check("…y no liga ese otro número", 0, scalar("SELECT count(*) FROM user WHERE whatsapp_phone='5210000000001'"))

status, body = a.call("POST", "/api/agenda/items", {"kind": "payable", "description": "Luz", "amount": "800", "dueDate": month_end.isoformat()})
luz = body.get("id")
status, body = b.call("POST", "/api/agenda/items", {"kind": "payable", "description": "Agua B", "amount": "300", "dueDate": month_end.isoformat()})
agua_b = body.get("id")
check("botón con token alterado no cambia nada", (200, "pending"), (webhook(button(PHONE_A, luz + ".firmafalsa")), scalar(f"SELECT status FROM agenda_items WHERE id='{luz}'")))
check("botón de V (solo lectura) no cambia nada", (200, "pending"), (webhook(button(PHONE_V, sign_item(luz))), scalar(f"SELECT status FROM agenda_items WHERE id='{luz}'")))
check("botón de A con un registro de otro espacio no cambia nada", (200, "pending"), (webhook(button(PHONE_A, sign_item(agua_b))), scalar(f"SELECT status FROM agenda_items WHERE id='{agua_b}'")))
check("botón de un número desconocido no cambia nada", (200, "pending"), (webhook(button("5210000000001", sign_item(luz))), scalar(f"SELECT status FROM agenda_items WHERE id='{luz}'")))
check("botón de A con token válido marca el pago", (200, "done", "whatsapp", id_a), (webhook(button(PHONE_A, sign_item(luz))), *d1(f"SELECT status, done_via, done_by_user_id FROM agenda_items WHERE id='{luz}'")[0].values()))
check("pulsarlo otra vez no cambia nada", (200, "done"), (webhook(button(PHONE_A, sign_item(luz))), scalar(f"SELECT status FROM agenda_items WHERE id='{luz}'")))

if CRON_URL:
    print("6) Cron de recordatorios (wrangler dev, /cdn-cgi/handler/scheduled)")
    mx_today = datetime.datetime.now(zoneinfo.ZoneInfo("America/Mexico_City")).date()
    due7 = (mx_today + datetime.timedelta(days=7)).isoformat()
    status, body = a.call("POST", "/api/agenda/items", {"kind": "payable", "description": "Internet", "amount": "500", "dueDate": due7})
    internet = body.get("id")

    def trigger():
        with urllib.request.urlopen(f"{CRON_URL}/cdn-cgi/handler/scheduled?cron=0+15+*+*+*") as response:
            return response.status

    check("primer disparo del cron", 200, trigger())
    for _ in range(10):  # el handler termina en waitUntil: se espera a que el aviso quede con su error
        rows = d1(f"SELECT 1 FROM agenda_notifications WHERE item_key='{internet}' AND error IS NOT NULL")
        if len(rows) >= 2:
            break
        time.sleep(1)
    rows = d1(f"SELECT user_id, offset, sent_at, error IS NOT NULL AS has_error FROM agenda_notifications WHERE item_key='{internet}'")
    check("un aviso de 7 días por destinatario (A y V), con error por la llave falsa", sorted([(id_a, "7d", None, 1), (id_v, "7d", None, 1)]), sorted(tuple(r.values()) for r in rows))
    check("segundo disparo del cron", 200, trigger())
    time.sleep(3)
    check("no se crean filas nuevas", 2, scalar(f"SELECT count(*) FROM agenda_notifications WHERE item_key='{internet}'"))
else:
    print("6) Cron: se salta (sin SMOKE_CRON_URL)")

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
