/*
 * DhakaFlix VOD addon for StreamBD IPTV / Eentertainment
 * Source: http://172.16.50.4/ (campus LAN only - servers 172.16.50.7/.10/.12/.14)
 *
 * Contract (same as other StreamBD addons):
 *   module.exports = async function(type, tmdbId, season, episode)
 *   returns [{url, quality, provider, headers}]
 *
 * Site layout (h5ai directory indexes, no search page):
 *   - Movies are bucketed by year:  "(2025)" / "(2025) 1080p"  (+ "(1960-1994)"-style range buckets)
 *   - TV/Anime bucketed by letter:  "TV Series ♥ A — L" ...
 *   - Korean TV (50.14) is a flat list of series folders
 *   - Series folders contain "Season N" folders with SxxEyy.mkv files
 *
 * Strategy: TMDB -> title/year/language -> O(1) bucket lookup -> fuzzy folder match
 *           -> descend for video files -> return direct playable URLs.
 */

module.exports = async function (type, tmdbId, season, episode) {
  try {
    var TMDB_KEY = "b911e74a3d17f8b87b908346ee2881ab";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var PROVIDER = "DhakaFlix";
    var VIDEO_RE = /\.(mkv|mp4|avi|ts|webm|mov|wmv|flv|mpg|mpeg)(\?|$)/i;

    // ---------------------------------------------------------------- helpers

    function httpGet(url) {
      return fetch(url, { headers: { "User-Agent": UA } }).then(function (r) {
        if (!r || !r.ok) throw new Error("HTTP " + (r && r.status ? r.status : "?"));
        return r.text();
      });
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

    function decodeName(href, text) {
      try {
        var clean = href.replace(/\/+$/, "");
        var base = clean.substring(clean.lastIndexOf("/") + 1);
        var dec = decodeURIComponent(base);
        if (dec && dec.indexOf("%") === -1) return dec;
        return dec || (text || base);
      } catch (e) {
        return text || href;
      }
    }

    // Parse an h5ai fallback listing -> [{href, name, folder}]
    function parseListing(html) {
      var out = [];
      var re = /<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = m[1];
        if (!href || href === ".." || href === "../" || /^https?:/i.test(href)) continue;
        var isFolder = /\/(\?|$)/.test(href);
        out.push({ href: href, name: decodeName(href, m[2]), folder: isFolder });
      }
      return out;
    }

    // Pick the year bucket folder that contains `year`
    function pickYearBucket(entries, year) {
      var best = null, bestScore = 0;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.folder) continue;
        var nums = e.name.match(/(19|20)\d{2}/g);
        if (!nums || nums.length === 0) continue;
        var score = 0;
        if (/before/i.test(e.name)) {
          if (year <= parseInt(nums[0], 10)) score = 1;
        } else if (nums.length >= 2) {
          var a = parseInt(nums[0], 10), b = parseInt(nums[1], 10);
          if (year >= a && year <= b) score = 1;
        } else {
          if (parseInt(nums[0], 10) === year) score = 2;
        }
        if (score > bestScore) { bestScore = score; best = e; }
      }
      return bestScore > 0 ? best : null;
    }

    // Pick the letter bucket (A — L style) containing the first letter of the title
    function pickLetterBucket(entries, ch) {
      var c = (ch || "").toUpperCase();
      if (!/[A-Z0-9]/.test(c)) c = "0";
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.folder) continue;
        // space-flanked em-dash range only, so "Anime-TV" style hyphens never hijack the match
        var m = e.name.match(/(?:^|[\s])([0-9A-Z])\s*[\u2014\u2013]\s*([0-9A-Z])(?:[\s]|$)/i);
        if (!m) continue;
        var lo = m[1].toUpperCase(), hi = m[2].toUpperCase();
        if (/[0-9]/.test(c)) {
          if (/[0-9]/.test(lo)) return e;
        } else if (c >= lo && c <= hi) {
          return e;
        }
      }
      return null;
    }

    function titleScore(folderName, titleTokens, year) {
      var fn = norm(folderName);
      if (!fn) return 0;
      var hit = 0;
      for (var i = 0; i < titleTokens.length; i++) {
        var re = new RegExp("(^|[^a-z0-9])" + escRe(titleTokens[i]) + "([^a-z0-9]|$)");
        if (re.test(fn)) hit++;
      }
      var ratio = titleTokens.length ? hit / titleTokens.length : 0;
      var bonus = 0;
      var m = folderName.match(/\((19|20)\d{2}/);
      if (m) {
        var fy = parseInt(m[0].replace("(", ""), 10);
        if (fy === year) bonus = 0.4;
        else if (Math.abs(fy - year) <= 1) bonus = 0.2;
        else bonus = -0.2;
      }
      return ratio + bonus;
    }

    function matchTitle(entries, titleTokens, year, minRatio, limit) {
      var strict = [], loose = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.folder) continue;
        var s = titleScore(e.name, titleTokens, year);
        // strict pass: every title token must be present (kills "3 Idiots" -> "Pelham 1 2 3")
        var allTokens = tokensAllIn(e.name, titleTokens);
        if (allTokens) strict.push({ entry: e, score: s + 1 });
        else if (s >= Math.max(minRatio, 1.1)) loose.push({ entry: e, score: s });
      }
      var cands = strict.length ? strict : loose;
      cands.sort(function (a, b) { return b.score - a.score; });
      return cands.slice(0, limit || 3).map(function (c) { return c.entry; });
    }

    function tokensAllIn(folderName, titleTokens) {
      var fn = norm(folderName);
      for (var i = 0; i < titleTokens.length; i++) {
        var re = new RegExp("(^|[^a-z0-9])" + escRe(titleTokens[i]) + "([^a-z0-9]|$)");
        if (!re.test(fn)) return false;
      }
      return true;
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

    function result(url, quality, referer) {
      var h = {};
      if (referer) h["Referer"] = referer;
      return { url: url, quality: quality, provider: PROVIDER, headers: h };
    }

    // Collect video files inside a folder; descend one level into subfolders when flat
    async function collectVideos(folderUrl, folderName, depth) {
      var found = [];
      var html;
      try { html = await httpGet(folderUrl); } catch (e) { return found; }
      var entries = parseListing(html);
      var origin = originOf(folderUrl);
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.folder && VIDEO_RE.test(e.href)) {
          found.push(result(origin + e.href, qualityOf(e.name), folderUrl));
        }
      }
      if (found.length === 0 && depth > 0) {
        var subs = [];
        for (var j = 0; j < entries.length; j++) if (entries[j].folder) subs.push(entries[j]);
        for (var k = 0; k < subs.length && found.length === 0; k++) {
          var subUrl = originOf(folderUrl) + subs[k].href;
          found = await collectVideos(subUrl, subs[k].name, depth - 1);
        }
      }
      return found;
    }

    function originOf(url) {
      var m = url.match(/^(https?:\/\/[^\/]+)/i);
      return m ? m[1] : "";
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
    var date = t === "movie" ? meta.release_date : meta.first_air_date;
    var year = date ? parseInt(String(date).substring(0, 4), 10) : 0;
    var lang = (meta.original_language || "").toLowerCase();
    var genres = (meta.genres || []).map(function (g) { return g.id; });
    if (!title || !year) return [];

    var tt = tokens(title);
    // CJK/other script titles never match latin folder names -> bail early
    if (tt.length === 0) return [];

    var results = [];
    var seen = {};

    function pushAll(list) {
      for (var i = 0; i < list.length; i++) {
        var u = list[i].url;
        if (!seen[u]) { seen[u] = true; results.push(list[i]); }
      }
    }

    // ---------------------------------------------------------------- movies

    if (t === "movie") {
      // [origin, base, langs, isAnimeGenre] — 1080p preferred first
      var roots = [];
      if (lang === "en") {
        // includes Dual-Audio (Hindi+English) releases of English movies
        roots.push({ origin: "http://172.16.50.14", base: "/DHAKA-FLIX-14/English%20Movies%20%281080p%29/" });
        roots.push({ origin: "http://172.16.50.7", base: "/DHAKA-FLIX-7/English%20Movies/" });
      }
      if (lang === "hi") {
        roots.unshift({ origin: "http://172.16.50.14", base: "/DHAKA-FLIX-14/Hindi%20Movies/" });
      }
      if (lang === "bn") {
        roots.unshift({ origin: "http://172.16.50.7", base: "/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/" });
      }
      if (genres.indexOf(16) !== -1) {
        roots.unshift({ origin: "http://172.16.50.14", base: "/DHAKA-FLIX-14/Animation%20Movies/" });
      }
      if (lang !== "en" && lang !== "hi" && lang !== "bn") {
        roots.push({ origin: "http://172.16.50.7", base: "/DHAKA-FLIX-7/Foreign%20Language%20Movies/", foreign: true, lang: lang });
      }

      for (var r = 0; r < roots.length && results.length < 12; r++) {
        var root = roots[r];
        try {
          var rootHtml = await httpGet(root.origin + root.base);
          var rootEntries = parseListing(rootHtml);

          var bucketUrl = null;
          if (root.foreign) {
            // Foreign Language: find "<Language> Language" style subfolder
            var langNames = {
              ko: "korean", ja: "japanese", zh: "chinese", fr: "french", de: "german",
              es: "spanish", it: "italian", ru: "russian", th: "thai", ta: "tamil",
              te: "telugu", ml: "malayalam", kn: "kannada", pa: "punjabi", ur: "urdu",
              ar: "arabic", tr: "turkish", pt: "portuguese", id: "indonesian",
              ms: "malay", fa: "persian", he: "hebrew", sv: "swedish", nl: "dutch",
              pl: "polish", uk: "ukrainian", da: "danish", fi: "finnish", no: "norwegian",
              el: "greek", hu: "hungarian", cs: "czech", ro: "romanian", ne: "nepali"
            };
            var want = langNames[root.lang] || root.lang;
            for (var f = 0; f < rootEntries.length; f++) {
              if (rootEntries[f].folder && norm(rootEntries[f].name).indexOf(want) !== -1) {
                bucketUrl = root.origin + rootEntries[f].href;
                break;
              }
            }
          } else {
            var bucket = pickYearBucket(rootEntries, year);
            if (bucket) bucketUrl = root.origin + bucket.href;
          }
          if (!bucketUrl) continue;

          var bucketHtml = await httpGet(bucketUrl);
          var bucketEntries = parseListing(bucketHtml);
          var matches = matchTitle(bucketEntries, tt, year, 0.8, 3);
          for (var mi = 0; mi < matches.length; mi++) {
            var vids = await collectVideos(originOf(bucketUrl) + matches[mi].href, matches[mi].name, 1);
            pushAll(vids);
          }
        } catch (e) { /* server down / bucket missing -> try next root */ }
      }

      results.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
      return results.slice(0, 12);
    }

    // ---------------------------------------------------------------- tv

    var tvRoots = [];
    if (genres.indexOf(16) !== -1) {
      tvRoots.push({ origin: "http://172.16.50.10", base: "/DHAKA-FLIX-10/Anime%20%26%20Cartoon%20TV%20Series/", lettered: true });
    }
    if (lang === "ko") {
      tvRoots.push({ origin: "http://172.16.50.14", base: "/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/", flat: true });
    }
    tvRoots.push({ origin: "http://172.16.50.12", base: "/DHAKA-FLIX-12/TV-WEB-Series/", lettered: true });

    function matchEpisode(fname, s, e) {
      var m = fname.match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,2})/);
      if (m) return parseInt(m[1], 10) === s && parseInt(m[2], 10) === e;
      var m2 = fname.match(/\b(?:ep?|episode)[\s._-]*0*(\d{1,3})\b/i);
      if (m2 && s === 1) return parseInt(m2[1], 10) === e;
      // anime flat naming: "Title - 07.mkv"
      var m3 = fname.match(/[\s_-]0*(\d{1,3})\.(mkv|mp4|avi|ts|webm|mov)$/i);
      if (m3 && s === 1) return parseInt(m3[1], 10) === e;
      return false;
    }

    async function findEpisode(seriesUrl, s, e) {
      var found = [];
      var html;
      try { html = await httpGet(seriesUrl); } catch (err) { return found; }
      var entries = parseListing(html);
      var origin = originOf(seriesUrl);

      // direct episode files at series root
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].folder && VIDEO_RE.test(entries[i].href) && matchEpisode(entries[i].name, s, e)) {
          found.push(result(origin + entries[i].href, qualityOf(entries[i].name), seriesUrl));
        }
      }
      if (found.length > 0) return found;

      // "Season N" folder
      for (var j = 0; j < entries.length; j++) {
        var en = entries[j];
        if (!en.folder) continue;
        var sm = en.name.match(/(?:^|[\s._-])(?:season|s)[\s._-]*0*(\d{1,2})\b/i);
        if (!sm || parseInt(sm[1], 10) !== s) continue;
        var sUrl = origin + en.href;
        var sHtml;
        try { sHtml = await httpGet(sUrl); } catch (err) { continue; }
        var sEntries = parseListing(sHtml);
        for (var k = 0; k < sEntries.length; k++) {
          if (!sEntries[k].folder && VIDEO_RE.test(sEntries[k].href) && matchEpisode(sEntries[k].name, s, e)) {
            found.push(result(origin + sEntries[k].href, qualityOf(sEntries[k].name), sUrl));
          }
        }
        if (found.length > 0) return found;
      }
      return found;
    }

    for (var tr = 0; tr < tvRoots.length && results.length < 8; tr++) {
      var tvr = tvRoots[tr];
      try {
        var tvHtml = await httpGet(tvr.origin + tvr.base);
        var tvEntries = parseListing(tvHtml);
        var listUrl = tvr.origin + tvr.base;
        if (tvr.lettered) {
          var lb = pickLetterBucket(tvEntries, tt[0].charAt(0));
          if (!lb) continue;
          var lbHtml = await httpGet(tvr.origin + lb.href);
          tvEntries = parseListing(lbHtml);
          listUrl = tvr.origin + lb.href;
        }
        var sMatches = matchTitle(tvEntries, tt, year, 0.75, 3);
        for (var si = 0; si < sMatches.length; si++) {
          var eps = await findEpisode(originOf(listUrl) + sMatches[si].href, season, episode);
          pushAll(eps);
        }
      } catch (e2) { /* try next root */ }
    }

    return results.slice(0, 8);
  } catch (err) {
    return [];
  }
};
