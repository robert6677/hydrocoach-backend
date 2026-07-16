"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const { Pool } = require("pg");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || "https://hydropwr.app";
const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN || "hydrocoach_webhook_2024";
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

const TOKEN_TTL_MS = 10 * 60 * 1000;

// ── Static Files ──────────────────────────────────────────────────────────────
let landingHtml = "<html><body><h1>HydroPwr</h1></body></html>";
let legalHtml = "<html><body><h1>Legal</h1></body></html>";

try {
  if (fs.existsSync("./landing.html")) {
    landingHtml = fs.readFileSync("./landing.html", "utf8");
  }
} catch (e) {
  console.error("Failed to load landing.html:", e.message);
}

try {
  if (fs.existsSync("./legal.html")) {
    legalHtml = fs.readFileSync("./legal.html", "utf8");
  }
} catch (e) {
  console.error("Failed to load legal.html:", e.message);
}

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL missing - DB features are disabled");
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS athletes (
        id BIGINT PRIMARY KEY,
        firstname TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at BIGINT,
        birthday DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS activities (
        id BIGINT PRIMARY KEY,
        athlete_id BIGINT,
        fluid_loss_ml INT,
        duration_seconds INT,
        distance_m DOUBLE PRECISION,
        heartrate INT,
        max_heartrate INT,
        elevation_m DOUBLE PRECISION,
        temp_c DOUBLE PRECISION,
        sport_type TEXT,
        activity_date TIMESTAMP,
        recorded_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE athletes
        ADD COLUMN IF NOT EXISTS birthday DATE;

      ALTER TABLE activities
        ADD COLUMN IF NOT EXISTS max_heartrate INT;

      ALTER TABLE activities
        ADD COLUMN IF NOT EXISTS activity_date TIMESTAMP;
    `);

    console.log("DB ready");
  } catch (e) {
    console.error("DB init error:", e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const tokens = Object.create(null);

function cleanupTokens() {
  const now = Date.now();
  for (const key of Object.keys(tokens)) {
    if (!tokens[key] || now - tokens[key].created_at > TOKEN_TTL_MS) {
      delete tokens[key];
    }
  }
}

setInterval(cleanupTokens, 60 * 1000).unref();

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
  res.end(html);
}

function parseJsonSafe(input, fallback = null) {
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isAdminAuthorized(req) {
  if (!ADMIN_SECRET) return true;
  return req.headers["x-admin-secret"] === ADMIN_SECRET;
}

function requireAdmin(req, res) {
  if (!isAdminAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function httpsRequestJson({
  hostname,
  path,
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = 15000
}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data)
              }
            : {}),
          ...headers
        }
      },
      res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          const parsed = parseJsonSafe(raw, null);

          if (res.statusCode >= 400) {
            const msg =
              parsed?.message ||
              parsed?.errors?.[0]?.message ||
              raw ||
              `HTTP ${res.statusCode}`;
            const err = new Error(msg);
            err.statusCode = res.statusCode;
            err.response = parsed ?? raw;
            return reject(err);
          }

          resolve({
            statusCode: res.statusCode,
            data: parsed
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", reject);

    if (data) req.write(data);
    req.end();
  });
}

// ── Strava API ────────────────────────────────────────────────────────────────
async function stravaPostToken(body) {
  const result = await httpsRequestJson({
    hostname: "www.strava.com",
    path: "/oauth/token",
    method: "POST",
    body
  });
  return result.data;
}

async function stravaGet(path, token) {
  const result = await httpsRequestJson({
    hostname: "www.strava.com",
    path,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return result.data;
}

async function stravaPutActivity(activityId, token, description) {
  const result = await httpsRequestJson({
    hostname: "www.strava.com",
    path: `/api/v3/activities/${activityId}`,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: { description }
  });
  return result.data;
}

async function stravaCreateWebhook() {
  const result = await httpsRequestJson({
    hostname: "www.strava.com",
    path: "/api/v3/push_subscriptions",
    method: "POST",
    body: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      callback_url: `${BACKEND_URL}/webhook`,
      verify_token: WEBHOOK_VERIFY_TOKEN
    }
  });
  return result.data;
}

async function stravaListWebhooks() {
  const path = `/api/v3/push_subscriptions?client_id=${encodeURIComponent(
    CLIENT_ID
  )}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;

  const result = await httpsRequestJson({
    hostname: "www.strava.com",
    path,
    method: "GET"
  });
  return result.data;
}

async function stravaDeleteWebhook(subscriptionId) {
  const path = `/api/v3/push_subscriptions/${subscriptionId}?client_id=${encodeURIComponent(
    CLIENT_ID
  )}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;

  const result = await httpsRequestJson({
    hostname: "www.strava.com",
    path,
    method: "DELETE"
  });
  return result.data;
}

// ── Weather ───────────────────────────────────────────────────────────────────
async function fetchWeather(lat, lon, dateIso) {
  try {
    const dateStr = dateIso.slice(0, 10);
    const hour = Math.max(0, Math.min(23, parseInt(dateIso.slice(11, 13), 10) || 12));
    const today = new Date().toISOString().slice(0, 10);
    const isHistorical = dateStr < today;

    const host = isHistorical
      ? "archive-api.open-meteo.com"
      : "api.open-meteo.com";

    const path = isHistorical
      ? `/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(
          lon
        )}&start_date=${encodeURIComponent(
          dateStr
        )}&end_date=${encodeURIComponent(
          dateStr
        )}&hourly=temperature_2m&timezone=auto`
      : `/v1/forecast?latitude=${encodeURIComponent(
          lat
        )}&longitude=${encodeURIComponent(
          lon
        )}&current=temperature_2m&timezone=auto`;

    const result = await httpsRequestJson({
      hostname: host,
      path,
      method: "GET",
      timeoutMs: 10000
    });

    const d = result.data;
    const temp = isHistorical
      ? d?.hourly?.temperature_2m?.[hour]
      : d?.current?.temperature_2m;

    return typeof temp === "number" ? temp : null;
  } catch (e) {
    console.warn("Weather fetch failed:", e.message);
    return null;
  }
}

// ── Fluid Loss Calculation ────────────────────────────────────────────────────
function calcFluidLoss(durationSec, heartrate, tempC, elevationM) {
  const hours = durationSec / 3600;
  const hr = heartrate || 140;
  const temp = tempC ?? 18;
  const elev = elevationM || 0;

  const baseRate = 600; // ml/h
  const intensityFactor =
    hr > 170 ? 1.5 :
    hr > 155 ? 1.3 :
    hr > 140 ? 1.15 :
    1.0;

  const tempFactor =
    temp > 28 ? 1.4 :
    temp > 23 ? 1.2 :
    temp > 18 ? 1.05 :
    temp < 10 ? 0.85 :
    1.0;

  const elevFactor =
    elev > 400 ? 1.15 :
    elev > 200 ? 1.07 :
    1.0;

  const raw = hours * baseRate * intensityFactor * tempFactor * elevFactor;
  return Math.max(150, Math.round(raw / 50) * 50);
}

// ── Card Logic ────────────────────────────────────────────────────────────────
function calcSweatMetrics(fluidLoss, durationSec, tempC, hr, hrMax, avgLoss) {
  const sweatRate = fluidLoss / (durationSec / 3600);
  const sweatVsAverage =
    avgLoss && avgLoss > 0
      ? Math.round(((fluidLoss - avgLoss) / avgLoss) * 100)
      : null;

  const hrPct =
    hr && hrMax
      ? Math.round((hr / hrMax) * 100)
      : null;

  const confidence =
    tempC !== null && hr !== null
      ? "HIGH"
      : tempC !== null || hr !== null
      ? "MEDIUM"
      : "LOW";

  return {
    lossL: (fluidLoss / 1000).toFixed(1),
    rateL: (sweatRate / 1000).toFixed(2),
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
    ? `Higher than your 30-day average: ${sign}${pct}%`
    : `Vs your 30-day average: ${sign}${pct}%`;
}

function getCauseInsight(metrics) {
  const causeRules = [
    {
      priority: 100,
      condition: metrics.confidence !== "LOW" && metrics.tempC > 30,
      text: "Main driver: heat"
    },
    {
      priority: 90,
      condition:
        metrics.confidence !== "LOW" &&
        metrics.tempC > 24 &&
        metrics.hrPct !== null &&
        metrics.hrPct > 75,
      text: "Main driver: heat + intensity"
    },
    {
      priority: 80,
      condition: metrics.hrPct !== null && metrics.hrPct > 85,
      text: "Main driver: high intensity"
    },
    {
      priority: 70,
      condition: metrics.durationH > 3,
      text: "Main driver: long duration"
    }
  ];

  const match = causeRules
    .filter(r => r.condition)
    .sort((a, b) => b.priority - a.priority)[0];

  return match ? match.text : null;
}

function getActionInsight(metrics, weeklyLoss) {
  const actionRules = [
    {
      priority: 100,
      condition: parseFloat(metrics.rateL) > 0.8,
      text: "Consider electrolytes today"
    },
    {
      priority: 80,
      condition: weeklyLoss > 4000,
      text: "High weekly load - prioritize recovery"
    },
    {
      priority: 60,
      condition: weeklyLoss > 2500,
      text: "Active week - stay on top of hydration"
    },
    {
      priority: 40,
      condition:
        metrics.sweatVsAverage !== null && metrics.sweatVsAverage > 30,
      text: "Prioritize hydration today"
    }
  ];

  const match = actionRules
    .filter(r => r.condition)
    .sort((a, b) => b.priority - a.priority)[0];

  return match ? match.text : null;
}

function buildCardText(cardData) {
  const lines = [
    `Est. sweat loss: ${cardData.loss}L · ${cardData.rate}L/h`,
    cardData.comparison,
    cardData.cause,
    cardData.action
  ].filter(Boolean);

  return lines.join("\n") + "\n\nHydroPwr.app";
}

async function buildCard(athleteId, currentLoss, durationSec, tempC, hr) {
  if (!process.env.DATABASE_URL) {
    const metrics = calcSweatMetrics(currentLoss, durationSec, tempC, hr, null, null);
    return buildCardText({
      loss: metrics.lossL,
      rate: metrics.rateL,
      comparison: null,
      cause: getCauseInsight(metrics),
      action: getActionInsight(metrics, 0)
    });
  }

  const historyResult = await pool.query(
    `SELECT fluid_loss_ml, activity_date
     FROM activities
     WHERE athlete_id = $1
       AND activity_date > NOW() - INTERVAL '30 days'
     ORDER BY activity_date DESC
     LIMIT 20`,
    [String(athleteId)]
  );

  const history = historyResult.rows;

  const avgLoss =
    history.length > 0
      ? Math.round(
          history.reduce((sum, row) => sum + (row.fluid_loss_ml || 0), 0) /
            history.length
        )
      : null;

  const weeklyLoss = history
    .filter(row => {
      if (!row.activity_date) return false;
      return Date.now() - new Date(row.activity_date).getTime() <= 7 * 86400000;
    })
    .reduce((sum, row) => sum + (row.fluid_loss_ml || 0), 0);

  const athleteResult = await pool.query(
    `SELECT birthday FROM athletes WHERE id = $1`,
    [String(athleteId)]
  );

  const birthday = athleteResult.rows[0]?.birthday || null;
  const age = birthday
    ? Math.floor(
        (Date.now() - new Date(birthday).getTime()) /
          (365.25 * 24 * 3600 * 1000)
      )
    : null;

  const hrMaxFormula = age ? 220 - age : null;

  const maxHrResult = await pool.query(
    `SELECT MAX(max_heartrate) AS max_hr
     FROM activities
     WHERE athlete_id = $1
       AND activity_date > NOW() - INTERVAL '90 days'`,
    [String(athleteId)]
  );

  const hrMax = maxHrResult.rows[0]?.max_hr || hrMaxFormula;

  const metrics = calcSweatMetrics(
    currentLoss,
    durationSec,
    tempC,
    hr,
    hrMax,
    avgLoss
  );

  const cardData = {
    loss: metrics.lossL,
    rate: metrics.rateL,
    comparison: getComparison(metrics),
    cause: getCauseInsight(metrics),
    action: getActionInsight(metrics, weeklyLoss)
  };

  return buildCardText(cardData);
}

// ── Token Management ──────────────────────────────────────────────────────────
async function getValidToken(athleteId) {
  if (!process.env.DATABASE_URL) return null;

  const result = await pool.query(
    "SELECT * FROM athletes WHERE id = $1",
    [String(athleteId)]
  );

  if (result.rows.length === 0) return null;

  const athlete = result.rows[0];
  const now = Math.floor(Date.now() / 1000);

  if (athlete.expires_at > now + 300) {
    return athlete.access_token;
  }

  try {
    const token = await stravaPostToken({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: athlete.refresh_token,
      grant_type: "refresh_token"
    });

    if (!token?.access_token) return null;

    await pool.query(
      `UPDATE athletes
       SET access_token = $1,
           refresh_token = $2,
           expires_at = $3
       WHERE id = $4`,
      [token.access_token, token.refresh_token, token.expires_at, String(athleteId)]
    );

    return token.access_token;
  } catch (e) {
    console.error("Token refresh failed:", e.message);
    return null;
  }
}

// ── Activity Processing ───────────────────────────────────────────────────────
async function processActivity(athleteId, activityId) {
  try {
    const token = await getValidToken(athleteId);
    if (!token) {
      console.log("No valid token for athlete", athleteId);
      return;
    }

    const activity = await stravaGet(`/api/v3/activities/${activityId}`, token);
    if (!activity?.id) {
      console.log("Invalid activity payload for", activityId);
      return;
    }

    const durationSec = activity.moving_time || 0;
    const hr = activity.average_heartrate || null;
    const maxHeartrate = activity.max_heartrate || null;
    const elevationM = activity.total_elevation_gain || 0;
    const distanceM = activity.distance || 0;
    const lat = activity.start_latlng?.[0] ?? null;
    const lon = activity.start_latlng?.[1] ?? null;
    const dateIso =
      activity.start_date_local || activity.start_date || new Date().toISOString();

    if (durationSec < 600) {
      console.log("Activity too short, skipping", activityId);
      return;
    }

    let tempC = null;
    if (lat != null && lon != null) {
      tempC = await fetchWeather(lat, lon, dateIso);
    }

    const fluidLoss = calcFluidLoss(durationSec, hr, tempC, elevationM);

    if (process.env.DATABASE_URL) {
      await pool.query(
        `INSERT INTO activities (
          id, athlete_id, fluid_loss_ml, duration_seconds, distance_m,
          heartrate, max_heartrate, elevation_m, temp_c, sport_type, activity_date
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
          athlete_id = EXCLUDED.athlete_id,
          fluid_loss_ml = EXCLUDED.fluid_loss_ml,
          duration_seconds = EXCLUDED.duration_seconds,
          distance_m = EXCLUDED.distance_m,
          heartrate = EXCLUDED.heartrate,
          max_heartrate = EXCLUDED.max_heartrate,
          elevation_m = EXCLUDED.elevation_m,
          temp_c = EXCLUDED.temp_c,
          sport_type = EXCLUDED.sport_type,
          activity_date = EXCLUDED.activity_date`,
        [
          String(activityId),
          String(athleteId),
          fluidLoss,
          durationSec,
          distanceM,
          hr ? Math.round(hr) : null,
          maxHeartrate ? Math.round(maxHeartrate) : null,
          elevationM ? Math.round(elevationM) : null,
          tempC,
          activity.sport_type || null,
          dateIso
        ]
      );
    }

    const message = await buildCard(
      athleteId,
      fluidLoss,
      durationSec,
      tempC,
      hr
    );

    await stravaPutActivity(activityId, token, message);
    console.log("Posted hydration card to activity", activityId);
  } catch (e) {
    console.error("processActivity error:", e.message);
  }
}

// ── OAuth Success Page ────────────────────────────────────────────────────────
function buildSuccessHtml(firstname) {
  const safeName = String(firstname || "Athlete").replace(/[<>]/g, "");

  return `<!DOCTYPE html>
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
    .btn-share { display: block; background: #111e30; border: 1px solid rgba(34,211,238,0.3); color: #22d3ee; font-weight: 600; font-size: 15px; padding: 14px; border-radius: 12px; text-decoration: none; cursor: pointer; transition: background 0.2s; width: 100%; }
    .btn-share:hover { background: rgba(34,211,238,0.1); }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">💧</div>
    <h1>HydroPwr</h1>
    <p class="greeting">Hallo, ${safeName}!</p>

    <div class="box">
      <div class="box-title">Ab jetzt automatisch</div>
      <div class="check"><span>1.</span><span>Nach jedem Training über 10 Min analysiert HydroPwr deine Aktivität</span></div>
      <div class="check"><span>2.</span><span>Temperatur, Herzfrequenz und Höhenprofil werden einberechnet</span></div>
      <div class="check"><span>3.</span><span>Deine persönliche Hydrations-Empfehlung erscheint direkt in Strava</span></div>
    </div>

    <div class="box" style="margin-bottom:32px">
      <div class="box-title">Wusstest du?</div>
      <p class="fact">Bei <strong>28°C</strong> verlierst du beim Radfahren bis zu <strong>1.8L pro Stunde</strong> – mehr als die meisten trinken. HydroPwr erinnert dich genau dann daran.</p>
    </div>

    <a class="btn-strava" href="https://www.strava.com/athlete/training">Strava öffnen</a>
    <button class="btn-share" onclick="navigator.share ? navigator.share({title:'HydroPwr',text:'Automatische Hydrations-Empfehlungen nach jedem Strava-Training',url:'https://hydropwr.app'}) : navigator.clipboard.writeText('https://hydropwr.app').then(()=>this.textContent='Link kopiert!')">
      HydroPwr teilen
    </button>
  </div>
</body>
</html>`;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      });
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // Health
    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, uptime: process.uptime() });
      return;
    }

    // Landing
    if (pathname === "/" && req.method === "GET") {
      sendHtml(res, 200, landingHtml);
      return;
    }

    // Legal
    if (pathname === "/legal" && req.method === "GET") {
      sendHtml(res, 200, legalHtml);
      return;
    }

    // Webhook verification
    if (pathname === "/webhook" && req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
        console.log("Webhook verified");
        sendJson(res, 200, { "hub.challenge": challenge });
        return;
      }

      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    // Webhook event
    if (pathname === "/webhook" && req.method === "POST") {
      const body = await readRequestBody(req);

      sendJson(res, 200, { status: "ok" });

      const event = parseJsonSafe(body, null);
      if (!event) {
        console.error("Webhook parse error");
        return;
      }

      console.log(
        "Webhook event:",
        event.object_type,
        event.aspect_type,
        event.object_id
      );

      if (event.object_type === "activity" && event.aspect_type === "create") {
        processActivity(event.owner_id, event.object_id).catch(err =>
          console.error("Async processActivity error:", err.message)
        );
      }

      return;
    }

    // OAuth callback
    if (pathname === "/callback" && req.method === "GET") {
      if (!CLIENT_ID || !CLIENT_SECRET) {
        sendHtml(
          res,
          500,
          "<html><body style='background:#080f1e;color:white;text-align:center;padding:40px;font-family:sans-serif'><h2>Missing Strava credentials</h2></body></html>"
        );
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        sendJson(res, 400, { error: "Kein Code" });
        return;
      }

      try {
        const token = await stravaPostToken({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: "authorization_code"
        });

        if (!token?.access_token || !token?.athlete?.id) {
          throw new Error("Invalid Strava token response");
        }

        if (process.env.DATABASE_URL) {
          await pool.query(
            `INSERT INTO athletes (
              id, firstname, access_token, refresh_token, expires_at, birthday
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (id) DO UPDATE SET
              firstname = EXCLUDED.firstname,
              access_token = EXCLUDED.access_token,
              refresh_token = EXCLUDED.refresh_token,
              expires_at = EXCLUDED.expires_at,
              birthday = EXCLUDED.birthday`,
            [
              token.athlete.id,
              token.athlete.firstname || null,
              token.access_token,
              token.refresh_token,
              token.expires_at,
              token.athlete.birthday || null
            ]
          );
        }

        const key = Math.random().toString(36).slice(2, 10);
        tokens[key] = {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: token.expires_at,
          athlete: token.athlete,
          created_at: Date.now()
        };

        sendHtml(res, 200, buildSuccessHtml(token.athlete.firstname));
      } catch (e) {
        console.error("OAuth callback failed:", e.message);
        sendHtml(
          res,
          200,
          "<html><body style='background:#080f1e;color:white;text-align:center;padding:40px;font-family:sans-serif'><h2>Login fehlgeschlagen</h2></body></html>"
        );
      }

      return;
    }

    // Get token by one-time key
    if (pathname.startsWith("/token/") && req.method === "GET") {
      const key = pathname.slice("/token/".length);
      const token = tokens[key];

      if (!token) {
        sendJson(res, 404, { error: "Token nicht gefunden" });
        return;
      }

      if (Date.now() - token.created_at > TOKEN_TTL_MS) {
        delete tokens[key];
        sendJson(res, 410, { error: "Token abgelaufen" });
        return;
      }

      const result = { ...token };
      delete tokens[key];
      sendJson(res, 200, result);
      return;
    }

    // Refresh token
    if (pathname === "/refresh" && req.method === "POST") {
      const rawBody = await readRequestBody(req);
      const parsed = parseJsonSafe(rawBody, {});

      if (!parsed.refresh_token) {
        sendJson(res, 400, { error: "refresh_token fehlt" });
        return;
      }

      try {
        const token = await stravaPostToken({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: parsed.refresh_token,
          grant_type: "refresh_token"
        });

        sendJson(res, 200, {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: token.expires_at
        });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }

      return;
    }

    // Setup webhook
    if (pathname === "/setup" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;

      try {
        const result = await stravaCreateWebhook();
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, e.statusCode || 500, {
          error: e.message,
          details: e.response || null
        });
      }

      return;
    }

    // List webhooks
    if (pathname === "/reset-webhook" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;

      try {
        const subs = await stravaListWebhooks();
        sendJson(res, 200, subs);
      } catch (e) {
        sendJson(res, e.statusCode || 500, {
          error: e.message,
          details: e.response || null
        });
      }

      return;
    }

    // Delete + recreate webhook
    if (pathname === "/fix-webhook" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;

      try {
        const subscriptionId = url.searchParams.get("id");

        if (!subscriptionId) {
          sendJson(res, 400, { error: "Missing webhook subscription id" });
          return;
        }

        await stravaDeleteWebhook(subscriptionId);
        const created = await stravaCreateWebhook();

        sendJson(res, 200, {
          status: "recreated",
          created
        });
      } catch (e) {
        sendJson(res, e.statusCode || 500, {
          error: e.message,
          details: e.response || null
        });
      }

      return;
    }

    // Manual processing
    if (pathname.startsWith("/process/") && req.method === "GET") {
      if (!requireAdmin(req, res)) return;

      const parts = pathname.split("/").filter(Boolean);
      const athleteId = parts[1];
      const activityId = parts[2];

      if (!athleteId || !activityId) {
        sendJson(res, 400, { error: "athleteId oder activityId fehlt" });
        return;
      }

      processActivity(athleteId, activityId).catch(err =>
        console.error("Manual processActivity error:", err.message)
      );

      sendJson(res, 200, {
        status: "processing",
        athleteId,
        activityId
      });
      return;
    }

    sendJson(res, 404, { error: "Nicht gefunden" });
  } catch (e) {
    console.error("Request error:", e);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HydroCoach Port " + PORT);
  setTimeout(() => {
    initDB().catch(err => console.error("initDB failed:", err.message));
  }, 1000);
});

// ── Process Error Handling ────────────────────────────────────────────────────
process.on("uncaughtException", err => {
  console.error("Uncaught:", err);
});

process.on("unhandledRejection", err => {
  console.error("Unhandled:", err);
});
