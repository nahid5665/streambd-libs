/*
 * OlaMovies VOD addon for StreamBD IPTV / Entertainment
 * Source: https://v6.olamovies.mov/ (Next.js app, server-rendered search + post pages)
 *
 * Contract (same as other StreamBD addons, e.g. dhakaflix.js / circleftp.js):
 *   module.exports = async function(type, tmdbId, season, episode)
 *   returns [{url, quality, provider, headers}]
 *
 * Site layout:
 *   - Search:  GET /search?q=<title>  -> SSR result cards linking to
 *       /movies/<slug>            (movie posts, collections)
 *       /tv-series/<slug>         (TV series posts)
 *   - Post pages embed a structured download list in the Next.js flight payload:
 *       {"id":"itm_..","btnId":"..","url":"https://links.ol-am.top/<token>",
 *        "label":"720p [1.8gb]" | "episode 01", "episode":null|N,
 *        "filename":"Title (Year) 1080p ... .mkv", "filesize":"1.8GB",
 *        "broken":false, "face":{"quality":"1080p","source":"BluRay",...}}
 *   - Season sections appear as "label":"Season N" entries preceding their items.
 *   - Every item URL routes through the "OlaMovies Link Generator"
 *     (links.ol-am.top/<token>) which exposes POST /api/generate {id} and
 *     POST /api/cloud {id} (direct-download mirror); a captcha gate can appear.
 *
 * Strategy: TMDB -> title/year -> /search -> score post slugs -> fetch posts ->
 *           parse items -> match movie title / season+episode -> resolve the
 *           generator chain (redirect -> /api/generate -> /api/cloud -> HTML)
 *           -> return direct playable URLs.
 *
 * NOTE: the link-generator origin (links.ol-am.top) is occasionally offline
 *       (Cloudflare 522); when it is down this addon returns [] by design.
 */

