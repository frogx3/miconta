#!/usr/bin/env bash
# Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
#   rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
# Crea usuarios, cuentas y tarjetas de prueba; vuelve a vaciar la base local al terminar.
# Prueba de humo del CRUD de cuentas y tarjetas: permisos, aislamiento entre espacios, validación, archivado,
# varias tarjetas por cuenta, últimos 4 repetidos y tarjetas con historial.
B=http://localhost:4321
O="Origin: $B"
DIR=$(mktemp -d)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PW="Aa1-$(openssl rand -hex 10)"
JSON=(-H "$O" -H 'Content-Type: application/json')
ADMIN=$DIR/admin.jar A=$DIR/a.jar BJ=$DIR/b.jar CJ=$DIR/c.jar

ok()    { printf '  %-66s %s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "✓ $1" "$3"; else ok "✗ $1 (esperado $2)" "$3"; FAIL=1; [ -s "$DIR/last.body" ] && echo "      respuesta: $(head -c 240 "$DIR/last.body")"; fi; }
status() { tail -1; }
body()   { sed '$d'; }
idof()   { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
d1()     { (cd "$ROOT" && pnpm exec wrangler d1 execute miconta --local --json --command "$1" 2>/dev/null); }
d1_v()   { d1 "$1" | sed -n 's/.*"v": "\{0,1\}\([^",]*\).*/\1/p' | head -1; }

# api MÉTODO JAR RUTA [CUERPO] -> cuerpo + código HTTP en la última línea
api() {
  if [ -n "$4" ]; then
    curl -s -b "$2" -c "$2" -X "$1" "${JSON[@]}" -w '\n%{http_code}' -d "$4" "$B$3" | tee "$DIR/last.body"
  else
    curl -s -b "$2" -c "$2" -X "$1" "${JSON[@]}" -w '\n%{http_code}' "$B$3" | tee "$DIR/last.body"
  fi
}
acct_body() { printf '{"name":"%s","bank":"%s","customerId":"%s"}' "$@"; }
# card_body kind digital last4 label currency limit cutoff due
card_body() { printf '{"kind":"%s","isDigital":%s,"last4":"%s","label":"%s","currency":"%s","creditLimit":"%s","cutoffDay":"%s","paymentDueDay":"%s"}' "$@"; }
signin()    { api POST "$1" /api/auth/sign-in/email "$(printf '{"email":"%s","password":"%s"}' "$2" "$PW")" | status; }
mkuser()    { api POST "$ADMIN" /api/auth/admin/create-user "$(printf '{"name":"%s","email":"%s","password":"%s","role":"user","data":{"locale":"es-MX"}}' "$1" "$2" "$PW")"; }

echo "0) Preparación: admin y tres usuarios (A dueño, B ajeno, C solo lectura en el espacio de A)"
api POST "$ADMIN" /api/auth/sign-up/email "$(printf '{"name":"Admin","email":"admin@miconta.test","password":"%s"}' "$PW")" >/dev/null
mkuser "Usuario A" a@miconta.test >/dev/null
mkuser "Usuario B" b@miconta.test >/dev/null
C_ID=$(mkuser "Usuario C" c@miconta.test | body | idof)
check "sign-in A" 200 "$(signin $A a@miconta.test)"; sleep 4
check "sign-in B" 200 "$(signin $BJ b@miconta.test)"; sleep 4
check "sign-in C" 200 "$(signin $CJ c@miconta.test)"
A_WS=$(d1_v "SELECT w.id AS v FROM workspaces w WHERE w.name='Usuario A'")
d1 "DELETE FROM workspace_members WHERE user_id='$C_ID'" >/dev/null
d1 "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('$A_WS', '$C_ID', 'viewer')" >/dev/null

echo "1) Acceso"
check "sin sesión: crear cuenta" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${JSON[@]}" -d '{}' $B/api/accounts)"
check "admin (sin espacio): crear cuenta" 403 "$(api POST $ADMIN /api/accounts "$(acct_body X Y '')" | status)"
check "origen ajeno rechazado" 403 "$(curl -s -o /dev/null -w '%{http_code}' -b $A -X POST -H 'Origin: http://evil.test' -H 'Content-Type: application/json' -d "$(acct_body X Y '')" $B/api/accounts)"
check "cuerpo no JSON" 400 "$(api POST $A /api/accounts 'esto no es json' | status)"

echo "2) Crear cuenta (A)"
R=$(api POST $A /api/accounts "$(acct_body 'Mi Banorte' Banorte 'CL-12345')")
check "crear cuenta" 201 "$(echo "$R" | status)"
ACC=$(echo "$R" | body | idof)
check "ID de cliente guardado" "CL-12345" "$(d1_v "SELECT customer_id AS v FROM accounts WHERE id='$ACC'")"
check "nombre y banco guardados" "Mi Banorte/Banorte" "$(d1_v "SELECT name || '/' || bank AS v FROM accounts WHERE id='$ACC'")"
R=$(api POST $A /api/accounts "$(acct_body 'Sin cliente' BBVA '')")
check "cuenta sin ID de cliente" 201 "$(echo "$R" | status)"
ACC2=$(echo "$R" | body | idof)
check "customer_id queda nulo" 1 "$(d1_v "SELECT count(*) AS v FROM accounts WHERE id='$ACC2' AND customer_id IS NULL")"
R=$(api POST $A /api/accounts "$(acct_body '' '' '')")
check "validación: nombre y banco obligatorios" 400 "$(echo "$R" | status)"
for field in name bank; do
  check "  error reportado en $field" 1 "$(echo "$R" | body | grep -c "\"field\":\"$field\"")"
done
check "ID de cliente demasiado largo" 400 "$(api POST $A /api/accounts "$(acct_body X Y "$(printf 'x%.0s' $(seq 1 41))")" | status)"

echo "3) Varias tarjetas en una cuenta"
R=$(api POST $A /api/accounts/$ACC/cards "$(card_body credit false 4172 Física MXN '50,000.00' 15 5)")
check "tarjeta de crédito física" 201 "$(echo "$R" | status)"
C1=$(echo "$R" | body | idof)
R=$(api POST $A /api/accounts/$ACC/cards "$(card_body credit true 9001 'Compras en línea' mxn '20,000' 15 5)")
check "tarjeta de crédito digital" 201 "$(echo "$R" | status)"
C2=$(echo "$R" | body | idof)
R=$(api POST $A /api/accounts/$ACC/cards "$(card_body debit false 2455 Nómina MXN '' '' '')")
check "tarjeta de débito" 201 "$(echo "$R" | status)"
C3=$(echo "$R" | body | idof)
check "la cuenta tiene 3 tarjetas" 3 "$(d1_v "SELECT count(*) AS v FROM cards WHERE account_id='$ACC'")"
check "límite guardado en centavos" 5000000 "$(d1_v "SELECT credit_limit_minor AS v FROM cards WHERE id='$C1'")"
check "corte y pago guardados" "15/5" "$(d1_v "SELECT cutoff_day || '/' || payment_due_day AS v FROM cards WHERE id='$C1'")"
check "tarjeta digital marcada" "0/1/0" "$(d1_v "SELECT is_digital || '/' || (SELECT is_digital FROM cards WHERE id='$C2') || '/' || (SELECT is_digital FROM cards WHERE id='$C3') AS v FROM cards WHERE id='$C1'")"
check "moneda normalizada a mayúsculas" MXN "$(d1_v "SELECT currency AS v FROM cards WHERE id='$C2'")"
check "débito: sin límite, corte ni pago" 1 "$(d1_v "SELECT count(*) AS v FROM cards WHERE id='$C3' AND credit_limit_minor IS NULL AND cutoff_day IS NULL AND payment_due_day IS NULL")"
check "tipos guardados" "credit/credit/debit" "$(d1_v "SELECT kind || '/' || (SELECT kind FROM cards WHERE id='$C2') || '/' || (SELECT kind FROM cards WHERE id='$C3') AS v FROM cards WHERE id='$C1'")"
check "la tarjeta quedó ligada a la cuenta y su espacio" "$ACC/$A_WS" "$(d1_v "SELECT account_id || '/' || workspace_id AS v FROM cards WHERE id='$C1'")"
check "últimos 4 repetidos en la cuenta: 409 DUPLICATE_CARD" 409 "$(api POST $A /api/accounts/$ACC/cards "$(card_body debit false 4172 '' MXN '' '' '')" | status)"
check "  código DUPLICATE_CARD" 1 "$(grep -c DUPLICATE_CARD $DIR/last.body)"
check "los mismos últimos 4 en OTRA cuenta sí se permiten" 201 "$(api POST $A /api/accounts/$ACC2/cards "$(card_body credit false 4172 '' USD '' 10 '')" | status)"
R=$(api POST $A /api/accounts/$ACC/cards "$(card_body credit false 12 '' ZZZ mucho 40 99)")
check "validación: varios errores" 400 "$(echo "$R" | status)"
for field in last4 currency creditLimit cutoffDay paymentDueDay; do
  check "  error reportado en $field" 1 "$(echo "$R" | body | grep -c "\"field\":\"$field\"")"
