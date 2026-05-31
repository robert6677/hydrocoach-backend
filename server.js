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

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "HydroCoach Backend laeuft!" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) {}

    if (req.url === "/auth" && req.method === "POST") {
      stravaPost({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: parsed.code,
        grant_type: "authorization_code"
      }, (err, token) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
        res.writeHead(200);
        res.end(JSON.stringify({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: token.expires_at,
          athlete: token.athlete
        }));
      });
      return;
    }

    if (req.url === "/refresh" && req.method === "POST") {
      stravaPost({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: parsed.refresh_token,
        grant_type: "refresh_token"
      }, (err, token) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
        res.writeHead(200);
        res.end(JSON.stringify({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: token.expires_at
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Nicht gefunden" }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HydroCoach laeuft auf Port " + PORT);
});

      
