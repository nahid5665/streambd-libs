/*
 * Discovery FTP (DFLIX) addon for StreamBD IPTV / Entertainment
 * Source: https://movies.discoveryftp.net/ (ISP LAN only - CDN hosts cdn1..cdn5.discoveryftp.net)
 *
 * Contract (same as other StreamBD addons):
 *   module.exports = async function(type, tmdbId, season, episode)
 *   returns [{url, quality, provider, headers}]
 *
 * Site layout (DFLIX frontend, server-rendered HTML, no API):
 *   - /m/type/{cat}/{year}/{page}       movie grids (div.card > a.cfocus)
 *   - /m/find/{query}                   movie search (this one DOES filter)
 *   - POST /search {term, types}        autocomplete; types=s DOES filter
 *                                       (the /s/find/{q} page ignores the term!)
 *   - /m/view/{id}                      movie detail (quality badges, download link)
 *   - /m/playlist/{id}                  M3U holding the direct CDN file URL
 *   - /s/view/{id}                      series detail + season tabs /s/view/{id}/{ss}
 *   - /s/view/{id}/{ss}                 episode blocks: header (S|EP label, direct
 *                                       file link, size) is rendered BEFORE the
 *                                       view('<playId>') marker, title/overview AFTER
 *
 * Notes:
 *   - CDN links are plain http but 301 to https, so https is used directly.
 *     cdn1-cdn3 were healthy at dev time; cdn4/cdn5 did not respond.
 *   - Movies are stored as one item per quality (1080p and 4K variants have
 *     separate ids), so several search hits turn into several streams.
 *   - Series: the site's "Episode N" titles disagree with the file names;
 *     the S|EP label (matches the SxxEyy inside the file name) is authoritative.
 *   - Files need no Referer/cookies (verified: 206 Partial Content, Accept-Ranges).
 *
 * Strategy: TMDB -> title/year -> search -> title-token scoring
 *           -> movie: playlist M3U per candidate id
 *              tv: season pages -> S|EP block match -> direct file URL
 */

