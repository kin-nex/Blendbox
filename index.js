// Helper to strip HTML tags and condense whitespace
function stripHTML(str) {
	return (str || "")
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

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

// CLI roaster filter argument
const ROASTER_FILTER = process.argv[2]?.toLowerCase() || null;
const MAX_COUNT = process.argv[3] ? parseInt(process.argv[3], 10) : null;
const DEBUG = process.argv.includes("--debug");

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
	if (ROASTER_FILTER) {
		console.log(`Applying roaster filter: ${ROASTER_FILTER}`);
	}
	if (MAX_COUNT) {
		console.log(`Limiting to first ${MAX_COUNT} products`);
	}

	const notionData = await fetchNotionCatalog();
	const items = filterSellingItems(notionData);
	const limitedItems = MAX_COUNT ? items.slice(0, MAX_COUNT) : items;

	const results = [];

	// Batch + concurrency limit
	const queue = [...limitedItems];
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

	// Keep track of screenshot so we can still attach it even if later steps fail
	let lastScreenshotBase64 = null;

	try {
		const result = await fetchPageHTML(item.url);
		if (result.screenshotBase64) {
			lastScreenshotBase64 = result.screenshotBase64;
		}

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
				ai_reason: stripHTML(
					"Screenshot missing — page may not have loaded or blocked early",
				),
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
				ai_reason: stripHTML(result.reason || "Page blocked or unavailable"),
				screenshotBase64: result.screenshotBase64,
			};
		}

		const ai = await askChatGPT(result.html, item.url, result.screenshotBase64);

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
			ai_reason: stripHTML(ai.reason),
			screenshotBase64: result.screenshotBase64,
		};
	} catch (err) {
		if (DEBUG) {
			console.error(
				"[AI DEBUG] checkOneItem caught error for",
				item.url,
				":",
				err,
			);
		}

		if (DEBUG && err?.response) {
			console.error(
				"[AI DEBUG] HTTP status from AI call:",
				err.response.status,
			);
			console.error(
				"[AI DEBUG] Response data from AI call:",
				JSON.stringify(err.response.data),
			);
		}

		const rawErr = stripHTML(err?.message || "");
		const truncatedErr = rawErr.slice(0, 300);
		console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 ${item.roaster} — ${item.name}
❗ Status: ERROR
📝 Reason (analysis / ChatGPT failure): ${truncatedErr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

		const screenshotBase64 = lastScreenshotBase64;
		return {
			...item,
			ai_status: "error",
			ai_reason: rawErr
				? `ChatGPT / analysis failed: ${truncatedErr}`
				: "ChatGPT / analysis failed (no error message)",
			screenshotBase64,
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
				"--window-size=1280,2000",
			],
		});
	}
	return browser;
}

// Generic hydration wait helper — waits for DOM to stop changing
async function waitForDomToSettle(page, maxMs = 8000, quietMs = 1200) {
	const start = Date.now();
	let lastHtmlLength = 0;
	let lastChange = Date.now();

	while (Date.now() - start < maxMs) {
		const htmlLength = await page.evaluate(
			() => document.documentElement.outerHTML.length,
		);

		if (htmlLength !== lastHtmlLength) {
			lastHtmlLength = htmlLength;
			lastChange = Date.now();
		}

		if (Date.now() - lastChange > quietMs) break;

		await page.waitForTimeout(250);
	}
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

	// Helper to safely take a screenshot and compress it to base64 (webp)
	async function safeScreenshot() {
		try {
			const buf = await page.screenshot({ fullPage: true });
			const compressed = await sharp(buf)
				.resize({ width: 600 })
				.webp({ quality: 30 })
				.toBuffer();
			return compressed.toString("base64");
		} catch {
			return null;
		}
	}

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
	} catch (err) {
		// fallback attempt
		try {
			resp = await page.goto(url, {
				waitUntil: "load",
				timeout: 20000,
			});
		} catch (err2) {
			const screenshotBase64 = await safeScreenshot();
			await context.close();
			return {
				blocked: true,
				html: "",
				screenshotBase64,
				reason: "Navigation failed twice (early block or timeout)",
			};
		}
	}

	// --- SCROLL PATCH FOR LAZY / SCROLL-REVEAL HYDRATION ---
	try {
		// Progressive scroll to trigger PageFly / ScrollReveal / lazy components
		for (let i = 0; i < 6; i++) {
			await page.evaluate(() => {
				window.scrollBy(0, window.innerHeight);
			});
			await page.waitForTimeout(350);
		}

		// Scroll back to top so screenshot starts at correct position
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.waitForTimeout(300);
	} catch (e) {
		if (DEBUG) console.error("[AI DEBUG] Scroll hydration failed:", e.message);
	}

	// Generic hydration wait before waiting for DOM to settle
	try {
		await Promise.race([
			page.waitForSelector('button:has-text("Add")', { timeout: 5000 }),
			page.waitForSelector("*:text-matches(/£|€|\\$/i)", { timeout: 5000 }),
			page.waitForSelector("form input", { timeout: 5000 }),
			page.waitForTimeout(5000),
		]);
	} catch {}

	// Wait for hydration / DOM stability (works for Shopify, Wix, Squarespace, custom sites)
	await waitForDomToSettle(page);

	if (!resp) {
		const screenshotBase64 = await safeScreenshot();
		await context.close();
		return {
			blocked: true,
			html: "",
			screenshotBase64,
			reason: "Navigation failed (no response)",
		};
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
			.resize({ width: 600 })
			.webp({ quality: 30 })
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
			.resize({ width: 600 })
			.webp({ quality: 30 })
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
			.resize({ width: 600 })
			.webp({ quality: 30 })
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
		.resize({ width: 600 })
		.webp({ quality: 30 })
		.toBuffer();
	const screenshotBase64 = compressed.toString("base64");
	await context.close();
	return { blocked: false, html, screenshotBase64 };
}