module.exports = async function (type, tmdbId, season, episode) {
  try {
    var TMDB_KEY = "b911e74a3d17f8b87b908346ee2881ab";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var SITE = "https://v6.olamovies.mov";
    var PROVIDER = "OlaMovies";
    var VIDEO_RE = /\.(mkv|mp4|avi|ts|webm|mov|wmv|flv|mpg|mpeg|m4v)(\?|$)/i;
    var ITEM_URL_RE = /^https:\/\/links\.ol-am\.top\/[A-Za-z0-9_-]+$/;

    function httpGet(url, referer) {
      var h = { "User-Agent": UA };
      if (referer) h["Referer"] = referer;
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) h.signal = AbortSignal.timeout(15000);
      return fetch(url, { headers: h, redirect: "follow" }).then(function (r) {
        if (!r || !r.ok) throw new Error("HTTP " + (r && r.status ? r.status : "?"));
        return r.text();
      });
    }

    function httpJsonPost(url, body, referer) {
      var h = { "User-Agent": UA, "Content-Type": "application/json" };
      if (referer) h["Referer"] = referer;
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) h.signal = AbortSignal.timeout(20000);
      return fetch(url, {
        method: "POST", headers: h,
        body: JSON.stringify(body || {}), redirect: "follow"
      }).then(function (r) { return r.ok ? r.text() : null; });
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
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // decode the payload's \uXXXX leftovers
    function unesc(s) {
      return String(s || "").replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
      }).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }

    function qualityOf(text) {
      var t = text || "";
      if (/2160p|\b4k\b|uhd/i.test(t)) return "4K";
      if (/1080[pi]/i.test(t)) return "1080p";
      if (/720[pi]/i.test(t)) return "720p";
      if (/480p|360p|sd\b/i.test(t)) return "480p";
      return "HD";
    }

    function qualityRank(q) {
      return q === "4K" ? 4 : q === "1080p" ? 3 : q === "720p" ? 2 : 1;
    }

    function originOf(url) {
      var m = url.match(/^(https?:\/\/[^\/]+)/i);
      return m ? m[1] : "";
    }

    // ---------------------------------------------------------------- payload

    // Un-escape the Next.js flight payload once (\\\" -> " levels)
    function unwrapPayload(html) {
      var start = html.indexOf("__next_f");
      var body = start >= 0 ? html.slice(start) : html;
      return body.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    }

    // Pull download items out of the unescaped payload text.
    // Payload model: "kind":"release" group entries carry heading/episode/
    // resolution/specs; "id":"itm_" rows (url/label/episode/filename) attach to
    // the current group; "label":"Season N" section marks set season context.
    // Returns [{url, label, episode, filename, filesize, broken, quality, season}]
    function extractItems(plain) {
      var items = [];
      var events = [];
      var m;

      var grpRe = /"kind":"release","id":"grp_[A-Za-z0-9]+"/g;
      while ((m = grpRe.exec(plain)) !== null) events.push({ idx: m.index, type: "grp" });
      var itmRe = /"id":"itm_[A-Za-z0-9]+","btnId":"[^"]*","url":"([^"]+)"/g;
      while ((m = itmRe.exec(plain)) !== null) events.push({ idx: m.index, type: "itm", url: m[1] });
      var sr = /"label":"(?:Season|season)\s*(\d{1,2})"/g;
      while ((m = sr.exec(plain)) !== null) events.push({ idx: m.index, type: "season", n: parseInt(m[1], 10) });

      events.sort(function (a, b) { return a.idx - b.idx; });

      var curQuality = "", curSeason = 0;
      var nextGrpIdx = plain.length;
      // pre-compute next group boundary for each event
      for (var e = events.length - 1, lastGrp = plain.length; e >= 0; e--) {
        if (events[e].type === "grp") { events[e].end = lastGrp; lastGrp = events[e].idx; }
      }

      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.type === "season") { curSeason = ev.n; continue; }
        if (ev.type === "grp") {
          var gs = plain.slice(ev.idx, Math.min(ev.end, ev.idx + 1800));
          curQuality = (gs.match(/"resolution":"([^"]{1,12})"/) || [])[1] || "";
          continue;
        }
        // itm row
        var slice = plain.slice(ev.idx, Math.min(ev.idx + 1500));
        var label = unesc((slice.match(/"label":"((?:\\.|[^"\\])*)"/) || [])[1] || "");
        var ep = (slice.match(/"episode":(null|\d+(?:\.\d+)?)(?:,|\})/) || [])[1];
        var fn = unesc((slice.match(/"filename":"((?:\\.|[^"\\])*)"/) || [])[1] || "");
        var broken = /"broken":true/.test(slice);
        items.push({
          url: ev.url,
          label: label,
          episode: ep === "null" || ep === undefined ? null : parseFloat(ep),
          filename: fn,
          quality: curQuality,
          season: curSeason,
          broken: broken
        });
      }
      return items;
    }

    // ---------------------------------------------------------------- resolver

    function scanVideoUrls(text) {
      var out = [];
      var re = /https?:\/\/[^\s"'`<>\\]+/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        var u = m[0];
        if (VIDEO_RE.test(u) && !/\.(jpe?g|png|webp|gif|css|js|ico|svg|mp3)(\?|$)/i.test(u)) out.push(u);
      }
      // de-dupe, strip trailing escapes
      var seen = {};
      var clean = [];
      for (var i = 0; i < out.length; i++) {
        var u2 = out[i].replace(/[",\]}]+$/, "");
        if (!seen[u2]) { seen[u2] = true; clean.push(u2); }
      }
      return clean;
    }

    // Collect next-hop URLs from a page/response: file-host pages, drive
    // links, download endpoints — anything that could lead to the file.
    function scanNextUrls(text, excludeOrigin) {
      var out = [];
      var seen = {};
      var re = /https?:\/\/[^\s"'`<>\\]+/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        var u = m[0].replace(/[",\]}\\]+$/, "");
        if (VIDEO_RE.test(u)) continue; // handled elsewhere
        if (/\.(jpe?g|png|webp|gif|css|js|ico|svg|mp3|woff2?)(\?|$)/i.test(u)) continue;
        if (excludeOrigin && u.indexOf(excludeOrigin) === 0) continue;
        if (/googleapis|gstatic|w3\.org|schema\.org|cloudflare|archive\.org/i.test(u)) continue;
        if (!seen[u]) { seen[u] = true; out.push(u); }
      }
      return out.slice(0, 8);
    }

    // Resolve one URL toward a direct playable file URL (best effort).
    // Walks up to maxHops pages: redirects are followed automatically by
    // fetch(); landing pages are scanned for video URLs and next hops, and
    // the Link Generator's /api/generate + /api/cloud endpoints are tried.
    // Throws {networkDown:true} when the host itself is unreachable so the
    // caller can skip the remaining items on that host immediately.
    async function resolveUrl(startUrl, referer, maxHops) {
      var hops = maxHops === undefined ? 2 : maxHops;
      var queue = [{ url: startUrl, ref: referer }];
      var visited = {};
      var fetchBudget = 6;

      while (queue.length > 0 && fetchBudget > 0) {
        var cur = queue.shift();
        if (visited[cur.url]) continue;
        visited[cur.url] = true;
        fetchBudget--;

        var finalUrl = cur.url;
        var body = "";
        try {
          var h = { "User-Agent": UA };
          if (cur.ref) h["Referer"] = cur.ref;
          if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) h.signal = AbortSignal.timeout(12000);
          var r = await fetch(cur.url, { headers: h, redirect: "follow" });
          if (r.status >= 500) throw { networkDown: true, status: r.status };
          finalUrl = r.url || cur.url;
          var ct = r.headers.get("content-type") || "";
          if (VIDEO_RE.test(finalUrl) || /video\//i.test(ct)) return finalUrl;
          if (/text\/html|application\/json|text\/plain/i.test(ct)) body = await r.text();
          else {
            var v0 = scanVideoUrls(await r.text());
            if (v0.length) return v0[0];
            continue;
          }
        } catch (e) {
          if (e && e.networkDown) throw e;
          // connection error / abort timeout -> host unreachable
          throw { networkDown: true, err: String((e && e.message) || e) };
        }

        // Link Generator page: POST /api/generate {id} on its origin
        var origin = originOf(finalUrl);
        var token = finalUrl.split("?")[0].split("/").pop();
        var nextUrls = [];
        var isGeneratorPage = (token && /links\.|\/link\//i.test(finalUrl)) || /link generator/i.test(body);
        if (/text\/html/i.test(body) && isGeneratorPage) {
          try {
            var gtxt = await httpJsonPost(origin + "/api/generate", { id: token }, finalUrl);
            if (gtxt) {
              if (/"captcha_required"/.test(gtxt)) return null;
              var vids = scanVideoUrls(gtxt);
              if (vids.length) return vids[0];
              nextUrls = nextUrls.concat(scanNextUrls(gtxt, origin));
              fetchBudget--; // POST counts against the budget
            }
          } catch (e2) { /* fall through */ }
          // direct-download mirror: /api/cloud {id} -> {success, link2}
          try {
            var ctxt = await httpJsonPost(origin + "/api/cloud", { id: token }, finalUrl);
            if (ctxt) {
              var cj = null;
              try { cj = JSON.parse(ctxt); } catch (e3) { cj = null; }
              if (cj && cj.success && cj.link2) {
                if (VIDEO_RE.test(cj.link2)) return cj.link2;
                nextUrls.unshift(cj.link2);
              }
              fetchBudget--;
            }
          } catch (e4) { /* ignore */ }
        }

        // scan the page itself for video URLs and next hops
        if (!VIDEO_RE.test(finalUrl)) {
          var vidsPage = scanVideoUrls(body);
          if (vidsPage.length) return vidsPage[0];
          nextUrls = nextUrls.concat(scanNextUrls(body, origin));
        }

        if (hops > 0) {
          for (var n = 0; n < nextUrls.length; n++) {
            if (!visited[nextUrls[n]]) queue.push({ url: nextUrls[n], ref: finalUrl });
          }
        }
        hops--;
      }
      return null;
    }

    // origins known to be unreachable -> skip their remaining items fast
    var deadOrigins = {};

    async function resolveItem(itemUrl, referer) {
      if (!ITEM_URL_RE.test(itemUrl)) {
        return VIDEO_RE.test(itemUrl) ? itemUrl : null;
      }
      var o = originOf(itemUrl);
      if (deadOrigins[o]) return null;
      try {
        return await resolveUrl(itemUrl, referer, 2);
      } catch (e) {
        if (e && e.networkDown) deadOrigins[o] = true;
        return null;
      }
    }

    // ---------------------------------------------------------------- TMDB

    var t = String(type || "").toLowerCase();
    if (t !== "movie" && t !== "tv" && t !== "series") return [];
    if (t === "series") t = "tv";
    season = parseInt(season, 10) || 1;
    episode = parseInt(episode, 10) || 0;

    var meta = null;
    try {
      var tOpts = { headers: { "User-Agent": UA } };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) tOpts.signal = AbortSignal.timeout(15000);
      var res = await fetch(
        "https://api.themoviedb.org/3/" + t + "/" + tmdbId +
        "?api_key=" + TMDB_KEY + "&language=en-US",
        tOpts
      );
      if (res && res.ok) meta = await res.json();
    } catch (e) { meta = null; }
    if (!meta) return [];

    var title = t === "movie" ? (meta.title || meta.original_title) : (meta.name || meta.original_name);
    var date = t === "movie" ? meta.release_date : meta.first_air_date;
    var year = date ? parseInt(String(date).substring(0, 4), 10) : 0;
    if (!title) return [];

    var tt = tokens(title);
    if (tt.length === 0) return [];

    var results = [];
    var seen = {};
    var seenFile = {};

    function pushResult(url, quality, referer, dedupKey) {
      if (!url || seen[url]) return;
      if (dedupKey && seenFile[dedupKey + "|" + quality]) return;
      seen[url] = true;
      if (dedupKey) seenFile[dedupKey + "|" + quality] = true;
      var h = {};
      if (referer) h["Referer"] = referer;
      results.push({ url: url, quality: quality, provider: PROVIDER, headers: h });
    }

    // ---------------------------------------------------------------- search

    var searchHtml;
    try {
      searchHtml = await httpGet(SITE + "/search?q=" + encodeURIComponent(title));
    } catch (e) { return []; }

    // candidate post slugs, scored against the title tokens
    var slugSeen = {};
    var cands = [];
    var hrefRe = /href="\/(movies|tv-series)\/([a-z0-9%-]+)"/g;
    var hm;
    while ((hm = hrefRe.exec(searchHtml)) !== null) {
      var kind = hm[1];
      var slug = hm[2];
      var key = kind + "/" + slug;
      if (slugSeen[key]) continue;
      slugSeen[key] = true;
      var slugNorm = norm(decodeURIComponent(slug.replace(/-/g, " ")));
      if (!slugNorm) continue;
      var hit = 0;
      for (var i = 0; i < tt.length; i++) {
        var re = new RegExp("(^|[^a-z0-9])" + escRe(tt[i]) + "([^a-z0-9]|$)");
        if (re.test(slugNorm)) hit++;
      }
      var ratio = tt.length ? hit / tt.length : 0;
      // posts carry the release year in the slug ("stranger-things-2016"):
      // a slug from a different year is a sequel/spin-off post -> reject it
      var sy = (slug.match(/(19|20)\d{2}/g) || []).map(function (y) { return parseInt(y, 10); });
      var yearOk = true;
      if (sy.length && year) {
        if (sy.indexOf(year) !== -1) ratio += 0.15;
        else if (Math.min.apply(null, sy.map(function (y) { return Math.abs(y - year); })) > 1) yearOk = false;
      }
      // collections/posts without the title are noise -> require a decent ratio
      if (yearOk && ratio >= 0.6) cands.push({ href: "/" + kind + "/" + slug, ratio: ratio, kind: kind });
    }
    cands.sort(function (a, b) { return b.ratio - a.ratio; });
    cands = cands.slice(0, 4);
    if (cands.length === 0) return [];

    // ---------------------------------------------------------------- items

    function matchMovieItem(it) {
      if (it.broken || it.episode !== null) return 0;
      if (/\.zip(\?|$)/i.test(it.filename || it.label)) return 0;
      var fn = norm(it.filename + " " + it.label);
      if (!fn) return 0;
      var hit = 0;
      for (var i = 0; i < tt.length; i++) {
        var re = new RegExp("(^|[^a-z0-9])" + escRe(tt[i]) + "([^a-z0-9]|$)");
        if (re.test(fn)) hit++;
      }
      var ratio = tt.length ? hit / tt.length : 0;
      // release year from filename: "(2023)" or bare "2023" (first 19xx/20xx hit;
      // 1080p/2160p/H264 never match the 19|20 prefix). A different year is a
      // different film (sequels are separate posts) -> reject outright.
      var ym = (it.filename || "").match(/\((19|20)\d{2}\)/) || (it.filename || "").match(/(19|20)\d{2}/);
      if (ym) {
        var fy = parseInt(ym[0].replace("(", ""), 10);
        if (fy === year) ratio += 0.15;
        else if (Math.abs(fy - year) <= 1) ratio += 0.05;
        else return 0;
      }
      return ratio;
    }

    function matchTvItem(it, s, e) {
      if (it.broken) return 0;
      if (/\.zip(\?|$)/i.test(it.filename || it.label)) return 0;
      // episode files only (zip packs have episode null)
      if (it.episode !== null) {
        if (Math.floor(it.episode) !== e) return 0;
        if (it.season && it.season !== s) return 0;
        return 1.2; // explicit episode field -> strong match
      }
      // fallback: SxxEyy in the filename
      var fm = (it.filename || "").match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/);
      if (fm) {
        if (parseInt(fm[1], 10) === s && parseInt(fm[2], 10) === e) return 1.0;
        return 0;
      }
      // title match only helps if the label names the episode ("episode 01")
      var lm = (it.label || "").match(/(?:episode|ep)[\s._-]*0*(\d{1,3})\b/i);
      if (lm && it.season === s && parseInt(lm[1], 10) === e) return 1.0;
      return 0;
    }

    for (var c = 0; c < cands.length && results.length < 12; c++) {
      var cand = cands[c];
      var postUrl = SITE + cand.href;
      var postHtml;
      try { postHtml = await httpGet(postUrl); } catch (err) { continue; }
      var plain = unwrapPayload(postHtml);
      var items = extractItems(plain);

      var matched = [];
      for (var k = 0; k < items.length; k++) {
        var score = t === "movie" ? matchMovieItem(items[k]) : matchTvItem(items[k], season, episode);
        if (score > 0) matched.push({ it: items[k], score: score });
      }
      if (matched.length === 0) continue;
      // prefer explicit episode fields, then higher quality
      matched.sort(function (a, b) {
        var d = b.score - a.score;
        if (d !== 0) return d;
        return qualityRank(qualityOf(b.it.quality + " " + b.it.label)) - qualityRank(qualityOf(a.it.quality + " " + a.it.label));
      });
      // one direct result per distinct quality label
      var perQ = {};
      for (var j = 0; j < matched.length && results.length < 12; j++) {
        var it = matched[j].it;
        var q = qualityOf(it.quality + " " + it.label);
        if (perQ[q] >= 2) continue; // at most 2 per quality (e.g. different groups)
        perQ[q] = (perQ[q] || 0) + 1;
        try {
          var direct = await resolveItem(it.url, postUrl);
          if (direct) pushResult(direct, q, postUrl, norm(it.filename || it.label));
        } catch (err2) { /* skip item */ }
      }
    }

    results.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return results.slice(0, 12);
  } catch (err) {
    return [];
  }
};
