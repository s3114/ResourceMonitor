const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3001;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const TARGETS_FILE = path.join(DATA_DIR, "targets.json");
const DARPANET_RESOURCE_FILE = path.join(__dirname, "DARPANET Resource Monitor.html");
const DARPANET_LIST_FILE = path.join(__dirname, "DARPANET list.json");

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
        alarmEnabled: false,
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
        alarmEnabled: parseAlarmEnabled(body.alarmEnabled, targets[idx].alarmEnabled),
        updatedAt: new Date().toISOString(),
      };

      writeTargets(targets);
      return sendJson(res, 200, { target: targets[idx] });
    } catch (error) {
      return sendJson(res, 400, { error: "JSON形式が不正です。" });
    }
  }

  if (targetId && /^\/api\/targets\/[^/]+$/.test(parsedUrl.pathname) && req.method === "DELETE") {
    const targets = readTargets();
    const idx = targets.findIndex((t) => t.id === targetId);
    if (idx < 0) {
      return sendJson(res, 404, { error: "対象が見つかりません。" });
    }
    const [removed] = targets.splice(idx, 1);
    writeTargets(targets);
    return sendJson(res, 200, { ok: true, removed });
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

  if (parsedUrl.pathname === "/api/system-usage" && req.method === "GET") {
    try {
      const usage = await getSystemUsage();
      return sendJson(res, 200, usage);
    } catch (error) {
      return sendJson(res, 500, { error: "システム使用率の取得に失敗しました。" });
    }
  }

  if (parsedUrl.pathname === "/api/darpanet/endpoints" && req.method === "GET") {
    try {
      return sendJson(res, 200, {
        endpoints: readDarpanetEndpoints(),
        updatedAt: getFileUpdatedAt(DARPANET_LIST_FILE),
      });
    } catch (error) {
      return sendJson(res, 500, { error: "DARPANET list.json の読み込みに失敗しました。" });
    }
  }

  if (parsedUrl.pathname === "/api/darpanet/endpoints/refresh" && req.method === "POST") {
    try {
      const endpoints = await refreshDarpanetEndpoints();
      return sendJson(res, 200, { endpoints, updatedAt: new Date().toISOString() });
    } catch (error) {
      return sendJson(res, 500, { error: error.message || "電話端末一覧の更新に失敗しました。" });
    }
  }

  if (parsedUrl.pathname === "/telephone" && req.method === "GET") {
    return serveFile(path.join(PUBLIC_DIR, "index.html"), res);
  }

  if (
    (parsedUrl.pathname === "/DARPANET%20Resource%20Monitor.html" ||
      parsedUrl.pathname === "/DARPANET Resource Monitor.html") &&
    req.method === "GET"
  ) {
    return serveFile(DARPANET_RESOURCE_FILE, res);
  }

  if (
    (parsedUrl.pathname === "/DARPANET%20list.json" || parsedUrl.pathname === "/DARPANET list.json") &&
    req.method === "GET"
  ) {
    return serveFile(DARPANET_LIST_FILE, res);
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

function readDarpanetEndpoints() {
  const raw = fs.readFileSync(DARPANET_LIST_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function getFileUpdatedAt(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch (error) {
    return null;
  }
}

function refreshDarpanetEndpoints() {
  return new Promise((resolve, reject) => {
    execFile(
      "curl.exe",
      ["-u", "monitor:hongo2025", "http://192.168.43.150:8088/ari/endpoints"],
      { timeout: 15000, maxBuffer: 1024 * 1024 * 5 },
      (error, stdout = "", stderr = "") => {
        if (error) {
          const detail = (stderr || error.message || "").trim();
          reject(new Error(detail || "curl.exe の実行に失敗しました。"));
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) {
            reject(new Error("ARI endpoints の応答が配列ではありません。"));
            return;
          }
          fs.writeFileSync(DARPANET_LIST_FILE, JSON.stringify(parsed, null, 2), "utf-8");
          resolve(parsed);
        } catch (parseError) {
          reject(new Error("ARI endpoints の応答JSONを解析できませんでした。"));
        }
      }
    );
  });
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

function parseAlarmEnabled(value, fallback = false) {
  return typeof value === "boolean" ? value : !!fallback;
}

function normalizeTarget(target) {
  return {
    ...target,
    id: String(target.id || createId()),
    name: String(target.name || ""),
    ip: String(target.ip || ""),
    port: parsePort(target.port),
    pinned: !!target.pinned,
    alarmEnabled: !!target.alarmEnabled,
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
        responseMs: isUp ? Date.now() - start : null,
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
    execFile("ping", args, { timeout: 5000 }, (error, stdout = "", stderr = "") => {
      const output = `${stdout}\n${stderr}`;
      const success = isSuccessfulPing(output, isWindows) && !error;
      resolve({
        isUp: success,
        responseMs: success ? Date.now() - start : null,
        reason: success ? null : "ping_failed",
      });
    });
  });
}

function isSuccessfulPing(output, isWindows) {
  if (!output) return false;
  if (isWindows) {
    return /TTL=/i.test(output);
  }
  return /ttl=/i.test(output) || /1 received/i.test(output) || /1 packets received/i.test(output);
}

async function getSystemUsage() {
  const cpuPercent = await sampleCpuUsagePercent(250);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memoryPercent = totalMem > 0 ? roundTo1((usedMem / totalMem) * 100) : null;
  const gpu = await getGpuUsage();

  return {
    cpuPercent,
    cpuCores: (os.cpus() || []).length || null,
    memoryPercent,
    memoryUsedGb: roundTo2(usedMem / 1024 / 1024 / 1024),
    memoryTotalGb: roundTo2(totalMem / 1024 / 1024 / 1024),
    gpuPercent: gpu.percent,
    gpuSource: gpu.source,
    checkedAt: new Date().toISOString(),
  };
}

function sampleCpuUsagePercent(intervalMs) {
  const start = readCpuTimes();
  return new Promise((resolve) => {
    setTimeout(() => {
      const end = readCpuTimes();
      const totalDiff = Math.max(1, end.total - start.total);
      const idleDiff = Math.max(0, end.idle - start.idle);
      const busyPercent = ((totalDiff - idleDiff) / totalDiff) * 100;
      resolve(roundTo1(busyPercent));
    }, intervalMs);
  });
}

function readCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  cpus.forEach((cpu) => {
    const times = cpu.times || {};
    idle += times.idle || 0;
    total +=
      (times.user || 0) +
      (times.nice || 0) +
      (times.sys || 0) +
      (times.idle || 0) +
      (times.irq || 0);
  });
  return { idle, total };
}

function getGpuUsage() {
  if (process.platform !== "win32") {
    return Promise.resolve({ percent: null, source: "unsupported_os" });
  }

  return new Promise((resolve) => {
    execFile(
      "wmic",
      ["path", "Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine", "get", "UtilizationPercentage", "/value"],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve({ percent: null, source: "wmic_unavailable" });
          return;
        }

        const matches = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith("UtilizationPercentage="))
          .map((line) => Number(line.split("=")[1]))
          .filter((value) => Number.isFinite(value) && value >= 0);

        if (!matches.length) {
          resolve({ percent: null, source: "no_data" });
          return;
        }

        const peak = Math.max(...matches);
        resolve({ percent: roundTo1(peak), source: "wmic" });
      }
    );
  });
}

