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

// =========================================================================
// TRENDING & POPULAR ENGINES & IN-MEMORY CACHE (15 MINUTE TTL)
// Top 10 Hero Trending (with backdrops & overviews) + Popular Catalogs
// =========================================================================
const trendingCache = {
  movies: { timestamp: 0, data: [] },
  series: { timestamp: 0, data: [] },
  anime: { timestamp: 0, data: [] }
};
const popularCache = {
  movies: { timestamp: 0, data: [] },
  series: { timestamp: 0, data: [] },
  anime: { timestamp: 0, data: [] }
};
const TRENDING_CACHE_TTL = 15 * 60 * 1000;
const TMDB_API_KEYS = [
  "8476a7ab80ad76f0936744df0430e67c",
  "4f298a53e5522830ce95f3859f10ac84"
];

async function getTrendingMovies() {
  const now = Date.now();
  if (trendingCache.movies.data.length && (now - trendingCache.movies.timestamp < TRENDING_CACHE_TTL)) {
    return trendingCache.movies.data;
  }

  // 1. Fetch live daily trending from TMDB
  for (const key of TMDB_API_KEYS) {
    try {
      const res = await fetchJson(`https://api.themoviedb.org/3/trending/movie/day?api_key=${key}`, 4500);
      if (res && res.results && res.results.length) {
        const items = res.results.slice(0, 20).map((m, idx) => ({
          id: `tmdb-${m.id}`,
          tmdb_id: m.id,
          title: m.title || m.original_title,
          poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
          backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : (m.poster_path ? `https://image.tmdb.org/t/p/w780${m.poster_path}` : null),
          overview: m.overview || "",
          year: (m.release_date || "").slice(0, 4) || "2026",
          rating: m.vote_average ? Number(m.vote_average.toFixed(1)) : null,
          type: "Movie",
          rank: idx + 1,
          trending: true
        }));
        trendingCache.movies = { timestamp: now, data: items };
        return items;
      }
    } catch (e) {}
  }

  // Fallback: Cinemeta top filtered to recent
  try {
    const cmData = await fetchJson("https://v3-cinemeta.strem.io/catalog/movie/top.json", 4500);
    if (cmData && cmData.metas && cmData.metas.length) {
      const items = cmData.metas.slice(0, 20).map((m, idx) => ({
        id: m.id,
        title: m.name,
        poster: m.poster,
        backdrop: m.background || m.poster,
        overview: m.description || "",
        year: m.releaseInfo || m.year || "",
        rating: m.imdbRating || null,
        type: "Movie",
        rank: idx + 1,
        trending: true
      }));
      trendingCache.movies = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  return trendingCache.movies.data || [];
}

async function getPopularMovies() {
  const now = Date.now();
  if (popularCache.movies.data.length && (now - popularCache.movies.timestamp < TRENDING_CACHE_TTL)) {
    return popularCache.movies.data;
  }

  for (const key of TMDB_API_KEYS) {
    try {
      const res = await fetchJson(`https://api.themoviedb.org/3/movie/popular?api_key=${key}`, 4500);
      if (res && res.results && res.results.length) {
        const items = res.results.slice(0, 24).map((m, idx) => ({
          id: `tmdb-${m.id}`,
          tmdb_id: m.id,
          title: m.title || m.original_title,
          poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
          backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
          overview: m.overview || "",
          year: (m.release_date || "").slice(0, 4) || "2026",
          rating: m.vote_average ? Number(m.vote_average.toFixed(1)) : null,
          type: "Movie",
          rank: idx + 1
        }));
        popularCache.movies = { timestamp: now, data: items };
        return items;
      }
    } catch (e) {}
  }

  try {
    const cmData = await fetchJson("https://v3-cinemeta.strem.io/catalog/movie/top.json", 4500);
    if (cmData && cmData.metas && cmData.metas.length) {
      const items = cmData.metas.slice(0, 24).map((m, idx) => ({
        id: m.id,
        title: m.name,
        poster: m.poster,
        year: m.releaseInfo || m.year || "",
        rating: m.imdbRating || null,
        type: "Movie",
        rank: idx + 1
      }));
      popularCache.movies = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  return popularCache.movies.data || [];
}

async function getTrendingSeries() {
  const now = Date.now();
  if (trendingCache.series.data.length && (now - trendingCache.series.timestamp < TRENDING_CACHE_TTL)) {
    return trendingCache.series.data;
  }

  // 1. Fetch live daily trending from TMDB
  for (const key of TMDB_API_KEYS) {
    try {
      const res = await fetchJson(`https://api.themoviedb.org/3/trending/tv/day?api_key=${key}`, 4500);
      if (res && res.results && res.results.length) {
        const items = res.results.slice(0, 20).map((s, idx) => ({
          id: `tmdb-tv-${s.id}`,
          tmdb_id: s.id,
          title: s.name || s.original_name,
          poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
          backdrop: s.backdrop_path ? `https://image.tmdb.org/t/p/w1280${s.backdrop_path}` : (s.poster_path ? `https://image.tmdb.org/t/p/w780${s.poster_path}` : null),
          overview: s.overview || "",
          year: (s.first_air_date || "").slice(0, 4) || "2026",
          rating: s.vote_average ? Number(s.vote_average.toFixed(1)) : null,
          type: "Series",
          rank: idx + 1,
          trending: true
        }));
        trendingCache.series = { timestamp: now, data: items };
        return items;
      }
    } catch (e) {}
  }

  // Fallback: Cinemeta series top
  try {
    const cmData = await fetchJson("https://v3-cinemeta.strem.io/catalog/series/top.json", 4500);
    if (cmData && cmData.metas && cmData.metas.length) {
      const items = cmData.metas.slice(0, 20).map((m, idx) => ({
        id: m.id,
        title: m.name,
        poster: m.poster,
        backdrop: m.background || m.poster,
        overview: m.description || "",
        year: m.releaseInfo || m.year || "",
        rating: m.imdbRating || null,
        type: "Series",
        rank: idx + 1,
        trending: true
      }));
      trendingCache.series = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  return trendingCache.series.data || [];
}

async function getPopularSeries() {
  const now = Date.now();
  if (popularCache.series.data.length && (now - popularCache.series.timestamp < TRENDING_CACHE_TTL)) {
    return popularCache.series.data;
  }

  try {
    const cmData = await fetchJson("https://v3-cinemeta.strem.io/catalog/series/top.json", 4500);
    if (cmData && cmData.metas && cmData.metas.length) {
      const items = cmData.metas.slice(0, 24).map((m, idx) => ({
        id: m.id,
        title: m.name,
        poster: m.poster,
        backdrop: m.background || m.poster,
        overview: m.description || "",
        year: m.releaseInfo || m.year || "",
        rating: m.imdbRating || null,
        type: "Series",
        rank: idx + 1
      }));
      popularCache.series = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  return popularCache.series.data || [];
}

async function getTrendingAnime() {
  const now = Date.now();
  if (trendingCache.anime.data.length && (now - trendingCache.anime.timestamp < TRENDING_CACHE_TTL)) {
    return trendingCache.anime.data;
  }

  // 1. Fetch live trending anime from AniList GraphQL (top 10 with bannerImage and overview)
  try {
    const query = `
      query {
        Page(page: 1, perPage: 10) {
          media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
            id
            title { english romaji }
            bannerImage
            coverImage { extraLarge large }
            description
            startDate { year }
            seasonYear
            averageScore
            format
          }
        }
      }
    `;

    let anilistData = null;
    if (typeof fetch === "function") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        anilistData = await res.json();
      }
    }

    const list = anilistData?.data?.Page?.media || [];
    if (list.length) {
      const items = list.map((a, idx) => ({
        id: `anilist-${a.id}`,
        title: a.title.english || a.title.romaji,
        romaji: a.title.romaji,
        poster: a.coverImage.extraLarge || a.coverImage.large,
        backdrop: a.bannerImage || a.coverImage.extraLarge,
        overview: a.description ? a.description.replace(/<[^>]*>?/gm, "").slice(0, 180) + "..." : "",
        year: a.startDate?.year || a.seasonYear || "2026",
        rating: a.averageScore ? Number((a.averageScore / 10).toFixed(1)) : null,
        type: "Anime",
        rank: idx + 1,
        trending: true
      }));
      trendingCache.anime = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  // Fallback: Cinemeta Anime
  try {
    const animeData = await fetchJson("https://v3-cinemeta.strem.io/catalog/series/top/genre=Anime.json", 4500);
    if (animeData && animeData.metas) {
      const items = animeData.metas.slice(0, 10).map((m, idx) => ({
        id: m.id,
        title: m.name,
        poster: m.poster,
        backdrop: m.background || m.poster,
        overview: m.description || "",
        year: m.releaseInfo || m.year || "",
        rating: m.imdbRating || null,
        type: "Anime",
        rank: idx + 1,
        trending: true
      }));
      trendingCache.anime = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  return trendingCache.anime.data || [];
}

async function getPopularAnime() {
  const now = Date.now();
  if (popularCache.anime.data.length && (now - popularCache.anime.timestamp < TRENDING_CACHE_TTL)) {
    return popularCache.anime.data;
  }

  try {
    const query = `
      query {
        Page(page: 1, perPage: 24) {
          media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
            id
            title { english romaji }
            coverImage { extraLarge large }
            startDate { year }
            seasonYear
            averageScore
            format
          }
        }
      }
    `;

    let anilistData = null;
    if (typeof fetch === "function") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        anilistData = await res.json();
      }
    }

    const list = anilistData?.data?.Page?.media || [];
    if (list.length) {
      const items = list.map((a, idx) => ({
        id: `anilist-${a.id}`,
        title: a.title.english || a.title.romaji,
        romaji: a.title.romaji,
        poster: a.coverImage.extraLarge || a.coverImage.large,
        backdrop: a.coverImage.extraLarge,
        year: a.startDate?.year || a.seasonYear || "2026",
        rating: a.averageScore ? Number((a.averageScore / 10).toFixed(1)) : null,
        type: "Anime",
        rank: idx + 1
      }));
      popularCache.anime = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  try {
    const animeData = await fetchJson("https://v3-cinemeta.strem.io/catalog/series/top/genre=Anime.json", 4500);
    if (animeData && animeData.metas) {
      const items = animeData.metas.slice(0, 24).map((m, idx) => ({
        id: m.id,
        title: m.name,
        poster: m.poster,
        year: m.releaseInfo || m.year || "",
        rating: m.imdbRating || null,
        type: "Anime",
        rank: idx + 1
      }));
      popularCache.anime = { timestamp: now, data: items };
      return items;
    }
  } catch (e) {}

  return popularCache.anime.data || [];
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

  // Exclude HEVC/H.265 (causes browser video decoder freeze/stalls in standard HTML5 video)
  if (/\b(hevc|h265|x265|h\.265)\b/i.test(lower)) return false;

  // YTS releases are guaranteed 8-bit MP4s
  if (lower.includes("yts") || lower.includes("yify")) return true;

  // Explicit MP4 extension or bracket
  if (/\.mp4\b|\[mp4\]|\(mp4\)|\bmp4\b|\.m4v\b/i.test(lower)) {
    return true;
  }

  // x264 / h264 without mkv/hevc
  if (lower.includes("x264") || lower.includes("h264") || lower.includes("h.264")) {
    return true;
  }

  return false;
}

// Studio / network / franchise prefixes commonly included in user search queries
const FRANCHISE_PREFIXES = /^(?:marvel(?:'s)?|disney(?:\s*\+|\s*plus)?(?:'s)?|dc(?:'s)?|hbo(?:\s*max)?|netflix|apple(?:\s*tv(?:\s*\+)?)?|amazon(?:\s*prime)?|paramount(?:\s*\+)?|hulu|peacock|star\s*wars)\s+/i;

// In-memory metadata resolution cache (1 hour TTL)
const metaCache = new Map();

// Helper: Normalize queries and generate smart search variations with prefix stripping
function buildSearchQueries(raw, matchedMetaTitle = null, format = "mp4") {
  const queries = [];
  const add = (str) => {
    if (!str) return;
    const clean = str.replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 2 && !queries.includes(clean)) {
      queries.push(clean);
    }
  };

  const isMp4 = format === "mp4" || format === "mp4_only";

  // 1. If we matched official title (e.g. "Moon Knight" for "marvel moon knight")
  if (matchedMetaTitle) {
    add(matchedMetaTitle);
    if (isMp4) add(`${matchedMetaTitle} mp4`);
    add(`${matchedMetaTitle} s01`);
  }

  // 2. Strip studio / franchise prefixes from raw query (e.g. "marvel moon knight" -> "moon knight")
  const stripped = raw.replace(FRANCHISE_PREFIXES, "").trim();
  if (stripped && stripped.toLowerCase() !== raw.toLowerCase()) {
    add(stripped);
    if (isMp4) add(`${stripped} mp4`);
  }

  // 3. Raw query itself
  add(raw);
  if (isMp4) add(`${raw} mp4`);

  // 4. Dash / colon split parts
  const dashParts = raw.split(/\s*[-–—:]\s*/);
  if (dashParts.length > 1 && dashParts[0].trim()) {
    const p = dashParts[0].trim();
    add(p);
    const pStripped = p.replace(FRANCHISE_PREFIXES, "").trim();
    if (pStripped) add(pStripped);
  }

  // 5. Word segments
  const words = (stripped || raw).replace(/[:\-–—_/\\!?.'"()[\]~*+@#$&]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length > 3) add(words.slice(0, 3).join(" "));
  if (words.length > 2) add(words.slice(0, 2).join(" "));

  return queries;
}

// Helper: Extract clean title and 4-digit release year by removing scene/codec tags and TV episode tags
function extractCleanTitleAndYear(raw) {
  if (!raw || typeof raw !== "string") return { title: "", year: "" };
  let s = raw.replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, "");
  s = s.replace(/[._]/g, " ");
  s = s.replace(/\b[sS]\d{1,2}[eE]\d{1,2}\b.*/i, "");
  s = s.replace(/\b\d{1,2}x\d{1,2}\b.*/i, "");
  s = s.replace(/\bseason\s*\d+\b.*/i, "");
  const yearMatch = s.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : "";
  const sceneRegex = /\b(1080p|720p|480p|2160p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdrip|dvdrip|x264|h264|x265|hevc|h\.264|h\.265|aac|dts|ac3|yts|yify|rarbg|eztv|proper|repack|remux|hdr)\b/i;
  const match = s.match(sceneRegex);
  if (match) s = s.substring(0, match.index);
  if (year) s = s.replace(new RegExp(`\\b${year}\\b`, "g"), "");
  const title = s.replace(/[:\-–—/\\!?.'"()[\]~*+@#$&]/g, " ").replace(/\s+/g, " ").trim();
  return { title, year };
}

// Helper: Resolve precise media metadata using TMDB with Cinemeta fallback
async function resolveMediaMeta(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "string") return null;
  const cacheKey = rawQuery.toLowerCase().trim();
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 3600000) {
    return cached.data;
  }

  const stripped = rawQuery.replace(FRANCHISE_PREFIXES, "").trim();
  const searchTerms = [stripped, rawQuery].filter(Boolean);

  let result = null;

  // 1. Try TMDB Search First (exceptional accuracy with franchise titles like "marvel moon knight")
  for (const term of searchTerms) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(term)}&api_key=${TMDB_API_KEY}`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const json = await res.json();
        const candidates = (json.results || []).filter(r => r.media_type === "movie" || r.media_type === "tv");
        if (candidates.length) {
          const lowerTerm = term.toLowerCase();
          const best = candidates.find(r => (r.title || r.name || "").toLowerCase().includes(lowerTerm)) || candidates[0];
          const type = best.media_type === "tv" ? "series" : "movie";

          let imdbId = null;
          try {
            const extRes = await fetch(`https://api.themoviedb.org/3/${best.media_type}/${best.id}/external_ids?api_key=${TMDB_API_KEY}`, { signal: AbortSignal.timeout(2000) });
            if (extRes.ok) {
              const extJson = await extRes.json();
              imdbId = extJson.imdb_id;
            }
          } catch (e) {}

          result = {
            id: imdbId || `tmdb:${best.id}`,
            name: best.title || best.name,
            year: (best.release_date || best.first_air_date || "").slice(0, 4),
            rating: best.vote_average ? best.vote_average.toFixed(1) : null,
            poster: best.poster_path ? `https://image.tmdb.org/t/p/w500${best.poster_path}` : null,
            type: type
          };
          break;
        }
      }
    } catch (e) {}
  }

  // 2. Cinemeta fallback
  if (!result) {
    for (const term of searchTerms) {
      try {
        const [sRes, mRes] = await Promise.all([
          fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(term)}.json`, { signal: AbortSignal.timeout(2500) }).then(r=>r.json()).catch(()=>null),
          fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(term)}.json`, { signal: AbortSignal.timeout(2500) }).then(r=>r.json()).catch(()=>null)
        ]);
        const metas = [...(sRes?.metas || []), ...(mRes?.metas || [])];
        if (metas.length) {
          result = {
            id: metas[0].id,
            name: metas[0].name,
            year: metas[0].releaseInfo || metas[0].year,
            rating: metas[0].imdbRating,
            poster: metas[0].poster,
            type: metas[0].type
          };
          break;
        }
      } catch (e) {}
    }
  }

  if (result) {
    metaCache.set(cacheKey, { ts: Date.now(), data: result });
  }

  return result;
}

// Helper: Multi-engine Federated Swarm Scraper (Torrentio + EZTV + Apibay + SolidTorrents + YTS + Nyaa)
async function scrapeTorrentSwarm(query, matchedMeta, limit = 50, format = "mp4") {
  const queryCandidates = buildSearchQueries(query, matchedMeta?.name, format);
  const primaryQuery = queryCandidates[0] || query;
  const imdbId = matchedMeta?.id && matchedMeta.id.startsWith("tt") ? matchedMeta.id : null;
  const cleanImdbDigits = imdbId ? imdbId.replace(/^tt/, "") : null;

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
    seenHashes.add(hash);

    const hasImdb = (item.imdb && typeof item.imdb === "string" && item.imdb.startsWith("tt")) ? item.imdb : imdbId;
    const poster = matchedMeta?.poster || (hasImdb ? `https://images.metahub.space/poster/small/${hasImdb}/img` : null);

    allTorrents.push({
      name: item.name,
      info_hash: item.info_hash || null,
      size: parseInt(item.size, 10) || 0,
      seeders: parseInt(item.seeders, 10) || 0,
      leechers: parseInt(item.leechers, 10) || 0,
      added: parseInt(item.added, 10) || 0,
      magnet: item.magnet || `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}${trackers}`,
      imdb: hasImdb,
      poster: poster,
      is_mp4: isMp4,
      container: isMp4 ? "mp4" : "mkv",
      source: item.source || "Swarm",
      meta: matchedMeta ? {
        title: matchedMeta.name,
        year: matchedMeta.year,
        rating: matchedMeta.rating,
        poster: matchedMeta.poster,
        type: matchedMeta.type
      } : null
    });
  }

  // Execute all federated scrapers in parallel
  const scrapers = [];

  // 1. Torrentio Stremio Streams Provider (1337x, TorrentGalaxy, ThePirateBay, Kickass)
  if (imdbId) {
    scrapers.push((async () => {
      try {
        const streamUrls = matchedMeta?.type === "series"
          ? [
              `https://torrentio.strem.fun/stream/series/${imdbId}:1:1.json`,
              `https://torrentio.strem.fun/stream/series/${imdbId}:1:2.json`
            ]
          : [`https://torrentio.strem.fun/stream/movie/${imdbId}.json`];

        for (const sUrl of streamUrls) {
          const res = await fetch(sUrl, { signal: AbortSignal.timeout(3500) });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.streams)) {
              data.streams.forEach(s => {
                if (!s.infoHash) return;
                const lines = (s.title || "").split("\n");
                const name = lines[0] || s.behaviorHints?.filename || `${matchedMeta.name} Stream`;
                const seedMatch = s.title?.match(/👤\s*(\d+)/);
                const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 10;
                const sizeMatch = s.title?.match(/💾\s*([\d.]+)\s*([A-Za-z]+)/);
                let sizeBytes = 0;
                if (sizeMatch) {
                  const num = parseFloat(sizeMatch[1]);
                  const unit = sizeMatch[2].toUpperCase();
                  if (unit.includes("GB") || unit === "G") sizeBytes = Math.round(num * 1024 * 1024 * 1024);
                  else if (unit.includes("MB") || unit === "M") sizeBytes = Math.round(num * 1024 * 1024);
                }
                addTorrent({
                  name: name,
                  info_hash: s.infoHash,
                  seeders: seeds,
                  leechers: 0,
                  size: sizeBytes,
                  source: "Torrentio",
                  imdb: imdbId
                });
              });
            }
          }
        }
      } catch (e) {}
    })());
  }

  // 2. EZTV (TV Shows Indexer)
  if (cleanImdbDigits) {
    scrapers.push((async () => {
      try {
        const url = `https://eztvx.to/api/get-torrents?limit=50&imdb_id=${cleanImdbDigits}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
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
                magnet: t.magnet_url,
                source: "EZTV",
                imdb: imdbId
              });
            });
          }
        }
      } catch (e) {}
    })());
  }

  // 3. Apibay (ThePirateBay API with category=200 Video filter)
  scrapers.push((async () => {
    try {
      for (const q of queryCandidates.slice(0, 3)) {
        const url = `https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=200`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const items = await res.json();
          if (Array.isArray(items)) {
            let count = 0;
            items.forEach(t => {
              if (t.name && t.name !== "No results returned") {
                addTorrent({
                  name: t.name,
                  info_hash: t.info_hash,
                  seeders: parseInt(t.seeders, 10) || 0,
                  leechers: parseInt(t.leechers, 10) || 0,
                  added: parseInt(t.added, 10) || 0,
                  size: parseInt(t.size, 10) || 0,
                  source: "Apibay"
                });
                count++;
              }
            });
            if (count > 0) break;
          }
        }
      }
    } catch (e) {}
  })());

  // 4. SolidTorrents (Fast DHT indexer with category=video)
  scrapers.push((async () => {
    try {
      for (const q of queryCandidates.slice(0, 2)) {
        const url = `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(q)}&category=video&sort=seeders`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
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
                  added: t.createdAt ? Math.floor(Date.parse(t.createdAt) / 1000) || 0 : 0,
                  source: "SolidTorrents"
                });
                count++;
              }
            });
            if (count > 0) break;
          }
        }
      }
    } catch (e) {}
  })());

  // 5. YTS Movies Scraper (100% Browser-Native MP4s)
  scrapers.push((async () => {
    try {
      const mirrors = ["https://yts.bz", "https://yts.rs", "https://yts.mx"];
      for (const rawQ of queryCandidates.slice(0, 2)) {
        const q = rawQ.replace(/\bmp4\b/gi, "").trim();
        if (!q) continue;
        let gotYts = false;
        for (const m of mirrors) {
          try {
            const url = `${m}/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=20`;
            const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
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
                        imdb: movie.imdb_code,
                        source: "YTS"
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

  // 6. Nyaa.si (Anime RSS Indexer)
  scrapers.push((async () => {
    try {
      for (const q of queryCandidates.slice(0, 2)) {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&s=seeders&o=desc`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
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
                size: sizeBytes,
                source: "Nyaa"
              });
              count++;
            }
          }
          if (count > 0) break;
        }
      }
    } catch (e) {}
  })());

  await Promise.allSettled(scrapers);

  // Sorting: If MP4 mode requested, place playable MP4s first, followed by top MKVs
  allTorrents.sort((a, b) => {
    if (format === "mp4") {
      if (a.is_mp4 && !b.is_mp4) return -1;
      if (!a.is_mp4 && b.is_mp4) return 1;
    }
    return (b.seeders || 0) - (a.seeders || 0);
  });

  return allTorrents.slice(0, limit);
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

  // 1. Trending & Popular Feed Catalog (/catalog?type=movies|series|anime&feed=all|trending|popular)
  if (pathname === "/catalog" || pathname.startsWith("/catalog")) {
    const type = urlParams.searchParams.get("type") || reqUrlObj.searchParams.get("type") || "movies";
    const feed = urlParams.searchParams.get("feed") || reqUrlObj.searchParams.get("feed") || "all";

    try {
      let trending = [];
      let popular = [];

      if (type === "anime") {
        [trending, popular] = await Promise.all([getTrendingAnime(), getPopularAnime()]);
      } else if (type === "series") {
        [trending, popular] = await Promise.all([getTrendingSeries(), getPopularSeries()]);
      } else {
        [trending, popular] = await Promise.all([getTrendingMovies(), getPopularMovies()]);
      }

      if (feed === "trending") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(trending));
        return;
      }
      if (feed === "popular") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(popular));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type, trending, popular }));
    } catch (err) {
      console.error("Catalog handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type, trending: [], popular: [] }));
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
      const matchedMeta = await resolveMediaMeta(query);
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

  // 3. Captions & Subtitles Engine (/api/subtitles?imdb=...&season=...&episode=...&q=...)
  if (pathname === "/api/subtitles") {
    let imdb = urlParams.searchParams.get("imdb") || reqUrlObj.searchParams.get("imdb");
    const season = urlParams.searchParams.get("season") || reqUrlObj.searchParams.get("season");
    const episode = urlParams.searchParams.get("episode") || reqUrlObj.searchParams.get("episode");
    const q = urlParams.searchParams.get("q") || reqUrlObj.searchParams.get("q");

    try {
      let targetImdb = imdb;
      if (!targetImdb && q) {
        const trimmedQ = q.trim();
        // Check if query itself is an IMDb ID (e.g. tt1375666)
        if (/^tt\d{5,10}$/i.test(trimmedQ)) {
          targetImdb = trimmedQ.toLowerCase();
        } else {
          const isSeries = !!(season && episode);
          const { title, year } = extractCleanTitleAndYear(trimmedQ);
          const searchQueries = [];
          if (title) {
            if (year && !isSeries) searchQueries.push(`${title} ${year}`);
            searchQueries.push(title);
          }
          if (!isSeries) {
            searchQueries.push(...buildSearchQueries(trimmedQ, "all"));
          }

          const meta = await resolveMediaMeta(searchQueries, isSeries);
          if (meta && (meta.id || meta.imdb_id)) {
            targetImdb = meta.id || meta.imdb_id;
          }
        }
      }

      if (!targetImdb) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, subtitles: [] }));
        return;
      }

      let subUrl = "";
      if (season && episode) {
        subUrl = `https://opensubtitles-v3.strem.io/subtitles/series/${targetImdb}:${season}:${episode}.json`;
      } else {
        subUrl = `https://opensubtitles-v3.strem.io/subtitles/movie/${targetImdb}.json`;
      }

      const json = await fetchJson(subUrl, 4500);
      const subs = (json && Array.isArray(json.subtitles)) ? json.subtitles : [];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        imdb: targetImdb,
        subtitles: subs.map(s => ({
          id: s.id,
          lang: s.lang,
          url: s.url,
          fileName: s.subtitleFileName || s.movieReleaseName || "subtitle.srt"
        }))
      }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, subtitles: [], error: e.message }));
    }
    return;
  }

  // 4. Subtitle CORS Safe Stream Proxy (/api/sub-proxy?url=...)
  if (pathname === "/api/sub-proxy") {
    const target = urlParams.searchParams.get("url") || reqUrlObj.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing url parameter");
      return;
    }
    try {
      const parsed = new URL(target);
      const client = parsed.protocol === "http:" ? http : https;
      client.get(target, (pRes) => {
        res.writeHead(pRes.statusCode, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
        pRes.pipe(res);
      }).on("error", (e) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Proxy error: " + e.message);
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid URL");
    }
    return;
  }

  // 5. TorBox API Forwarding (/api/...)
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