done
check "los últimos 4 son obligatorios" 1 "$(api POST $A /api/accounts/$ACC/cards "$(card_body debit false '' '' MXN '' '' '')" | body | grep -c '"field":"last4","code":"required"')"
check "crédito sin día de corte: rechazado" 1 "$(api POST $A /api/accounts/$ACC/cards "$(card_body credit false 7777 '' MXN '' '' '')" | body | grep -c '"field":"cutoffDay","code":"required"')"
check "tarjeta en cuenta inexistente" 404 "$(api POST $A /api/accounts/no-existe/cards "$(card_body debit false 5555 '' MXN '' '' '')" | status)"

echo "4) Editar y archivar"
check "editar cuenta" 200 "$(api PATCH $A /api/accounts/$ACC "$(acct_body 'Mi Banorte Plus' Banorte 'CL-99999')" | status)"
check "nombre e ID de cliente actualizados" "Mi Banorte Plus/CL-99999" "$(d1_v "SELECT name || '/' || customer_id AS v FROM accounts WHERE id='$ACC'")"
check "editar cuenta con datos inválidos" 400 "$(api PATCH $A /api/accounts/$ACC "$(acct_body '' Banorte '')" | status)"
check "cuenta inexistente" 404 "$(api PATCH $A /api/accounts/no-existe "$(acct_body X Y '')" | status)"
check "editar tarjeta" 200 "$(api PATCH $A /api/accounts/$ACC/cards/$C1 "$(card_body credit false 4172 Principal MXN '60,000' 20 10)" | status)"
check "límite y corte actualizados" "6000000/20" "$(d1_v "SELECT credit_limit_minor || '/' || cutoff_day AS v FROM cards WHERE id='$C1'")"
check "etiqueta guardada" Principal "$(d1_v "SELECT label AS v FROM cards WHERE id='$C1'")"
check "editar con datos inválidos" 400 "$(api PATCH $A /api/accounts/$ACC/cards/$C1 "$(card_body credit false 41 '' MXN '' 20 10)" | status)"
check "mover a últimos 4 ya usados: 409" 409 "$(api PATCH $A /api/accounts/$ACC/cards/$C1 "$(card_body credit false 2455 '' MXN '' 20 10)" | status)"
check "tarjeta inexistente" 404 "$(api PATCH $A /api/accounts/$ACC/cards/no-existe "$(card_body debit false 5555 '' MXN '' '' '')" | status)"
check "archivar tarjeta" 200 "$(api PATCH $A /api/accounts/$ACC/cards/$C2 '{"archived":true}' | status)"
check "archived_at de la tarjeta definido" 1 "$(d1_v "SELECT count(*) AS v FROM cards WHERE id='$C2' AND archived_at IS NOT NULL")"
check "restaurar tarjeta" 200 "$(api PATCH $A /api/accounts/$ACC/cards/$C2 '{"archived":false}' | status)"
check "archived_at de la tarjeta vacío" 1 "$(d1_v "SELECT count(*) AS v FROM cards WHERE id='$C2' AND archived_at IS NULL")"
check "archivar cuenta" 200 "$(api PATCH $A /api/accounts/$ACC2 '{"archived":true}' | status)"
check "archived_at de la cuenta definido" 1 "$(d1_v "SELECT count(*) AS v FROM accounts WHERE id='$ACC2' AND archived_at IS NOT NULL")"
check "restaurar cuenta" 200 "$(api PATCH $A /api/accounts/$ACC2 '{"archived":false}' | status)"
check "archived_at de la cuenta vacío" 1 "$(d1_v "SELECT count(*) AS v FROM accounts WHERE id='$ACC2' AND archived_at IS NULL")"

