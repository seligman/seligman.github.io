/* SITE: where the pages get their data and their addresses.

   This is the one place that knows the difference between the Flask server
   (data from the /api routes) and a static export (data from files next to
   the pages); everything else (search-core.js, viewer.js, app.js,
   detail.js, map.js) works the same in both. The page settings come from
   the <script type="application/json" id="app-config"> block the server (or
   the exporter) writes into each page.

   Data
     SITE.loadIndex(callback)      callback({version, generated, libraries:
                                   [{id, name}], records: [...]}) with the
                                   compact search records (keys: see
                                   search_index.py), or callback(null).
     SITE.loadRecord(id, callback) the full record of one picture (server:
                                   /api/image/<id>, with info, exif,
                                   provenance, ...; an export: what it
                                   holds beyond the compact record, if
                                   anything), or null. The pages show the
                                   compact record first and add this.
     SITE.loadLocations(callback)  [{id, lat, lon}] or null.
     SITE.compactRecord(detail)    a full record as a compact search record.

   Addresses (state: a search state, see below; may be left out)
     SITE.searchUrl(state, id)     the search page (with the viewer open on id)
     SITE.homeUrl()                the search page
     SITE.detailUrl(id, state)     the page of one picture
     SITE.mapUrl(state)            the map, following that search (null: no map)
     SITE.thumbUrl(record or id)   the small square-ish thumbnail
     SITE.previewUrl(record)       the screen-sized (2048 px) picture, or null
     SITE.panoUrl(record)          the large (4096 px) panorama of a 360-degree
                                   photo for the 360 view, or null (not a 360
                                   photo, or an export without panoramas)
     SITE.imageUrl(record)         the original (or what an export ships), or null
     SITE.tileUrl(z, x, y), SITE.tilesMax(), SITE.tileSize()   map tiles

   SITE.shuffleSeed(renew) is the seed of the "shuffle" sort: one per
   browser tab (a new one with renew).

   SITE.title is the name of the site ("Image Search", or an export's
   title); SITE.originalLabel the words of the link to SITE.imageUrl.

   Search state in the address (SITE.searchState)
     read(search)  -> {q, lib, sort, filters: {group: [values]}, group,
                       size, hidden, junk, sensitive, ids, view, from, to}
                       from a query string (default: the page's)
     params(state) -> the query string for a state ("" when all default)
     The facet selections use the group names of SearchCore.FACETS as
     parameter names, one per value: ?q=beach&type=photo&tags=sunset.
     ids holds the pictures picked on the map ("Show these in the grid"),
     written by SITE.idList.encode; view the map's centre and zoom
     ("lat,lon,zoom"), so the search page can lead back to the same place.
     The map itself never takes ids (mapUrl leaves them out). from and to
     are the timeline's choice of dates (SearchCore's range option:
     "YYYY", "YYYY-MM" or "YYYY-MM-DD").

   SITE.idList.encode(ids, records) -> the ids value for a list of picture
     ids; SITE.idList.decode(text, records) -> {ids: [...], stale} (stale:
     the value was made for other records, see there), or null when it is
     not a valid value. records are the records of loadIndex.
     SITE.idList.maxLength() is the longest value an address may carry here.

   A static export (export.py) writes data/manifest.js
   (window.SEARCH_DATA_MANIFEST = {shards: [...], details: [...],
   libraries, locations, ...}), index shards (SEARCH_DATA.push([...records]))
   and detail shards (SEARCH_DATA.detail({id: details})), and with the map
   data/locations.js (SEARCH_DATA.locations([{id, lat, lon}])). They are
   loaded with <script> tags (never fetch), so the pages also work when
   opened from disk. The details of a picture are in the detail shard
   detailShard() names, which is loaded when they are first wanted. An
   exported picture is images/<id>.jpg, or images/<id>.<rec.ix>; one with
   rec.pn has a large panorama in panos/<id>.jpg. The data files are asked
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
    var FACET_KEYS = ["library", "type", "people", "setting", "time", "event", "year", "month",
                      "place", "camera", "has", "tags", "subjects", "animals", "food",
                      "vehicles", "colors"];
    var SORTS = ["relevance", "newest", "oldest", "name", "quality", "shuffle"];
    var SIZES = ["s", "m", "l"];
    var SENSITIVE = ["show", "strict"];
    // At most this many values per facet group are taken from an address.
    var MAX_VALUES = 50;

    // The longest ids value read from an address (see idList).
    var MAX_IDS_TEXT = 200000;
    var IDS_RE = /^[0-9a-z]+(?:[._-][0-9a-z]+)*$/;
    // A date of the timeline's range: "YYYY", "YYYY-MM" or "YYYY-MM-DD".
    var DATE_KEY_RE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;
    // "lat,lon,zoom" of the map (see readView).
    var VIEW_RE = /^(-?\d{1,3}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?),(\d{1,2})$/;

    function emptyState() {
        return {q: "", lib: "", sort: "", filters: {}, group: true, size: "",
                hidden: false, junk: false, sensitive: "", ids: "", view: "", from: "", to: ""};
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
        var size = params.get("size");
        state.size = SIZES.indexOf(size) >= 0 ? size : "";
        state.hidden = params.get("hidden") === "1";
        state.junk = params.get("junk") === "1";
        var sensitive = params.get("sensitive");
        state.sensitive = SENSITIVE.indexOf(sensitive) >= 0 ? sensitive : "";
        var ids = params.get("ids") || "";
        state.ids = ids.length <= MAX_IDS_TEXT && IDS_RE.test(ids) ? ids : "";
        state.view = readView(params.get("view"));
        ["from", "to"].forEach(function (key) {
            var value = params.get(key) || "";
            state[key] = DATE_KEY_RE.test(value) ? value : "";
        });
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
        var url = withQuery(isStatic ? "index.html" : "/", searchParams(state));
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
        panos: cfg.panos || "panos/"
    };

    function thumbUrl(rec) {
        if (isStatic) {
            if (rec && rec._thumb) {
                return rec._thumb;
            }
            return staticPrefix.thumbs + encodeURIComponent(recordId(rec)) + ".jpg";
        }
        return "/thumb/" + encodeURIComponent(recordId(rec));
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

    // The large panorama of a 360-degree photo (rec.p "360"); null for
    // other pictures, for a 360-degree photo no larger than its preview
    // (which is then the whole picture), and in an export for a picture
    // without one (rec.pn: it has panos/<id>.jpg).
    function panoUrl(rec) {
        if (!rec || typeof rec !== "object" || rec.p !== "360") {
            return null;
        }
        if (isStatic && rec._pano) {
            return rec._pano;
        }
        var edge = Math.max(rec.w || 0, rec.hgt || 0);
        if (edge && edge <= PREVIEW_EDGE) {
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

    /* ---------- Compact records from full ones ------------------------------- */

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
        }
        if (detail.width) {
            rec.w = detail.width;
        }
        if (detail.height) {
            rec.hgt = detail.height;
        }
        if (detail.projection === "equirectangular" || detail.projection === "dual_fisheye") {
            rec.p = "360";
        }
        if (detail.hidden) {
            rec.h = 1;
        }
        if (detail.edited) {
            rec.ed = 1;
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

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = src;
            script.async = false;
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
                        libraries: libraries, records: records};
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
        panoUrl: panoUrl,
        tileUrl: function (zoom, x, y) {
            var prefix = cfg.tiles;
            if (!prefix) {
                return null;
            }
            if (isStatic) {
                return prefix + zoom + "/" + x + "/" + y + ".jpg";
            }
            return prefix + "/" + zoom + "/" + x + "/" + y + ".jpg";
        },
        tilesMax: function () {
            return typeof cfg.tilesMax === "number" ? cfg.tilesMax : null;
        },
        tileSize: function () {
            return cfg.tileSize || 256;
        },
        loadIndex: loadIndex,
        refreshIndex: refreshIndex,
        loadRecord: loadRecord,
        loadLocations: loadLocations,
        compactRecord: compactRecord,
        shuffleSeed: shuffleSeed
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = SITE;
}
