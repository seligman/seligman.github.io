/* SITE: where the pages get their data and their addresses.

   This is the one place that knows the difference between the Flask server
   (data from the /api routes) and a static export (data from files next to
   the pages); everything else (search-core.js, viewer.js, app.js,
   detail.js, map.js) works the same in both. The page settings come from
   the <script type="application/json" id="app-config"> block the server (or
   the exporter) writes into each page.

   Data
     SITE.loadIndex(callback)      callback({version, generated, libraries:
                                   [{id, name}], albums, records: [...]})
                                   with the compact search records (keys:
                                   see search_index.py), or callback(null).
                                   albums: the owner's albums (SearchCore's
                                   albums option; albums.index_albums on
                                   the server, an export's manifest.albums
                                   with its "marks" option, else []).
                                   An export also gives names: the names of
                                   people it publishes (its "people_names"
                                   option, manifest.names), for SearchCore's
                                   interpret; null without them.
     SITE.loadRecord(id, callback) the full record of one picture (server:
                                   /api/image/<id>, with info, exif,
                                   provenance, ...; an export: what it
                                   holds beyond the compact record, if
                                   anything), or null. The pages show the
                                   compact record first and add this.
     SITE.loadLocations(callback)  [{id, lat, lon}] or null.
     SITE.loadPlaces(callback, fresh)  where the pictures were taken, for an
                                   area of the map (SearchCore's
                                   index.setPlaces): {points (loadLocations'),
                                   routes (loadRoutes')}, or null when they
                                   could not be loaded (loaded once; asked
                                   again after a failure, and with fresh).
                                   An export without locations has none:
                                   {points: [], routes: []}
     SITE.hasAreas()               an area of the map can be searched here
                                   (the server; an export that publishes
                                   locations: SITE.mapUrl is not null)
     SITE.loadRoutes(callback)     the routes of drives (the GPS tracks of
                                   videos, see tracks.py and routes.js:
                                   [{d, l, c: [{i, o, p}]}]; server:
                                   /api/routes, an export: data/routes.js
                                   with its "routes" option, else []), or
                                   null when they cannot be loaded. Loaded
                                   once per page.
     SITE.loadTrips(callback)      the trips (trips.py): {enabled,
                                   best_per_day, trips: [{id, title, start,
                                   end, days: [{date, ids, places}], other,
                                   places, ...}]} (server: /api/trips; an
                                   export: data/trips.js, SEARCH_DATA.trips,
                                   when manifest.trips names it), or null.
     SITE.loadTripStory(id, callback)  a trip's story (trip_stories.py) from
                                   the server, /api/trips/<id>/story: {trip,
                                   days: [{date, text}], ...}, or null (an
                                   export's is on its trip's days: story).
     SITE.compactRecord(detail)    a full record as a compact search record.
     SITE.loadVectors(callback)    the meaning vectors of the pictures, as
                                   SearchCore.decodeVectors makes them
                                   ({model, dims, query, ids, data}), or
                                   null when there are none (server:
                                   /api/vectors; an export: the files that
                                   manifest.vectors lists, made with its
                                   "similar" option). Loaded once per page;
                                   SITE.refreshVectors(callback) asks the
                                   server again: callback({vectors}) when
                                   they changed, callback(null) when not.
     SITE.queryVector(text, callback, progress)  the meaning vector of
                                   what was typed: callback({state: "ready",
                                   model, dims, vec (base64)}); text may be
                                   a list (a query and its words,
                                   SearchCore.meaningTexts): then also vecs,
                                   one per text (one request to the server);
                                   or callback({
                                   state: "starting" (ask again soon) | "off"
                                   | "unavailable" | "busy", error}). The
                                   server asks /api/embed. An export with the
                                   query model (manifest.meaning, see below)
                                   runs it in the page; without one it says
                                   "off".
     SITE.meaningInBrowser()       true when an export ships its query model
     SITE.loadLooks(callback)      the look vectors of the pictures ("Looks
                                   like this", see looks.py), decoded like
                                   loadVectors' ({model, dims, query, ids,
                                   data}), or null when there are none
                                   (server: /api/looks; an export: the files
                                   manifest.looks lists, made with its
                                   "looks" option). query: the admin can
                                   search by an example picture with them.
                                   SITE.refreshLooks(callback) asks the
                                   server again, as refreshVectors does;
                                   SITE.attachLooks(index, callback) sets
                                   them on a SearchCore index (setLooks).
     SITE.loadPeople(callback, hidden)  the people in the pictures (people
                                   found by their faces, see people_groups.py):
                                   {people: [{id, name, label, cover, faces,
                                   ids}]} from the server's /api/people (the
                                   admin's; others' only when the server
                                   shows them people), or null: none, or an
                                   export (exports never hold them). hidden
                                   (the admin's): hidden people too. Asked
                                   for anew every time.
     SITE.peopleForSearch(onLoaded, hidden)  the people a page's searches
                                   need for person: (also in the smart
                                   albums they name): an object whose
                                   want(text, words) loads them (loadPeople,
                                   once) when text has a person: term, or
                                   with words true any word (plain-language
                                   search may find a name in it), and calls
                                   onLoaded(people) when they have come
                                   (never before want returns);
                                   options(opts) sets SearchCore.search's
                                   people and peoplePending options;
                                   pending() is true while they are on
                                   their way. hidden (the admin's): hidden
                                   people too (person: names them, but
                                   never by a part of a name, nor with
                                   person:any). After
                                   SITE.peopleChanged() (the admin named a
                                   face in the viewer) they are asked for
                                   again the next time want needs them,
                                   and onLoaded is told again.
     SITE.faceUrl(id)              a square picture of one face (/face/<id>),
                                   null in an export
     SITE.lookQuery(blob, callback)  the look vector of an example picture
                                   (a File or Blob), made by the server's
                                   image model (admin only, POST
                                   /api/looks/query; the picture is never
                                   kept): callback({state: "ready", model,
                                   dims, vec (base64), matches, thumb (a
                                   data: URL of a small JPEG of it, or
                                   null)}) or
                                   callback({state: "starting" (ask again
                                   soon) | "off" | "unavailable" | "error",
                                   error}). An export says "off".

   Addresses (state: a search state, see below; may be left out)
     SITE.searchUrl(state, id)     the search page (with the viewer open on id)
     SITE.homeUrl()                the first page: the search page (a trip's
                                   export: the trip's page, see trip_export.py)
     SITE.detailUrl(id, state)     the page of one picture
     SITE.mapUrl(state)            the map, following that search (null: no map)
     SITE.thumbUrl(record or id)   the small square-ish thumbnail
     SITE.previewUrl(record)       the screen-sized (2048 px) picture, or null
     SITE.panoUrl(record)          the large (4096 px) panorama of a 360-degree
                                   photo for the 360 view, or the larger
                                   (1600 px tall) picture of a wide photo for
                                   the viewer's pan view; or null (neither,
                                   or an export without it)
     SITE.imageUrl(record)         the original (or what an export ships), or null
     SITE.videoUrl(record)         a video (rec.mv) to play: /video/<id> (its
                                   playable copy when there is one, else the
                                   original), or an export's videos/<id>.mp4
                                   (rec.vf); null for pictures and for videos
                                   an export holds only the poster of
     SITE.tripsUrl(), SITE.tripUrl(id)  the Trips page, the page of a trip
                                   (tripsUrl: null in an export without trips,
                                   and with trips turned off)
     SITE.drivePreviewUrl(record)  the sped-up preview of the drive a clip
                                   (rec.dv) belongs to: /drive-preview/<id>
                                   (the full record says whether there is
                                   one: detail.drive.preview); null in an
                                   export
     SITE.tileUrl(z, x, y), SITE.tilesMax(), SITE.tileSize()   map tiles
                                   (on the server with the tiles' version,
                                   "?v=...": see serve.tiles_version)
     SITE.streets()                the street maps ({url, v}: where their
                                   index and tile scripts are, see
                                   streets.js and street_maps.py; /maps/ on
                                   the server, maps/ in an export with them),
                                   or null

   SITE.shuffleSeed(renew) is the seed of the "shuffle" sort: one per
   browser tab (a new one with renew).
   SITE.attachVectors(index, callback) sets the meaning vectors on a
   SearchCore index (index.setVectors) once they are loaded, then calls
   callback(vectors or null).

   Search by meaning in an export (its "meaning" option: manifest.meaning
   {id, dims, model, parts, bytes, gzip, license, credit, assets}): nothing
   of it loads until queryVector is first called. Then assets/embed-kernel.js
   (if it fails, the engine runs in plain JavaScript) and embed-engine.js are
   added, and the engine (EMBED.load) adds the model files one at a time,
   reporting progress({loaded, total}) in bytes of the download
   (manifest.meaning.gzip). Once it has loaded, it checks itself: it embeds
   the probe texts the server embedded and compares (a cosine of at least
   MEANING_SAME); a browser that makes other vectors, or lacks what the
   engine needs, searches by words only ("off" from then on, with one
   console warning; the page says so). A query asked for while it loads
   is the one embedded when it is ready (an earlier one hears "skipped").
   With Save-Data on (navigator.connection.saveData) nothing is downloaded
   until the visitor agrees: queryVector answers {state: "ask", bytes}, and
   SITE.allowMeaningDownload() records the choice for the site (local
   storage) and asks again. The vectors of an export with the model carry
   its id (vectors.model) and query is true, like the server's when it can
   embed queries.

   SITE.title is the name of the site ("Image Search", or an export's
   title); SITE.originalLabel the words of the link to SITE.imageUrl.

   Search state in the address (SITE.searchState)
     read(search)  -> {q, lib, sort, filters: {group: [values]}, group,
                       size, hidden, junk, sensitive, ids, view, from, to,
                       by, drives, typed, area, aname}
                       from a query string (default: the page's)
     params(state) -> the query string for a state ("" when all default)
     The facet selections use the group names of SearchCore.FACETS as
     parameter names, one per value: ?q=beach&type=photo&tags=sunset.
     ids holds the pictures picked on the map ("Show these in the grid"),
     written by SITE.idList.encode, and pick what to call them instead
     ("Trip: Name", a trip page's "Open in search"; only with ids); view
     the map's centre and zoom
     ("lat,lon,zoom"), so the search page can lead back to the same place.
     The map itself never takes ids (mapUrl leaves them out). from and to
     are the timeline's choice of dates (SearchCore's range option:
     "YYYY", "YYYY-MM" or "YYYY-MM-DD"). by is how words are looked for:
     "words", "meaning", or "" (words and meaning, SearchCore's meaning
     option). drives is false when the clips of drives are shown one by
     one ("Fold drives" off: drives=0). typed lists the parts of q that
     plain-language search leaves as typed words (SearchCore.interpret's
     typed option: "*" for all of them, else keys joined by commas).
     area is an area drawn or picked on the map (SearchCore's area
     option: its text, see search-core.js "Areas on the map"; only its
     form is checked here), aname its name ("Main Street": only with
     area). Both are location data: the server's request log never shows
     them (serve.py quiet_request_line).

   SITE.idList.encode(ids, records) -> the ids value for a list of picture
     ids; SITE.idList.decode(text, records) -> {ids: [...], stale} (stale:
     the value was made for other records, see there), or null when it is
     not a valid value. records are the records of loadIndex.
     SITE.idList.maxLength() is the longest value an address may carry here.

   A static export (export.py) writes data/manifest.js
   (window.SEARCH_DATA_MANIFEST = {shards: [...], details: [...],
   libraries, locations, ...}), index shards (SEARCH_DATA.push([...records]))
   and detail shards (SEARCH_DATA.detail({id: details})), with the map
   data/locations.js (SEARCH_DATA.locations([{id, lat, lon}])), with its
   "routes" option data/routes.js (SEARCH_DATA.routes([...])), and with the
   "similar" option vector files (SEARCH_VECTORS.push({dims, ids, data}),
   listed in manifest.vectors, loaded only when a page wants them) and with
   the "looks" option look vector files (SEARCH_LOOKS.push({dims, ids,
   data, model}), manifest.looks, loaded the same way). They are
   loaded with <script> tags (never fetch), so the pages also work when
   opened from disk. The details of a picture are in the detail shard
   detailShard() names, which is loaded when they are first wanted. An
   exported picture is images/<id>.jpg, or images/<id>.<rec.ix>; one with
   rec.pn has a large panorama (a 360-degree photo's, or a wide photo's for
   the pan view) in panos/<id>.jpg, one with rec.vf a video in
   videos/<id>.mp4. The data files are asked
   for with the hash of their contents (manifest.versions, and the page's
   dataVersion for manifest.js), so a browser never mixes files of two
   exports from its cache. When a data file cannot be loaded, the next
   loadIndex() tries again. Packages made by older versions
   (manifest.json and data-NNNN.json) still load over http; their records
   are turned into compact ones here.

   Also loads under Node for the tests (no document there).
*/
var SITE = (function () {
    "use strict";

    var hasDocument = typeof document !== "undefined" && document !== null;
    var root = typeof window !== "undefined" ? window : {};

    function readConfig() {
        var node = hasDocument ? document.getElementById("app-config") : null;
        if (node) {
            try {
                return JSON.parse(node.textContent) || {};
            } catch (error) {
                return {};
            }
        }
        return root.APP_CONFIG || {};
    }

    var cfg = readConfig();
    var isStatic = cfg.mode === "static";
    var capabilities = cfg.capabilities || {admin: false, static: isStatic};

    /* ---------- Search state in the address --------------------------------- */

    // The facet groups of SearchCore.FACETS (a test keeps the two in step).
    var FACET_KEYS = ["library", "favorite", "rating", "type", "people", "setting", "time",
                      "event", "year", "month", "place", "camera", "has", "tags", "subjects",
                      "animals", "food", "vehicles", "colors"];
    var SORTS = ["relevance", "newest", "oldest", "name", "quality", "shuffle", "album"];
    var SIZES = ["s", "m", "l"];
    var SENSITIVE = ["show", "strict"];
    var BY = ["words", "meaning"];
    // At most this many values per facet group are taken from an address.
    var MAX_VALUES = 50;

    // The longest ids value read from an address (see idList), and the longest pick.
    var MAX_IDS_TEXT = 200000;
    var MAX_PICK_TEXT = 160;
    var IDS_RE = /^[0-9a-z]+(?:[._-][0-9a-z]+)*$/;
    // A date of the timeline's range: "YYYY", "YYYY-MM" or "YYYY-MM-DD".
    var DATE_KEY_RE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;
    // "lat,lon,zoom" of the map (see readView).
    var VIEW_RE = /^(-?\d{1,3}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?),(\d{1,2})$/;
    // The most texts embedded at once (SearchCore.MEANING_TEXTS; the
    // server's /api/embed takes as many: embeddings.QUERY_TEXTS).
    var MEANING_TEXTS = 9;
    // The parts of a query left as typed (SearchCore.interpret): "*", or
    // keys (lower-case words) joined by commas.
    var TYPED_RE = /^(?:\*|[0-9a-z\u00c0-\uffff ]{1,80}(?:,[0-9a-z\u00c0-\uffff ]{1,80}){0,19})$/;
    // An area of the map (SearchCore.areas reads it all), and its name.
    var AREA_RE = /^[bpl](?:[1-9]\d{0,3})?(?:\.[0-9A-Za-z_-]+)+$/;
    var MAX_AREA_TEXT = 6000;
    var MAX_AREA_NAME = 100;

    function emptyState() {
        return {q: "", lib: "", sort: "", filters: {}, group: true, size: "",
                hidden: false, junk: false, sensitive: "", ids: "", view: "", from: "", to: "",
                by: "", drives: true, pick: "", typed: "", area: "", aname: ""};
    }

    // An area's text when it has the form of one ("" if not), and its name.
    function readArea(value) {
        value = typeof value === "string" ? value : "";
        return value.length <= MAX_AREA_TEXT && AREA_RE.test(value) ? value : "";
    }

    function readAreaName(value) {
        return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ")
            .replace(/^\s+|\s+$/g, "").slice(0, MAX_AREA_NAME) : "";
    }

    // A map view from an address: "lat,lon,zoom" with the latitude within
    // the poles, the longitude within one turn and a whole zoom; "" if not.
    function readView(value) {
        var match = VIEW_RE.exec(String(value || ""));
        if (!match) {
            return "";
        }
        var lat = Number(match[1]);
        var lon = Number(match[2]);
        if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
            return "";
        }
        return match[1] + "," + match[2] + "," + Number(match[3]);
    }

    function readSearchState(search) {
        var params = new URLSearchParams(search === undefined
            ? (root.location ? root.location.search : "") : search);
        var state = emptyState();
        state.q = (params.get("q") || "").slice(0, 2000);
        state.lib = params.get("lib") || "";
        var sort = params.get("sort");
        state.sort = SORTS.indexOf(sort) >= 0 ? sort : "";
        FACET_KEYS.forEach(function (key) {
            var values = [];
            params.getAll(key).forEach(function (value) {
                value = String(value).slice(0, 200);
                if (value && values.indexOf(value) < 0 && values.length < MAX_VALUES) {
                    values.push(value);
                }
            });
            if (values.length) {
                state.filters[key] = values;
            }
        });
        state.group = params.get("group") !== "0";
        state.drives = params.get("drives") !== "0";
        var size = params.get("size");
        state.size = SIZES.indexOf(size) >= 0 ? size : "";
        state.hidden = params.get("hidden") === "1";
        state.junk = params.get("junk") === "1";
        var sensitive = params.get("sensitive");
        state.sensitive = SENSITIVE.indexOf(sensitive) >= 0 ? sensitive : "";
        var ids = params.get("ids") || "";
        state.ids = ids.length <= MAX_IDS_TEXT && IDS_RE.test(ids) ? ids : "";
        state.pick = state.ids ? (params.get("pick") || "").replace(/[\x00-\x1f\x7f]+/g, " ")
            .slice(0, MAX_PICK_TEXT) : "";
        state.view = readView(params.get("view"));
        ["from", "to"].forEach(function (key) {
            var value = params.get(key) || "";
            state[key] = DATE_KEY_RE.test(value) ? value : "";
        });
        var by = params.get("by");
        state.by = BY.indexOf(by) >= 0 ? by : "";
        var typed = params.get("typed") || "";
        state.typed = state.q && TYPED_RE.test(typed) ? typed : "";
        state.area = readArea(params.get("area"));
        state.aname = state.area ? readAreaName(params.get("aname")) : "";
        return state;
    }

    function searchParams(state) {
        state = state || {};
        var params = new URLSearchParams();
        if (state.q) {
            params.set("q", state.q);
        }
        if (state.lib) {
            params.set("lib", state.lib);
        }
        var filters = state.filters || {};
        FACET_KEYS.forEach(function (key) {
            (Array.isArray(filters[key]) ? filters[key] : []).forEach(function (value) {
                if (value !== "" && value !== null && value !== undefined) {
                    params.append(key, String(value));
                }
            });
        });
        if (state.sort && SORTS.indexOf(state.sort) >= 0) {
            params.set("sort", state.sort);
        }
        if (state.group === false) {
            params.set("group", "0");
        }
        if (state.drives === false) {
            params.set("drives", "0");
        }
        if (state.size && SIZES.indexOf(state.size) >= 0) {
            params.set("size", state.size);
        }
        if (state.junk) {
            params.set("junk", "1");
        }
        if (state.sensitive && SENSITIVE.indexOf(state.sensitive) >= 0) {
            params.set("sensitive", state.sensitive);
        }
        if (state.hidden) {
            params.set("hidden", "1");
        }
        if (typeof state.ids === "string" && state.ids && IDS_RE.test(state.ids)) {
            params.set("ids", state.ids);
            if (typeof state.pick === "string" && state.pick) {
                params.set("pick", state.pick.slice(0, MAX_PICK_TEXT));
            }
        }
        var view = readView(state.view);
        if (view) {
            params.set("view", view);
        }
        ["from", "to"].forEach(function (key) {
            if (typeof state[key] === "string" && DATE_KEY_RE.test(state[key])) {
                params.set(key, state[key]);
            }
        });
        if (state.by && BY.indexOf(state.by) >= 0) {
            params.set("by", state.by);
        }
        if (state.q && typeof state.typed === "string" && TYPED_RE.test(state.typed)) {
            params.set("typed", state.typed);
        }
        var area = readArea(state.area);
        if (area) {
            params.set("area", area);
            var name = readAreaName(state.aname);
            if (name) {
                params.set("aname", name);
            }
        }
        return params.toString();
    }

    /* ---------- The shuffled order ------------------------------------------- */

    // The seed of the "shuffle" sort (SearchCore): one per browser tab
    // (sessionStorage), so the order holds while the grid grows, on the map
    // and after a reload. renew: a new one (choosing "Shuffle" again).
    var SHUFFLE_KEY = "searchImages.shuffleSeed";
    var shuffleValue = null;

    function shuffleSeed(renew) {
        if (shuffleValue !== null && !renew) {
            return shuffleValue;
        }
        var stored = null;
        try {
            stored = root.sessionStorage ? root.sessionStorage.getItem(SHUFFLE_KEY) : null;
        } catch (error) {
            stored = null;
        }
        shuffleValue = !renew && /^\d{1,10}$/.test(stored || "") ? Number(stored) >>> 0
            : Math.floor(Math.random() * 4294967296) >>> 0;
        try {
            if (root.sessionStorage) {
                root.sessionStorage.setItem(SHUFFLE_KEY, String(shuffleValue));
            }
        } catch (error) {
            // Only this page keeps it, then.
        }
        return shuffleValue;
    }

    /* ---------- Lists of pictures in an address (idList) --------------------- */

    /* Whole numbers >= 0 as short text: sorted, runs of consecutive numbers
       as one token, each token the gap since the previous run in base 36,
       with "-" and the run's length - 1 for a run: [5, 6, 7, 10] ->
       "5-2.2". Only letters, digits, "." and "-" (none of them escaped in
       an address). */
    function encodeNumbers(numbers) {
        var list = numbers.filter(function (value) {
            return typeof value === "number" && value >= 0 && value % 1 === 0 &&
                value <= 9007199254740991;
        }).sort(function (a, b) {
            return a - b;
        });
        var tokens = [];
        var previous = -1;
        var k = 0;
        while (k < list.length) {
            var start = list[k];
            var end = start;
            k += 1;
            while (k < list.length && list[k] <= end + 1) {
                end = Math.max(end, list[k]);
                k += 1;
            }
            var token = (start - previous - 1).toString(36);
            if (end > start) {
                token += "-" + (end - start).toString(36);
            }
            tokens.push(token);
            previous = end;
        }
        return tokens.join(".");
    }

    // At most this many pictures in one list.
    var MAX_PICKED = 100000;

    // The numbers of encodeNumbers' text, or null when it is not such text
    // (or names a number >= limit, or more than MAX_PICKED numbers).
    function decodeNumbers(text, limit) {
        if (typeof text !== "string" || !/^[0-9a-z]+(?:-[0-9a-z]+)?(?:\.[0-9a-z]+(?:-[0-9a-z]+)?)*$/
                .test(text)) {
            return null;
        }
        var out = [];
        var previous = -1;
        var tokens = text.split(".");
        for (var k = 0; k < tokens.length; k++) {
            var parts = tokens[k].split("-");
            var start = previous + 1 + parseInt(parts[0], 36);
            var end = start + (parts.length > 1 ? parseInt(parts[1], 36) : 0);
            if (!isFinite(end) || end >= limit || out.length + (end - start) >= MAX_PICKED) {
                return null;
            }
            for (var value = start; value <= end; value++) {
                out.push(value);
            }
            previous = end;
        }
        return out;
    }

    // A short check value of a list of strings (FNV-1a, in base 36).
    function checkValue(list) {
        var hash = 2166136261;
        for (var k = 0; k < list.length; k++) {
            var text = list[k] + "\n";
            for (var c = 0; c < text.length; c++) {
                hash ^= text.charCodeAt(c);
                hash = Math.imul(hash, 16777619) >>> 0;
            }
        }
        return (hash >>> 0).toString(36);
    }

    var orderCache = {records: null, length: -1, order: null};

    /* An export's pictures in a fixed order (their ids sorted), with a check
       value of that order: a picture is named by its place in it, so a
       list of hundreds of export ids still fits in an address. */
    function recordOrder(records) {
        if (orderCache.records === records && orderCache.length === records.length) {
            return orderCache.order;
        }
        var ids = records.map(function (rec) {
            return String(recordId(rec));
        }).sort();
        var place = {};
        ids.forEach(function (id, index) {
            place[id] = index;
        });
        var order = {ids: ids, place: place, check: checkValue(ids)};
        orderCache = {records: records, length: records.length, order: order};
        return order;
    }

    // ids -> the ids value of an address ("" for none). The server's ids
    // are numbers; an export names its pictures by their place in
    // recordOrder ("<check>_<places>").
    function encodeIdList(ids, records) {
        ids = Array.isArray(ids) ? ids : [];
        if (!ids.length) {
            return "";
        }
        if (!isStatic) {
            return encodeNumbers(ids.map(function (id) {
                return typeof id === "number" ? id : /^\d{1,15}$/.test(String(id)) ? Number(id) : -1;
            }));
        }
        var order = recordOrder(records || []);
        var places = [];
        ids.forEach(function (id) {
            var place = order.place[String(id)];
            if (place !== undefined) {
                places.push(place);
            }
        });
        return places.length ? order.check + "_" + encodeNumbers(places) : "";
    }

    function decodeIdList(text, records) {
        if (typeof text !== "string" || !text) {
            return null;
        }
        if (!isStatic) {
            var numbers = decodeNumbers(text, 9007199254740991);
            return numbers ? {ids: numbers, stale: false} : null;
        }
        var at = text.indexOf("_");
        if (at <= 0) {
            return null;
        }
        var order = recordOrder(records || []);
        var places = decodeNumbers(text.slice(at + 1), Math.max(order.ids.length, 1));
        if (!places) {
            return text.slice(0, at) === order.check ? null : {ids: [], stale: true};
        }
        if (text.slice(0, at) !== order.check) {
            return {ids: [], stale: true};
        }
        return {ids: places.map(function (place) {
            var id = order.ids[place];
            return /^\d+$/.test(id) ? Number(id) : id;
        }), stale: false};
    }

    // The longest ids value to put in an address: web servers refuse
    // addresses longer than about 8,000 characters (a static host), the
    // program's own server takes about 64,000; from disk there is no limit.
    function maxIdsLength() {
        if (!isStatic) {
            return 30000;
        }
        var protocol = root.location && root.location.protocol;
        return protocol === "file:" ? 100000 : 6000;
    }

    function withQuery(base, query) {
        if (!query) {
            return base;
        }
        return base + (base.indexOf("?") >= 0 ? "&" : "?") + query;
    }

    /* ---------- Addresses ------------------------------------------------- */

    function recordId(rec) {
        if (rec !== null && typeof rec === "object") {
            return rec.i !== undefined ? rec.i : rec.id;
        }
        return rec;
    }

    function searchUrl(state, id) {
        // (A trip's export has its search page beside the trip's: cfg.searchPage.)
        var url = withQuery(isStatic ? cfg.searchPage || "index.html" : "/",
                            searchParams(state));
        if (id !== undefined && id !== null && id !== "") {
            url += "#id=" + encodeURIComponent(id);
        }
        return url;
    }

    function hasMap() {
        if (capabilities.map === false) {
            return false;
        }
        return !isStatic || Boolean(cfg.tiles) || capabilities.map === true;
    }

    var staticPrefix = {
        thumbs: cfg.thumbs || "thumbs/",
        images: cfg.images || "images/",
        panos: cfg.panos || "panos/",
        videos: cfg.videos || "videos/"
    };

    function thumbUrl(rec) {
        // (A 360 picture's thumbnail shows its opening view, rec.ov: another
        // view is another address, so the browser does not keep the old one
        // -- an export's too, whose file keeps its name.)
        var view = rec && typeof rec === "object" && Array.isArray(rec.ov)
            ? "?v=" + encodeURIComponent(rec.ov.join("_")) : "";
        if (isStatic) {
            if (rec && rec._thumb) {
                return rec._thumb;
            }
            return staticPrefix.thumbs + encodeURIComponent(recordId(rec)) + ".jpg" + view;
        }
        return "/thumb/" + encodeURIComponent(recordId(rec)) + view;
    }

    function imageUrl(rec) {
        if (isStatic) {
            if (rec && rec._image) {
                return rec._image;
            }
            if (capabilities.images === false) {
                return null;
            }
            var extension = rec && typeof rec.ix === "string" && /^[a-z0-9]{1,5}$/.test(rec.ix)
                ? rec.ix : "jpg";
            return staticPrefix.images + encodeURIComponent(recordId(rec)) + "." + extension;
        }
        return "/image/" + encodeURIComponent(recordId(rec));
    }

    // A screen-sized (2048 px) version; null when there is none (the
    // viewer then shows the thumbnail).
    function previewUrl(rec) {
        if (isStatic) {
            return imageUrl(rec);
        }
        return "/preview/" + encodeURIComponent(recordId(rec));
    }

    // The preview's long edge (images.PREVIEW_EDGE).
    var PREVIEW_EDGE = 2048;
    // The larger picture of a wide photo, for the viewer's pan view: the
    // same numbers as images.WIDE_ASPECT, WIDE_PANO_HEIGHT,
    // WIDE_PANO_MAX_WIDTH and WIDE_PANO_GAIN.
    var WIDE_ASPECT = 2.2;
    var WIDE_PANO_HEIGHT = 1600;
    var WIDE_PANO_MAX_WIDTH = 16384;
    var WIDE_PANO_GAIN = 1.25;

    // [width, height] of the larger picture a flat picture width x height
    // gets for the pan view (images.wide_pano_size), or null.
    function widePanoSize(width, height) {
        width = Number(width) || 0;
        height = Number(height) || 0;
        if (width <= 0 || height <= 0 || width < WIDE_ASPECT * height - 1e-9) {
            return null;
        }
        var previewHeight = width > PREVIEW_EDGE
            ? Math.max(1, Math.round(height * PREVIEW_EDGE / width)) : height;
        var tall = Math.min(height, WIDE_PANO_HEIGHT);
        var across = Math.max(1, Math.round(width * tall / height));
        if (across > WIDE_PANO_MAX_WIDTH) {
            across = WIDE_PANO_MAX_WIDTH;
            tall = Math.max(1, Math.round(height * WIDE_PANO_MAX_WIDTH / width));
        }
        return tall >= previewHeight * WIDE_PANO_GAIN ? [across, tall] : null;
    }

    // Does a flat picture width x height get a larger picture for the pan
    // view (images.wide_pano_size)?
    function hasWidePano(width, height) {
        return widePanoSize(width, height) !== null;
    }

    // [width, height] of the picture previewUrl gives of a flat picture:
    // the picture itself in an export of the originals, else fitted into
    // PREVIEW_EDGE (never enlarged); [0, 0] when its size is not known.
    function previewSize(rec) {
        var width = Number(rec && rec.w) || 0;
        var height = Number(rec && rec.hgt) || 0;
        var edge = Math.max(width, height);
        if (!width || !height || edge <= PREVIEW_EDGE ||
                (isStatic && capabilities.originals === true)) {
            return [width, height];
        }
        return [Math.max(1, Math.round(width * PREVIEW_EDGE / edge)),
                Math.max(1, Math.round(height * PREVIEW_EDGE / edge))];
    }

    // The large panorama of a 360-degree photo (rec.p "360"), or the larger
    // picture of a wide photo (hasWidePano); null for other pictures, for a
    // 360-degree photo no larger than its preview (which is then the whole
    // picture), and in an export for a picture without one (rec.pn: it has
    // panos/<id>.jpg).
    function panoUrl(rec) {
        // (A video has none: it plays.)
        if (!rec || typeof rec !== "object" || rec.mv ||
                (rec.p !== "360" && !hasWidePano(rec.w, rec.hgt))) {
            return null;
        }
        if (isStatic && rec._pano) {
            return rec._pano;
        }
        var edge = Math.max(rec.w || 0, rec.hgt || 0);
        if (rec.p === "360" && edge && edge <= PREVIEW_EDGE) {
            return null;
        }
        if (isStatic) {
            if (capabilities.panos !== true || rec.pn !== 1) {
                return null;
            }
            return staticPrefix.panos + encodeURIComponent(recordId(rec)) + ".jpg";
        }
        return "/pano/" + encodeURIComponent(recordId(rec));
    }

    // A video to play (rec.mv): the server's /video/<id>, or an export's
    // videos/<id>.mp4 when it holds the video itself (rec.vf); else null.
    function videoUrl(rec) {
        if (!rec || typeof rec !== "object" || !rec.mv) {
            return null;
        }
        if (isStatic) {
            return rec.vf === 1 ? staticPrefix.videos + encodeURIComponent(recordId(rec)) +
                ".mp4" : null;
        }
        return "/video/" + encodeURIComponent(recordId(rec));
    }

    // The sped-up preview of a clip's drive (rec.dv): the server's
    // /drive-preview/<id> (whether there is one: the full record's
    // drive.preview); an export has none.
    function drivePreviewUrl(rec) {
        if (!rec || typeof rec !== "object" || !rec.mv || rec.dv === undefined ||
                rec.dv === null || isStatic) {
            return null;
        }
        return "/drive-preview/" + encodeURIComponent(recordId(rec));
    }

    /* ---------- Compact records from full ones ------------------------------- */

    // A 360 video's lens geometry (its facts' "fisheye") as a record's fx,
    // or null: only finite numbers in the expected shapes
    // (search_index.fisheye_record).
    function fisheyeRecord(geometry) {
        if (!geometry || typeof geometry !== "object") {
            return null;
        }
        function numbers(value, count) {
            if (!Array.isArray(value) || value.length !== count) {
                return null;
            }
            for (var index = 0; index < count; index++) {
                if (typeof value[index] !== "number" || !isFinite(value[index])) {
                    return null;
                }
            }
            return value.slice();
        }
        function pair(value) {
            if (!Array.isArray(value) || value.length !== 2) {
                return null;
            }
            var first = numbers(value[0], 3);
            var second = numbers(value[1], 3);
            return first && second ? [first, second] : null;
        }
        var lens = pair(geometry.lens);
        var gain = pair(geometry.gain);
        var turn = numbers(geometry.turn, 2);
        var fill = numbers(geometry.fill, 2);
        var fov = numbers([geometry.fov], 1);
        var blend = numbers([geometry.blend], 1);
        if (!lens || !gain || !turn || !fill || !fov || !blend ||
                (geometry.front !== 0 && geometry.front !== 1) || !(fov[0] > 90 && fov[0] < 360)) {
            return null;
        }
        return {lens: lens, fov: fov[0], turn: turn, front: geometry.front,
                mirror: geometry.mirror === true, blend: blend[0], gain: gain, fill: fill};
    }

    function text(value) {
        return typeof value === "string" ? value.replace(/^\s+|\s+$/g, "") : "";
    }

    function phrases(value, lower) {
        var out = [];
        (Array.isArray(value) ? value : []).forEach(function (item) {
            var entry = text(item);
            if (lower) {
                entry = entry.toLowerCase();
            }
            if (entry && out.indexOf(entry) < 0) {
                out.push(entry);
            }
        });
        return out;
    }

    function score(value) {
        if (typeof value !== "number" || !isFinite(value)) {
            return null;
        }
        value = Math.round(value);
        return value >= 1 && value <= 5 ? value : null;
    }

    var TEXT_FIELDS = [["t", "title"], ["d", "description"], ["o", "text"], ["sc", "scene"]];
    var LIST_FIELDS = [["s", "subjects"], ["a", "animals"], ["fo", "food"], ["v", "vehicles"],
                       ["pd", "people_descriptors"], ["qf", "quality_flags"]];
    var LOWER_FIELDS = [["g", "tags"], ["c", "colors"]];
    var ENUM_FIELDS = [["st", "setting", "unknown"], ["td", "time_of_day", "unknown"],
                       ["ev", "event", "none"], ["ty", "photo_type", ""],
                       ["dt", "document_type", "none"], ["se", "sensitive", "none"],
                       ["pp", "people", ""]];

    /* The compact search record (search_index.record_for_row) of a full
       record: /api/image/<id>, or a record of an older package. */
    function compactRecord(detail) {
        if (!detail || typeof detail !== "object") {
            return null;
        }
        var rec = {i: detail.id, l: detail.library_id || detail.library || ""};
        if (detail.name) {
            rec.n = detail.name;
        }
        var folder = typeof detail.path === "string" ? detail.path.replace(/\/?[^/]*$/, "") : "";
        if (folder) {
            rec.f = folder;
        }
        var info = detail.info && typeof detail.info === "object" ? detail.info : null;
        if (info) {
            TEXT_FIELDS.forEach(function (pair) {
                var value = text(info[pair[1]]);
                if (value) {
                    rec[pair[0]] = value;
                }
            });
            LIST_FIELDS.forEach(function (pair) {
                var value = phrases(info[pair[1]]);
                if (value.length) {
                    rec[pair[0]] = value;
                }
            });
            LOWER_FIELDS.forEach(function (pair) {
                var value = phrases(info[pair[1]], true);
                if (value.length) {
                    rec[pair[0]] = value;
                }
            });
            ENUM_FIELDS.forEach(function (entry) {
                var value = text(info[entry[1]]);
                if (value && value !== entry[2]) {
                    rec[entry[0]] = value;
                }
            });
            var words = [];
            (Array.isArray(info.objects) ? info.objects : []).forEach(function (item) {
                if (item && text(item.name)) {
                    words.push(text(item.name));
                }
            });
            words = words.concat(phrases(info.landmarks), phrases(info.activities));
            if (text(info.mood) && info.mood !== "neutral") {
                words.push(text(info.mood));
            }
            if (text(info.location_guess)) {
                words.push(text(info.location_guess));
            }
            if (words.length) {
                rec.ex = words.join(", ");
            }
            var version = typeof detail.prompt_ver === "number" ? detail.prompt_ver
                : detail.provenance && detail.provenance.prompt_ver;
            // (Only an edit of the owner's, on a picture not described yet.)
            var described = detail.described !== false;
            var older = !described ? false : typeof version === "number" ? version <= 4
                : info.photo_type === undefined && info.title === undefined;
            // Version 4 rated sharpness from 0 to 1: no 1-5 scores then.
            var aesthetic = older ? null : score(info.aesthetic);
            var sharpness = older ? null : score(info.sharpness);
            if (aesthetic !== null) {
                rec.q = aesthetic;
            }
            if (sharpness !== null) {
                rec.sh = sharpness;
            }
            if (info.private_info === true) {
                rec.pr = 1;
            }
            if (described) {
                rec.ds = 1;
            }
            if (older) {
                rec.v4 = 1;
            }
        }
        var taken = typeof detail.taken_at === "string" ? detail.taken_at : "";
        if (/^\d{4}-\d{2}-\d{2}/.test(taken)) {
            rec.dk = taken.slice(0, 10);
            rec.ts = taken;
            // (A date from the file's time is no date taken: see du.)
            if (detail.taken_source === "mtime") {
                rec.du = 1;
            }
        }
        if (detail.camera) {
            rec.cm = detail.camera;
        }
        if (typeof detail.lat === "number" && typeof detail.lon === "number") {
            rec.gp = 1;
        }
        var place = detail.place && typeof detail.place === "object" ? detail.place : null;
        if (place && text(place.country)) {
            [["ci", "city"], ["rg", "region"], ["co", "country"], ["cc", "cc"]].forEach(
                function (pair) {
                    if (text(place[pair[1]])) {
                        rec[pair[0]] = text(place[pair[1]]);
                    }
                });
            if (rec.ci && typeof place.km === "number" && place.km >= 0) {
                rec.km = Math.round(place.km);
            }
            if (place.estimated === true) {
                rec.pe = 1;     // (place_estimates.py: no position of its own)
            }
            var sources = {copy: "c", time: "t", area: "a", owner: "o", file: "f"};
            if (sources[place.source]) {
                rec.ps = sources[place.source];
            }
        }
        if (detail.width) {
            rec.w = detail.width;
        }
        if (detail.height) {
            rec.hgt = detail.height;
        }
        if (detail.projection === "equirectangular" || detail.projection === "dual_fisheye") {
            rec.p = "360";
            // (Where it opens, when not at the front: opening_views.record_value.)
            var view = detail.opening_view && typeof detail.opening_view === "object"
                ? detail.opening_view : null;
            if (view && typeof view.yaw === "number" && typeof view.pitch === "number" &&
                    isFinite(view.yaw) && isFinite(view.pitch)) {
                var ov = [Math.round(view.yaw * 10) / 10, Math.round(view.pitch * 10) / 10];
                if (typeof view.fov === "number" && isFinite(view.fov)) {
                    ov.push(Math.round(view.fov * 10) / 10);
                }
                if (Math.abs(ov[0]) >= 0.5 || Math.abs(ov[1]) >= 0.5 || ov.length > 2) {
                    rec.ov = ov;
                }
            }
        }
        if (detail.media === "video") {
            // (search_index.add_video)
            rec.mv = 1;
            rec.ty = "video";
            if (typeof detail.duration === "number" && detail.duration > 0) {
                // (Rounded down, at least 0.1, as search_index does.)
                rec.dr = Math.max(0.1, Math.floor(detail.duration * 10) / 10);
            }
            var facts = detail.video && typeof detail.video === "object" ? detail.video : {};
            var codec = text(facts.codec);
            if (detail.projection === "dual_fisheye") {
                // (A 360 video plays its LRV, or its original when that
                // holds both lenses in one stream; lens streams only as a
                // playable copy.)
                var lrv = facts.lrv && typeof facts.lrv === "object" ? facts.lrv : {};
                codec = text(lrv.codec) || (facts.lenses === "frame" ? codec : "");
            }
            if (codec) {
                rec.vc = codec;
            }
            var geometry = detail.projection === "dual_fisheye" && detail.video
                ? fisheyeRecord(detail.video.fisheye) : null;
            if (geometry) {
                rec.fx = geometry;
                if (Array.isArray(detail.level) && detail.level.length) {
                    // (Its frames are turned level: the record holds the track.)
                    rec.lv = 1;
                }
            }
        }
        if (detail.hidden) {
            rec.h = 1;
        }
        if (detail.edited) {
            rec.ed = 1;
        }
        if (detail.location_check && detail.location_check.ignored) {
            rec.gx = 1;
        }
        var marks = detail.marks && typeof detail.marks === "object" ? detail.marks : null;
        if (marks) {
            // (search_index.add_marks)
            if (marks.favorite) {
                rec.fav = 1;
            }
            if (typeof marks.rating === "number" && marks.rating >= 1 && marks.rating <= 5) {
                rec.rt = marks.rating;
            }
            var albumIds = (Array.isArray(marks.albums) ? marks.albums : []).map(function (album) {
                return album && album.id;
            }).filter(function (id) {
                return typeof id === "number";
            });
            if (albumIds.length) {
                rec.al = albumIds.sort(function (a, b) {
                    return a - b;
                });
            }
        }
        return rec;
    }

    /* ---------- Loading ----------------------------------------------------- */

    function getJson(url) {
        return fetch(url, {credentials: "same-origin"}).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.json();
        });
    }

    // src as a script element of the page: run in the order added (the
    // meaning engine's parts need that), unless free -- then it runs once it
    // has loaded, and holds back none of the others (SITE.loadWords).
    function loadScript(src, free) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = src;
            script.async = Boolean(free);
            script.onload = function () {
                resolve();
            };
            script.onerror = function () {
                // (A later try adds a new one.)
                if (script.parentNode) {
                    script.parentNode.removeChild(script);
                }
                reject(new Error("Could not load " + src));
            };
            document.head.appendChild(script);
        });
    }

    var staticData = null;        // promise of the static index
    var staticManifest = null;    // the export's manifest, once loaded
    var staticDetails = {};       // id -> full record (older packages, detail shards)
    var staticScripts = {};       // data script name -> promise of it being loaded
    var staticLocations = null;   // [{id, lat, lon}] once data/locations.js has run
    var staticRoutes = null;      // the routes once data/routes.js has run
    var staticTrips = null;       // the trips once data/trips.js has run

    // The address of a data script: with the hash of its contents when
    // the manifest has one (export.py, "versions").
    function versioned(path, version) {
        return typeof version === "string" && /^[0-9a-f]{1,40}$/.test(version)
            ? path + "?v=" + version : path;
    }

    function dataUrl(name) {
        var versions = staticManifest && staticManifest.versions;
        return versioned((cfg.data || "data/") + name,
                         versions && typeof versions === "object" ? versions[name] : null);
    }

    // The letters of the export's picture ids (export.XID_ALPHABET).
    var XID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

    /* The detail shard of an exported picture: the export spreads the
       details over manifest.details by the first four characters of the
       id (export.bucket_of does the same sum). */
    function detailShard(manifest, id) {
        var list = manifest && Array.isArray(manifest.details) ? manifest.details : [];
        if (!list.length) {
            return null;
        }
        var text = String(id);
        var value = 0;
        for (var k = 0; k < 4 && k < text.length; k++) {
            value = value * 32 + Math.max(XID_ALPHABET.indexOf(text.charAt(k)), 0);
        }
        return list[value % list.length];
    }

    // A data script of the export, loaded once (again after a failure).
    function loadDataScript(name) {
        if (!staticScripts[name]) {
            staticScripts[name] = loadScript(dataUrl(name)).catch(function (error) {
                delete staticScripts[name];
                throw error;
            });
        }
        return staticScripts[name];
    }

    // Shards of a static export: data/manifest.js, then the scripts it lists.
    function loadScriptExport() {
        var dataPrefix = cfg.data || "data/";
        var records = [];
        root.SEARCH_DATA = {
            push: function (list) {
                if (Array.isArray(list)) {
                    for (var k = 0; k < list.length; k++) {
                        records.push(list[k]);
                    }
                }
            },
            detail: function (map) {
                Object.keys(map || {}).forEach(function (id) {
                    staticDetails[id] = map[id];
                });
            },
            locations: function (list) {
                staticLocations = Array.isArray(list) ? list : [];
            },
            routes: function (list) {
                staticRoutes = Array.isArray(list) ? list : [];
            },
            trips: function (value) {
                staticTrips = value && typeof value === "object" ? value : null;
            }
        };
        var ready = root.SEARCH_DATA_MANIFEST ? Promise.resolve()
            : loadScript(versioned(dataPrefix + "manifest.js", cfg.dataVersion));
        return ready.then(function () {
            var manifest = root.SEARCH_DATA_MANIFEST;
            if (!manifest || !Array.isArray(manifest.shards)) {
                throw new Error("No manifest.js");
            }
            staticManifest = manifest;
            return Promise.all(manifest.shards.map(function (name) {
                return loadScript(dataUrl(name)).catch(function (error) {
                    error.shard = true;     // the export is there, one file is not
                    throw error;
                });
            })).then(function () {
                return {
                    version: manifest.version || 1,
                    generated: manifest.generated || null,
                    libraries: manifest.libraries || (manifest.library ? [manifest.library] : []),
                    albums: Array.isArray(manifest.albums) ? manifest.albums : [],
                    names: Array.isArray(manifest.names) ? manifest.names.filter(function (name) {
                        return typeof name === "string" && name !== "";
                    }) : null,
                    records: records,
                    manifest: manifest
                };
            });
        });
    }

    // Packages made before compact records: manifest.json + data-NNNN.json.
    function loadOlderPackage() {
        var dataPrefix = cfg.data || "data/";
        return getJson(dataPrefix + "manifest.json").then(function (manifest) {
            return Promise.all((manifest.shards || []).map(function (name) {
                return getJson(dataPrefix + name);
            })).then(function (parts) {
                var records = [];
                parts.forEach(function (part) {
                    (part || []).forEach(function (old) {
                        var rec = compactRecord(old);
                        if (rec) {
                            rec._thumb = old.thumb || "";
                            rec._image = old.image || "";
                            staticDetails[String(rec.i)] = old;
                            records.push(rec);
                        }
                    });
                });
                var libraries = (manifest.libraries || []).map(function (name) {
                    return {id: name, name: name};
                });
                return {version: 0, generated: manifest.generated || null,
                        libraries: libraries, albums: [], records: records};
            });
        });
    }

    // The static index, loaded once; after a failure the next call tries
    // again. A package of an older version is only looked for when there
    // is no manifest.js (not when one data file of an export is missing).
    function loadStaticIndex() {
        if (!staticData) {
            staticData = loadScriptExport().catch(function (error) {
                if (error && error.shard) {
                    throw error;
                }
                return loadOlderPackage().catch(function () {
                    throw error;
                });
            }).catch(function (error) {
                staticData = null;
                throw error;
            });
        }
        return staticData;
    }

    var lastIndexTag = null;
    var UNCHANGED = {unchanged: true};

    // The ETag without the encoding's suffix (the server sends "<tag>" or
    // "<tag>-gzip" for the same records).
    function sameRecords(tag) {
        return tag ? tag.replace(/^W\//, "").replace(/-gzip"$/, "\"") : null;
    }

    /* The server's index. skipTag: an ETag the page has the records of
       already; an answer with that tag is not read at all (UNCHANGED).
       The browser itself asks with the ETag it has cached and gets 304,
       but fetch() then hands over the cached body, and parsing it would
       cost as much as a new one. */
    function loadServerIndex(skipTag) {
        return fetch(cfg.api + "/index", {credentials: "same-origin"}).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            var tag = sameRecords(response.headers.get("ETag"));
            if (skipTag && tag && tag === skipTag) {
                if (response.body && response.body.cancel) {
                    response.body.cancel().catch(function () {});
                }
                return UNCHANGED;
            }
            return response.json().then(function (data) {
                if (Array.isArray(data)) {
                    data = {version: 0, libraries: [], records: data};
                }
                if (!Array.isArray(data.albums)) {
                    data.albums = [];
                }
                data.etag = tag;
                return data;
            });
        });
    }

    // callback(value) once, outside the promise chain: an error in the
    // page's own code then shows in the console, and is not taken for a
    // failed download (which would call the callback a second time).
    function settle(promise, callback) {
        promise.then(function (value) {
            return value;
        }, function () {
            return null;
        }).then(function (value) {
            setTimeout(function () {
                callback(value);
            }, 0);
        });
    }

    function loadIndex(callback) {
        var promise = isStatic ? loadStaticIndex() : loadServerIndex(null);
        settle(promise.then(function (data) {
            if (!data || !Array.isArray(data.records)) {
                throw new Error("No records");
            }
            lastIndexTag = data.etag || null;
            return data;
        }), callback);
    }

    /* Load the index again when it may have changed (server only):
       callback(data) with new data, callback(null) when it is unchanged or
       cannot be loaded. An unchanged index costs one small request and is
       not parsed (see loadServerIndex). */
    function refreshIndex(callback) {
        if (isStatic) {
            callback(null);
            return;
        }
        settle(loadServerIndex(lastIndexTag).then(function (data) {
            if (data === UNCHANGED || !data || !Array.isArray(data.records)) {
                return null;
            }
            lastIndexTag = data.etag || null;
            return data;
        }), callback);
    }

    function loadRecord(id, callback) {
        if (isStatic) {
            settle(loadStaticIndex().then(function (data) {
                var key = String(id);
                var name = staticDetails[key] ? null : detailShard(data && data.manifest, key);
                if (!name) {
                    return staticDetails[key] || null;
                }
                return loadDataScript(name).then(function () {
                    return staticDetails[key] || null;
                });
            }), callback);
            return;
        }
        getJson(cfg.api + "/image/" + encodeURIComponent(id)).then(callback, function () {
            callback(null);
        });
    }

    function loadLocations(callback) {
        var promise;
        if (isStatic) {
            promise = loadStaticIndex().then(function (data) {
                var manifest = data && data.manifest;
                if (!manifest) {
                    // An older package.
                    return getJson((cfg.data || "data/") + "locations.json");
                }
                if (typeof manifest.locations !== "string" || !manifest.locations) {
                    return [];
                }
                return loadDataScript(manifest.locations).then(function () {
                    return staticLocations || [];
                });
            });
        } else {
            promise = getJson(cfg.api + "/locations");
        }
        promise.then(callback, function () {
            callback(null);
        });
    }

    var placesPromise = null;     // where the pictures were taken (null again after a failure)

    function loadPlaces(callback, fresh) {
        if (!placesPromise || fresh) {
            placesPromise = new Promise(function (resolve, reject) {
                loadLocations(function (points) {
                    if (!points) {
                        reject(new Error("no locations"));
                        return;
                    }
                    loadRoutes(function (routes) {
                        // (Without routes the clips count by their own positions.)
                        resolve({points: points, routes: routes || []});
                    });
                });
            });
            placesPromise.catch(function () {
                placesPromise = null;
            });
        }
        placesPromise.then(callback, function () {
            callback(null);
        });
    }

    function loadPeople(callback, hidden) {
        if (isStatic || !capabilities.people || !cfg.api) {
            callback(null);
            return;
        }
        getJson(cfg.api + "/people" + (hidden ? "?hidden=1" : "")).then(function (answer) {
            callback(answer && Array.isArray(answer.people) ? answer : null);
        }, function () {
            callback(null);
        });
    }

    var PERSON_TERM = /(^|\s)-?person:/i;
    var peopleEpoch = 0;        // raised by peopleChanged: the people loaded before are old

    function peopleChanged() {
        peopleEpoch += 1;
    }

    function peopleForSearch(onLoaded, hidden) {
        var list = null;
        var asked = false;
        var settled = false;
        var epoch = peopleEpoch;
        return {
            // (words: plain-language search may find a person's name in any word.)
            want: function (text, words) {
                text = String(text || "");
                if (asked && settled && epoch !== peopleEpoch) {
                    // (A face was named since: asked for again when needed.)
                    asked = false;
                    settled = false;
                    list = null;
                }
                if (asked || !(PERSON_TERM.test(text) || (words === true && /\S/.test(text)))) {
                    return false;
                }
                asked = true;
                epoch = peopleEpoch;
                var waiting = true;
                loadPeople(function (answer) {
                    settled = true;
                    list = answer && Array.isArray(answer.people) ? answer.people : null;
                    if (!onLoaded) {
                        return;
                    }
                    if (waiting) {
                        // (Not while the caller is still in want: it is searching.)
                        window.setTimeout(function () {
                            onLoaded(list);
                        }, 0);
                    } else {
                        onLoaded(list);
                    }
                }, hidden);
                waiting = false;
                return true;
            },
            options: function (opts) {
                opts.people = list;
                opts.peoplePending = asked && !settled;
                return opts;
            },
            pending: function () {
                return asked && !settled;
            }
        };
    }

    var routesPromise = null;     // the routes, once asked for (null again after a failure)

    function loadRoutes(callback) {
        if (!routesPromise) {
            if (isStatic) {
                routesPromise = loadStaticIndex().then(function (data) {
                    var manifest = data && data.manifest;
                    if (!manifest || typeof manifest.routes !== "string" || !manifest.routes) {
                        return [];
                    }
                    return loadDataScript(manifest.routes).then(function () {
                        return staticRoutes || [];
                    });
                });
            } else {
                routesPromise = getJson(cfg.api + "/routes").then(function (payload) {
                    return payload && Array.isArray(payload.routes) ? payload.routes : [];
                });
            }
            routesPromise.catch(function () {
                routesPromise = null;
            });
        }
        routesPromise.then(callback, function () {
            callback(null);
        });
    }

    var tripsPromise = null;      // the trips, once asked for (null again after a failure)

    function loadTrips(callback) {
        if (!tripsPromise) {
            if (isStatic) {
                tripsPromise = loadStaticIndex().then(function (data) {
                    var manifest = data && data.manifest;
                    if (!manifest || typeof manifest.trips !== "string" || !manifest.trips) {
                        return null;
                    }
                    return loadDataScript(manifest.trips).then(function () {
                        return staticTrips;
                    });
                });
            } else {
                tripsPromise = getJson(cfg.api + "/trips");
            }
            tripsPromise.catch(function () {
                tripsPromise = null;
            });
        }
        tripsPromise.then(function (value) {
            callback(value && typeof value === "object" && Array.isArray(value.trips)
                ? value : null);
        }, function () {
            callback(null);
        });
    }

    // Forget the trips loaded, so the next loadTrips asks again (after a change).
    function refreshTrips(callback) {
        tripsPromise = null;
        loadTrips(callback);
    }

    function loadTripStory(id, callback) {
        if (isStatic || !cfg.api) {
            callback(null);
            return;
        }
        getJson(cfg.api + "/trips/" + encodeURIComponent(id) + "/story").then(function (value) {
            callback(value && typeof value === "object" && Array.isArray(value.days) ? value
                : null);
        }, function () {
            callback(null);
        });
    }

    /* ---------- Meaning vectors ---------------------------------------------- */

    var vectorsPromise = null;    // the vectors (decoded and joined), or null
    var lastVectorsTag = null;
    var staticVectors = [];       // what an export's vector files pushed

    // [answer] from /api/vectors, or UNCHANGED for skipTag (see loadServerIndex).
    function loadServerVectors(skipTag) {
        return fetch(cfg.api + "/vectors", {credentials: "same-origin"}).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            var tag = sameRecords(response.headers.get("ETag"));
            if (skipTag && tag && tag === skipTag) {
                if (response.body && response.body.cancel) {
                    response.body.cancel().catch(function () {});
                }
                return UNCHANGED;
            }
            return response.json().then(function (payload) {
                payload.etag = tag;
                return [payload];
            });
        });
    }

    // The parts an export's vector files push (none without the option).
    function loadStaticVectors() {
        return loadStaticIndex().then(function (data) {
            var manifest = data && data.manifest;
            var names = manifest && Array.isArray(manifest.vectors) ? manifest.vectors : [];
            if (!names.length) {
                return [];
            }
            staticVectors = [];
            root.SEARCH_VECTORS = {
                push: function (part) {
                    if (part && typeof part === "object") {
                        staticVectors.push(part);
                    }
                }
            };
            return Promise.all(names.map(loadDataScript)).then(function () {
                return staticVectors.slice();
            });
        });
    }

    function decodeParts(parts) {
        /* global SearchCore */
        var core = root.SearchCore || (typeof SearchCore !== "undefined" ? SearchCore : null);
        if (!core || !Array.isArray(parts) || !parts.length) {
            return null;
        }
        var joined = core.joinVectors(parts.map(core.decodeVectors));
        if (joined) {
            // (Queries can be embedded: by the server, or by an export's own model.)
            joined.query = isStatic ? meaningInBrowser() : parts[0].query === true;
            joined.etag = parts[0].etag || null;
        }
        return joined;
    }

    function loadVectors(callback) {
        if (!vectorsPromise) {
            vectorsPromise = (isStatic ? loadStaticVectors() : loadServerVectors(null))
                .then(function (parts) {
                    var joined = decodeParts(parts);
                    lastVectorsTag = joined ? joined.etag : null;
                    return joined;
                }).catch(function (error) {
                    vectorsPromise = null;
                    throw error;
                });
        }
        settle(vectorsPromise, callback);
    }

    function refreshVectors(callback) {
        if (isStatic) {
            callback(null);
            return;
        }
        settle(loadServerVectors(lastVectorsTag).then(function (parts) {
            if (parts === UNCHANGED) {
                return null;
            }
            var joined = decodeParts(parts);
            lastVectorsTag = joined ? joined.etag : null;
            vectorsPromise = Promise.resolve(joined);
            return {vectors: joined};
        }), callback);
    }

    function attachVectors(index, callback) {
        loadVectors(function (vectors) {
            if (vectors && index && index.setVectors) {
                index.setVectors(vectors);
            }
            if (callback) {
                callback(vectors);
            }
        });
    }

    /* ---------- Look vectors ("Looks like this") ------------------------------ */

    var looksPromise = null;      // the look vectors (decoded and joined), or null
    var lastLooksTag = null;
    var staticLooks = [];         // what an export's looks files pushed

    // [answer] from /api/looks, or UNCHANGED for skipTag (see loadServerIndex).
    function loadServerLooks(skipTag) {
        return fetch(cfg.api + "/looks", {credentials: "same-origin"}).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            var tag = sameRecords(response.headers.get("ETag"));
            if (skipTag && tag && tag === skipTag) {
                if (response.body && response.body.cancel) {
                    response.body.cancel().catch(function () {});
                }
                return UNCHANGED;
            }
            return response.json().then(function (payload) {
                payload.etag = tag;
                return [payload];
            });
        });
    }

    // The parts an export's looks files push (none without the option).
    function loadStaticLooks() {
        return loadStaticIndex().then(function (data) {
            var manifest = data && data.manifest;
            var names = manifest && Array.isArray(manifest.looks) ? manifest.looks : [];
            if (!names.length) {
                return [];
            }
            staticLooks = [];
            root.SEARCH_LOOKS = {
                push: function (part) {
                    if (part && typeof part === "object") {
                        staticLooks.push(part);
                    }
                }
            };
            return Promise.all(names.map(loadDataScript)).then(function () {
                return staticLooks.slice();
            });
        });
    }

    function decodeLooks(parts) {
        var core = root.SearchCore || (typeof SearchCore !== "undefined" ? SearchCore : null);
        if (!core || !Array.isArray(parts) || !parts.length) {
            return null;
        }
        var joined = core.joinVectors(parts.map(core.decodeVectors));
        if (joined) {
            // (Only the server's admin can search by an example picture.)
            joined.query = !isStatic && parts[0].query === true;
            joined.etag = parts[0].etag || null;
        }
        return joined;
    }

    function loadLooks(callback) {
        if (!looksPromise) {
            looksPromise = (isStatic ? loadStaticLooks() : loadServerLooks(null))
                .then(function (parts) {
                    var joined = decodeLooks(parts);
                    lastLooksTag = joined ? joined.etag : null;
                    return joined;
                }).catch(function (error) {
                    looksPromise = null;
                    throw error;
                });
        }
        settle(looksPromise, callback);
    }

    function refreshLooks(callback) {
        if (isStatic) {
            callback(null);
            return;
        }
        settle(loadServerLooks(lastLooksTag).then(function (parts) {
            if (parts === UNCHANGED) {
                return null;
            }
            var joined = decodeLooks(parts);
            lastLooksTag = joined ? joined.etag : null;
            looksPromise = Promise.resolve(joined);
            return {looks: joined};
        }), callback);
    }

    function attachLooks(index, callback) {
        loadLooks(function (looks) {
            if (looks && index && index.setLooks) {
                index.setLooks(looks);
            }
            if (callback) {
                callback(looks);
            }
        });
    }

    // Search by an example picture (see the notes at the top).
    function lookQuery(blob, callback) {
        if (isStatic || !capabilities.admin || typeof fetch !== "function") {
            callback({state: "off", error: "Search by an example picture only works on the " +
                      "server, on this computer."});
            return;
        }
        var answer = fetch(cfg.api + "/looks/query", {
            method: "POST", body: blob, credentials: "same-origin",
            headers: {"X-Search-Images": "1",
                      "Content-Type": (blob && blob.type) || "application/octet-stream"}
        }).then(function (response) {
            return response.json().catch(function () {
                return {};
            }).then(function (payload) {
                if (response.ok && typeof payload.vec === "string") {
                    var thumb = typeof payload.thumb === "string" &&
                        /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(payload.thumb)
                        ? payload.thumb : null;
                    return {state: "ready", model: payload.model, dims: payload.dims,
                            vec: payload.vec, matches: payload.matches !== false,
                            thumb: thumb};
                }
                var state = payload && typeof payload.state === "string" ? payload.state
                    : "error";
                return {state: state, error: (payload && payload.error) ||
                        "The picture could not be compared (HTTP " + response.status + ")."};
            });
        }, function () {
            return {state: "error", error: "The server could not be reached."};
        });
        settle(answer, callback);
    }

    /* ---------- Search by meaning in an export (see the notes at the top) ---- */

    // The cosine the probe texts need with the server's vectors of them.
    var MEANING_SAME = 0.99;
    var MEANING_CONSENT_KEY = "searchImages.meaningDownload";
    // "idle", "loading", "ready", "failed" (word search until the page
    // loads again) or "off" (this browser cannot, or makes other vectors).
    var browserMeaning = {state: "idle", engine: null, waiting: null, progress: null,
                          warned: false};
    // The folder of the page's scripts (where site.js came from).
    var assetPrefix = (function () {
        var script = hasDocument ? document.currentScript : null;
        var src = script && script.getAttribute ? script.getAttribute("src") || "" : "";
        var at = src.search(/site\.js(\?|$)/);
        return at > 0 ? src.slice(0, at) : "assets/";
    })();

    /* The rest of the word list (SearchCore.wantWords): the script the
       first part names (english-words-more.js, next to site.js, with its
       version), added as a script element once, so it loads from disk too
       under the pages' script policy -- one that waits for no other script,
       nor holds one back (the meaning engine's own are added after it when a
       search first needs both). Resolves with its filter, or with null
       when it did not load, or not within WORDS_WAIT: the page then searches
       as with the first part alone rather than wait on. When it comes in
       after all, late (given with the first call) gets its filter. */
    var WORDS_WAIT = 20000;
    var moreWords = null;
    function loadWords(more, late) {
        if (!moreWords) {
            var file = more && typeof more.file === "string" &&
                /^[a-z][a-z0-9-]*\.js$/.test(more.file) ? more.file : "";
            moreWords = !file || !hasDocument ? Promise.resolve(null)
                : new Promise(function (resolve) {
                    var waited = false;
                    var timer = setTimeout(function () {
                        waited = true;
                        resolve(null);
                    }, WORDS_WAIT);
                    loadScript(versioned(assetPrefix + file, more.v), true).then(function () {
                        var found = root.ENGLISH_WORDS_MORE;
                        found = found && typeof found === "object" ? found : null;
                        clearTimeout(timer);
                        if (!waited) {
                            resolve(found);
                        } else if (found && typeof late === "function") {
                            late(found);
                        }
                    }, function () {
                        clearTimeout(timer);
                        resolve(null);
                    });
                });
        }
        return moreWords;
    }

    function exportMeaning() {
        var meaning = staticManifest && staticManifest.meaning;
        return isStatic && meaning && typeof meaning === "object" &&
            typeof meaning.id === "string" && typeof meaning.model === "string" &&
            Array.isArray(meaning.parts) && meaning.parts.length ? meaning : null;
    }

    function meaningInBrowser() {
        return Boolean(exportMeaning()) && browserMeaning.state !== "off";
    }

    function saveData() {
        var connection = root.navigator && root.navigator.connection;
        return Boolean(connection && connection.saveData);
    }

    function storage() {
        try {
            return root.localStorage || null;
        } catch (error) {
            return null;
        }
    }

    function downloadAllowed() {
        try {
            return storage() ? storage().getItem(MEANING_CONSENT_KEY) === "1" : false;
        } catch (error) {
            return false;
        }
    }

    function allowMeaningDownload() {
        try {
            if (storage()) {
                storage().setItem(MEANING_CONSENT_KEY, "1");
            }
        } catch (error) {
            // Not remembered: this page still loads it.
        }
        browserMeaning.allowed = true;
    }

    function base64(vector) {
        var bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.length);
        var text = "";
        for (var k = 0; k < bytes.length; k++) {
            text += String.fromCharCode(bytes[k]);
        }
        /* global Buffer */
        return typeof root.btoa === "function" ? root.btoa(text)
            : typeof btoa === "function" ? btoa(text) : Buffer.from(bytes).toString("base64");
    }

    /* (texts: one text, or several: then vecs too, see queryVector -- at
       most SearchCore.MEANING_TEXTS, as the server takes; each is a pass of
       the model, so the page gets a turn between them.) */
    function embedNow(meaning, texts, callback) {
        var list = (Array.isArray(texts) ? texts : [texts]).slice(0, MEANING_TEXTS);
        var vectors = [];
        function next() {
            try {
                vectors.push(browserMeaning.engine.query(list[vectors.length]));
            } catch (error) {
                callback({state: "unavailable", error: "Search by meaning could not run."});
                return;
            }
            if (vectors.length < list.length) {
                setTimeout(next, 0);
                return;
            }
            var answer = {state: "ready", model: meaning.id, dims: vectors[0].length,
                          vec: base64(vectors[0])};
            if (Array.isArray(texts)) {
                answer.vecs = vectors.map(base64);
            }
            callback(answer);
        }
        next();
    }

    function meaningFailed(state, message) {
        browserMeaning.state = state;
        var waiting = browserMeaning.waiting;
        browserMeaning.waiting = null;
        if (state === "off" && !browserMeaning.warned && root.console) {
            browserMeaning.warned = true;
            root.console.warn("Search by meaning is off in this browser: " + message);
        }
        if (waiting) {
            waiting.callback({state: state === "off" ? "off" : "unavailable", error: message});
        }
    }

    function loadEngine(meaning) {
        var assets = meaning.assets && typeof meaning.assets === "object" ? meaning.assets : {};
        function asset(name) {
            return versioned(assetPrefix + name, assets[name]);
        }
        var gzip = meaning.gzip > 0 ? meaning.gzip : meaning.bytes || 0;
        function report(loaded, total) {
            var share = total > 0 ? loaded / total : 0;
            if (browserMeaning.progress) {
                browserMeaning.progress({loaded: Math.round(share * gzip), total: gzip});
            }
        }
        report(0, 1);
        // (Without its WebAssembly kernel the engine runs in plain JavaScript:
        // the same vectors, only slower.)
        return loadScript(asset("embed-kernel.js")).catch(function () {
            return null;
        }).then(function () {
            return loadScript(asset("embed-engine.js"));
        }).then(function () {
            var engineApi = root.EMBED || (typeof EMBED !== "undefined" ? EMBED : null);
            if (!engineApi) {
                throw new Error("the engine did not load");
            }
            var missing = engineApi.unsupported();
            if (missing) {
                var error = new Error(missing);
                error.off = true;
                throw error;
            }
            return engineApi.load(meaning, {url: dataUrl, load: loadScript, progress: report});
        });
    }

    function staticQueryVector(text, callback, progress) {
        var meaning = exportMeaning();
        var state = browserMeaning.state;
        if (!meaning || state === "off" || state === "failed") {
            setTimeout(function () {
                callback(!meaning || state === "off" ? {state: "off", error: ""}
                    : {state: "unavailable", error: "Search by meaning could not load."});
            }, 0);
            return;
        }
        if (state === "ready") {
            setTimeout(function () {
                embedNow(meaning, text, callback);
            }, 0);
            return;
        }
        if (state === "idle" && saveData() && !downloadAllowed() && !browserMeaning.allowed) {
            setTimeout(function () {
                callback({state: "ask", bytes: meaning.gzip || meaning.bytes || 0});
            }, 0);
            return;
        }
        var earlier = browserMeaning.waiting;
        browserMeaning.waiting = {text: text, callback: callback};
        browserMeaning.progress = progress || null;
        if (earlier) {
            earlier.callback({state: "skipped"});
        }
        if (state !== "idle") {
            return;
        }
        browserMeaning.state = "loading";
        loadEngine(meaning).then(function (engine) {
            var lowest = engine.check();
            if (!(lowest >= MEANING_SAME)) {
                // (Its memory goes: nothing uses it.)
                meaningFailed("off", "its vectors differ from the site's (self-check " +
                              lowest.toFixed(3) + ")");
                return;
            }
            browserMeaning.engine = engine;
            browserMeaning.state = "ready";
            var waiting = browserMeaning.waiting;
            browserMeaning.waiting = null;
            if (waiting) {
                embedNow(meaning, waiting.text, waiting.callback);
            }
        }).catch(function (error) {
            meaningFailed(error && error.off ? "off" : "failed",
                          String(error && error.message || error));
        });
    }

    function queryVector(text, callback, progress) {
        if (isStatic) {
            staticQueryVector(text, callback, progress);
            return;
        }
        if (!cfg.api) {
            setTimeout(function () {
                callback({state: "off", error: ""});
            }, 0);
            return;
        }
        var asked = (Array.isArray(text) ? text.slice(0, MEANING_TEXTS) : [text])
            .map(function (one) {
                return "q=" + encodeURIComponent(one);
            }).join("&");
        fetch(cfg.api + "/embed?" + asked, {credentials: "same-origin"})
            .then(function (response) {
                return response.json().catch(function () {
                    return {};
                }).then(function (body) {
                    body = body && typeof body === "object" ? body : {};
                    if (response.ok) {
                        body.state = "ready";
                        return body;
                    }
                    if (response.status === 429) {
                        return {state: "busy", error: body.error || ""};
                    }
                    return {state: typeof body.state === "string" ? body.state : "unavailable",
                            error: typeof body.error === "string" ? body.error : ""};
                });
            }).then(callback, function () {
                callback({state: "unavailable", error: "The server did not answer."});
            });
    }

    return {
        page: cfg.page || "",
        // [{id, name}] of the libraries the page may show.
        libraryList: cfg.libraryList || [],
        // admin: Manage and Settings may be used; static: an export.
        capabilities: capabilities,
        adminApi: cfg.adminApi || null,
        isStatic: isStatic,
        // The name of the site: an export's title, else the program's.
        title: typeof cfg.title === "string" && cfg.title ? cfg.title : "Image Search",
        // The words of the link to imageUrl(): an export of web-size
        // pictures has no originals.
        originalLabel: isStatic && capabilities.images === true && capabilities.originals !== true
            ? "Open the large picture" : "Open the original",

        searchState: {
            read: readSearchState,
            params: searchParams,
            empty: emptyState,
            FACET_KEYS: FACET_KEYS
        },
        idList: {
            encode: encodeIdList,
            decode: decodeIdList,
            numbers: {encode: encodeNumbers, decode: decodeNumbers},
            maxLength: maxIdsLength
        },
        homeUrl: function () {
            return isStatic ? "index.html" : "/";
        },
        searchUrl: searchUrl,
        detailUrl: function (id, state) {
            var base = (isStatic ? "detail.html" : "/detail") + "?id=" + encodeURIComponent(id);
            return withQuery(base, searchParams(state));
        },
        // (Without the pictures picked on the map: the map shows the whole search.)
        mapUrl: function (state) {
            if (!hasMap()) {
                return null;
            }
            var copy = {};
            Object.keys(state || {}).forEach(function (key) {
                copy[key] = state[key];
            });
            copy.ids = "";
            return withQuery(isStatic ? "map.html" : "/map", searchParams(copy));
        },
        thumbUrl: thumbUrl,
        imageUrl: imageUrl,
        previewUrl: previewUrl,
        previewSize: previewSize,
        panoUrl: panoUrl,
        widePanoSize: widePanoSize,
        videoUrl: videoUrl,
        drivePreviewUrl: drivePreviewUrl,
        tripsUrl: function () {
            // (capabilities.trips false: trips are turned off in config.json.)
            return isStatic ? (cfg.tripsPage || null)
                : capabilities.trips === false ? null : "/trips";
        },
        tripUrl: function (id) {
            if (isStatic) {
                return cfg.tripsPage ? withQuery(cfg.tripsPage, "trip=" +
                                                 encodeURIComponent(id)) : null;
            }
            return "/trip/" + encodeURIComponent(id);
        },
        tileUrl: function (zoom, x, y) {
            var prefix = cfg.tiles;
            if (!prefix) {
                return null;
            }
            if (isStatic) {
                return prefix + zoom + "/" + x + "/" + y + ".jpg";
            }
            // (A browser keeps tiles a day: with the version, never those from
            // before the tile pyramid was made, or made again.)
            var version = typeof cfg.tilesVersion === "string" && cfg.tilesVersion
                ? "?v=" + encodeURIComponent(cfg.tilesVersion) : "";
            return prefix + "/" + zoom + "/" + x + "/" + y + ".jpg" + version;
        },
        tilesMax: function () {
            return typeof cfg.tilesMax === "number" ? cfg.tilesMax : null;
        },
        tileSize: function () {
            return cfg.tileSize || 256;
        },
        streets: function () {
            var info = cfg.streets;
            return info && typeof info === "object" && typeof info.url === "string" && info.url
                ? {url: info.url, v: typeof info.v === "string" ? info.v : ""} : null;
        },
        loadIndex: loadIndex,
        refreshIndex: refreshIndex,
        loadRecord: loadRecord,
        loadLocations: loadLocations,
        loadRoutes: loadRoutes,
        loadPlaces: loadPlaces,
        hasAreas: hasMap,
        loadTrips: loadTrips,
        refreshTrips: refreshTrips,
        loadTripStory: loadTripStory,
        loadVectors: loadVectors,
        refreshVectors: refreshVectors,
        attachVectors: attachVectors,
        loadLooks: loadLooks,
        refreshLooks: refreshLooks,
        attachLooks: attachLooks,
        lookQuery: lookQuery,
        loadPeople: loadPeople,
        peopleForSearch: peopleForSearch,
        peopleChanged: peopleChanged,
        faceUrl: function (id) {
            return isStatic ? null : "/face/" + encodeURIComponent(id);
        },
        queryVector: queryVector,
        loadWords: loadWords,
        meaningInBrowser: meaningInBrowser,
        allowMeaningDownload: allowMeaningDownload,
        compactRecord: compactRecord,
        shuffleSeed: shuffleSeed
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = SITE;
}
