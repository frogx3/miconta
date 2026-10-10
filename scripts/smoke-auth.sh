#!/usr/bin/env bash
# Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
#   rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
# Crea usuarios de prueba (@miconta.test); vuelve a vaciar la base local al terminar.
# Prueba de humo de autenticación y gestión de cuentas contra el servidor de desarrollo (D1 local).
B=http://localhost:4321
O="Origin: $B"
DIR=$(mktemp -d)
ADMIN_PW="Aa1-$(openssl rand -hex 10)"
FAM_PW="Bb2-$(openssl rand -hex 10)"
NEW_PW="Cc3-$(openssl rand -hex 10)"
ADMIN_JAR=$DIR/admin.jar
FAM_JAR=$DIR/fam.jar
MX_JAR=$DIR/mx.jar
JSON=(-H "$O" -H 'Content-Type: application/json')
ROOT=$(cd "$(dirname "$0")/.." && pwd)

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
loc()  { curl -s -o /dev/null -w '%{redirect_url}' "$@" | sed "s#$B##"; }
ok()   { printf '  %-64s %s\n' "$1" "$2"; }
check() { # descripción esperado real
  if [ "$2" = "$3" ]; then ok "✓ $1" "$3"; else ok "✗ $1 (esperado $2)" "$3"; FAIL=1; [ -s "$DIR/last.body" ] && echo "      respuesta: $(head -c 220 "$DIR/last.body")"; fi
}
wait_rate_limit() { sleep 11; } # sign-in: 3 intentos por 10 s
post() { # jar ruta cuerpo -> imprime cuerpo y código en la última línea
  curl -s -b "$1" -c "$1" "${JSON[@]}" -w '\n%{http_code}' -d "$3" "$B/api/auth/$2" | tee "$DIR/last.body"
}
status() { tail -1; }
body() { sed '$d'; }
signin()  { post "$1" sign-in/email "$(printf '{"email":"%s","password":"%s"}' "$2" "$3")" | status; }
admin_user_action() { post "$ADMIN_JAR" "admin/$1" "$(printf '{"userId":"%s"}' "$2")" | status; }
admin_update() { post "$ADMIN_JAR" admin/update-user "$(printf '{"userId":"%s","data":{"name":"%s","email":"%s"}}' "$1" "$2" "$3")" | status; }
admin_set_pw() { post "$ADMIN_JAR" admin/set-user-password "$(printf '{"userId":"%s","newPassword":"%s"}' "$1" "$2")" | status; }
d1() { (cd "$ROOT" && pnpm exec wrangler d1 execute miconta --local --json --command "$1" 2>/dev/null); }
d1_n() { d1 "$1" | grep -o '"n": [0-9]*' | head -1 | grep -o '[0-9]*$'; }
del() { curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "${2:-$O}" ${3:+-b "$3"} "$B/api/admin/users/$1"; }
idof() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
sessionuser() { sed -n 's/.*"user":{.*"id":"\([^"]*\)".*/\1/p'; }

echo "1) Rutas protegidas sin sesión"
check "GET /login" 200 "$(code $B/login)"
check "GET /app redirige a /login" "/login" "$(loc $B/app)"
check "GET /admin redirige a /login" "/login" "$(loc $B/admin)"
check "registro avisa que el admin no usa la app" 1 "$(curl -s $B/registro | grep -c 'cuenta de usuario aparte')"

echo "2) Primer usuario = administrador, SIN espacio ni acceso a /app"
R=$(post "$ADMIN_JAR" sign-up/email "{\"name\":\"Admin Prueba\",\"email\":\"admin@miconta.test\",\"password\":\"$ADMIN_PW\"}")
check "sign-up primer usuario" 200 "$(echo "$R" | status)"
check "GET /app como admin redirige a /admin" "/admin" "$(loc -b $ADMIN_JAR $B/app)"
check "GET /admin como admin" 200 "$(code -b $ADMIN_JAR $B/admin)"
check "GET /login con sesión admin -> /admin" "/admin" "$(loc -b $ADMIN_JAR $B/login)"
check "GET / con sesión admin -> /admin" "/admin" "$(loc -b $ADMIN_JAR $B/)"

