/*
 * Circle FTP VOD addon for StreamBD IPTV / Entertainment
 * Source: http://new.circleftp.net/ (React SPA front for http://new.circleftp.net:5000/api)
 *         Files live on h5ai directory indexes spread over ftpN.circleftp.net servers,
 *         per http://new.circleftp.net:5000/api/index-links
 *
 * Contract (same as other StreamBD addons, e.g. dhakaflix.js):
 *   module.exports = async function(type, tmdbId, season, episode)
 *   returns [{url, quality, provider, headers}]
 *
 * Site layout (h5ai directory indexes, no search page):
 *   - Movies are bucketed by year:  "1996" ... "2026", "(1995) & Before", "2000 & Before", "1994& Before"
 *       index.circleftp.net  -> English Movies (<=2015), English & Foreign Dubbed Movies (<=2015)
 *       index1.circleftp.net -> Hindi Movies
 *       index2.circleftp.net -> English Movies (2016+), English & Foreign Dubbed Movies (2016+)
 *       ftp5                 -> Animation Movies, Animation Dubbed Movies, Foreign Language Movies/<Language>
 *       ftp17                -> Tamil Telugu & Others (<=2023), ... Hindi Dubbed (<=2023)
 *       ftp13                -> Tamil Telugu & Others (2024+), ... Hindi Dubbed (2024+)
 *   - TV is a flat list of series folders named "Title (TV Series 2018-) [quality]":
 *       ftp4/6/7/9/10/11/12  -> English & Foreign TV Series
 *       ftp15 / ftp17        -> English & Foreign Anime Series
 *       ftp8                 -> Hindi TV Series
 *       ftp16                -> Dubbed TV Series & Shows
 *   - Series folders contain "Season N" / "Season N 720p" folders (or flat episode files)
 *
 * Strategy: TMDB -> title/year/language/genre -> year bucket or flat list -> fuzzy folder match
 *           -> descend for video files -> return direct playable URLs.
 */

