const http = require("http");
const https = require("https");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || "https:/hydropwr.app";
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
        birthday TEXT,
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
      ALTER TABLE athletes ADD COLUMN IF NOT EXISTS birthday TEXT;
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
    "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json",
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

function calcSweatMetrics(fluidLoss, durationSec, tempC, hr, hrMax, avgLoss) {
  const sweatRate = fluidLoss / (durationSec / 3600);
  const sweatVsAverage = avgLoss ? Math.round(((fluidLoss - avgLoss) / avgLoss) * 100) : null;
  const hrPct = (hr && hrMax) ? Math.round((hr / hrMax) * 100) : null;
  const confidence = (tempC !== null && hr !== null) ? "HIGH" : (tempC !== null || hr !== null) ? "MEDIUM" : "LOW";

  return {
    lossL: (fluidLoss / 1000).toFixed(1),
    rateL: sweatRate.toFixed(1),
    sweatVsAverage,
    tempC,
    hr: hr ? Math.round(hr) : null,
    hrPct,
    durationH: durationSec / 3600,
    confidence
  };
}

function getComparison(metrics) {
  if (metrics.sweatVsAverage === null) return null;
  const pct = metrics.sweatVsAverage;
  const sign = pct > 0 ? "+" : "";
  return pct > 0
    ? `📈 ${sign}${pct}% vs your 30-day average`
    : `✅ ${sign}${pct}% vs your 30-day average`;
}

function getCauseInsight(metrics) {
  const causeRules = [
    {
      priority: 100,
      condition: metrics.confidence !== "LOW" && metrics.tempC > 30,
      text: "🌡️ Heat was the main driver"
    },
    {
      priority: 90,
      condition: metrics.confidence !== "LOW" && metrics.tempC > 24 && metrics.hrPct > 75,
      text: "🌡️ Heat & intensity combined"
    },
    {
      priority: 80,
      condition: metrics.hrPct !== null && metrics.hrPct > 85,
      text: "❤️ High intensity drove sweat loss"
    },
    {
      priority: 70,
      condition: metrics.durationH > 3,
      text: "⏱️ Long duration accumulated fluid loss"
    }
  ];

  const match = causeRules
    .filter(r => r.condition)
    .sort((a, b) => b.priority - a.priority)[0];

  return match ? match.text : null;
}

function getActionInsight(metrics, hardSessions) {
  const actionRules = [
    {
      priority: 100,
      condition: parseFloat(metrics.rateL) > 1.0,
      text: "🧂 Consider replacing electrolytes"
    },
    {
      priority: 80,
      condition: hardSessions >= 3,
      text: "⚡ Prioritize recovery today"
    },
    {
      priority: 60,
      condition: metrics.sweatVsAverage !== null && metrics.sweatVsAverage > 30,
      text: "💧 Prioritize hydration today"
    }
  ];

  const match = actionRules
    .filter(r => r.condition)
    .sort((a, b) => b.priority - a.priority)[0];

  return match ? match.text : null;
}

function buildCardText(cardData) {
  const lines = [
    `💧 Est. sweat loss: ${cardData.loss}L · ${cardData.rate}L/h`,
    cardData.comparison,
    cardData.cause,
    cardData.action
  ].filter(Boolean);

  return lines.join("\n") + "\n\nHydroPwr.app";
}

