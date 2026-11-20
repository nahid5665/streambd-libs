module.exports = async function(type, tmdbId, season, episode) {
    const baseUrl = "https://net52.cc";
    const userAgent = "Mozilla/5.0 (Linux; Android 13; RMX3461 Build/TP1A.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.184 Mobile Safari/537.36 /OS.Gatu v3.1";
    const tmdbKey = "b911e74a3d17f8b87b908346ee2881ab";
    let userhash = "";
    const T = () => Date.now();

    try {
        if (typeof bypassCloudflare === 'function') {
            const t0 = T();
            await bypassCloudflare(baseUrl);
            console.log("[TIMING] bypassCloudflare: " + (T() - t0) + "ms");
        }
    } catch (e) {
        console.error("Cloudflare bypass error: " + e.message);
    }

    function extractHash(res) {
        const setCookie = (res.headers.get("Set-Cookie") || "") + "," +
                          (res.headers.get("set-cookie") || "");
        const match = setCookie.match(/t_hash_t=([^;, ]+)/);
        if (match) return decodeURIComponent(match[1]);
        return "";
    }

    try {
        // ── TMDB ──
        const tTmdb = T();
        const tmdbRes = await fetch(
            `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}`
        );
        console.log("[TIMING] TMDB fetch: " + (T() - tTmdb) + "ms");
        if (!tmdbRes.ok) return [];

        const tmdbData = await tmdbRes.json();
        const targetSearchTitle = tmdbData.title || tmdbData.name ||
                                  tmdbData.original_title || tmdbData.original_name;
        if (!targetSearchTitle) return [];
        console.log("[TITLE] " + targetSearchTitle);

        // ── Home fetch once ──
        const homeUrl = baseUrl + "/mobile/home?app=1";
        const tHome = T();
        const homeRes = await fetch(homeUrl, {
            headers: { "User-Agent": userAgent }
        });
        console.log("[TIMING] home fetch: " + (T() - tHome) + "ms status=" + homeRes.status);

        const initialHash = extractHash(homeRes);
        console.log("[AUTH] hash1=" +
                    (initialHash ? initialHash.substring(0, 8) + "..." : "MISSING"));

        const html = await homeRes.text();
        const match = html.match(/data-addhash="([^"]+)"/);
        if (!match) {
            console.error("[AUTH] no addhash");
            return [];
        }
        const addhash = match[1];
        console.log("[AUTH] addhash=" + addhash.substring(0, 12) + "...");

        // ═══════════════════════════════════════════════════════
        // WARMUP — server needs ~40-60s of continuous ad activity
        // before it will issue the t_hash_t cookie.
        //
        // The server credits ad impressions asynchronously. Our
        // earlier 20s window was too short — 60s (with 2 pings
        // per iteration) has empirically worked when the user
        // manually pressed Play 3 times.
        // ═══════════════════════════════════════════════════════
        const adUrl = `https://userver.net52.cc/?hee5=${encodeURIComponent(addhash)}&a=y`;

        const warmupStart = T();
        const MAX_WARMUP_MS = 60000;   // ← 60 seconds
        let iteration = 0;

        while (T() - warmupStart < MAX_WARMUP_MS) {
            iteration++;

            // ── Two ad pings per iteration for extra impressions ──
            for (let pingIdx = 0; pingIdx < 2; pingIdx++) {
                try {
                    await fetch(adUrl + "&t=" + Math.random() +
                                "&n=" + iteration + "_" + pingIdx, {
                        method: 'GET',
                        headers: { "User-Agent": userAgent }
                    });
                } catch (_) {}
            }

            // ── Verify ──
            let hash2 = "";
            try {
                const verifyRes = await fetch(baseUrl + "/mobile/verify2.php", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "User-Agent": userAgent,
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": homeUrl,
                        "Origin": baseUrl
                    },
                    body: "verify=" + encodeURIComponent(addhash)
                });
                hash2 = extractHash(verifyRes);
            } catch (e) {
                console.error("[WARMUP] iter " + iteration + " verify threw: " + e.message);
            }

            const elapsed = T() - warmupStart;
            console.log("[WARMUP] iter " + iteration + ": hash2=" +
                        (hash2 ? hash2.substring(0, 8) + "..." : "MISSING") +
                        " elapsed=" + elapsed + "ms");

            if (hash2 && hash2.length >= 10) {
                userhash = hash2;
                console.log("[WARMUP] SUCCESS after " + iteration +
                            " iterations, " + elapsed + "ms");
                break;
            }
        }

        if (!userhash && initialHash && initialHash.length >= 10) {
            userhash = initialHash;
            console.log("[WARMUP] using home hash as fallback");
        }

        if (!userhash || userhash.length < 10) {
            console.warn("[WARMUP] timed out with no hash — proceeding without it");
            userhash = "";
        } else {
            console.log("[SESSION] using userhash=" + userhash.substring(0, 8) + "...");
        }

        // ── Provider searches ──
        const timestamp = Math.floor(Date.now() / 1000);
        const searchTarget = targetSearchTitle.toLowerCase().trim();

        const providers = [
            { type: "Netflix",    searchPath: "/mobile/search.php",    playlistPath: "/mobile/playlist.php",    extraStr: "" },
            { type: "Prime Video", searchPath: "/mobile/pv/search.php", playlistPath: "/mobile/pv/playlist.php", extraStr: "&lang=null&hd=null" },
            { type: "Hotstar",    searchPath: "/mobile/hs/search.php", playlistPath: "/mobile/hs/playlist.php", extraStr: "&lang=null&hd=null" }
        ];

        const providerPromises = providers.map(async (provider) => {
            const tProvider = T();
            try {
                const searchUrl = `${baseUrl}${provider.searchPath}?s=${encodeURIComponent(targetSearchTitle)}&t=${timestamp}&ADSearch=false`;
                const searchRes = await fetch(searchUrl, {
                    method: "GET",
                    headers: {
                        "User-Agent": userAgent,
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept": "*/*",
                        "Referer": baseUrl + "/mobile/home?app=1"
                    }
                });

                if (!searchRes.ok) return [];

                const searchData = await searchRes.json();
                const resultCount = (searchData && searchData.searchResult)
                    ? searchData.searchResult.length : 0;
                console.log("[SEARCH][" + provider.type + "] elapsed=" +
                            (T() - tProvider) + "ms results=" + resultCount);

                if (!searchData || !searchData.searchResult ||
                    searchData.searchResult.length === 0) return [];

                const matchedResults = searchData.searchResult.filter(item => {
                    if (!item.t) return false;
                    const itemTitle = item.t.toLowerCase().trim();
                    return itemTitle === searchTarget ||
                           itemTitle.startsWith(searchTarget + ":") ||
                           itemTitle.startsWith(searchTarget + " ") ||
                           itemTitle.startsWith(searchTarget + "(") ||
                           itemTitle.startsWith(searchTarget + "-");
                });

                if (matchedResults.length === 0) {
                    console.log("[SEARCH][" + provider.type + "] no title match");
                    return [];
                }
                console.log("[SEARCH][" + provider.type + "] matched=" +
                            matchedResults.length);

                const plTimestamp = Math.floor(Date.now() / 1000);
                const playlistPromises = matchedResults.map(async (matchedItem) => {
                    try {
                        let playlistUrl = `${baseUrl}${provider.playlistPath}?id=${matchedItem.id}&t=${encodeURIComponent(matchedItem.t)}&tm=${plTimestamp}&userhash=${encodeURIComponent(userhash)}${provider.extraStr}`;

                        if (type === "tv" && season !== null && episode !== null) {
                            playlistUrl += `&s=${season}&e=${episode}`;
                        }

                        const tPl = T();
                        const plRes = await fetch(playlistUrl, {
                            method: "GET",
                            headers: {
                                "User-Agent": userAgent,
                                "X-Requested-With": "app.netmirror.nmv2",
                                "Accept": "*/*",
                                "Referer": baseUrl + "/mobile/home?app=1"
                            }
                        });

                        console.log("[PLAYLIST][" + provider.type + "][" +
                                    matchedItem.t + "] elapsed=" + (T() - tPl) +
                                    "ms status=" + plRes.status);

                        if (!plRes.ok) return null;
                        const data = await plRes.json();
                        return { data, title: matchedItem.t, providerType: provider.type };
                    } catch (e) {
                        console.error(`Playlist fetch failed: ` + e.message);
                        return null;
                    }
                });

                return await Promise.all(playlistPromises);
            } catch (e) {
                console.error(`Provider ${provider.type} failed: ` + e.message);
                return [];
            }
        });

        const providerResultsArray = await Promise.all(providerPromises);
        const results = [];

        for (const playlistsArray of providerResultsArray) {
            if (!playlistsArray) continue;
            for (const pl of playlistsArray) {
                if (!pl) continue;
                try {
                    const playlistData = pl.data;
                    if (!playlistData || playlistData.length === 0 ||
                        !playlistData[0]?.sources) continue;

                    const source = playlistData[0].sources[0];
                    if (!source || !source.file) continue;

                    let fileUrl = source.file;
                    if (!fileUrl.startsWith("http")) {
                        fileUrl = fileUrl.startsWith("//")
                            ? "https:" + fileUrl
                            : baseUrl + fileUrl;
                    }

                    results.push({
                        url: fileUrl,
                        quality: source.label || "Auto",
                        provider: "NetMirror",
                        type: pl.providerType,
                        headers: {
                            "User-Agent": userAgent,
                            "Referer": baseUrl + "/",
                            "X-Requested-With": "app.netmirror.nmv2"
                        }
                    });
                } catch (e) {
                    console.error("Skipping bad source: " + e.message);
                }
            }
        }

        const hasUnknownToken = results.some(r => r.url.includes("in=unknown"));
        if (hasUnknownToken) {
            console.warn("[DONE] WARNING: in=unknown present — playback may fail");
        }
        console.log("[DONE] total sources=" + results.length);
        return results;
    } catch (e) {
        console.error("Fatal error: " + e.toString());
        return [];
    }
};
