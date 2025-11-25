import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import axios from "axios";
import dotenv from "dotenv";
import { minify } from "html-minifier-terser";
import fetch from "node-fetch";
import { chromium } from "playwright";
import sharp from "sharp";

dotenv.config();

const CONCURRENCY = 1;

const axiosClient = axios.create({
	httpAgent: new http.Agent({ keepAlive: false }),
	httpsAgent: new https.Agent({ keepAlive: false }),
});

// -----------------------------
// MAIN ENTRY POINT
// -----------------------------
async function main() {
	console.log("Starting Product Check…");

	const notionData = await fetchNotionCatalog();
	const items = filterSellingItems(notionData);

	const results = [];

	// Batch + concurrency limit
	const queue = [...items];
	const active = [];

	while (queue.length > 0 || active.length > 0) {
		while (active.length < CONCURRENCY && queue.length > 0) {
			const item = queue.shift();
			const promise = checkOneItem(item).then((result) => {
				results.push(result);
				active.splice(active.indexOf(promise), 1);
			});
			active.push(promise);
		}

		await Promise.race(active);
	}

	await sendSummaryEmail(results);

	console.log("All done.");
}

// -----------------------------
// CHECK ONE PRODUCT
// -----------------------------
async function checkOneItem(item) {
	console.log(`${item.roaster} — ${item.name} (${item.url})`);

	try {
		const result = await fetchPageHTML(item.url);

		// Detect missing screenshot — treat as error
		if (!result.screenshotBase64) {
			console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 ${item.roaster} — ${item.name}
❗ Status: ERROR
📝 Reason: Screenshot missing (page may not have loaded or was blocked)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
			return {
				...item,
				ai_status: "error",
				ai_reason:
					"Screenshot missing — page may not have loaded or blocked early",
				screenshotBase64: null,
			};
		}

		if (result.blocked) {
			console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 ${item.roaster} — ${item.name}
⚠️ Status: UNCERTAIN
📝 Reason: ${result.reason}
📸 Screenshot: ${result.screenshotBase64 ? "Embedded" : "Missing"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
			return {
				...item,
				ai_status: "uncertain",
				ai_reason: result.reason,
				screenshotBase64: result.screenshotBase64,
			};
		}

		const ai = await askDeepseek(result.html, item.url);

		console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 ${item.roaster} — ${item.name}
🏷️ Status: ${ai.status.toUpperCase()}
📝 Reason: ${ai.reason}
📸 Screenshot: ${result.screenshotBase64 ? "Embedded" : "Missing"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
		return {
			...item,
			ai_status: ai.status,
			ai_reason: ai.reason,
			screenshotBase64: result.screenshotBase64,
		};
	} catch (err) {
		console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 ${item.roaster} — ${item.name}
❗ Status: ERROR
📝 Reason: ${err.message}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
		return {
			...item,
			ai_status: "error",
			ai_reason: err.message || "Unknown error",
			screenshotBase64: null,
		};
	}
}

// -------------------------------------------
// CRAWLING VIA PLAYWRIGHT (headless Chromium)
// -------------------------------------------

let browser = null;

async function getPage() {
	if (!browser) {
		browser = await chromium.launch({
			headless: true,
			args: [
				"--disable-blink-features=AutomationControlled",
				"--disable-dev-shm-usage",
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-infobars",
				"--disable-web-security",
				"--disable-features=IsolateOrigins,site-per-process",
				"--disable-blink-features",
				"--window-size=1280,2000",
			],
		});
	}
	return browser;
}

async function fetchPageHTML(url) {
	// Screenshot file path logic is no longer needed; all screenshots are in-memory base64

	const browser = await getPage();
	const context = await browser.newContext({
		viewport: { width: 1280, height: 4000 },
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
	});
	const page = await context.newPage();
	await page.setDefaultNavigationTimeout(30000);
	await page.setDefaultTimeout(30000);

	// Inject your anti-stealth script into this *context*
	await context.addInitScript(() => {
		Object.defineProperty(navigator, "webdriver", { get: () => undefined });

		window.chrome = { runtime: {} };

		Object.defineProperty(navigator, "languages", {
			get: () => ["en-US", "en"],
		});

		Object.defineProperty(navigator, "plugins", {
			get: () => [1, 2, 3, 4],
		});

		const getParameter = WebGLRenderingContext.prototype.getParameter;
		WebGLRenderingContext.prototype.getParameter = (parameter) => {
			if (parameter === 37445) return "Intel Inc.";
			if (parameter === 37446) return "Intel(R) UHD Graphics";
			return getParameter(parameter);
		};

		const originalGetContext = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (type, attrs) {
			const ctx = originalGetContext.apply(this, [type, attrs]);
			if (!ctx) return ctx;

			const getImageData = ctx.getImageData;
			ctx.getImageData = function (x, y, w, h) {
				const data = getImageData.apply(this, [x, y, w, h]);
				data.data[0] = data.data[0] ^ 1;
				return data;
			};

			return ctx;
		};

		const originalEnumerate = MediaDevices.prototype.enumerateDevices;
		MediaDevices.prototype.enumerateDevices = function () {
			try {
				return Promise.resolve([
					{ kind: "audioinput", label: "Built-in Microphone", deviceId: "A1" },
					{ kind: "audiooutput", label: "MacBook Speakers", deviceId: "A2" },
					{ kind: "videoinput", label: "FaceTime HD Camera", deviceId: "A3" },
				]);
			} catch (e) {
				return originalEnumerate.apply(this, arguments);
			}
		};
	});

	let resp;

	try {
		resp = await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: 20000,
		});
	} catch {
		// fallback for slow or bot-blocking pages
		resp = await page.goto(url, {
			waitUntil: "load",
			timeout: 20000,
		});
	}

	// Give Shopify JS time to render critical UI
	await page.waitForTimeout(1500);

	if (!resp) {
		await context.close();
		throw new Error("Navigation failed (no response)");
	}

	const status = resp.status();

	// Treat HTTP error statuses as unavailable product pages
	if ([403, 404, 410].includes(status)) {
		const html = await page.content();
		const screenshotBuffer = await page.screenshot({
			fullPage: true,
			clip: { x: 0, y: 0, width: 1280, height: 2000 },
		});
		const compressed = await sharp(screenshotBuffer)
			.webp({ quality: 60 })
			.toBuffer();
		const screenshotBase64 = compressed.toString("base64");

		await context.close();
		return {
			blocked: true,
			html,
			screenshotBase64,
			reason: `HTTP ${status} (unavailable or missing product page)`,
		};
	}

	// -------- BLOCK PAGE CHECK --------
	if (status >= 400) {
		const html = await page.content();
		const screenshotBuffer = await page.screenshot({
			fullPage: true,
			clip: { x: 0, y: 0, width: 1280, height: 2000 },
		});
		const compressed = await sharp(screenshotBuffer)
			.webp({ quality: 60 })
			.toBuffer();
		const screenshotBase64 = compressed.toString("base64");
		await context.close();
		return {
			blocked: true,
			html,
			screenshotBase64,
			reason: `HTTP ${status} (blocked or error page)`,
		};
	}

	const html = await page.content();

	// Take screenshot
	const screenshotBuffer = await page.screenshot({
		fullPage: true,
		clip: { x: 0, y: 0, width: 1280, height: 2000 },
	});

	// Additional HTML-level bot-block detection
	const lower = html.toLowerCase();

	const blockIndicators = [
		"cf-browser-verification",
		"/cdn-cgi/challenge",
		"attention required",
		"access denied",
		"request blocked",
		"too many requests",
		"bot detection",
		"pardon our interruption",
	];

	if (blockIndicators.some((s) => lower.includes(s))) {
		const htmlCapture = html;
		const compressed = await sharp(screenshotBuffer)
			.webp({ quality: 60 })
			.toBuffer();
		const screenshotBase64 = compressed.toString("base64");
		await context.close();
		return {
			blocked: true,
			html: htmlCapture,
			screenshotBase64,
			reason: "Detected bot-block or challenge page",
		};
	}

	const compressed = await sharp(screenshotBuffer)
		.webp({ quality: 60 })
		.toBuffer();
	const screenshotBase64 = compressed.toString("base64");
	await context.close();
	return { blocked: false, html, screenshotBase64 };
}

