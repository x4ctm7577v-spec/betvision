# BetVision (100xBajo): cómo ponerlo en línea

BetVision consulta las cuotas de muchas casas con The Odds API, les quita el margen para calcular la probabilidad real (consenso del mercado), marca dónde hay valor y arma los parlays recomendados. Se actualiza solo.

## Archivos
- `server.js`: el servidor. Busca las cuotas, calcula probabilidades y valor.
- `index.html`: la app que ves en el teléfono.
- `package.json`: le dice al hosting cómo arrancar.

## Paso 1. Sube los archivos a GitHub (gratis)
1. Crea una cuenta en github.com.
2. Toca **New repository**, ponle de nombre `betvision` y márcalo como **Private**.
3. Toca **uploading an existing file** y sube los 4 archivos del zip: `server.js`, `index.html`, `package.json` y `LEEME.md`.
4. Toca **Commit changes**.

## Paso 2. Publica el servidor en Render (tiene plan gratis)
1. Crea una cuenta en render.com y conéctala con tu GitHub.
2. Toca **New +** y luego **Web Service**, y elige el repositorio `betvision`.
3. Configura:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
4. En **Environment Variables** agrega:
   - `ODDS_API_KEY`: tu clave de The Odds API (aquí va la clave, nunca en el chat ni en GitHub)
   - `MY_BOOK`: `hardrockbet` (la clave de tu casa en The Odds API; revisa la lista de casas en su documentación)
   - `SPORTS`: `baseball_mlb,americanfootball_nfl`
   - `REFRESH_MIN`: `180`
5. Toca **Create Web Service**. En unos minutos te da un enlace como `https://betvision.onrender.com`.

## Paso 3. Instálala en tu teléfono
Abre el enlace en Safari, toca **Compartir** y luego **Agregar a pantalla de inicio**. Queda como una app con su ícono.

## Créditos de The Odds API
Cada actualización gasta 1 crédito por deporte. Con 2 deportes cada 180 minutos son unos 480 créditos al mes, lo que cabe en el plan gratis. Si pagas el plan de 30 dólares, baja `REFRESH_MIN` a 30 y agrega deportes.

Deportes disponibles para `SPORTS` (separados por comas):
- `baseball_mlb` (MLB)
- `americanfootball_nfl` (NFL)
- `icehockey_nhl` (NHL)
- `basketball_nba` (NBA)
- `soccer_spain_la_liga` (LaLiga)
- `soccer_epl` (Premier League)
- `soccer_mexico_ligamx` (Liga MX)

## Notas
- En el plan gratis de Render el servidor se duerme si nadie lo usa; la primera carga puede tardar unos 30 segundos.
- Si tu casa no aparece en los datos, la app te avisa y calcula el valor con la mejor cuota disponible.
- Juego responsable: 1-800-GAMBLER.