module.exports = async function (type, tmdbId, season, episode) {
  try {
    var TMDB_KEY = "b911e74a3d17f8b87b908346ee2881ab";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var PROVIDER = "CircleFTP";
    var VIDEO_RE = /\.(mkv|mp4|avi|ts|webm|mov|wmv|flv|mpg|mpeg|m4v)(\?|$)/i;

    // ---------------------------------------------------------------- helpers

    function httpGet(url) {
      var opts = { headers: { "User-Agent": UA } };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(15000);
      return fetch(url, opts).then(function (r) {
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

    function tokensAllIn(folderName, titleTokens) {
      var fn = norm(folderName);
      for (var i = 0; i < titleTokens.length; i++) {
        var re = new RegExp("(^|[^a-z0-9])" + escRe(titleTokens[i]) + "([^a-z0-9]|$)");
        if (!re.test(fn)) return false;
      }
      return true;
    }

    function matchTitle(entries, titleTokens, year, minRatio, limit) {
      var strict = [], loose = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.folder) continue;
        var s = titleScore(e.name, titleTokens, year);
        var allTokens = tokensAllIn(e.name, titleTokens);
        if (allTokens) strict.push({ entry: e, score: s + 1 });
        else if (s >= Math.max(minRatio, 1.1)) loose.push({ entry: e, score: s });
      }
      var cands = strict.length ? strict : loose;
      cands.sort(function (a, b) { return b.score - a.score; });
      return cands.slice(0, limit || 3).map(function (c) { return c.entry; });
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
          found.push(result(origin + e.href, qualityOf(folderName + " " + e.name), folderUrl));
        }
      }
      if (found.length === 0 && depth > 0) {
        var subs = [];
        for (var j = 0; j < entries.length; j++) if (entries[j].folder) subs.push(entries[j]);
        for (var k = 0; k < subs.length && found.length === 0; k++) {
          var subUrl = origin + subs[k].href;
          found = await collectVideos(subUrl, folderName + " " + subs[k].name, depth - 1);
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
      var isAnime = genres.indexOf(16) !== -1;
      var southIndian = ["ta", "te", "kn", "ml", "pa", "mr", "bn", "ur", "as", "or"].indexOf(lang) !== -1;
      var newHost = year >= 2024 ? "http://ftp13.circleftp.net" : "http://ftp17.circleftp.net";
      var oldHost = year <= 2023 ? "http://ftp17.circleftp.net" : "http://ftp13.circleftp.net";

      // Priority-ordered roots; year-bucketed unless `foreign`
      var roots = [];
      if (isAnime) {
        roots.push({ origin: "http://ftp5.circleftp.net", base: "/FILE/Animation%20Movies/" });
      }
      if (lang === "en") {
        roots.push(year <= 2015
          ? { origin: "http://index.circleftp.net", base: "/FILE/English%20Movies/" }
          : { origin: "http://index2.circleftp.net", base: "/FILE/English%20Movies/" });
        roots.push(year <= 2015
          ? { origin: "http://index2.circleftp.net", base: "/FILE/English%20Movies/" }
          : { origin: "http://index.circleftp.net", base: "/FILE/English%20Movies/" });
      }
      if (lang === "hi") {
        roots.push({ origin: "http://index1.circleftp.net", base: "/FILE/Hindi%20Movies/" });
      }
      if (southIndian) {
        roots.push({ origin: newHost, base: "/FILE/Tamil%20Telugu%20%26%20Others/" });
        roots.push({ origin: oldHost, base: "/FILE/Tamil%20Telugu%20%26%20Others/" });
      }
      if (!isAnime && lang !== "en" && lang !== "hi" && !southIndian) {
        roots.push({ origin: "http://ftp5.circleftp.net", base: "/FILE/Foreign%20Language%20Movies/", foreign: true, lang: lang });
      }

      // Low-priority dubbed mirrors as fallbacks
      if (isAnime) {
        roots.push({ origin: "http://ftp5.circleftp.net", base: "/FILE/Animation%20Dubbed%20Movies/" });
      }
      if (southIndian) {
        roots.push({ origin: newHost, base: "/FILE/Tamil%20Telugu%20%26%20Others%20Hindi%20Dubbed/" });
        roots.push({ origin: oldHost, base: "/FILE/Tamil%20Telugu%20%26%20Others%20Hindi%20Dubbed/" });
      }

      var langNames = {
        ko: "korean", ja: "japanese", zh: "chinese", fr: "french", de: "german",
        es: "spanish", it: "italian", ru: "russian", th: "thai", ta: "tamil",
        te: "telugu", ml: "malayalam", kn: "kannada", pa: "punjabi", ur: "urdu",
        ar: "arabic", tr: "turkish", pt: "portuguese", id: "indonesian",
        ms: "malay", fa: "persian", he: "hebrew", sv: "swedish", nl: "dutch",
        pl: "polish", uk: "ukrainian", da: "danish", fi: "finnish", no: "norwegian",
        el: "greek", hu: "hungarian", cs: "czech", ro: "romanian", ne: "nepali"
      };

      for (var r = 0; r < roots.length && results.length < 12; r++) {
        var root = roots[r];
        try {
          var rootHtml = await httpGet(root.origin + root.base);
          var rootEntries = parseListing(rootHtml);

          // Movies get re-filed across year boundaries (Dec releases -> next
          // year folder), so fall back to year+1 / year-1 buckets
          var yearTries = [year, year + 1, year - 1];
          for (var yi = 0; yi < yearTries.length; yi++) {
            var bucketUrl = null;
            if (root.foreign) {
              // Foreign Language: find "<Language>" style subfolder
              if (yi > 0) break; // language folder does not depend on year
              var want = langNames[root.lang] || root.lang;
              for (var f = 0; f < rootEntries.length; f++) {
                if (rootEntries[f].folder && norm(rootEntries[f].name).indexOf(want) !== -1) {
                  bucketUrl = root.origin + rootEntries[f].href;
                  break;
                }
              }
            } else {
              var bucket = pickYearBucket(rootEntries, yearTries[yi]);
              if (bucket) bucketUrl = root.origin + bucket.href;
            }
            if (!bucketUrl) continue;

            var bucketHtml = await httpGet(bucketUrl);
            var bucketEntries = parseListing(bucketHtml);
            var matches = matchTitle(bucketEntries, tt, yearTries[yi], 0.8, 3);
            if (matches.length === 0) continue;
            for (var mi = 0; mi < matches.length; mi++) {
              var vids = await collectVideos(originOf(bucketUrl) + matches[mi].href, matches[mi].name, 1);
              pushAll(vids);
            }
            break;
          }
        } catch (e) { /* server down / bucket missing -> try next root */ }
      }

      results.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
      return results.slice(0, 12);
    }

    // ---------------------------------------------------------------- tv

    var isAnimeTv = genres.indexOf(16) !== -1 || lang === "ja";
    var tvRoots = [];
    if (isAnimeTv) {
      tvRoots.push({ origin: "http://ftp15.circleftp.net", base: "/FILE/English%20%26%20Foreign%20Anime%20Series/" });
      tvRoots.push({ origin: "http://ftp17.circleftp.net", base: "/FILE/English%20%26%20Foreign%20Anime%20Series/" });
    }
    if (lang === "hi") {
      tvRoots.push({ origin: "http://ftp8.circleftp.net", base: "/FILE/Hindi%20TV%20Series/" });
      tvRoots.push({ origin: "http://ftp16.circleftp.net", base: "/FILE/Dubbed%20TV%20Series%20%26%20Shows/" });
    }
    // English & Foreign TV Series is spread over several servers
    tvRoots.push({ origin: "http://ftp4.circleftp.net", base: "/FILE/English%20%26%20Foreign%20TV%20Series/" });
    tvRoots.push({ origin: "http://ftp9.circleftp.net", base: "/FILE/English%20%26%20Foreign%20TV%20Series/" });
    tvRoots.push({ origin: "http://ftp12.circleftp.net", base: "/FILE/English%20%26%20Foreign%20TV%20Series/" });
    tvRoots.push({ origin: "http://ftp6.circleftp.net", base: "/FILE/English%20%26%20Foreign%20TV%20Series/" });
    tvRoots.push({ origin: "http://ftp7.circleftp.net", base: "/FILE/English%20%26%20Foreign%20TV%20Series/" });
    tvRoots.push({ origin: "http://ftp11.circleftp.net", base: "/FILE/English%20%26%20Foreign%20TV%20Series/" });
    tvRoots.push({ origin: "http://ftp10.circleftp.net", base: "/File/English%20%26%20Foreign%20TV%20Series/" });
    if (!isAnimeTv && lang !== "hi") {
      tvRoots.push({ origin: "http://ftp16.circleftp.net", base: "/FILE/Dubbed%20TV%20Series%20%26%20Shows/" });
    }

    function matchEpisode(fname, s, e) {
      var m = fname.match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/);
      if (m) return parseInt(m[1], 10) === s && parseInt(m[2], 10) === e;
      var mx = fname.match(/\b(\d{1,2})x(\d{1,3})\b/);
      if (mx) return parseInt(mx[1], 10) === s && parseInt(mx[2], 10) === e;
      var m2 = fname.match(/season[\s._-]*0*(\d{1,2})[\s._-]*(?:episode|ep?)[\s._-]*0*(\d{1,3})\b/i);
      if (m2) return parseInt(m2[1], 10) === s && parseInt(m2[2], 10) === e;
      var m3 = fname.match(/\b(?:episode|ep)[\s._-]*0*(\d{1,3})\b/i);
      if (m3) return parseInt(m3[1], 10) === e;
      // anime bare numbering: "[AT] 07-Ghost 01 [720p].mkv" / "Title - 07.mkv"
      var m4 = fname.match(/(?:^|[\s._-])0*(\d{1,3})(?=[\s._\[\(]|$)/);
      if (m4) return parseInt(m4[1], 10) === e;
      return false;
    }

    // Match a "Season N" (optionally with quality suffix) folder name
    function seasonNumber(name) {
      var sm = name.match(/(?:^|[\s._-])(?:season|s)[\s._-]*0*(\d{1,2})\b/i);
      return sm ? parseInt(sm[1], 10) : 0;
    }

    async function findEpisode(seriesUrl, s, e) {
      var found = [];
      var html;
      try { html = await httpGet(seriesUrl); } catch (err) { return found; }
      var entries = parseListing(html);
      var origin = originOf(seriesUrl);

      // direct episode files at series root (flat layout)
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].folder && VIDEO_RE.test(entries[i].href) && matchEpisode(entries[i].name, s, e)) {
          found.push(result(origin + entries[i].href, qualityOf(entries[i].name), seriesUrl));
        }
      }
      if (found.length > 0) return found;

      // "Season N" folders, optionally with quality suffix ("Season 1 720p")
      var seasonFolders = [];
      for (var j = 0; j < entries.length; j++) {
        var en = entries[j];
        if (en.folder && seasonNumber(en.name) === s) seasonFolders.push(en);
      }
      for (var k = 0; k < seasonFolders.length && found.length < 6; k++) {
        var sUrl = origin + seasonFolders[k].href;
        var sHtml;
        try { sHtml = await httpGet(sUrl); } catch (err) { continue; }
        var sEntries = parseListing(sHtml);
        for (var a = 0; a < sEntries.length; a++) {
          if (!sEntries[a].folder && VIDEO_RE.test(sEntries[a].href) && matchEpisode(sEntries[a].name, s, e)) {
            found.push(result(origin + sEntries[a].href, qualityOf(seasonFolders[k].name + " " + sEntries[a].name), sUrl));
          }
        }
        // season folder itself contains subfolders -> descend one level
        if (found.length === 0) {
          var subs = [];
          for (var b = 0; b < sEntries.length; b++) if (sEntries[b].folder) subs.push(sEntries[b]);
          for (var c = 0; c < subs.length && found.length === 0; c++) {
            var subHtml;
            try { subHtml = await httpGet(origin + subs[c].href); } catch (err2) { continue; }
            var subEntries = parseListing(subHtml);
            for (var d = 0; d < subEntries.length; d++) {
              if (!subEntries[d].folder && VIDEO_RE.test(subEntries[d].href) && matchEpisode(subEntries[d].name, s, e)) {
                found.push(result(origin + subEntries[d].href, qualityOf(seasonFolders[k].name + " " + subs[c].name + " " + subEntries[d].name), origin + subs[c].href));
              }
            }
          }
        }
      }
      return found;
    }

    for (var tr = 0; tr < tvRoots.length && results.length < 8; tr++) {
      var tvr = tvRoots[tr];
      try {
        var tvHtml = await httpGet(tvr.origin + tvr.base);
        var tvEntries = parseListing(tvHtml);
        var sMatches = matchTitle(tvEntries, tt, year, 0.75, 3);
        for (var si = 0; si < sMatches.length; si++) {
          var eps = await findEpisode(tvr.origin + sMatches[si].href, season, episode);
          pushAll(eps);
          // weaker title matches ("24 Legacy" for "24") only fill in
          // when the best match on this host lacks the episode
          if (eps.length > 0) break;
        }
      } catch (e2) { /* try next root */ }
    }

    results.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return results.slice(0, 8);
  } catch (err) {
    return [];
  }
};
