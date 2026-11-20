module.exports = async function(type, tmdbId, season, episode) {
    try {
        // 1. Dynamically discover domain
        let domain = "vixsrc.to";
        try {
            const res = await fetch("https://raw.githubusercontent.com/realbestia1/domains/refs/heads/main/domains.json");
            if (res.ok) {
                const data = await res.json();
                if (data && data.vixsrc) {
                    domain = data.vixsrc.replace(/^https?:\/\//, '').replace(/\/$/, '');
                }
            }
        } catch (e) {
            console.warn("Failed to fetch vixsrc domain config, using fallback:", e);
        }

        // 2. Construct and fetch API URL
        const apiUrl = type === "movie" 
            ? `https://${domain}/api/movie/${tmdbId}`
            : `https://${domain}/api/tv/${tmdbId}/${season}/${episode}`;

        const apiRes = await fetch(apiUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*"
            }
        });

        if (!apiRes.ok) {
            console.error("API fetch failed:", apiRes.status);
            return [];
        }

        let apiText = await apiRes.text();
        let apiData;
        try {
            apiData = JSON.parse(apiText);
        } catch (e) {
            // Handle potential HTML-wrapped JSON (e.g., Chrome JSON viewer <pre> tag)
            const preMatch = apiText.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
            let textToParse = null;
            if (preMatch) {
                textToParse = preMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            } else if (apiText.trim().startsWith("{")) {
                textToParse = apiText.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            }
            
            if (textToParse) {
                try {
                    apiData = JSON.parse(textToParse);
                } catch (e2) {
                    console.error("Failed to parse API response even after cleanup:", e2);
                    return [];
                }
            } else {
                console.error("Invalid API response, not JSON");
                return [];
            }
        }

        const embedPath = apiData.src;
        if (!embedPath) {
            console.error("No embed src in API response");
            return [];
        }

        const embedUrl = `https://${domain}${embedPath}`;

        // 3. Fetch embed URL
        let embedHtml = "";
        try {
            const embedRes = await fetch(embedUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": `https://${domain}/`,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
                }
            });
            embedHtml = await embedRes.text();
            
            // Detect Cloudflare challenge and attempt bypass
            if (embedHtml.toLowerCase().includes("just a moment") || embedHtml.toLowerCase().includes("challenge")) {
                const cf = await bypassCloudflare(embedUrl);
                if (cf && cf.html) {
                    embedHtml = cf.html;
                }
            }
        } catch (e) {
            console.warn("Initial fetch failed, trying bypassCloudflare", e);
            try {
                const cf = await bypassCloudflare(embedUrl);
                if (cf && cf.html) {
                    embedHtml = cf.html;
                } else {
                    throw e;
                }
            } catch (cfErr) {
                console.error("bypassCloudflare also failed:", cfErr);
                return [];
            }
        }

        // 4. Extract token, expires, url, asn
        let token = null, expires = null, url = null, asn = null;
        
        // Try masterPlaylist structure first
        const masterMatch = embedHtml.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?params\s*:\s*\{([\s\S]*?)\}\s*,\s*url\s*:\s*['"]([^'"]+)['"]/);
        if (masterMatch) {
            const paramsBlock = masterMatch[1];
            url = masterMatch[2].replace(/\\\//g, "/").replace(/vixcloud\.co/g, domain).replace(/vixsrc\.to/g, domain);
            const tMatch = paramsBlock.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
            const eMatch = paramsBlock.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
            const aMatch = paramsBlock.match(/['"]asn['"]\s*:\s*['"]([^'"]*)['"]/);
            if (tMatch && eMatch) {
                token = tMatch[1];
                expires = eMatch[1];
                asn = aMatch ? aMatch[1] : null;
            }
        }
        
        // Fallback extraction
        if (!token || !expires || !url) {
            const tMatch = embedHtml.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
            const eMatch = embedHtml.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
            const uMatch = embedHtml.match(/url\s*:\s*['"]([^'"]+)['"]/);
            const aMatch = embedHtml.match(/['"]asn['"]\s*:\s*['"]([^'"]*)['"]/);
            
            if (tMatch && eMatch && uMatch) {
                token = tMatch[1];
                expires = eMatch[1];
                url = uMatch[1].replace(/\\\//g, "/").replace(/vixcloud\.co/g, domain).replace(/vixsrc\.to/g, domain);
                asn = aMatch ? aMatch[1] : null;
            }
        }
        
        if (!token || !expires || !url) {
            console.error("Failed to extract token/expires/url from embed");
            return [];
        }

        // 5. Build final URL manually to avoid reliance on URL/URLSearchParams APIs
        let baseUrl = url;
        let queryString = "";
        const qIndex = url.indexOf('?');
        if (qIndex !== -1) {
            baseUrl = url.substring(0, qIndex);
            queryString = url.substring(qIndex + 1);
        }
        
        const params = {};
        if (queryString) {
            const pairs = queryString.split('&');
            for (let i = 0; i < pairs.length; i++) {
                const kv = pairs[i].split('=');
                if (kv.length === 2) {
                    params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
                }
            }
        }
        
        params["token"] = token;
        params["expires"] = expires;
        params["lang"] = "it";
        if (/window\.canPlayFHD\s*=\s*true/i.test(embedHtml)) {
            params["h"] = "1";
        }
        if (asn) {
            params["asn"] = asn;
        }
        
        const newQuery = Object.keys(params).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join('&');
        const finalUrl = baseUrl + (newQuery ? "?" + newQuery : "");

        return [{
            url: finalUrl,
            quality: "1080p",
            provider: "VixSrc",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": `https://${domain}/`
            }
        }];

    } catch (e) {
        console.error("VixSrc extractor error:", e);
        return [];
    }
};