echo "3) Registro público cerrado tras el primer usuario"
R=$(post "$DIR/x.jar" sign-up/email "{\"name\":\"Intruso\",\"email\":\"intruso@miconta.test\",\"password\":\"$FAM_PW\"}")
check "sign-up público rechazado" 403 "$(echo "$R" | status)"
check "código SIGNUP_DISABLED" 1 "$(echo "$R" | grep -c SIGNUP_DISABLED)"

echo "4) El admin crea cuentas de usuario (cada una recibe su espacio)"
R=$(post "$ADMIN_JAR" admin/create-user "{\"name\":\"Familiar Prueba\",\"email\":\"familiar@miconta.test\",\"password\":\"$FAM_PW\",\"role\":\"user\",\"data\":{\"locale\":\"en\"}}")
check "crear cuenta (en)" 200 "$(echo "$R" | status)"
FAM_ID=$(echo "$R" | body | idof)
R=$(post "$ADMIN_JAR" admin/create-user "{\"name\":\"Usuario Mexico\",\"email\":\"usuario@miconta.test\",\"password\":\"$FAM_PW\",\"role\":\"user\",\"data\":{\"locale\":\"es-MX\"}}")
check "crear cuenta (es-MX)" 200 "$(echo "$R" | status)"
R=$(post "$ADMIN_JAR" admin/create-user "{\"name\":\"Otro Admin\",\"email\":\"admin2@miconta.test\",\"password\":\"$FAM_PW\",\"role\":\"admin\"}")
check "crear otra cuenta admin" 200 "$(echo "$R" | status)"
R=$(post "$ADMIN_JAR" admin/create-user "{\"name\":\"Duplicado\",\"email\":\"familiar@miconta.test\",\"password\":\"$FAM_PW\",\"role\":\"user\"}")
check "correo duplicado rechazado" 1 "$(echo "$R" | grep -c USER_ALREADY_EXISTS)"
check "la lista de /admin muestra las 4 cuentas" 4 "$(curl -s -b $ADMIN_JAR $B/admin | grep -o 'miconta.test</td>' | wc -l | tr -d ' ')"

wait_rate_limit
echo "5) Los usuarios usan la app; no entran a /admin"
check "sign-in familiar" 200 "$(signin "$FAM_JAR" familiar@miconta.test "$FAM_PW")"
check "GET /app familiar" 200 "$(code -b $FAM_JAR $B/app)"
check "familiar en inglés" 1 "$(curl -s -b $FAM_JAR $B/app | grep -c 'Hello, Familiar Prueba')"
check "familiar: espacio en USD" 1 "$(curl -s -b $FAM_JAR $B/app | grep -c 'USD')"
check "GET /admin familiar -> /app" "/app" "$(loc -b $FAM_JAR $B/admin)"
check "familiar no puede usar la API de admin" 403 "$(code -b $FAM_JAR "$B/api/auth/admin/list-users?limit=10")"
check "sign-in usuario es-MX" 200 "$(signin "$MX_JAR" usuario@miconta.test "$FAM_PW")"
check "usuario es-MX: espacio en MXN" 1 "$(curl -s -b $MX_JAR $B/app | grep -c 'MXN')"

wait_rate_limit
echo "6) El admin edita cuentas"
check "página de edición" 200 "$(code -b $ADMIN_JAR $B/admin/users/$FAM_ID)"
check "editar nombre y correo" 200 "$(admin_update "$FAM_ID" "Familiar Editado" familiar2@miconta.test)"
check "el cambio se refleja en /admin" 1 "$(curl -s -b $ADMIN_JAR $B/admin | grep -c 'Familiar Editado')"
check "restablecer contraseña" 200 "$(admin_set_pw "$FAM_ID" "$NEW_PW")"
check "la contraseña vieja ya no sirve" 401 "$(signin "$DIR/o.jar" familiar2@miconta.test "$FAM_PW")"
check "la nueva contraseña sí" 200 "$(signin "$DIR/n.jar" familiar2@miconta.test "$NEW_PW")"

wait_rate_limit
echo "7) Suspender y reactivar"
check "suspender cuenta" 200 "$(admin_user_action ban-user "$FAM_ID")"
check "cuenta suspendida no inicia sesión" 403 "$(signin "$DIR/b.jar" familiar2@miconta.test "$NEW_PW")"
check "su sesión activa deja de valer" "/login" "$(loc -b $DIR/n.jar $B/app)"
check "reactivar cuenta" 200 "$(admin_user_action unban-user "$FAM_ID")"
check "vuelve a iniciar sesión" 200 "$(signin "$DIR/c.jar" familiar2@miconta.test "$NEW_PW")"
ADMIN_ID=$(curl -s -b $ADMIN_JAR "$B/api/auth/get-session" | sessionuser)
check "el admin no puede suspenderse a sí mismo" 400 "$(admin_user_action ban-user "$ADMIN_ID")"

