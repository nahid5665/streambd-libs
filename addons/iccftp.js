/*
 * ICC FTP addon for StreamBD IPTV / Entertainment
 * Source: http://10.16.100.244/ (ISP LAN only - FTP hosts 10.16.100.202/.208/.213/.214/...)
 *
 * Contract (same as other StreamBD addons):
 *   module.exports = async function(type, tmdbId, season, episode)
 *   returns [{url, quality, provider, headers}]
 *
 * Site layout (PHP dashboard, no directory indexes):
 *   - dashboard.php?session=<64hex>&category=<id>   category grid (12 items/page)
 *   - dashboard.php  POST {token, psearch}          global search (12 results, grid)
 *   - player.php?session=<64hex>&play=<id>          item page: meta table + <source> tags
 *   - Streams are direct MP4/MKV links on the FTP hosts (10.16.100.202 etc.);
 *     they need no session/Referer/cookies (verified: 206 Partial Content, Accept-Ranges).
 *
 * Notes:
 *   - The dashboard accepts ANY 64-hex session token (verified: dashboard, search and
 *     player all serve content with 0000...0), so no stored login is needed.
 *   - The search POST needs a CSRF token scraped from the page ("name="token""), cached
 *     and re-scraped once on failure.
 *   - The 20-item carousel at the top of every page is a GLOBAL "latest uploads" strip,
 *     not category/search results -> only the "post post-height" grid is parsed.
 *
 * Strategy: TMDB -> title/year -> global search -> title-token scoring
 *           -> player page per candidate (meta year + <source> tags)
 *           -> direct playable URLs (mirrors included).
 */