async function buildCard(athleteId, currentLoss, durationSec, tempC, hr, elevationM) {
  // Get history
  const result = await pool.query(
    "SELECT fluid_loss_ml, recorded_at FROM activities WHERE athlete_id = $1 AND recorded_at > NOW() - INTERVAL '30 days' ORDER BY recorded_at DESC LIMIT 20",
    [String(athleteId)]
  );
  const history = result.rows;
  const avgLoss = history.length > 0
    ? Math.round(history.reduce((s, r) => s + r.fluid_loss_ml, 0) / history.length)
    : null;
  const hardSessions = history.filter(r => {
    const days = (Date.now() - new Date(r.recorded_at)) / 86400000;
    return days <= 5 && r.fluid_loss_ml > 600;
  }).length;

  // Get HRmax
  const athleteResult = await pool.query(
    "SELECT birthday FROM athletes WHERE id = $1",
    [String(athleteId)]
  );
  const birthday = athleteResult.rows[0]?.birthday;
  const age = birthday ? Math.floor((Date.now() - new Date(birthday)) / (365.25 * 24 * 3600 * 1000)) : null;
  const hrMaxFormula = age ? 220 - age : null;
  const maxHrResult = await pool.query(
    "SELECT MAX(max_heartrate) as max_hr FROM activities WHERE athlete_id = $1 AND recorded_at > NOW() - INTERVAL '90 days'",
    [String(athleteId)]
  );
  const hrMax = maxHrResult.rows[0]?.max_hr || hrMaxFormula;

  // Calculate metrics
  const metrics = calcSweatMetrics(currentLoss, durationSec, tempC, hr, hrMax, avgLoss);

  // Build card data
  const cardData = {
    loss: metrics.lossL,
    rate: metrics.rateL,
    comparison: getComparison(metrics),
    cause: getCauseInsight(metrics),
    action: getActionInsight(metrics, hardSessions)
  };

  return buildCardText(cardData);
}
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
      [String(activityId), String(athleteId), fluidLoss, durationSec, distanceM, hr ? Math.round(hr) : null, elevationM ? Math.round(elevationM) : null, tempC, activity.sport_type]
      );

      // Build card
      const message = await buildCard(athleteId, fluidLoss, durationSec, tempC, hr, elevationM);

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
  if (req.url === "/legal" && req.method === "GET") {
  const fs = require("fs");
  const html = fs.readFileSync("./legal.html", "utf8");
  if (res.headersSent) return;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
  return;
}
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
        `INSERT INTO athletes (id, firstname, access_token, refresh_token, expires_at, birthday) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET access_token=$3, refresh_token=$4, expires_at=$5`, birthday=$6,
        [token.athlete.id, token.athlete.firstname, token.access_token, token.refresh_token, token.expires_at, token.athlete.birthday || null]
      );
      const key = Math.random().toString(36).substring(2, 10);
      tokens[key] = { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at, athlete: token.athlete };
      send(res, 200, `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>HydroPwr – Verbunden!</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: #060d18; color: #f0f6ff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 380px; width: 100%; text-align: center; }
    .emoji { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 28px; font-weight: 700; color: #22d3ee; margin-bottom: 8px; }
    .greeting { font-size: 20px; font-weight: 500; margin-bottom: 32px; }
    .box { background: #111e30; border: 1px solid rgba(34,211,238,0.15); border-radius: 16px; padding: 20px; margin-bottom: 16px; text-align: left; }
    .box-title { font-size: 12px; font-weight: 600; color: #22d3ee; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; }
    .check { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; font-size: 15px; color: #8aa8c0; line-height: 1.5; }
    .check:last-child { margin-bottom: 0; }
    .fact { font-size: 15px; color: #8aa8c0; line-height: 1.6; }
    .fact strong { color: #f0f6ff; }
    .btn-strava { display: block; background: #FC4C02; color: white; font-weight: 700; font-size: 16px; padding: 16px; border-radius: 12px; text-decoration: none; margin-bottom: 12px; transition: opacity 0.2s; }
    .btn-strava:hover { opacity: 0.85; }
    .btn-share { display: block; background: #111e30; border: 1px solid rgba(34,211,238,0.3); color: #22d3ee; font-weight: 600; font-size: 15px; padding: 14px; border-radius: 12px; text-decoration: none; cursor: pointer; transition: background 0.2s; }
    .btn-share:hover { background: rgba(34,211,238,0.1); }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">💧</div>
    <h1>HydroPwr</h1>
    <p class="greeting">Hallo, ${token.athlete?.firstname}! 👋</p>

    <div class="box">
      <div class="box-title">✅ Ab jetzt automatisch</div>
      <div class="check"><span>🏃</span><span>Nach jedem Training über 10 Min analysiert HydroPwr deine Aktivität</span></div>
      <div class="check"><span>🌡️</span><span>Temperatur, Herzfrequenz und Höhenprofil werden einberechnet</span></div>
      <div class="check"><span>📝</span><span>Deine persönliche Hydrations-Empfehlung erscheint direkt in Strava</span></div>
    </div>

    <div class="box" style="margin-bottom:32px">
      <div class="box-title">💡 Wusstest du?</div>
      <p class="fact">Bei <strong>28°C</strong> verlierst du beim Radfahren bis zu <strong>1.8L pro Stunde</strong> – mehr als die meisten trinken. HydroPwr erinnert dich genau dann daran.</p>
    </div>

    <a class="btn-strava" href="https://www.strava.com/athlete/training">Strava öffnen 🏆</a>
    <button class="btn-share" onclick="navigator.share ? navigator.share({title:'HydroPwr',text:'Automatische Hydrations-Empfehlungen nach jedem Strava-Training 💧',url:'https://hydropwr.app'}) : navigator.clipboard.writeText('https://hydropwr.app').then(()=>this.textContent='✅ Link kopiert!')">
      HydroPwr teilen 🔗
    </button>
  </div>
</body>
</html>`);
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
  // Reset webhook
if (req.url === "/reset-webhook" && req.method === "GET") {
  const https2 = require("https");
  // First get existing subscription
  const reqG = https2.request({
    hostname: "www.strava.com",
    path: `/api/v3/push_subscriptions?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
    method: "GET"
  }, (resG) => {
    let raw = "";
    resG.on("data", c => raw += c);
    resG.on("end", () => {
      const subs = JSON.parse(raw);
      send(res, 200, subs);
    });
  });
  reqG.on("error", (e) => send(res, 500, { error: e.message }));
  reqG.end();
  return;
}
  // Delete und neu registrieren
if (req.url === "/fix-webhook" && req.method === "GET") {
  const reqD = https.request({
    hostname: "www.strava.com",
    path: `/api/v3/push_subscriptions/353383?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
    method: "DELETE"
  }, (resD) => {
    resD.on("end", () => {
      // Neu registrieren
      const data = JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        callback_url: `${BACKEND_URL}/webhook`,
        verify_token: WEBHOOK_VERIFY_TOKEN
      });
      const reqN = https.request({
        hostname: "www.strava.com",
        path: "/api/v3/push_subscriptions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
      }, (resN) => {
        let raw = "";
        resN.on("data", c => raw += c);
        resN.on("end", () => send(res, 200, JSON.parse(raw)));
      });
      reqN.on("error", (e) => send(res, 500, { error: e.message }));
      reqN.write(data);
      reqN.end();
    });
    resD.resume();
  });
  reqD.on("error", (e) => send(res, 500, { error: e.message }));
  reqD.end();
  return;
}
  // Manuell Aktivität verarbeiten
if (req.url.startsWith("/process/") && req.method === "GET") {
  const parts = req.url.split("/");
  const athleteId = parts[2];
  const activityId = parts[3];
  processActivity(athleteId, activityId);
  return send(res, 200, { status: "processing", athleteId, activityId });
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
