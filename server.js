const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3001;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const TARGETS_FILE = path.join(DATA_DIR, "targets.json");

ensureDataFile();

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetId = getTargetIdFromPath(parsedUrl.pathname);

  if (parsedUrl.pathname === "/api/targets" && req.method === "GET") {
    return sendJson(res, 200, { targets: readTargets() });
  }

  if (parsedUrl.pathname === "/api/targets" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const validation = validateTargetInput(body);
      if (!validation.ok) {
        return sendJson(res, 400, { error: validation.error });
      }

      const targets = readTargets();
      const port = parsePort(body.port);
      const newTarget = {
        id: createId(),
        name: body.name.trim(),
        ip: body.ip.trim(),
        port,
        pinned: false,
        createdAt: new Date().toISOString(),
      };

      targets.push(newTarget);
      writeTargets(targets);
      return sendJson(res, 201, { target: newTarget });
    } catch (error) {
      return sendJson(res, 400, { error: "JSON形式が不正です。" });
    }
  }

  if (targetId && /^\/api\/targets\/[^/]+$/.test(parsedUrl.pathname) && req.method === "PATCH") {
    try {
      const body = await readJsonBody(req);
      const validation = validateTargetInput(body);
      if (!validation.ok) {
        return sendJson(res, 400, { error: validation.error });
      }

      const targets = readTargets();
      const idx = targets.findIndex((t) => t.id === targetId);
      if (idx < 0) {
        return sendJson(res, 404, { error: "対象が見つかりません。" });
      }

      targets[idx] = {
        ...targets[idx],
        name: body.name.trim(),
        ip: body.ip.trim(),
        port: parsePort(body.port),
        updatedAt: new Date().toISOString(),
      };

      writeTargets(targets);
      return sendJson(res, 200, { target: targets[idx] });
    } catch (error) {
      return sendJson(res, 400, { error: "JSON形式が不正です。" });
    }
  }

  if (targetId && parsedUrl.pathname.endsWith("/pin") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const targets = readTargets();
      const idx = targets.findIndex((t) => t.id === targetId);
      if (idx < 0) {
        return sendJson(res, 404, { error: "対象が見つかりません。" });
      }

      const current = targets[idx];
      const shouldPin = typeof body.pinned === "boolean" ? body.pinned : !current.pinned;
      current.pinned = shouldPin;
      current.updatedAt = new Date().toISOString();
      moveByPinRule(targets, idx, shouldPin);
      writeTargets(targets);
      return sendJson(res, 200, { target: current });
    } catch (error) {
      return sendJson(res, 400, { error: "JSON形式が不正です。" });
    }
  }

  if (targetId && parsedUrl.pathname.endsWith("/move") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const direction = body.direction === "up" ? "up" : body.direction === "down" ? "down" : null;
      if (!direction) {
        return sendJson(res, 400, { error: "direction は up/down を指定してください。" });
      }

      const targets = readTargets();
      const idx = targets.findIndex((t) => t.id === targetId);
      if (idx < 0) {
        return sendJson(res, 404, { error: "対象が見つかりません。" });
      }

      const swapped = moveTargetInGroup(targets, idx, direction);
      if (!swapped) {
        return sendJson(res, 200, { ok: true, unchanged: true });
      }
      writeTargets(targets);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { error: "JSON形式が不正です。" });
    }
  }

  if (parsedUrl.pathname === "/api/status" && req.method === "GET") {
    const targets = readTargets();
    const statuses = await Promise.all(
      targets.map(async (target) => ({
        ...target,
        status: Number.isInteger(target.port)
          ? await checkEndpoint(target.ip, target.port)
          : await pingHost(target.ip),
      }))
    );
    return sendJson(res, 200, { targets: statuses, checkedAt: new Date().toISOString() });
  }

  if (parsedUrl.pathname === "/api/response-time/reset" && req.method === "POST") {
    return sendJson(res, 200, { ok: true });
  }

  if (parsedUrl.pathname === "/api/restart" && req.method === "POST") {
    sendJson(res, 200, { ok: true, message: "サーバーを再起動します。" });
    scheduleRestart();
    return;
  }

  serveStaticFile(parsedUrl.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(TARGETS_FILE)) {
    fs.writeFileSync(TARGETS_FILE, "[]", "utf-8");
  }
}

