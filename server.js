const https = require("https");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ||3000;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

// ── Simple HTTP helper ────────────────────────────────────────────────────────
function stravaPost(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "www.strava.com",
        path: "/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("Invalid JSON from Strava")); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Request handler ───────────────────────────────────────────────────────────
const http = require("http");

http.createServer(async (req, res) => {
  // CORS – allow requests from anywhere (your app)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "HydroCoach Backend läuft ✅" }));
    return;
  }

  // Read request body
  const body = await new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); }
      catch { resolve({}); }
    });
  });

  // ── POST /auth → Code gegen Token tauschen ────────────────────────────────
  if (req.url === "/auth" && req.method === "POST") {
    if (!body.code) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "code fehlt" }));
      return;
    }
    try {
      const token = await stravaPost({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: body.code,
        grant_type: "authorization_code",
      });
      res.writeHead(200);
      res.end(JSON.stringify({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
        athlete: token.athlete,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /refresh → Abgelaufenen Token erneuern ───────────────────────────
  if (req.url === "/refresh" && req.method === "POST") {
    if (!body.refresh_token) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "refresh_token fehlt" }));
      return;
    }
    try {
      const token = await stravaPost({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: body.refresh_token,
        grant_type: "refresh_token",
      });
      res.writeHead(200);
      res.end(JSON.stringify({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Nicht gefunden" }));

}).listen(PORT, () => {
  console.log(`HydroCoach Backend läuft auf Port ${PORT}`);
});
