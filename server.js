const http = require("http");
const https = require("https");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || "https://abundant-surprise-production-b13d.up.railway.app";
const WEBHOOK_VERIFY_TOKEN = "hydrocoach_webhook_2024";

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Init DB tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS athletes (
        id BIGINT PRIMARY KEY,
        firstname TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at BIGINT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS activities (
        id BIGINT PRIMARY KEY,
        athlete_id BIGINT,
        fluid_loss_ml INT,
        duration_seconds INT,
        distance_m FLOAT,
        heartrate INT,
        elevation_m FLOAT,
        temp_c FLOAT,
        sport_type TEXT,
        recorded_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("DB ready");
  } catch(e) {
    console.error("DB init error:", e.message);
    console.log("Server laeuft ohne DB");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const tokens = {};

function send(res, status, body) {
  if (res.headersSent) return;
  const isHtml = typeof body === "string";
  res.writeHead(status, {
    "Content-Type": isHtml ? "text/html" : "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(isHtml ? body : JSON.stringify(body));
}

function stravaPost(body, callback) {
  const data = JSON.stringify(body);
  const req = https.request({
    hostname: "www.strava.com", path: "/oauth/token", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
  }, (res) => {
    let raw = "";
    res.on("data", c => raw += c);
    res.on("end", () => { try { callback(null, JSON.parse(raw)); } catch(e) { callback(e); } });
  });
  req.on("error", callback);
  req.write(data);
  req.end();
}

function stravaGet(path, token, callback) {
  const req = https.request({
    hostname: "www.strava.com", path, method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  }, (res) => {
    let raw = "";
    res.on("data", c => raw += c);
    res.on("end", () => { try { callback(null, JSON.parse(raw)); } catch(e) { callback(e); } });
  });
  req.on("error", callback);
  req.end();
}

function stravaPut(activityId, token, description, callback) {
  const data = JSON.stringify({ description });
  const req = https.request({
    hostname: "www.strava.com", path: `/api/v3/activities/${activityId}`, method: "PUT",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
  }, (res) => {
    let raw = "";
    res.on("data", c => raw += c);
    res.on("end", () => { try { callback(null, JSON.parse(raw)); } catch(e) { callback(e); } });
  });
  req.on("error", callback);
  req.write(data);
  req.end();
}

async function fetchWeather(lat, lon, dateIso) {
  return new Promise((resolve) => {
    const dateStr = dateIso.slice(0, 10);
    const hour = parseInt(dateIso.slice(11, 13)) || 12;
    const today = new Date().toISOString().slice(0, 10);
    const isHistorical = dateStr < today;
    const host = isHistorical ? "archive-api.open-meteo.com" : "api.open-meteo.com";
    const path = isHistorical
      ? `/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&hourly=temperature_2m&timezone=auto`
      : `/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`;
    https.get(`https://${host}${path}`, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(raw);
          const temp = isHistorical ? d.hourly?.temperature_2m?.[hour] : d.current?.temperature_2m;
          resolve(temp ?? null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// ── Fluid Loss Calculation ────────────────────────────────────────────────────
function calcFluidLoss(durationSec, heartrate, tempC, elevationM) {
  const hours = durationSec / 3600;
  const hr = heartrate || 140;
  const temp = tempC ?? 18;
  const elev = elevationM || 0;
  const baseRate = 600; // ml/hour base sweat rate
  const intensityFactor = hr > 170 ? 1.5 : hr > 155 ? 1.3 : hr > 140 ? 1.15 : 1.0;
  const tempFactor = temp > 28 ? 1.4 : temp > 23 ? 1.2 : temp > 18 ? 1.05 : temp < 10 ? 0.85 : 1.0;
  const elevFactor = elev > 400 ? 1.15 : elev > 200 ? 1.07 : 1.0;
  const raw = hours * baseRate * intensityFactor * tempFactor * elevFactor;
  return Math.max(150, Math.round(raw / 50) * 50);
}

// ── Card Logic ────────────────────────────────────────────────────────────────
async function buildCard(athleteId, currentLoss, durationSec, tempC, hr) {
  // Get last 30 days of activities for comparison
  const result = await pool.query(
    "SELECT fluid_loss_ml, recorded_at FROM activities WHERE athlete_id = $1 AND recorded_at > NOW() - INTERVAL '30 days' ORDER BY recorded_at DESC LIMIT 20",
    [athleteId]
  );
  const history = result.rows;
  const avgLoss = history.length > 0
    ? Math.round(history.reduce((s, r) => s + r.fluid_loss_ml, 0) / history.length)
    : null;
  const maxLoss14d = history.filter(r => {
    const days = (Date.now() - new Date(r.recorded_at)) / 86400000;
    return days <= 14;
  }).reduce((m, r) => Math.max(m, r.fluid_loss_ml), 0);
  const recentIntense = history.filter(r => {
    const days = (Date.now() - new Date(r.recorded_at)) / 86400000;
    return days <= 5 && r.fluid_loss_ml > 600;
  }).length;

  const lossL = (currentLoss / 1000).toFixed(1);
  const drinkMl = Math.round(currentLoss * 1.25 / 50) * 50;
  const drinkL = (drinkMl / 1000).toFixed(1);
  const needsElectrolytes = currentLoss > 700 || (tempC ?? 0) > 25 || durationSec > 5400;

  // Determine card type
  let cardType = "standard";
  if (currentLoss === maxLoss14d && history.length >= 3) cardType = "peak";
  else if (tempC > 25 && hr > 150) cardType = "heat";
  else if (recentIntense >= 2) cardType = "fatigue";

  // Comparison text
  let comparison = "";
  if (avgLoss && history.length >= 3) {
    const diff = currentLoss - avgLoss;
    const pct = Math.abs(Math.round((diff / avgLoss) * 100));
    if (Math.abs(diff) < 100) comparison = "Typisch für dich";
    else if (diff > 0) comparison = pct > 30 ? "Deutlich mehr als üblich" : "Etwas mehr als üblich";
    else comparison = pct > 30 ? "Deutlich weniger als üblich" : "Etwas weniger als üblich";
  }

  // Ampel
  const ampel = currentLoss > 1200 ? "🔴" : currentLoss > 600 ? "🟡" : "🟢";
  const load = currentLoss > 1200 ? "Hohe Belastung" : currentLoss > 600 ? "Mittlere Belastung" : "Geringe Belastung";

  // Build message based on card type
  let msg = "";

  if (cardType === "peak") {
    msg = `💧 ${lossL}L Flüssigkeitsverlust
📈 Höchster Wert der letzten 14 Tage

${ampel} ${load} – heute auf Erholung achten
👉 Trink ${drinkL}L – Flüssigkeit & Ruhe priorisieren${needsElectrolytes ? "\n💡 Elektrolyte empfohlen" : ""}

HydroPwr`;
  } else if (cardType === "heat") {
    msg = `💧 ${lossL}L Flüssigkeitsverlust
🌡️ Hitze hat den Verlust deutlich erhöht${comparison ? `\n${comparison}` : ""}

${ampel} ${load} – erhöhte Belastung durch Hitze
👉 Trink ${drinkL}L in den nächsten 2h
💡 Elektrolyte empfohlen

HydroPwr`;
  } else if (cardType === "fatigue") {
    msg = `💧 ${lossL}L Flüssigkeitsverlust
📊 ${recentIntense + 1}. intensive Einheit in 5 Tagen${comparison ? `\n${comparison}` : ""}

${ampel} Erhöhte Gesamtbelastung
👉 Recovery priorisieren
💡 Flüssigkeit & Schlaf besonders wichtig

HydroPwr`;
  } else {
    msg = `💧 ${lossL}L Flüssigkeitsverlust${comparison ? `\n${comparison}` : ""}

${ampel} ${load}
👉 Trink ${drinkL}L heute${needsElectrolytes ? "\n💡 Elektrolyte optional" : ""}

HydroPwr`;
  }

  return msg;
}

// ── Token Management ──────────────────────────────────────────────────────────
async function getValidToken(athleteId) {
  const result = await pool.query("SELECT * FROM athletes WHERE id = $1", [athleteId]);
  if (result.rows.length === 0) return null;
  const athlete = result.rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (athlete.expires_at > now + 300) return athlete.access_token;
  // Refresh token
  return new Promise((resolve) => {
    stravaPost({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: athlete.refresh_token, grant_type: "refresh_token"
    }, async (err, token) => {
      if (err || !token.access_token) { resolve(null); return; }
      await pool.query(
        "UPDATE athletes SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE id=$4",
        [token.access_token, token.refresh_token, token.expires_at, athleteId]
      );
      resolve(token.access_token);
    });
  });
}

// ── Webhook Processing ────────────────────────────────────────────────────────
async function processActivity(athleteId, activityId) {
  try {
    const token = await getValidToken(athleteId);
    if (!token) { console.log("No token for athlete", athleteId); return; }

    // Get activity details
    stravaGet(`/api/v3/activities/${activityId}`, token, async (err, activity) => {
      if (err || !activity.id) { console.log("Error fetching activity:", err); return; }

      const durationSec = activity.moving_time || 0;
      const hr = activity.average_heartrate || null;
      const elevationM = activity.total_elevation_gain || 0;
      const distanceM = activity.distance || 0;
      const lat = activity.start_latlng?.[0] || null;
      const lon = activity.start_latlng?.[1] || null;
      const dateIso = activity.start_date_local || new Date().toISOString();

      // Skip very short activities
      if (durationSec < 600) { console.log("Activity too short, skipping"); return; }

      // Fetch weather
      let tempC = null;
      if (lat && lon) tempC = await fetchWeather(lat, lon, dateIso);

      // Calculate fluid loss
      const fluidLoss = calcFluidLoss(durationSec, hr, tempC, elevationM);

      // Save to DB
      await pool.query(
        `INSERT INTO activities (id, athlete_id, fluid_loss_ml, duration_seconds, distance_m, heartrate, elevation_m, temp_c, sport_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      [String(activityId), String(athleteId), fluidLoss, durationSec, distanceM, hr, elevationM, tempC, activity.sport_type]
      );

      // Build card
      const message = await buildCard(athleteId, fluidLoss, durationSec, tempC, hr);

      // Post to Strava
      stravaPut(activityId, token, message, (err, result) => {
        if (err) console.log("Error posting to Strava:", err);
        else console.log("Posted to activity", activityId);
      });
    });
  } catch (e) {
    console.error("processActivity error:", e);
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }

  // Health check
if (req.url === "/" && req.method === "GET") {
  const fs = require("fs");
  const html = fs.readFileSync("./landing.html", "utf8");
  if (res.headersSent) return;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
  return;
}

  // Webhook verification (GET)
  if (req.url.startsWith("/webhook") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
      console.log("Webhook verified");
      return send(res, 200, { "hub.challenge": challenge });
    }
    return send(res, 403, { error: "Forbidden" });
  }

  // Webhook event (POST)
  if (req.url === "/webhook" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      send(res, 200, { status: "ok" }); // Respond immediately
      try {
        const event = JSON.parse(body);
        console.log("Webhook event:", event.object_type, event.aspect_type, event.object_id);
        if (event.object_type === "activity" && event.aspect_type === "create") {
          processActivity(event.owner_id, event.object_id);
        }
      } catch(e) { console.error("Webhook parse error:", e); }
    });
    return;
  }

  // OAuth callback
  if (req.url.startsWith("/callback") && req.method === "GET") {
    const code = new URL(req.url, "http://localhost").searchParams.get("code");
    if (!code) return send(res, 400, { error: "Kein Code" });
    stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code" }, async (err, token) => {
      if (err || token.errors) return send(res, 200, "<html><body style='background:#080f1e;color:white;text-align:center;padding:40px;font-family:sans-serif'><h2>❌ Login fehlgeschlagen</h2></body></html>");
      // Save athlete
      await pool.query(
        `INSERT INTO athletes (id, firstname, access_token, refresh_token, expires_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET access_token=$3, refresh_token=$4, expires_at=$5`,
        [token.athlete.id, token.athlete.firstname, token.access_token, token.refresh_token, token.expires_at]
      );
      const key = Math.random().toString(36).substring(2, 10);
      tokens[key] = { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at, athlete: token.athlete };
      send(res, 200, `<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#080f1e;color:white">
  <div style="font-size:60px;margin-bottom:16px">💧</div>
  <h1 style="color:#22d3ee;margin-bottom:4px">HydroCoach</h1>
  <h2 style="font-weight:400;margin-bottom:8px">Hallo, ${token.athlete?.firstname}! 👋</h2>
  <p style="color:#475569;margin-bottom:24px">Strava verbunden. HydroCoach postet nach jedem Training automatisch.</p>
  <div style="background:#131929;border:1px solid rgba(34,211,238,0.3);border-radius:16px;padding:20px;max-width:300px;margin:0 auto 24px">
    <p style="color:#22d3ee;font-size:13px;margin:0 0 8px">Dein Login-Code:</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:0 0 8px;color:white">${key}</p>
    <p style="color:#475569;font-size:12px;margin:0">Gib diesen Code in der App ein</p>
  </div>
  <button onclick="navigator.clipboard.writeText('${key}').then(()=>this.textContent='✅ Kopiert!')"
    style="background:linear-gradient(135deg,#0ea5e9,#22d3ee);border:none;border-radius:12px;color:#020c18;font-size:16px;font-weight:bold;padding:14px 32px;cursor:pointer">
    Code kopieren 📋
  </button>
</body></html>`);
    });
    return;
  }

  // Get token by key
  if (req.url.startsWith("/token/") && req.method === "GET") {
    const key = req.url.split("/token/")[1];
    const token = tokens[key];
    if (!token) return send(res, 404, { error: "Token nicht gefunden" });
    const result = { ...token };
    delete tokens[key];
    return send(res, 200, result);
  }

  // Refresh token
  if (req.url === "/refresh" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch(e) {}
      stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: parsed.refresh_token, grant_type: "refresh_token" }, (err, token) => {
        if (err) return send(res, 500, { error: err.message });
        send(res, 200, { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at });
      });
    });
    return;
  }
// Setup: Webhook bei Strava registrieren
if (req.url === "/setup" && req.method === "GET") {
  const data = JSON.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    callback_url: `${BACKEND_URL}/webhook`,
    verify_token: WEBHOOK_VERIFY_TOKEN
  });
  const reqS = https.request({
    hostname: "www.strava.com",
    path: "/api/v3/push_subscriptions",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
  }, (resS) => {
    let raw = "";
    resS.on("data", c => raw += c);
    resS.on("end", () => send(res, 200, JSON.parse(raw)));
  });
  reqS.on("error", (e) => send(res, 500, { error: e.message }));
  reqS.write(data);
  reqS.end();
  return;
}
  send(res, 404, { error: "Nicht gefunden" });

}).listen(PORT, "0.0.0.0", () => {
  console.log("HydroCoach Port " + PORT);
  setTimeout(() => initDB(), 3000);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled:", err);
});
