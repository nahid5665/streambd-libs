module.exports = async function(type, tmdbId, season, episode) {
    try {
        const baseUrl = "https://cockpit.ctgmovies.com/api/v1";
        const userAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": userAgent,
            "Origin": "https://ctgmovies.com",
            "Referer": "https://ctgmovies.com/"
        };
        
        const tmdbApiKey = "b911e74a3d17f8b87b908346ee2881ab"; 
        const tmdbUrl = `https://api.themoviedb.org/3/${type === "movie" ? "movie" : "tv"}/${tmdbId}?api_key=${tmdbApiKey}`;

        // Batch independent requests with Promise.all for speed
        const [tmdbRes, authRes] = await Promise.all([
            fetch(tmdbUrl).catch(() => ({ ok: false })),
            fetch(`${baseUrl}/auth/login`, {
                method: "POST",
                headers: headers,
                body: JSON.stringify({
                    email: "gobop98171@joystill.com",
                    password: "Joy1971"
                })
            }).catch(() => ({ ok: false }))
        ]);

        let movieTitle = String(tmdbId);
        if (tmdbRes.ok) {
            try {
                const tmdbData = await tmdbRes.json();
                movieTitle = (tmdbData && (tmdbData.title || tmdbData.name || tmdbData.original_title)) || String(tmdbId);
            } catch (e) {
                console.error("TMDB JSON parse error", e);
            }
        }

        let token = "";
        if (authRes.ok) {
            try {
                const authData = await authRes.json();
                if (authData && authData.token) {
                    token = authData.token;
                }
            } catch (e) {
                console.error("Auth JSON parse error", e);
            }
        }

        if (!token) {
            return [];
        }

        const path = type === "movie" ? "/movies" : "/series";
        const authHeaders = {
            "x-auth-token": token,
            "authorization": `Bearer ${token}`,
            "Accept": "application/json",
            "User-Agent": userAgent
        };
        
        const searchUrl = `${baseUrl}${path}?search=${encodeURIComponent(movieTitle)}&limit=24`;
        const searchRes = await fetch(searchUrl, { headers: authHeaders });
        
        let matchedItem = null;
        if (searchRes.ok) {
            try {
                const searchData = await searchRes.json();
                const items = (searchData && (searchData.movies || searchData.series || searchData.results || searchData.data)) || [];
                
                // 1. Strict Match: TMDB ID
                for (const item of items) {
                    if (String(item.tmdb_id) === String(tmdbId)) {
                        matchedItem = item;
                        break;
                    }
                }
                
                // 2. Loose Match: By Title
                if (!matchedItem && movieTitle !== String(tmdbId) && items.length > 0) {
                    const lowerTitle = movieTitle.toLowerCase();
                    for (const item of items) {
                        const itemTitle = (item.title || item.name || "").toLowerCase();
                        if (itemTitle.includes(lowerTitle)) {
                            matchedItem = item;
                            break;
                        }
                    }
                }

                // 3. Last Resort: Pick the first search result
                if (!matchedItem && items.length > 0) {
                    matchedItem = items[0];
                }
            } catch (e) {
                console.error("Search JSON parse error", e);
            }
        }

        if (!matchedItem) {
            return [];
        }

        const id = matchedItem.id || matchedItem._id;
        let watchInfo = null;

        if (type === "tv") {
            const epUrl = `${baseUrl}/episodes?series_id=${id}&season=${season}&episode=${episode}`;
            const epRes = await fetch(epUrl, { headers: authHeaders });
            if (epRes.ok) {
                try {
                    const epData = await epRes.json();
                    const eps = (epData && (epData.episodes || epData.data || epData.results)) || [];
                    if (eps.length > 0) {
                        watchInfo = { watchId: eps[0].id || eps[0]._id, watchType: "episode" };
                    }
                } catch (e) {
                    console.error("Episodes JSON parse error", e);
                }
            }
            
            if (!watchInfo) {
                const directEpUrl = `${baseUrl}/series/${id}/seasons/${season}/episodes/${episode}`;
                const directEpRes = await fetch(directEpUrl, { headers: authHeaders });
                if (directEpRes.ok) {
                    try {
                        const detail = await directEpRes.json();
                        if (detail && (detail.id || detail._id)) {
                            watchInfo = { watchId: detail.id || detail._id, watchType: "episode" };
                        }
                    } catch (e) {
                        console.error("Direct Episode JSON parse error", e);
                    }
                }
            }
        } else {
            watchInfo = { watchId: id, watchType: "movie" };
        }

        if (!watchInfo) {
            return [];
        }

        // Step 5: Try to extract streaming links dynamically from Watch Page RSC Payload
        const watchUrl = `https://ctgmovies.com/watch/${watchInfo.watchId}?type=${watchInfo.watchType}`;
        const watchRes = await fetch(watchUrl, {
            headers: {
                "RSC": "1", 
                "Cookie": `ctg_token=${token}`,
                "User-Agent": userAgent,
                "Accept": "*/*",
                "Referer": "https://ctgmovies.com/"
            }
        });

        let uniqueLinks = [];
        if (watchRes.ok) {
            try {
                const text = await watchRes.text();
                const extractedLinks = [];
                
                function extract(obj, depth) {
                    if (!obj || depth > 20) return;
                    if (Array.isArray(obj)) {
                        for (let i = 0; i < obj.length; i++) extract(obj[i], depth + 1);
                    } else if (typeof obj === 'object') {
                        if (obj.links && Array.isArray(obj.links)) {
                            for (let j = 0; j < obj.links.length; j++) {
                                const link = obj.links[j];
                                if (link && (link.url || link.hls_url || link.file)) {
                                    extractedLinks.push(link);
                                }
                            }
                        }
                        for (const key in obj) {
                            if (key !== 'links') extract(obj[key], depth + 1);
                        }
                    }
                }

                const lines = (text || "").split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    
                    const match = line.match(/^[0-9a-fA-F]+:(.*)/);
                    if (match) {
                        try { extract(JSON.parse(match[1]), 0); } catch(e) {}
                    }
                    
                    const chunks = line.split('self.__next_f.push(');
                    for (let c = 1; c < chunks.length; c++) {
                        try {
                            const chunk = chunks[c];
                            const bracketEnd = chunk.indexOf('])');
                            if (bracketEnd !== -1) {
                                const arr = JSON.parse(chunk.substring(0, bracketEnd + 1));
                                if (arr.length >= 2 && typeof arr[1] === 'string') {
                                    const rscMatch = arr[1].match(/^[0-9a-fA-F]+:(.*)/);
                                    if (rscMatch) extract(JSON.parse(rscMatch[1]), 0);
                                }
                            }
                        } catch(e) {}
                    }
                }
                
                const seenUrls = {};
                for (const item of extractedLinks) {
                    const u = item.hls_url || item.url || item.file;
                    if (!u || seenUrls[u]) continue; // Skip bad/duplicate items individually
                    seenUrls[u] = true;
                    
                    const lang = item.language ? ` - ${item.language}` : "";
                    const q = item.quality || item.resolution || "Auto";
                    
                    uniqueLinks.push({
                        url: u,
                        quality: q,
                        provider: "CTG Movies",
                        type: lang,
                        headers: {
                            "Referer": "https://ctgmovies.com/",
                            "User-Agent": userAgent,
                            "Cookie": `ctg_token=${token}`
                        }
                    });
                }
            } catch (e) {
                console.error("Watch page parse error", e);
            }
        }

        if (uniqueLinks.length > 0) {
            return uniqueLinks;
        }

        // Step 6: Fallback - API endpoint for direct links if Watch Page parsing fails
        const fallbackUrl = `${baseUrl}/links?${watchInfo.watchType === "movie" ? "movie_id=" : "episode_id="}${watchInfo.watchId}`;
        const fallbackRes = await fetch(fallbackUrl, { headers: authHeaders });
        
        if (fallbackRes.ok) {
            try {
                const linkData = await fallbackRes.json();
                const apiLinks = (linkData && (linkData.links || linkData.data)) || (Array.isArray(linkData) ? linkData : []);
                const fbResults = [];
                const seenUrls = {};
                
                for (const fbItem of apiLinks) {
                    const fbUrl = fbItem.url || fbItem.link || fbItem.file;
                    if (!fbUrl || seenUrls[fbUrl]) continue; // Skip bad/duplicate items individually
                    seenUrls[fbUrl] = true;
                    
                    const lang = fbItem.language ? ` - ${fbItem.language}` : "";
                    const q = fbItem.quality || fbItem.resolution || "Auto";
                    
                    fbResults.push({
                        url: fbUrl,
                        quality: q,
                        provider: "CTG Movies",
                        type: lang,
                        headers: {
                            "Referer": "https://ctgmovies.com/",
                            "User-Agent": userAgent,
                            "Cookie": `ctg_token=${token}`
                        }
                    });
                }
                return fbResults;
            } catch (e) {
                console.error("Fallback links JSON parse error", e);
            }
        }

        return [];
    } catch (err) {
        console.error("resolveStream error:", err);
        return []; // Always return a clean array on failure to prevent app crash
    }
};
