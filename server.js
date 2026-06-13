require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let browser = null;
let page = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

async function getPage() {
  const b = await getBrowser();
  if (!page || page.isClosed()) {
    const context = await b.newContext();
    page = await context.newPage();
  }
  return page;
}

async function executeAction(action, params) {
  const p = await getPage();

  switch (action) {
    case "navigate":
      await p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      return `Navigated to ${params.url}`;

    case "screenshot": {
      const buf = await p.screenshot({ type: "jpeg", quality: 60 });
      return buf.toString("base64");
    }

    case "click":
      await p.click(params.selector);
      return `Clicked ${params.selector}`;

    case "type":
      await p.fill(params.selector, params.text);
      return `Typed "${params.text}" into ${params.selector}`;

    case "get_content": {
      const content = await p.evaluate(() => document.body.innerText);
      return content.slice(0, 3000);
    }

    case "get_url":
      return p.url();

    default:
      return "Unknown action";
  }
}

app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = `You are TePilot, an AI agent that can control a web browser. 
You have access to browser actions. When you need to use the browser, respond with a JSON action block like this:

<action>
{"action": "navigate", "params": {"url": "https://example.com"}}
</action>

Available actions:
- navigate: {"action": "navigate", "params": {"url": "..."}}
- screenshot: {"action": "screenshot", "params": {}}
- click: {"action": "click", "params": {"selector": "..."}}
- type: {"action": "type", "params": {"selector": "...", "text": "..."}}
- get_content: {"action": "get_content", "params": {}}
- get_url: {"action": "get_url", "params": {}}

After getting a screenshot or content, analyze it and respond to the user.
If no browser action is needed, just respond normally.
Always respond in the same language the user used.`;

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Anladım, TePilot olarak hazırım!" }] },
        ...history,
      ],
    });

    const lastMessage = messages[messages.length - 1].content;
    let result = await chat.sendMessage(lastMessage);
    let responseText = result.response.text();

    // Check for action blocks and execute them
    const actionRegex = /<action>([\s\S]*?)<\/action>/g;
    let match;
    let finalResponse = responseText;
    let iterations = 0;

    while ((match = actionRegex.exec(responseText)) !== null && iterations < 5) {
      iterations++;
      try {
        const actionData = JSON.parse(match[1].trim());
        const actionResult = await executeAction(actionData.action, actionData.params);

        let followUpContent;
        if (actionData.action === "screenshot") {
          followUpContent = `Screenshot taken (base64 image). Describe what you see and help the user. Image data: [screenshot captured, ${actionResult.length} chars]`;
        } else {
          followUpContent = `Action result: ${actionResult}. Now respond to the user based on this result.`;
        }

        result = await chat.sendMessage(followUpContent);
        finalResponse = result.response.text();
        responseText = finalResponse;
        actionRegex.lastIndex = 0;
      } catch (e) {
        console.error("Action error:", e);
      }
    }

    res.json({ response: finalResponse });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "TePilot Backend is running!" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`TePilot Backend running on port ${PORT}`);
});
