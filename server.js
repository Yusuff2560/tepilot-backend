require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const OPENROUTER_API_KEY = process.env.openrouter_api_key || process.env.OPENROUTER_API_KEY;
const MODEL = "moonshotai/kimi-k2.6:free";

// ── Browser state ──────────────────────────────────────────────────────────
let browser = null;
let page = null;
let lastScreenshotHash = null;
let lastScreenshotB64 = null;
let screenshotClients = new Set(); // SSE clients

// ── Init browser on startup ────────────────────────────────────────────────
async function initBrowser() {
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--mute-audio",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      javaScriptEnabled: true,
      bypassCSP: true,
    });
    page = await context.newPage();

    // Block unnecessary resources for speed
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["font", "media"].includes(type)) return route.abort();
      return route.continue();
    });

    await page.goto("about:blank");
    console.log("Browser ready");

    // Start continuous screenshot loop
    startScreenshotLoop();
  } catch (err) {
    console.error("Browser init failed:", err);
    setTimeout(initBrowser, 3000);
  }
}

// ── Screenshot loop ────────────────────────────────────────────────────────
let screenshotLoopActive = false;

async function startScreenshotLoop() {
  if (screenshotLoopActive) return;
  screenshotLoopActive = true;

  while (screenshotLoopActive) {
    try {
      if (screenshotClients.size > 0 && page && !page.isClosed()) {
        const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
        const b64 = buf.toString("base64");

        // Simple hash to skip unchanged frames
        const hash = b64.slice(0, 64) + b64.slice(-64);
        if (hash !== lastScreenshotHash) {
          lastScreenshotHash = hash;
          lastScreenshotB64 = b64;
          broadcastScreenshot(b64);
        }
      }
    } catch { /* page might be navigating */ }

    // Adaptive delay: fast when clients connected, slow otherwise
    await sleep(screenshotClients.size > 0 ? 800 : 3000);
  }
}

function broadcastScreenshot(b64) {
  const payload = `data: ${b64}\n\n`;
  for (const client of screenshotClients) {
    try { client.write(payload); } catch { screenshotClients.delete(client); }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── SSE endpoint for live screenshot stream ────────────────────────────────
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  screenshotClients.add(res);

  // Send last known frame immediately
  if (lastScreenshotB64) {
    res.write(`data: ${lastScreenshotB64}\n\n`);
  }

  req.on("close", () => {
    screenshotClients.delete(res);
  });
});

// ── Browser actions ────────────────────────────────────────────────────────
async function executeAction(action, params) {
  if (!page || page.isClosed()) throw new Error("Browser not ready");

  switch (action) {
    case "navigate": {
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await sleep(400); // let page settle
      return `Navigated to ${params.url}`;
    }
    case "click": {
      await page.click(params.selector, { timeout: 5000 });
      await sleep(300);
      return `Clicked ${params.selector}`;
    }
    case "type": {
      await page.fill(params.selector, params.text);
      return `Typed "${params.text}" into ${params.selector}`;
    }
    case "scroll": {
      await page.evaluate(({ x, y }) => window.scrollBy(x, y), params);
      await sleep(200);
      return `Scrolled`;
    }
    case "press": {
      await page.keyboard.press(params.key);
      await sleep(200);
      return `Pressed ${params.key}`;
    }
    case "get_content": {
      const text = await page.evaluate(() => document.body.innerText);
      return text.slice(0, 5000);
    }
    case "get_url":
      return page.url();
    case "wait":
      await sleep(params.ms || 1000);
      return "Waited";
    default:
      return "Unknown action";
  }
}

// ── Groq chat ──────────────────────────────────────────────────────────────
async function groqChat(messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://tepilot-frontend.vercel.app",
      "X-Title": "TePilot",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 4096,
      temperature: 0.6,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.choices[0].message.content;
}

// ── Chat endpoint ──────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    const systemPrompt = `You are TePilot, an autonomous AI agent controlling a real web browser. Complete tasks FULLY and AUTONOMOUSLY.

CRITICAL RULES:
- NEVER say "I will do X" without immediately doing it with an action block
- NEVER stop midway or ask for confirmation - complete the entire task
- Chain ALL necessary actions one after another
- Only give your final summary AFTER all actions are complete

Browser actions:
<action>{"action": "navigate", "params": {"url": "https://..."}}</action>
<action>{"action": "click", "params": {"selector": "CSS_SELECTOR"}}</action>
<action>{"action": "type", "params": {"selector": "CSS_SELECTOR", "text": "TEXT"}}</action>
<action>{"action": "press", "params": {"key": "Enter"}}</action>
<action>{"action": "scroll", "params": {"x": 0, "y": 500}}</action>
<action>{"action": "get_content", "params": {}}</action>
<action>{"action": "get_url", "params": {}}</action>
<action>{"action": "wait", "params": {"ms": 1000}}</action>

Example task "search cats on google":
<action>{"action": "navigate", "params": {"url": "https://google.com"}}</action>
<action>{"action": "type", "params": {"selector": "input[name=q]", "text": "cats"}}</action>
<action>{"action": "press", "params": {"key": "Enter"}}</action>
<action>{"action": "get_content", "params": {}}</action>

Always respond in the user language.`;

    const groqMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    let responseText = await groqChat(groqMessages);
    let iterations = 0;

    while (iterations < 20) {
      const match = /<action>([\s\S]*?)<\/action>/.exec(responseText);
      if (!match) break;
      iterations++;

      try {
        const actionData = JSON.parse(match[1].trim());
        const result = await executeAction(actionData.action, actionData.params);

        groqMessages.push({ role: "assistant", content: responseText });
        groqMessages.push({ role: "user", content: `Action result: ${result}` });
        responseText = await groqChat(groqMessages);
      } catch (e) {
        groqMessages.push({ role: "assistant", content: responseText });
        groqMessages.push({ role: "user", content: `Action failed: ${e.message}` });
        responseText = await groqChat(groqMessages);
        break;
      }
    }

    const finalResponse = responseText.replace(/<action>[\s\S]*?<\/action>/g, "").trim();
    res.json({ response: finalResponse });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    browser: browser ? "ready" : "starting",
    clients: screenshotClients.size,
  });
});

const PORT = process.env.PORT || process.env.port || 7860;
app.listen(PORT, async () => {
  console.log(`TePilot running on ${PORT}`);
  await initBrowser();
});