function readTargets() {
  try {
    const raw = fs.readFileSync(TARGETS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeTarget) : [];
  } catch (error) {
    return [];
  }
}

function writeTargets(targets) {
  fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2), "utf-8");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function validateTargetInput(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "入力が不正です。" };
  }

  const ip = String(body.ip || "").trim();
  const name = String(body.name || "").trim();
  const port = parsePort(body.port);

  if (!name) {
    return { ok: false, error: "表示名は必須です。" };
  }

  if (!isValidHost(ip)) {
    return { ok: false, error: "IPまたはホスト名（例: soari.mydns.jp）を入力してください。" };
  }

  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { ok: false, error: "ポートは1-65535の整数で入力してください（未入力も可）。" };
  }

  return { ok: true };
}

function isValidHost(value) {
  if (net.isIP(value)) {
    return true;
  }

  // Allow common hostname/FQDN forms: labels of 1-63 chars, alnum/hyphen, no leading/trailing hyphen.
  const hostnameRegex =
    /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)$/;

  return hostnameRegex.test(value);
}

function parsePort(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function normalizeTarget(target) {
  return {
    ...target,
    id: String(target.id || createId()),
    name: String(target.name || ""),
    ip: String(target.ip || ""),
    port: parsePort(target.port),
    pinned: !!target.pinned,
  };
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function checkEndpoint(ip, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (isUp, reason = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        isUp,
        responseMs: Date.now() - start,
        reason,
      });
    };

    socket.setTimeout(3000);
    socket.connect(port, ip, () => finish(true));
    socket.on("timeout", () => finish(false, "timeout"));
    socket.on("error", (err) => finish(false, err.code || "error"));
  });
}

function pingHost(ip) {
  const start = Date.now();
  const isWindows = process.platform === "win32";
  const args = isWindows ? ["-n", "1", "-w", "3000", ip] : ["-c", "1", "-W", "3", ip];

  return new Promise((resolve) => {
    execFile("ping", args, { timeout: 5000 }, (error) => {
      resolve({
        isUp: !error,
        responseMs: Date.now() - start,
        reason: error ? "ping_failed" : null,
      });
    });
  });
}

function scheduleRestart() {
  const batPath = path.join(__dirname, "起動.bat");

  try {
    if (process.platform === "win32" && fs.existsSync(batPath)) {
      const child = spawn("cmd.exe", ["/c", "start", "", batPath], {
        cwd: __dirname,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
        cwd: __dirname,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  } catch (error) {
    console.error("Failed to start new server process:", error);
  }

  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  }, 300);
}

function getTargetIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/targets\/([^/]+)(?:\/(pin|move))?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function moveByPinRule(targets, idx, pinned) {
  const [item] = targets.splice(idx, 1);
  if (!item) return;

  if (pinned) {
    const firstUnpinned = targets.findIndex((t) => !t.pinned);
    const insertAt = firstUnpinned === -1 ? targets.length : firstUnpinned;
    targets.splice(insertAt, 0, item);
    return;
  }

  const lastPinned = findLastIndex(targets, (t) => t.pinned);
  targets.splice(lastPinned + 1, 0, item);
}

function moveTargetInGroup(targets, idx, direction) {
  const source = targets[idx];
  if (!source) return false;

  if (direction === "up") {
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (!!targets[i].pinned === !!source.pinned) {
        [targets[i], targets[idx]] = [targets[idx], targets[i]];
        return true;
      }
    }
    return false;
  }

  for (let i = idx + 1; i < targets.length; i += 1) {
    if (!!targets[i].pinned === !!source.pinned) {
      [targets[i], targets[idx]] = [targets[idx], targets[i]];
      return true;
    }
  }
  return false;
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function serveStaticFile(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendText(res, 404, "Not Found");
    }
    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    res.end(data);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
