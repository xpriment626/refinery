import crypto from "node:crypto";
import fs from "node:fs";
import http, {} from "node:http";
import path from "node:path";
import { asRefineryError, RefineryError } from "../core/errors.js";
import { removeStoredAuth, writeStoredAuth } from "../core/credentials.js";
import { resolveRefineryPaths } from "../core/paths.js";
import { provisionCoralRuntime } from "../coral/runtime.js";
import { verifyCoralCredential } from "../coral/verification.js";
import { resolveModelSelection } from "../core/model-selection.js";
import { writeUiConfig } from "../gateway/config.js";
import { inspectSetup, writeSetupReceipt } from "./status.js";
export const setupProtocolVersion = "refinery.setup-gateway.v1";
const maxRequestBodyBytes = 16 * 1024;
function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
function secureHashMatch(token, expectedHash) {
    const actual = Buffer.from(hashToken(token), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function bearerToken(request) {
    const authorization = request.headers.authorization;
    return typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
}
function securityHeaders(response, contentType) {
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}
function sendJson(response, status, value) {
    securityHeaders(response, "application/json; charset=utf-8");
    response.statusCode = status;
    response.end(`${JSON.stringify(value)}\n`);
}
function sendText(response, status, contentType, body) {
    securityHeaders(response, contentType);
    response.statusCode = status;
    response.end(body);
}
async function readJsonBody(request) {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
        throw new RefineryError("SETUP_CONTENT_TYPE_INVALID", "Setup requests must use application/json.", { phase: "setup-server" });
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxRequestBodyBytes) {
            throw new RefineryError("SETUP_BODY_TOO_LARGE", `Setup request body exceeds ${maxRequestBodyBytes} bytes.`, { phase: "setup-server" });
        }
        chunks.push(buffer);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("expected an object");
        return parsed;
    }
    catch {
        throw new RefineryError("SETUP_JSON_INVALID", "Setup request body must be a valid JSON object.", { phase: "setup-server" });
    }
}
const setupHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Refinery setup</title>
  <link rel="stylesheet" href="/setup.css">
</head>
<body>
  <main>
    <p class="eyebrow">REFINERY v0.3</p>
    <h1>Connect local memory to coordinated review.</h1>
    <p class="lede">Refinery reads selected Codex memory and session sources, builds a derived responsibility graph, and asks Coral-coordinated specialists to propose changes. Canonical Codex sources remain read-only; derived graph state and proposal artifacts stay in Refinery-managed local storage.</p>
    <section id="loading" class="panel">Establishing a one-time local setup session…</section>
    <form id="setup-form" class="panel" hidden autocomplete="off">
      <h2>Local authorization</h2>
      <dl id="scope"></dl>
      <label for="coral-key">Coral API key</label>
      <input id="coral-key" name="coral-key" type="password" required autocomplete="off" spellcheck="false">
      <p class="hint">Sent only to this loopback process, checked with registry and model-catalogue GET requests, then stored in a private local file using POSIX mode 0600 or the Windows user-profile ACL. It is not an OS keychain, and is never placed in the URL, Codex transcript, logs, or browser storage.</p>
      <label class="choice"><input id="provision-runtime" type="checkbox" checked> Provision the latest stable public Coral Server release with recorded SHA-256 verification (about 110 MB)</label>
      <label class="choice"><input id="browser-open" type="checkbox"> Let Refinery request the graph UI after graph changes</label>
      <button type="submit">Verify and finish setup</button>
      <p id="status" role="status" aria-live="polite"></p>
    </form>
    <section id="complete" class="panel" hidden>
      <h2>Refinery is connected.</h2>
      <p>You can close this tab. Codex will run the final readiness check and show the graph UI.</p>
      <pre id="readiness"></pre>
    </section>
  </main>
  <script src="/setup.js" type="module"></script>
