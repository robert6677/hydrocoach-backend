const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const tokens = {};

function stravaPost(body, callback) {
  const data = JSON.stringify(body);
  const req = https.request({
    hostname: "www.strava.com",
    path: "/oauth/token",
    method: "POST",
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

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/html" : "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }

  if (req.url === "/" && req.method === "GET") return send(res, 200, { status: "HydroCoach laeuft!" });

  if (req.url.startsWith("/callback") && req.method === "GET") {
    const code = new URL(req.url, "http://localhost").searchParams.get("code");
    if (!code) return send(res, 400, { error: "Kein Code" });
    stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code" }, (err, token) => {
      if (err || token.errors) return send(res, 200, "<html><body style='background:#080f1e;color:white;text-align:center;padding:40px;font-family:sans-serif'><h2>❌ Login fehlgeschlagen</h2></body></html>");
      const key = Math.random().toString(36).substring(2, 10);
      tokens[key] = { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at, athlete: token.athlete };
      send(res, 200, `<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#080f1e;color:white">
  <div style="font-size:60px;margin-bottom:16px">💧</div>
  <h1 style="color:#22d3ee;margin-bottom:4px">HydroCoach</h1>
  <h2 style="font-weight:400;margin-bottom:24px">Hallo, ${token.athlete?.firstname || "Athlet"}! 👋</h2>
  <div style="background:#131929;border:1px solid rgba(34,211,238,0.3);border-radius:16px;padding:20px;max-width:300px;margin:0 auto 24px">
    <p style="color:#22d3ee;font-size:13px;margin:0 0 8px">Dein Login-Code:</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:0 0 8px;color:white">${key}</p>
    <p style="color:#475569;font-size:12px;margin:0">Gib diesen Code in der HydroCoach App ein</p>
  </div>
  <button onclick="navigator.clipboard.writeText('${key}').then(()=>this.textContent='✅ Kopiert!')" 
    style="background:linear-gradient(135deg,#0ea5e9,#22d3ee);border:none;border-radius:12px;color:#020c18;font-size:16px;font-weight:bold;padding:14px 32px;cursor:pointer">
    Code kopieren 📋
  </button>
</body></html>`);
    });
    return;
  }

  if (req.url.startsWith("/token/") && req.method === "GET") {
    const key = req.url.split("/token/")[1];
    const token = tokens[key];
    if (!token) return send(res, 404, { error: "Token nicht gefunden" });
    const result = { ...token };
    delete tokens[key];
    return send(res, 200, result);
  }

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

  send(res, 404, { error: "Nicht gefunden" });

}).listen(PORT, "0.0.0.0", () => console.log("HydroCoach Port " + PORT));