function roundTo1(value) {
  return Math.round(value * 10) / 10;
}

function roundTo2(value) {
  return Math.round(value * 100) / 100;
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
    const headers = { "Content-Type": getContentType(filePath) };
    if (path.basename(filePath).toLowerCase().startsWith("favicon")) {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendText(res, 404, "Not Found");
    }
    let body = data;
    if (filePath === DARPANET_RESOURCE_FILE) {
      body = injectDarpanetTelephoneExtension(data.toString("utf-8"));
    }
    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    res.end(body);
  });
}

function injectDarpanetTelephoneExtension(html) {
  if (html.includes("darpanet-telephone-extension")) {
    return html;
  }

  const extension = String.raw`
<style id="darpanet-telephone-extension-style">
  .darpanet-phone-icon-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .darpanet-phone-icon-link svg {
    width: 1.1rem;
    height: 1.1rem;
  }
  .darpanet-phone-page {
    width: 100%;
    max-width: 1280px;
    margin: 0 auto;
    padding: 1.5rem;
  }
  .darpanet-phone-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .darpanet-phone-title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .darpanet-phone-title svg {
    width: 2rem;
    height: 2rem;
  }
  .darpanet-phone-title h2 {
    font-size: 1.5rem;
    line-height: 2rem;
    font-weight: 700;
  }
  .darpanet-phone-summary {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .darpanet-phone-summary span {
    border: 1px solid hsl(var(--nextui-divider, 240 5% 26%));
    border-radius: 999px;
    padding: 0.35rem 0.75rem;
    font-size: 0.875rem;
  }
  .darpanet-refresh-button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.5rem;
    border-radius: 0.75rem;
    padding: 0.5rem 1rem;
    background: hsl(var(--nextui-primary, 212 100% 47%));
    color: hsl(var(--nextui-primary-foreground, 0 0% 100%));
    font-weight: 600;
  }
  .darpanet-refresh-button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .darpanet-phone-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 0.75rem;
  }
  .darpanet-phone-card {
    border: 1px solid hsl(var(--nextui-divider, 240 5% 26%));
    border-radius: 0.5rem;
    padding: 0.85rem;
    background: hsl(var(--nextui-content1, 240 5% 10%));
  }
  .darpanet-phone-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .darpanet-phone-resource {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 1.1rem;
    font-weight: 700;
  }
  .darpanet-phone-state {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 0.15rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 700;
  }
  .darpanet-phone-state.online {
    background: rgba(34, 197, 94, 0.18);
    color: #4ade80;
  }
  .darpanet-phone-state.offline {
    background: rgba(248, 113, 113, 0.18);
    color: #f87171;
  }
  .darpanet-phone-meta {
    margin-top: 0.6rem;
    color: hsl(var(--nextui-default-500, 240 4% 65%));
    font-size: 0.8rem;
    word-break: break-word;
  }
  .darpanet-phone-status {
    color: hsl(var(--nextui-default-500, 240 4% 65%));
    font-size: 0.875rem;
  }
</style>
<script id="darpanet-telephone-extension">
(function () {
  const phoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92z"/></svg>';
  const refreshSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

  function endpointUrl(path) {
    return path;
  }

  function enhanceNav() {
    const telephoneLinks = Array.from(document.querySelectorAll('a[href$="/telephone"], a[href="/telephone"]'));
    telephoneLinks.forEach((link) => {
      if (!link.classList.contains("darpanet-phone-icon-link")) {
        link.classList.add("darpanet-phone-icon-link");
        if (!link.querySelector("svg")) {
          link.insertAdjacentHTML("afterbegin", phoneSvg);
        }
      }
    });

    const desktopTelephone = telephoneLinks.find((link) => link.closest("ul.hidden.lg\\:flex"));
    const desktopCloud = document.querySelector('ul.hidden.lg\\:flex a[href$="/cloud"], ul.hidden.lg\\:flex a[href="/cloud"]');
    if (desktopTelephone && desktopCloud) {
      const phoneItem = desktopTelephone.closest("li");
      const cloudItem = desktopCloud.closest("li");
      if (phoneItem && cloudItem && phoneItem !== cloudItem && phoneItem.nextElementSibling !== cloudItem) {
        cloudItem.parentElement.insertBefore(phoneItem, cloudItem);
      }
    }
  }

  function getRoot() {
    const heading = Array.from(document.querySelectorAll("h1,h2,h3")).find((el) => el.textContent.trim().includes("内線"));
    if (heading) {
      return heading.closest("section") || heading.closest("main") || heading.parentElement;
    }
    return document.querySelector("main") || document.querySelector('[data-overlay-container="true"] > div') || document.body;
  }

  function renderShell(root) {
    root.innerHTML = [
      '<section class="darpanet-phone-page">',
      '  <div class="darpanet-phone-toolbar">',
      '    <div class="darpanet-phone-title">' + phoneSvg + '<h2>内線の状況</h2></div>',
      '    <button class="darpanet-refresh-button" type="button" id="darpanetRefreshButton">' + refreshSvg + '<span>更新</span></button>',
      '  </div>',
      '  <div class="darpanet-phone-summary" id="darpanetPhoneSummary"></div>',
      '  <p class="darpanet-phone-status" id="darpanetPhoneStatus">読み込み中...</p>',
      '  <div class="darpanet-phone-grid" id="darpanetPhoneGrid"></div>',
      '</section>'
    ].join("");
  }

  function renderEndpoints(items, updatedAt) {
    const grid = document.getElementById("darpanetPhoneGrid");
    const summary = document.getElementById("darpanetPhoneSummary");
    const status = document.getElementById("darpanetPhoneStatus");
    if (!grid || !summary || !status) return;

    const sorted = items.slice().sort((a, b) => String(a.resource || "").localeCompare(String(b.resource || ""), "ja", { numeric: true }));
    const online = sorted.filter((item) => item.state === "online").length;
    const offline = sorted.filter((item) => item.state !== "online").length;
    const updatedLabel = updatedAt ? new Date(updatedAt).toLocaleString("ja-JP") : "-";

    summary.innerHTML = [
      '<span>合計 ' + sorted.length + '</span>',
      '<span>online ' + online + '</span>',
      '<span>offline ' + offline + '</span>',
      '<span>最終更新 ' + updatedLabel + '</span>'
    ].join("");

    status.textContent = sorted.length ? "" : "表示できる内線がありません。";
    grid.innerHTML = sorted.map((item) => {
      const state = item.state === "online" ? "online" : "offline";
      const channels = Array.isArray(item.channel_ids) && item.channel_ids.length ? item.channel_ids.join(", ") : "channel none";
      return [
        '<article class="darpanet-phone-card">',
        '  <div class="darpanet-phone-card-head">',
        '    <span class="darpanet-phone-resource">' + escapeHtml(item.resource || "-") + '</span>',
        '    <span class="darpanet-phone-state ' + state + '">' + state + '</span>',
        '  </div>',
        '  <div class="darpanet-phone-meta">' + escapeHtml(item.technology || "-") + '</div>',
        '  <div class="darpanet-phone-meta">' + escapeHtml(channels) + '</div>',
        '</article>'
      ].join("");
    }).join("");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  async function loadEndpoints() {
    const status = document.getElementById("darpanetPhoneStatus");
    if (status) status.textContent = "読み込み中...";
    const response = await fetch(endpointUrl("/api/darpanet/endpoints"), { cache: "no-store" });
    if (!response.ok) throw new Error("list fetch failed");
    const data = await response.json();
    renderEndpoints(data.endpoints || [], data.updatedAt);
  }

  async function refreshEndpoints() {
    const button = document.getElementById("darpanetRefreshButton");
    const status = document.getElementById("darpanetPhoneStatus");
    if (button) button.disabled = true;
    if (status) status.textContent = "更新中...";
    try {
      const response = await fetch(endpointUrl("/api/darpanet/endpoints/refresh"), { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "refresh failed");
      renderEndpoints(data.endpoints || [], data.updatedAt);
    } catch (error) {
      if (status) status.textContent = "更新に失敗しました: " + error.message;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function mount() {
    enhanceNav();
    if (!location.pathname.endsWith("/telephone") && !decodeURIComponent(location.pathname).endsWith("DARPANET Resource Monitor.html")) {
      return;
    }
    const root = getRoot();
    if (!root) return;
    renderShell(root);
    const button = document.getElementById("darpanetRefreshButton");
    if (button) button.addEventListener("click", refreshEndpoints);
    loadEndpoints().catch((error) => {
      const status = document.getElementById("darpanetPhoneStatus");
      if (status) status.textContent = "読み込みに失敗しました: " + error.message;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  window.addEventListener("load", function () {
    setTimeout(enhanceNav, 200);
  });
})();
</script>`;

  return html.replace("</body>", `${extension}</body>`);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
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
