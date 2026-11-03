#!/usr/bin/env python3
"""
Prueba de humo de la captura por correo: dirección de reenvío por cuenta, correos simulados al handler `email()`
(`/cdn-cgi/handler/email` del servidor de desarrollo), revisión, confianza por firma DKIM, tarjeta desconocida,
duplicados, correo ilegible y que el CSV no duplique lo que ya llegó por correo.

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
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "http://localhost:4321"
DOMAIN = "in.donbigo.com"
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


def send(to, sender, subject, body, message_id, auth=None):
    """Entrega un correo al handler `email()` como lo haría Email Routing. Devuelve el código HTTP."""
    headers = [f"From: {sender}", f"To: {to}", f"Subject: {subject}", f"Message-ID: <{message_id}>", "Content-Type: text/plain; charset=utf-8"]
    if auth:
        headers.insert(0, f"Authentication-Results: {auth}")
    raw = ("\r\n".join(headers) + "\r\n\r\n" + body).encode()
    query = urllib.parse.urlencode({"from": sender, "to": to})
    request = urllib.request.Request(f"{BASE}/cdn-cgi/handler/email?{query}", data=raw, method="POST")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def status_of(message_id):
    return scalar(f"SELECT status FROM email_messages WHERE message_key='<{message_id}>' OR message_key='{message_id}'")


def notice(last4="4172", amount="995.15", ref="74657656275011773788752", date="02/10/2026"):
    return f"Compra aprobada\nTarjeta terminación {last4}\nComercio: GAS SERV SAN IDELFONSO\nMonto: ${amount}\nFecha de operación: {date}\nReferencia: {ref}\n"


print("0) Preparación: A (dueña de la cuenta) y B (otro espacio)")
admin, a, b = Client(), Client(), Client()
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test")):
    admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
ws_a = scalar("SELECT id FROM workspaces WHERE name='Usuario A'")
d1(f"INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('acc-a', '{ws_a}', 'Cuenta A', 'Banorte')")
d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency, cutoff_day) VALUES ('card-a', '{ws_a}', 'acc-a', 'credit', '4172', 'MXN', 15)")

print("1) Dirección de reenvío")
check("B no puede activarla en la cuenta de A", 404, b.call("POST", "/api/accounts/acc-a/email", {})[0])
check("sin sesión", 401, Client().call("POST", "/api/accounts/acc-a/email", {})[0])
check("A la activa", 200, a.call("POST", "/api/accounts/acc-a/email", {})[0])
token = scalar("SELECT token FROM email_inboxes WHERE account_id='acc-a'")
to = f"{token}@{DOMAIN}"
status, html = a.call("GET", "/app/cuentas/acc-a", raw=True)
check("la página de la cuenta muestra la dirección", (200, True), (status, to in html))
check("una dirección inexistente se rebota", True, send(f"{'a' * 26}@{DOMAIN}", "x@banco.com.mx", "Compra", notice(), "m0@test") >= 400)

print("2) Confirmación de reenvío de Gmail")
send(to, "forwarding-noreply@google.com", "(#123456789) Confirmación de reenvío de Gmail", "Código de confirmación: 123456789", "m1@test")
check("queda como confirmación", "confirmation", status_of("m1@test"))
check("la página muestra el código", True, "123456789" in a.call("GET", "/app/cuentas/acc-a", raw=True)[1])

print("3) Aviso sin firma: espera revisión y se registra al aprobarlo")
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(), "m2@test")
check("por revisar, sin movimiento", ("review", 0), (status_of("m2@test"), scalar("SELECT count(*) FROM movements WHERE account_id='acc-a'")))
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(), "m2@test")
check("el mismo Message-ID no se procesa dos veces", 1, scalar("SELECT count(*) FROM email_messages WHERE message_key='<m2@test>'"))
mid = scalar("SELECT id FROM email_messages WHERE message_key='<m2@test>'")
check("B no puede revisarlo", 404, b.call("POST", f"/api/email-messages/{mid}", {"action": "apply"})[0])
check("acción inválida", 400, a.call("POST", f"/api/email-messages/{mid}", {"action": "x"})[0])
status, body = a.call("POST", f"/api/email-messages/{mid}", {"action": "apply"})
check("A lo registra", (200, "applied"), (status, body.get("status")))
row = d1("SELECT * FROM movements WHERE account_id='acc-a'")[0]
check("movimiento: fecha de operación, monto, tarjeta y referencia", ("2026-10-02", 99515, 0, "card-a", "74657656275011773788752"), (row["date"], row["charge_minor"], row["credit_minor"], row["card_id"], row["reference"]))
check("en el lote de correo, fuera del historial de cargas", "email", scalar(f"SELECT source FROM import_batches WHERE id='{row['batch_id']}'"))
check("ya no se puede volver a aplicar", 409, a.call("POST", f"/api/email-messages/{mid}", {"action": "apply"})[0])

print("4) Duplicado: otro correo con la misma referencia y monto")
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(), "m3@test")
mid = scalar("SELECT id FROM email_messages WHERE message_key='<m3@test>'")
check("al aprobarlo se detecta como ya registrado", "duplicate", a.call("POST", f"/api/email-messages/{mid}", {"action": "apply"})[1].get("status"))
check("sigue habiendo un solo movimiento", 1, scalar("SELECT count(*) FROM movements WHERE account_id='acc-a'"))

print("5) Confianza en el dominio firmado")
signed = "mx.cloudflare.net; dkim=pass header.d=banco.com.mx header.s=s1; spf=fail"
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(amount="100.00", ref="REF0001"), "m4@test", auth=signed)
mid = scalar("SELECT id FROM email_messages WHERE message_key='<m4@test>'")
check("firmado pero aún no confiable: por revisar", "review", status_of("m4@test"))
a.call("POST", f"/api/email-messages/{mid}", {"action": "apply", "trustDomain": True})
check("al aprobar con confianza se guarda el dominio", '["banco.com.mx"]', scalar("SELECT trusted_domains FROM email_inboxes WHERE account_id='acc-a'"))
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(amount="200.00", ref="REF0002"), "m5@test", auth=signed)
check("el siguiente firmado se registra solo", "applied", status_of("m5@test"))
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(amount="300.00", ref="REF0003"), "m6@test", auth="mx.evil.test; dkim=pass header.d=banco.com.mx")
check("una firma que no agregó Cloudflare no cuenta", "review", status_of("m6@test"))
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(amount="300.00", ref="REF0004"), "m7@test", auth="mx.cloudflare.net; dkim=pass header.d=gmail.com")
check("la firma de otro dominio no cuenta", "review", status_of("m7@test"))

print("6) Tarjeta no registrada")
send(to, "alertas@banco.com.mx", "Compra aprobada", notice(last4="9999", amount="50.00", ref="REF0005"), "m8@test", auth=signed)
check("queda como tarjeta desconocida", "unknown_card", status_of("m8@test"))
d1(f"INSERT INTO cards (id, workspace_id, account_id, kind, last4, currency) VALUES ('card-a2', '{ws_a}', 'acc-a', 'debit', '9999', 'MXN')")
mid = scalar("SELECT id FROM email_messages WHERE message_key='<m8@test>'")
check("tras dar de alta la tarjeta se registra", "applied", a.call("POST", f"/api/email-messages/{mid}", {"action": "apply"})[1].get("status"))
check("en la tarjeta nueva", "card-a2", scalar("SELECT card_id FROM movements WHERE reference='REF0005'"))

print("7) Correo ilegible")
send(to, "promos@banco.com.mx", "Conoce tus beneficios", "Hola, tenemos promociones para ti.", "m9@test")
raw_key = scalar("SELECT raw_key FROM email_messages WHERE message_key='<m9@test>'")
check("queda sin leer y con el original guardado", ("unparsed", True), (status_of("m9@test"), bool(raw_key)))
mid = scalar("SELECT id FROM email_messages WHERE message_key='<m9@test>'")
check("no se puede aplicar", 409, a.call("POST", f"/api/email-messages/{mid}", {"action": "apply"})[0])
check("al descartarlo se borra el original", (200, None), (a.call("POST", f"/api/email-messages/{mid}", {"action": "dismiss"})[0], scalar(f"SELECT raw_key FROM email_messages WHERE id='{mid}'")))

print("8) El CSV no duplica lo que ya llegó por correo")
CSV = open(os.path.join(ROOT, "tests/fixtures/movements-sample.csv"), encoding="utf-8").read()
status, body = a.call("POST", "/api/import/preview", {"accountId": "acc-a", "text": CSV})
p = body.get("preview", {})
dup = [m for m in p.get("movements", []) if m.get("status") == "duplicate"]
check("vista previa: el cargo recibido por correo sale como duplicado", (200, 1), (status, len(dup)))

print("9) Desactivar y cambiar la dirección")
check("A la desactiva", 200, a.call("DELETE", "/api/accounts/acc-a/email", {})[0])
check("los correos a la dirección desactivada se rebotan", True, send(to, "alertas@banco.com.mx", "Compra", notice(), "m10@test") >= 400)
a.call("POST", "/api/accounts/acc-a/email", {"regenerate": True})
check("cambiarla genera otra dirección", True, scalar("SELECT token FROM email_inboxes WHERE account_id='acc-a'") != token)
check("la anterior ya no recibe", True, send(to, "alertas@banco.com.mx", "Compra", notice(), "m11@test") >= 400)

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