module.exports = async function (type, tmdbId, season, episode) {
  try {
    var TMDB_KEY = "b911e74a3d17f8b87b908346ee2881ab";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var PROVIDER = "Discovery FTP";
    var HOST = "https://movies.discoveryftp.net";

    var MAX_CANDIDATES = 4; // detail/playlist fetches per call

    // ---------------------------------------------------------------- helpers

    function httpGet(url) {
      return fetch(url, { headers: { "User-Agent": UA, Referer: HOST + "/" } }).then(function (r) {
        if (!r || !r.ok) throw new Error("HTTP " + (r && r.status ? r.status : "?"));
        return r.text();
      });
    }

    function httpPostForm(url, form) {
      return fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: HOST + "/" },
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
        .replace(/<[^>]+>/g, " ")
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

    function yearOf(text) {
      var m = String(text || "").match(/\d{4}/);
      return m ? parseInt(m[0], 10) : 0;
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
      // http answers with a 301 to https; series paths carry raw spaces ->
      // percent-encode only segments that still need it (never touch %xx)
      var u = String(url).replace(/^http:\/\//i, "https://");
      if (/[\s\u0080-\uffff]/.test(u)) {
        u = u.split("/").map(function (seg) {
          return /[\s\u0080-\uffff]/.test(seg) ? encodeURIComponent(seg) : seg;
        }).join("/");
      }
      return { url: u, quality: quality, provider: PROVIDER, headers: {} };
    }

    // ------------------------------------------------------------- DFLIX parsing

    // movie grid card: quality badge + poster + title + year, link to /m/view/{id}
    function parseMovieCards(html) {
      var out = [];
      var blocks = html.split('<div class="card">').slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var id = (b.match(/\/m\/view\/(\d+)/) || [])[1];
        if (!id) continue;
        var quality = decodeEntities((b.match(/movie_details_span_end">\s*([^<]*?)\s*<\/span>/) || [])[1]);
        var title = decodeEntities((b.match(/<h3[^>]*>\s*([\s\S]*?)\s*<\/h3>/) || [])[1]);
        var year = yearOf(decodeEntities((b.match(/title="views">\s*([^<]*?)\s*</) || [])[1]));
        if (!title) continue;
        out.push({ id: id, title: title, year: year, quality: quality });
      }
      return out;
    }

    // series autocomplete hit (POST /search, types=s)
    function parseSeriesHits(html) {
      var out = [];
      var blocks = html.split("moviesearchiteam").slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var id = (blocks[i].match(/\/s\/view\/(\d+)/) || [])[1];
        // class="searchtitle" > — the site puts a space before the closing bracket
        var title = decodeEntities((blocks[i].match(/searchtitle"[^>]*>\s*([\s\S]*?)\s*<\/div>/) || [])[1]);
        if (!id || !title) continue;
        out.push({ id: id, title: title });
      }
      var seen = {}, uniq = [];
      for (var j = 0; j < out.length; j++) {
        if (!seen[out[j].id]) { seen[out[j].id] = true; uniq.push(out[j]); }
      }
      return uniq;
    }

    // season page -> episode list. The episode's own header is the LAST
    // S|EP label / file link in the window before its view() marker (the
    // previous episode's header sits in the same window).
    function parseEpisodes(html) {
      var eps = [];
      var re = /view\('(\d+)'\)/g;
      var marks = [], m;
      while ((m = re.exec(html)) !== null) {
        marks.push({ start: m.index, end: m.index + m[0].length });
      }
      for (var i = 0; i < marks.length; i++) {
        var pre = html.slice(Math.max(0, marks[i].start - 3000), marks[i].start);
        var postEnd = i + 1 < marks.length ? marks[i + 1].start : html.length;
        var post = html.slice(marks[i].end, postEnd);

        var file = null, fm;
        var fre = /href="(https?:\/\/[^"]+\.(?:mkv|mp4|avi|webm)[^"]*)"/gi;
        while ((fm = fre.exec(pre)) !== null) file = fm[1];
        if (!file) continue;

        var s = 0, e = 0, sm;
        var sre = /S(\d+)\s*\|\s*EP\s*(\d+)/gi;
        while ((sm = sre.exec(pre)) !== null) { s = parseInt(sm[1], 10); e = parseInt(sm[2], 10); }
        if (!s || !e) {
          var f = file.match(/s(\d{1,2})\s*e\s*(\d{1,2})/i);
          if (!f) continue;
          s = parseInt(f[1], 10);
          e = parseInt(f[2], 10);
        }

        var name = decodeEntities((post.match(/<h4>([\s\S]*?)<br/i) || [])[1] || "");
        eps.push({ s: s, e: e, name: name, url: file });
      }
      return eps;
    }

    // season tabs on a series detail page ("| Season 03" -> /s/view/{id}/03)
    function parseSeasonTabs(html, seriesId) {
      var out = [], seen = {}, m;
      var re = new RegExp('href="/s/view/' + seriesId + '/(\\d+)"', "g");
      while ((m = re.exec(html)) !== null) {
        if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
      }
      return out;
    }

    async function movieStreamUrl(viewId) {
      var m3u = await httpGet(HOST + "/m/playlist/" + viewId);
      var lines = m3u.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (/^https?:\/\//i.test(l)) return l;
      }
      // fallback: the download link on the item page
      var html = await httpGet(HOST + "/m/view/" + viewId);
      var m = html.match(/href="(https?:\/\/[^"]+\.(?:mkv|mp4|avi|webm)[^"]*)"/i);
      return m ? m[1] : null;
    }

    // The search page shows ONE card per title (the /m/view/{id} variants for
    // the other qualities are linked as alt-quality badges on the item page).
    function altQualityIds(viewId) {
      return httpGet(HOST + "/m/view/" + viewId).then(function (html) {
        var out = [], seen = {}, m;
        var re = /badge-outline">\s*<a[^>]*href="\/m\/view\/(\d+)"/gi;
        while ((m = re.exec(html)) !== null) {
          if (m[1] !== String(viewId) && !seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
        }
        return out;
      }).catch(function () { return []; });
    }

    async function seriesEpisodes(seriesId) {
      var main = await httpGet(HOST + "/s/view/" + seriesId);
      var tabs = parseSeasonTabs(main, seriesId);
      if (tabs.length === 0) return parseEpisodes(main); // single-season layout
      var eps = [];
      for (var i = 0; i < tabs.length; i++) {
        try {
          eps = eps.concat(parseEpisodes(await httpGet(HOST + "/s/view/" + seriesId + "/" + tabs[i])));
        } catch (e) { /* dead season page -> keep the rest */ }
      }
      return eps;
    }

    // ---------------------------------------------------------------- matching

    function scoreTitle(name, titleTokens) {
      var hit = 0;
      for (var i = 0; i < titleTokens.length; i++) if (tokenIn(name, titleTokens[i])) hit++;
      return titleTokens.length ? hit / titleTokens.length : 0;
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
    if (!title) return [];

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

    // DFLIX search is a plain substring match on the title: TMDB compound names
    // ("A: B") can return nothing. Ladder: full title -> original title ->
    // compound-name segments, longest first.
    function searchQueries() {
      var out = [];
      function pushQ(q) {
        q = String(q || "").replace(/\s+/g, " ").trim();
        if (q && out.indexOf(q) === -1) out.push(q);
      }
      pushQ(title);
      if (origTitle && origTitle.toLowerCase() !== title.toLowerCase()) pushQ(origTitle);
      var segs = (title + (origTitle ? "|" + origTitle : "")).split(/[:|\u2013\u2014]|\s+-\s+/);
      segs.sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < segs.length && out.length < 4; i++) pushQ(segs[i].trim());
      return out.slice(0, 4);
    }

    var candidates = [];
    var seenCand = {};
    var queries = searchQueries();

    for (var qi = 0; qi < queries.length && candidates.length < MAX_CANDIDATES; qi++) {
      var items;
      try {
        items = t === "tv"
          ? parseSeriesHits(await httpPostForm(HOST + "/search", { term: queries[qi], types: "s" }))
          : parseMovieCards(await httpGet(HOST + "/m/find/" + encodeURIComponent(queries[qi])));
      } catch (eSearch) { continue; }

      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii];
        if (seenCand[it.id]) continue;

        var ratio = scoreTitle(it.title, tt);
        // all title tokens must hit; a year match rescues partial titles,
        // a year mismatch beyond +/-1 kills the candidate (movies)
        var allTokens = ratio >= 1;
        var cy = it.year || 0;
        var yearOk = !year || !cy || Math.abs(cy - year) <= 1;
        if (!allTokens || !yearOk) {
          if (t !== "tv" || ratio < 1) continue;
          if (!(cy && year && Math.abs(cy - year) <= 1)) continue;
        }
        if (t === "movie" && cy && year && Math.abs(cy - year) > 1) continue;

        seenCand[it.id] = true;
        candidates.push(it);
        if (candidates.length >= MAX_CANDIDATES) break;
      }
    }

    if (t === "movie") {
      // one card per title on search -> expand to the alt-quality variant ids
      // linked on the item page, then resolve a stream per variant
      for (var c = 0; c < candidates.length; c++) {
        try {
          var ids = [candidates[c].id].concat(await altQualityIds(candidates[c].id)).slice(0, 4);
          for (var vi = 0; vi < ids.length; vi++) {
            try {
              var url = await movieStreamUrl(ids[vi]);
              if (url) pushAll([result(url, qualityOf(candidates[c].quality, url))]);
            } catch (e2) { /* dead variant -> next */ }
          }
        } catch (e) { /* dead item -> next candidate */ }
      }
    } else {
      for (var c2 = 0; c2 < candidates.length; c2++) {
        try {
          var eps = await seriesEpisodes(candidates[c2].id);
          for (var ei = 0; ei < eps.length; ei++) {
            var ep = eps[ei];
            if (ep.s === season && ep.e === episode) {
              pushAll([result(ep.url, qualityOf(ep.name, ep.url))]);
            }
          }
        } catch (e2) { /* dead series -> next candidate */ }
      }
    }

    results.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return results.slice(0, 12);
  } catch (err) {
    return [];
  }
};