// -----------------------------
// AI ANALYSIS (DEEPSEEK)
// -----------------------------
async function askDeepseek(html, url) {
	const cleanedHtml = await minify(html || "", {
		collapseWhitespace: true,
		removeComments: true,

		minifyCSS: true,
		minifyJS: true,

		// KEEP all attributes & ordering
		removeRedundantAttributes: false,
		removeScriptTypeAttributes: false,
		removeStyleLinkTypeAttributes: false,
		collapseBooleanAttributes: false,
		sortAttributes: false,
		sortClassName: false,

		// Do not decode or reformat entities
		decodeEntities: false,

		// Preserve structure
		keepClosingSlash: true,
	});
	const prompt = `
You are an expert product-page auditor for e-commerce websites (primarily Shopify, WooCommerce, Squarespace, and custom stores).

Your job is to determine whether a product is CURRENTLY PURCHASABLE.

You MUST return ONLY valid JSON in this exact structure:

{
  "status": "available" | "unavailable" | "uncertain",
  "reason": "short explanation in plain English"
}

NO extra text, no commentary, only JSON.

--------------------------------------
RULES FOR CLASSIFICATION
--------------------------------------

### 1. "available"
Choose **available** only when ALL of the following are true:

- The page clearly represents a **specific product page** (not a collection, not a blog post, not a category).
- A **purchase action** is clearly present, such as:
  - "Add to cart"
  - "Add to bag"
  - "Add to basket"
  - "Buy now"
  - "Subscribe" (if this refers to buying a subscription coffee product)
  - A button allowing the user to select a variant and purchase

AND:

- There is a **price** displayed OR a price selector for variants.

### 2. "unavailable"
Choose **unavailable** when ANY of the following are true:

- The page shows explicit unavailability indicators:
  - "Sold out"
  - "Out of stock"
  - "Unavailable"
  - "Currently unavailable"
  - A disabled purchase button
  - "No longer available"
  - "Product not found"
- The page is **not the correct product page**:
  - Redirects to a collection or homepage
  - Shows multiple products instead of one item
  - It is a blog article or content page
  - It is a 404, 410, or empty state page
  - Price or purchase button is completely missing and the page clearly is not purchasable

### 3. "uncertain"
Use **uncertain** ONLY when BOTH are true:

- The page seems to be a product page (has product title, description, etc.)
- But you cannot confidently determine availability because:
  - The HTML is incomplete, broken, or truncated BUT you can still identify it as a product page without clear purchase indicators
  - Content is ambiguous
  - Price exists but purchase options are unclear
  - "Add to cart" may be dynamically inserted and is not visible in the HTML snippet
  - No explicit sold-out indicators, but also no purchase button visible

If you are missing essential elements and cannot make a confident judgment, choose **uncertain**.

--------------------------------------
IMPORTANT LOGIC RULES
--------------------------------------

- If the page is **not a real product page**, the result is **unavailable** (NOT uncertain).
- If the product title appears but the page looks like a **collection grid**, classify as **unavailable**.
- If the product clearly exists but HTML is too incomplete to see buy options → **uncertain**.
- If there is ANY clear "sold out" text → **unavailable**.
- If there is an "add to cart/bag/basket" OR a "buy now" visible → **available**.
- Use conservative judgment. When in doubt between available/unavailable,
  choose **uncertain**, NOT available.
- Do NOT choose "uncertain" solely because HTML is malformed or incomplete — make a best‑effort judgment using whatever product signals remain.

--------------------------------------
INPUT DATA
--------------------------------------

URL: ${url}

Below is raw HTML of the fetched page (may be truncated):
IMPORTANT: The HTML may be malformed or truncated — you must still attempt best‑effort classification.

${cleanedHtml.slice(0, 30000)}
`;

	const res = await axiosClient.post(
		"https://api.deepseek.com/v1/chat/completions",
		{
			model: "deepseek-chat",
			temperature: 0,
			messages: [{ role: "user", content: prompt }],
		},
		{
			headers: {
				Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
				"Content-Type": "application/json",
			},
		},
	);

	try {
		return JSON.parse(res.data.choices[0].message.content);
	} catch {
		return { status: "uncertain", reason: "Invalid AI JSON" };
	}
}

