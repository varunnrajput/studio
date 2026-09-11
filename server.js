const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// Fetch helper using global fetch (Node 18+) with timeout and fallback to https/http
async function fetchJson(url, timeoutMs = 5000, maxRedirects = 3) {
  try {
    if (typeof fetch === "function") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*"
        },
        signal: controller.signal,
        redirect: "follow"
      });
      clearTimeout(timer);
      if (!response.ok) {
        return null;
      }
      return await response.json();
    }
  } catch (err) {}

  // Fallback to legacy http/https client if fetch unavailable
  return new Promise((resolve) => {
    if (maxRedirects < 0) return resolve(null);

    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "http:" ? http : https;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*"
      }
    };

    client.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(fetchJson(nextUrl, timeoutMs, maxRedirects - 1));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return resolve(null);
      }

      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
}

// Helper: Strict classification of browser-playable MP4 containers (H.264 / AAC, 8-bit)
function isBrowserMp4(name, isYts = false) {
  if (isYts) return true;
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase();

  // Exclude MKV containers
  if (/\.mkv\b|\[mkv\]|\(mkv\)|\bmkv\b/i.test(lower)) return false;

  // Exclude 10-bit color depth (causes browser video decoder stall)
  if (/10bit|10-bit|hi10p/i.test(lower)) return false;

  // YTS releases are guaranteed 8-bit MP4s
  if (lower.includes("yts") || lower.includes("yify")) return true;

  // Explicit MP4 extension or bracket
  if (/\.mp4\b|\[mp4\]|\(mp4\)|\bmp4\b|\.m4v\b/i.test(lower)) {
    return true;
  }

  // x264 / h264 with AAC without mkv/hevc
  if ((lower.includes("x264") || lower.includes("h264") || lower.includes("h.264")) &&
      !lower.includes("hevc") && !lower.includes("x265") && !lower.includes("h265")) {
    return true;
  }

  return false;
}

// Helper: Normalize queries to prevent apibay fulltext parser errors on punctuation/operators
function buildSearchQueries(raw, format = "mp4") {
  const queries = [];
  const add = (str) => {
    if (!str) return;
    const clean = str.replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 2 && !queries.includes(clean)) {
      queries.push(clean);
    }
  };

  const isMp4 = format === "mp4" || format === "mp4_only";

  if (isMp4) {
    add(`${raw} mp4`);
    const cleanWords = raw.replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").trim().split(/\s+/).filter(Boolean);
    if (cleanWords.length > 2) {
      add(`${cleanWords.slice(0, 3).join(" ")} mp4`);
      add(`${cleanWords.slice(0, 2).join(" ")} mp4`);
    }
  }

  add(raw);

  const dashParts = raw.split(/\s*[-–—]\s*/);
  if (dashParts.length > 1 && dashParts[0]) {
    add(dashParts[0]);
    if (isMp4) add(`${dashParts[0].trim()} mp4`);
  }

  const colonParts = raw.split(/\s*:\s*/);
  if (colonParts.length > 1 && colonParts[0]) {
    add(colonParts[0]);
    if (isMp4) add(`${colonParts[0].trim()} mp4`);
  }

  const words = raw.replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length > 2) {
    add(words.slice(0, 2).join(" "));
  }
  if (words.length > 3) {
    add(words.slice(0, 3).join(" "));
  }
  if (words.length > 4) {
    add(words.slice(0, 4).join(" "));
  }

  if (!queries.includes(raw.trim())) {
    queries.push(raw.trim());
  }

  return queries;
}

// Helper: Resolve Cinemeta metadata with query fallbacks (fast timeout to never block torrent search)
async function resolveMediaMeta(queryCandidates) {
  try {
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 2500));
    const searchPromise = (async () => {
      for (const q of queryCandidates.slice(0, 2)) {
        const [movieMeta, seriesMeta] = await Promise.all([
          fetchJson(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`, 2500),
          fetchJson(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`, 2500)
        ]);

        const candidates = [];
        if (movieMeta && movieMeta.metas) candidates.push(...movieMeta.metas);
        if (seriesMeta && seriesMeta.metas) candidates.push(...seriesMeta.metas);

        if (candidates.length > 0) {
          const official = candidates.find(m =>
            m.name &&
            !m.name.toLowerCase().includes("reaction") &&
            !m.name.toLowerCase().includes("review") &&
            !m.name.includes("#DUPE#")
          );
          return official || candidates[0];
        }
      }
      return null;
    })();

    return await Promise.race([searchPromise, timeoutPromise]);
  } catch (e) {
    return null;
  }
}

