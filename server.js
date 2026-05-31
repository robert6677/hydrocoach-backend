const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

function stravaPost(body, callback) {
  const data = JSON.stringify(body);
  const options = {
    hostname: "www.strava.com",
    path: "/oauth/token",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data)
    }
  };
  const req = https.request(options, (res) => {
    let raw = "";
    res.on("data", (chunk) => raw += chunk);
    res.on("end", () => callback(null, JSON.parse(raw)));
  });
  req.on("error", (e) => callback(e));
  req.write(data);
  req.end();
}

// Store tokens temporarily (in memory)
const tokens = {};

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ status: "HydroCoach Backend laeuft!" }));
    return;
  }

  // Strava callback - exchange code for token
  if (req.url.startsWith("/callback") && req.method === "GET") {
    const code = new URL(req.url, "http://localhost").searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Kein Code");
      return;
    }
    stravaPost({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: "authorization_code"
    }, (err, token) => {
      if (err || token.errors) {
        res.writeHead(200);
        res.setHeader("Content-Type", "text/html");
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#080f1e;color:white">
          <h2>❌ Fehler beim Login</h2><p>Bitte versuche es erneut.</p></body></html>`);
        return;
      }
      // Store token with a simple key
      const key = Date.now().toString();
      tokens[key] = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
        athlete: token.athlete
      };
      res.writeHead(200);
      res.setHeader("Content-Type", "text/html");
      res.end(`<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:40px;background:#080f1e;color:white">
  <div style="font-size:64px;margin-bottom:20px">💧</div>
  <h1 style="color:#22d3ee;font-size:28px">HydroCoach</h1>
  <h2 style="font-weight:400;margin-bottom:8px">Hallo, ${token.athlete?.firstname || "Athlet"}! 👋</h2>
  <p style="color:#475569;margin-bottom:32px">Dein Strava-Konto wurde erfolgreich verbunden.</p>
  <div style="background:#131929;border:1px solid rgba(34,211,238,0.2);border-radius:16px;padding:20px;margin-bottom:32px;max-width:320px;margin-left:auto;margin-right:auto">
    <p style="color:#22d3ee;font-size:14px;margin:0">Dein Login-Code:</p>
    <p id="tokenKey" style="font-size:22px;font-weight:bold;letter-spacing:4px;margin:10px 0">${key}</p>
    <p style="color:#475569;font-size:12px;margin:0">Gib diesen Code in der App ein</p>
  </div>
  <button onclick="copyCode()" style="background:linear-gradient(135deg,#0ea5e9,#22d3ee);border:none;border-radius:12px;color:#020c18;font-size:16px;font-weight:bold;padding:14px 32px;cursor:pointer">
    Code kopieren
  </button>
  <script>
    function copyCode() {
      navigator.clipboard.writeText('${key}').then(() => {
        document.querySelector('button').textContent = '✅ Kopiert!';
      });
    }
  </script>
</body></html>`);
    });
    return;
  }

  // GET /token/:key - retrieve stored token
  if (req.url.startsWith("/token/") && req.method === "GET") {
    const key = req.url.split("/token/")[1];
    const token = tokens[key];
    res.setHeader("Content-Type", "application/json");
    if (!token) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Token nicht gefunden" }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(token));
    delete tokens[key]; // single use
    return;
  }

  // POST /refresh
  if (req.url === "/refresh" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      stravaPost({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: parsed.refresh_token,
        grant_type: "refresh_token"
      }, (err, token) => {
        res.setHeader("Content-Type", "application/json");
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
        res.writeHead(200);
        res.end(JSON.stringify({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: token.expires_at
        }));
      });
    });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Nicht gefunden" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HydroCoach laeuft auf Port " + PORT);
});