</body>
</html>
`;
const setupCss = `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#18212f;background:#f0f2ee;color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 70% 0,#dbe7ff 0,transparent 38%),#f0f2ee}main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:64px 0 80px}.eyebrow{font:700 12px ui-monospace,monospace;letter-spacing:.18em;color:#43607e}h1{font-size:clamp(40px,7vw,72px);line-height:.98;letter-spacing:-.055em;margin:12px 0 24px;max-width:720px}.lede{font-size:19px;line-height:1.55;color:#4c5b6b;max-width:680px}.panel{margin-top:32px;padding:28px;border:1px solid #c6ced3;background:rgba(255,255,255,.76);box-shadow:0 18px 60px rgba(26,40,58,.08)}h2{margin-top:0;font-size:24px}dl{display:grid;grid-template-columns:130px 1fr;gap:8px 16px;margin:0 0 24px;padding:16px;background:#edf1f4;font:13px ui-monospace,monospace}dt{color:#647487}dd{margin:0;overflow-wrap:anywhere}label{display:block;font-weight:700;margin:18px 0 8px}input[type=password]{width:100%;padding:13px;border:1px solid #8b99a6;background:white;font:16px ui-monospace,monospace}.choice{display:flex;gap:10px;align-items:flex-start;font-weight:500}.hint{font-size:13px;line-height:1.5;color:#607080}button{margin-top:22px;border:0;background:#18212f;color:white;padding:13px 18px;font-weight:750;font-size:15px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}#status{min-height:22px;color:#814329}pre{white-space:pre-wrap;font-size:12px;background:#18212f;color:#dce8f4;padding:16px;overflow:auto}@media(max-width:560px){main{padding-top:36px}.panel{padding:20px}dl{grid-template-columns:1fr}h1{font-size:44px}}`;
const setupJs = `let sessionToken = "";
const loading = document.querySelector("#loading");
const form = document.querySelector("#setup-form");
const complete = document.querySelector("#complete");
const status = document.querySelector("#status");
const keyInput = document.querySelector("#coral-key");
const capability = new URLSearchParams(location.hash.slice(1)).get("cap") || "";
history.replaceState(null, "", location.pathname);

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (sessionToken) headers.set("Authorization", "Bearer " + sessionToken);
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const value = await response.json().catch(() => ({ error: { message: "Invalid local response" } }));
  if (!response.ok) throw new Error(value.error?.message || "Local setup request failed");
  return value;
}

async function boot() {
  if (!capability) throw new Error("This one-time setup link has no capability. Ask Codex to run refinery setup start again.");
  const exchange = await request("/api/v1/session", { method: "POST", headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" }, body: "{}" });
  sessionToken = exchange.sessionToken;
  const setup = await request("/api/v1/setup");
  const scope = document.querySelector("#scope");
  scope.innerHTML = "<dt>Project</dt><dd></dd><dt>Canonical sources</dt><dd></dd><dt>Graph state</dt><dd></dd><dt>Credential</dt><dd></dd><dt>Coral model</dt><dd></dd>";
  const values = scope.querySelectorAll("dd");
  values[0].textContent = setup.project;
  values[1].textContent = setup.memoryHome.path + " (read-only)";
  values[2].textContent = setup.graph.path + " (Refinery-managed)";
  values[3].textContent = setup.credential.path + " (" + setup.credential.protection + ")";
  values[4].textContent = setup.model.selected.modelName + " (" + setup.model.selected.source + ") through Coral-coordinated specialists";
  document.querySelector("#browser-open").checked = Boolean(setup.ui?.browserOpenOnSync);
  loading.hidden = true;
  form.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  status.textContent = "Checking Coral authorization and local prerequisites…";
  const coralApiKey = keyInput.value;
  keyInput.value = "";
  try {
    const result = await request("/api/v1/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coralApiKey,
        storage: "private-file",
        provisionRuntime: document.querySelector("#provision-runtime").checked,
        browserOpenOnSync: document.querySelector("#browser-open").checked
      })
    });
    sessionToken = "";
    form.hidden = true;
    complete.hidden = false;
    document.querySelector("#readiness").textContent = JSON.stringify(result.setup.readyFor, null, 2);
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});

boot().catch((error) => { loading.textContent = error.message; });`;
export async function startSetupHttpServer(options) {
    const env = options.env ?? process.env;
    const expiresAtMs = Date.parse(options.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw new RefineryError("SETUP_LINK_EXPIRED", "Setup server expiration must be in the future.", { phase: "setup-server" });
    }
    let capabilityConsumed = false;
    let sessionHash = null;
    let expectedOrigin = "";
    let expectedHost = "";
    let closing = false;
    const server = http.createServer(async (request, response) => {
        try {
            if (request.headers.host !== expectedHost) {
                sendJson(response, 421, { ok: false, error: { code: "SETUP_HOST_REJECTED", message: "Host is not allowed." } });
                return;
            }
            const url = new URL(request.url ?? "/", expectedOrigin);
            const method = request.method ?? "GET";
            const stateChanging = method !== "GET" && method !== "HEAD";
            if (stateChanging && request.headers.origin !== expectedOrigin) {
                sendJson(response, 403, { ok: false, error: { code: "SETUP_ORIGIN_REJECTED", message: "Origin is not allowed." } });
                return;
            }
            if (Date.now() >= expiresAtMs) {
                sendJson(response, 410, { ok: false, error: { code: "SETUP_LINK_EXPIRED", message: "This setup session expired." } });
                void close();
                return;
            }
            if (url.pathname === "/internal/health") {
                if (method !== "GET" || request.headers["x-refinery-instance"] !== options.instanceId) {
                    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Not found." } });
                    return;
                }
                sendJson(response, 200, { ok: true, protocol: setupProtocolVersion, instanceId: options.instanceId, expiresAt: options.expiresAt });
                return;
            }
            if (url.pathname === "/internal/shutdown") {
                if (method !== "POST" || request.headers["x-refinery-instance"] !== options.instanceId) {
                    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Not found." } });
                    return;
                }
                sendJson(response, 200, { ok: true });
                setTimeout(() => void close(), 10);
                return;
            }
            if (url.pathname === "/" && method === "GET") {
                sendText(response, 200, "text/html; charset=utf-8", setupHtml);
                return;
            }
            if (url.pathname === "/setup.js" && method === "GET") {
                sendText(response, 200, "text/javascript; charset=utf-8", setupJs);
                return;
            }
            if (url.pathname === "/setup.css" && method === "GET") {
                sendText(response, 200, "text/css; charset=utf-8", setupCss);
                return;
            }
            if (url.pathname === "/api/v1/session") {
                if (method !== "POST") {
                    response.setHeader("Allow", "POST");
                    sendJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
                    return;
                }
                await readJsonBody(request);
                const capability = bearerToken(request);
                if (capabilityConsumed || !secureHashMatch(capability, options.capabilityHash)) {
                    sendJson(response, 401, { ok: false, error: { code: "SETUP_CAPABILITY_REJECTED", message: "Setup capability is invalid or already used." } });
                    return;
                }
                capabilityConsumed = true;
                const sessionToken = crypto.randomBytes(32).toString("base64url");
                sessionHash = hashToken(sessionToken);
                sendJson(response, 200, { ok: true, protocol: setupProtocolVersion, sessionToken, expiresAt: options.expiresAt });
                return;
            }
            const authorized = sessionHash !== null && secureHashMatch(bearerToken(request), sessionHash);
            if (!authorized) {
                sendJson(response, 401, { ok: false, error: { code: "SETUP_SESSION_REQUIRED", message: "A valid in-memory setup session is required." } });
                return;
            }
            if (url.pathname === "/api/v1/setup" && method === "GET") {
                sendJson(response, 200, { ok: true, protocol: setupProtocolVersion, ...inspectSetup({
                        home: options.home,
                        project: options.project,
                        codexHome: options.codexHome,
                        env,
                    }) });
                return;
            }
            if (url.pathname === "/api/v1/credentials/coral" && method === "DELETE") {
                removeStoredAuth("coral", { home: options.home, cwd: options.project, env });
                const receiptPath = resolveRefineryPaths({ home: options.home, cwd: options.project, env }).setupReceiptPath;
                fs.rmSync(receiptPath, { force: true });
                sendJson(response, 200, { ok: true, revoked: true });
                return;
            }
            if (url.pathname === "/api/v1/complete") {
                if (method !== "POST") {
                    response.setHeader("Allow", "POST");
                    sendJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
                    return;
                }
                const body = await readJsonBody(request);
                const allowedKeys = new Set(["coralApiKey", "storage", "provisionRuntime", "browserOpenOnSync"]);
                if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
                    throw new RefineryError("SETUP_FIELDS_INVALID", "Setup request contains unsupported fields.", { phase: "setup-server" });
                }
                if (typeof body.coralApiKey !== "string"
                    || !body.coralApiKey.trim()
                    || body.coralApiKey.length > 8_192
                    || body.storage !== "private-file"
                    || typeof body.provisionRuntime !== "boolean"
                    || typeof body.browserOpenOnSync !== "boolean") {
                    throw new RefineryError("SETUP_FIELDS_INVALID", "Setup request fields are invalid.", { phase: "setup-server" });
                }
                const selectedModel = resolveModelSelection({ home: options.home, cwd: options.project, env });
                const coral = await verifyCoralCredential({
                    apiKey: body.coralApiKey,
                    cloudApiUrl: env.CORAL_CLOUD_API_URL,
                    modelBaseUrl: env.REFINERY_MODEL_BASE_URL,
                    modelName: selectedModel.modelName,
                });
                writeStoredAuth("coral", body.coralApiKey, { home: options.home, cwd: options.project, env });
                writeSetupReceipt({ home: options.home, project: options.project, coral });
                if (body.provisionRuntime) {
                    await (options.provisionRuntime ?? provisionCoralRuntime)({
                        home: options.home,
                        cwd: options.project,
                        env,
                        confirmed: true,
                    });
                }
                writeUiConfig({ home: options.home, project: options.project, browserOpenOnSync: body.browserOpenOnSync });
                const setup = inspectSetup({ home: options.home, project: options.project, codexHome: options.codexHome, env });
                sessionHash = null;
                sendJson(response, 200, { ok: true, protocol: setupProtocolVersion, coral, setup });
                if (options.shutdownAfterComplete !== false)
                    setTimeout(() => void close(), 250);
                return;
            }
            sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Not found." } });
        }
        catch (error) {
            const refined = asRefineryError(error, { code: "SETUP_REQUEST_FAILED", phase: "setup-server" });
            sendJson(response, refined.code === "CORAL_AUTH_REJECTED" ? 401 : 400, {
                ok: false,
                error: { code: refined.code, message: refined.message, phase: refined.phase },
            });
        }
    });
    const close = async () => {
        if (closing)
            return;
        closing = true;
        await new Promise((resolve) => server.close(() => resolve()));
        options.onClosed?.();
    };
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    expectedHost = `127.0.0.1:${address.port}`;
    expectedOrigin = `http://${expectedHost}`;
    options.onListening?.({ host: "127.0.0.1", port: address.port, pid: process.pid });
    const expiryTimer = setTimeout(() => void close(), Math.max(1, expiresAtMs - Date.now()));
    expiryTimer.unref();
    server.once("close", () => clearTimeout(expiryTimer));
    return { server, baseUrl: expectedOrigin, close };
}
export function setupCapabilityHash(capability) {
    return hashToken(capability);
}
//# sourceMappingURL=server.js.map