// Helper: Multi-engine Federated Swarm Scraper (Apibay + Nyaa + EZTV + YTS)
async function scrapeTorrentSwarm(query, matchedMeta, limit = 50, format = "mp4") {
  const isMp4Only = format === "mp4" || format === "mp4_only";
  const queryCandidates = buildSearchQueries(query, format);
  const primaryQuery = queryCandidates[0] || query;
  const imdbIdRaw = matchedMeta?.id || matchedMeta?.imdb_id;
  const cleanImdbDigits = imdbIdRaw ? imdbIdRaw.replace(/^tt/, "") : null;

  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce"
  ].map(tr => `&tr=${encodeURIComponent(tr)}`).join("");

  const allTorrents = [];
  const seenHashes = new Set();

  function addTorrent(item, isYts = false) {
    if (!item || !item.name || !item.info_hash) return;
    const hash = item.info_hash.toLowerCase();
    if (hash === "0000000000000000000000000000000000000000" || seenHashes.has(hash)) return;

    const isMp4 = isBrowserMp4(item.name, isYts);
    if (isMp4Only && !isMp4) return;

    seenHashes.add(hash);

    const hasImdb = item.imdb && typeof item.imdb === "string" && item.imdb.startsWith("tt");
    const poster = hasImdb 
      ? `https://images.metahub.space/poster/small/${item.imdb}/img` 
      : (matchedMeta?.poster || null);

    allTorrents.push({
      name: item.name,
      info_hash: item.info_hash || null,
      size: parseInt(item.size, 10) || 0,
      seeders: parseInt(item.seeders, 10) || 0,
      leechers: parseInt(item.leechers, 10) || 0,
      added: parseInt(item.added, 10) || 0,
      magnet: item.magnet || `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}${trackers}`,
      imdb: hasImdb ? item.imdb : (matchedMeta?.id || null),
      poster: poster,
      is_mp4: isMp4,
      container: isMp4 ? "mp4" : "mkv",
      meta: matchedMeta ? {
        title: matchedMeta.name,
        year: matchedMeta.releaseInfo || matchedMeta.year,
        rating: matchedMeta.imdbRating,
        poster: matchedMeta.poster,
        type: matchedMeta.type
      } : null
    });
  }

  // Execute all scrapers in parallel
  const scrapers = [];

  // 1. SolidTorrents (Ultra-fast modern DHT indexer - unblocked on Vercel/datacenter IPs)
  scrapers.push((async () => {
    try {
      for (const q of queryCandidates.slice(0, 2)) {
        const url = `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
        if (res.ok) {
          const json = await res.json();
          if (json.results && Array.isArray(json.results)) {
            let count = 0;
            json.results.forEach(t => {
              if (t.title && t.infohash) {
                addTorrent({
                  name: t.title,
                  info_hash: t.infohash,
                  seeders: t.seeders || 0,
                  leechers: t.leechers || 0,
                  size: t.size || 0,
                  added: t.createdAt ? Math.floor(Date.parse(t.createdAt) / 1000) || 0 : 0
                });
                count++;
              }
            });
            if (count > 0 || allTorrents.length >= limit) break;
          }
        }
      }
    } catch (e) {}
  })());

  // 2. Nyaa.si (Fast Anime RSS Indexer - never blocked on Vercel)
  scrapers.push((async () => {
    try {
      for (const q of queryCandidates.slice(0, 3)) {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
        if (res.ok) {
          const xml = await res.text();
          const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          let count = 0;
          for (const itemXml of itemMatches) {
            const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
            const hashMatch = itemXml.match(/<nyaa:infoHash>([a-fA-F0-9]{40})<\/nyaa:infoHash>/);
            const seedersMatch = itemXml.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/);
            const leechersMatch = itemXml.match(/<nyaa:leechers>(\d+)<\/nyaa:leechers>/);
            const dateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
            const sizeMatch = itemXml.match(/<nyaa:size>([\s\S]*?)<\/nyaa:size>/);

            if (titleMatch && hashMatch) {
              let sizeBytes = 0;
              if (sizeMatch) {
                const parts = sizeMatch[1].trim().split(/\s+/);
                const num = parseFloat(parts[0]);
                const unit = (parts[1] || "").toLowerCase();
                if (unit.includes("gib") || unit.includes("gb")) sizeBytes = Math.round(num * 1024 * 1024 * 1024);
                else if (unit.includes("mib") || unit.includes("mb")) sizeBytes = Math.round(num * 1024 * 1024);
                else if (unit.includes("kib") || unit.includes("kb")) sizeBytes = Math.round(num * 1024);
              }

              addTorrent({
                name: titleMatch[1].trim(),
                info_hash: hashMatch[1].trim(),
                seeders: seedersMatch ? parseInt(seedersMatch[1], 10) : 0,
                leechers: leechersMatch ? parseInt(leechersMatch[1], 10) : 0,
                added: dateMatch ? Math.floor(Date.parse(dateMatch[1]) / 1000) || 0 : 0,
                size: sizeBytes
              });
              count++;
            }
          }
          if (count > 0 || allTorrents.length >= limit) break;
        }
      }
    } catch (e) {}
  })());

  // 3. EZTV (Fast TV Shows Indexer)
  if (cleanImdbDigits) {
    scrapers.push((async () => {
      try {
        const url = `https://eztvx.to/api/get-torrents?limit=50&imdb_id=${cleanImdbDigits}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
        if (res.ok) {
          const json = await res.json();
          if (json.torrents && Array.isArray(json.torrents)) {
            json.torrents.forEach(t => {
              addTorrent({
                name: t.title || t.filename,
                info_hash: t.hash,
                seeders: t.seeds || 0,
                leechers: t.peers || 0,
                added: t.date_released_unix || 0,
                size: parseInt(t.size_bytes, 10) || 0,
                magnet: t.magnet_url
              });
            });
          }
        }
      } catch (e) {}
    })());
  }

  // 4. YTS Movies Scraper (Always 100% Browser-Native MP4s)
  scrapers.push((async () => {
    try {
      const mirrors = ["https://yts.bz", "https://yts.rs", "https://yts.mx"];
      for (const rawQ of queryCandidates.slice(0, 3)) {
        const q = rawQ.replace(/\bmp4\b/gi, "").trim();
        if (!q) continue;
        let gotYts = false;
        for (const m of mirrors) {
          try {
            const url = `${m}/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=20`;
            const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
              const json = await res.json();
              if (json.data && Array.isArray(json.data.movies)) {
                json.data.movies.forEach(movie => {
                  if (movie.torrents && Array.isArray(movie.torrents)) {
                    movie.torrents.forEach(t => {
                      addTorrent({
                        name: `${movie.title} (${movie.year}) [${t.quality}] [${t.type}] YTS`,
                        info_hash: t.hash,
                        seeders: t.seeds || 0,
                        leechers: t.peers || 0,
                        added: t.date_uploaded_unix || 0,
                        size: t.size_bytes || 0,
                        imdb: movie.imdb_code
                      }, true);
                    });
                  }
                });
                gotYts = true;
                break;
              }
            }
          } catch (e) {}
        }
        if (gotYts) break;
      }
    } catch (e) {}
  })());

  // 5. Apibay (ThePirateBay API Fallback)
  scrapers.push((async () => {
    try {
      for (const q of queryCandidates.slice(0, 2)) {
        const url = `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
        const items = await fetchJson(url, 3500);
        if (Array.isArray(items)) {
          items.forEach(t => {
            if (t.name !== "No results returned") {
              addTorrent(t);
            }
          });
          if (allTorrents.length >= limit) break;
        }
      }
    } catch (e) {}
  })());

  await Promise.allSettled(scrapers);

  return allTorrents;
}

// Helper: Locate static files across common deployment directories
function findStaticFile(filename) {
  if (filename === "server.js" || filename === "server") return null;

  const candidates = [
    path.join(__dirname, filename),
    path.join(process.cwd(), filename),
    path.join(__dirname, "public", filename),
    path.join(process.cwd(), "public", filename)
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (e) {}
  }
  return null;
}

// Main Request Handler
async function handler(req, res) {
  // CORS configuration
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Resolve original client URL (supports Vercel rewrites, x-forwarded-uri, x-matched-path)
  let effectiveUrl = req.headers["x-forwarded-uri"] || 
                     (req.headers["x-matched-path"] ? req.headers["x-matched-path"] + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") : req.url);

  const urlParams = new URL(effectiveUrl, `http://${req.headers.host || "localhost"}`);
  const reqUrlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = urlParams.pathname;

  // If Vercel rewrote pathname to /server.js, inspect query parameter or x-matched-path
  if (pathname === "/server.js" || pathname === "/server") {
    const route = urlParams.searchParams.get("__route") || reqUrlObj.searchParams.get("__route");
    if (route === "catalog") {
      pathname = "/catalog";
    } else if (route === "search-torrents") {
      pathname = "/search-torrents";
    } else if (route === "api") {
      const sub = urlParams.searchParams.get("__path") || reqUrlObj.searchParams.get("__path") || "";
      pathname = "/api/" + sub.replace(/^\/+/, "");
    } else if (req.headers["x-matched-path"] && req.headers["x-matched-path"] !== "/server.js") {
      pathname = req.headers["x-matched-path"];
    } else {
      pathname = "/";
    }
  }

  // Health & diagnostic endpoint
  if (pathname === "/api/health" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      effectiveUrl,
      rawUrl: req.url,
      pathname,
      nodeVersion: process.version
    }));
    return;
  }

  // 1. Recommendation Feed Catalog (/catalog?type=movies|series|anime)
  if (pathname === "/catalog" || pathname.startsWith("/catalog")) {
    const type = urlParams.searchParams.get("type") || reqUrlObj.searchParams.get("type") || "movies";

    try {
      let items = [];

      if (type === "anime") {
        const animeData = await fetchJson("https://v3-cinemeta.strem.io/catalog/series/top/genre=Anime.json", 5000);
        if (animeData && animeData.metas) {
          items = animeData.metas.slice(0, 24).map(m => ({
            id: m.id,
            title: m.name,
            poster: m.poster,
            year: m.releaseInfo || m.year || "",
            rating: m.imdbRating || null,
            type: "Anime"
          }));
        }
      } else {
        const cinemetaType = type === "series" ? "series" : "movie";
        const metaData = await fetchJson(`https://v3-cinemeta.strem.io/catalog/${cinemetaType}/top.json`, 5000);
        if (metaData && metaData.metas) {
          items = metaData.metas.slice(0, 24).map(m => ({
            id: m.id,
            title: m.name,
            poster: m.poster,
            year: m.releaseInfo || m.year || "",
            rating: m.imdbRating || null,
            type: type === "series" ? "Series" : "Movie"
          }));
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(items));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // 2. Keyword Torrent Search Endpoint (/search-torrents?q=...&limit=...)
  if (pathname === "/search-torrents" || pathname.startsWith("/search-torrents")) {
    const query = urlParams.searchParams.get("q") || 
                  reqUrlObj.searchParams.get("q") ||
                  (req.headers["x-forwarded-uri"] ? new URL(req.headers["x-forwarded-uri"], "http://localhost").searchParams.get("q") : null) ||
                  urlParams.searchParams.get("query") ||
                  reqUrlObj.searchParams.get("query");

    const limit = Math.min(
      parseInt(
        urlParams.searchParams.get("limit") || 
        reqUrlObj.searchParams.get("limit") || 
        "50", 
        10
      ), 
      100
    );

    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing query parameter 'q'" }));
      return;
    }

    const format = urlParams.searchParams.get("format") || 
                   reqUrlObj.searchParams.get("format") || 
                   "mp4";

    try {
      const queryCandidates = buildSearchQueries(query, format);
      const matchedMeta = await resolveMediaMeta(queryCandidates);
      const results = await scrapeTorrentSwarm(query, matchedMeta, limit, format);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    } catch (err) {
      console.error("Search torrents handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to search torrents: " + err.message }));
    }
    return;
  }

  // 3. TorBox API Forwarding (/api/...)
  if (pathname.startsWith("/api/")) {
    const forwardParams = new URLSearchParams(reqUrlObj.search);
    for (const [k, v] of urlParams.searchParams.entries()) {
      forwardParams.set(k, v);
    }
    forwardParams.delete("__route");
    forwardParams.delete("__path");
    const qs = forwardParams.toString() ? `?${forwardParams.toString()}` : "";

    const targetUrl = new URL(`https://api.torbox.app/v1${pathname}${qs}`);
    const options = {
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.hostname
      }
    };

    const proxyReq = https.request(options, (apiRes) => {
      res.writeHead(apiRes.statusCode, apiRes.headers);
      apiRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });

    if (req.body) {
      const postData = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      proxyReq.write(postData);
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
    return;
  }

  // 4. Static File Serving (with automatic index.html fallback)
  const parsedPath = (pathname === "/" || pathname === "" || pathname === "server.js" || pathname === "/server.js") 
    ? "index.html" 
    : pathname.replace(/^\//, "");
  
  let filePath = findStaticFile(parsedPath);

  // SPA fallback to index.html if route doesn't match an asset
  if (!filePath && !path.extname(parsedPath)) {
    filePath = findStaticFile("index.html");
  }

  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("500 Internal Server Error");
      return;
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon"
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(data);
  });
}

// Export for Vercel Serverless Function
module.exports = handler;

// Run standalone server when invoked via node server.js
if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Stuvio is running at http://0.0.0.0:${PORT}`);
  });
}