# BetVision (100xBajo), Fase 1: cuentas, suscripción de $99 y registro de apuestas

## Qué hay de nuevo
- Cuentas de usuario con correo y contraseña, con confirmación de 21 años o más.
- Plan gratis: partidos y probabilidades.
- Premium ($99 al mes, 7 días gratis): valor de cada cuota, cuota justa, parlays recomendados, registro de apuestas con CLV y tamaño de apuesta sugerido.
- Las apuestas registradas se califican solas al terminar el partido.

## Archivos
- `server.js`, `index.html` y `package.json`: reemplazan a los anteriores en GitHub.
- `supabase.sql`: se pega una sola vez en Supabase (paso A).

---

## A. Supabase (cuentas y base de datos, gratis)
1. Entra a supabase.com, crea una cuenta y toca **New project**. Nombre: `betvision`. Región: **East US**. Guarda la contraseña que pongas.
2. En el menú, abre **SQL Editor**, pega todo el contenido de `supabase.sql` y toca **Run**.
3. Abre **Authentication**, luego **URL Configuration**, y en **Site URL** pon tu enlace de Render (por ejemplo `https://betvision.onrender.com`).
4. Abre **Project Settings** y luego **API**. Copia tres cosas:
   - **Project URL**
   - La clave **anon public**
   - La clave **service_role**. Esta es secreta: nunca la compartas ni la subas a GitHub.

## B. Stripe (cobros)
Empieza en **modo de prueba** (Test mode). Así nadie paga de verdad mientras pruebas.
1. Crea tu cuenta en stripe.com. Describe el negocio con honestidad: "software de análisis deportivo por suscripción; no acepta apuestas ni da premios".
2. Abre **Product catalog** y toca **Add product**:
   - Nombre: `BetVision Premium`
   - Precio: **$99**, **Recurring**, **Monthly**
   Guarda y copia el **Price ID** (empieza con `price_`).
3. Abre **Developers**, luego **API keys**, y copia la **Secret key** (empieza con `sk_test_`).
4. Abre **Developers**, luego **Webhooks**, y toca **Add endpoint**:
   - URL: `https://TU-ENLACE.onrender.com/api/stripe-webhook`
   - Eventos: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` y `customer.subscription.deleted`
   Guarda y copia el **Signing secret** (empieza con `whsec_`).
5. Abre **Settings**, luego **Billing** y luego **Customer portal**, y actívalo con la opción de cancelar. Así tus clientes pueden cancelar solos.

## C. Render (variables nuevas)
En tu servicio, abre **Environment**, agrega estas filas y toca **Save Changes**:

| NAME | VALUE |
|---|---|
| APP_URL | tu enlace de Render, por ejemplo `https://betvision.onrender.com` |
| SUPABASE_URL | Project URL de Supabase |
| SUPABASE_ANON_KEY | clave anon public |
| SUPABASE_SERVICE_KEY | clave service_role |
| STRIPE_SECRET_KEY | clave `sk_test_...` |
| STRIPE_PRICE_ID | `price_...` |
| STRIPE_WEBHOOK_SECRET | `whsec_...` |

Las que ya tenías (`ODDS_API_KEY` y `MY_BOOK`) se quedan igual.

## D. GitHub
En tu repositorio, toca **Add file**, luego **Upload files**, y sube `server.js`, `index.html`, `package.json`, `supabase.sql` y este `LEEME.md`. Cuando se te pregunte, reemplaza los que ya existen y toca **Commit changes**. Render se actualiza solo en unos minutos.

## E. Prueba todo
1. Abre la app, ve a **Cuenta** y crea una cuenta. Confírmala desde el correo que te llega.
2. Toca **Probar 7 días gratis**. En la pantalla de Stripe usa la tarjeta de prueba `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC.
3. Al volver, la app debe decir **Prueba Premium activa** y mostrar el valor de cada cuota.
4. Registra una apuesta de prueba y revisa la pestaña **Apuestas**.

Cuando todo funcione y Stripe apruebe tu cuenta, cambia las dos claves de Stripe por las reales (`sk_live_...` y el `whsec_` de un webhook en modo real) y crea el producto también en modo real.

## Antes de cobrar de verdad
- **Render:** el plan gratis se duerme, y entonces la línea de cierre y la calificación de apuestas se retrasan. Con clientes que pagan, usa el plan de pago básico.
- **The Odds API:** con clientes, sube al plan de pago y pon `REFRESH_MIN` en `30` para que el CLV sea preciso.
- **Legal:** consulta con un abogado sobre los términos de servicio, la edad mínima y los avisos. Nunca prometas ganancias.

---

## F. Referidos: ganar comisión con las casas de apuestas

### 1. Actualiza Supabase (una sola vez)
Si ya corriste `supabase.sql` antes, abre **SQL Editor**, pega solo esto y toca **Run**:

```sql
alter table profiles add column if not exists state text;
alter table profiles add column if not exists book text;
create table if not exists clicks (
  id bigint generated always as identity primary key,
  book text, kind text, user_id uuid, created_at timestamptz default now()
);
alter table clicks enable row level security;
```

En la tabla `clicks` verás cada vez que alguien toca un enlace tuyo.

### 2. Consigue tus enlaces de afiliado
Solicita entrar al programa de afiliados de cada casa (busca "nombre de la casa affiliate program"). Cuando te aprueben te dan un enlace personal. En sus términos revisa tres cosas:
- En qué estados puedes promocionarla.
- Si te pagan por cliente nuevo o un porcentaje de lo que pierden los clientes.
- Si te dan un enlace que lleve directo a una jugada, con tu código incluido.

### 3. Agrega la variable AFFILIATES en Render
Name: `AFFILIATES`. Value: una lista como esta, en una sola línea, cambiando los enlaces por los tuyos:

```
[{"key":"hardrockbet","name":"Hard Rock Bet","url":"https://TU-ENLACE-DE-AFILIADO","deeplink":"","offer":"","states":["FL"]}]
```

- `key`: el código de la casa en The Odds API (`hardrockbet`, `fanduel`, `draftkings`, `betmgm`, `caesars`…).
- `url`: tu enlace para abrir cuenta.
- `deeplink`: déjalo vacío, salvo que el programa te dé una plantilla para enlazar a una jugada; en ese caso escríbela con `{url}` donde va la dirección de la jugada.
- `offer`: el bono de bienvenida, escrito tal como lo publica la casa. Déjalo vacío si no estás seguro.
- `states`: los estados donde la casa es legal y el programa te permite promocionarla.

Para agregar otra casa, sepárala con una coma dentro de los corchetes: `[{...},{...}]`.

**Importante:** consulta a tu abogado antes de activar los referidos. Algunos estados exigen que los afiliados de apuestas se registren con el regulador.
