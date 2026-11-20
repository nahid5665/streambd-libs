module.exports = async function(type, tmdbId, season, episode) {
    try {
        const tmdbApiKey = "b911e74a3d17f8b87b908346ee2881ab";
        const tmdbUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbApiKey}`;
        const baseUrl = "http://flix.playtimebd.live";
        const providerName = "11Plus Flix";

        function extractVideoFromHtml(html) {
            try {
                const regex = /src:\s*['"](http[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i;
                let match = html.match(regex);
                
                if (!match) {
                    const fallbackRegex = /(?:src=|videoEl\.src\s*=\s*)['"](http[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i;
                    match = html.match(fallbackRegex);
                }
                
                if (!match || !match[1]) return [];
                
                const videoUrl = match[1];
                const isHls = videoUrl.indexOf(".m3u8") !== -1;
                
                let quality = "Auto";
                if (videoUrl.indexOf("1080") !== -1) quality = "1080p";
                else if (videoUrl.indexOf("720") !== -1) quality = "720p";
                else if (videoUrl.indexOf("480") !== -1) quality = "480p";

                return [{
                    url: videoUrl,
                    quality: quality,
                    provider: providerName,
                    type: isHls ? "hls" : "mp4",
                    headers: {
                        "Referer": baseUrl + "/",
                        "User-Agent": "Mozilla/5.0"
                    }
                }];
            } catch (e) {
                console.error("HTML Extraction failed: " + e.toString());
                return [];
            }
        }

        console.log(`Fetching TMDB metadata for ${type} ${tmdbId}`);
        const tmdbResp = await fetch(tmdbUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        
        if (!tmdbResp.ok) {
            console.error("TMDB fetch failed: " + tmdbResp.status);
            return [];
        }
        
        let data;
        try {
            data = await tmdbResp.json();
        } catch (e) {
            console.error("Failed to parse TMDB JSON: " + e.toString());
            return [];
        }
        
        if (!data.name && !data.title) {
            console.error("No title found in TMDB response");
            return [];
        }
        
        const title = type === "movie" ? data.title : data.name;
        const releaseDate = type === "movie" ? data.release_date : data.first_air_date;
        const year = releaseDate ? releaseDate.split("-")[0] : "";
        
        const slugStandard = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        const slugStripped = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
        
        const searchQuery = encodeURIComponent(title);
        const searchUrl = `${baseUrl}/search?q=${searchQuery}`;

        console.log(`Searching ${providerName}: ${searchUrl}`);
        const searchResp = await fetch(searchUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        
        if (!searchResp.ok) {
            console.error("Search failed: " + searchResp.status);
            return [];
        }
        
        const searchHtml = await searchResp.text();
        const typeSuffix = type === "movie" ? "movie" : "tv";
        
        const exactRegex1 = new RegExp(`href="([^"]+/watch/${slugStandard}-${year}-${typeSuffix}\\.html)"`, 'i');
        const exactRegex2 = new RegExp(`href="([^"]+/watch/${slugStripped}-${year}-${typeSuffix}\\.html)"`, 'i');
        const exactRegex3 = new RegExp(`href="([^"]+/watch/${slugStandard}(?:-[0-9]{4})?-${typeSuffix}\\.html)"`, 'i');
        const exactRegex4 = new RegExp(`href="([^"]+/watch/${slugStripped}(?:-[0-9]{4})?-${typeSuffix}\\.html)"`, 'i');

        const match = searchHtml.match(exactRegex1) || 
                      searchHtml.match(exactRegex2) || 
                      searchHtml.match(exactRegex3) || 
                      searchHtml.match(exactRegex4);
        
        if (!match || !match[1]) {
            console.log("No exact match found in search results.");
            return [];
        }
        
        let pageUrl = match[1];
        if (pageUrl.indexOf("http") === -1) {
            pageUrl = pageUrl.charAt(0) === '/' ? baseUrl + pageUrl : baseUrl + "/" + pageUrl;
        }

        console.log(`Found content page: ${pageUrl}`);

        if (type === "movie") {
            const pageResp = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!pageResp.ok) {
                console.error("Movie page fetch failed: " + pageResp.status);
                return [];
            }
            const html = await pageResp.text();
            return extractVideoFromHtml(html);
        } else {
            const pageResp = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!pageResp.ok) {
                console.error("TV page fetch failed: " + pageResp.status);
                return [];
            }
            const html = await pageResp.text();
            
            const epRegex = new RegExp(`<a[^>]+href="([^"]+key=[^"]+)"[^>]*>[\\s\\S]*?(?:alt="0?${episode}\\s*-|Episode\\s*0?${episode}\\b)`, 'i');
            const epMatch = html.match(epRegex);
            
            if (!epMatch || !epMatch[1]) {
                console.log(`Episode ${episode} link not found.`);
                return [];
            }
            
            let epUrl = epMatch[1];
            if (epUrl.indexOf("http") === -1) {
                epUrl = epUrl.charAt(0) === '/' ? baseUrl + epUrl : baseUrl + "/" + epUrl;
            }
            
            console.log(`Found episode URL: ${epUrl}`);
            const epResp = await fetch(epUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!epResp.ok) {
                console.error("Episode page fetch failed: " + epResp.status);
                return [];
            }
            const epHtml = await epResp.text();
            return extractVideoFromHtml(epHtml);
        }
    } catch (e) {
        console.error("Fatal error in 11Plus addon: " + e.toString());
        return [];
    }
};
