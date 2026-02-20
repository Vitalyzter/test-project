const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const BASE_URL =
  "https://www.aruodas.lt/butai/vilniuje/?FAreaOverAllMin=80&FPriceMin=250000&FPriceMax=450000";
const DATA_DIR = path.join(__dirname, "data");
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");
const NEW_LISTINGS_FILE = path.join(DATA_DIR, "new_listings.json");

// n8n webhook URL — set via environment variable or .env file
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// Adjust this to your local Chrome/Chromium path
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/usr/bin/google-chrome" ||
  "/usr/bin/chromium-browser";

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPreviousListings() {
  if (fs.existsSync(LISTINGS_FILE)) {
    return JSON.parse(fs.readFileSync(LISTINGS_FILE, "utf8"));
  }
  return {};
}

function saveListings(listings) {
  fs.writeFileSync(LISTINGS_FILE, JSON.stringify(listings, null, 2), "utf8");
}

function saveNewListings(newListings) {
  const timestamp = new Date().toISOString().split("T")[0];
  const file = path.join(DATA_DIR, `new_${timestamp}.json`);
  fs.writeFileSync(file, JSON.stringify(newListings, null, 2), "utf8");
  fs.writeFileSync(
    NEW_LISTINGS_FILE,
    JSON.stringify(newListings, null, 2),
    "utf8"
  );
  return file;
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToWebhook(payload) {
  if (!N8N_WEBHOOK_URL) {
    console.log("N8N_WEBHOOK_URL not set, skipping webhook notification.");
    return;
  }

  const url = new URL(N8N_WEBHOOK_URL);
  const transport = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log("Webhook notification sent successfully.");
            resolve(data);
          } else {
            console.error(`Webhook returned status ${res.statusCode}: ${data}`);
            reject(new Error(`Webhook status ${res.statusCode}`));
          }
        });
      }
    );
    req.on("error", (err) => {
      console.error(`Webhook request failed: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
  });
}

async function acceptCookies(page) {
  try {
    const cookieBtn = await page.$(
      "#onetrust-accept-btn-handler, .cookie-accept, .agree-button"
    );
    if (cookieBtn) {
      await cookieBtn.click();
      await delay(1000);
    }
  } catch {
    // Cookie banner may not appear
  }
}

async function waitForCloudflare(page) {
  // Wait for Cloudflare challenge to resolve (up to 30s)
  const maxWait = 30000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const title = await page.title();
    const url = page.url();

    // Cloudflare challenge pages have specific titles
    if (
      title.includes("Just a moment") ||
      title.includes("Checking your browser") ||
      url.includes("challenge")
    ) {
      console.log("  Waiting for Cloudflare challenge to resolve...");
      await delay(3000);
      continue;
    }
    break;
  }
}

async function scrapeSearchPage(page) {
  const listings = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll(".list-row");

    for (const row of rows) {
      try {
        // Skip ad/promoted rows without real listing data
        if (
          row.classList.contains("list-row-banner") ||
          row.querySelector(".list-banner")
        ) {
          continue;
        }

        const linkEl = row.querySelector(".list-adress a, .list-address a");
        const priceEl = row.querySelector(".list-item-price");
        const areaEl = row.querySelector(
          ".list-AreaOverall, .list-area-overall"
        );
        const roomsEl = row.querySelector(
          ".list-RoomNum, .list-room-num"
        );
        const floorEl = row.querySelector(
          ".list-Floors, .list-floors"
        );

        if (!linkEl) continue;

        const url = linkEl.href;
        const address = linkEl.textContent.trim();

        const priceText = priceEl ? priceEl.textContent.trim() : "";
        const price = priceText.replace(/[^\d]/g, "");

        const area = areaEl ? areaEl.textContent.trim() : "";
        const rooms = roomsEl ? roomsEl.textContent.trim() : "";
        const floor = floorEl ? floorEl.textContent.trim() : "";

        // Use URL as unique ID
        const id = url.replace(/https?:\/\/www\.aruodas\.lt/, "");

        results.push({ id, url, address, price, area, rooms, floor });
      } catch {
        continue;
      }
    }
    return results;
  });

  return listings;
}

async function scrapeListingDetails(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForCloudflare(page);
  await delay(1500 + Math.random() * 1500);

  const details = await page.evaluate(() => {
    const getText = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : "";
    };

    // Extract key-value pairs from the details table
    const info = {};
    const dtRows = document.querySelectorAll(".obj-details dt, .obj-details dd");
    let currentKey = "";
    for (const el of dtRows) {
      if (el.tagName === "DT") {
        currentKey = el.textContent.trim().replace(/:$/, "");
      } else if (el.tagName === "DD" && currentKey) {
        info[currentKey] = el.textContent.trim();
        currentKey = "";
      }
    }

    const description =
      getText(".obj-comment") ||
      getText('[id="TextContent"]') ||
      "";

    const photoEls = document.querySelectorAll(
      ".obj-slide img, .gallery-img img, .obj-gallery img"
    );
    const photos = Array.from(photoEls)
      .map((img) => img.src || img.dataset.src)
      .filter(Boolean);

    const agentName = getText(".agent-name, .broker-name, .obj-agent-name");
    const agentPhone = getText(
      ".agent-phone, .broker-phone, .phone-button, .obj-agent-phone"
    );

    return { description, info, photos, agentName, agentPhone };
  });

  return details;
}

function getPageUrl(pageNum) {
  if (pageNum === 1) return BASE_URL;
  // aruodas.lt pagination: /butai/vilniuje/puslapis/N/?filters...
  const urlObj = new URL(BASE_URL);
  const pathParts = urlObj.pathname.replace(/\/$/, "").split("/");
  const newPath = pathParts.join("/") + `/puslapis/${pageNum}/`;
  urlObj.pathname = newPath;
  return urlObj.toString();
}

async function run() {
  console.log("=== Aruodas.lt Apartment Scraper ===");
  console.log(`Filters: Vilnius, 80+ sqm, 250k-450k EUR`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  ensureDataDir();
  const previousListings = loadPreviousListings();
  const previousIds = new Set(Object.keys(previousListings));

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Set a realistic viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "lt-LT,lt;q=0.9,en;q=0.8" });

    console.log("Navigating to search page...");
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCloudflare(page);
    await delay(2000 + Math.random() * 2000);
    await acceptCookies(page);

    // Scrape all pages
    const allListings = [];
    let pageNum = 1;
    const maxPages = 20; // safety limit

    while (pageNum <= maxPages) {
      console.log(`\nScraping page ${pageNum}...`);

      if (pageNum > 1) {
        const pageUrl = getPageUrl(pageNum);
        await page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await waitForCloudflare(page);
        await delay(2000 + Math.random() * 2000);
      }

      const listings = await scrapeSearchPage(page);

      if (listings.length === 0) {
        console.log("  No more listings found, stopping pagination.");
        break;
      }

      console.log(`  Found ${listings.length} listings on page ${pageNum}`);
      allListings.push(...listings);

      // Check if there's a next page
      const hasNext = await page.evaluate(() => {
        const nextLink = document.querySelector(
          ".pagination a.page-bt:last-child, .pagination .next"
        );
        return !!nextLink;
      });

      if (!hasNext) {
        console.log("  No next page found, done with pagination.");
        break;
      }

      pageNum++;
    }

    console.log(`\nTotal search results: ${allListings.length}`);

    // Identify new listings
    const newListings = allListings.filter((l) => !previousIds.has(l.id));
    console.log(
      `New listings since last run: ${newListings.length}`,
    );

    // Fetch full details for new listings
    if (newListings.length > 0) {
      console.log("\nFetching details for new listings...");

      for (let i = 0; i < newListings.length; i++) {
        const listing = newListings[i];
        console.log(
          `  [${i + 1}/${newListings.length}] ${listing.address}`
        );

        try {
          const details = await scrapeListingDetails(page, listing.url);
          Object.assign(listing, details);
        } catch (err) {
          console.log(`    Error fetching details: ${err.message}`);
        }

        // Polite delay between requests
        await delay(2000 + Math.random() * 3000);
      }
    }

    // Merge with previous data
    const updatedListings = { ...previousListings };
    for (const listing of allListings) {
      updatedListings[listing.id] = {
        ...updatedListings[listing.id],
        ...listing,
        lastSeen: new Date().toISOString(),
        firstSeen:
          updatedListings[listing.id]?.firstSeen || new Date().toISOString(),
      };
    }

    // Mark listings no longer in results
    const currentIds = new Set(allListings.map((l) => l.id));
    for (const [id, listing] of Object.entries(updatedListings)) {
      if (!currentIds.has(id) && !listing.removed) {
        updatedListings[id].removed = new Date().toISOString();
      }
    }

    saveListings(updatedListings);

    if (newListings.length > 0) {
      const file = saveNewListings(newListings);
      console.log(`\nNew listings saved to: ${file}`);
    }

    // Summary
    const active = Object.values(updatedListings).filter(
      (l) => !l.removed
    ).length;
    const removed = Object.values(updatedListings).filter(
      (l) => l.removed
    ).length;
    console.log(
      `\nSummary: ${active} active, ${removed} removed, ${newListings.length} new today`
    );

    // Send new listings to n8n webhook
    if (newListings.length > 0) {
      try {
        await postToWebhook({
          newCount: newListings.length,
          activeCount: active,
          removedCount: removed,
          timestamp: new Date().toISOString(),
          listings: newListings.map((l) => ({
            address: l.address,
            price: l.price,
            area: l.area,
            rooms: l.rooms,
            floor: l.floor,
            url: l.url,
            description: l.description || "",
            agentName: l.agentName || "",
            agentPhone: l.agentPhone || "",
            photos: (l.photos || []).slice(0, 3),
          })),
        });
      } catch (err) {
        console.error("Failed to notify n8n:", err.message);
      }
    } else {
      console.log("\nNo new listings — skipping webhook notification.");
    }
  } catch (err) {
    console.error("Scraper error:", err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

run();
