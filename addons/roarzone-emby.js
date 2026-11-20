module.exports = async function(type, tmdbId, season, episode) {
    var serverUrl = "https://play.roarzone.net";
    var deviceId = "a82c8593-c522-41b1-bda6-d752c415a875";
    var clientVersion = "4.9.3.0";

    function safeJson(text, tag) {
        try {
            return JSON.parse(text);
        } catch (e) {
            console.error("[" + tag + "] JSON parse failed. First 200: " + String(text).slice(0, 200));
            return null;
        }
    }

    // ── Step 0: discover the public guest user, then authenticate with empty password ──
    async function authenticate() {
        var authHeader = 'MediaBrowser Client="Emby Web", Device="Google Chrome Android", ' +
            'DeviceId="' + deviceId + '", Version="' + clientVersion + '"';

        // 0a. list public users — guest server exposes them without auth
        var pubRes = await fetch(serverUrl + "/emby/Users/Public", {
            headers: { "Accept": "application/json" }
        });
        console.log("[AUTH] public users status=" + pubRes.status);

        if (!pubRes.ok) {
            console.error("[AUTH] could not list public users");
            return null;
        }

        var pubText = await pubRes.text();
        var pubUsers = safeJson(pubText, "AUTH");
        if (!pubUsers || !Array.isArray(pubUsers) || pubUsers.length === 0) {
            console.error("[AUTH] no public users returned");
            return null;
        }

        // prefer a guest-looking user, else take the first
        var guest = pubUsers.find(function(u) {
            return u.HasPassword === false;
        }) || pubUsers[0];

        console.log("[AUTH] using public user=" + guest.Name + " id=" + guest.Id);

        // 0b. authenticate with empty password
        var authRes = await fetch(serverUrl + "/emby/Users/AuthenticateByName", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Emby-Authorization": authHeader
            },
            body: JSON.stringify({
                Username: guest.Name,
                Pw: ""
            })
        });

        console.log("[AUTH] authenticate status=" + authRes.status);

        if (!authRes.ok) {
            var authErrBody = await authRes.text();
            console.error("[AUTH] login failed. body: " + authErrBody.slice(0, 300));
            return null;
        }

        var authText = await authRes.text();
        var authData = safeJson(authText, "AUTH");
        if (!authData || !authData.AccessToken || !authData.User) {
            console.error("[AUTH] response missing AccessToken/User");
            return null;
        }

        console.log("[AUTH] success. token acquired for userId=" + authData.User.Id);

        return {
            token: authData.AccessToken,
            userId: authData.User.Id
        };
    }

    try {
        console.log("[STEP 1] type=" + type + " tmdbId=" + tmdbId +
            " season=" + season + " episode=" + episode);

        var auth = await authenticate();
        if (!auth) {
            console.error("[FATAL] authentication failed — server may have changed its guest policy");
            return [];
        }

        var apiKey = auth.token;
        var userId = auth.userId;

        var searchUrl = serverUrl + "/emby/Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode&AnyProviderIdEquals=tmdb." + tmdbId + "&api_key=" + apiKey;

        var searchResp = await fetch(searchUrl, {
            headers: { "User-Agent": "Mozilla/5.0", "X-Emby-Token": apiKey }
        });

        console.log("[STEP 1] search status=" + searchResp.status + " ok=" + searchResp.ok);

        if (!searchResp.ok) {
            var errBody = await searchResp.text();
            console.error("[STEP 1] search failed. body: " + errBody.slice(0, 300));
            return [];
        }

        var searchText = await searchResp.text();
        var data = safeJson(searchText, "STEP 1");
        if (!data) return [];

        console.log("[STEP 1] items found=" + (data.Items ? data.Items.length : 0));

        if (!data.Items || data.Items.length === 0) {
            console.error("[STEP 1] no items matched tmdb." + tmdbId);
            return [];
        }

        if (type === "tv" && season !== null && season !== undefined && episode !== null && episode !== undefined) {
            var seriesId = data.Items[0].Id;
            console.log("[STEP 2] seriesId=" + seriesId + " season=" + season);

            var epsUrl = serverUrl + "/emby/Shows/" + seriesId + "/Episodes?Season=" + season + "&api_key=" + apiKey;
            var epsResp = await fetch(epsUrl, {
                headers: { "User-Agent": "Mozilla/5.0", "X-Emby-Token": apiKey }
            });

            console.log("[STEP 2] episodes status=" + epsResp.status);

            if (!epsResp.ok) {
                var epsErrBody = await epsResp.text();
                console.error("[STEP 2] episodes fetch failed. body: " + epsErrBody.slice(0, 300));
                return [];
            }

            var epsText = await epsResp.text();
            var epsData = safeJson(epsText, "STEP 2");
            if (!epsData) return [];

            console.log("[STEP 2] episode count=" + (epsData.Items ? epsData.Items.length : 0));

            if (!epsData.Items || epsData.Items.length === 0) {
                console.error("[STEP 2] season " + season + " has no episodes on server");
                return [];
            }

            var targetEpisodeId = null;
            var targetWidth = 1920;
            var numSeason = Number(season);
            var numEpisode = Number(episode);

            for (var i = 0; i < epsData.Items.length; i++) {
                var item = epsData.Items[i];
                if (item.IndexNumber === numEpisode && item.ParentIndexNumber === numSeason) {
                    targetEpisodeId = item.Id;
                    targetWidth = item.Width || 1920;
                    break;
                }
            }

            if (!targetEpisodeId) {
                console.error("[STEP 2] S" + numSeason + "E" + numEpisode + " not found in season list");
                return [];
            }

            console.log("[STEP 3] targetEpisodeId=" + targetEpisodeId);
            return await getPlaybackStreams(targetEpisodeId, targetWidth, serverUrl, apiKey, userId, deviceId, clientVersion);
        }

        if (type === "movie") {
            var promises = [];
            for (var k = 0; k < data.Items.length; k++) {
                if (data.Items[k].Type === "Movie") {
                    console.log("[STEP 2] movie candidate id=" + data.Items[k].Id);
                    promises.push(getPlaybackStreams(data.Items[k].Id, data.Items[k].Width, serverUrl, apiKey, userId, deviceId, clientVersion));
                }
            }

            if (promises.length === 0) {
                console.error("[STEP 2] no Movie-type items in result set");
                return [];
            }

            var results = await Promise.all(promises);
            var allStreams = [];
            for (var r = 0; r < results.length; r++) {
                allStreams = allStreams.concat(results[r]);
            }
            console.log("[DONE] total streams=" + allStreams.length);
            return allStreams;
        }

        console.error("[STEP 1] unhandled type/season/episode combo");
        return [];
    } catch (error) {
        console.error("[FATAL] Resolver Error: " + error.toString());
        return [];
    }
};

