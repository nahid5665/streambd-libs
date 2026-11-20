module.exports = async function(type, tmdbId, season, episode) {
  try {
    const tmdbApiKey = "b911e74a3d17f8b87b908346ee2881ab";
    const baseUrl = "http://cineplexbd.net";
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const tmdbApiUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbApiKey}&language=en-US`;
    
    const tmdbRes = await fetch(tmdbApiUrl, {
      headers: { "User-Agent": userAgent }
    });
    
    if (!tmdbRes || !tmdbRes.ok) {
      return [];
    }
    
    const data = await tmdbRes.json();
    if (!data) {
      return [];
    }
    
    const title = type === "movie" ? data.title : data.name;
    if (!title) {
      return [];
    }
    
    const searchTitleClean = title.replace(/-/g, ' ').trim();
    const targetTitleClean = title.replace(/-/g, ' ').replace(/[^\w\s]/g, '').trim().toLowerCase();
    
    const searchUrl = `${baseUrl}/search.php?q=${encodeURIComponent(searchTitleClean)}`;
    
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": userAgent }
    });
    
    if (!searchRes || !searchRes.ok) {
      return [];
    }
    
    const html = await searchRes.text();
    if (!html || typeof html !== "string") {
      return [];
    }
    
    const searchResults = [];
    const uniqueIds = {};
    
    const blocks = html.split(/href=["'](?:view|watch)\.php\?id=/i);
    
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const idMatch = block.match(/^(\d+)/);
      
      if (idMatch && idMatch[1]) {
        const id = idMatch[1];
        
        const titleRegex = /<span[^>]*class=["'][^"']*truncate[^"']*["'][^>]*>\s*([^<]+?)\s*<\/span>/i;
        const titleMatch = block.match(titleRegex);
        
        if (titleMatch && titleMatch[1]) {
          const siteTitleClean = titleMatch[1].replace(/-/g, ' ').replace(/[^\w\s]/g, '').trim().toLowerCase();
          
          if (siteTitleClean === targetTitleClean && !uniqueIds[id]) {
            uniqueIds[id] = true;
            
            let quality = "Auto";
            const qualityMatch = block.match(/>\s*(4K|1080P|720P|480P)\s*</i);
            if (qualityMatch && qualityMatch[1]) {
              quality = qualityMatch[1];
            }
            
            searchResults.push({
              id: id,
              quality: quality
            });
          }
        }
      }
    }
    
    if (searchResults.length === 0) {
      return [];
    }
    
    const fetchPromises = searchResults.map(async (item) => {
      try {
        const viewPageUrl = `${baseUrl}/view.php?id=${item.id}`;
        const streamPageUrl = (type === "tv") 
          ? `${baseUrl}/watch.php?id=${item.id}&season=${season}&ep=${episode}`
          : `${baseUrl}/player.php?id=${item.id}`;

        const viewRes = await fetch(viewPageUrl, {
          headers: { 
            "User-Agent": userAgent,
            "Referer": baseUrl + "/"
          }
        });
        
        let viewCookie = "";
        if (viewRes && viewRes.headers && typeof viewRes.headers.get === "function") {
          viewCookie = viewRes.headers.get("set-cookie") || "";
        }
        
        const streamRes = await fetch(streamPageUrl, {
          headers: {
            "User-Agent": userAgent,
            "Referer": viewPageUrl,
            "Cookie": viewCookie
          }
        });
        
        let setCookie = "";
        if (streamRes && streamRes.headers && typeof streamRes.headers.get === "function") {
          setCookie = streamRes.headers.get("set-cookie") || "";
        }
        const combinedCookie = viewCookie ? (viewCookie + "; " + setCookie) : setCookie;
        
        if (!streamRes || !streamRes.ok) {
          return null;
        }
        
        const playerHtml = await streamRes.text();
        if (!playerHtml || typeof playerHtml !== "string") {
          return null;
        }
        
        let streamUrl = null;
        const sourceRegex = /<source\s+src=["']([^"']+)["']/i;
        const sourceMatch = playerHtml.match(sourceRegex);
        
        if (sourceMatch && sourceMatch[1]) {
          streamUrl = sourceMatch[1];
        } else {
          const jsRegex = /const\s+videoSrc\s*=\s*["']([^"']+)["']/i;
          const jsMatch = playerHtml.match(jsRegex);
          if (jsMatch && jsMatch[1]) {
            streamUrl = jsMatch[1];
          }
        }
        
        if (streamUrl) {
          if (streamUrl.indexOf("http") !== 0) {
            if (streamUrl.indexOf("/") === 0) {
              streamUrl = baseUrl + streamUrl;
            } else {
              streamUrl = baseUrl + "/" + streamUrl;
            }
          }
          
          const headersObj = {
            "Referer": baseUrl + "/",
            "Origin": baseUrl,
            "User-Agent": userAgent
          };
          if (combinedCookie) {
            headersObj["Cookie"] = combinedCookie;
          }
          
          return {
            url: streamUrl,
            quality: item.quality,
            provider: "CineplexBD",
            headers: headersObj
          };
        }
        return null;
      } catch (err) {
        console.error("cineplexbdStream item error:", err);
        return null;
      }
    });
    
    const streamResults = await Promise.all(fetchPromises);
    
    const finalStreams = [];
    for (let i = 0; i < streamResults.length; i++) {
      if (streamResults[i] !== null) {
        finalStreams.push(streamResults[i]);
      }
    }
    
    return finalStreams;
  } catch (err) {
    console.error("cineplexbdStream error:", err);
    return [];
  }
};