// -----------------------------
// NOTION FETCH
// -----------------------------
async function fetchNotionCatalog() {
	const all = [];
	let cursor;

	while (true) {
		const res = await fetch(
			`https://api.notion.com/v1/databases/${process.env.NOTION_DB_ID}/query`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
					"Notion-Version": "2022-06-28",
					"Content-Type": "application/json",
					"X-Cache-Buster": Date.now().toString(),
				},
				body: JSON.stringify({
					start_cursor: cursor,
					filter: {
						property: "Name",
						title: { is_not_empty: true },
					},
				}),
			},
		);

		const data = await res.json();
		if (!res.ok) {
			throw new Error(`Failed to query Notion: ${JSON.stringify(data)}`);
		}

		all.push(...data.results);

		if (!data.has_more) break;
		cursor = data.next_cursor;
	}

	return { results: all };
}

function filterSellingItems(notionJson) {
	return notionJson.results
		.map((page) => {
			const props = page.properties;

			return {
				name: props.Name?.title?.[0]?.plain_text ?? "Unnamed",
				url: props["Link to product"]?.url ?? null,
				roaster: props.Roaster?.select?.name ?? "Unknown",
				selling: props["Selling?"]?.checkbox ?? false,
			};
		})
		.filter((i) => i.selling && i.url);
}