async function getPlaybackStreams(itemId, width, serverUrl, apiKey, userId, deviceId, clientVersion) {
    try {
        var playbackUrl = serverUrl + "/emby/Items/" + itemId + "/PlaybackInfo" +
            "?UserId=" + userId +
            "&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false" +
            "&MaxStreamingBitrate=6475000" +
            "&X-Emby-Client=Emby+Web&X-Emby-Device-Name=Google+Chrome+Android" +
            "&X-Emby-Device-Id=" + deviceId +
            "&X-Emby-Client-Version=" + clientVersion +
            "&X-Emby-Token=" + apiKey +
            "&reqformat=json";

        var payload = {
            DeviceProfile: {
                MaxStaticBitrate: 200000000,
                MaxStreamingBitrate: 200000000,
                MusicStreamingTranscodingBitrate: 192000,
                DirectPlayProfiles: [
                    { Container: "mp4,m4v", Type: "Video", VideoCodec: "h264,hevc,av1,vp8,vp9", AudioCodec: "mp3,aac,opus,flac,vorbis" },
                    { Container: "mkv", Type: "Video", VideoCodec: "h264,hevc,av1,vp8,vp9", AudioCodec: "mp3,aac,opus,flac,vorbis" }
                ],
                TranscodingProfiles: [
                    { Container: "ts", Type: "Video", AudioCodec: "mp3,aac", VideoCodec: "hevc,h264,av1", Context: "Streaming", Protocol: "hls", MaxAudioChannels: "2" }
                ]
            }
        };

        console.log("[PLAYBACK] itemId=" + itemId + " requesting PlaybackInfo");

        var res = await fetch(playbackUrl, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "text/plain",
                "X-Emby-Token": apiKey
            },
            body: JSON.stringify(payload)
        });

        console.log("[PLAYBACK] status=" + res.status + " ok=" + res.ok);

        if (!res.ok) {
            var pbErrBody = await res.text();
            console.error("[PLAYBACK] failed itemId=" + itemId + " body: " + pbErrBody.slice(0, 300));
            return [];
        }

        var playText = await res.text();
        var playData;
        try {
            playData = JSON.parse(playText);
        } catch (e) {
            console.error("[PLAYBACK] non-JSON response. First 200: " + playText.slice(0, 200));
            return [];
        }

        if (!playData.MediaSources || playData.MediaSources.length === 0) {
            console.error("[PLAYBACK] itemId=" + itemId + " no MediaSources in response");
            return [];
        }

        var mediaSource = playData.MediaSources[0];
        var streamUrl = "";
        var streamType = "hls";

        if (mediaSource.DirectStreamUrl) {
            streamUrl = serverUrl + mediaSource.DirectStreamUrl;
            streamType = "mp4";
        } else if (mediaSource.TranscodingUrl) {
            streamUrl = serverUrl + mediaSource.TranscodingUrl;
            streamType = "hls";
} else {
    streamUrl = serverUrl + "/emby/videos/" + itemId + "/master.m3u8?DeviceId=" + deviceId +
        "&MediaSourceId=" + mediaSource.Id + "&PlaySessionId=" + playData.PlaySessionId + "&api_key=" + apiKey;
    streamType = "hls";
    console.log("[PLAYBACK] itemId=" + itemId + " mediaSourceId=" + mediaSource.Id);
}
        var qualityLabel = "HD";
        if (width) {
            if (width >= 3800) qualityLabel = "4K";
            else if (width >= 1900) qualityLabel = "1080p";
            else if (width >= 1200) qualityLabel = "720p";
            else qualityLabel = "SD";
        }

        var userAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

        return [
            {
                url: streamUrl,
                quality: qualityLabel + " (" + streamType.toUpperCase() + ")",
                provider: "RoarZone [Emby]",
                headers: {
                    "User-Agent": userAgent,
                    "Referer": "https://play.roarzone.net/web/index.html"
                }
            }
        ];
    } catch (err) {
        console.error("[PLAYBACK] Fetch Error itemId=" + itemId + ": " + err.toString());
        return [];
    }
}