wait_rate_limit
echo "8) Credenciales incorrectas y límite de intentos"
R=$(post "$DIR/w.jar" sign-in/email '{"email":"usuario@miconta.test","password":"incorrecta-123456"}')
check "contraseña incorrecta" 401 "$(echo "$R" | status)"
LAST=0
for i in $(seq 1 12); do
  LAST=$(code "${JSON[@]}" -d '{"email":"usuario@miconta.test","password":"incorrecta-123456"}' $B/api/auth/sign-in/email)
done
check "tras varios intentos responde 429" 429 "$LAST"

wait_rate_limit
echo "9) Eliminar cuentas: solo las que no tienen información financiera"
R=$(post "$ADMIN_JAR" admin/create-user "$(printf '{"name":"Borrable","email":"borrable@miconta.test","password":"%s","role":"user"}' "$FAM_PW")")
DEL_ID=$(echo "$R" | body | idof)
check "la cuenta nueva tiene su espacio" 1 "$(d1_n "SELECT count(*) AS n FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id='$DEL_ID'")"
check "la página ofrece eliminar (sin datos)" 1 "$(curl -s -b $ADMIN_JAR $B/admin/users/$DEL_ID | grep -c 'id="delete-user"')"
check "sin sesión no puede eliminar" 401 "$(del $DEL_ID "$O")"
check "un usuario no-admin no puede eliminar" 403 "$(del $DEL_ID "$O" $MX_JAR)"
check "origen ajeno rechazado" 403 "$(del $DEL_ID 'Origin: http://evil.test' $ADMIN_JAR)"
check "el admin no puede eliminarse a sí mismo" 400 "$(del $ADMIN_ID "$O" $ADMIN_JAR)"
check "cuenta inexistente" 404 "$(del no-existe "$O" $ADMIN_JAR)"
check "eliminar cuenta sin datos" 200 "$(del $DEL_ID "$O" $ADMIN_JAR)"
check "ya no está en la lista" 0 "$(curl -s -b $ADMIN_JAR $B/admin | grep -c 'borrable@miconta.test')"
check "su espacio vacío también se eliminó" 0 "$(d1_n "SELECT count(*) AS n FROM workspaces WHERE name='Borrable'")"
check "ya no puede iniciar sesión" 401 "$(signin "$DIR/d.jar" borrable@miconta.test "$FAM_PW")"

FAM_WS=$(d1 "SELECT workspace_id AS w FROM workspace_members WHERE user_id='$FAM_ID'" | grep -o '"w": "[^"]*"' | head -1 | cut -d'"' -f4)
d1 "INSERT INTO accounts (id, workspace_id, name, bank) VALUES ('smoke-acct', '$FAM_WS', 'Cuenta de prueba', 'Banco')" >/dev/null
check "la página NO ofrece eliminar (con datos)" 0 "$(curl -s -b $ADMIN_JAR $B/admin/users/$FAM_ID | grep -c 'id="delete-user"')"
check "la página sugiere suspender" 1 "$(curl -s -b $ADMIN_JAR $B/admin/users/$FAM_ID | grep -c 'información financiera')"
check "eliminar cuenta con datos: rechazado" 409 "$(del $FAM_ID "$O" $ADMIN_JAR)"
check "la cuenta con datos sigue existiendo" 1 "$(d1_n "SELECT count(*) AS n FROM user WHERE id='$FAM_ID'")"
check "y conserva su espacio y su cuenta" 1 "$(d1_n "SELECT count(*) AS n FROM accounts WHERE workspace_id='$FAM_WS'")"
check "pero sí se puede suspender" 200 "$(admin_user_action ban-user "$FAM_ID")"

echo "10) Cerrar sesión"
check "sign-out" 200 "$(post "$ADMIN_JAR" sign-out '{}' | status)"
check "GET /admin tras sign-out redirige" "/login" "$(loc -b $ADMIN_JAR $B/admin)"

rm -rf "$DIR"
[ -z "$FAIL" ] && echo "TODO OK" || { echo "HAY FALLOS"; exit 1; }
