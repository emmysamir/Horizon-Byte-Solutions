/**
 * Cloudflare Worker: secure proxy between the GitHub Pages site and the n8n Form Trigger.
 *
 * - Adds CORS headers (n8n itself is never changed).
 * - Sends the ngrok "skip browser warning" header so ngrok's interstitial page doesn't break requests.
 * - Re-maps clean field names to the field-0..field-4 names that n8n Form Triggers expect.
 * - Repeats the workflow's validation (cheap, stops junk before it reaches your laptop).
 * - Turns n8n's HTML answer into small JSON: success | duplicate | invalid | unconfirmed | error.
 *
 * Settings (Cloudflare dashboard > Worker > Settings > Variables):
 *   N8N_FORM_URL     e.g. https://your-name.ngrok-free.app/form/<form-id>   (TEST first, production later)
 *   ALLOWED_ORIGINS  e.g. https://YOURNAME.github.io   (comma-separated, no trailing slash, no path)
 *   DEBUG            optional, "1" returns a short snippet of n8n's reply to help troubleshooting
 * No secrets are stored here. N8N_FORM_URL is a public form address.
 */

const ALLOWED_POSITIONS = [
  "Ai Automation Engineer (Junior)",
  "Data Analyst",
  "Customer Support Specialist",
];
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 500;
const POLL_MS = 1500;
const POLL_TRIES = 14; // ~21 s waiting for n8n to finish its steps

// n8n names form inputs field-0, field-1 ... in the order the fields are defined in the Form Trigger.
// Order in your Intake workflow: Full name, email, position, cv, why do you want this job?
const FIELD = { name: "field-0", email: "field-1", position: "field-2", cv: "field-3", motivation: "field-4" };

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk ? origin : allowed[0] || "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ status: "error", message: "Method not allowed." }, 405);
    if (!originOk) return json({ status: "error", message: "Origin not allowed." }, 403);
    if (!env.N8N_FORM_URL) return json({ status: "error", message: "Server is not configured." }, 500);

    // Reject oversized bodies early.
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > MAX_BYTES + 200 * 1024) return json({ status: "invalid", message: "Your CV must be smaller than 5 MB." }, 413);

    let incoming;
    try { incoming = await request.formData(); }
    catch { return json({ status: "error", message: "Bad request." }, 400); }

    // Honeypot: pretend success so bots learn nothing.
    if (String(incoming.get("website") || "").trim() !== "") return json({ status: "success" });

    const name = String(incoming.get("fullName") || "").trim().replace(/\s+/g, " ");
    const email = String(incoming.get("email") || "").trim().toLowerCase();
    const position = String(incoming.get("position") || "").trim();
    const motivation = String(incoming.get("motivation") || "").trim();
    const cv = incoming.get("cv");

    const errors = [];
    if (name.length < 3 || name.split(" ").length < 2 || !/^[\p{L} .'-]+$/u.test(name)) errors.push("Please enter your first and last name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push("Please enter a valid email address.");
    if (!ALLOWED_POSITIONS.includes(position)) errors.push("Please choose one of the listed roles.");
    if (motivation.length > 1500) errors.push("Please keep your motivation under 1500 characters.");

    let cvBuf = null;
    if (!cv || typeof cv === "string") errors.push("Please attach your CV.");
    else {
      cvBuf = await cv.arrayBuffer();
      const head = new TextDecoder().decode(cvBuf.slice(0, 5));
      if (head !== "%PDF-") errors.push("Your CV must be a real PDF file.");
      if (cvBuf.byteLength > MAX_BYTES) errors.push("Your CV must be smaller than 5 MB.");
      if (cvBuf.byteLength < MIN_BYTES) errors.push("Your CV file looks empty or damaged.");
    }
    if (errors.length) return json({ status: "invalid", message: errors.join(" ") }, 400);

    // Build the request n8n's form expects.
    const out = new FormData();
    out.append(FIELD.name, name);
    out.append(FIELD.email, email);
    out.append(FIELD.position, position);
    out.append(FIELD.cv, new Blob([cvBuf], { type: "application/pdf" }), "cv.pdf");
    out.append(FIELD.motivation, motivation);

    const headers = { "ngrok-skip-browser-warning": "true", "User-Agent": "careers-site-proxy" };

    try {
      const first = await fetch(env.N8N_FORM_URL, { method: "POST", body: out, headers, redirect: "manual" });
      const base = new URL(env.N8N_FORM_URL);

      // n8n answers with a redirect or JSON pointing at /form-waiting/<executionId>; follow it until a page is final.
      let next = await nextUrl(first, base);
      let html = next ? "" : await first.text();

      for (let i = 0; next && i < POLL_TRIES; i++) {
        const r = await fetch(next, { headers, redirect: "manual" });
        const again = await nextUrl(r, base);
        if (again) { next = again; await sleep(POLL_MS); continue; }
        html = await r.text();
        const verdict = classify(html);
        if (verdict !== "pending") break;
        await sleep(POLL_MS);
      }

      if (first.status >= 500 && !html) return json({ status: "error", message: "The hiring system is unavailable right now. Please try again later." }, 502);

      const verdict = classify(html);
      const dbg = env.DEBUG === "1" ? { debug: strip(html).slice(0, 300) } : {};
      if (verdict === "success") return json({ status: "success", ...dbg });
      if (verdict === "duplicate") return json({ status: "duplicate", ...dbg });
      if (verdict === "invalid") return json({ status: "invalid", message: "Please check your details and try again.", ...dbg }, 422);
      return json({ status: "unconfirmed", ...dbg }, 202);
    } catch (e) {
      return json({ status: "error", message: "The hiring system is unreachable right now. Please try again later." }, 502);
    }
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Find where n8n wants us to go next (HTTP redirect, or a JSON body with a URL).
async function nextUrl(res, base) {
  // Always keep the path but force the host to the ngrok address we were configured with. n8n may report
  // http://localhost:5678/... if its WEBHOOK_URL isn't set, which Cloudflare can't reach.
  const rebase = (u) => {
    const x = new URL(u, base);
    return new URL(x.pathname + x.search, base.origin).toString();
  };
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) return rebase(loc);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      const body = await res.clone().json();
      const u = body.formWaitingUrl || body.redirectURL || body.redirectUrl;
      if (u) return rebase(u);
    } catch { /* ignore */ }
  }
  return null;
}

// Map the completion page text from the Intake workflow's Form nodes to an outcome.
// Order matters: the validation page also contains the words "Thank you for applying".
function classify(html) {
  const t = strip(html).toLowerCase();
  if (!t) return "pending";
  if (t.includes("please fix your application")) return "invalid";
  if (t.includes("you have already applied") || t.includes("we already have your application")) return "duplicate";
  if (t.includes("we received your cv")) return "success";
  if (t.includes("waiting for") || t.includes("form-waiting") || t.includes("processing")) return "pending";
  return "unknown";
}