echo "5) Pantallas"
check "lista de cuentas" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b $A $B/app/cuentas)"
check "lista muestra la cuenta" 1 "$(curl -s -b $A $B/app/cuentas | grep -c 'Mi Banorte Plus')"
check "detalle de la cuenta" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b $A $B/app/cuentas/$ACC)"
check "formulario de cuenta nueva" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b $A $B/app/cuentas/nueva)"
check "las rutas viejas /app/tarjetas ya no existen" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b $A $B/app/tarjetas)"

echo "6) Aislamiento entre espacios y rol de solo lectura"
check "B no puede editar la cuenta de A" 404 "$(api PATCH $BJ /api/accounts/$ACC "$(acct_body Robada Banco '')" | status)"
check "B no puede archivar la cuenta de A" 404 "$(api PATCH $BJ /api/accounts/$ACC '{"archived":true}' | status)"
check "B no puede agregar tarjetas a la cuenta de A" 404 "$(api POST $BJ /api/accounts/$ACC/cards "$(card_body debit false 1111 '' MXN '' '' '')" | status)"
check "B no puede editar tarjetas de A" 404 "$(api PATCH $BJ /api/accounts/$ACC/cards/$C1 "$(card_body debit false 4172 '' MXN '' '' '')" | status)"
check "B no puede archivar tarjetas de A" 404 "$(api PATCH $BJ /api/accounts/$ACC/cards/$C1 '{"archived":true}' | status)"
check "B no puede quitar tarjetas de A" 404 "$(api DELETE $BJ /api/accounts/$ACC/cards/$C1 | status)"
check "B no ve la cuenta de A en su lista" 0 "$(curl -s -b $BJ $B/app/cuentas | grep -c 'Mi Banorte Plus')"
check "la cuenta de A sigue intacta" "Mi Banorte Plus" "$(d1_v "SELECT name AS v FROM accounts WHERE id='$ACC'")"
check "C (solo lectura) no puede crear cuentas" 403 "$(api POST $CJ /api/accounts "$(acct_body X Y '')" | status)"
check "C (solo lectura) no puede editar cuentas" 403 "$(api PATCH $CJ /api/accounts/$ACC "$(acct_body X Y '')" | status)"
check "C (solo lectura) no puede agregar tarjetas" 403 "$(api POST $CJ /api/accounts/$ACC/cards "$(card_body debit false 1111 '' MXN '' '' '')" | status)"
check "C (solo lectura) no puede quitar tarjetas" 403 "$(api DELETE $CJ /api/accounts/$ACC/cards/$C1 | status)"
check "C responde READ_ONLY" 1 "$(grep -c READ_ONLY $DIR/last.body)"
check "C sí puede ver la lista" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b $CJ $B/app/cuentas)"

