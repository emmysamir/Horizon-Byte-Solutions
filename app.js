(function () {
  "use strict";

  var ALLOWED = [
    "Ai Automation Engineer (Junior)",
    "Data Analyst",
    "Customer Support Specialist"
  ];
  var MAX_BYTES = 5 * 1024 * 1024;
  var MIN_BYTES = 500;
  var TIMEOUT_MS = 70000;

  var $ = function (id) { return document.getElementById(id); };
  var form = $("applyForm");
  var submitBtn = $("submitBtn");
  var result = $("result");

  // ----- small UI helpers -----
  $("year").textContent = new Date().getFullYear();

  var menuBtn = $("menuBtn");
  var menu = $("menu");
  menuBtn.addEventListener("click", function () {
    var open = menu.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  menu.addEventListener("click", function (e) {
    if (e.target.tagName === "A") {
      menu.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    }
  });

  document.querySelectorAll("[data-role]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      $("position").value = btn.getAttribute("data-role");
      clearError("position");
      $("apply").scrollIntoView({ behavior: "smooth" });
      setTimeout(function () { $("fullName").focus({ preventScroll: true }); }, 500);
    });
  });

  var motivation = $("motivation");
  motivation.addEventListener("input", function () {
    $("count").textContent = motivation.value.length;
  });

  // ----- validation (mirrors the rules in the n8n Intake workflow) -----
  function setError(field, msg) {
    var el = $("err-" + field);
    el.textContent = msg;
    var wrap = el.closest(".field");
    if (wrap) wrap.classList.add("invalid");
  }
  function clearError(field) {
    var el = $("err-" + field);
    el.textContent = "";
    var wrap = el.closest(".field");
    if (wrap) wrap.classList.remove("invalid");
  }

  function readHeader(file) {
    return new Promise(function (resolve) {
      var r = new FileReader();
      r.onload = function () { resolve(String.fromCharCode.apply(null, new Uint8Array(r.result))); };
      r.onerror = function () { resolve(""); };
      r.readAsArrayBuffer(file.slice(0, 5));
    });
  }

  function fmtSize(n) {
    return n < 1024 * 1024 ? Math.round(n / 1024) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB";
  }

  async function validate() {
    var ok = true;
    ["fullName", "email", "position", "cv", "motivation"].forEach(clearError);

    var name = $("fullName").value.trim().replace(/\s+/g, " ");
    if (name.length < 3 || name.split(" ").length < 2 || !/^[\p{L} .'-]+$/u.test(name)) {
      setError("fullName", "Please enter your first and last name (letters only).");
      ok = false;
    }

    var email = $("email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setError("email", "Please enter a valid email address.");
      ok = false;
    }

    if (ALLOWED.indexOf($("position").value) === -1) {
      setError("position", "Please choose one of the listed roles.");
      ok = false;
    }

    if ($("motivation").value.trim().length > 1500) {
      setError("motivation", "Please keep this under 1500 characters.");
      ok = false;
    }

    var file = $("cv").files[0];
    if (!file) {
      setError("cv", "Please attach your CV as a PDF.");
      ok = false;
    } else if (!/\.pdf$/i.test(file.name)) {
      setError("cv", "Your CV must be a PDF file.");
      ok = false;
    } else if (file.size > MAX_BYTES) {
      setError("cv", "Your CV must be smaller than 5 MB (yours is " + fmtSize(file.size) + ").");
      ok = false;
    } else if (file.size < MIN_BYTES) {
      setError("cv", "This file looks empty or damaged.");
      ok = false;
    } else if ((await readHeader(file)) !== "%PDF-") {
      setError("cv", "This doesn't look like a real PDF file.");
      ok = false;
    }

    if (!ok) {
      var first = form.querySelector(".invalid input, .invalid select, .invalid textarea");
      if (first) first.focus();
    }
    return ok;
  }

  $("cv").addEventListener("change", function () {
    var f = this.files[0];
    $("fileInfo").textContent = f ? f.name + " · " + fmtSize(f.size) : "";
    clearError("cv");
  });
  ["fullName", "email", "position", "motivation"].forEach(function (id) {
    $(id).addEventListener("input", function () { clearError(id); });
  });

  // ----- result panel -----
  function showResult(kind, title, text) {
    form.hidden = true;
    result.hidden = false;
    result.className = "result " + kind;
    $("resultIcon").textContent = kind === "ok" ? "✓" : kind === "warn" ? "!" : "×";
    $("resultTitle").textContent = title;
    $("resultText").textContent = text;
    $("resultBtn").textContent = kind === "ok" ? "Submit another application" : "Back to the form";
    result.scrollIntoView({ behavior: "smooth", block: "center" });
    $("resultBtn").focus({ preventScroll: true });
  }
  $("resultBtn").addEventListener("click", function () {
    var wasOk = result.classList.contains("ok");
    result.hidden = true;
    form.hidden = false;
    if (wasOk) {
      form.reset();
      $("fileInfo").textContent = "";
      $("count").textContent = "0";
    }
    $("fullName").focus();
  });

  function setLoading(on) {
    submitBtn.disabled = on;
    submitBtn.classList.toggle("loading", on);
    submitBtn.querySelector(".btn-label").textContent = on ? "Sending…" : "Submit application";
  }

  // ----- submit to the Cloudflare Worker -----
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (submitBtn.disabled) return;
    if (!(await validate())) return;

    var url = (window.APP_CONFIG || {}).WORKER_URL || "";
    if (!/^https:\/\//.test(url) || /REPLACE/i.test(url)) {
      showResult("bad", "Site not configured yet",
        "The application endpoint hasn't been set up. Please try again later.");
      return;
    }

    var fd = new FormData();
    fd.append("fullName", $("fullName").value.trim().replace(/\s+/g, " "));
    fd.append("email", $("email").value.trim().toLowerCase());
    fd.append("position", $("position").value);
    fd.append("motivation", $("motivation").value.trim());
    fd.append("website", form.elements["website"].value); // honeypot
    fd.append("cv", $("cv").files[0]);

    setLoading(true);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);

    try {
      var res = await fetch(url, { method: "POST", body: fd, signal: ctrl.signal });
      var data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON */ }

      switch (data.status) {
        case "success":
          showResult("ok", "Application received",
            "Thank you! We received your CV and will reply by email within 48 hours.");
          break;
        case "duplicate":
          showResult("warn", "You've already applied",
            "We already have your application for this role. We will reply to your email within 48 hours.");
          break;
        case "invalid":
          showResult("bad", "Please check your application",
            data.message || "Some details need fixing. Please review the form and try again.");
          break;
        case "unconfirmed":
          showResult("warn", "Submitted, awaiting confirmation",
            "Your application was sent but we couldn't confirm it. Please check your email within 48 hours before applying again.");
          break;
        default:
          showResult("bad", "Something went wrong",
            data.message || "We couldn't send your application. Please try again in a few minutes.");
      }
    } catch (err) {
      var timedOut = err && err.name === "AbortError";
      showResult("bad", timedOut ? "That took too long" : "Connection problem",
        timedOut
          ? "The server didn't answer in time. Please try again shortly."
          : "We couldn't reach the server. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  });
})();
