/* STREETS: the maps under the pins -- the world image, and street-level
   maps where they were downloaded (street_maps.py).

   The map page, the trip pages' maps and the viewer's map of a drive all
   draw their ground with STREETS.Basemap: the world image (make_tiles.py's
   tiles, or the server's cut of the small bundled one) as far as it has
   detail, and past that -- from zoom FROM_ZOOM on (about 50 km a tile:
   below it the world image, stretched a little, looks better than a
   patchwork of street maps around the pictures) -- the street maps, where
   there are any. Elsewhere the world image is stretched (fainter the
   further).

   Projection: Web Mercator, the street maps' own. At map zoom z the world
   is 512 * 2^z pixels wide and as tall (MAP.worldWidth with 256 px tiles):
   x grows east from the date line, y south from about 85 degrees north
   (STREETS.MAX_LAT; the poles are left out). The world image is
   equirectangular: each of its tiles is redrawn once into Web Mercator
   (row by row) when it arrives.

   Street maps: OpenStreetMap vector tiles (the Protomaps basemap, version
   4: layers earth, water, landcover, landuse, roads, buildings,
   boundaries, places), drawn here on canvases -- one per tile and zoom,
   kept while in use -- in a light or a dark style that follows the page's
   theme, with the names of places, roads and waters on top (placed anew
   for each drawing so that they never overlap, nor go under the map's
   buttons and credit: draw's avoid). Past their most detailed zoom they
   are drawn larger (OVERZOOM levels); where they end, they fade into the
   world image (FEATHER); a gap in them is filled from a tile
   at most FILL_LEVELS zooms coarser (and never one below FROM_ZOOM: a trip
   export leaves out every tile that touches home, and nothing of it may be
   drawn), else the world image shows there, and counts as "missing" (the
   map's note says the map has no more detail there). While a tile is
   drawn for the first time, one drawn before stands in for it: a coarser
   one, larger, or (zooming out) finer ones, smaller, on the land's colour
   (never the world image's darker colours: a flash). Tiles are drawn on
   their canvases for at most FRAME_BUDGET milliseconds a frame (at least
   one), the rest in the next frames.

   Where the tiles come from: the page settings' "streets" ({url, v}, see
   SITE.streets) -- /maps/ on the server, maps/ in an export. Every tile
   is a small script, <url><z>/<x>/<y>.js, that calls
   STREETS_DATA.tile(z, x, y, base64 of the gzip MVT); <url>index.js calls
   STREETS_DATA.index({minzoom, maxzoom, rows}) with the tiles there are
   (rows: {zoom: [[row, first column, last column, ...]]}), so no tile
   that is not there is ever asked for. Scripts (not fetch) so that a site
   opened from disk works too; nothing is ever asked of another host. Maps
   that show street tiles credit OpenStreetMap (STREETS.ATTRIBUTION), and
   while the world image shows, NASA's Blue Marble (STREETS.WORLD_CREDIT:
   make_tiles.py's world image, and the small bundled one, are made from
   it; public domain).

     STREETS.Basemap(options)      {tileUrl(z, x, y), tileSize, tileZoom
                                   (the world image's most detailed zoom),
                                   ocean, streets (SITE.streets(), or
                                   null), onLoad() (something arrived: draw
                                   again), labels (default true)}.
                                   draw(ctx, zoom, left, top, w, h, avoid)
                                   draws the view whose top left corner is
                                   world pixel (left, top) at zoom
                                   (fractional zooms too; avoid: [[x0, y0,
                                   x1, y1]] of the view no name goes under)
                                   and returns {stretch (levels the world
                                   image is stretched), streets (street
                                   tiles drawn), missing (tiles of the view
                                   without street map), tiles (tiles of the
                                   view, at a zoom with street maps)}.
                                   .ready() the street maps' index is in;
                                   .maxZoom() the deepest zoom worth
                                   zooming to (null: no street maps);
                                   .fitZoom() the deepest a fit goes;
                                   .coveredZoom(lat, lon) the most detailed
                                   zoom of a street tile there (-1: none;
                                   null: no street maps or not known yet).
     STREETS.licenceUrl(streets)   the address of the street maps' licence
                                   (the credit's link: a file of the server
                                   or of the export, never another host)
     STREETS.creditNode(tag, className, streets)   a map's credit (hidden)
     STREETS.showCredit(node, drawn)   shows the parts of a map's credit
                                   for what Basemap.draw drew; true when
                                   the credit was hidden and shows now
     STREETS.clearOf(node, canvas)  a node's rectangle on a canvas (for
                                   draw's avoid), or null when hidden
     STREETS.WorldLayer(options)   the world image alone (the same options)
     STREETS.StreetLayer(options)  the street maps alone
     STREETS.inflate(bytes)        gzip (or raw deflate) undone: a Uint8Array
     STREETS.decodeTile(bytes)     an MVT tile: {layer name: {extent,
                                   features: [{type, props, geom: [Int16Array
                                   of x, y pairs, one per ring or line], id
                                   (when it has one)}]}}; the named points
                                   of interest too (pois: not drawn, see
                                   Picker)
     STREETS.Picker(streets)       the named streets, areas and places of
                                   the street maps at a place or in a view,
                                   and all of one of them (the map page's
                                   search of an area; see Picker)
     STREETS.mercatorY(lat), STREETS.latitudeAt(t)   0 (north) to 1 (south)

   Loads under Node for the tests (tests/js/streets_test.js): no document
   there, so nothing is drawn or loaded unless the test gives a canvas
   maker (options.makeCanvas).
*/
var STREETS = (function () {
    "use strict";

    var root = typeof window !== "undefined" ? window : {};
    var hasDocument = typeof document !== "undefined" && document !== null;

    var ATTRIBUTION = "\u00a9 OpenStreetMap contributors";
    var WORLD_CREDIT = "Imagery: NASA Blue Marble";
    var MAX_LAT = 85.0511287798;
    // A street tile is this many pixels wide at its own zoom.
    var STREET_TILE = 512;
    // Street tiles are drawn up to this many zooms past their most detailed.
    var OVERZOOM = 3;
    // A part of a coarser tile drawn while a tile loads: this many zooms up at most.
    var STAND_IN = 6;
    // Street tiles are drawn from this zoom on (street_maps.DRAWN_FROM), and a gap
    // is filled from a tile at most FILL_LEVELS zooms coarser (never below FROM_ZOOM).
    var FROM_ZOOM = 9;
    var FILL_LEVELS = 3;
    // A search's pictures are fitted at most this far in (or the street maps' most
    // detailed zoom, when less).
    var FIT_ZOOM = 15;
    // Features this far (pixels) outside a tile may still show in it (wide lines).
    var MARGIN = 32;
    // Where the street maps end (a side of a tile with none next to it), they fade
    // out over this many tile pixels into the world image under them.
    var FEATHER = 48;
    // The sides of a tile (renderTile's edges): no street map to the west, north,
    // east, south of it.
    var WEST = 1;
    var NORTH = 2;
    var EAST = 4;
    var SOUTH = 8;
    // Tiles are drawn on their canvases for at most this many milliseconds a
    // frame (at least one; the rest in the next frames), and this many tile
    // scripts load at once.
    var FRAME_BUDGET = 8;
    var LOADS_AT_ONCE = 8;
    // Decoded tiles kept per source, and tiles that failed asked again after.
    var DECODED_KEPT = 96;
    var RETRY_MS = 30000;
    var FONT = "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif";
    // The layers decoded (the others are not even read): those drawn, and the named
    // points of interest (Picker).
    var LAYERS = ["earth", "landcover", "landuse", "water", "roads", "buildings", "boundaries",
                  "places", "pois"];

    /* ---------- Projection ------------------------------------------------ */

    // 0 at the north edge of the map (MAX_LAT) to 1 at the south edge.
    function mercatorY(lat) {
        var clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
        var r = clamped * Math.PI / 180;
        return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
    }

    function latitudeAt(t) {
        var v = Math.PI * (1 - 2 * t);
        return Math.atan((Math.exp(v) - Math.exp(-v)) / 2) * 180 / Math.PI;
    }

    function mod(value, n) {
        return ((value % n) + n) % n;
    }

    function now() {
        return root.performance && typeof root.performance.now === "function"
            ? root.performance.now() : Date.now();
    }

    /* ---------- gzip ------------------------------------------------------ */

    var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51,
                       59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
                        5, 5, 5, 5, 0];
    var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
                     769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
                      11, 11, 12, 12, 13, 13];
    var CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    /* A decoding table for code lengths: entries (symbol << 4 | length)
       indexed by the next `bits` bits of the stream (read lowest bit first). */
    function huffman(lengths) {
        var max = 0;
        var k;
        for (k = 0; k < lengths.length; k++) {
            max = Math.max(max, lengths[k]);
        }
        var counts = new Array(max + 1);
        for (k = 0; k <= max; k++) {
            counts[k] = 0;
        }
        for (k = 0; k < lengths.length; k++) {
            if (lengths[k]) {
                counts[lengths[k]] += 1;
            }
        }
        var next = new Array(max + 2);
        var code = 0;
        next[1] = 0;
        for (k = 1; k <= max; k++) {
            code = (code + (counts[k - 1] || 0)) << 1;
            next[k] = code;
        }
        var size = 1 << Math.max(1, max);
        var table = new Int32Array(size);
        for (var symbol = 0; symbol < lengths.length; symbol++) {
            var length = lengths[symbol];
            if (!length) {
                continue;
            }
            var value = next[length]++;
            var reversed = 0;
            for (var bit = 0; bit < length; bit++) {
                reversed = (reversed << 1) | ((value >> bit) & 1);
            }
            for (var at = reversed; at < size; at += 1 << length) {
                table[at] = (symbol << 4) | length;
            }
        }
        return {table: table, bits: Math.max(1, max)};
    }

    var FIXED = null;

    function fixedTables() {
        if (!FIXED) {
            var lengths = [];
            var k;
            for (k = 0; k < 288; k++) {
                lengths.push(k < 144 ? 8 : k < 256 ? 9 : k < 280 ? 7 : 8);
            }
            var distances = [];
            for (k = 0; k < 30; k++) {
                distances.push(5);
            }
            FIXED = {lit: huffman(lengths), dist: huffman(distances)};
        }
        return FIXED;
    }

    function inflateRaw(data, start) {
        var pos = start;
        var bitBuf = 0;
        var bitCount = 0;
        var out = new Uint8Array(Math.max(1024, data.length * 4));
        var outPos = 0;

        function need(count) {
            while (bitCount < count) {
                bitBuf |= (pos < data.length ? data[pos] : 0) << bitCount;
                pos += 1;
                bitCount += 8;
            }
        }

        function bits(count) {
            if (!count) {
                return 0;
            }
            need(count);
            var value = bitBuf & ((1 << count) - 1);
            bitBuf >>>= count;
            bitCount -= count;
            return value;
        }

        function decode(code) {
            need(code.bits);
            var entry = code.table[bitBuf & ((1 << code.bits) - 1)];
            var length = entry & 15;
            if (!length) {
                throw new Error("bad deflate data");
            }
            bitBuf >>>= length;
            bitCount -= length;
            return entry >> 4;
        }

        function room(count) {
            if (outPos + count > out.length) {
                var bigger = new Uint8Array(Math.max(out.length * 2, outPos + count));
                bigger.set(out.subarray(0, outPos));
                out = bigger;
            }
        }

        var last = 0;
        while (!last) {
            if (pos > data.length + 4) {
                throw new Error("deflate data cut short");
            }
            last = bits(1);
            var type = bits(2);
            if (type === 0) {
                // Stored: whole bytes (the bits read ahead are given back).
                pos -= bitCount >> 3;
                bitBuf = 0;
                bitCount = 0;
                var length = data[pos] | (data[pos + 1] << 8);
                pos += 4;
                if (pos + length > data.length) {
                    throw new Error("deflate data cut short");
                }
                room(length);
                out.set(data.subarray(pos, pos + length), outPos);
                outPos += length;
                pos += length;
                continue;
            }
            var lit;
            var dist;
            if (type === 1) {
                lit = fixedTables().lit;
                dist = fixedTables().dist;
            } else if (type === 2) {
                var litCount = bits(5) + 257;
                var distCount = bits(5) + 1;
                var codeCount = bits(4) + 4;
                var codeLengths = [];
                var k;
                for (k = 0; k < 19; k++) {
                    codeLengths.push(0);
                }
                for (k = 0; k < codeCount; k++) {
                    codeLengths[CODE_ORDER[k]] = bits(3);
                }
                var codes = huffman(codeLengths);
                var lengths = [];
                while (lengths.length < litCount + distCount) {
                    var symbol = decode(codes);
                    if (symbol < 16) {
                        lengths.push(symbol);
                    } else {
                        var repeat;
                        var value = 0;
                        if (symbol === 16) {
                            if (!lengths.length) {
                                throw new Error("bad deflate data");
                            }
                            value = lengths[lengths.length - 1];
                            repeat = 3 + bits(2);
                        } else if (symbol === 17) {
                            repeat = 3 + bits(3);
                        } else {
                            repeat = 11 + bits(7);
                        }
                        while (repeat--) {
                            lengths.push(value);
                        }
                    }
                }
                lit = huffman(lengths.slice(0, litCount));
                dist = huffman(lengths.slice(litCount, litCount + distCount));
            } else {
                throw new Error("bad deflate block");
            }
            for (;;) {
                var code = decode(lit);
                if (code < 256) {
                    room(1);
                    out[outPos++] = code;
                } else if (code === 256) {
                    break;
                } else {
                    code -= 257;
                    if (code >= 29) {
                        throw new Error("bad deflate length");
                    }
                    var size = LENGTH_BASE[code] + bits(LENGTH_EXTRA[code]);
                    var where = decode(dist);
                    if (where >= 30) {
                        throw new Error("bad deflate distance");
                    }
                    var back = DIST_BASE[where] + bits(DIST_EXTRA[where]);
                    if (back > outPos) {
                        throw new Error("bad deflate distance");
                    }
                    room(size);
                    for (var n = 0; n < size; n++) {
                        out[outPos] = out[outPos - back];
                        outPos += 1;
                    }
                }
            }
        }
        return out.subarray(0, outPos);
    }

    // gzip, zlib or raw deflate data undone.
    function inflate(data) {
        if (data.length > 18 && data[0] === 0x1f && data[1] === 0x8b) {
            var flags = data[3];
            var pos = 10;
            if (flags & 4) {
                pos += 2 + (data[pos] | (data[pos + 1] << 8));
            }
            if (flags & 8) {
                while (pos < data.length && data[pos++] !== 0) {
                    // (the file name)
                }
            }
            if (flags & 16) {
                while (pos < data.length && data[pos++] !== 0) {
                    // (a comment)
                }
            }
            if (flags & 2) {
                pos += 2;
            }
            return inflateRaw(data, pos);
        }
        if (data.length > 2 && (data[0] & 15) === 8 && ((data[0] << 8) | data[1]) % 31 === 0) {
            return inflateRaw(data, 2);
        }
        return inflateRaw(data, 0);
    }

    /* ---------- Vector tiles (MVT) ---------------------------------------- */

    var decoder = typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;

    function utf8(bytes) {
        if (decoder) {
            return decoder.decode(bytes);
        }
        var text = "";
        for (var k = 0; k < bytes.length; k++) {
            text += String.fromCharCode(bytes[k]);
        }
        try {
            return decodeURIComponent(escape(text));
        } catch (error) {
            return text;
        }
    }

    function Reader(bytes) {
        this.bytes = bytes;
        this.pos = 0;
        this.view = null;
    }

    Reader.prototype.varint = function () {
        var bytes = this.bytes;
        var value = 0;
        var scale = 1;
        for (var k = 0; k < 10; k++) {
            var byte = bytes[this.pos++];
            value += (byte & 0x7f) * scale;
            if (byte < 0x80) {
                return value;
            }
            scale *= 128;
        }
        throw new Error("bad varint");
    };

    Reader.prototype.svarint = function () {
        var value = this.varint();
        return value % 2 === 1 ? (value + 1) / -2 : value / 2;
    };

    Reader.prototype.bytesField = function () {
        var length = this.varint();
        var start = this.pos;
        this.pos += length;
        return this.bytes.subarray(start, start + length);
    };

    Reader.prototype.skip = function (wire) {
        if (wire === 0) {
            this.varint();
        } else if (wire === 1) {
            this.pos += 8;
        } else if (wire === 2) {
            this.pos += this.varint();
        } else if (wire === 5) {
            this.pos += 4;
        } else {
            throw new Error("bad wire type");
        }
    };

    function readValue(bytes) {
        var reader = new Reader(bytes);
        var value = null;
        while (reader.pos < bytes.length) {
            var key = reader.varint();
            var field = Math.floor(key / 8);
            var wire = key & 7;
            if (field === 1) {
                value = utf8(reader.bytesField());
            } else if (field === 2) {
                value = new DataView(bytes.buffer, bytes.byteOffset + reader.pos, 4)
                    .getFloat32(0, true);
                reader.pos += 4;
            } else if (field === 3) {
                value = new DataView(bytes.buffer, bytes.byteOffset + reader.pos, 8)
                    .getFloat64(0, true);
                reader.pos += 8;
            } else if (field === 4 || field === 5) {
                value = reader.varint();
            } else if (field === 6) {
                value = reader.svarint();
            } else if (field === 7) {
                value = Boolean(reader.varint());
            } else {
                reader.skip(wire);
            }
        }
        return value;
    }

    function packed(bytes) {
        var reader = new Reader(bytes);
        var out = [];
        while (reader.pos < bytes.length) {
            out.push(reader.varint());
        }
        return out;
    }

    // The rings (polygons), lines or points of a feature: [Int16Array of x, y, ...].
    function geometry(commands) {
        var parts = [];
        var current = null;
        var x = 0;
        var y = 0;
        var k = 0;
        while (k < commands.length) {
            var header = commands[k++];
            var command = header & 7;
            var count = header >> 3;
            if (command === 1 || command === 2) {
                for (var n = 0; n < count; n++) {
                    var dx = commands[k++];
                    var dy = commands[k++];
                    x += (dx >> 1) ^ (-(dx & 1));
                    y += (dy >> 1) ^ (-(dy & 1));
                    if (command === 1 || !current) {
                        current = [];
                        parts.push(current);
                    }
                    current.push(Math.max(-32768, Math.min(32767, x)),
                                 Math.max(-32768, Math.min(32767, y)));
                }
            } else if (command !== 7) {
                break;
            }
        }
        return parts.map(function (part) {
            return new Int16Array(part);
        });
    }

    function readFeature(bytes, keys, values, skip) {
        var reader = new Reader(bytes);
        var tags = [];
        var type = 0;
        var commands = null;
        var id = null;
        while (reader.pos < bytes.length) {
            var key = reader.varint();
            var field = Math.floor(key / 8);
            if (field === 1 && (key & 7) === 0) {
                id = reader.varint();
            } else if (field === 2) {
                tags = packed(reader.bytesField());
            } else if (field === 3) {
                type = reader.varint();
            } else if (field === 4) {
                commands = reader.bytesField();
            } else {
                reader.skip(key & 7);
            }
        }
        var props = {};
        for (var k = 0; k + 1 < tags.length; k += 2) {
            props[keys[tags[k]]] = values[tags[k + 1]];
        }
        if (skip && skip(props, type)) {
            return null;
        }
        var geom = commands ? geometry(packed(commands)) : [];
        // (Its box, so a part of a tile drawn larger leaves out what is not in it.)
        var box = [Infinity, Infinity, -Infinity, -Infinity];
        geom.forEach(function (part) {
            for (var n = 0; n + 1 < part.length; n += 2) {
                box[0] = Math.min(box[0], part[n]);
                box[1] = Math.min(box[1], part[n + 1]);
                box[2] = Math.max(box[2], part[n]);
                box[3] = Math.max(box[3], part[n + 1]);
            }
        });
        var feature = {type: type, props: props, geom: geom, box: box};
        if (id !== null) {
            feature.id = id;
        }
        return feature;
    }

    // Features left out: address points and nameless points of buildings, and the
    // points of interest without a name.
    function skipFeature(layer) {
        if (layer === "buildings") {
            return function (props, type) {
                return type === 1;
            };
        }
        if (layer === "pois") {
            return function (props, type) {
                return type !== 1 || typeof props.name !== "string" || !props.name;
            };
        }
        return null;
    }

    function decodeTile(bytes, wanted) {
        var reader = new Reader(bytes);
        var layers = {};
        wanted = wanted || LAYERS;
        while (reader.pos < bytes.length) {
            var key = reader.varint();
            if (Math.floor(key / 8) !== 3 || (key & 7) !== 2) {
                reader.skip(key & 7);
                continue;
            }
            var layerBytes = reader.bytesField();
            var layer = new Reader(layerBytes);
            var name = "";
            var extent = 4096;
            var keys = [];
            var values = [];
            var features = [];
            while (layer.pos < layerBytes.length) {
                var lkey = layer.varint();
                var field = Math.floor(lkey / 8);
                if (field === 1) {
                    name = utf8(layer.bytesField());
                } else if (field === 2) {
                    features.push(layer.bytesField());
                } else if (field === 3) {
                    keys.push(utf8(layer.bytesField()));
                } else if (field === 4) {
                    values.push(readValue(layer.bytesField()));
                } else if (field === 5) {
                    extent = layer.varint();
                } else {
                    layer.skip(lkey & 7);
                }
            }
            if (wanted.indexOf(name) < 0) {
                continue;
            }
            var skip = skipFeature(name);
            var list = [];
            for (var k = 0; k < features.length; k++) {
                var feature = readFeature(features[k], keys, values, skip);
                if (feature) {
                    list.push(feature);
                }
            }
            layers[name] = {extent: extent, features: list};
        }
        return layers;
    }

    function base64Bytes(text) {
        var binary = typeof atob === "function" ? atob(text)
            : typeof Buffer !== "undefined" ? Buffer.from(text, "base64").toString("binary")
                : "";
        var bytes = new Uint8Array(binary.length);
        for (var k = 0; k < binary.length; k++) {
            bytes[k] = binary.charCodeAt(k);
        }
        return bytes;
    }

    /* ---------- Styles ------------------------------------------------------ */

    // Waters whose names are left off the map (a fountain is not a lake).
    var QUIET_WATERS = ["fountain", "swimming_pool", "dock", "basin", "reservoir_small"];
    var GREEN = ["park", "garden", "grass", "meadow", "recreation_ground", "playground",
                 "dog_park", "village_green", "golf_course", "allotments", "nature_reserve",
                 "national_park", "protected_area", "zoo", "theme_park", "grassland"];
    var THEMES = {
        light: {
            water: "#a8cbe4", earth: "#f2efe9",
            cover: {forest: "#d3e3c4", wood: "#d3e3c4", grassland: "#e2ebd2", scrub: "#dce6cb",
                    farmland: "#efecd9", barren: "#ece6da", urban_area: "#e8e4dd",
                    snow: "#fbfbfb", glacier: "#fbfbfb"},
            use: {green: "#cfe4be", pitch: "#bedcaa", forest: "#bcd6a6", wood: "#bcd6a6",
                  scrub: "#d5e1c2", cemetery: "#d6dfcb", residential: "#ebe7e0",
                  commercial: "#efe4e2", retail: "#efe4e2", industrial: "#e6e1e8",
                  railway: "#e6e1e8", military: "#ecdad3", school: "#efe6d6",
                  university: "#efe6d6", college: "#efe6d6", kindergarten: "#efe6d6",
                  hospital: "#f1e2dd", beach: "#f3e9c7", sand: "#f3e9c7",
                  pedestrian: "#e9e5de", platform: "#e3dfd8", pier: "#e3dfd8",
                  wetland: "#d0e4dc", farmland: "#edead3", orchard: "#e4ead0",
                  vineyard: "#e4ead0", parking: "#e7e4df", aerodrome: "#e3e0e9",
                  runway: "#d6d2dc", glacier: "#fbfbfb"},
            building: "#ddd6cc", buildingEdge: "#cbc2b5",
            roads: {highway: ["#f8c76a", "#cf9a42"], major_road: ["#fdeaa8", "#d2b874"],
                    medium_road: ["#ffffff", "#cdc3b4"], minor_road: ["#ffffff", "#d5ccbf"],
                    other: ["#ffffff", "#d8d1c6"], path: ["#b3a38a", null]},
            tunnel: "rgba(255, 255, 255, 0.55)", rail: "#9d9993", ferry: "#6f9ac2",
            river: "#a8cbe4",
            country: "#9b87af", region: "#bcadc9",
            text: "#2e3236", minor: "#5c6167", waterText: "#3a6c96", road: "#3d4045",
            halo: "rgba(255, 255, 255, 0.92)"
        },
        dark: {
            water: "#18304a", earth: "#23272c",
            cover: {forest: "#24332a", wood: "#24332a", grassland: "#283229",
                    scrub: "#273028", farmland: "#2a2c27", barren: "#2b2a28",
                    urban_area: "#2a2d32", snow: "#3a3f45", glacier: "#3a3f45"},
            use: {green: "#263a2c", pitch: "#2c4532", forest: "#223428", wood: "#223428",
                  scrub: "#283329", cemetery: "#29332b", residential: "#292d32",
                  commercial: "#33292c", retail: "#33292c", industrial: "#2e2b33",
                  railway: "#2e2b33", military: "#362a28", school: "#332e28",
                  university: "#332e28", college: "#332e28", kindergarten: "#332e28",
                  hospital: "#352a2a", beach: "#38352a", sand: "#38352a",
                  pedestrian: "#2c2f34", platform: "#30333a", pier: "#30333a",
                  wetland: "#243430", farmland: "#2b2d27", orchard: "#29302a",
                  vineyard: "#29302a", parking: "#2c2f34", aerodrome: "#2e2d35",
                  runway: "#3a3942", glacier: "#3a3f45"},
            building: "#343940", buildingEdge: "#40464e",
            roads: {highway: ["#a77b36", "#55401f"], major_road: ["#6c6650", "#383528"],
                    medium_road: ["#4d525a", "#2b2f35"], minor_road: ["#454a52", "#2b2f35"],
                    other: ["#3f444b", "#2b2f35"], path: ["#5e5b55", null]},
            tunnel: "rgba(80, 86, 94, 0.6)", rail: "#62676e", ferry: "#3f6b93",
            river: "#18304a",
            country: "#806f93", region: "#5b5167",
            text: "#e2e5e9", minor: "#a4aab1", waterText: "#8eb8da", road: "#c9cdd2",
            halo: "rgba(17, 19, 22, 0.9)"
        }
    };
    // Line widths in pixels at zooms: [[zoom, width], ...] (in between: on
    // the same doubling curve; none before the first).
    var WIDTHS = {
        highway: [[5, 0.6], [8, 1.1], [11, 2], [13, 3.5], [15, 7], [17, 14], [18, 22]],
        major_road: [[7, 0.5], [10, 1], [12, 2], [14, 4], [16, 9], [18, 20]],
        medium_road: [[10, 0.5], [12, 1.2], [14, 3], [16, 7], [18, 16]],
        minor_road: [[12, 0.4], [13, 0.8], [15, 2.4], [17, 7], [18, 12]],
        other: [[14, 0.5], [16, 1.6], [18, 5]],
        path: [[14, 0.6], [16, 1], [18, 2]],
        rail: [[9, 0.5], [13, 1], [16, 1.6], [18, 2.5]],
        ferry: [[8, 0.6], [14, 1.2]],
        river: [[8, 0.5], [12, 1], [14, 2.5], [16, 5], [18, 10]],
        stream: [[13, 0.5], [15, 1], [18, 2.5]],
        country: [[0, 0.6], [6, 1], [10, 1.5], [14, 2]],
        region: [[3, 0.4], [8, 0.7], [14, 1.2]]
    };

    function width(table, zoom) {
        if (!table || zoom < table[0][0]) {
            return 0;
        }
        for (var k = 1; k < table.length; k++) {
            if (zoom <= table[k][0]) {
                var a = table[k - 1];
                var b = table[k];
                var share = (zoom - a[0]) / (b[0] - a[0]);
                return a[1] * Math.pow(b[1] / a[1], share);
            }
        }
        return table[table.length - 1][1];
    }

    function roadClass(props) {
        var kind = props.kind;
        if (kind === "minor_road" && props.kind_detail === "service") {
            return "other";
        }
        return WIDTHS[kind] && THEMES.light.roads[kind] ? kind : null;
    }

    function landuseColour(theme, kind) {
        if (GREEN.indexOf(kind) >= 0) {
            return theme.use.green;
        }
        return theme.use[kind] || null;
    }

    function theme() {
        if (!hasDocument) {
            return "light";
        }
        var chosen = document.documentElement.getAttribute("data-theme");
        if (chosen === "dark" || chosen === "light") {
            return chosen;
        }
        return root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark" : "light";
    }

    /* ---------- Drawing one street tile ------------------------------------- */

    // A point of a line this close (tile pixels, both ways) to the last one drawn is
    // left out: nothing to see, but much less to draw at the coarse zooms.
    var MIN_STEP = 0.5;

    // The rings, lines or points of features as a path in tile pixels.
    function tracePath(ctx, geom, scale, offX, offY, close) {
        for (var p = 0; p < geom.length; p++) {
            var part = geom[p];
            if (part.length < 2) {
                continue;
            }
            var lastX = part[0] * scale - offX;
            var lastY = part[1] * scale - offY;
            ctx.moveTo(lastX, lastY);
            var end = part.length - 2;
            for (var k = 2; k < part.length; k += 2) {
                var px = part[k] * scale - offX;
                var py = part[k + 1] * scale - offY;
                if (k < end && Math.abs(px - lastX) < MIN_STEP &&
                        Math.abs(py - lastY) < MIN_STEP) {
                    continue;
                }
                ctx.lineTo(px, py);
                lastX = px;
                lastY = py;
            }
            if (close) {
                ctx.closePath();
            }
        }
    }

    function fillFeatures(ctx, features, colourOf, scale, offX, offY) {
        // One path per colour, in the order the colours first come.
        var order = [];
        var byColour = {};
        features.forEach(function (feature) {
            if (feature.type !== 3) {
                return;
            }
            var colour = colourOf(feature.props);
            if (!colour) {
                return;
            }
            if (!byColour[colour]) {
                byColour[colour] = [];
                order.push(colour);
            }
            byColour[colour].push(feature);
        });
        order.forEach(function (colour) {
            ctx.beginPath();
            byColour[colour].forEach(function (feature) {
                tracePath(ctx, feature.geom, scale, offX, offY, true);
            });
            ctx.fillStyle = colour;
            ctx.fill();
        });
    }

    function strokeFeatures(ctx, features, colour, lineWidth, scale, offX, offY, dash) {
        if (!features.length || !(lineWidth > 0)) {
            return;
        }
        ctx.beginPath();
        features.forEach(function (feature) {
            tracePath(ctx, feature.geom, scale, offX, offY, false);
        });
        ctx.setLineDash(dash || []);
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = colour;
        ctx.stroke();
        ctx.setLineDash([]);
    }

    function bySortRank(a, b) {
        return (Number(a.props.sort_rank) || 0) - (Number(b.props.sort_rank) || 0);
    }

    var measureCtx = null;

    function textWidth(font, text) {
        if (!measureCtx) {
            return text.length * 6;
        }
        measureCtx.font = font;
        return measureCtx.measureText(text).width;
    }

    // The longest straight piece of a line (in tile pixels): {x, y, angle, length}.
    function longestPiece(geom, scale, offX, offY) {
        var best = null;
        geom.forEach(function (part) {
            for (var k = 2; k < part.length; k += 2) {
                var x0 = part[k - 2] * scale - offX;
                var y0 = part[k - 1] * scale - offY;
                var x1 = part[k] * scale - offX;
                var y1 = part[k + 1] * scale - offY;
                var length = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
                var mx = (x0 + x1) / 2;
                var my = (y0 + y1) / 2;
                if (mx < 0 || my < 0 || mx >= STREET_TILE || my >= STREET_TILE) {
                    continue;
                }
                if (!best || length > best.length) {
                    var angle = Math.atan2(y1 - y0, x1 - x0);
                    if (angle > Math.PI / 2) {
                        angle -= Math.PI;
                    } else if (angle < -Math.PI / 2) {
                        angle += Math.PI;
                    }
                    best = {x: mx, y: my, angle: angle, length: length};
                }
            }
        });
        return best;
    }

    // Places of the "locality" kind that are no town: a crossroads, a bastion,
    // a field's name (the basemap's kind_detail).
    var UNPOPULATED = ["locality", "isolated_dwelling", "farm", "square"];
    // The size of a town's name by its kind_detail.
    var TOWN_SIZES = {city: 15, town: 13, village: 12, hamlet: 11};

    function placeLabel(props, zoom) {
        var kind = props.kind;
        var detail = props.kind_detail;
        var rank = Number(props.population_rank) || 0;
        // (As the basemap's own styles: a place only from its min_zoom on.)
        var minZoom = Number(props.min_zoom);
        if (isFinite(minZoom) && minZoom > zoom) {
            return null;
        }
        if (kind === "country") {
            return zoom <= 7 ? {font: "600 14px " + FONT, prio: 0, colour: "text"} : null;
        }
        if (kind === "region") {
            return zoom >= 5 && zoom <= 9 ? {font: "italic 12px " + FONT, prio: 1,
                                             colour: "minor"} : null;
        }
        if (kind === "locality" && UNPOPULATED.indexOf(detail) >= 0) {
            // (Below the neighbourhoods: no town.)
            return {font: "11px " + FONT, prio: 9, colour: "minor"};
        }
        if (kind === "locality") {
            var size = TOWN_SIZES[detail] ? TOWN_SIZES[detail] + (detail === "city" &&
                                                                  rank >= 12 ? 1 : 0)
                : rank >= 12 ? 15 : rank >= 10 ? 14 : rank >= 8 ? 13 : 12;
            var bold = detail === "city" || (detail !== "village" && detail !== "hamlet" &&
                                             rank >= 9);
            return {font: (bold ? "600 " : "500 ") + size + "px " + FONT,
                    prio: 2 + Math.max(0, 16 - rank) / 4,
                    colour: detail === "hamlet" ? "minor" : "text"};
        }
        if (kind === "neighbourhood" || kind === "macrohood") {
            return zoom >= 13 ? {font: "11px " + FONT, prio: kind === "macrohood" ? 7 : 8,
                                 colour: "minor"} : null;
        }
        return null;
    }

    /* Draws the street tile (zoom, x, y) of the map from the decoded tile of
       (source zoom, sx, sy) (zoom - source zoom levels up) on a canvas of
       STREET_TILE * ratio pixels, and lists its labels: {canvas, labels:
       [{x, y (tile pixels), text, font, colour, angle, w, h, prio, line}]}.
       edges (WEST | NORTH | EAST | SOUTH): the sides with no street map next
       to them, where the tile fades out (FEATHER). */
    function renderTile(make, tile, zoom, x, y, sourceZoom, ratio, themeName, edges) {
        var size = Math.round(STREET_TILE * ratio);
        var canvas = make(size, size);
        var ctx = canvas.getContext("2d");
        var style = THEMES[themeName] || THEMES.light;
        var up = zoom - sourceZoom;
        var labels = [];
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.fillStyle = style.water;
        ctx.fillRect(0, 0, STREET_TILE, STREET_TILE);

        // Tile pixels per unit of a layer, and where this tile starts in them.
        function frame(found) {
            var scale = STREET_TILE * Math.pow(2, up) / (found.extent || 4096);
            var n = Math.pow(2, up);
            return {scale: scale, offX: (x - Math.floor(x / n) * n) * STREET_TILE,
                    offY: (y - Math.floor(y / n) * n) * STREET_TILE};
        }

        // A layer's features that reach into this tile (all of them at its own zoom).
        function layer(name) {
            var found = tile[name] || {extent: 4096, features: []};
            if (!up) {
                return found;
            }
            var at = frame(found);
            return {extent: found.extent, features: found.features.filter(function (feature) {
                var box = feature.box;
                return !box || (box[2] * at.scale - at.offX >= -MARGIN &&
                                box[0] * at.scale - at.offX <= STREET_TILE + MARGIN &&
                                box[3] * at.scale - at.offY >= -MARGIN &&
                                box[1] * at.scale - at.offY <= STREET_TILE + MARGIN);
            })};
        }

        var earth = layer("earth");
        var f = frame(earth);
        fillFeatures(ctx, earth.features, function () {
            return style.earth;
        }, f.scale, f.offX, f.offY);
        var cover = layer("landcover");
        f = frame(cover);
        fillFeatures(ctx, cover.features, function (props) {
            return style.cover[props.kind] || null;
        }, f.scale, f.offX, f.offY);
        var use = layer("landuse");
        f = frame(use);
        fillFeatures(ctx, use.features.slice().sort(bySortRank), function (props) {
            // (Farmland, much like the land's own colour, from zoom 12: below, its
            // many fields cost much to draw for little to see.)
            return zoom < 12 && props.kind === "farmland" ? null
                : landuseColour(style, props.kind);
        }, f.scale, f.offX, f.offY);

        var water = layer("water");
        f = frame(water);
        fillFeatures(ctx, water.features, function () {
            return style.water;
        }, f.scale, f.offX, f.offY);
        var rivers = water.features.filter(function (feature) {
            return feature.type === 2 && (feature.props.kind === "river" ||
                                          feature.props.kind === "canal");
        });
        var streams = water.features.filter(function (feature) {
            return feature.type === 2 && !(feature.props.kind === "river" ||
                                           feature.props.kind === "canal");
        });
        strokeFeatures(ctx, rivers, style.river, width(WIDTHS.river, zoom), f.scale, f.offX,
                       f.offY);
        strokeFeatures(ctx, streams, style.river, width(WIDTHS.stream, zoom), f.scale,
                       f.offX, f.offY);

        // (Buildings from zoom 14: at 13 they are a few pixels, and costly to draw.)
        if (zoom >= 14) {
            var buildings = layer("buildings");
            f = frame(buildings);
            var shapes = buildings.features.filter(function (feature) {
                return feature.type === 3;
            });
            fillFeatures(ctx, shapes, function () {
                return style.building;
            }, f.scale, f.offX, f.offY);
            if (zoom >= 15) {
                strokeFeatures(ctx, shapes, style.buildingEdge, 0.6, f.scale, f.offX, f.offY);
            }
        }

        var bounds = layer("boundaries");
        f = frame(bounds);
        ["region", "country"].forEach(function (kind) {
            strokeFeatures(ctx, bounds.features.filter(function (feature) {
                return feature.props.kind === kind;
            }), style[kind], width(WIDTHS[kind], zoom), f.scale, f.offX, f.offY,
                           kind === "country" ? [5, 3] : [3, 3]);
        });

        var roads = layer("roads");
        f = frame(roads);
        var lines = roads.features.filter(function (feature) {
            return feature.type === 2;
        }).sort(bySortRank);
        var classes = ["path", "other", "minor_road", "medium_road", "major_road", "highway"];
        function ofClass(list, name) {
            return list.filter(function (feature) {
                return roadClass(feature.props) === name;
            });
        }
        // (Tunnels and bridges as passes of their own only from zoom 12: below,
        // tunnels are left out and bridges drawn with the other roads.)
        var layered = zoom >= 12;
        var tunnels = layered ? lines.filter(function (feature) {
            return feature.props.is_tunnel === true;
        }) : [];
        var bridges = layered ? lines.filter(function (feature) {
            return feature.props.is_bridge === true && feature.props.is_tunnel !== true;
        }) : [];
        var ground = lines.filter(function (feature) {
            return feature.props.is_tunnel !== true &&
                (!layered || feature.props.is_bridge !== true);
        });
        classes.forEach(function (name) {
            strokeFeatures(ctx, ofClass(tunnels, name), style.tunnel,
                           width(WIDTHS[name], zoom), f.scale, f.offX, f.offY, [4, 3]);
        });
        [ground, bridges].forEach(function (list) {
            classes.forEach(function (name) {
                var colours = style.roads[name];
                var w = width(WIDTHS[name], zoom);
                if (colours[1] && zoom >= 12 && w > 0) {
                    strokeFeatures(ctx, ofClass(list, name), colours[1], w + Math.max(1, w * 0.3),
                                   f.scale, f.offX, f.offY);
                }
            });
            classes.forEach(function (name) {
                var colours = style.roads[name];
                strokeFeatures(ctx, ofClass(list, name), colours[0], width(WIDTHS[name], zoom),
                               f.scale, f.offX, f.offY, name === "path" ? [2, 2] : null);
            });
        });
        strokeFeatures(ctx, lines.filter(function (feature) {
            return feature.props.kind === "rail";
        }), style.rail, width(WIDTHS.rail, zoom), f.scale, f.offX, f.offY, [6, 3]);
        strokeFeatures(ctx, lines.filter(function (feature) {
            return feature.props.kind === "ferry";
        }), style.ferry, width(WIDTHS.ferry, zoom), f.scale, f.offX, f.offY, [5, 4]);

        // Labels: the names of roads (along their longest straight piece)...
        if (zoom >= 13) {
            lines.forEach(function (feature) {
                var name = feature.props.name;
                var cls = roadClass(feature.props);
                if (typeof name !== "string" || !name || !cls || cls === "path" ||
                        (zoom < 15 && cls !== "major_road" && cls !== "highway")) {
                    return;
                }
                var piece = longestPiece(feature.geom, f.scale, f.offX, f.offY);
                var font = "11px " + FONT;
                var w = textWidth(font, name);
                if (piece && piece.length >= w + 12) {
                    labels.push({x: piece.x, y: piece.y, text: name, font: font,
                                 colour: "road", angle: piece.angle, w: w, h: 11,
                                 prio: cls === "highway" || cls === "major_road" ? 20 : 22,
                                 line: true});
                }
            });
        }
        // ... of waters, and of places.
        var waterFrame = frame(water);
        water.features.forEach(function (feature) {
            var name = feature.props.name;
            if (feature.type !== 1 || typeof name !== "string" || !name || zoom < 8 ||
                    QUIET_WATERS.indexOf(feature.props.kind) >= 0) {
                return;
            }
            var at = feature.geom[0];
            var px = at[0] * waterFrame.scale - waterFrame.offX;
            var py = at[1] * waterFrame.scale - waterFrame.offY;
            if (px < 0 || py < 0 || px >= STREET_TILE || py >= STREET_TILE) {
                return;
            }
            var font = "italic 12px " + FONT;
            labels.push({x: px, y: py, text: name, font: font, colour: "waterText", angle: 0,
                         w: textWidth(font, name), h: 12, prio: 10});
        });
        var places = layer("places");
        f = frame(places);
        places.features.forEach(function (feature) {
            var name = feature.props.name;
            var look = feature.type === 1 && typeof name === "string" && name
                ? placeLabel(feature.props, zoom) : null;
            if (!look) {
                return;
            }
            var at = feature.geom[0];
            var px = at[0] * f.scale - f.offX;
            var py = at[1] * f.scale - f.offY;
            if (px < 0 || py < 0 || px >= STREET_TILE || py >= STREET_TILE) {
                return;
            }
            labels.push({x: px, y: py, text: name, font: look.font, colour: look.colour,
                         angle: 0, w: textWidth(look.font, name),
                         h: parseInt(/(\d+)px/.exec(look.font)[1], 10),
                         prio: look.prio - (Number(feature.props.population_rank) || 0) / 100});
        });
        if (edges && typeof ctx.createLinearGradient === "function") {
            fadeEdges(ctx, edges);
        }
        return {canvas: canvas, labels: labels};
    }

    // The tile made transparent towards its sides in edges (see renderTile).
    function fadeEdges(ctx, edges) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        [[WEST, 0, 0, FEATHER, 0], [NORTH, 0, 0, 0, FEATHER],
         [EAST, STREET_TILE, 0, STREET_TILE - FEATHER, 0],
         [SOUTH, 0, STREET_TILE, 0, STREET_TILE - FEATHER]].forEach(function (side) {
            if (!(edges & side[0])) {
                return;
            }
            var gradient = ctx.createLinearGradient(side[1], side[2], side[3], side[4]);
            gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
            gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
            ctx.fillStyle = gradient;
            ctx.fillRect(Math.min(side[1], side[3]), Math.min(side[2], side[4]),
                         side[3] !== side[1] ? FEATHER : STREET_TILE,
                         side[4] !== side[2] ? FEATHER : STREET_TILE);
        });
        ctx.restore();
    }

    /* ---------- Where the street tiles come from ----------------------------- */

    var sources = {};           // url -> Source
    var waiting = {};           // "z/x/y" -> [Source]: tile scripts on their way

    function Source(info) {
        this.url = info.url;
        this.version = typeof info.v === "string" ? info.v : "";
        this.index = null;      // {minzoom, maxzoom, rows: {z: {y: [x0, x1, ...]}}}
        this.state = "new";     // new | loading | ready | failed
        this.tiles = {};        // "z/x/y" -> {state: queued|loading|ready|failed, data, at}
        this.order = [];        // keys of the decoded tiles, oldest first
        this.queue = [];
        this.loading = 0;
        this.listeners = [];
        this.pinned = {};       // "z/x/y" -> how many Picker reads want it kept
    }

    Source.prototype.address = function (name) {
        return this.url + name + (this.version ? "?v=" + encodeURIComponent(this.version) : "");
    };

    Source.prototype.changed = function () {
        this.listeners.forEach(function (listener) {
            listener();
        });
    };

    // Adds a tile or index script to the page (onError: it could not be loaded).
    Source.prototype.load = function (src, onError) {
        if (hasDocument) {
            addScript(src, onError);
        }
    };

    Source.prototype.start = function () {
        var self = this;
        if (this.state !== "new") {
            return;
        }
        this.state = "loading";
        this.load(this.address("index.js"), function () {
            self.state = "failed";
            self.changed();
        });
    };

    Source.prototype.setIndex = function (value) {
        var rows = {};
        var given = value && typeof value === "object" ? value.rows : null;
        Object.keys(given || {}).forEach(function (zoom) {
            var byRow = {};
            (Array.isArray(given[zoom]) ? given[zoom] : []).forEach(function (row) {
                if (Array.isArray(row) && row.length >= 3) {
                    byRow[row[0]] = row.slice(1);
                }
            });
            rows[zoom] = byRow;
        });
        this.index = {minzoom: Number(value && value.minzoom) || 0,
                      maxzoom: Number(value && value.maxzoom) || 0, rows: rows};
        this.state = "ready";
        this.changed();
    };

    // True when the tile is there (the index says so).
    Source.prototype.has = function (z, x, y) {
        var rows = this.index && this.index.rows[z];
        var runs = rows && rows[y];
        if (!runs) {
            return false;
        }
        var low = 0;
        var high = runs.length / 2 - 1;
        while (low <= high) {
            var middle = (low + high) >> 1;
            if (x < runs[2 * middle]) {
                high = middle - 1;
            } else if (x > runs[2 * middle + 1]) {
                low = middle + 1;
            } else {
                return true;
            }
        }
        return false;
    };

    /* The decoded tile, or null while it loads (asked for now, once). wanted:
       the keys a drawing needs, so tiles asked for earlier and no longer in
       sight are not loaded after all. */
    Source.prototype.tile = function (z, x, y) {
        var key = z + "/" + x + "/" + y;
        var entry = this.tiles[key];
        if (entry && entry.state === "ready") {
            return entry.data;
        }
        if (entry && entry.state === "failed" && Date.now() - entry.at < RETRY_MS) {
            return null;
        }
        if (!entry || entry.state === "failed") {
            entry = this.tiles[key] = {state: "queued", data: null, at: 0};
            this.queue.unshift(key);
            this.pump();
        }
        return null;
    };

    // True when the tile's script could not be loaded (it is asked for again later).
    Source.prototype.failedTile = function (z, x, y) {
        var entry = this.tiles[z + "/" + x + "/" + y];
        return Boolean(entry && entry.state === "failed");
    };

    Source.prototype.keepOnly = function (wanted) {
        var self = this;
        this.queue = this.queue.filter(function (key) {
            if (wanted[key] || self.pinned[key]) {
                return true;
            }
            delete self.tiles[key];
            return false;
        });
    };

    Source.prototype.pump = function () {
        var self = this;
        while (this.loading < LOADS_AT_ONCE && this.queue.length) {
            var key = this.queue.shift();
            var entry = this.tiles[key];
            if (!entry || entry.state !== "queued") {
                continue;
            }
            entry.state = "loading";
            this.loading += 1;
            (waiting[key] = waiting[key] || []).push(this);
            this.load(this.address(key + ".js"), (function (name) {
                return function () {
                    self.failed(name);
                };
            })(key));
        }
    };

    Source.prototype.arrived = function (key, data) {
        var entry = this.tiles[key];
        if (!entry || entry.state !== "loading") {
            return;
        }
        this.loading = Math.max(0, this.loading - 1);
        entry.state = data ? "ready" : "failed";
        entry.data = data;
        entry.at = Date.now();
        if (data) {
            this.order.push(key);
            // (The oldest go first, but not those a Picker waits for.)
            for (var k = 0; this.order.length > DECODED_KEPT && k < this.order.length; k++) {
                var old = this.order[k];
                if (!this.pinned[old]) {
                    this.order.splice(k, 1);
                    k -= 1;
                    if (this.tiles[old] && this.tiles[old].state === "ready") {
                        delete this.tiles[old];
                    }
                }
            }
        }
        this.pump();
        this.changed();
    };

    Source.prototype.failed = function (key) {
        var list = waiting[key] || [];
        var at = list.indexOf(this);
        if (at >= 0) {
            list.splice(at, 1);
        }
        this.arrived(key, null);
    };

    function addScript(src, onError) {
        var script = document.createElement("script");
        script.async = true;
        script.src = src;
        script.onload = function () {
            if (script.parentNode) {
                script.parentNode.removeChild(script);
            }
        };
        script.onerror = function () {
            if (script.parentNode) {
                script.parentNode.removeChild(script);
            }
            onError();
        };
        document.head.appendChild(script);
    }

    function sourceFor(info) {
        if (!info || typeof info.url !== "string" || !info.url) {
            return null;
        }
        if (!sources[info.url]) {
            sources[info.url] = new Source(info);
        }
        return sources[info.url];
    }

    // What the tile and index scripts call.
    root.STREETS_DATA = {
        index: function (value) {
            Object.keys(sources).forEach(function (url) {
                if (sources[url].state === "loading") {
                    sources[url].setIndex(value);
                }
            });
        },
        tile: function (z, x, y, text) {
            var key = z + "/" + x + "/" + y;
            var list = waiting[key] || [];
            delete waiting[key];
            if (!list.length) {
                return;
            }
            var data = null;
            try {
                data = typeof text === "string" && text
                    ? decodeTile(inflate(base64Bytes(text))) : null;
            } catch (error) {
                data = null;
            }
            list.forEach(function (source) {
                source.arrived(key, data);
            });
        }
    };

    /* ---------- The world image, in Web Mercator ----------------------------- */

    function defaultCanvas(w, h) {
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        return canvas;
    }

    /* The view's coordinates (CSS pixels, as drawn on ctx) moved to the
       nearest edge of a device pixel: {x(v), y(v)}. The maps draw scaled by
       the screen's pixel ratio (1.25 at 125 %), and a tile whose side falls
       inside a device pixel covers it only in part: two tiles side by side
       there let what is under them show through, a hairline seam. Tiles
       placed with these meet on whole device pixels (at a ratio of 1: whole
       pixels, as Math.round). */
    function pixelEdges(ctx) {
        var m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
        if (!m || m.b || m.c || !(m.a > 0) || !(m.d > 0)) {
            return {x: Math.round, y: Math.round};
        }
        return {
            x: function (v) {
                return (Math.round(v * m.a + m.e) - m.e) / m.a;
            },
            y: function (v) {
                return (Math.round(v * m.d + m.f) - m.f) / m.d;
            }
        };
    }

    function WorldLayer(options) {
        this.options = options || {};
        this.tile = this.options.tileSize || 256;
        this.cache = {};
        this.make = this.options.makeCanvas || (hasDocument ? defaultCanvas : null);
    }

    // The latitudes of the top and bottom of row y of the world image at zoom z.
    function rowLatitudes(z, y) {
        var rows = Math.pow(2, z);
        var north = 90 - y * 180 / rows;
        return {north: north, south: north - 180 / rows};
    }

    /* The tile redrawn into Web Mercator at its own zoom: a canvas as wide
       as the tile and as tall as the rows it covers are there. */
    WorldLayer.prototype.reproject = function (image, z, y) {
        var tile = this.tile;
        var lat = rowLatitudes(z, y);
        var world = tile * Math.pow(2, z + 1);
        var top = mercatorY(lat.north) * world;
        var height = Math.max(1, Math.round(mercatorY(lat.south) * world - top));
        var canvas = this.make(tile, height);
        var ctx = canvas.getContext("2d");
        var step = (lat.north - lat.south) / tile;
        for (var row = 0; row < tile; row++) {
            var a = lat.north - row * step;
            var b = a - step;
            if (b >= MAX_LAT || a <= -MAX_LAT) {
                continue;
            }
            var y0 = Math.floor(mercatorY(a) * world - top);
            var y1 = Math.ceil(mercatorY(b) * world - top);
            ctx.drawImage(image, 0, row, tile, 1, 0, y0, tile, Math.max(1, y1 - y0));
        }
        return canvas;
    };

    WorldLayer.prototype.get = function (z, x, y) {
        var key = z + "/" + x + "/" + y;
        if (this.cache[key]) {
            return this.cache[key];
        }
        var url = this.options.tileUrl ? this.options.tileUrl(z, x, y) : null;
        if (!url || typeof Image === "undefined") {
            return null;
        }
        var self = this;
        var onLoad = this.options.onLoad;
        var img = new Image();
        var entry = {img: img, merc: null, loaded: false, failed: false};
        this.cache[key] = entry;
        img.onload = function () {
            entry.merc = self.make ? self.reproject(img, z, y) : img;
            entry.img = null;
            entry.loaded = true;
            if (onLoad) {
                onLoad();
            }
        };
        img.onerror = function () {
            entry.failed = true;
        };
        img.src = url;
        return entry;
    };

    // Part of a coarser tile already there, in place of one that is not.
    WorldLayer.prototype.fromParent = function (ctx, z, x, y, dx, dy, dw, dh) {
        var own = rowLatitudes(z, y);
        for (var up = 1; up <= z; up++) {
            var n = Math.pow(2, up);
            var py = Math.floor(y / n);
            var entry = this.cache[(z - up) + "/" + Math.floor(x / n) + "/" + py];
            if (entry && entry.loaded) {
                var lat = rowLatitudes(z - up, py);
                var top = mercatorY(lat.north);
                var span = mercatorY(lat.south) - top;
                var h = entry.merc.height;
                var sy0 = (mercatorY(own.north) - top) / span * h;
                var sy1 = (mercatorY(own.south) - top) / span * h;
                var part = this.tile / n;
                if (sy1 - sy0 > 0) {
                    ctx.drawImage(entry.merc, (x % n) * part, sy0, part, sy1 - sy0,
                                  dx, dy, dw, dh);
                }
                return true;
            }
        }
        return false;
    };

    /* Draws the view (world pixel (left, top) at the top left, w x h) at
       zoom (fractional too); returns how many levels the tiles are
       stretched past their detail (fainter the further). */
    WorldLayer.prototype.draw = function (ctx, zoom, left, top, w, h) {
        var tz = Math.max(0, Math.min(Math.floor(zoom + 1e-9), this.options.tileZoom || 0));
        var world = this.tile * Math.pow(2, zoom + 1);
        var cols = Math.pow(2, tz + 1);
        var rows = Math.pow(2, tz);
        var colW = world / cols;
        var stretch = zoom - tz;
        var snap = pixelEdges(ctx);
        ctx.globalAlpha = stretch <= 1 ? 1 : Math.max(0.35, 1 - 0.2 * (stretch - 1));
        var x0 = Math.floor(left / colW);
        var x1 = Math.ceil((left + w) / colW) - 1;
        var latTop = latitudeAt(Math.max(0, Math.min(1, top / world)));
        var latBottom = latitudeAt(Math.max(0, Math.min(1, (top + h) / world)));
        var y0 = Math.max(0, Math.floor((90 - latTop) / (180 / rows)));
        var y1 = Math.min(rows - 1, Math.floor((90 - latBottom) / (180 / rows)));
        for (var ty = y0; ty <= y1; ty++) {
            var lat = rowLatitudes(tz, ty);
            var dy = snap.y(mercatorY(lat.north) * world - top);
            var dh = snap.y(mercatorY(lat.south) * world - top) - dy;
            if (dh <= 0) {
                continue;
            }
            for (var tx = x0; tx <= x1; tx++) {
                // The world repeats sideways: column tx is column tx mod cols.
                var x = mod(tx, cols);
                var dx = snap.x(tx * colW - left);
                var dw = snap.x((tx + 1) * colW - left) - dx;
                var entry = this.get(tz, x, ty);
                if (entry && entry.loaded) {
                    ctx.drawImage(entry.merc, dx, dy, dw, dh);
                } else if (!this.fromParent(ctx, tz, x, ty, dx, dy, dw, dh)) {
                    ctx.fillStyle = this.options.ocean || "#1a2c3d";
                    ctx.fillRect(dx, dy, dw, dh);
                }
            }
        }
        ctx.globalAlpha = 1;
        // Keep the cache bounded in long sessions (oldest first; the coarse
        // levels stay, they stand in for missing tiles).
        var keys = Object.keys(this.cache);
        if (keys.length > 300) {
            for (var k = 0; k < keys.length - 200; k++) {
                if (Number(keys[k].split("/")[0]) > 2) {
                    delete this.cache[keys[k]];
                }
            }
        }
        return stretch;
    };

    /* ---------- The street maps -------------------------------------------- */

    var watchers = [];

    function watchTheme(callback) {
        watchers.push(callback);
        if (watchers.length > 1 || !hasDocument) {
            return;
        }
        function tell() {
            watchers.forEach(function (fn) {
                fn();
            });
        }
        if (typeof MutationObserver === "function") {
            new MutationObserver(tell).observe(document.documentElement,
                                               {attributes: true,
                                                attributeFilter: ["data-theme"]});
        }
        if (root.matchMedia) {
            var query = root.matchMedia("(prefers-color-scheme: dark)");
            if (query.addEventListener) {
                query.addEventListener("change", tell);
            } else if (query.addListener) {
                query.addListener(tell);
            }
        }
    }

    function StreetLayer(options) {
        var self = this;
        this.options = options || {};
        this.source = sourceFor(this.options.streets);
        this.make = this.options.makeCanvas || (hasDocument ? defaultCanvas : null);
        this.rendered = {};     // "zoom/x/y/theme/ratio" -> {canvas, labels}
        this.order = [];
        this.pending = false;
        if (this.make && !measureCtx) {
            try {
                measureCtx = this.make(8, 8).getContext("2d");
            } catch (error) {
                measureCtx = null;
            }
        }
        if (this.source) {
            this.source.listeners.push(function () {
                self.changed();
            });
            this.source.start();
        }
        watchTheme(function () {
            self.changed();
        });
    }

    StreetLayer.prototype.changed = function () {
        if (this.options.onLoad) {
            this.options.onLoad();
        }
    };

    // Whether there may be street maps here at all (once the index is in).
    StreetLayer.prototype.available = function () {
        return Boolean(this.source) && this.source.state !== "failed";
    };

    StreetLayer.prototype.keep = function (key, entry, visible) {
        this.rendered[key] = entry;
        this.order.push(key);
        // (Each is up to 4 MB: about two screens' worth are kept.)
        var limit = Math.max(16, visible * 2);
        while (this.order.length > limit) {
            delete this.rendered[this.order.shift()];
        }
    };

    /* Draws the street tiles of the view (as WorldLayer.draw; the view's
       zoom may be fractional: the tiles of the nearest whole zoom are drawn
       a little larger or smaller; avoid: rectangles no name goes under);
       returns {drawn, missing, tiles}. */
    StreetLayer.prototype.draw = function (ctx, zoom, left, top, w, h, avoid) {
        var result = {drawn: 0, missing: 0, tiles: 0};
        var source = this.source;
        if (!source || !this.make || Math.round(zoom) < FROM_ZOOM) {
            return result;
        }
        if (source.state !== "ready") {
            source.start();
            result.missing = 1;
            result.tiles = 1;
            return result;
        }
        var index = source.index;
        var d = Math.max(0, Math.min(Math.round(zoom), index.maxzoom + OVERZOOM));
        var size = STREET_TILE * Math.pow(2, zoom - d);
        var n = Math.pow(2, d);
        var x0 = Math.floor(left / size);
        var x1 = Math.ceil((left + w) / size) - 1;
        var y0 = Math.max(0, Math.floor(top / size));
        var y1 = Math.min(n - 1, Math.ceil((top + h) / size) - 1);
        var ratio = Math.min(2, (root.devicePixelRatio || 1));
        var themeName = theme();
        var started = null;
        var wanted = {};
        var shown = [];
        var visible = (x1 - x0 + 1) * (y1 - y0 + 1);
        var snap = pixelEdges(ctx);
        for (var ty = y0; ty <= y1; ty++) {
            for (var tx = x0; tx <= x1; tx++) {
                var x = mod(tx, n);
                var dx = snap.x(tx * size - left);
                var dy = snap.y(ty * size - top);
                var dw = snap.x((tx + 1) * size - left) - dx;
                var dh = snap.y((ty + 1) * size - top) - dy;
                result.tiles += 1;
                // The most detailed tile there is for this place: at most
                // FILL_LEVELS zooms coarser, and not below FROM_ZOOM (else the
                // world image shows, and the place counts as missing).
                var s = Math.min(d, index.maxzoom);
                var lowest = Math.max(index.minzoom, d - FILL_LEVELS, FROM_ZOOM);
                while (s >= lowest && !source.has(s, x >> (d - s), ty >> (d - s))) {
                    s -= 1;
                }
                if (s < lowest) {
                    result.missing += 1;
                    continue;
                }
                var key = d + "/" + x + "/" + ty + "/" + themeName + "/" + ratio;
                var entry = this.rendered[key];
                var failed = false;
                if (!entry) {
                    var sx = x >> (d - s);
                    var sy = ty >> (d - s);
                    wanted[s + "/" + sx + "/" + sy] = true;
                    var data = source.tile(s, sx, sy);
                    failed = !data && source.failedTile(s, sx, sy);
                    // (Within the frame's time, but always one.)
                    if (data && (started === null || now() - started < FRAME_BUDGET)) {
                        if (started === null) {
                            started = now();
                        }
                        entry = renderTile(this.make, data, d, x, ty, s, ratio, themeName,
                                           this.edges(d, x, ty));
                        this.keep(key, entry, visible);
                    } else if (data) {
                        this.later();
                    }
                }
                if (entry) {
                    ctx.drawImage(entry.canvas, dx, dy, dw, dh);
                    result.drawn += 1;
                    shown.push({entry: entry, dx: dx, dy: dy, scale: dw / STREET_TILE});
                } else if (failed) {
                    // (Its script could not be loaded: the world image shows.)
                    result.missing += 1;
                } else {
                    // On its way: the land's colour (not the world image, which
                    // would flash), and what stands in for it over that.
                    ctx.fillStyle = (THEMES[themeName] || THEMES.light).earth;
                    ctx.fillRect(dx, dy, dw, dh);
                    if (this.standIn(ctx, d, x, ty, themeName, ratio, dx, dy, dw, dh)) {
                        result.drawn += 1;
                    }
                }
            }
        }
        source.keepOnly(wanted);
        if (this.options.labels !== false) {
            drawLabels(ctx, shown, w, h, THEMES[themeName] || THEMES.light, avoid);
        }
        return result;
    };

    /* While this tile is on its way: part of a coarser tile already drawn
       (larger), and over it the finer tiles already drawn (smaller: just
       zoomed out), one or two zooms down; true when anything was drawn. */
    StreetLayer.prototype.standIn = function (ctx, d, x, y, themeName, ratio, dx, dy, dw, dh) {
        var drew = false;
        var tail = "/" + themeName + "/" + ratio;
        for (var up = 1; up <= Math.min(d, STAND_IN); up++) {
            var n = Math.pow(2, up);
            var entry = this.rendered[(d - up) + "/" + Math.floor(x / n) + "/" +
                                      Math.floor(y / n) + tail];
            if (entry) {
                var part = entry.canvas.width / n;
                ctx.drawImage(entry.canvas, (x % n) * part, (y % n) * part, part, part,
                              dx, dy, dw, dh);
                drew = true;
                break;
            }
        }
        var snap = pixelEdges(ctx);
        for (var down = 1; down <= 2; down++) {
            var m = Math.pow(2, down);
            var found = false;
            for (var j = 0; j < m; j++) {
                for (var i = 0; i < m; i++) {
                    var child = this.rendered[(d + down) + "/" + (x * m + i) + "/" +
                                              (y * m + j) + tail];
                    if (child) {
                        var cx = snap.x(dx + i * dw / m);
                        var cy = snap.y(dy + j * dh / m);
                        ctx.drawImage(child.canvas, cx, cy,
                                      snap.x(dx + (i + 1) * dw / m) - cx,
                                      snap.y(dy + (j + 1) * dh / m) - cy);
                        found = true;
                    }
                }
            }
            if (found) {
                drew = true;
                break;
            }
        }
        return drew;
    };

    // The zoom of the tile drawn at (d, x, y) of the view (FILL_LEVELS and
    // FROM_ZOOM as in draw), or -1: none (the world image shows there).
    StreetLayer.prototype.sourceZoom = function (d, x, y) {
        var source = this.source;
        var index = source.index;
        var n = Math.pow(2, d);
        if (y < 0 || y >= n) {
            return -1;
        }
        x = mod(x, n);
        var lowest = Math.max(index.minzoom, d - FILL_LEVELS, FROM_ZOOM);
        for (var s = Math.min(d, index.maxzoom); s >= lowest; s--) {
            if (source.has(s, x >> (d - s), y >> (d - s))) {
                return s;
            }
        }
        return -1;
    };

    // The sides of the tile (d, x, y) with no street map next to them (renderTile).
    StreetLayer.prototype.edges = function (d, x, y) {
        var edges = 0;
        if (this.sourceZoom(d, x - 1, y) < 0) {
            edges |= WEST;
        }
        if (this.sourceZoom(d, x, y - 1) < 0) {
            edges |= NORTH;
        }
        if (this.sourceZoom(d, x + 1, y) < 0) {
            edges |= EAST;
        }
        if (this.sourceZoom(d, x, y + 1) < 0) {
            edges |= SOUTH;
        }
        return edges;
    };

    StreetLayer.prototype.later = function () {
        var self = this;
        if (this.pending || typeof root.requestAnimationFrame !== "function") {
            return;
        }
        this.pending = true;
        root.requestAnimationFrame(function () {
            self.pending = false;
            self.changed();
        });
    };

    /* The labels of the tiles drawn, most important first, each only where
       it is wholly in sight and overlaps none placed before, nor the
       rectangles of avoid (the map's buttons and credit: [[x0, y0, x1,
       y1]]), and a road's name not again near the same name. */
    function drawLabels(ctx, shown, w, h, style, avoid) {
        var list = [];
        shown.forEach(function (item) {
            item.entry.labels.forEach(function (label, number) {
                list.push({label: label, x: item.dx + label.x * item.scale,
                           y: item.dy + label.y * item.scale, order: number});
            });
        });
        if (!list.length) {
            return;
        }
        list.sort(function (a, b) {
            return a.label.prio - b.label.prio || a.y - b.y || a.x - b.x;
        });
        var boxes = (avoid || []).filter(function (box) {
            return box && box.length === 4 && box[2] > box[0] && box[3] > box[1];
        });
        var roadNames = [];
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        list.forEach(function (item) {
            var label = item.label;
            var halfW = label.w / 2 + 3;
            var halfH = label.h / 2 + 3;
            if (label.angle) {
                var cos = Math.abs(Math.cos(label.angle));
                var sin = Math.abs(Math.sin(label.angle));
                var bw = halfW * cos + halfH * sin;
                var bh = halfW * sin + halfH * cos;
                halfW = bw;
                halfH = bh;
            }
            var box = [item.x - halfW, item.y - halfH, item.x + halfW, item.y + halfH];
            // (Only names wholly in sight: none cut by the edge of the map.)
            if (box[0] < -2 || box[1] < -2 || box[2] > w + 2 || box[3] > h + 2) {
                return;
            }
            for (var k = 0; k < boxes.length; k++) {
                var other = boxes[k];
                if (box[0] < other[2] && box[2] > other[0] && box[1] < other[3] &&
                        box[3] > other[1]) {
                    return;
                }
            }
            if (label.line) {
                for (var r = 0; r < roadNames.length; r++) {
                    var near = roadNames[r];
                    if (near.text === label.text && Math.abs(near.x - item.x) < 200 &&
                            Math.abs(near.y - item.y) < 200) {
                        return;
                    }
                }
                roadNames.push({text: label.text, x: item.x, y: item.y});
            }
            boxes.push(box);
            ctx.save();
            ctx.translate(item.x, item.y);
            if (label.angle) {
                ctx.rotate(label.angle);
            }
            ctx.font = label.font;
            ctx.lineWidth = 3;
            ctx.strokeStyle = style.halo;
            ctx.strokeText(label.text, 0, 0);
            ctx.fillStyle = style[label.colour] || style.text;
            ctx.fillText(label.text, 0, 0);
            ctx.restore();
        });
        ctx.restore();
    }

    /* ---------- Streets and places by name (an area of the map) ------------- */

    /* A Picker finds the named streets and places of the street maps for
       the map page's "Street or place" (map.js: a search limited to an area,
       see search-core.js "Areas on the map"), from the tiles of the street
       maps alone (nothing is asked of another host), at the most detailed
       zoom there is at the place:

         streets  named roads and paths (the roads layer)
         areas    outlined areas (the landuse layer: a park, a zoo, a
                  campus) named by the point of interest with the same id
                  (as named_places.py names them), looked for in the tiles
                  around and the coarser tiles at the place down to
                  LABEL_ZOOM
         places   named points of interest (the pois layer)

       at(lat, lon, metres, callback) lists those at a place: callback([{kind
       ("street", "area" or "place"), name, what (its kind in words: "park",
       "museum", "street"), metres (how far; 0 inside an area), key}]),
       nearest first, areas smallest first. inView(box, zoom, callback) lists
       those of the tiles of a view (box {south, west, north, east}; for
       the keyboard's list), each once (a street by its name, an area by its
       id, a place by its name and point), by name (of one name, the street
       first; numbers in names by their value; two of one name and kind told
       apart by where they are in the view: near "north-west"), or
       callback(null, why): "wait" before the street maps' index is in
       (whenReady), "large" for a view of more than GATHER_TILES tiles.
       whenReady(callback) calls callback(true) once the index is in (at
       once when it is), callback(false) when it cannot be read. gather(item,
       callback) then reads all of it: a street's parts (the roads of that
       name joined to the one picked, within JOIN_METRES of one another), an
       area's outline (its parts in each tile, cut at the tile's edges, then
       joined again into one outline: dissolve), a place's point -- from the
       tile it was found in and on through the tiles it goes on into, at most
       GATHER_TILES of them: callback({kind, name, what, parts: [[lat, lon,
       lat, lon, ...]], cut (true when it went on further)}) or null. Tiles
       not loaded yet are asked for (and kept until the Picker is done with
       them). */
    var GATHER_TILES = 36;
    var JOIN_METRES = 30;
    var LABEL_ZOOM = 10;
    var PICK_WAIT_MS = 20000;
    // The road kinds that are streets (railways and ferries are not offered).
    var STREET_KINDS = ["highway", "major_road", "medium_road", "minor_road", "other", "path"];
    // How far a named place of the street maps names the pictures taken around
    // it, by its kind (metres: named_places.py KINDS and SHOWN_SHOPS, which a test
    // keeps the same), and the accuracy named_places.py gives a position taken
    // indoors (see placeWithin).
    var PLACE_REACH = {
        aerodrome: 300, airport: 300, alpine_hut: 60, amusement_arcade: 40, antiques: 15,
        aquarium: 150, archaeological_site: 150, art: 15, arts_centre: 60, attraction: 150,
        bakery: 25, bar: 30, bare_rock: 100, beach: 200, biergarten: 40, books: 15, brewery: 80,
        bridge: 100, bus_station: 60, cafe: 30, camp_site: 150, cape: 150, caravan_site: 100,
        casino: 120, castle: 150, cave_entrance: 100, cemetery: 100, cheese: 15, chocolate: 15,
        cinema: 50, college: 150, commercial: 60, confectionery: 15, conference_centre: 100,
        deli: 15, department_store: 40, dog_park: 60, events_venue: 80, exhibition_centre: 120,
        fast_food: 25, ferry_terminal: 100, food_court: 50, forest: 200, fort: 150, fountain: 60,
        gallery: 50, garden: 100, geyser: 100, gift: 15, glacier: 1000, golf_course: 200,
        grass: 40, heath: 150, hospital: 80, hostel: 40, hot_spring: 100, hotel: 60,
        ice_cream: 25, ice_rink: 60, library: 50, lighthouse: 150, mall: 120, marina: 100,
        marketplace: 40, meadow: 100, memorial: 60, monument: 100, motel: 50, museum: 100,
        national_park: 1000, nature_reserve: 200, nightclub: 30, observatory: 100, park: 150,
        peak: 300, pedestrian: 60, picnic_site: 60, pier: 100, pitch: 60, place_of_worship: 80,
        planetarium: 80, playground: 40, protected_area: 200, pub: 30, railway: 100,
        recreation_ground: 100, resort: 150, restaurant: 30, ruins: 100, sand: 150, school: 60,
        scrub: 100, ski: 300, sports_centre: 80, stadium: 200, station: 150, theatre: 50,
        theme_park: 250, tower: 80, townhall: 80, university: 200, viewpoint: 150,
        village_green: 80, volcano: 1000, water_park: 100, waterfall: 150, wetland: 150,
        wine: 15, wine_bar: 30, winery: 150, winter_sports: 300, wood: 150, zoo: 200,
        // (SHOWN_SHOPS: shops named only for a picture that shows one)
        bed: 20, car: 30, clothes: 15, cosmetics: 15, doityourself: 30, electronics: 20,
        florist: 15, furniture: 25, hardware: 20, jewelry: 15, mobile_phone: 15, music: 15,
        outdoor: 20, shoes: 15, sports: 20, supermarket: 30, toys: 15, variety_store: 20,
        wholesale: 40
    };
    var PLACE_INDOOR_M = 65;
    // How a road's kind and kind_detail read (else "street").
    var ROAD_WORDS = {highway: "road", major_road: "road", path: "path", rail: "railway",
                      ferry: "ferry"};

    function Picker(streets) {
        this.source = sourceFor(streets);
    }

    Picker.prototype.ready = function () {
        return Boolean(this.source) && this.source.state === "ready";
    };

    // callback(true) once the street maps' index is in, callback(false) if it cannot be.
    Picker.prototype.whenReady = function (callback) {
        var source = this.source;
        if (!source || source.state === "failed") {
            callback(false);
            return;
        }
        if (source.state === "ready") {
            callback(true);
            return;
        }
        function check() {
            if (source.state === "ready" || source.state === "failed") {
                var at = source.listeners.indexOf(check);
                if (at >= 0) {
                    source.listeners.splice(at, 1);
                }
                callback(source.state === "ready");
            }
        }
        source.listeners.push(check);
        source.start();
    };

    // The most detailed zoom of a street tile at a place (FROM_ZOOM or more), or -1.
    Picker.prototype.zoomAt = function (lat, lon) {
        var source = this.source;
        if (!this.ready() || !isFinite(lat) || !isFinite(lon)) {
            return -1;
        }
        var t = mercatorY(lat);
        for (var z = source.index.maxzoom; z >= Math.max(FROM_ZOOM, source.index.minzoom); z--) {
            var n = Math.pow(2, z);
            if (source.has(z, mod(Math.floor((lon + 180) / 360 * n), n),
                           Math.max(0, Math.min(n - 1, Math.floor(t * n))))) {
                return z;
            }
        }
        return -1;
    };

    // The decoded tile of a key ("z/x/y") when it is in, else null.
    Picker.prototype.data = function (key) {
        var entry = this.source ? this.source.tiles[key] : null;
        return entry && entry.state === "ready" ? entry.data : null;
    };

    /* Asks for the tiles keys ("z/x/y", only those the index has) and calls
       callback() once each is in or could not be loaded (or after
       PICK_WAIT_MS). They are kept while waiting (Source.pinned). */
    Picker.prototype.read = function (keys, callback) {
        var source = this.source;
        var wanted = keys.filter(function (key) {
            var p = key.split("/").map(Number);
            return source.has(p[0], p[1], p[2]);
        });
        var waiting = true;
        var timer = 0;
        function busy(key) {
            var entry = source.tiles[key];
            return Boolean(entry && (entry.state === "queued" || entry.state === "loading"));
        }
        function check() {
            if (waiting && !wanted.some(busy)) {
                finish();
            }
        }
        function finish() {
            waiting = false;
            var at = source.listeners.indexOf(check);
            if (at >= 0) {
                source.listeners.splice(at, 1);
            }
            wanted.forEach(function (key) {
                source.pinned[key] = Math.max(0, (source.pinned[key] || 1) - 1);
                if (!source.pinned[key]) {
                    delete source.pinned[key];
                }
            });
            if (timer) {
                clearTimeout(timer);
            }
            callback();
        }
        wanted.forEach(function (key) {
            var p = key.split("/").map(Number);
            source.pinned[key] = (source.pinned[key] || 0) + 1;
            source.tile(p[0], p[1], p[2]);
        });
        if (!wanted.some(busy)) {
            finish();
            return;
        }
        source.listeners.push(check);
        timer = setTimeout(finish, PICK_WAIT_MS);
    };

    // World units (0 to 1 round the world, Web Mercator) of a point of a tile.
    function tileWorld(z, x, y, extent, px, py) {
        var n = Math.pow(2, z);
        return [(x + px / extent) / n, (y + py / extent) / n];
    }

    function worldLatLon(wx, wy) {
        return [latitudeAt(wy), wx * 360 - 180];
    }

    // Metres per world unit at world y.
    function worldMetres(wy) {
        return 40075016.686 * Math.cos(latitudeAt(wy) * Math.PI / 180);
    }

    function keyOf(z, x, y) {
        return z + "/" + x + "/" + y;
    }

    function displayName(props) {
        var name = typeof props.name === "string" ? props.name.replace(/^\s+|\s+$/g, "") : "";
        return name;
    }

    function words(kind) {
        return String(kind || "").replace(/_/g, " ");
    }

    /* The circle (metres around it) that holds most of the pictures a point of
       interest of this kind (its props.kind) names on the viewer's Place line:
       its reach and half the accuracy of a position taken indoors, as
       named_places.py allows (rounded up to 5 m) -- a picture taken in its
       building further from its point, or named by the other pictures of its
       visit, may be outside it; null for a kind it does not name. */
    function placeWithin(kind) {
        if (!Object.prototype.hasOwnProperty.call(PLACE_REACH, kind)) {
            return null;
        }
        var reach = PLACE_REACH[kind];
        return Math.ceil((reach + Math.min(PLACE_INDOOR_M, reach) / 2) / 5) * 5;
    }

    function roadWhat(props) {
        return ROAD_WORDS[props.kind] || (props.kind_detail === "pedestrian" ? "path" : "street");
    }

    function streetFamily(kind) {
        return STREET_KINDS.indexOf(kind) >= 0 ? "street" : String(kind || "");
    }

    // Distance (squared, tile units) from (px, py) to a line's segments.
    function lineDistance2(geom, px, py) {
        var best = Infinity;
        geom.forEach(function (part) {
            if (part.length === 2) {
                best = Math.min(best, (part[0] - px) * (part[0] - px) +
                                (part[1] - py) * (part[1] - py));
            }
            for (var k = 2; k < part.length; k += 2) {
                var ax = part[k - 2];
                var ay = part[k - 1];
                var dx = part[k] - ax;
                var dy = part[k + 1] - ay;
                var length = dx * dx + dy * dy;
                var t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) /
                                                       length)) : 0;
                var ex = ax + t * dx - px;
                var ey = ay + t * dy - py;
                best = Math.min(best, ex * ex + ey * ey);
            }
        });
        return best;
    }

    // Twice the signed area of a ring (tile units; > 0: an outer ring, as MVT has it).
    function ringArea(ring) {
        var sum = 0;
        for (var k = 0, j = ring.length - 2; k < ring.length; j = k, k += 2) {
            sum += ring[j] * ring[k + 1] - ring[k] * ring[j + 1];
        }
        return sum;
    }

    function inside(ring, px, py) {
        var found = false;
        for (var k = 0, j = ring.length - 2; k < ring.length; j = k, k += 2) {
            if ((ring[k + 1] > py) !== (ring[j + 1] > py) &&
                    px < (ring[j] - ring[k]) * (py - ring[k + 1]) / (ring[j + 1] - ring[k + 1]) +
                    ring[k]) {
                found = !found;
            }
        }
        return found;
    }

    // The outer rings of a polygon feature that hold (px, py): their area (tile units), or 0.
    function areaAround(feature, px, py) {
        var best = 0;
        feature.geom.forEach(function (ring) {
            var size = ringArea(ring);
            if (size > 0 && inside(ring, px, py)) {
                best = best ? Math.min(best, size) : size;
            }
        });
        return best / 2;
    }

    /* The names of areas: {id: the name of the point of interest with that id}
       of the decoded tiles (those of keys first, then every other one in: the
       ones at the place down to LABEL_ZOOM among them). */
    Picker.prototype.areaNames = function (keys) {
        var source = this.source;
        var names = Object.create(null);
        var all = (keys || []).slice();
        Object.keys(source.tiles).forEach(function (key) {
            if (source.tiles[key].state === "ready" && all.indexOf(key) < 0) {
                all.push(key);
            }
        });
        for (var k = 0; k < all.length; k++) {
            var data = this.data(all[k]);
            var pois = data && data.pois ? data.pois.features : [];
            for (var f = 0; f < pois.length; f++) {
                var id = pois[f].id;
                if (id !== undefined && names[id] === undefined && displayName(pois[f].props)) {
                    names[id] = displayName(pois[f].props);
                }
            }
        }
        return names;
    };

    /* The streets, areas and places at a place (see Picker): within metres
       of it (a street or a place; an area holds it). */
    Picker.prototype.at = function (lat, lon, metres, callback) {
        var self = this;
        var z = this.zoomAt(lat, lon);
        if (z < 0) {
            callback([]);
            return;
        }
        var n = Math.pow(2, z);
        var fx = mod((lon + 180) / 360 * n, n);
        var fy = mercatorY(lat) * n;
        var x = Math.floor(fx);
        var y = Math.max(0, Math.min(n - 1, Math.floor(fy)));
        var key = keyOf(z, x, y);
        // (The tile, and the coarser ones at the place: the names of areas.)
        var keys = [key];
        for (var up = z - 1; up >= Math.max(LABEL_ZOOM, this.source.index.minzoom); up--) {
            keys.push(keyOf(up, x >> (z - up), y >> (z - up)));
        }
        this.read(keys, function () {
            var data = self.data(key);
            if (!data) {
                callback([]);
                return;
            }
            var found = [];
            var seen = {};
            var extent = (data.roads || data.landuse || data.pois || {extent: 4096}).extent ||
                4096;
            var px = (fx - x) * extent;
            var py = (fy - y) * extent;
            var perUnit = worldMetres(fy / n) / n / extent;     // metres per tile unit
            var reach = metres / perUnit;
            var names = null;           // (the names of areas, once one holds the place)
            (data.roads ? data.roads.features : []).forEach(function (feature) {
                var name = displayName(feature.props);
                if (!name || feature.type !== 2 || STREET_KINDS.indexOf(feature.props.kind) < 0) {
                    return;
                }
                var d = Math.sqrt(lineDistance2(feature.geom, px, py));
                var id = "street:" + streetFamily(feature.props.kind) + ":" + name;
                if (d <= reach && (!seen[id] || seen[id].metres > d * perUnit)) {
                    if (seen[id]) {
                        found.splice(found.indexOf(seen[id]), 1);
                    }
                    seen[id] = {kind: "street", name: name, what: roadWhat(feature.props),
                                metres: Math.round(d * perUnit), key: key,
                                family: streetFamily(feature.props.kind), at: [px, py]};
                    found.push(seen[id]);
                }
            });
            (data.landuse ? data.landuse.features : []).forEach(function (feature) {
                if (feature.type !== 3) {
                    return;
                }
                var size = areaAround(feature, px, py);
                if (size && !names) {
                    names = self.areaNames(keys);
                }
                var name = size && feature.id !== undefined ? names[feature.id] || "" : "";
                var id = "area:" + feature.id;
                if (name && !seen[id]) {
                    seen[id] = {kind: "area", name: name, what: words(feature.props.kind),
                                metres: 0, key: key, id: feature.id, size: size};
                    found.push(seen[id]);
                }
            });
            (data.pois ? data.pois.features : []).forEach(function (feature) {
                var name = displayName(feature.props);
                var point = feature.geom[0];
                if (!name || feature.type !== 1 || !point || seen["area:" + feature.id]) {
                    return;
                }
                var d = Math.sqrt((point[0] - px) * (point[0] - px) +
                                  (point[1] - py) * (point[1] - py));
                var id = "place:" + name + ":" + point[0] + ":" + point[1];
                if (d <= reach && !seen[id]) {
                    seen[id] = {kind: "place", name: name, what: words(feature.props.kind),
                                metres: Math.round(d * perUnit), key: key,
                                point: worldLatLon.apply(null, tileWorld(z, x, y, extent,
                                                                         point[0], point[1]))};
                    found.push(seen[id]);
                }
            });
            var order = {place: 0, street: 1, area: 2};
            found.sort(function (a, b) {
                return a.kind === "area" && b.kind === "area" ? a.size - b.size
                    : a.kind === "area" || b.kind === "area" ? order[a.kind] - order[b.kind]
                        : a.metres - b.metres || order[a.kind] - order[b.kind];
            });
            callback(found);
        });
    };

    /* The streets, areas and places named in the tiles of a view (box
       {south, west, north, east} in degrees; the tiles of zoom, or the most
       detailed there are below it; at most GATHER_TILES of them, else []
       and the view is too large): [{kind, name, what, key, ...}], each name
       of a kind once, by name. */
    Picker.prototype.inView = function (box, zoom, callback) {
        var self = this;
        if (!this.ready()) {
            callback(null, "wait");
            return;
        }
        var index = this.source.index;
        var z = Math.max(FROM_ZOOM, Math.min(index.maxzoom, Math.round(zoom)));
        var n = Math.pow(2, z);
        var x0 = Math.floor((box.west + 180) / 360 * n);
        var x1 = Math.floor((box.east + 180) / 360 * n);
        var y0 = Math.max(0, Math.floor(mercatorY(box.north) * n));
        var y1 = Math.min(n - 1, Math.floor(mercatorY(box.south) * n));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > GATHER_TILES) {
            callback(null, "large");
            return;
        }
        var keys = [];
        for (var ty = y0; ty <= y1; ty++) {
            for (var tx = x0; tx <= x1; tx++) {
                keys.push(keyOf(z, mod(tx, n), ty));
            }
        }
        this.read(keys, function () {
            var found = [];
            var seen = {};
            var names = self.areaNames(keys);
            keys.forEach(function (key) {
                var data = self.data(key);
                if (!data) {
                    return;
                }
                (data.roads ? data.roads.features : []).forEach(function (feature) {
                    var name = displayName(feature.props);
                    var family = streetFamily(feature.props.kind);
                    var id = "street:" + family + ":" + name;
                    var part = feature.geom[0];
                    if (name && feature.type === 2 && part && !seen[id] && family === "street") {
                        seen[id] = true;
                        var p = key.split("/").map(Number);
                        found.push({kind: "street", name: name, what: roadWhat(feature.props),
                                    key: key, family: family, at: [part[0], part[1]],
                                    where: tileWorld(p[0], p[1], p[2],
                                                     data.roads.extent || 4096, part[0],
                                                     part[1])});
                    }
                });
                (data.landuse ? data.landuse.features : []).forEach(function (feature) {
                    var id = "area:" + feature.id;
                    if (feature.type !== 3 || seen[id]) {
                        return;
                    }
                    var name = feature.id !== undefined ? names[feature.id] || "" : "";
                    if (name) {
                        seen[id] = true;
                        var p = key.split("/").map(Number);
                        // (Where it is: the middle of its first ring's box.)
                        var ring = feature.geom[0] || [0, 0];
                        var xs = ring.filter(function (value, index) {
                            return index % 2 === 0;
                        });
                        var ys = ring.filter(function (value, index) {
                            return index % 2 === 1;
                        });
                        var extent = data.landuse.extent || 4096;
                        found.push({kind: "area", name: name, what: words(feature.props.kind),
                                    key: key, id: feature.id,
                                    where: tileWorld(p[0], p[1], p[2], extent,
                                                     (Math.min.apply(null, xs) +
                                                      Math.max.apply(null, xs)) / 2,
                                                     (Math.min.apply(null, ys) +
                                                      Math.max.apply(null, ys)) / 2)});
                    }
                });
                (data.pois ? data.pois.features : []).forEach(function (feature) {
                    var name = displayName(feature.props);
                    var point = feature.geom[0];
                    var p = key.split("/").map(Number);
                    var extent = data.pois.extent || 4096;
                    if (!name || feature.type !== 1 || !point || seen["area:" + feature.id] ||
                            point[0] < 0 || point[1] < 0 || point[0] >= extent ||
                            point[1] >= extent) {
                        return;
                    }
                    // (Once each: two places of one name elsewhere are two, one point
                    // in two tiles is one.)
                    var where = tileWorld(p[0], p[1], p[2], extent, point[0], point[1]);
                    var id = "place:" + name + ":" + Math.round(where[0] * 4e6) + ":" +
                        Math.round(where[1] * 4e6);
                    if (seen[id]) {
                        return;
                    }
                    seen[id] = true;
                    found.push({kind: "place", name: name, what: words(feature.props.kind),
                                type: String(feature.props.kind || ""), key: key,
                                point: worldLatLon.apply(null, where), where: where});
                });
            });
            // (By name, numbers by their value -- "Pier 7" before "Pier 40" --; of one
            // name, a street, then an area, then a place.)
            var order = {street: 0, area: 1, place: 2};
            found.sort(function (a, b) {
                return compareNames(a.name, b.name) || order[a.kind] - order[b.kind];
            });
            placeTwins(found, box);
            callback(found);
        });
    };

    // Names compared as a reader sorts them: case and accents aside, numbers by value.
    function compareNames(a, b) {
        var x = a.toLowerCase();
        var y = b.toLowerCase();
        if (typeof x.localeCompare === "function") {
            try {
                return x.localeCompare(y, undefined, {numeric: true, sensitivity: "base"});
            } catch (error) {
                // (An old browser without the options: plainly, below.)
            }
        }
        return x < y ? -1 : x > y ? 1 : 0;
    }

    // Of a list's entries with one name and kind, each told apart by where it is in
    // the view (box): its "near" ("north-west", "middle"), from its world point.
    function placeTwins(found, box) {
        var counts = {};
        found.forEach(function (item) {
            var id = item.kind + ":" + item.what + ":" + item.name.toLowerCase();
            counts[id] = (counts[id] || 0) + 1;
        });
        var west = (box.west + 180) / 360;
        var east = (box.east + 180) / 360;
        var top = mercatorY(box.north);
        var bottom = mercatorY(box.south);
        found.forEach(function (item) {
            var id = item.kind + ":" + item.what + ":" + item.name.toLowerCase();
            if (counts[id] < 2 || !item.where) {
                return;
            }
            var fx = (item.where[0] - west - Math.round(item.where[0] - (west + east) / 2)) /
                ((east - west) || 1);
            var fy = (item.where[1] - top) / ((bottom - top) || 1);
            var row = fy < 1 / 3 ? "north" : fy > 2 / 3 ? "south" : "";
            var column = fx < 1 / 3 ? "west" : fx > 2 / 3 ? "east" : "";
            item.near = row && column ? row + "-" + column : row || column || "middle";
        });
    }

    /* A line cut to the square [0, extent] of its tile: [[x, y, x, y, ...]] (the
       pieces inside, Liang and Barsky). */
    function clipLine(part, extent) {
        var out = [];
        var current = null;
        if (part.length === 2) {
            return part[0] >= 0 && part[0] <= extent && part[1] >= 0 && part[1] <= extent
                ? [[part[0], part[1]]] : [];
        }
        for (var k = 2; k < part.length; k += 2) {
            var x0 = part[k - 2];
            var y0 = part[k - 1];
            var dx = part[k] - x0;
            var dy = part[k + 1] - y0;
            var low = 0;
            var high = 1;
            var edges = [[-dx, x0], [dx, extent - x0], [-dy, y0], [dy, extent - y0]];
            var empty = false;
            for (var e = 0; e < 4 && !empty; e++) {
                var p = edges[e][0];
                var q = edges[e][1];
                if (p === 0) {
                    empty = q < 0;
                } else if (p < 0) {
                    low = Math.max(low, q / p);
                } else {
                    high = Math.min(high, q / p);
                }
                empty = empty || low > high;
            }
            if (empty) {
                current = null;
                continue;
            }
            var ax = x0 + low * dx;
            var ay = y0 + low * dy;
            if (!current || low > 0) {
                current = [ax, ay];
                out.push(current);
            }
            current.push(x0 + high * dx, y0 + high * dy);
            if (high < 1) {
                current = null;
            }
        }
        return out;
    }

    // A ring cut to the square [0, extent] (Sutherland and Hodgman), or null.
    function clipRing(ring, extent) {
        var points = [];
        for (var k = 0; k < ring.length; k += 2) {
            points.push([ring[k], ring[k + 1]]);
        }
        [[0, 1, 0], [0, -1, extent], [1, 1, 0], [1, -1, extent]].forEach(function (edge) {
            var axis = edge[0];
            var sign = edge[1];
            var at = edge[2];
            var kept = [];
            function keep(point) {
                return sign * (point[axis] - at) >= 0;
            }
            for (var i = 0; i < points.length; i++) {
                var a = points[i];
                var b = points[(i + 1) % points.length];
                if (keep(a)) {
                    kept.push(a);
                }
                if (keep(a) !== keep(b)) {
                    var t = (at - a[axis]) / (b[axis] - a[axis]);
                    var cut = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                    cut[axis] = at;     // (exactly on the edge: see dissolve)
                    kept.push(cut);
                }
            }
            points = kept;
        });
        if (points.length < 3) {
            return null;
        }
        var out = [];
        points.forEach(function (point) {
            out.push(point[0], point[1]);
        });
        return out;
    }

    // The tiles next to (z, x, y) whose side a piece of [x, y, ...] (tile units) touches.
    function sidesTouched(piece, extent, z, x, y) {
        var n = Math.pow(2, z);
        var out = [];
        var slack = extent / 1024;
        var west = false;
        var east = false;
        var north = false;
        var south = false;
        for (var k = 0; k < piece.length; k += 2) {
            west = west || piece[k] <= slack;
            east = east || piece[k] >= extent - slack;
            north = north || piece[k + 1] <= slack;
            south = south || piece[k + 1] >= extent - slack;
        }
        if (west) {
            out.push(keyOf(z, mod(x - 1, n), y));
        }
        if (east) {
            out.push(keyOf(z, mod(x + 1, n), y));
        }
        if (north && y > 0) {
            out.push(keyOf(z, x, y - 1));
        }
        if (south && y < n - 1) {
            out.push(keyOf(z, x, y + 1));
        }
        return out;
    }

    // [x, y, ...] of tile units as world units (the copy of the world nearest ref x).
    function toWorld(piece, z, x, y, extent, refX) {
        var out = [];
        for (var k = 0; k < piece.length; k += 2) {
            var at = tileWorld(z, x, y, extent, piece[k], piece[k + 1]);
            out.push(refX === undefined ? at[0] : at[0] + Math.round(refX - at[0]), at[1]);
        }
        return out;
    }

    // Distance (world units) from a point to a piece's segments.
    function pieceDistance(piece, px, py) {
        var best = Infinity;
        if (piece.length === 2) {
            return Math.sqrt((piece[0] - px) * (piece[0] - px) + (piece[1] - py) * (piece[1] - py));
        }
        for (var k = 2; k < piece.length; k += 2) {
            var ax = piece[k - 2];
            var ay = piece[k - 1];
            var dx = piece[k] - ax;
            var dy = piece[k + 1] - ay;
            var length = dx * dx + dy * dy;
            var t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) /
                                                   length)) : 0;
            var ex = ax + t * dx - px;
            var ey = ay + t * dy - py;
            best = Math.min(best, ex * ex + ey * ey);
        }
        return Math.sqrt(best);
    }

    // True when two pieces (world units) come within gap of each other (at an end of one).
    function joined(a, b, gap) {
        var ends = [[a, b], [b, a]];
        for (var k = 0; k < 2; k++) {
            var one = ends[k][0];
            var other = ends[k][1];
            var last = one.length - 2;
            if (pieceDistance(other, one[0], one[1]) <= gap ||
                    pieceDistance(other, one[last], one[last + 1]) <= gap) {
                return true;
            }
        }
        return false;
    }

    /* Pieces (world units) joined end to end where one ends where another
       starts (within gap): fewer, longer lines. */
    function chain(pieces, gap) {
        var list = pieces.map(function (piece) {
            return piece.slice();
        });
        var merged = true;
        function close(ax, ay, bx, by) {
            return Math.abs(ax - bx) <= gap && Math.abs(ay - by) <= gap;
        }
        while (merged) {
            merged = false;
            for (var i = 0; i < list.length && !merged; i++) {
                for (var j = 0; j < list.length && !merged; j++) {
                    if (i === j || list[i].length < 4 || list[j].length < 4) {
                        continue;
                    }
                    var a = list[i];
                    var b = list[j];
                    var aEnd = a.length - 2;
                    var bEnd = b.length - 2;
                    var joinedPiece = null;
                    if (close(a[aEnd], a[aEnd + 1], b[0], b[1])) {
                        joinedPiece = a.concat(b.slice(2));
                    } else if (close(a[aEnd], a[aEnd + 1], b[bEnd], b[bEnd + 1])) {
                        joinedPiece = a.concat(reversed(b).slice(2));
                    } else if (close(a[0], a[1], b[0], b[1])) {
                        // (Two ways that start at the same corner.)
                        joinedPiece = reversed(a).concat(b.slice(2));
                    }
                    if (joinedPiece) {
                        list[i] = joinedPiece;
                        list.splice(j, 1);
                        merged = true;
                    }
                }
            }
        }
        return list;
    }

    function reversed(piece) {
        var out = [];
        for (var k = piece.length - 2; k >= 0; k -= 2) {
            out.push(piece[k], piece[k + 1]);
        }
        return out;
    }

    /* The rings of an area's pieces cut at the edges of the tiles of zoom
       n = 2^z ([x, y, ...] world units, outer rings as MVT has them) joined
       again: an edge along a tile's edge that the piece on its other side
       has too (the other way round) is no edge of the area, so it goes;
       what is left is chained into rings -- the area's outline, and the
       edges where it was cut short (GATHER_TILES). Rings of no area (or the
       other way round: slivers where two tiles' cuts differ a little) are
       left out. */
    function dissolve(rings, n) {
        var edges = [];
        var seams = {};             // "x" or "y" + the line -> [[from, to], ...] along it
        function onLine(value) {
            return value * n === Math.round(value * n);
        }
        rings.forEach(function (ring) {
            var count = ring.length / 2;
            for (var k = 0; k < count; k++) {
                var ax = ring[2 * k];
                var ay = ring[2 * k + 1];
                var b = (k + 1) % count;
                var bx = ring[2 * b];
                var by = ring[2 * b + 1];
                if (ax === bx && ay === by) {
                    continue;
                }
                if (ax === bx && onLine(ax)) {
                    (seams["x" + ax] = seams["x" + ax] || {line: ax, axis: 0, runs: []})
                        .runs.push([ay, by]);
                } else if (ay === by && onLine(ay)) {
                    (seams["y" + ay] = seams["y" + ay] || {line: ay, axis: 1, runs: []})
                        .runs.push([ax, bx]);
                } else {
                    edges.push([ax, ay, bx, by]);
                }
            }
        });
        Object.keys(seams).forEach(function (id) {
            var seam = seams[id];
            var cuts = [];
            seam.runs.forEach(function (run) {
                cuts.push(run[0], run[1]);
            });
            cuts.sort(function (a, b) {
                return a - b;
            });
            cuts = cuts.filter(function (value, index) {
                return !index || value !== cuts[index - 1];
            });
            function point(along) {
                return seam.axis === 0 ? [seam.line, along] : [along, seam.line];
            }
            var open = null;            // [from, direction] of the run being kept
            function close(at) {
                if (open) {
                    var from = point(open[1] > 0 ? open[0] : at);
                    var to = point(open[1] > 0 ? at : open[0]);
                    edges.push([from[0], from[1], to[0], to[1]]);
                    open = null;
                }
            }
            for (var k = 0; k + 1 < cuts.length; k++) {
                var low = cuts[k];
                var high = cuts[k + 1];
                var net = 0;
                seam.runs.forEach(function (run) {
                    if (Math.min(run[0], run[1]) <= low && Math.max(run[0], run[1]) >= high) {
                        net += run[1] > run[0] ? 1 : -1;
                    }
                });
                var direction = net > 0 ? 1 : net < 0 ? -1 : 0;
                if (open && open[1] !== direction) {
                    close(low);
                }
                if (direction && !open) {
                    open = [low, direction];
                }
            }
            close(cuts[cuts.length - 1]);
        });
        // The edges chained into rings, each from where the one before it ends.
        var starts = {};
        edges.forEach(function (edge, index) {
            var key = edge[0] + "," + edge[1];
            (starts[key] = starts[key] || []).push(index);
        });
        var used = [];
        var out = [];
        edges.forEach(function (edge, index) {
            if (used[index]) {
                return;
            }
            var ring = [];
            var at = index;
            while (at !== undefined && !used[at]) {
                used[at] = true;
                ring.push(edges[at][0], edges[at][1]);
                var next = starts[edges[at][2] + "," + edges[at][3]] || [];
                at = next.filter(function (candidate) {
                    return !used[candidate];
                })[0];
            }
            if (ring.length >= 6 && ringArea(ring) > 0) {
                out.push(ring);
            }
        });
        return out;
    }

    /* All of a street, area or place of at() or inView() (see Picker). */
    Picker.prototype.gather = function (item, callback) {
        var self = this;
        if (!item || !this.ready()) {
            callback(null);
            return;
        }
        if (item.kind === "place") {
            callback({kind: "place", name: item.name, what: item.what, type: item.type,
                      parts: [item.point.slice()], cut: false});
            return;
        }
        var first = item.key.split("/").map(Number);
        var z = first[0];
        var visited = {};
        var pieces = [];            // {world: [x, y, ...], sides: [keys]}
        var refX = null;
        var cut = false;
        var seed = null;            // (a street: the piece nearest where it was picked)
        function take(key) {
            var p = key.split("/").map(Number);
            var data = self.data(key);
            var layer = data ? data[item.kind === "street" ? "roads" : "landuse"] : null;
            if (!layer) {
                return;
            }
            var extent = layer.extent || 4096;
            layer.features.forEach(function (feature) {
                if (item.kind === "street" ? feature.type !== 2 ||
                        displayName(feature.props) !== item.name ||
                        streetFamily(feature.props.kind) !== item.family
                    : feature.type !== 3 || feature.id !== item.id) {
                    return;
                }
                feature.geom.forEach(function (part) {
                    var cutParts = item.kind === "street" ? clipLine(part, extent)
                        : ringArea(part) > 0 ? [clipRing(part, extent)] : [];
                    cutParts.forEach(function (piece) {
                        if (!piece || piece.length < 2) {
                            return;
                        }
                        if (refX === null) {
                            refX = tileWorld(p[0], p[1], p[2], extent, piece[0], piece[1])[0];
                        }
                        var entry = {world: toWorld(piece, p[0], p[1], p[2], extent, refX),
                                     sides: sidesTouched(piece, extent, p[0], p[1], p[2]),
                                     key: key};
                        pieces.push(entry);
                        if (item.kind === "street" && item.at) {
                            // (The piece nearest where it was picked: in its tile, or
                            // one next to it when it was picked near the edge.)
                            var at = tileWorld(first[0], first[1], first[2], extent, item.at[0],
                                               item.at[1]);
                            var d = pieceDistance(entry.world, at[0] + Math.round(refX - at[0]),
                                                  at[1]);
                            if (!seed || d < seed.distance) {
                                seed = {entry: entry, distance: d};
                            }
                        }
                    });
                });
            });
        }
        // The pieces of the street joined to the seed (all of an area's).
        function kept() {
            if (item.kind !== "street") {
                return pieces;
            }
            var start = seed ? seed.entry : pieces[0];
            if (!start) {
                return [];
            }
            var gap = JOIN_METRES / worldMetres(start.world[1]);
            var inSet = [start];
            var left = pieces.filter(function (piece) {
                return piece !== start;
            });
            var grew = true;
            while (grew) {
                grew = false;
                for (var k = left.length - 1; k >= 0; k--) {
                    var piece = left[k];
                    if (inSet.some(function (one) {
                        return joined(one.world, piece.world, gap);
                    })) {
                        inSet.push(piece);
                        left.splice(k, 1);
                        grew = true;
                    }
                }
            }
            return inSet;
        }
        function next(keys) {
            var fresh = keys.filter(function (key) {
                var p = key.split("/").map(Number);
                return !visited[key] && self.source.has(p[0], p[1], p[2]);
            });
            if (!fresh.length) {
                finish();
                return;
            }
            var room = GATHER_TILES - Object.keys(visited).length;
            if (fresh.length > room) {
                cut = true;
                fresh = fresh.slice(0, Math.max(0, room));
            }
            if (!fresh.length) {
                finish();
                return;
            }
            fresh.forEach(function (key) {
                visited[key] = true;
            });
            self.read(fresh, function () {
                fresh.forEach(take);
                var wanted = [];
                kept().forEach(function (piece) {
                    piece.sides.forEach(function (key) {
                        if (!visited[key] && wanted.indexOf(key) < 0) {
                            wanted.push(key);
                        }
                    });
                });
                next(wanted);
            });
        }
        function finish() {
            var chosen = kept();
            if (!chosen.length) {
                callback(null);
                return;
            }
            var world = chosen.map(function (piece) {
                return piece.world;
            });
            if (item.kind === "street") {
                world = chain(world, 2 / worldMetres(world[0][1]));
            } else if (item.kind === "area") {
                // (One outline again, not a piece in each tile: drawn without the
                // tiles' edges, and as deep inside as it is.)
                var joinedRings = dissolve(world, Math.pow(2, z));
                world = joinedRings.length ? joinedRings : world;
            }
            var parts = world.map(function (piece) {
                var out = [];
                for (var k = 0; k < piece.length; k += 2) {
                    var at = worldLatLon(piece[k], piece[k + 1]);
                    out.push(at[0], at[1]);
                }
                return out;
            });
            callback({kind: item.kind, name: item.name, what: item.what, parts: parts, cut: cut});
        }
        if (z < 0 || !isFinite(z)) {
            callback(null);
            return;
        }
        // (A street is read from its tile and the eight around it first: picked near
        // a tile's edge, it may be in the next one only.)
        var around = [item.key];
        if (item.kind === "street") {
            var n = Math.pow(2, z);
            for (var dy = -1; dy <= 1; dy++) {
                for (var dx = -1; dx <= 1; dx++) {
                    if ((dx || dy) && first[2] + dy >= 0 && first[2] + dy < n) {
                        around.push(keyOf(z, mod(first[1] + dx, n), first[2] + dy));
                    }
                }
            }
        }
        next(around);
    };

    /* ---------- Both ------------------------------------------------------- */

    function Basemap(options) {
        this.options = options || {};
        this.world = new WorldLayer(this.options);
        this.streets = this.options.streets ? new StreetLayer(this.options) : null;
        this.tileZoom = this.options.tileZoom || 0;
    }

    Basemap.prototype.source = function () {
        var source = this.streets && this.streets.source;
        return source && source.state !== "failed" ? source : null;
    };

    // Whether the street maps' index is in (what is where is known).
    Basemap.prototype.ready = function () {
        var source = this.source();
        return Boolean(source && source.state === "ready");
    };

    // The deepest zoom the street maps are worth zooming to (null: none).
    Basemap.prototype.maxZoom = function () {
        var source = this.source();
        if (!source) {
            return null;
        }
        return source.index ? source.index.maxzoom + OVERZOOM : FIT_ZOOM + OVERZOOM;
    };

    // The deepest zoom a fit of pictures goes to (null: no street maps).
    Basemap.prototype.fitZoom = function () {
        var source = this.source();
        if (!source) {
            return null;
        }
        return source.index ? Math.min(FIT_ZOOM, source.index.maxzoom) : FIT_ZOOM;
    };

    /* The most detailed zoom of a street tile at a place (from FROM_ZOOM on;
       -1: none there), or null when there are no street maps or their index
       is not in yet. */
    Basemap.prototype.coveredZoom = function (lat, lon) {
        var source = this.source();
        if (!source || source.state !== "ready" || !isFinite(lat) || !isFinite(lon)) {
            return null;
        }
        var t = mercatorY(lat);
        for (var z = source.index.maxzoom; z >= Math.max(FROM_ZOOM, source.index.minzoom);
            z--) {
            var n = Math.pow(2, z);
            var x = mod(Math.floor((lon + 180) / 360 * n), n);
            var y = Math.max(0, Math.min(n - 1, Math.floor(t * n)));
            if (source.has(z, x, y)) {
                return z;
            }
        }
        return -1;
    };

    Basemap.prototype.draw = function (ctx, zoom, left, top, w, h, avoid) {
        var result = {stretch: this.world.draw(ctx, zoom, left, top, w, h), streets: 0,
                      missing: 0, tiles: 0};
        if (this.streets && zoom > this.tileZoom + 1e-9 && Math.round(zoom) >= FROM_ZOOM) {
            var found = this.streets.draw(ctx, zoom, left, top, w, h, avoid);
            result.streets = found.drawn;
            result.missing = found.missing;
            result.tiles = found.tiles;
        }
        return result;
    };

    // The address of the street maps' licence (a file next to their tiles).
    function licenceUrl(streets) {
        return streets && typeof streets.url === "string" && streets.url
            ? streets.url + "LICENSE.txt" : null;
    }

    /* The credit of a map (hidden at first; showCredit shows its parts):
       WORLD_CREDIT (.map-credit-world) while the world image shows, and "(c)
       OpenStreetMap contributors (ODbL)" (.map-credit-osm) while street
       tiles do, the licence's name a link to licenceUrl (opened in another
       tab), with a dot between them (.map-credit-sep) when both show. The
       map page's credit (templates/map.html) has the same parts. tag: "p"
       or "span". */
    function creditNode(tag, className, streets) {
        var node = document.createElement(tag);
        node.className = className;
        function part(name, text) {
            var span = document.createElement("span");
            span.className = name;
            if (text) {
                span.textContent = text;
            }
            node.appendChild(span);
            return span;
        }
        part("map-credit-world", WORLD_CREDIT);
        part("map-credit-sep", " \u00b7 ").setAttribute("aria-hidden", "true");
        var osm = part("map-credit-osm", "");
        osm.appendChild(document.createTextNode(ATTRIBUTION + " ("));
        var link = document.createElement("a");
        link.textContent = "ODbL";
        link.rel = "license";
        link.target = "_blank";
        var url = licenceUrl(streets);
        if (url) {
            link.href = url;
        }
        osm.appendChild(link);
        osm.appendChild(document.createTextNode(")"));
        node.hidden = true;
        return node;
    }

    /* Shows the parts of a map's credit (creditNode) for what Basemap.draw
       drew (drawn): the world image's unless street tiles covered the whole
       view, the street maps' while any showed. Returns true when the credit
       was hidden and shows now (the names are placed clear of it at the
       next drawing). */
    function showCredit(node, drawn) {
        if (!node) {
            return false;
        }
        var streets = Boolean(drawn && drawn.streets > 0);
        var world = !streets || drawn.missing > 0 || drawn.streets < drawn.tiles;
        [["map-credit-world", world], ["map-credit-osm", streets],
         ["map-credit-sep", world && streets]].forEach(function (pair) {
            var part = node.querySelector ? node.querySelector("." + pair[0]) : null;
            if (part) {
                part.hidden = !pair[1];
            }
        });
        var was = node.hidden;
        node.hidden = !world && !streets;
        return was && !node.hidden;
    }

    /* A node's rectangle in the view of a canvas ([x0, y0, x1, y1], a little
       larger), for draw's avoid; null when it is hidden. */
    function clearOf(node, canvas) {
        if (!node || node.hidden || !canvas) {
            return null;
        }
        var box = canvas.getBoundingClientRect();
        var r = node.getBoundingClientRect();
        return r.width && r.height ? [r.left - box.left - 2, r.top - box.top - 2,
                                      r.right - box.left + 2, r.bottom - box.top + 2] : null;
    }

    return {
        ATTRIBUTION: ATTRIBUTION,
        MAX_LAT: MAX_LAT,
        STREET_TILE: STREET_TILE,
        OVERZOOM: OVERZOOM,
        FROM_ZOOM: FROM_ZOOM,
        FILL_LEVELS: FILL_LEVELS,
        FIT_ZOOM: FIT_ZOOM,
        WORLD_CREDIT: WORLD_CREDIT,
        PLACE_REACH: PLACE_REACH,
        placeWithin: placeWithin,
        licenceUrl: licenceUrl,
        creditNode: creditNode,
        showCredit: showCredit,
        clearOf: clearOf,
        placeLabel: placeLabel,
        mercatorY: mercatorY,
        latitudeAt: latitudeAt,
        inflate: inflate,
        decodeTile: decodeTile,
        base64Bytes: base64Bytes,
        width: width,
        WIDTHS: WIDTHS,
        THEMES: THEMES,
        renderTile: renderTile,
        DATA: root.STREETS_DATA,
        Source: Source,
        sourceFor: sourceFor,
        WorldLayer: WorldLayer,
        StreetLayer: StreetLayer,
        Basemap: Basemap,
        Picker: Picker,
        dissolve: dissolve,
        GATHER_TILES: GATHER_TILES,
        clipLine: clipLine,
        clipRing: clipRing
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = STREETS;
}