// -----------------------------
// EMAIL REPORT (RESEND)
// -----------------------------
async function sendSummaryEmail(results) {
	const unavailable = results.filter((r) => r.ai_status === "unavailable");
	const uncertain = results.filter((r) => r.ai_status === "uncertain");
	const available = results.filter((r) => r.ai_status === "available");
	const errors = results.filter((r) => r.ai_status === "error");

	const html = buildEmailHTML(unavailable, uncertain, available, errors);

	await axiosClient.post(
		"https://api.resend.com/emails",
		{
			from: "Blendbox Alerts <alerts@blendbox.coffee>",
			to: JSON.parse(process.env.ALERT_EMAILS),
			subject: "⚠️ Blendbox Product Report",
			html,
		},
		{
			headers: {
				Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
		},
	);
}

function buildEmailHTML(unavailable, uncertain, available, errors) {
	// Read and embed SVG logo
	const logoPath = path.join(process.cwd(), "logo.svg");
	let logoBase64 = "";
	try {
		const svgBuf = fs.readFileSync(logoPath);
		logoBase64 = `data:image/svg+xml;base64,${svgBuf.toString("base64")}`;
	} catch (e) {
		logoBase64 = "";
	}

	return `
    <div style="font-family: Montserrat, Verdana, Arial, sans-serif; padding: 20px; color: #333;">
      <div style="text-align:center; margin-bottom:25px;">
        <img src="${logoBase64}" alt="Blendbox" style="height:70px; margin-bottom:16px;" />
        <h1 style="margin:0px; font-size:28px;">Product Availability Report</h1>
      </div>

      <h2 style="color:#8e44ad; margin-top:35px;">🚨 Errors / Failed Checks</h2>
      ${buildTable(errors)}

      <h2 style="color:#c0392b;">❌ Unavailable Products</h2>
      ${buildTable(unavailable)}

      <h2 style="color:#f39c12; margin-top:35px;">⚠️ Uncertain Products</h2>
      ${buildTable(uncertain)}

      <h2 style="color:#27ae60; margin-top:35px;">✅ Available Products</h2>
      ${buildTable(available)}

      <div style="margin-top:40px; text-align:center; color:#888; font-size:12px;">
        <p>Blendbox Automated Monitor • Keeping your coffee lineup fresh ☕✨</p>
      </div>
    </div>
  `;
}

function buildTable(items) {
	if (!items.length) return "<p>None</p>";
	const isAvailableSection = items.every((i) => i.ai_status === "available");
	if (isAvailableSection) {
		return `
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Roaster</th><th>Name</th><th>Reason</th></tr>
        ${items
					.map(
						(i) => `<tr>
                <td>${i.roaster}</td>
                <td><a href="${i.url}">${i.name}</a></td>
                <td>${i.ai_reason}</td>
            </tr>`,
					)
					.join("")}
      </table>
    `;
	}

	return `
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Roaster</th><th>Name</th><th>Reason</th><th>Screenshot</th></tr>
        ${items
					.map(
						(i) => `<tr>
              <td>${i.roaster}</td>
              <td><a href="${i.url}">${i.name}</a></td>
              <td>${i.ai_reason}</td>
              <td>
                ${
									i.screenshotBase64
										? `<img src="data:image/webp;base64,${i.screenshotBase64}" style="max-width:250px;border:1px solid #ccc;" />`
										: "No screenshot"
								}
              </td>
            </tr>`,
					)
					.join("")}
      </table>
    `;
}

// -----------------------------
// RUN
// -----------------------------
main()
	.catch((err) => {
		console.error("Fatal error in main:", err);
	})
	.finally(async () => {
		if (browser) {
			await browser.close();
		}
	});