echo "7) Una tarjeta con historial no se puede quitar: se archiva"
A_ID=$(d1_v "SELECT user_id AS v FROM workspace_members WHERE workspace_id='$A_WS' AND role='owner'")
d1 "INSERT INTO import_batches (id, workspace_id, account_id, file_name, created_by) VALUES ('smoke-batch', '$A_WS', '$ACC', 'x.csv', '$A_ID')" >/dev/null
d1 "INSERT INTO movements (id, workspace_id, account_id, card_id, batch_id, unique_key, date, description, description_norm, currency) VALUES ('smoke-mov', '$A_WS', '$ACC', '$C1', 'smoke-batch', 'k#1', '2026-10-01', 'TIENDA', 'TIENDA', 'MXN')" >/dev/null
check "quitar tarjeta con movimientos: 409" 409 "$(api DELETE $A /api/accounts/$ACC/cards/$C1 | status)"
check "  código CARD_IN_USE" 1 "$(grep -c CARD_IN_USE $DIR/last.body)"
check "la tarjeta con movimientos sigue existiendo" 1 "$(d1_v "SELECT count(*) AS v FROM cards WHERE id='$C1'")"
check "pero sí se puede archivar" 200 "$(api PATCH $A /api/accounts/$ACC/cards/$C1 '{"archived":true}' | status)"
check "queda archivada con su historial" "1/1" "$(d1_v "SELECT (SELECT count(*) FROM cards WHERE id='$C1' AND archived_at IS NOT NULL) || '/' || (SELECT count(*) FROM movements WHERE card_id='$C1') AS v")"
d1 "INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date, status) VALUES ('smoke-plan', '$A_WS', '$C2', 'msi', 'Plan', 'PLAN', 'MXN', 1200, 100, 12, 0, '2026-10-01', 'active')" >/dev/null
check "quitar tarjeta con planes: 409 CARD_IN_USE" "409/1" "$(api DELETE $A /api/accounts/$ACC/cards/$C2 | status)/$(grep -c CARD_IN_USE $DIR/last.body)"
check "quitar tarjeta que no es de esa cuenta" 404 "$(api DELETE $A /api/accounts/$ACC2/cards/$C3 | status)"
check "quitar tarjeta sin historial" 200 "$(api DELETE $A /api/accounts/$ACC/cards/$C3 | status)"
check "la tarjeta ya no existe" 0 "$(d1_v "SELECT count(*) AS v FROM cards WHERE id='$C3'")"
check "tarjeta inexistente al quitar" 404 "$(api DELETE $A /api/accounts/$ACC/cards/$C3 | status)"
check "al quitarla, sus últimos 4 se pueden volver a usar" 201 "$(api POST $A /api/accounts/$ACC/cards "$(card_body debit false 2455 '' MXN '' '' '')" | status)"

rm -rf "$DIR"
[ -z "$FAIL" ] && echo "TODO OK" || { echo "HAY FALLOS"; exit 1; }
