const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Fetch helper with redirect handling (301/302/307/308) and standard browser headers
function fetchJson(url, maxRedirects = 3) {
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
        return resolve(fetchJson(nextUrl, maxRedirects - 1));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.error(`API returned HTTP ${res.statusCode} for: ${url}`);
        return resolve(null);
      }

      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error(`JSON parse error from ${url}:`, e.message);
          resolve(null);
        }
      });
    }).on("error", (err) => {
      console.error(`Network error requesting ${url}:`, err.message);
      resolve(null);
    });
  });
}

// Helper: Normalize queries to prevent apibay fulltext parser errors on punctuation/operators
function buildSearchQueries(raw) {
  const queries = [];
  const add = (str) => {
    if (!str) return;
    const clean = str.replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 2 && !queries.includes(clean)) {
      queries.push(clean);
    }
  };

  add(raw);

  const dashParts = raw.split(/\s*[-–—]\s*/);
  if (dashParts.length > 1 && dashParts[0]) {
    add(dashParts[0]);
  }

  const colonParts = raw.split(/\s*:\s*/);
  if (colonParts.length > 1 && colonParts[0]) {
    add(colonParts[0]);
  }

  const words = raw.replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").trim().split(/\s+/).filter(Boolean);
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

// Helper: Query apibay sequentially through query variations until results are found
async function searchApibayWithFallbacks(queryCandidates, limit) {
  const results = [];
  const seenHashes = new Set();

  for (const q of queryCandidates) {
    const searchUrl = `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
    const items = await fetchJson(searchUrl);

    if (Array.isArray(items)) {
      const validItems = items.filter(item =>
        item.name &&
        item.info_hash &&
        item.info_hash !== "0000000000000000000000000000000000000000" &&
        item.name !== "No results returned"
      );

      for (const item of validItems) {
        if (!seenHashes.has(item.info_hash)) {
          seenHashes.add(item.info_hash);
          results.push(item);
        }
      }

      if (results.length >= Math.max(limit * 2, 50)) {
        break;
      }
    }
  }

  return results;
}

// Helper: Resolve Cinemeta metadata with query fallbacks
async function resolveMediaMeta(queryCandidates) {
  for (const q of queryCandidates) {
    const [movieMeta, seriesMeta] = await Promise.all([
      fetchJson(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`),
      fetchJson(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`)
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
}

// Main Request Handler compatible with Node.js http and Vercel Serverless Functions
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

  const urlParams = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = urlParams.pathname;
  const endpoint = urlParams.searchParams.get("endpoint");

  // 1. Recommendation Feed Catalog (/catalog?type=movies|series|anime)
  if (endpoint === "catalog" || pathname.startsWith("/catalog") || pathname === "/api/catalog") {
    const type = urlParams.searchParams.get("type") || "movies";

    try {
      let items = [];

      if (type === "anime") {
        const animeData = await fetchJson("https://v3-cinemeta.strem.io/catalog/series/top/genre=Anime.json");
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
        const metaData = await fetchJson(`https://v3-cinemeta.strem.io/catalog/${cinemetaType}/top.json`);
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
  if (endpoint === "search-torrents" || pathname.startsWith("/search-torrents") || pathname === "/api/search-torrents") {
    const query = urlParams.searchParams.get("q");
    const limit = Math.min(parseInt(urlParams.searchParams.get("limit") || "25", 10), 100);

    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing query parameter 'q'" }));
      return;
    }

    try {
      const queryCandidates = buildSearchQueries(query);
      const [results, matchedMeta] = await Promise.all([
        searchApibayWithFallbacks(queryCandidates, limit),
        resolveMediaMeta(queryCandidates)
      ]);

      const defaultPoster = matchedMeta ? matchedMeta.poster : null;

      const formatted = (Array.isArray(results) ? results : [])
        .map(t => {
          const trackers = [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.demonii.com:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce"
          ].map(tr => `&tr=${encodeURIComponent(tr)}`).join("");

          const hasImdb = t.imdb && typeof t.imdb === "string" && t.imdb.startsWith("tt");
          const poster = hasImdb 
            ? `https://images.metahub.space/poster/small/${t.imdb}/img` 
            : defaultPoster;

          return {
            name: t.name,
            size: parseInt(t.size, 10) || 0,
            seeders: parseInt(t.seeders, 10) || 0,
            leechers: parseInt(t.leechers, 10) || 0,
            added: parseInt(t.added, 10) || 0,
            magnet: `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}${trackers}`,
            imdb: hasImdb ? t.imdb : (matchedMeta ? matchedMeta.id : null),
            poster: poster,
            meta: matchedMeta ? {
              title: matchedMeta.name,
              year: matchedMeta.releaseInfo || matchedMeta.year,
              rating: matchedMeta.imdbRating,
              poster: matchedMeta.poster,
              type: matchedMeta.type
            } : null
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatted));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to search torrents" }));
    }
    return;
  }

  // 3. TorBox API Forwarding (/api/torrents/... or rewrites)
  const isTorbox = endpoint === "torbox" || 
                   pathname === "/api/torrents" ||
                   pathname.startsWith("/api/torrents") || 
                   pathname.startsWith("/torrents") || 
                   (pathname.startsWith("/api/") && !pathname.startsWith("/api/catalog") && !pathname.startsWith("/api/search-torrents"));

  if (isTorbox) {
    let subPath = urlParams.searchParams.get("path") || req.headers["x-matched-path"] || pathname;
    if (!subPath.startsWith("/api/")) {
      subPath = "/api/" + subPath.replace(/^\/+/, "");
    }

    // Preserve query parameters except internal routing params
    const forwardParams = new URLSearchParams(urlParams.search);
    forwardParams.delete("endpoint");
    forwardParams.delete("path");
    const qs = forwardParams.toString() ? `?${forwardParams.toString()}` : "";

    const targetUrl = new URL(`https://api.torbox.app/v1${subPath}${qs}`);
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

    req.pipe(proxyReq);
    return;
  }

  // 4. Static File Serving (for local node server.js fallback)
  const parsedPath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = path.join(__dirname, "..", parsedPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(data);
  });
}

module.exports = handler;
