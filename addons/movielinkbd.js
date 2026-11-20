/**
 * MovieLinkBD Addon for StreamBD IPA
 * Target: https://gh7uky.movielinkbd.at/ (with auto-mirrors movielinkbd.tv / movielinkbd.one)
 * Supports Movies & TV Series with HLS Master Playlists & Direct High-Speed MP4 Streams.
 */

module.exports = async function(type, tmdbId, season, episode) {
    const tmdbApiKey = "b911e74a3d17f8b87b908346ee2881ab";
    const primaryBase = "https://gh7uky.movielinkbd.at";
    const fallbackBases = ["https://movielinkbd.tv", "https://movielinkbd.one"];
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const providerName = "MovieLinkBD";

    const defaultHeaders = {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };

    // Helper: LCG XOR Decryption for MovieLinkBD data-dl attributes
    function decryptDataDl(b64, seedHex, rounds) {
        try {
            let x = parseInt(seedHex, 16) >>> 0;
            for (let i = 0; i < rounds; i++) {
                x = (Math.imul(x, 1103515245) + 12345) >>> 0;
            }
            let rawStr;
            if (typeof atob === "function") {
                rawStr = atob(b64);
            } else if (typeof Buffer !== "undefined") {
                rawStr = Buffer.from(b64, "base64").toString("binary");
            } else {
                return "";
            }
            let out = "";
            for (let j = 0; j < rawStr.length; j++) {
                x = (Math.imul(x, 1103515245) + 12345) >>> 0;
                out += String.fromCharCode(rawStr.charCodeAt(j) ^ ((x >>> 16) & 255));
            }
            return out;
        } catch (e) {
            return "";
        }
    }

    try {
        console.log(`[${providerName}] Resolving ${type} tmdbId=${tmdbId} S=${season} E=${episode}`);

        // 1. Fetch TMDB Metadata
        const tmdbType = type === "tv" ? "tv" : "movie";
        const tmdbUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${tmdbApiKey}&language=en-US`;
        
        let title = "";
        let year = "";
        try {
            const tmdbRes = await fetch(tmdbUrl, { headers: { "User-Agent": userAgent } });
            if (tmdbRes.ok) {
                const tmdbData = await tmdbRes.json();
                title = tmdbData.title || tmdbData.name || tmdbData.original_title || tmdbData.original_name || "";
                const dateStr = tmdbData.release_date || tmdbData.first_air_date || "";
                if (dateStr) {
                    year = dateStr.split("-")[0];
                }
            }
        } catch (e) {
            console.error(`[${providerName}] TMDB fetch error:`, e.message);
        }

        if (!title) {
            title = String(tmdbId);
        }
        console.log(`[${providerName}] Resolved title: "${title}" (${year})`);

        // Clean title for search
        const searchTitle = title
            .replace(/[:\-_]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // 2. Search MovieLinkBD
        let currentBase = primaryBase;
        let searchHtml = "";
        const allBases = [primaryBase, ...fallbackBases];

        for (const b of allBases) {
            try {
                const sUrl = `${b}/search?q=${encodeURIComponent(searchTitle)}`;
                const sRes = await fetch(sUrl, {
                    headers: { ...defaultHeaders, "Referer": `${b}/` }
                });
                if (sRes.ok) {
                    const txt = await sRes.text();
                    if (txt && txt.length > 500) {
                        searchHtml = txt;
                        currentBase = b;
                        break;
                    }
                }
            } catch (_) {}
        }

        if (!searchHtml) {
            console.error(`[${providerName}] Search returned empty response`);
            return [];
        }

        // 3. Parse Movie Cards from Search Results
        const cardRegex = /<div class="movie-card"[\s\S]*?href="(\/[^"]+)" class="title">([^<]+)<\/a>/gi;
        let cardMatch;
        const candidates = [];

        while ((cardMatch = cardRegex.exec(searchHtml)) !== null) {
            const href = cardMatch[1];
            const cardTitle = cardMatch[2].trim();
            candidates.push({ href, title: cardTitle });
        }

        if (candidates.length === 0) {
            // Loose fallback search regex
            const looseRegex = /<a[^>]+href="(\/(?:movie|series|drama)\/[^"]+)"[^>]*class="title"[^>]*>([^<]+)<\/a>/gi;
            while ((cardMatch = looseRegex.exec(searchHtml)) !== null) {
                candidates.push({ href: cardMatch[1], title: cardMatch[2].trim() });
            }
        }

        console.log(`[${providerName}] Found ${candidates.length} search candidate(s)`);
        if (candidates.length === 0) {
            return [];
        }

        // Filter and score candidates
        const cleanTarget = title.toLowerCase().replace(/[^a-z0-9]/g, "");
        let bestCandidate = null;
        let highestScore = -1;

        for (const cand of candidates) {
            const cLower = cand.title.toLowerCase();
            const cClean = cLower.replace(/[^a-z0-9]/g, "");
            let score = 0;

            // Media type match
            if (type === "movie") {
                if (cand.href.includes("/movie/")) score += 30;
                else if (cand.href.includes("/series/")) score -= 50;
            } else if (type === "tv") {
                if (cand.href.includes("/series/") || cand.href.includes("/drama/")) score += 30;
                else if (cand.href.includes("/movie/")) score -= 50;
            }

            // Title exact or substring match
            if (cClean === cleanTarget) {
                score += 100;
            } else if (cClean.includes(cleanTarget) || cleanTarget.includes(cClean)) {
                score += 50;
            }

            // Year match
            if (year && cLower.includes(year)) {
                score += 20;
            }

            // Season match for TV
            if (type === "tv" && season) {
                const sPats = [
                    new RegExp(`s0*${season}\\b`, "i"),
                    new RegExp(`season\\s*0*${season}\\b`, "i")
                ];
                if (sPats.some(p => p.test(cLower))) {
                    score += 40;
                }
            }

            if (score > highestScore) {
                highestScore = score;
                bestCandidate = cand;
            }
        }

        if (!bestCandidate) {
            bestCandidate = candidates[0];
        }

        console.log(`[${providerName}] Best match: "${bestCandidate.title}" (${bestCandidate.href}) score=${highestScore}`);

        // 4. Fetch Movie / Series Details Page
        const itemUrl = bestCandidate.href.startsWith("http")
            ? bestCandidate.href
            : `${currentBase}${bestCandidate.href}`;

        const itemRes = await fetch(itemUrl, {
            headers: { ...defaultHeaders, "Referer": `${currentBase}/` }
        });
        if (!itemRes.ok) {
            console.error(`[${providerName}] Failed to fetch item page: ${itemRes.status}`);
            return [];
        }

        const itemHtml = await itemRes.text();
        const streams = [];

        // 5. Look for Player Iframe (/p/...)
        let playerPath = null;
        const iframeMatch = itemHtml.match(/<iframe[^>]*\bid=["']mlbdHdFrame["'][^>]*src=["']([^"']+)["']/i) ||
                           itemHtml.match(/<iframe[^>]*src=["'](\/p\/[^"']+)["']/i);
        if (iframeMatch && iframeMatch[1]) {
            playerPath = iframeMatch[1];
        }

        if (playerPath) {
            const playerUrl = playerPath.startsWith("http") ? playerPath : `${currentBase}${playerPath}`;
            console.log(`[${providerName}] Found player iframe: ${playerUrl}`);

            try {
                const pRes = await fetch(playerUrl, {
                    headers: { ...defaultHeaders, "Referer": itemUrl }
                });
                if (pRes.ok) {
                    const pHtml = await pRes.text();
                    const pd2Match = pHtml.match(/window\.__PD2\s*=\s*(\{[\s\S]*?\});/);
                    if (pd2Match && pd2Match[1]) {
                        const pd2 = JSON.parse(pd2Match[1]);
                        const origin = new URL(currentBase).origin;

                        if (type === "movie") {
                            // Master HLS Stream
                            if (pd2.master) {
                                streams.push({
                                    url: pd2.master,
                                    quality: "1080p Full HD",
                                    provider: `${providerName} (HLS Master)`,
                                    type: "hls",
                                    headers: {
                                        "User-Agent": userAgent,
                                        "Referer": playerUrl,
                                        "Origin": origin
                                    }
                                });
                            }
                            // Direct MP4 Stream
                            if (pd2.episodes && pd2.episodes.length > 0 && pd2.episodes[0].mp4) {
                                streams.push({
                                    url: pd2.episodes[0].mp4,
                                    quality: "1080p Direct MP4",
                                    provider: `${providerName} (Fast Direct)`,
                                    type: "direct",
                                    headers: {
                                        "User-Agent": userAgent,
                                        "Referer": playerUrl,
                                        "Origin": origin
                                    }
                                });
                            }
                        } else {
                            // TV Series Episode matching
                            const episodesList = Array.isArray(pd2.episodes) ? pd2.episodes : [];
                            const targetSeason = parseInt(season || 1, 10);
                            const targetEpisode = parseInt(episode || 1, 10);

                            let matchedEp = episodesList.find(e => 
                                (e.season === targetSeason || e.s === targetSeason) &&
                                (e.number === targetEpisode || e.ep === targetEpisode || e.episode === targetEpisode)
                            );

                            if (!matchedEp && episodesList.length > 0) {
                                const idx = targetEpisode - 1;
                                if (idx >= 0 && idx < episodesList.length) {
                                    matchedEp = episodesList[idx];
                                }
                            }

                            if (matchedEp) {
                                if (matchedEp.master) {
                                    streams.push({
                                        url: matchedEp.master,
                                        quality: "1080p HD",
                                        provider: `${providerName} (S${targetSeason}E${targetEpisode} HLS)`,
                                        type: "hls",
                                        headers: {
                                            "User-Agent": userAgent,
                                            "Referer": playerUrl,
                                            "Origin": origin
                                        }
                                    });
                                }
                                if (matchedEp.mp4) {
                                    streams.push({
                                        url: matchedEp.mp4,
                                        quality: "1080p Direct MP4",
                                        provider: `${providerName} (S${targetSeason}E${targetEpisode} MP4)`,
                                        type: "direct",
                                        headers: {
                                            "User-Agent": userAgent,
                                            "Referer": playerUrl,
                                            "Origin": origin
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`[${providerName}] Player parsing error:`, err.message);
            }
        }

        // 6. Fallback: Parse Episode Cards (.ep-card) with Decrypted Download Links
        if (streams.length === 0 && type === "tv") {
            console.log(`[${providerName}] Checking episode cards fallback...`);
            const targetSeason = parseInt(season || 1, 10);
            const targetEpisode = parseInt(episode || 1, 10);

            // Match card by data-season-number and data-episode-number or data-ep
            const epCardRegex = new RegExp(
                `<div[^>]*class=["'][^"']*ep-card[^"']*["'][^>]*data-season-number=["']${targetSeason}["'][^>]*data-episode-number=["']${targetEpisode}["'][^>]*>([\\s\\S]*?)<\\/div>\\s*<\\/div>\\s*<\\/div>`,
                "i"
            );
            const fallbackEpRegex = new RegExp(
                `<div[^>]*class=["'][^"']*ep-card[^"']*["'][^>]*data-ep=["'][^"']*s0*${targetSeason}e0*${targetEpisode}[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>\\s*<\\/div>\\s*<\\/div>`,
                "i"
            );

            let epMatch = itemHtml.match(epCardRegex) || itemHtml.match(fallbackEpRegex);
            let epSnippet = epMatch ? epMatch[0] : "";

            if (!epSnippet) {
                // If specific card not isolated, search for any data-dl in the page
                const allDl = /data-dl=["']([^"']+)["'][^>]*data-ds=["']([^"']*)["'][^>]*data-dr=["'](\d+)["']/i;
                epMatch = itemHtml.match(allDl);
                if (epMatch) {
                    epSnippet = epMatch[0];
                }
            }

            if (epSnippet) {
                const dlMatch = epSnippet.match(/data-dl=["']([^"']+)["']/i);
                const dsMatch = epSnippet.match(/data-ds=["']([^"']*)["']/i);
                const drMatch = epSnippet.match(/data-dr=["'](\d+)["']/i);

                if (dlMatch && dlMatch[1]) {
                    const ds = dsMatch ? dsMatch[1] : "";
                    const dr = drMatch ? parseInt(drMatch[1], 10) : 0;
                    const filePath = decryptDataDl(dlMatch[1], ds, dr);

                    if (filePath && filePath.startsWith("/file/")) {
                        const fileGatewayUrl = `${currentBase}${filePath}`;
                        try {
                            const fRes = await fetch(fileGatewayUrl, {
                                headers: { ...defaultHeaders, "Referer": itemUrl }
                            });
                            if (fRes.ok) {
                                const fHtml = await fRes.text();
                                // Look for FSL direct gateway link
                                const fslMatch = fHtml.match(/href=["'](\/file\/[^"']+)["'][^>]*>[\s\S]*?(?:FSL|Fastest)/i);
                                if (fslMatch && fslMatch[1]) {
                                    const fslUrl = `${currentBase}${fslMatch[1]}`;
                                    const fslRes = await fetch(fslUrl, {
                                        headers: { ...defaultHeaders, "Referer": fileGatewayUrl }
                                    });
                                    if (fslRes.ok) {
                                        const fslHtml = await fslRes.text();
                                        const streamMatch = fslHtml.match(/href=["'](https?:\/\/fsl\.movielink\.tv\/d\/[^"']+)["']/i);
                                        if (streamMatch && streamMatch[1]) {
                                            streams.push({
                                                url: streamMatch[1],
                                                quality: "720p HD",
                                                provider: `${providerName} (S${targetSeason}E${targetEpisode} Direct)`,
                                                type: "direct",
                                                headers: {
                                                    "User-Agent": userAgent,
                                                    "Referer": `${currentBase}/`
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`[${providerName}] Episode card resolve error:`, err.message);
                        }
                    }
                }
            }
        }

        console.log(`[${providerName}] Successfully returned ${streams.length} stream source(s)`);
        return streams;

    } catch (err) {
        console.error(`[${providerName}] Fatal error:`, err);
        return [];
    }
};