module.exports = async function (type, tmdbId, season, episode) {
  try {
    var TMDB_KEY = "b911e74a3d17f8b87b908346ee2881ab";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var PROVIDER = "ICC FTP";
    var HOST = "http://10.16.100.244";
    // any 64-hex session works; constant keeps CSRF-token caching stable
    var SESSION = "0000000000000000000000000000000000000000000000000000000000000000";

    var MAX_CANDIDATES = 4; // player-page fetches per call

    // ---------------------------------------------------------------- helpers

    var csrf = { token: null, at: 0 };

    function httpGet(url) {
      return fetch(url, { headers: { "User-Agent": UA } }).then(function (r) {
        if (!r || !r.ok) throw new Error("HTTP " + (r && r.status ? r.status : "?"));
        return r.text();
      });
    }

    function httpPostForm(url, form) {
      return fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }).then(function (r) {
        if (!r || !r.ok) throw new Error("HTTP " + (r && r.status ? r.status : "?"));
        return r.text();
      });
    }

    function decodeEntities(s) {
      return String(s || "")
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(+n); })
        .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function norm(s) {
      if (!s) return "";
      return String(s)
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/[\u2018\u2019\u02bc]/g, "'")
        .replace(/[^a-z0-9' ]+/g, " ")
        .replace(/'/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function tokens(s) {
      var t = norm(s).split(" ");
      var out = [];
      for (var i = 0; i < t.length; i++) if (t[i] !== "") out.push(t[i]);
      return out;
    }

    function escRe(s) {
      return s.replace(/[.*+?^${}()[\]\\]/g, "\\$&");
    }

    // token-boundary aware hit test, like the other StreamBD addons
    function tokenIn(name, token) {
      return new RegExp("(^|[^a-z0-9])" + escRe(token) + "([^a-z0-9]|$)").test(norm(name));
    }

    function qualityOf(text, url) {
      var t = (text || "") + " " + (url || "");
      if (/2160p|\b4k\b|uhd/i.test(t)) return "4K";
      if (/1080[pi]/i.test(t)) return "1080p";
      if (/720[pi]/i.test(t)) return "720p";
      if (/480p|360p|sd\b/i.test(t)) return "480p";
      return "HD";
    }

    function qualityRank(q) {
      return q === "4K" ? 4 : q === "1080p" ? 3 : q === "720p" ? 2 : 1;
    }

    function result(url, quality) {
      return { url: url, quality: quality, provider: PROVIDER, headers: {} };
    }

    // ---------------------------------------------------------------- ICC scraping

    // Grid parser: the contextual result blocks ("post post-height" cards).
    // Slider content is a global latest-uploads strip and is deliberately ignored.
    function parseGrid(html) {
      var out = [];
      var blocks = html.split(/<div class="post post-height/).slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var id = (b.match(/play=(\d+)/) || [])[1];
        if (!id) continue;
        var img = b.match(/<img\s[^>]*src=["'](files\/[^"']+)["'][^>]*alt=["']([^"']*)["']/i) ||
                  b.match(/<img\s[^>]*alt=["']([^"']*)["'][^>]*src=["'](files\/[^"']+)["']/i);
        var title = (img && decodeEntities(img[2] || img[1])) ||
                    decodeEntities((b.match(/<div class="title">\s*([\s\S]*?)\s*<\/div>/) || [])[1]);
        if (!title) continue;
        out.push({ id: id, name: title });
      }
      var seen = {}, uniq = [];
      for (var j = 0; j < out.length; j++) {
        if (!seen[out[j].id]) { seen[out[j].id] = true; uniq.push(out[j]); }
      }
      return uniq;
    }

    // returns [token, wasFresh] — wasFresh marks a token scraped for this call
    async function getCsrf() {
      var now = Date.now();
      if (csrf.token && now - csrf.at < 10 * 60 * 1000) return [csrf.token, false];
      var html = await httpGet(HOST + "/dashboard.php?session=" + SESSION);
      var m = html.match(/name="token"\s+value="([^"]+)"/);
      if (!m) throw new Error("no csrf token on dashboard");
      csrf.token = m[1];
      csrf.at = now;
      return [m[1], true];
    }

    async function searchIcc(query) {
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var tk = await getCsrf();
          var html = await httpPostForm(HOST + "/dashboard.php?session=" + SESSION, {
            token: tk[0], psearch: query,
          });
          var items = parseGrid(html);
          if (items.length > 0) return items;
          // empty result with a CACHED token may mean the token went stale ->
          // retry once; with a fresh token it is a genuine no-hit
          if (tk[1] || attempt === 1) return [];
        } catch (e) {
          csrf.token = null;
        }
      }
      return [];
    }

    // Player page: meta year + all <source> mirrors
    var SOURCE_RE = /<source[^>]+src=['"]([^'"]+)['"][^>]*>/gi;

    async function scrapePlayer(playId) {
      var html = await httpGet(HOST + "/player.php?session=" + SESSION + "&play=" + playId);
      var name = decodeEntities(
        (html.match(/font-size:\s*30px[^>]*>\s*<strong>([\s\S]*?)<\/strong>/) || [])[1] || ""
      );
      var year = 0;
      var ym = html.match(/<td>Year:<\/td>\s*<td[^>]*>([^<]*)<\/td>/i);
      if (ym) year = parseInt(decodeEntities(ym[1]).match(/\d{4}/), 10) || 0;

      var sources = [], m;
      SOURCE_RE.lastIndex = 0;
      while ((m = SOURCE_RE.exec(html)) !== null) {
        var url = decodeEntities(m[1]);
        var q = (m[0].match(/title=['"]([^'"]*)['"]/i) || [])[1];
        if (!sources.some(function (s) { return s.url === url; })) {
          sources.push({ url: url, label: decodeEntities(q || "") });
        }
      }
      return { name: name, year: year, sources: sources };
    }

    // ---------------------------------------------------------------- matching

    function scoreTitle(name, titleTokens, year, isTv) {
      var fn = norm(name);
      if (!fn) return 0;
      var hit = 0;
      for (var i = 0; i < titleTokens.length; i++) if (tokenIn(name, titleTokens[i])) hit++;
      var ratio = titleTokens.length ? hit / titleTokens.length : 0;
      var allIn = ratio >= 1;
      // movies: the card name sometimes carries the release year "(2011)".
      // tv: ICC serial names carry the SEASON year ("Season 03 (2026)"), not the
      //     series' first-air year, so year scoring is skipped entirely.
      var bonus = 0;
      if (!isTv) {
        var m = name.match(/\((19|20)\d{2}\)/);
        if (m && year) {
          var fy = parseInt(m[0].replace(/\(|\)/g, ""), 10);
          if (fy === year) bonus = 0.4;
          else if (Math.abs(fy - year) <= 1) bonus = 0.2;
          else bonus = -0.2;
        }
      }
      return ratio + bonus + (allIn ? 1 : 0);
    }

    // Season / episode range awareness for "Season 03 ... Episode 01_06" style names
    // (both take the already-normalized name)
    function seasonOf(fn) {
      var m = fn.match(/(?:^|\s)(?:season|s)\s*0*(\d{1,2})\b/);
      return m ? parseInt(m[1], 10) : null;
    }

    function epRangeOf(fn) {
      var m = fn.match(/\bepisodes?\s+0*(\d{1,3})(?:\s*(?:to\s*)?0*(\d{1,3}))?\b/);
      if (!m) return null;
      var a = parseInt(m[1], 10);
      var b = m[2] ? parseInt(m[2], 10) : a;
      return a <= b ? [a, b] : [b, a];
    }

    function pickCandidates(items, titleTokens, year, isTv, s, e) {
      // duplicate query tokens ("The Lord of the Rings: The Rings of Power")
      // would inflate the hit count -> score against distinct tokens only
      var tt = [];
      for (var k = 0; k < titleTokens.length; k++) {
        if (tt.indexOf(titleTokens[k]) === -1) tt.push(titleTokens[k]);
      }
      var scored = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var score = scoreTitle(it.name, tt, year, isTv);
        if (score < 0.8) continue;

        if (isTv) {
          var ss = seasonOf(norm(it.name));
          if (ss !== null) {
            if (ss === s) score += 1;
            else score -= 0.5;
          } else {
            score += 0.2; // single-season/undated pack
          }
          var range = epRangeOf(norm(it.name));
          if (range && e) {
            if (e >= range[0] && e <= range[1]) score += 0.3;
            else continue; // declared range misses the requested episode
          }
        }
        scored.push({ item: it, score: score });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored;
    }

    // SxxEyy / "Episode N" marker on an individual source file (for tv packs
    // that store one file per episode)
    function fileEpMark(fn) {
      var m = fn.match(/\bs(\d{1,2})\s*e\s*0*(\d{1,3})\b/);
      if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
      var m2 = fn.match(/\bepisodes?\s+0*(\d{1,3})\b/);
      if (m2) return { s: 1, e: parseInt(m2[1], 10) };
      return null;
    }

    // ---------------------------------------------------------------- TMDB

    var t = String(type || "").toLowerCase();
    if (t !== "movie" && t !== "tv") return [];
    season = parseInt(season, 10) || 1;
    episode = parseInt(episode, 10) || 0;

    var meta = null;
    try {
      var res = await fetch(
        "https://api.themoviedb.org/3/" + t + "/" + tmdbId +
        "?api_key=" + TMDB_KEY + "&language=en-US",
        { headers: { "User-Agent": UA } }
      );
      if (res && res.ok) meta = await res.json();
    } catch (e) { meta = null; }
    if (!meta) return [];

    var title = t === "movie" ? (meta.title || meta.original_title) : (meta.name || meta.original_name);
    var origTitle = t === "movie" ? meta.original_title : meta.original_name;
    var date = t === "movie" ? meta.release_date : meta.first_air_date;
    var year = date ? parseInt(String(date).substring(0, 4), 10) : 0;
    if (!title || !year) return [];

    var tt = tokens(title);
    if (tt.length === 0) return [];

    // ---------------------------------------------------------------- search & resolve

    var results = [];
    var seen = {};

    function pushAll(list) {
      for (var i = 0; i < list.length; i++) {
        var u = list[i].url;
        if (!seen[u]) { seen[u] = true; results.push(list[i]); }
      }
    }

    // ICC search is a plain %LIKE% on the stored title: TMDB compound names
    // ("A: B") return nothing. Build a query ladder: full title -> original
    // title -> compound-name segments -> 3-token windows of significant words.
    function searchQueries() {
      var STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, in: 1, on: 1, to: 1 };
      var out = [];
      function pushQ(q) {
        q = String(q || "").replace(/\s+/g, " ").trim();
        if (q && out.indexOf(q) === -1) out.push(q);
      }
      pushQ(title);
      if (origTitle && origTitle.toLowerCase() !== title.toLowerCase()) pushQ(origTitle);
      // compound titles: "X: Y" -> try each segment, longest first
      var segs = (title + (origTitle ? "|" + origTitle : "")).split(/[:|\u2013\u2014]|\s+-\s+/);
      segs.sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < segs.length && out.length < 4; i++) pushQ(segs[i].trim());
      // last resort: sliding 3-token windows over significant words
      var sig = tokens(title).filter(function (w) { return !STOP[w]; });
      for (var w = 0; w + 2 < sig.length && out.length < 6; w++) {
        pushQ(sig[w] + " " + sig[w + 1] + " " + sig[w + 2]);
      }
      return out.slice(0, 6);
    }

    // Run the whole ladder and pool the candidates: the right item often only
    // matches a LATER query (e.g. the "Season 03" pack is titled without the
    // "The Lord of the Rings" prefix, so the first segment query misses it).
    var candidates = [];
    var seenCand = {};
    var queries = searchQueries();
    for (var qi = 0; qi < queries.length; qi++) {
      var picked;
      try {
        picked = pickCandidates(await searchIcc(queries[qi]), tt, year, t === "tv", season, episode);
      } catch (eSearch) { continue; }
      for (var pi = 0; pi < picked.length; pi++) {
        if (!seenCand[picked[pi].item.id]) {
          seenCand[picked[pi].item.id] = true;
          candidates.push(picked[pi]);
        }
      }
    }
    candidates.sort(function (a, b) { return b.score - a.score; });
    candidates = candidates.slice(0, MAX_CANDIDATES);

    // player pages carry the real year and the mirror list
    for (var c = 0; c < candidates.length; c++) {
      try {
        var p = await scrapePlayer(candidates[c].item.id);
        // soft year gate (movies): mismatch beyond +/-1 kills a wrong-title hit
        if (t === "movie" && p.year && Math.abs(p.year - year) > 1) continue;
        for (var sIdx = 0; sIdx < p.sources.length; sIdx++) {
          var src = p.sources[sIdx];
          // tv: packs that store one file per episode must match the requested
          // SxxEyy; marker-less files are whole-season packs and pass as-is
          if (t === "tv" && episode) {
            var fname = decodeURIComponent(String(src.url.split("/").pop() || src.url));
            var mk = fileEpMark(norm(fname));
            if (mk && (mk.s !== season || mk.e !== episode)) continue;
          }
          pushAll([result(src.url, qualityOf(src.label, src.url))]);
        }
      } catch (e) { /* dead item / host hiccup -> next candidate */ }
    }

    results.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return results.slice(0, 12);
  } catch (err) {
    return [];
  }
};
