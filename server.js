require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = "llama-3.3-70b-versatile";

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
      return content.slice(0, 4000);
    }
    case "get_url":
      return p.url();
    default:
      return "Unknown action";
  }
}

async function groqChat(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 2048,
      temperature: 0.7,
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    const systemPrompt = `You are TePilot, an AI agent that can control a web browser.
When you need to use the browser, respond with a JSON action block like this:

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

After getting content or a screenshot result, analyze it and respond to the user.
If no browser action is needed, just respond normally.
Always respond in the same language the user used.`;

    const groqMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let responseText = await groqChat(groqMessages);
    let finalResponse = responseText;
    let iterations = 0;

    while (iterations < 5) {
      const actionRegex = /<action>([\s\S]*?)<\/action>/;
      const match = actionRegex.exec(responseText);
      if (!match) break;
      iterations++;

      try {
        const actionData = JSON.parse(match[1].trim());
        const actionResult = await executeAction(actionData.action, actionData.params);

        let followUpContent;
        if (actionData.action === "screenshot") {
          followUpContent = `Screenshot taken. Image is base64 encoded (${actionResult.length} chars). Based on the page, respond to the user's request.`;
        } else {
          followUpContent = `Browser action result: ${actionResult}`;
        }

        groqMessages.push({ role: "assistant", content: responseText });
        groqMessages.push({ role: "user", content: followUpContent });

        responseText = await groqChat(groqMessages);
        finalResponse = responseText;
      } catch (e) {
        console.error("Action error:", e);
        break;
      }
    }

    res.json({ response: finalResponse });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "TePilot Backend running with Groq + llama-3.3-70b!" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`TePilot Backend running on port ${PORT}`);
});