// -----------------------------
// AI ANALYSIS (ChatGPT)
// -----------------------------
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askChatGPT(html, url, screenshotBase64) {
	if (DEBUG)
		console.log(
			"[AI DEBUG] Starting askChatGPT for URL:",
			url,
			"raw HTML length:",
			(html || "").length,
		);

	let cleanedHtml;
	try {
		cleanedHtml = await minify(html || "", {
			collapseWhitespace: true,
			removeComments: true,

			minifyCSS: true,
			minifyJS: true,

			removeRedundantAttributes: false,
			removeScriptTypeAttributes: false,
			removeStyleLinkTypeAttributes: false,
			collapseBooleanAttributes: false,
			sortAttributes: false,
			sortClassName: false,
			decodeEntities: false,
			keepClosingSlash: true,
		});
		if (DEBUG)
			console.log("[AI DEBUG] Minified HTML length:", cleanedHtml.length);
	} catch (err) {
		if (DEBUG) {
			console.error(
				"[AI DEBUG] HTML minify failed, falling back to raw HTML:",
				err?.message,
			);
		}
		cleanedHtml = html || "";
	}

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
INPUT DATA
--------------------------------------

URL: ${url}

Below is raw HTML of the fetched page (may be truncated):
IMPORTANT: The HTML may be malformed or truncated — you must still attempt best-effort classification.

${cleanedHtml.slice(0, 30000)}
`;

	if (DEBUG) console.log("[AI DEBUG] Prompt length:", prompt.length);
	// --- CLEANED HTML STATS DEBUG ---
	if (DEBUG) {
		console.log("[AI DEBUG] --- CLEANED HTML STATS ---");
		console.log("[AI DEBUG] Cleaned HTML length:", cleanedHtml.length);
		console.log("[AI DEBUG] First 1500 chars of cleaned HTML:");
		console.log(cleanedHtml.slice(0, 1500));
		console.log("[AI DEBUG] Last 1500 chars of cleaned HTML:");
		console.log(cleanedHtml.slice(-1500));
	}
	// --- GPT PROMPT DEBUG ---
	if (DEBUG) {
		console.log("[AI DEBUG] --- GPT PROMPT (FIRST 2000 CHARS) ---");
		console.log(prompt.slice(0, 2000));
		console.log("[AI DEBUG] --- GPT PROMPT (LAST 2000 CHARS) ---");
		console.log(prompt.slice(-2000));
	}

	const maxRetries = 3;
	let attempt = 0;

	while (true) {
		try {
			const res = await axiosClient.post(
				"https://api.openai.com/v1/chat/completions",
				{
					model: "gpt-5-nano",
					response_format: { type: "json_object" },
					service_tier: "flex",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: prompt },
								...(screenshotBase64
									? [
											{
												type: "image_url",
												image_url: {
													url: `data:image/webp;base64,${screenshotBase64}`,
												},
											},
										]
									: []),
							],
						},
					],
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
						"Content-Type": "application/json",
					},
				},
			);

			const content = res.data?.choices?.[0]?.message?.content;
			if (DEBUG)
				console.log("[AI DEBUG] Raw ChatGPT response content:", content);

			try {
				const parsed = JSON.parse(content);
				if (DEBUG) console.log("[AI DEBUG] Parsed ChatGPT JSON:", parsed);
				return parsed;
			} catch (parseErr) {
				if (DEBUG) {
					console.error(
						"[AI DEBUG] JSON.parse failed on ChatGPT content:",
						parseErr?.message,
					);
				}
				return {
					status: "uncertain",
					reason: `Invalid AI JSON. Raw content: ${String(content).slice(
						0,
						500,
					)}`,
				};
			}
		} catch (err) {
			const status = err?.response?.status;
			if (status === 429 && attempt < maxRetries) {
				const delayMs = 2000 * 2 ** attempt; // 2s, 4s, 8s
				if (DEBUG) {
					console.error(
						"[AI DEBUG] Received 429 Too Many Requests, retrying in",
						delayMs,
						"ms (attempt",
						attempt + 1,
						"of",
						maxRetries,
						")",
					);
				}
				attempt += 1;
				await sleep(delayMs);
				continue;
			}

			if (DEBUG)
				console.error("[AI DEBUG] Error inside askChatGPT:", err?.message);
			if (DEBUG && err?.response) {
				console.error("[AI DEBUG] ChatGPT HTTP status:", err.response.status);
				console.error(
					"[AI DEBUG] ChatGPT error body:",
					JSON.stringify(err.response.data),
				);
			}
			// Re-throw so checkOneItem can see it
			throw err;
		}
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
		.filter((i) => i.selling && i.url)
		.filter((i) => {
			if (!ROASTER_FILTER) return true;
			return i.roaster.toLowerCase().includes(ROASTER_FILTER);
		});
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
