/* The map page: the located pictures of the current search as pins on a
   world map, a list of the pictures of a pin, and a way back to the grid
   with just those pictures.

   Coordinates
     - lat/lon: WGS84 degrees.
     - world pixels at zoom z: the Web Mercator projection (that of the
       street maps, see streets.js), the world (tile * 2^(z+1)) wide and as
       tall; x grows east from the date line (lon -180), y south from about
       85 degrees north (MAX_LAT; the poles are left out). The world
       repeats sideways: x and x + width are the same place.
     - screen pixels: a place in the canvas.

   Pins are grouped (clustered) in world pixels, once per zoom level and
   search: the groups do not depend on where the map is panned to, so they
   never change while it is dragged. A group is the pictures of one 64 px
   cell of the world, and groups whose pins would touch are merged (also
   across the date line), so pins never overlap. Each pin is drawn on every
   copy of the world that is on the screen.

   Zoom levels are whole numbers. Past the most detailed tiles of the world
   image the map shows the street maps where they were downloaded
   (street_maps.py; from STREETS.FROM_ZOOM on; credited to OpenStreetMap,
   with a link to their licence, in a corner while they show), down to
   street level and a few zooms past it (as deep as they go: MAX_ZOOM and
   FIT_ZOOM follow their index once it is in); elsewhere it zooms on with
   the world image enlarged (OVERZOOM levels, and at least to zoom 10, about
   75 m a pixel; drawn fainter the further they are stretched, with a
   note), so pictures taken close together still come apart; while a tile
   loads, a coarser one that is already there stands in for it. A search's
   pictures are fitted down to street level only where the street maps
   have tiles at some of them (else to the world image's detail), and fitted
   again when the street maps' index comes in after the fit, or the people
   a search names (person:, or a name plain-language search understood)
   come after it (unless the map was moved since). Names on the street
   maps keep clear of the buttons, the credits and the note.

   The list of a pin names each picture's named place on the street maps
   (a park, a museum: the record's np, see named_places.py), and its title
   the named place most of them were taken at.

   Estimated places (place_estimates.py: pictures without a GPS position
   of their own, points with "e": 1) are drawn as hollow pins (a pin whose
   pictures are all estimated), and only while "Show estimated places" is
   on (the admin's default; others turn it on).

   Drive routes (routes.js; the GPS tracks of videos, tracks.py) are drawn
   as lines under the pins: the clips the search finds, broken where clips
   are left out or missing, while "Show drive routes" is on (the default;
   it shows only when there are routes). Their clips then have no pins of
   their own (the line is where they are; with it off they are pins
   again). The pointer over a line says the drive and the clip there; a
   click (or a tap) opens the viewer on that clip, that far into it,
   playing the whole drive. A clip of a drive opened from a pin plays the
   whole drive too, as on the search page.

   An area of the map limits the search ("Search an area": a rectangle, a
   shape drawn around it, the view, or a street, park or place picked from
   the street maps; see "An area of the map" in the page's code and
   search-core.js "Areas on the map"): only its pictures keep their pins,
   the rest of the map is veiled, and a chip in the bar names it.

   The address holds the search (as on the search page, with its area) and the map's
   view ("view=lat,lon,zoom"), so a reload, a link or "Back to the map"
   shows the same place (a view that shows none of the search's pictures
   is not kept: the map fits them), and the open list ("pin=lat,lon").
   The search page keeps the view only while its search stays the same.

   MAP holds the parts without a page (projection, clustering, the wheel,
   fitting a view), also run by the tests under Node
   (tests/js/map_test.js). Pages are built with DOM calls and textContent
   only (never innerHTML).
*/
var MAP = (function () {
    "use strict";

    var hasDocument = typeof document !== "undefined" && document !== null;
    // The map's north and south edges (Web Mercator leaves the poles out).
    var MAX_LAT = 85.0511287798;

    // Pictures are grouped by cells of this many world pixels (a power of
    // two, so the cells fit the world exactly at every zoom).
    var CELL = 64;
    // Pins of different groups keep at least this far apart (pixels).
    var GAP = 3;
    var SINGLE_RADIUS = 7;
    var MAX_RADIUS = 20;
    // With street maps the map fits a search's pictures at most this far in
    // (and zooms STREETS.OVERZOOM further).
    var FIT_STREETS = 15;
    // Wheel: this many pixels of a mouse wheel make one zoom step (one
    // notch).
    var WHEEL_STEP = 100;
    var WHEEL_LINE = 40;
    var WHEEL_PAGE = 600;
    // A touchpad (or a wheel that scrolls smoothly) sends a stream of
    // steps: less than WHEEL_STREAM ms apart, of less than WHEEL_SMALL
    // pixels, or of changing sizes (a mouse's notches are all alike, or
    // whole multiples of one). Then TOUCHPAD_STEP pixels make one zoom
    // step, and after a step the scrolling of the next TOUCHPAD_REST ms is
    // left out (the momentum of a flick goes on for a while).
    var WHEEL_SMALL = 30;
    var WHEEL_STREAM = 25;
    var TOUCHPAD_STEP = 250;
    var TOUCHPAD_REST = 250;
    // A touchpad pinch arrives as small wheel steps with Ctrl held.
    var PINCH_FACTOR = 3;
    // A pause this long (ms) starts a new wheel gesture.
    var WHEEL_IDLE = 400;

    /* ---------- Projection ------------------------------------------------ */

    function worldWidth(tile, zoom) {
        return tile * Math.pow(2, zoom + 1);
    }

    // x into [0, width).
    function wrapX(x, width) {
        var value = x % width;
        return value < 0 ? value + width : value;
    }

    // A longitude in [-180, 180).
    function normalizeLon(lon) {
        return lon >= -180 && lon < 180 ? lon : wrapX(lon + 180, 360) - 180;
    }

    function validPoint(point) {
        return point !== null && typeof point === "object" &&
            typeof point.lat === "number" && typeof point.lon === "number" &&
            isFinite(point.lat) && isFinite(point.lon) &&
            point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180;
    }

    // World pixels (x in [0, width)) of a place (beyond MAX_LAT: on the edge).
    function project(lat, lon, width) {
        var r = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
        return {x: wrapX((lon + 180) / 360 * width, width),
                y: (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2 * width};
    }

    function unproject(x, y, width) {
        var v = Math.PI * (1 - 2 * y / width);
        return {lat: Math.atan((Math.exp(v) - Math.exp(-v)) / 2) * 180 / Math.PI,
                lon: normalizeLon(x * 360 / width - 180)};
    }

    // The copy of x (x + k * width) nearest to ref.
    function nearestCopy(x, ref, width) {
        return x + Math.round((ref - x) / width) * width;
    }

    /* The screen x of every copy of world x in a view whose left edge is
       world x = left and that is span pixels wide (margin: also copies
       that far off the screen, for pins that reach into it). */
    function copies(x, left, span, width, margin) {
        var out = [];
        if (!(width > 0)) {
            return out;
        }
        margin = margin || 0;
        var first = x + Math.ceil((left - margin - x) / width) * width;
        for (var at = first; at <= left + span + margin; at += width) {
            out.push(at - left);
        }
        return out;
    }

    /* ---------- Groups of pictures (clusters) ---------------------------- */

    function pinRadius(count) {
        return count <= 1 ? SINGLE_RADIUS
            : Math.min(MAX_RADIUS, Math.round(9 + 2.5 * Math.log(count)));
    }

    // "1,234" up to 9,999, then "12k".
    function countLabel(count) {
        if (count >= 10000) {
            return Math.floor(count / 1000) + "k";
        }
        return count >= 1000 ? Math.floor(count / 1000) + "," + String(count % 1000 + 1000).slice(1)
            : String(count);
    }

    /* Merges groups whose pins would touch until none do: the larger group
       takes the smaller, at their weighted middle (the short way round the
       world), and its pin grows. */
    function mergeTouching(groups, width, gap) {
        var size = CELL;
        var cols = Math.max(1, Math.round(width / size));
        var changed = true;
        while (changed) {
            changed = false;
            var buckets = {};
            groups.forEach(function (group, index) {
                group.dead = false;
                var key = (Math.floor(group.x / size) % cols) + ":" + Math.floor(group.y / size);
                (buckets[key] = buckets[key] || []).push(index);
            });
            var order = groups.map(function (group, index) {
                return index;
            }).sort(function (a, b) {
                var ga = groups[a];
                var gb = groups[b];
                return gb.count - ga.count || ga.y - gb.y || ga.x - gb.x;
            });
            for (var k = 0; k < order.length; k++) {
                var group = groups[order[k]];
                if (group.dead) {
                    continue;
                }
                var bx = Math.floor(group.x / size) % cols;
                var by = Math.floor(group.y / size);
                var seen = {};
                for (var dx = -1; dx <= 1; dx++) {
                    for (var dy = -1; dy <= 1; dy++) {
                        var key = ((bx + dx + cols) % cols) + ":" + (by + dy);
                        if (seen[key] || !buckets[key]) {
                            continue;
                        }
                        seen[key] = true;
                        var list = buckets[key];
                        for (var m = 0; m < list.length; m++) {
                            var other = groups[list[m]];
                            if (other === group || other.dead) {
                                continue;
                            }
                            var ox = nearestCopy(other.x, group.x, width);
                            var ddx = ox - group.x;
                            var ddy = other.y - group.y;
                            var reach = group.r + other.r + gap;
                            if (ddx * ddx + ddy * ddy < reach * reach) {
                                var total = group.count + other.count;
                                group.x = wrapX((group.x * group.count + ox * other.count) / total,
                                                width);
                                group.y = (group.y * group.count + other.y * other.count) / total;
                                group.count = total;
                                group.estimated = (group.estimated || 0) +
                                    (other.estimated || 0);
                                group.ids = group.ids.concat(other.ids);
                                group.r = pinRadius(total);
                                other.dead = true;
                                changed = true;
                            }
                        }
                    }
                }
            }
            groups = groups.filter(function (item) {
                return !item.dead;
            });
        }
        groups.forEach(function (item) {
            delete item.dead;
        });
        return groups;
    }

    /* The pins of points ([{id, lat, lon}; "e": 1 for an estimated place])
       on a world width pixels wide: [{x, y, count, ids, r, estimated (how
       many of its points are estimated)}] in world pixels (x in [0,
       width)), ordered top to bottom. The same points and width always
       give the same pins, wherever the map is panned to. options: cell,
       gap (pixels). */
    function cluster(points, width, options) {
        options = options || {};
        var cell = options.cell || CELL;
        var gap = options.gap === undefined ? GAP : options.gap;
        var cols = Math.max(1, Math.round(width / cell));
        var cells = {};
        var groups = [];
        (points || []).forEach(function (point) {
            if (!validPoint(point)) {
                return;
            }
            var at = project(point.lat, point.lon, width);
            var key = (Math.floor(at.x / cell) % cols) + ":" + Math.floor(at.y / cell);
            var group = cells[key];
            if (!group) {
                group = {sx: 0, sy: 0, ref: at.x, ids: [], estimated: 0};
                cells[key] = group;
                groups.push(group);
            }
            group.sx += nearestCopy(at.x, group.ref, width);
            group.sy += at.y;
            group.ids.push(point.id);
            if (point.e) {
                group.estimated += 1;
            }
        });
        groups = groups.map(function (group) {
            var count = group.ids.length;
            return {x: wrapX(group.sx / count, width), y: group.sy / count, count: count,
                    ids: group.ids, r: pinRadius(count), estimated: group.estimated};
        });
        groups = mergeTouching(groups, width, gap);
        groups.sort(function (a, b) {
            return a.y - b.y || a.x - b.x;
        });
        return groups;
    }

    /* The pins on the screen: every copy of every group (cluster()) that
       is (partly) in a view whose top left corner is world (left, top),
       viewW x viewH pixels, of a world width pixels wide: [{sx, sy, r,
       group}], larger groups last (drawn on top). */
    function screenPins(groups, left, top, viewW, viewH, width) {
        var list = [];
        groups.forEach(function (group) {
            var sy = group.y - top;
            var margin = group.r + 6;
            if (sy < -margin || sy > viewH + margin) {
                return;
            }
            copies(group.x, left, viewW, width, margin).forEach(function (sx) {
                list.push({sx: sx, sy: sy, r: group.r, group: group});
            });
        });
        list.sort(function (a, b) {
            return a.group.count - b.group.count;
        });
        return list;
    }

    /* The pin under a point of the screen: pins are [{sx, sy, r}] in the
       order they are drawn; the one whose edge is nearest wins, and of
       equals the one drawn last (on top). slack: pixels around a pin that
       still count (a finger is less precise than a mouse). */
    function hitPin(pins, x, y, slack) {
        var best = null;
        var bestScore = Infinity;
        slack = slack || 0;
        for (var k = 0; k < pins.length; k++) {
            var pin = pins[k];
            var dx = pin.sx - x;
            var dy = pin.sy - y;
            var distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= pin.r + slack && distance - pin.r <= bestScore) {
                best = pin;
                bestScore = distance - pin.r;
            }
        }
        return best;
    }

    /* ---------- The wheel ---------------------------------------------- */

    /* Wheel events to zoom steps. Only the up/down part zooms: a sideways
       scroll (a touchpad swipe, a tilt wheel, Shift+wheel) pans instead.
       Steps add up: WHEEL_STEP pixels of a mouse wheel (one notch) make one
       zoom level. A gesture (events without a pause) that turns out to be
       a stream of small steps (a touchpad) needs TOUCHPAD_STEP pixels a
       level and rests after each, so a flick and its momentum zoom a
       level or two, not ten. A pinch (Ctrl) zooms at its own pace.
       feed(event) -> {steps: 1 (in), -1 (out) or 0, panX: pixels to pan
       sideways}. */
    function WheelZoom(options) {
        options = options || {};
        this.step = options.step || WHEEL_STEP;
        this.idle = options.idle || WHEEL_IDLE;
        this.amount = 0;
        this.last = -Infinity;
        this.lastStep = -Infinity;
        this.lastSize = 0;
        this.touchpad = false;
    }

    // a and b (> 0) are the same size, or one a whole multiple of the other.
    function alike(a, b) {
        var ratio = Math.max(a, b) / Math.min(a, b);
        return Math.abs(ratio - Math.round(ratio)) < 0.02;
    }

    WheelZoom.prototype.feed = function (event) {
        var unit = event.deltaMode === 1 ? WHEEL_LINE : event.deltaMode === 2 ? WHEEL_PAGE : 1;
        var dy = (Number(event.deltaY) || 0) * unit;
        var dx = (Number(event.deltaX) || 0) * unit;
        var now = typeof event.timeStamp === "number" ? event.timeStamp : Date.now();
        var out = {steps: 0, panX: 0};
        if (Math.abs(dx) > Math.abs(dy)) {
            out.panX = -dx;
            return out;
        }
        if (!dy) {
            return out;
        }
        var pinch = Boolean(event.ctrlKey);
        var since = now - this.last;
        if (since > this.idle) {
            this.amount = 0;
            this.lastSize = 0;
            this.touchpad = false;
        } else if (this.amount !== 0 && (this.amount > 0) !== (dy > 0)) {
            this.amount = 0;
        }
        this.last = now;
        var size = Math.abs(dy);
        if (pinch) {
            dy *= PINCH_FACTOR;
        } else if (unit === 1 && (size < WHEEL_SMALL || since < WHEEL_STREAM ||
                                  (this.lastSize && !alike(size, this.lastSize)))) {
            this.touchpad = true;
        }
        this.lastSize = unit === 1 && !pinch ? size : 0;
        var step = this.step;
        if (this.touchpad && !pinch) {
            if (now - this.lastStep < TOUCHPAD_REST) {
                return out;
            }
            step = Math.max(step, TOUCHPAD_STEP);
        }
        this.amount += dy;
        if (Math.abs(this.amount) >= step) {
            out.steps = this.amount < 0 ? 1 : -1;
            this.amount = 0;
            this.lastStep = now;
        }
        return out;
    };

    /* ---------- Views ------------------------------------------------------ */

    /* The view {lat, lon, zoom} that shows all points with pad pixels to
       spare: the highest whole zoom in [minZoom, maxZoom] where they fit,
       centred on them. The longitudes are spanned the short way round: the
       widest gap between them is left out, so pictures on both sides of the
       date line are shown together. null without points. */
    function fitView(points, screenW, screenH, tile, minZoom, maxZoom, pad) {
        pad = pad === undefined ? 40 : pad;
        var lons = [];
        var south = 90;
        var north = -90;
        (points || []).forEach(function (point) {
            if (validPoint(point)) {
                lons.push(normalizeLon(point.lon));
                south = Math.min(south, point.lat);
                north = Math.max(north, point.lat);
            }
        });
        if (!lons.length) {
            return null;
        }
        lons.sort(function (a, b) {
            return a - b;
        });
        var gapStart = lons[lons.length - 1];
        var gap = lons[0] + 360 - lons[lons.length - 1];
        for (var k = 1; k < lons.length; k++) {
            if (lons[k] - lons[k - 1] > gap) {
                gap = lons[k] - lons[k - 1];
                gapStart = lons[k - 1];
            }
        }
        var span = 360 - gap;
        var west = gapStart + gap;
        var zoom = minZoom;
        // (The latitudes in world pixels of a world 1 pixel tall.)
        var top = project(north, 0, 1).y;
        var bottom = project(south, 0, 1).y;
        for (var z = minZoom; z <= maxZoom; z++) {
            var width = worldWidth(tile, z);
            if (span / 360 * width <= Math.max(1, screenW - 2 * pad) &&
                    (bottom - top) * width <= Math.max(1, screenH - 2 * pad)) {
                zoom = z;
            } else {
                break;
            }
        }
        return {lat: unproject(0, (top + bottom) / 2, 1).lat, lon: normalizeLon(west + span / 2),
                zoom: zoom};
    }

    function shortNumber(value) {
        var text = String(Number(value.toFixed(4)));
        return text === "-0" ? "0" : text;
    }

    /* The search a chip of the viewer opens (a search state, see
       SITE.searchState): just that value -- group "q" for words, else a
       facet group -- without the query, filters, map view, dates
       (state.from/to, the timeline's) or area of the search the map shows. */
    function chipState(state, group, value) {
        var target = {};
        Object.keys(state || {}).forEach(function (key) {
            target[key] = state[key];
        });
        target.q = group === "q" ? value : "";
        target.filters = {};
        target.view = "";
        target.from = "";
        target.to = "";
        target.area = "";
        target.aname = "";
        if (group !== "q") {
            target.filters[group] = [value];
        }
        return target;
    }

    // "lat,lon,zoom" for the address (SITE.searchState reads it back).
    function formatView(view) {
        return shortNumber(view.lat) + "," + shortNumber(normalizeLon(view.lon)) + "," +
            Math.round(view.zoom);
    }

    // {lat, lon, zoom} of formatView's text, or null.
    function parseView(text) {
        var match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+)$/.exec(String(text || ""));
        if (!match) {
            return null;
        }
        var lat = Number(match[1]);
        var lon = Number(match[2]);
        if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
            return null;
        }
        return {lat: lat, lon: normalizeLon(lon), zoom: Number(match[3])};
    }

    /* The open list is in the address too ("pin=lat,lon", the middle of
       its pin), so Back to a page the browser did not keep, or a reload,
       opens it again. */
    function formatPoint(point) {
        function six(value) {
            var text = String(Number(value.toFixed(6)));
            return text === "-0" ? "0" : text;
        }
        return six(point.lat) + "," + six(normalizeLon(point.lon));
    }

    // {lat, lon} of formatPoint's text, or null.
    function parsePoint(text) {
        var match = /^(-?\d{1,2}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?)$/.exec(String(text || ""));
        if (!match) {
            return null;
        }
        var point = {lat: Number(match[1]), lon: Number(match[2])};
        return validPoint(point) ? {lat: point.lat, lon: normalizeLon(point.lon)} : null;
    }

    // The group (of cluster()) whose pin covers a place, or null.
    function groupAt(groups, lat, lon, width) {
        var at = project(lat, lon, width);
        var best = null;
        var bestDistance = Infinity;
        (groups || []).forEach(function (group) {
            var dx = nearestCopy(group.x, at.x, width) - at.x;
            var dy = group.y - at.y;
            var distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= group.r && distance < bestDistance) {
                best = group;
                bestDistance = distance;
            }
        });
        return best;
    }

    /* ---------- Pins on a canvas (the ground under them: streets.js) ------ */

    /* Pins (screenPins' list) on a canvas: red for one picture, blue with
       the count for a group, hollow for a group of estimated places only,
       and a yellow ring around a picked group (group.picked). */
    function drawPins(ctx, list) {
        ctx.save();
        ctx.font = "600 12px system-ui, -apple-system, \"Segoe UI\", sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        list.forEach(function (pin) {
            var group = pin.group;
            if (group.picked) {
                // (A dark edge under it: seen on the light street maps too.)
                ctx.beginPath();
                ctx.arc(pin.sx, pin.sy, pin.r + 4, 0, Math.PI * 2);
                ctx.lineWidth = 5.5;
                ctx.strokeStyle = "rgba(12, 17, 24, 0.85)";
                ctx.stroke();
                ctx.lineWidth = 3;
                ctx.strokeStyle = "rgba(255, 210, 63, 0.98)";
                ctx.stroke();
            }
            ctx.beginPath();
            ctx.arc(pin.sx, pin.sy, pin.r, 0, Math.PI * 2);
            var color = group.count === 1 ? "rgba(214, 58, 58, 0.95)"
                : "rgba(31, 103, 214, 0.95)";
            if (group.estimated && group.estimated === group.count) {
                // Only estimated places: a hollow pin.
                ctx.fillStyle = "rgba(12, 17, 24, 0.35)";
                ctx.fill();
                ctx.lineWidth = 4;
                ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                ctx.stroke();
                ctx.lineWidth = 2.5;
                ctx.strokeStyle = color;
                ctx.stroke();
            } else {
                ctx.fillStyle = color;
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
                ctx.stroke();
            }
            if (group.count > 1) {
                ctx.fillStyle = "#ffffff";
                ctx.fillText(countLabel(group.count), pin.sx, pin.sy + 0.5);
            }
        });
        ctx.restore();
    }

    /* ---------- The page ------------------------------------------------- */

    function startPage() {
        var el = SHELL.el;
        var clear = SHELL.clear;
        var fmt = SHELL.format;

        var TILE = SITE.tileSize();
        var tilesMax = SITE.tilesMax();
        // The most detailed tiles: the pyramid's, or (without one) the
        // small bundled map the server cuts up to zoom 3.
        var TILE_ZOOM = tilesMax === null ? 3 : Math.max(0, tilesMax);
        var OVERZOOM = 4;
        var MIN_ZOOM = 0;
        // (The street maps, when there are any: see STREETS.Basemap. Until their
        // index is in, they are taken to go to street level; then MAX_ZOOM and
        // FIT_ZOOM follow it: streetsChanged.)
        var streets = SITE.streets();
        var BASE_MAX_ZOOM = Math.max(TILE_ZOOM + OVERZOOM, 10);
        var MAX_ZOOM = Math.max(BASE_MAX_ZOOM, streets ? FIT_STREETS + STREETS.OVERZOOM : 0);
        // A search's pictures are fitted at most this far in (see fitLimit).
        var FIT_ZOOM = streets ? Math.max(TILE_ZOOM, FIT_STREETS) : TILE_ZOOM;
        // The note shows while this share of the view or more has no street map.
        var NOTE_SHARE = 0.25;
        // Between an export's corner credit and the street maps' credit above it, and
        // between the credits and the note (px; style.css's for a corner of one line).
        var CREDIT_GAP = 5;
        var NOTE_GAP = 11;
        var OCEAN = "#1a2c3d";
        var PANEL_PAGE = 120;
        var MOUSE_SLACK = 4;
        var TOUCH_SLACK = 12;
        // (sessionStorage; app.js reads it.)
        var FROM_MAP_KEY = "searchImages.fromMap";

        var canvas = document.getElementById("map-canvas");
        var ctx = canvas.getContext("2d");
        var panel = document.getElementById("map-panel");
        var panelTitle = document.getElementById("map-panel-title");
        var panelList = document.getElementById("map-panel-list");
        var panelMore = document.getElementById("map-panel-more");
        var gridLink = document.getElementById("map-panel-grid");
        var gridNote = document.getElementById("map-panel-note");
        var statusBar = document.getElementById("map-status");
        var messageBox = document.getElementById("map-message");
        var detailNote = document.getElementById("map-note");
        var streetsCredit = document.getElementById("map-streets-credit");
        // (An export's: export.py render_page.)
        var cornerCredit = document.getElementById("map-credit");
        var streetsLicence = document.getElementById("map-streets-licence");
        var zoomButtons = document.getElementById("map-zoom");
        var targetNote = document.getElementById("map-target");

        var search = SITE.searchState.read();
        // The search as plain-language search understood it (SearchCore.interpret,
        // as on the search page: the same people, typed and plain).
        var interpreted = null;
        var adminOn = Boolean(SITE.capabilities.admin) && !SITE.capabilities.static;
        // "Show estimated places": the admin's default is on (kept for the
        // session when changed).
        var ESTIMATED_KEY = "searchImages.mapEstimated";
        var estimatedBox = document.getElementById("map-estimated");
        var estimatedToggle = document.getElementById("map-estimated-toggle");
        var showEstimated = adminOn;
        try {
            var keptChoice = window.sessionStorage.getItem(ESTIMATED_KEY);
            if (keptChoice === "1" || keptChoice === "0") {
                showEstimated = keptChoice === "1";
            }
        } catch (error) {
            // (No storage: the default.)
        }
        var estimatedIds = {};          // ids of the estimated points
        // "Show drive routes" (on by default; kept for the session when changed).
        var ROUTES_KEY = "searchImages.mapRoutes";
        var routesBox = document.getElementById("map-routes");
        var routesToggle = document.getElementById("map-routes-toggle");
        var routeTip = document.getElementById("map-route-tip");
        var showRoutes = true;
        try {
            var keptRoutes = window.sessionStorage.getItem(ROUTES_KEY);
            if (keptRoutes === "1" || keptRoutes === "0") {
                showRoutes = keptRoutes === "1";
            }
        } catch (error) {
            // (No storage: the default.)
        }
        var allRoutes = null;           // ROUTES.prepare's routes, once loaded
        var routeList = null;           // and as they came (for the index's places)
        var routeLines = [];            // the lines of the search's clips
        var routeCount = 0;             // the routes they are of
        var onRoutes = {};              // ids of the clips drawn as lines: no pins
        var pinLocations = [];          // the located pictures with pins
        var routesVersion = 0;
        var routeCache = {zoom: -1, version: -1, lines: []};
        var routesDrawn = [];           // the lines drawn last, with screen positions
        var hoverRoute = null;          // the place on a line under the mouse
        // (SITE.searchState.read has checked the value already.)
        var startView = parseView(search.view);
        // The view is still the one from the address (until the pictures
        // are there).
        var viewFromAddress = Boolean(startView);
        // The list that was open (see formatPoint), opened again once the
        // pictures are there.
        var startPin = parsePoint(new URLSearchParams(window.location.search).get("pin"));

        var view = {lat: 20, lon: 0, zoom: 1, w: 0, h: 0};
        var dpr = 0;
        var ratioQuery = null;
        var basemap = new STREETS.Basemap({tileUrl: SITE.tileUrl, tileSize: TILE,
                                           tileZoom: TILE_ZOOM, ocean: OCEAN, streets: streets,
                                           onLoad: function () {
                                               streetsChanged();
                                               scheduleDraw();
                                           }});
        var streetsKnown = !streets;     // how deep the street maps go is known
        var autoFitted = false;          // the view is a fit, not moved since
        if (streetsLicence && streets) {
            streetsLicence.href = STREETS.licenceUrl(streets);
        }
        streetsChanged();
        var records = [];
        var indexById = {};
        var indexLibraries = [];
        var indexAlbums = [];
        var indexNames = null;
        var searchIndex = null;
        // The people for person: (the search page's, SITE.peopleForSearch): the
        // search runs again when they come, and a view that is a fit nobody
        // moved since fits their pictures (the first fit found none of them).
        var peopleSearch = SITE.peopleForSearch(function () {
            if (loadState === "ready") {
                applySearch(autoFitted);
            }
        }, adminOn);
        var vectorsWanted = false;
        var allLocations = null;
        var locations = [];
        // With an area that holds none of the pictures that match: {total, placed} of
        // those that match anywhere (placed: how many have a place to be in an area by).
        var areaElsewhere = null;
        var matchCount = 0;
        var rank = {};
        var loadState = "loading";      // loading | failed | ready
        var placed = false;              // the view has been set (address or fit)
        var groupsCache = {zoom: -1, version: -1, groups: []};
        var locationsVersion = 0;
        var pins = [];                   // the pins drawn last: [{sx, sy, r, group}]
        var selection = null;            // the pictures of the open list
        var wheel = new WheelZoom();
        var viewerPushed = false;
        // How the map was last used while it had the focus: "key",
        // "pointer" (a mouse or a finger) or "" (not since it got it).
        var usedBy = "";

        /* View */

        function width() {
            return worldWidth(TILE, view.zoom);
        }

        function clampView() {
            var w = width();
            var top = view.h / 2;
            var bottom = w - view.h / 2;
            if (bottom < top) {
                view.lat = 0;
            } else {
                var y = Math.max(top, Math.min(bottom, project(view.lat, 0, w).y));
                view.lat = unproject(0, y, w).lat;
            }
            view.lon = normalizeLon(view.lon);
        }

        // World x and y of the screen's top left corner.
        function corner() {
            var w = width();
            var centre = project(view.lat, view.lon, w);
            return {left: centre.x - view.w / 2, top: centre.y - view.h / 2, w: w};
        }

        function setView(lat, lon, zoom) {
            view.lat = lat;
            view.lon = lon;
            view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
            autoFitted = false;
            clampView();
            changedView();
        }

        // The world filling the screen (the view without pictures).
        function worldView() {
            var zoom = MIN_ZOOM;
            while (zoom < TILE_ZOOM && (worldWidth(TILE, zoom) < view.w ||
                                        worldWidth(TILE, zoom) < view.h)) {
                zoom += 1;
            }
            setView(20, 0, zoom);
        }

        function zoomAt(sx, sy, zoom) {
            zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
            if (zoom === view.zoom) {
                return;
            }
            autoFitted = false;
            var at = corner();
            var anchor = unproject(at.left + sx, at.top + sy, at.w);
            var w = worldWidth(TILE, zoom);
            var spot = project(anchor.lat, anchor.lon, w);
            view.zoom = zoom;
            var centre = unproject(spot.x + view.w / 2 - sx, spot.y + view.h / 2 - sy, w);
            view.lat = centre.lat;
            view.lon = centre.lon;
            clampView();
            changedView();
        }

        function panBy(dx, dy) {
            autoFitted = false;
            var w = width();
            var centre = project(view.lat, view.lon, w);
            var moved = unproject(centre.x - dx, centre.y - dy, w);
            view.lon = moved.lon;
            view.lat = moved.lat;
            clampView();
            changedView();
        }

        var viewTimer = 0;

        function changedView() {
            placed = true;
            scheduleDraw();
            window.clearTimeout(viewTimer);
            viewTimer = window.setTimeout(function () {
                if (!VIEWER.isOpen()) {
                    SHELL.setState({view: formatView(view), ids: null});
                }
                updateLinks();
                if (areaMode === "pick") {
                    // (The names of the new view, for the list.)
                    listNames();
                }
                hideMenu();
            }, 250);
        }

        /* Size of the canvas */

        function onRatioChange() {
            resize();
        }

        // Redraws when the window moves to a screen of another pixel density
        // (or the page is zoomed): the canvas then needs a new size.
        function watchRatio() {
            if (ratioQuery) {
                if (ratioQuery.removeEventListener) {
                    ratioQuery.removeEventListener("change", onRatioChange);
                } else if (ratioQuery.removeListener) {
                    ratioQuery.removeListener(onRatioChange);
                }
                ratioQuery = null;
            }
            if (!window.matchMedia) {
                return;
            }
            ratioQuery = window.matchMedia("(resolution: " + dpr + "dppx)");
            if (ratioQuery.addEventListener) {
                ratioQuery.addEventListener("change", onRatioChange);
            } else if (ratioQuery.addListener) {
                ratioQuery.addListener(onRatioChange);
            }
        }

        function resize() {
            var rect = canvas.getBoundingClientRect();
            var ratio = window.devicePixelRatio || 1;
            view.w = rect.width;
            view.h = rect.height;
            var backW = Math.max(1, Math.round(rect.width * ratio));
            var backH = Math.max(1, Math.round(rect.height * ratio));
            if (canvas.width !== backW || canvas.height !== backH) {
                canvas.width = backW;
                canvas.height = backH;
            }
            if (ratio !== dpr) {
                dpr = ratio;
                watchRatio();
            }
            stackCredits();
            clampView();
            scheduleDraw();
        }

        /* An export's credit in the corner (#map-credit, export.py render_page: the
           GeoNames and named places credits, the link to the photo credits) can take
           two or three lines on a narrow screen: the street maps' credit and the note
           go above it, however tall it is (style.css places them for a corner of one
           line; the same gaps). Returns true when either moved. */
        function stackCredits() {
            if (!cornerCredit || cornerCredit.hidden) {
                return false;
            }
            var corner = cornerCredit.getBoundingClientRect();
            if (!corner.height) {
                return false;
            }
            var moved = false;
            function place(node, bottom) {
                var value = Math.round(bottom) + "px";
                if (node && node.style.bottom !== value) {
                    node.style.bottom = value;
                    moved = true;
                }
            }
            // (Its top, measured from the foot of the map.)
            var edge = Math.ceil(canvas.getBoundingClientRect().bottom - corner.top);
            var below = edge;
            if (streetsCredit) {
                place(streetsCredit, edge + CREDIT_GAP);
                if (!streetsCredit.hidden) {
                    below = edge + CREDIT_GAP + streetsCredit.getBoundingClientRect().height;
                }
            }
            place(detailNote, below + NOTE_GAP);
            return moved;
        }

        /* Tiles */

        function drawTiles(at) {
            var drawn = basemap.draw(ctx, view.zoom, at.left, at.top, view.w, view.h,
                                     keepClear());
            // (The note only where the world image is stretched: no street map in a
            // good part of the view.)
            var noteWas = detailNote.hidden;
            detailNote.hidden = drawn.stretch < 2 ||
                (drawn.streets > 0 && drawn.missing < NOTE_SHARE * drawn.tiles);
            // (The credit: the world image's, the street maps', or both.)
            var creditShown = STREETS.showCredit(streetsCredit, drawn);
            // (The corner of an export: the note goes above the street maps' credit
            // while that shows.)
            if (stackCredits() || creditShown ||
                    (noteWas && !detailNote.hidden && drawn.streets)) {
                // (Shown just now: the names are placed clear of it again.)
                scheduleDraw();
            }
        }

        // The places of the view no name of the street maps goes under: the zoom
        // buttons, the credits and the note ([[x0, y0, x1, y1]] in view pixels).
        function keepClear() {
            if (!streets) {
                return [];
            }
            var box = canvas.getBoundingClientRect();
            var list = [];
            // (.map-credit: the street maps' credit, and an export's GeoNames one.)
            var nodes = [zoomButtons, detailNote].concat(Array.prototype.slice.call(
                document.querySelectorAll(".map-credit")));
            nodes.forEach(function (node) {
                if (!node || node.hidden) {
                    return;
                }
                var r = node.getBoundingClientRect();
                if (r.width && r.height) {
                    list.push([r.left - box.left - 2, r.top - box.top - 2,
                               r.right - box.left + 2, r.bottom - box.top + 2]);
                }
            });
            return list;
        }

        /* The street maps' index is in (or could not be loaded): how deep the
           maps go is known now. A fit made before is made again (it may go
           deeper, or less deep), unless the map was moved since. */
        function streetsChanged() {
            if (streetsKnown || !basemap) {
                return;
            }
            var deepest = basemap.maxZoom();
            if (deepest !== null && !basemap.ready()) {
                return;                 // (still loading)
            }
            streetsKnown = true;
            MAX_ZOOM = Math.max(BASE_MAX_ZOOM, deepest === null ? 0 : deepest);
            FIT_ZOOM = deepest === null ? TILE_ZOOM : Math.max(TILE_ZOOM, basemap.fitZoom());
            if (autoFitted && loadState === "ready") {
                fit();
            } else if (view.zoom > MAX_ZOOM) {
                setView(view.lat, view.lon, MAX_ZOOM);
            }
        }

        /* Pins */

        function groupsNow() {
            if (groupsCache.zoom !== view.zoom || groupsCache.version !== locationsVersion) {
                groupsCache = {zoom: view.zoom, version: locationsVersion,
                               groups: cluster(pinLocations, width())};
                markPicked();
            }
            return groupsCache.groups;
        }

        function markPicked() {
            groupsCache.groups.forEach(function (group) {
                group.picked = Boolean(selection) && group.ids.some(function (id) {
                    return selection.picked[id] === true;
                });
            });
        }

        function drawPinsNow(at) {
            var list = screenPins(groupsNow(), at.left, at.top, view.w, view.h, at.w);
            drawPins(ctx, list);
            pins = list;
        }

        /* Routes */

        // The lines of the routes (ROUTES.lines) of the clips the search found.
        function applyRoutes() {
            routeLines = [];
            routeCount = 0;
            onRoutes = {};
            if (allRoutes && typeof ROUTES !== "undefined") {
                allRoutes.routes.forEach(function (route) {
                    var found = ROUTES.lines(route, function (id) {
                        return rank[id] !== undefined;
                    });
                    found.forEach(function (line) {
                        routeLines.push(line);
                        line.forEach(function (point) {
                            onRoutes[point.clip] = true;
                        });
                    });
                    routeCount += found.length ? 1 : 0;
                });
            }
            pinLocations = locations.filter(function (point) {
                return !(showRoutes && onRoutes[point.id]);
            });
            if (routesBox) {
                routesBox.hidden = !routeLines.length;
            }
            routesVersion += 1;
            setHoverRoute(null);
        }

        // The lines in world pixels at this zoom (each point the copy of the
        // world nearest the one before it).
        function projectedRoutes() {
            if (routeCache.zoom !== view.zoom || routeCache.version !== routesVersion) {
                var w = width();
                routeCache = {zoom: view.zoom, version: routesVersion,
                              lines: routeLines.map(function (line) {
                                  var before = null;
                                  return line.map(function (point) {
                                      var at = project(point.lat, point.lon, w);
                                      var x = before === null ? at.x : nearestCopy(at.x, before, w);
                                      before = x;
                                      return {x: x, y: at.y, point: point};
                                  });
                              })};
            }
            return routeCache.lines;
        }

        function drawRoutes(at) {
            routesDrawn = [];
            if (!showRoutes || !routeLines.length) {
                return;
            }
            var middle = at.left + view.w / 2;
            routesDrawn = projectedRoutes().map(function (line) {
                var shift = nearestCopy(line[0].x, middle, at.w) - line[0].x - at.left;
                return line.map(function (entry) {
                    return {sx: entry.x + shift, sy: entry.y - at.top, clip: entry.point.clip,
                            at: entry.point.at};
                });
            });
            var stroke = function (lines, lineWidth, colour) {
                ROUTES.strokeLines(ctx, lines, lineWidth, colour);
            };
            stroke(routesDrawn, 5.5, ROUTES.HALO);
            stroke(routesDrawn, 3, ROUTES.LINE);
            if (hoverRoute) {
                // The clip under the pointer, bright on a dark casing (seen on the
                // world image and the light street maps alike), and the place on it.
                var hovered = routesDrawn.map(function (line) {
                    return line.filter(function (point) {
                        return point.clip === hoverRoute.clip;
                    });
                }).filter(function (line) {
                    return line.length;
                });
                stroke(hovered, 8.5, ROUTES.CASING);
                stroke(hovered, 5, ROUTES.CURRENT);
                ctx.beginPath();
                ctx.arc(hoverRoute.sx, hoverRoute.sy, 5, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(214, 58, 58, 0.98)";
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#ffffff";
                ctx.stroke();
            }
        }

        // The place on a route line at a screen point, or null.
        function routeAt(x, y, slack) {
            if (!routesDrawn.length || typeof ROUTES === "undefined") {
                return null;
            }
            return ROUTES.nearest(routesDrawn, x, y, slack + 2);
        }

        // "Drive \u00b7 clip 3 of 12 \u00b7 0:41" (the clip's place in its drive as the
        // search page shows it, and the time into it) of a place on a route.
        function routeWords(hit) {
            var rec = indexById[hit.clip];
            var drive = driveOf(hit.clip);
            var title = (drive && drive.text !== null && indexById[drive.text] &&
                         indexById[drive.text].dvt) || "Drive";
            var parts = [title];
            if (drive) {
                parts.push("clip " + (drive.clips.indexOf(hit.clip) + 1) + " of " +
                           drive.clips.length);
            } else if (rec && rec.t) {
                parts.push(rec.t);
            }
            var seconds = Math.max(0, Math.round(hit.at));
            parts.push(Math.floor(seconds / 60) + ":" + (seconds % 60 < 10 ? "0" : "") +
                       (seconds % 60) + " in");
            return parts.join(" \u00b7 ");
        }

        function setHoverRoute(hit) {
            var before = hoverRoute;
            hoverRoute = hit;
            if (routeTip) {
                routeTip.hidden = !hit;
                if (hit) {
                    routeTip.textContent = routeWords(hit) + " \u2014 click to play from here";
                    routeTip.style.left = Math.round(Math.min(hit.sx + 14,
                                                              Math.max(0, view.w - 260))) + "px";
                    routeTip.style.top = Math.round(Math.max(0, hit.sy - 36)) + "px";
                }
            }
            if (before !== hit && (before || hit)) {
                scheduleDraw();
            }
        }

        // The viewer on the clip at a place on a route, that far into it.
        function openRoute(hit) {
            var rec = indexById[hit.clip];
            if (!rec) {
                return;
            }
            var drive = driveOf(hit.clip);
            var ids = drive ? drive.clips : [hit.clip];
            closePanel(false);
            showViewer(ids, Math.max(0, ids.indexOf(hit.clip)),
                       {id: hit.clip, seconds: hit.at});
        }

        var dirty = false;

        function scheduleDraw() {
            if (dirty) {
                return;
            }
            dirty = true;
            window.requestAnimationFrame(draw);
        }

        function draw() {
            dirty = false;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = OCEAN;
            ctx.fillRect(0, 0, view.w, view.h);
            var at = corner();
            drawTiles(at);
            drawRoutes(at);
            drawArea(at);
            drawPinsNow(at);
            drawTarget();
        }

        /* With the keyboard, Enter lists the pictures of the pin nearest
           the middle: while the map has the keyboard's focus, that pin has
           a ring (and its count is read out), and a small cross marks the
           middle. */
        function keyboardFocus() {
            if (document.activeElement !== canvas || usedBy === "pointer") {
                return false;
            }
            if (usedBy === "key") {
                return true;
            }
            try {
                return canvas.matches(":focus-visible");
            } catch (error) {
                return false;                   // (a browser without :focus-visible)
            }
        }

        // (The browser may keep showing the focus ring after a click when
        // the focus had come by keyboard: style.css hides it then.)
        function setUsedBy(value) {
            if (usedBy !== value) {
                usedBy = value;
                canvas.classList.toggle("pointer-used", value === "pointer");
                scheduleDraw();
            }
        }

        function drawTarget() {
            var focused = keyboardFocus();
            var pin = focused ? nearestPin() : null;
            announceTarget(focused, pin);
            if (!focused) {
                return;
            }
            var cx = Math.round(view.w / 2) + 0.5;
            var cy = Math.round(view.h / 2) + 0.5;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(cx - 7, cy);
            ctx.lineTo(cx + 7, cy);
            ctx.moveTo(cx, cy - 7);
            ctx.lineTo(cx, cy + 7);
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(12, 17, 24, 0.8)";
            ctx.stroke();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
            if (pin) {
                ctx.beginPath();
                ctx.arc(pin.sx, pin.sy, pin.r + 8, 0, Math.PI * 2);
                ctx.lineWidth = 4;
                ctx.strokeStyle = "rgba(12, 17, 24, 0.85)";
                ctx.stroke();
                ctx.setLineDash([5, 4]);
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#ffffff";
                ctx.stroke();
            }
            ctx.restore();
        }

        // The group last read out (undefined: the map has no keyboard focus).
        var announced;
        var announceTimer = 0;

        function announceTarget(focused, pin) {
            var group = focused ? (pin ? pin.group : null) : undefined;
            if (group === announced) {
                return;
            }
            announced = group;
            window.clearTimeout(announceTimer);
            if (group === undefined) {
                targetNote.textContent = "";
                return;
            }
            announceTimer = window.setTimeout(function () {
                targetNote.textContent = group
                    ? "Nearest pin: " + fmt.plural(group.count, "picture") + ". Enter lists them."
                    : "No pins in sight.";
            }, 400);
        }

        /* Messages */

        function noteButton(text, onClick) {
            return el("button", {type: "button", className: "button primary", text: text,
                                 on: {click: onClick}});
        }

        function showMessage(title, lines, actions) {
            clear(messageBox);
            if (!title) {
                messageBox.hidden = true;
                return;
            }
            messageBox.appendChild(el("h2", {text: title}));
            (lines || []).forEach(function (line) {
                messageBox.appendChild(el("p", {text: line}));
            });
            if (actions && actions.length) {
                messageBox.appendChild(el("div", {className: "map-message-actions"}, actions));
            }
            messageBox.hidden = false;
        }

        function filtered() {
            return Boolean(search.q || Object.keys(search.filters).length || SHELL.library() ||
                           search.area);
        }

        function renderStatus() {
            if (loadState === "loading") {
                statusBar.textContent = "Loading the pictures\u2026";
                showMessage(null);
                return;
            }
            if (loadState === "failed") {
                statusBar.textContent = "";
                showMessage("The pictures could not be loaded",
                            [SITE.isStatic ? "Some files of this site may be missing."
                                : "Is the server still running?"],
                            [noteButton("Try again", load)]);
                return;
            }
            var count = locations.length;
            var estimated = locations.filter(function (point) {
                return point.e;
            }).length;
            if (count) {
                // (With words or filters too: the matching ones.)
                var narrowed = Boolean(search.q || Object.keys(search.filters).length ||
                                       SHELL.library() || search.from || search.to);
                statusBar.textContent = (search.area ? fmt.plural(
                    count, narrowed ? "matching picture" : "picture") + " in this area"
                    : filtered() && matchCount > count
                        ? fmt.number(count) + " of " + fmt.plural(matchCount, "matching picture") +
                          " have a location"
                        : fmt.plural(count, "picture") + " with a location") +
                    (estimated ? " (" + fmt.number(estimated) + " estimated)" : "") +
                    (routeCount && showRoutes ? " \u00b7 " + fmt.plural(routeCount, "drive route")
                        : "");
                showMessage(null);
                return;
            }
            if (search.area) {
                // (No card over the map: the area is in sight, to draw again. A
                // place named without a position is in no area: said so.)
                var elsewhere = areaElsewhere && areaElsewhere.total && areaElsewhere.placed === 0
                    ? areaElsewhere.total : 0;
                statusBar.textContent = matchCount
                    ? fmt.plural(matchCount, "picture") + " of this area " +
                      (matchCount === 1 ? "has" : "have") + " only an estimated place: " +
                      "Show estimated places shows " + (matchCount === 1 ? "it" : "them")
                    : elsewhere === 1 ? "The picture that matches has no position, so it is " +
                      "in no area of the map"
                        : elsewhere ? "None of the " + fmt.plural(elsewhere, "picture") +
                          " that match has a position, so none is in an area of the map"
                            : "No pictures in this area";
                showMessage(null);
                return;
            }
            statusBar.textContent = "";
            var back = el("a", {className: "button", href: SITE.searchUrl(searchLinkState()),
                                text: "Back to search"});
            if (filtered() && matchCount) {
                // ("position": a picture may have a place without one, see
                // place_estimates.file_place.)
                showMessage(matchCount === 1 ? "The picture that matches has no position"
                    : "None of the " + fmt.plural(matchCount, "picture") + " that match " +
                      "have a position",
                            ["Only pictures with a GPS position in their file are on the map " +
                             "(a place named without a position has no pin)."],
                            [back]);
            } else if (filtered()) {
                showMessage("No pictures match this search", [], [back]);
            } else {
                showMessage("No pictures with a location yet",
                            ["Pictures appear on the map when their files hold a GPS position " +
                             "(most phone photos do)."], []);
            }
        }

        /* Links */

        // The search for links back to the search page: this one, without
        // a list of pictures, at this view.
        function searchLinkState() {
            var state = SITE.searchState.read();
            state.lib = SHELL.library();
            state.size = "";
            state.ids = "";
            state.view = formatView(view);
            return state;
        }

        function updateLinks() {
            var url = SITE.searchUrl(searchLinkState());
            document.getElementById("map-back").href = url;
            var searchLink = SHELL.navLink ? SHELL.navLink("search") : null;
            if (searchLink) {
                searchLink.href = url;
            }
            updateGridLink();
        }

        function updateGridLink() {
            if (!selection) {
                return;
            }
            var text = SITE.idList.encode(selection.ids, records);
            gridLink.textContent = selection.ids.length === 1 ? "Show it in the grid"
                : "Show these in the grid";
            if (text && text.length <= SITE.idList.maxLength()) {
                var state = searchLinkState();
                state.ids = text;
                gridLink.href = SITE.searchUrl(state);
                gridLink.removeAttribute("aria-disabled");
                gridLink.classList.remove("is-disabled");
                gridNote.hidden = true;
            } else {
                gridLink.removeAttribute("href");
                gridLink.setAttribute("aria-disabled", "true");
                gridLink.classList.add("is-disabled");
                gridNote.textContent = "Too many pictures for one link: zoom in to pick fewer.";
                gridNote.hidden = false;
            }
        }

        /* The list of a pin's pictures */

        function byRank(a, b) {
            var ra = rank[a] === undefined ? Infinity : rank[a];
            var rb = rank[b] === undefined ? Infinity : rank[b];
            return ra - rb || (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
        }

        function panelItem(id, index) {
            var rec = indexById[id] || {i: id};
            var link = el("a", {className: "map-panel-item",
                                href: SITE.detailUrl(id, searchLinkState())});
            link.setAttribute("data-index", String(index));
            var image = el("img", {alt: "", src: SITE.thumbUrl(rec), loading: "lazy",
                                   draggable: false});
            image.decoding = "async";
            link.appendChild(image);
            var text = el("span", {className: "map-panel-text"});
            text.appendChild(el("span", {className: "map-panel-name",
                                         text: rec.t || rec.n || VIEWER.altText(rec) ||
                                             "Picture"}));
            var date = VIEWER.format.shortDate(rec.dk);
            if (date) {
                text.appendChild(el("span", {className: "map-panel-date", text: date}));
            }
            var named = VIEWER.format.namedPlace(rec);
            if (named) {
                text.appendChild(el("span", {className: "map-panel-place", text: named,
                                             title: VIEWER.format.namedPlaceNote(rec)}));
            }
            if (estimatedIds[id]) {
                link.classList.add("is-estimated");
                text.appendChild(el("span", {className: "map-panel-date",
                                             text: "Estimated place"}));
            }
            link.appendChild(text);
            link.addEventListener("click", function (event) {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey ||
                        event.altKey) {
                    return;
                }
                event.preventDefault();
                openViewer(index);
            });
            return el("li", {}, [link]);
        }

        function showMore() {
            var end = Math.min(selection.ids.length, selection.shown + PANEL_PAGE);
            for (var k = selection.shown; k < end; k++) {
                panelList.appendChild(panelItem(selection.ids[k], k));
            }
            selection.shown = end;
            var left = selection.ids.length - end;
            panelMore.hidden = left <= 0;
            panelMore.textContent = "Show " + fmt.number(Math.min(left, PANEL_PAGE)) + " more";
        }

        /* The list covers part of the map (the left side; on a phone the
           foot): a pin it would hide moves into the part still in sight. */
        function keepInSight(group) {
            var at = corner();
            var xs = copies(group.x, at.left, view.w, at.w, 0);
            if (!xs.length) {
                return;
            }
            var sx = xs.reduce(function (best, x) {
                return Math.abs(x - view.w / 2) < Math.abs(best - view.w / 2) ? x : best;
            });
            var sy = group.y - at.top;
            var stage = canvas.getBoundingClientRect();
            var box = panel.getBoundingClientRect();
            var left = box.left - stage.left;
            var right = box.right - stage.left;
            var top = box.top - stage.top;
            var bottom = box.bottom - stage.top;
            var margin = group.r + 12;
            if (sx + margin < left || sx - margin > right || sy + margin < top ||
                    sy - margin > bottom) {
                return;
            }
            var sheet = right - left >= view.w * 0.9 && top > 0;
            var x = sheet ? view.w / 2 : right + (view.w - right) / 2;
            var y = sheet ? top / 2 : view.h / 2;
            panBy(x - sx, y - sy);
        }

        // " \u00b7 Harbour Aquarium": the named place more than half of a pin's
        // pictures were taken at, for the list's title, or "".
        function panelPlace(ids) {
            var counts = Object.create(null);
            var best = "";
            ids.forEach(function (id) {
                var name = VIEWER.format.namedPlace(indexById[id]);
                if (name) {
                    counts[name] = (counts[name] || 0) + 1;
                    if (!best || counts[name] > counts[best]) {
                        best = name;
                    }
                }
            });
            return best && counts[best] * 2 > ids.length ? " \u00b7 " + best : "";
        }

        function openPanel(group, byKeyboard) {
            var ids = group.ids.slice().sort(byRank);
            var picked = {};
            ids.forEach(function (id) {
                picked[id] = true;
            });
            // point: where the list's pin is, to open it again after a change.
            selection = {ids: ids, picked: picked, shown: 0,
                         point: unproject(group.x, group.y, width())};
            markPicked();
            clear(panelList);
            panelTitle.textContent = fmt.plural(ids.length, "picture") + panelPlace(ids);
            panelList.scrollTop = 0;
            showMore();
            updateGridLink();
            panel.hidden = false;
            document.body.classList.add("map-panel-open");
            SHELL.setState({pin: formatPoint(unproject(group.x, group.y, width()))});
            keepInSight(group);
            scheduleDraw();
            if (byKeyboard) {
                panelTitle.focus();
            }
        }

        function closePanel(returnFocus) {
            if (panel.hidden) {
                return;
            }
            panel.hidden = true;
            document.body.classList.remove("map-panel-open");
            SHELL.setState({pin: null});
            selection = null;
            markPicked();
            clear(panelList);
            scheduleDraw();
            if (returnFocus) {
                canvas.focus({preventScroll: true});
            }
        }

        panelMore.addEventListener("click", function () {
            if (selection) {
                showMore();
            }
        });
        document.getElementById("map-panel-close").addEventListener("click", function () {
            closePanel(true);
        });
        gridLink.addEventListener("click", function (event) {
            if (gridLink.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
                return;
            }
            if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
                    !event.altKey) {
                // Tells the search page it was opened from here, so its "Back
                // to the map" goes back in the history (to the map as it was,
                // its list open). A page opened from disk has no referrer.
                try {
                    window.sessionStorage.setItem(FROM_MAP_KEY, gridLink.href);
                } catch (error) {
                    // (No storage: the search page goes by the referrer.)
                }
            }
        });

        /* The viewer, over the map, for the pictures of the list */

        function visibility() {
            return {library: SHELL.library() || "", hidden: adminOn && search.hidden,
                    sensitive: search.sensitive || undefined, junk: search.junk};
        }

        // (A new search: without this view, so its map fits it.)
        function chipUrl(group, value) {
            return SITE.searchUrl(chipState(searchLinkState(), group, value));
        }

        function libraryName(id) {
            if (indexLibraries.length < 2) {
                return "";
            }
            var name = "";
            indexLibraries.forEach(function (library) {
                if (library.id === id) {
                    name = library.name;
                }
            });
            return name;
        }

        function hashWithId(id) {
            return window.location.pathname + window.location.search +
                (id === null ? "" : "#id=" + encodeURIComponent(id));
        }

        function openViewer(index) {
            if (!selection) {
                return;
            }
            showViewer(selection.ids, index, null);
        }

        /* The drive of a clip as the viewer plays it (its driveOf): the
           clips of its drive the search may show, in order, or null. */
        function driveOf(id) {
            var rec = indexById[id];
            if (!rec || rec.dv === undefined || rec.dv === null || !searchIndex) {
                return null;
            }
            var clips = searchIndex.driveClips(rec.dv, visibility());
            if (clips.length < 2 || clips.indexOf(id) < 0) {
                return null;
            }
            var text = null;
            clips.forEach(function (clipId) {
                var clip = indexById[clipId];
                if (text === null && clip && (clip.dvt || clip.dvd ||
                                              (clip.dvg && clip.dvg.length))) {
                    text = clipId;
                }
            });
            return {key: rec.dv, clips: clips, text: text, matched: {}, folded: false};
        }

        // The viewer on ids from index (startAt: VIEWER.open's).
        function showViewer(ids, index, startAt) {
            var opened = VIEWER.open({
                ids: ids,
                index: index,
                startAt: startAt,
                driveOf: driveOf,
                get: function (id) {
                    return indexById[id] || null;
                },
                query: interpreted ? interpreted.query : search.q,
                libraryName: libraryName,
                similar: searchIndex ? function (id) {
                    // ("More like this" goes by meaning once the vectors are
                    // there: loaded when first wanted.)
                    if (!vectorsWanted) {
                        vectorsWanted = true;
                        SITE.attachVectors(searchIndex);
                    }
                    return SearchCore.similar(searchIndex, id, 8, visibility());
                } : null,
                chipUrl: chipUrl,
                detailUrl: function (id) {
                    return SITE.detailUrl(id, searchLinkState());
                },
                onShow: function (id) {
                    if (viewerPushed) {
                        window.history.replaceState({mapViewer: true}, "", hashWithId(id));
                    }
                },
                onClose: function (id) {
                    if (viewerPushed) {
                        viewerPushed = false;
                        window.history.back();
                    }
                    var at = selection ? selection.ids.indexOf(id) : -1;
                    var item = at < 0 ? null : panelList.querySelector('a[data-index="' + at + '"]');
                    if (item) {
                        item.focus({preventScroll: false});
                    }
                },
                onHidden: function () {
                    // Hidden (or shown again) from the viewer: the pins, the
                    // open list and its grid link follow, as the grid does.
                    if (selection && selection.point) {
                        startPin = selection.point;
                    }
                    applySearch(false);
                },
                // The picture's albums, and the album picker's list.
                albums: function () {
                    return indexAlbums;
                },
                onMarked: function () {
                    // (A search of favorites, a rating or an album may change.)
                    if (selection && selection.point) {
                        startPin = selection.point;
                    }
                    applySearch(false);
                },
                onEdited: function () {
                    // A record changed in place (an edit; a GPS position used
                    // or ignored, which may move other pictures too): the
                    // search sees it, and the pins come from the server again.
                    searchIndex = SearchCore.prepare(records);
                    if (vectorsWanted) {
                        SITE.attachVectors(searchIndex);
                    }
                    SITE.loadLocations(function (loaded) {
                        if (loaded) {
                            allLocations = loaded;
                        }
                        placeIndex();
                        if (selection && selection.point) {
                            startPin = selection.point;
                        }
                        applySearch(false);
                    });
                }
            });
            if (opened) {
                // Back closes the viewer (and not the map).
                window.history.pushState({mapViewer: true}, "", hashWithId(ids[index]));
                viewerPushed = true;
            }
        }

        window.addEventListener("popstate", function () {
            if (VIEWER.isOpen() && !/(?:^#|&)id=/.test(window.location.hash || "")) {
                viewerPushed = false;
                VIEWER.close();
            }
        });

        /* Mouse */

        var drag = null;

        function rectPoint(event) {
            var rect = canvas.getBoundingClientRect();
            return {x: event.clientX - rect.left, y: event.clientY - rect.top};
        }

        function clickAt(x, y, slack) {
            if (areaMode === "pick") {
                pickAt(x, y, slack > MOUSE_SLACK ? PICK_TOUCH_SLACK : PICK_SLACK);
                return;
            }
            if (areaMode) {
                return;
            }
            hideMenu();
            var hit = hitPin(pins, x, y, slack);
            if (hit) {
                openPanel(hit.group, false);
                return;
            }
            var onRoute = routeAt(x, y, slack);
            if (onRoute) {
                setHoverRoute(null);
                openRoute(onRoute);
            } else {
                closePanel(false);
            }
        }

        // (preventDefault keeps a drag from selecting text, and also stops
        // the click from moving the focus: the map takes it itself, so its
        // keys work after a click even when the list had the focus.)
        function takeFocus() {
            if (document.activeElement !== canvas) {
                canvas.focus({preventScroll: true});
            }
            setUsedBy("pointer");
        }

        canvas.addEventListener("mousedown", function (event) {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            takeFocus();
            var p = rectPoint(event);
            if (areaMode === "box" || areaMode === "draw") {
                sketchStart(p);
                sketch.mouse = true;
                return;
            }
            drag = {downX: p.x, downY: p.y, lastX: p.x, lastY: p.y, moved: false};
        });

        window.addEventListener("mousemove", function (event) {
            var p = rectPoint(event);
            if (!drag) {
                if (event.target === canvas) {
                    var overPin = Boolean(hitPin(pins, p.x, p.y, MOUSE_SLACK));
                    var overRoute = overPin ? null : routeAt(p.x, p.y, MOUSE_SLACK);
                    canvas.classList.toggle("over-pin", overPin || Boolean(overRoute));
                    setHoverRoute(overRoute);
                } else if (hoverRoute) {
                    setHoverRoute(null);
                }
                return;
            }
            if (hoverRoute) {
                setHoverRoute(null);
            }
            if (Math.abs(p.x - drag.downX) + Math.abs(p.y - drag.downY) > 3) {
                drag.moved = true;
            }
            if (drag.moved) {
                panBy(p.x - drag.lastX, p.y - drag.lastY);
            }
            drag.lastX = p.x;
            drag.lastY = p.y;
        });

        // (Drawing an area: the mouse draws instead of moving the map.)
        window.addEventListener("mousemove", function (event) {
            if (sketch && sketch.mouse) {
                sketchMove(rectPoint(event));
            }
        });

        window.addEventListener("mouseup", function (event) {
            if (sketch && sketch.mouse) {
                sketchMove(rectPoint(event));
                sketchDone();
                return;
            }
            if (!drag) {
                return;
            }
            if (!drag.moved) {
                var p = rectPoint(event);
                clickAt(p.x, p.y, MOUSE_SLACK);
            }
            drag = null;
        });

        canvas.addEventListener("wheel", function (event) {
            event.preventDefault();
            var move = wheel.feed(event);
            if (move.panX) {
                panBy(move.panX, 0);
            }
            if (move.steps) {
                var p = rectPoint(event);
                zoomAt(p.x, p.y, view.zoom + move.steps);
            }
        }, {passive: false});

        canvas.addEventListener("dblclick", function (event) {
            event.preventDefault();
            var p = rectPoint(event);
            zoomAt(p.x, p.y, view.zoom + (event.shiftKey ? -1 : 1));
        });

        /* Touch */

        var touchState = null;
        var lastTap = null;

        function touchPoint(touch) {
            var rect = canvas.getBoundingClientRect();
            return {x: touch.clientX - rect.left, y: touch.clientY - rect.top};
        }

        function touchList(event) {
            var out = [];
            for (var k = 0; k < event.touches.length; k++) {
                out.push(touchPoint(event.touches[k]));
            }
            return out;
        }

        function spread(a, b) {
            return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
        }

        function middle(a, b) {
            return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
        }

        canvas.addEventListener("touchstart", function (event) {
            event.preventDefault();
            takeFocus();
            var touches = touchList(event);
            if (touches.length === 1 && (areaMode === "box" || areaMode === "draw")) {
                // (One finger draws the area; two still move the map.)
                sketchStart(touches[0]);
                touchState = {kind: "sketch"};
            } else if (touches.length === 1) {
                touchState = {kind: "pan", lastX: touches[0].x, lastY: touches[0].y,
                              downX: touches[0].x, downY: touches[0].y, moved: false};
            } else if (touches.length >= 2) {
                sketch = null;
                touchState = {kind: "pinch", startSpread: spread(touches[0], touches[1]),
                              startZoom: view.zoom, lastMid: middle(touches[0], touches[1]),
                              moved: true};
            }
        }, {passive: false});

        canvas.addEventListener("touchmove", function (event) {
            event.preventDefault();
            if (!touchState) {
                return;
            }
            var touches = touchList(event);
            if (touchState.kind === "sketch" && sketch && touches.length === 1) {
                sketchMove(touches[0]);
            } else if (touchState.kind === "pan" && touches.length === 1) {
                var p = touches[0];
                if (Math.abs(p.x - touchState.downX) + Math.abs(p.y - touchState.downY) > 6) {
                    touchState.moved = true;
                }
                if (touchState.moved) {
                    panBy(p.x - touchState.lastX, p.y - touchState.lastY);
                }
                touchState.lastX = p.x;
                touchState.lastY = p.y;
            } else if (touchState.kind === "pinch" && touches.length >= 2) {
                var mid = middle(touches[0], touches[1]);
                panBy(mid.x - touchState.lastMid.x, mid.y - touchState.lastMid.y);
                touchState.lastMid = mid;
                var ratio = spread(touches[0], touches[1]) / Math.max(1, touchState.startSpread);
                zoomAt(mid.x, mid.y, touchState.startZoom + Math.log(ratio) / Math.LN2);
            }
        }, {passive: false});

        canvas.addEventListener("touchend", function (event) {
            event.preventDefault();
            if (touchState && touchState.kind === "sketch") {
                sketchDone();
                touchState = event.touches.length ? {kind: "done"} : null;
                return;
            }
            if (touchState && touchState.kind === "pan" && !touchState.moved) {
                var now = Date.now();
                // A second tap within 300 ms near the first zooms in.
                if (lastTap && now - lastTap.t < 300 && Math.abs(lastTap.x - touchState.downX) < 30 &&
                        Math.abs(lastTap.y - touchState.downY) < 30) {
                    zoomAt(touchState.downX, touchState.downY, view.zoom + 1);
                    lastTap = null;
                } else {
                    lastTap = {t: now, x: touchState.downX, y: touchState.downY};
                    clickAt(touchState.downX, touchState.downY, TOUCH_SLACK);
                }
            }
            if (event.touches.length === 0) {
                touchState = null;
            } else if (event.touches.length === 1) {
                var t = touchPoint(event.touches[0]);
                touchState = {kind: "pan", lastX: t.x, lastY: t.y, downX: t.x, downY: t.y,
                              moved: true};
            }
        }, {passive: false});

        /* Keyboard: + and - zoom, arrows move, Enter lists the pictures of the
           pin nearest the centre (on the map), Esc closes the list. */

        // (Of the pins whose middle is on the screen.)
        function nearestPin() {
            var best = null;
            var bestDistance = Infinity;
            pins.forEach(function (pin) {
                if (pin.sx < 0 || pin.sx > view.w || pin.sy < 0 || pin.sy > view.h) {
                    return;
                }
                var dx = pin.sx - view.w / 2;
                var dy = pin.sy - view.h / 2;
                var distance = dx * dx + dy * dy;
                if (distance < bestDistance) {
                    best = pin;
                    bestDistance = distance;
                }
            });
            return best;
        }

        document.addEventListener("keydown", function (event) {
            if (VIEWER.isOpen() || event.ctrlKey || event.metaKey || event.altKey) {
                return;
            }
            var target = event.target;
            var tag = target && target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
                    (target && target.isContentEditable)) {
                return;
            }
            var inPanel = panel.contains(target);
            var stepX = Math.max(40, Math.round(view.w / (event.shiftKey ? 2 : 6)));
            var stepY = Math.max(40, Math.round(view.h / (event.shiftKey ? 2 : 6)));
            var key = event.key;
            if (key === "Escape" && (sketch || (areaMenu && !areaMenu.hidden) ||
                                     (areaTools && !areaTools.hidden))) {
                // (The area being drawn, the menu, the tool chosen, then the tools.)
                if (sketch) {
                    sketch = null;
                    scheduleDraw();
                } else if (areaMenu && !areaMenu.hidden) {
                    hideMenu();
                } else if (areaMode) {
                    setMode("");
                } else {
                    closeTools(true);
                }
            } else if (key === "Escape") {
                if (panel.hidden) {
                    return;
                }
                closePanel(true);
            } else if (inPanel || (areaTools && areaTools.contains(target)) ||
                       (areaMenu && areaMenu.contains(target))) {
                return;
            } else if (key === "+" || key === "=") {
                zoomAt(view.w / 2, view.h / 2, view.zoom + 1);
            } else if (key === "-" || key === "_") {
                zoomAt(view.w / 2, view.h / 2, view.zoom - 1);
            } else if (key === "ArrowLeft") {
                panBy(stepX, 0);
            } else if (key === "ArrowRight") {
                panBy(-stepX, 0);
            } else if (key === "ArrowUp") {
                panBy(0, stepY);
            } else if (key === "ArrowDown") {
                panBy(0, -stepY);
            } else if ((key === "Enter" || key === " ") && target === canvas) {
                var pin = nearestPin();
                if (pin) {
                    openPanel(pin.group, true);
                }
            } else {
                return;
            }
            event.preventDefault();
            if (target === canvas) {
                setUsedBy("key");
            }
        });

        canvas.addEventListener("focus", scheduleDraw);
        canvas.addEventListener("blur", function () {
            setUsedBy("");
            scheduleDraw();
        });

        /* Buttons */

        document.getElementById("zoom-in").addEventListener("click", function () {
            zoomAt(view.w / 2, view.h / 2, view.zoom + 1);
        });
        document.getElementById("zoom-out").addEventListener("click", function () {
            zoomAt(view.w / 2, view.h / 2, view.zoom - 1);
        });

        /* An area of the map: the search by drawing on the map

           "Search an area" opens a strip of tools over the map: Rectangle
           (drag across the map), Draw (draw around it; letting go closes
           it), Street or place (click or tap one on the street maps, or find
           one by name among those of the view -- a street with some metres
           either side, an outlined area such as a park, a point of interest
           with a circle around it: STREETS.Picker) and This view (the
           rectangle the map shows; the keyboard's way too). The area becomes
           part of the search (the address's area= and aname=, SearchCore's
           area option): only the pictures taken in it keep their pins, the
           rest of the map is veiled, and a chip in the bar names it, with an
           x that takes it away. The search page, smart albums and an export
           that publishes locations keep it. Two fingers still move the map
           while drawing; Esc stops. */

        var areaButton = document.getElementById("map-area-button");
        var areaTools = document.getElementById("map-area-tools");
        var areaHint = document.getElementById("map-area-hint");
        var areaFind = document.getElementById("map-area-find");
        var areaInput = document.getElementById("map-area-input");
        var areaList = document.getElementById("map-area-list");
        var areaMetres = document.getElementById("map-area-metres");
        var areaMenu = document.getElementById("map-area-menu");
        var areaChip = document.getElementById("map-area-chip");
        var areaModes = areaTools ? Array.prototype.slice.call(
            areaTools.querySelectorAll("[data-mode]")) : [];
        var picker = streets && STREETS.Picker ? new STREETS.Picker(streets) : null;
        var AREAS = SearchCore.areas;
        // Street or place works from this zoom on (closer, a click is precise).
        var PICK_ZOOM = 13;
        var PICK_SLACK = 10;
        var PICK_TOUCH_SLACK = 22;
        var NAMES_SHOWN = 40;
        // A free shape: a point every SKETCH_STEP pixels at most, its outline
        // simplified to within SKETCH_TOLERANCE pixels, at most SKETCH_POINTS
        // points while drawing; anything smaller than MIN_SKETCH pixels is no area.
        var SKETCH_STEP = 3;
        var SKETCH_TOLERANCE = 1.5;
        var SKETCH_POINTS = 4000;
        var MIN_SKETCH = 8;
        // A street or an area from the street maps is simplified to within this
        // many metres (a street's at most a quarter of its width either side).
        var PICK_TOLERANCE = 3;
        // The veil over the rest of the map: darker over the dark street maps.
        var VEIL = "rgba(12, 17, 24, 0.4)";
        var DARK_VEIL = "rgba(0, 0, 0, 0.55)";
        var EDGE = "rgba(255, 210, 63, 0.98)";
        var EDGE_CASING = "rgba(12, 17, 24, 0.85)";
        var HINTS = {
            "": "Drag a rectangle, draw around a place, or pick a street or a place of the " +
                "street maps; This view searches what the map shows now.",
            // (Without street maps: no picking; the admin is told where they come from.)
            plain: "Drag a rectangle or draw around a place; This view searches what the map " +
                "shows now." + (adminOn ? " Street maps (Manage, Street maps) let you pick a " +
                "street or a place too." : ""),
            box: "Drag across the map to draw a rectangle. Two fingers still move the map; " +
                "Esc stops.",
            draw: "Draw around the area with the mouse or a finger; letting go closes it. " +
                "Esc stops.",
            pick: "Click or tap a street, a park or a place of the street maps, or find one " +
                "by name in this view."
        };
        var areaMode = "";          // "", "box", "draw" or "pick"
        var sketch = null;          // being drawn: {kind, points: [{x, y}] (screen)}
        var named = null;           // the names of the view (Street or place)
        var namedFor = "";          // the view they are of
        var namedWhy = "";          // why there are none: "wait", "large" or "failed"
        var chosenWithFocus = false;    // a name chosen with the focus in the tools
        var namedShown = [];        // those in the list now
        var namedActive = -1;
        var namesTimer = 0;
        var picking = 0;            // the pick being read (its number)
        var veilCanvas = null;

        function currentArea() {
            return search.area ? AREAS.read(search.area) : null;
        }

        // True when the focus is in the tools or the Which one? menu.
        function focusInTools() {
            var focused = document.activeElement;
            return Boolean(focused && ((areaTools && areaTools.contains(focused)) ||
                                       (areaMenu && areaMenu.contains(focused))));
        }

        function renderAreaChip() {
            if (!areaChip) {
                return;
            }
            clear(areaChip);
            var label = search.area ? AREAS.label(search.area, search.aname) : "";
            areaChip.hidden = !label;
            // (A phone's bar keeps its rows: style.css, "map-has-area".)
            document.body.classList.toggle("map-has-area", Boolean(label));
            if (label) {
                var chip = el("button", {type: "button", className: "filter-chip",
                                         title: "Show every place again"},
                              [el("span", {text: "Area: " + label}),
                               el("span", {className: "filter-chip-x", text: "\u00d7",
                                           attrs: {"aria-hidden": "true"}})]);
                chip.setAttribute("aria-label", "Area: " + label + ": remove");
                chip.addEventListener("click", function () {
                    setArea("", "");
                    canvas.focus({preventScroll: true});
                });
                areaChip.appendChild(chip);
            }
            if (areaButton) {
                areaButton.textContent = label ? "Change the area" : "Search an area";
                areaButton.setAttribute("aria-label", label ? "Change the area of the map"
                    : "Search an area of the map");
            }
        }

        // The search limited to an area (its text; "" for none) named name
        // (keepTools: the tools stay as they are).
        function setArea(text, name, keepTools) {
            var area = text ? AREAS.read(text) : null;
            search.area = area ? area.text : "";
            search.aname = area ? AREAS.name(name) : "";
            SHELL.setState({area: search.area || null, aname: search.aname || null});
            // (Set from the tools with the keyboard -- This view, the list of names,
            // Which one? --: the focus goes to the new chip, not lost with the tools.)
            var fromTools = focusInTools() || chosenWithFocus;
            chosenWithFocus = false;
            if (!keepTools) {
                closeTools(false);
            }
            renderAreaChip();
            if (fromTools && !keepTools) {
                var chipButton = areaChip ? areaChip.querySelector("button") : null;
                (chipButton && !areaChip.hidden ? chipButton : areaButton || canvas)
                    .focus({preventScroll: true});
            }
            if (loadState === "ready") {
                applySearch(false);
            } else {
                updateLinks();
            }
            scheduleDraw();
        }

        /* The tools */

        function openTools() {
            if (!areaTools) {
                return;
            }
            areaTools.hidden = false;
            areaButton.setAttribute("aria-expanded", "true");
            document.body.classList.add("map-area-open");
            setMode("");
            var pick = areaTools.querySelector("[data-mode='pick']");
            if (pick) {
                // (No street maps here: the button goes, and the hint says nothing of it.)
                pick.hidden = !picker;
                pick.title = "Pick a street, a park or a place of the street maps";
            }
            showMetres();
            if (areaModes[0]) {
                areaModes[0].focus();
            }
        }

        function closeTools(returnFocus) {
            if (!areaTools || areaTools.hidden) {
                return;
            }
            setMode("");
            areaTools.hidden = true;
            areaButton.setAttribute("aria-expanded", "false");
            document.body.classList.remove("map-area-open");
            if (returnFocus) {
                areaButton.focus();
            }
        }

        function setHint(text) {
            if (areaHint) {
                areaHint.textContent = text;
            }
        }

        // The Within list as wide as the street searched now (an address's
        // width not among its choices becomes one).
        function showMetres() {
            var area = currentArea();
            if (!areaMetres || !area || area.kind !== "l" || !(area.metres > 0)) {
                return;
            }
            var value = String(Math.round(area.metres));
            var options = Array.prototype.slice.call(areaMetres.querySelectorAll("option"));
            var known = options.some(function (option) {
                return option.getAttribute("value") === value;
            });
            if (!known) {
                var added = el("option", {text: fmt.number(Number(value)) + " m",
                                          attrs: {value: value}});
                var before = options.filter(function (option) {
                    return Number(option.getAttribute("value")) > Number(value);
                })[0] || null;
                areaMetres.insertBefore(added, before);
            }
            areaMetres.value = value;
        }

        function setMode(mode) {
            areaMode = mode;
            sketch = null;
            picking += 1;
            hideMenu();
            areaModes.forEach(function (button) {
                button.setAttribute("aria-pressed",
                                    button.getAttribute("data-mode") === mode ? "true" : "false");
            });
            canvas.classList.toggle("drawing", mode === "box" || mode === "draw");
            canvas.classList.toggle("picking", mode === "pick");
            if (areaTools) {
                areaTools.classList.toggle("is-drawing", mode === "box" || mode === "draw");
            }
            if (areaFind) {
                areaFind.hidden = mode !== "pick";
            }
            setHint(mode ? HINTS[mode] || "" : picker ? HINTS[""] : HINTS.plain);
            if (mode === "pick") {
                listNames();
            }
            scheduleDraw();
        }

        // A screen point as a place; the longitude goes on past 180 (or -180)
        // so the points of one shape stay together across the date line.
        function screenPlace(sx, sy) {
            var at = corner();
            var place = unproject(at.left + sx, at.top + sy, at.w);
            return {lat: place.lat, lon: (at.left + sx) / at.w * 360 - 180};
        }

        // Screen pixels per metre at a latitude.
        function pixelsPerMetre(lat) {
            return width() / AREAS.worldScale(lat);
        }

        /* An area's text from parts in degrees, simplified (in world units,
           tolerance in metres at the first point) until it is short enough;
           "" when it cannot be made. */
        function fitText(kind, parts, metres, tolerance) {
            var lat = parts[0][0];
            var step = tolerance / AREAS.worldScale(lat);
            for (var tries = 0; tries < 12; tries++) {
                var simple = parts.map(function (part) {
                    var world = [];
                    for (var k = 0; k < part.length; k += 2) {
                        world.push((part[k + 1] + 180) / 360, AREAS.worldY(part[k]));
                    }
                    world = step > 0 ? AREAS.simplify(world, step) : world;
                    var out = [];
                    for (var j = 0; j < world.length; j += 2) {
                        out.push(AREAS.latitudeOf(world[j + 1]), world[j] * 360 - 180);
                    }
                    return out;
                }).filter(function (part) {
                    return kind !== "p" || part.length >= 6;
                });
                var text = simple.length ? AREAS.encode(kind, simple, metres) : "";
                if (text && text.length <= AREAS.MAX_TEXT) {
                    return text;
                }
                step = Math.max(step * 2, 1e-9);
            }
            return "";
        }

        /* A drawn line as a lasso: cut where it first crosses itself (the loop
           it closed there; a line that overshoots its start, or goes round
           twice, searches what the first loop holds), else as drawn. [{x, y}] */
        function lassoLoop(points) {
            for (var j = 2; j < points.length; j++) {
                var c = points[j - 1];
                var d = points[j];
                for (var i = 0; i < j - 2; i++) {
                    var a = points[i];
                    var b = points[i + 1];
                    var den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
                    if (!den) {
                        continue;
                    }
                    var t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
                    var u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
                    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                        var loop = [{x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y)}]
                            .concat(points.slice(i + 1, j));
                        if (loop.length >= 3) {
                            return loop;
                        }
                    }
                }
            }
            return points;
        }

        function sketchDone() {
            var drawn = sketch;
            sketch = null;
            scheduleDraw();
            if (!drawn || drawn.points.length < 2) {
                return;
            }
            if (drawn.kind !== "box") {
                drawn = {kind: drawn.kind, points: lassoLoop(drawn.points)};
            }
            var xs = drawn.points.map(function (point) {
                return point.x;
            });
            var ys = drawn.points.map(function (point) {
                return point.y;
            });
            var x0 = Math.min.apply(null, xs);
            var x1 = Math.max.apply(null, xs);
            var y0 = Math.min.apply(null, ys);
            var y1 = Math.max.apply(null, ys);
            if (x1 - x0 < MIN_SKETCH || y1 - y0 < MIN_SKETCH) {
                setHint("That is too small for an area: drag further.");
                return;
            }
            var text = "";
            if (drawn.kind === "box") {
                var sw = screenPlace(x0, y1);
                var ne = screenPlace(x1, y0);
                text = AREAS.encode("b", [[sw.lat, sw.lon, ne.lat, ne.lon]]);
            } else {
                var flat = [];
                drawn.points.forEach(function (point) {
                    flat.push(point.x, point.y);
                });
                var tolerance = SKETCH_TOLERANCE;
                for (var tries = 0; tries < 12 && !text; tries++) {
                    var simple = AREAS.simplify(flat, tolerance);
                    var ring = [];
                    for (var k = 0; k < simple.length; k += 2) {
                        var place = screenPlace(simple[k], simple[k + 1]);
                        ring.push(place.lat, place.lon);
                    }
                    if (ring.length < 6) {
                        break;
                    }
                    text = AREAS.encode("p", [ring]);
                    text = text.length <= AREAS.MAX_TEXT ? text : "";
                    tolerance *= 2;
                }
            }
            if (!text) {
                setHint("That shape could not be made into an area: try again.");
                return;
            }
            setArea(text, "");
        }

        function searchThisView() {
            var sw = screenPlace(0, view.h);
            var ne = screenPlace(view.w, 0);
            if (ne.lon - sw.lon >= 360) {
                sw.lon = -180;
                ne.lon = 179.99999;
            }
            var text = AREAS.encode("b", [[Math.max(-85, sw.lat), sw.lon, Math.min(85, ne.lat),
                                           ne.lon]]);
            if (text) {
                setArea(text, "");
            }
        }

        /* Street or place */

        function metresChosen() {
            var value = areaMetres ? Number(areaMetres.value) : 50;
            return value >= 1 && value <= AREAS.MAX_METRES ? value : 50;
        }

        function hideMenu() {
            if (areaMenu && !areaMenu.hidden) {
                areaMenu.hidden = true;
                clear(areaMenu);
            }
        }

        // "Pine Park \u00b7 park", with where it is when the view has two ("(north-west)").
        function itemText(item) {
            return item.name + " \u00b7 " + whatText(item);
        }

        function whatText(item) {
            return item.what + (item.near ? " (" + item.near + ")" : "");
        }

        // The pick of a list or the menu: read all of it, then search it.
        function choose(item) {
            // (The menu goes, and the focus with it: setArea puts it on the chip.)
            chosenWithFocus = focusInTools();
            hideMenu();
            if (!picker || !item) {
                return;
            }
            var number = picking += 1;
            setHint("Reading " + item.name + " from the street maps\u2026");
            picker.gather(item, function (found) {
                if (number !== picking) {
                    return;
                }
                if (!found || !found.parts.length) {
                    setHint("That could not be read from the street maps.");
                    return;
                }
                // (A place: the circle that holds the pictures it names, see
                // STREETS.placeWithin; Within shows it and changes it.)
                var metres = (found.kind === "place" && STREETS.placeWithin(found.type)) ||
                    metresChosen();
                var text = found.kind === "area" ? fitText("p", found.parts, 0, PICK_TOLERANCE)
                    : fitText("l", found.parts, metres, Math.min(PICK_TOLERANCE, metres / 4));
                if (!text) {
                    setHint("That is too large to search as one area.");
                    return;
                }
                setArea(text, found.name);
                if (found.cut) {
                    SHELL.toast("Only the part of " + found.name + " near where it was picked " +
                                "is searched (it goes on further).", "info");
                }
            });
        }

        function showMenu(x, y, list) {
            if (!areaMenu) {
                choose(list[0]);
                return;
            }
            clear(areaMenu);
            areaMenu.appendChild(el("p", {className: "map-area-menu-title", text: "Which one?"}));
            list.forEach(function (item) {
                areaMenu.appendChild(el("button", {type: "button", className: "map-area-option",
                                                   text: itemText(item), attrs: {role: "menuitem"},
                                                   on: {click: function () {
                                                       choose(item);
                                                   }}}));
            });
            areaMenu.hidden = false;
            var w = areaMenu.offsetWidth || 220;
            var h = areaMenu.offsetHeight || 40 * list.length;
            areaMenu.style.left = Math.round(Math.max(8, Math.min(x + 10, view.w - w - 8))) + "px";
            areaMenu.style.top = Math.round(Math.max(8, Math.min(y + 10, view.h - h - 8))) + "px";
            var first = areaMenu.querySelector("button");
            if (first) {
                first.focus({preventScroll: true});
            }
        }

        // A click or tap in Street or place: what is named there.
        function pickAt(x, y, slack) {
            hideMenu();
            if (!picker) {
                return;
            }
            if (view.zoom < PICK_ZOOM) {
                setHint("Zoom in further to pick a street or a place.");
                return;
            }
            var place = screenPlace(x, y);
            var lat = place.lat;
            var lon = normalizeLon(place.lon);
            var number = picking += 1;
            if (!picker.ready() && picker.whenReady) {
                // (Their index is not in yet: the pick waits for it.)
                setHint("Reading the street maps\u2026");
                picker.whenReady(function (ready) {
                    if (number !== picking) {
                        return;
                    }
                    if (ready) {
                        pickAt(x, y, slack);
                    } else {
                        setHint("The street maps could not be read.");
                    }
                });
                return;
            }
            setHint("Looking at the street maps there\u2026");
            picker.at(lat, lon, slack / pixelsPerMetre(lat), function (list) {
                if (number !== picking) {
                    return;
                }
                if (!list.length) {
                    setHint("Nothing with a name right there: try closer to a street or a name " +
                            "of the map.");
                } else if (list.length === 1) {
                    choose(list[0]);
                } else {
                    setHint(HINTS.pick);
                    showMenu(x, y, list.slice(0, 8));
                }
            });
        }

        // The names of the view, for the list (read again when the view changed).
        function listNames() {
            if (!picker || !areaFind) {
                return;
            }
            var key = formatView(view) + "/" + view.w + "x" + view.h;
            if (key === namedFor && named) {
                filterNames();
                return;
            }
            namedFor = key;
            named = null;
            namedWhy = "";
            filterNames();
            if (view.zoom < PICK_ZOOM) {
                return;
            }
            var sw = screenPlace(0, view.h);
            var ne = screenPlace(view.w, 0);
            picker.inView({south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon}, view.zoom,
                          function (list, why) {
                              if (namedFor !== key) {
                                  return;
                              }
                              if (list) {
                                  named = list;
                                  namedWhy = "";
                                  filterNames();
                                  return;
                              }
                              // (Not read: asked again on the next key or focus, and once
                              // the street maps' index is in.)
                              named = null;
                              namedFor = "";
                              namedWhy = why || "wait";
                              filterNames();
                              if (namedWhy === "wait" && picker.whenReady) {
                                  picker.whenReady(function (ready) {
                                      if (areaMode !== "pick") {
                                          return;
                                      }
                                      if (ready) {
                                          listNames();
                                      } else {
                                          namedWhy = "failed";
                                          filterNames();
                                      }
                                  });
                              }
                          });
        }

        function filterNames() {
            if (!areaList) {
                return;
            }
            clear(areaList);
            namedActive = -1;
            var typed = SearchCore.normalize(areaInput ? areaInput.value : "");
            var note = null;
            if (view.zoom < PICK_ZOOM || (!named && namedWhy === "large")) {
                note = "Zoom in further to list the streets and places of the view.";
            } else if (!named) {
                note = namedWhy === "failed" ? "The street maps could not be read."
                    : namedWhy === "wait" ? "Reading the street maps\u2026"
                        : "Reading the names of the view\u2026";
            }
            namedShown = [];
            if (!note && typed) {
                var starts = [];
                var within = [];
                named.forEach(function (item) {
                    var name = SearchCore.normalize(item.name);
                    var at = name.indexOf(typed);
                    if (at === 0) {
                        starts.push(item);
                    } else if (at > 0) {
                        within.push(item);
                    }
                });
                namedShown = starts.concat(within).slice(0, NAMES_SHOWN);
                if (!namedShown.length) {
                    note = "No street or place of the view is called that.";
                }
            } else if (!note) {
                note = fmt.plural(named.length, "name") + " in this view: type to find one.";
            }
            namedShown.forEach(function (item, index) {
                var option = el("li", {className: "map-area-name", id: "map-area-name-" + index,
                                       attrs: {role: "option", "aria-selected": "false"}},
                                [el("span", {text: item.name}),
                                 el("span", {className: "map-area-what",
                                             text: " \u00b7 " + whatText(item)})]);
                option.addEventListener("mousedown", function (event) {
                    event.preventDefault();
                });
                option.addEventListener("click", function () {
                    choose(item);
                });
                areaList.appendChild(option);
            });
            if (note) {
                areaList.appendChild(el("li", {className: "map-area-note", text: note,
                                               attrs: {role: "presentation"}}));
            }
            if (areaInput) {
                areaInput.setAttribute("aria-expanded", namedShown.length ? "true" : "false");
                areaInput.removeAttribute("aria-activedescendant");
            }
        }

        function markName(index) {
            var options = areaList ? areaList.querySelectorAll("[role='option']") : [];
            namedActive = Math.max(-1, Math.min(namedShown.length - 1, index));
            for (var k = 0; k < options.length; k++) {
                options[k].setAttribute("aria-selected", k === namedActive ? "true" : "false");
                options[k].classList.toggle("is-active", k === namedActive);
            }
            if (namedActive >= 0) {
                areaInput.setAttribute("aria-activedescendant", "map-area-name-" + namedActive);
                if (options[namedActive].scrollIntoView) {
                    options[namedActive].scrollIntoView({block: "nearest"});
                }
            } else {
                areaInput.removeAttribute("aria-activedescendant");
            }
        }

        /* Drawing the area: the rest of the map veiled, its outline, and the
           shape being drawn. */

        // The page's theme is dark (chosen, or the system's): the street maps are.
        function darkTheme() {
            var chosen = document.documentElement.getAttribute("data-theme");
            if (chosen === "dark" || chosen === "light") {
                return chosen === "dark";
            }
            return Boolean(window.matchMedia &&
                           window.matchMedia("(prefers-color-scheme: dark)").matches);
        }

        function veilFor() {
            if (!veilCanvas) {
                veilCanvas = document.createElement("canvas");
            }
            if (typeof veilCanvas.getContext !== "function") {
                return null;
            }
            if (veilCanvas.width !== canvas.width || veilCanvas.height !== canvas.height) {
                veilCanvas.width = canvas.width;
                veilCanvas.height = canvas.height;
            }
            return veilCanvas;
        }

        // The area's shapes in screen pixels: [[x, y, x, y, ...]].
        function screenShapes(area, at) {
            var w = at.w;
            var shift = nearestCopy(area.cx * w, at.left + view.w / 2, w) - area.cx * w - at.left;
            return area.shapes.map(function (shape) {
                var out = [];
                for (var k = 0; k < shape.length; k += 2) {
                    out.push(shape[k] * w + shift, shape[k + 1] * w - at.top);
                }
                return out;
            });
        }

        function trace(target, shape, close) {
            target.moveTo(shape[0], shape[1]);
            for (var k = 2; k < shape.length; k += 2) {
                target.lineTo(shape[k], shape[k + 1]);
            }
            if (close) {
                target.closePath();
            }
        }

        function drawArea(at) {
            var area = currentArea();
            if (area) {
                var shapes = screenShapes(area, at);
                var radius = area.kind === "l" ? Math.max(3, area.metres * pixelsPerMetre(
                    AREAS.latitudeOf((area.box.y0 + area.box.y1) / 2))) : 0;
                var off = veilFor();
                var v = off ? off.getContext("2d") : null;
                if (v) {
                    v.setTransform(dpr, 0, 0, dpr, 0, 0);
                    v.globalCompositeOperation = "source-over";
                    v.clearRect(0, 0, view.w, view.h);
                    v.fillStyle = darkTheme() ? DARK_VEIL : VEIL;
                    v.fillRect(0, 0, view.w, view.h);
                    v.globalCompositeOperation = "destination-out";
                    v.fillStyle = "#000000";
                    v.strokeStyle = "#000000";
                    v.lineCap = "round";
                    v.lineJoin = "round";
                    shapes.forEach(function (shape) {
                        v.beginPath();
                        if (area.kind !== "l") {
                            // (Even-odd, as it is searched: SearchCore inRing.)
                            trace(v, shape, true);
                            v.fill("evenodd");
                        } else if (shape.length === 2) {
                            v.arc(shape[0], shape[1], radius, 0, Math.PI * 2);
                            v.fill();
                        } else {
                            trace(v, shape, false);
                            v.lineWidth = 2 * radius;
                            v.stroke();
                        }
                    });
                    v.globalCompositeOperation = "source-over";
                    ctx.drawImage(off, 0, 0, view.w, view.h);
                }
                ctx.save();
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                [[4.5, EDGE_CASING], [2, EDGE]].forEach(function (pass) {
                    ctx.beginPath();
                    shapes.forEach(function (shape) {
                        if (area.kind !== "l") {
                            trace(ctx, shape, true);
                        } else if (shape.length === 2) {
                            ctx.moveTo(shape[0] + radius, shape[1]);
                            ctx.arc(shape[0], shape[1], radius, 0, Math.PI * 2);
                        } else {
                            trace(ctx, shape, false);
                        }
                    });
                    ctx.lineWidth = area.kind === "l" ? pass[0] - 1 : pass[0];
                    ctx.strokeStyle = pass[1];
                    if (area.kind === "l") {
                        ctx.setLineDash([6, 5]);
                    }
                    ctx.stroke();
                });
                ctx.restore();
            }
            if (sketch && sketch.points.length > 1) {
                ctx.save();
                ctx.beginPath();
                var first = sketch.points[0];
                var last = sketch.points[sketch.points.length - 1];
                if (sketch.kind === "box") {
                    ctx.rect(Math.min(first.x, last.x), Math.min(first.y, last.y),
                             Math.abs(last.x - first.x), Math.abs(last.y - first.y));
                } else {
                    ctx.moveTo(first.x, first.y);
                    sketch.points.forEach(function (point) {
                        ctx.lineTo(point.x, point.y);
                    });
                }
                ctx.fillStyle = "rgba(255, 210, 63, 0.16)";
                ctx.fill("evenodd");
                ctx.lineWidth = 4.5;
                ctx.strokeStyle = EDGE_CASING;
                ctx.stroke();
                ctx.lineWidth = 2;
                ctx.strokeStyle = EDGE;
                ctx.stroke();
                ctx.restore();
            }
        }

        function sketchStart(p) {
            sketch = {kind: areaMode, points: [{x: p.x, y: p.y}]};
            scheduleDraw();
        }

        function sketchMove(p) {
            var points = sketch.points;
            var last = points[points.length - 1];
            if (sketch.kind === "box") {
                points[1] = {x: p.x, y: p.y};
            } else if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= SKETCH_STEP &&
                       points.length < SKETCH_POINTS) {
                points.push({x: p.x, y: p.y});
            }
            scheduleDraw();
        }

        if (areaButton && areaTools) {
            areaButton.addEventListener("click", function () {
                if (areaTools.hidden) {
                    openTools();
                } else {
                    closeTools(true);
                }
            });
            areaModes.forEach(function (button) {
                button.addEventListener("click", function (event) {
                    var mode = button.getAttribute("data-mode");
                    setMode(areaMode === mode ? "" : mode);
                    // (Not with a finger: a phone's keyboard would cover the map to tap
                    // on; the box is there to tap.)
                    var touch = Boolean(window.matchMedia &&
                                        window.matchMedia("(pointer: coarse)").matches);
                    if (areaMode === "pick" && areaInput && (event.detail === 0 || !touch)) {
                        areaInput.focus();
                    }
                });
            });
            var thisView = document.getElementById("map-area-view");
            if (thisView) {
                thisView.addEventListener("click", searchThisView);
            }
            var closeButton = document.getElementById("map-area-close");
            if (closeButton) {
                closeButton.addEventListener("click", function () {
                    closeTools(true);
                });
            }
        }
        if (areaInput) {
            areaInput.addEventListener("input", function () {
                listNames();
            });
            areaInput.addEventListener("focus", listNames);
            areaInput.addEventListener("keydown", function (event) {
                if (event.key === "ArrowDown") {
                    event.preventDefault();
                    markName(namedActive + 1);
                } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    markName(namedActive - 1);
                } else if (event.key === "Enter") {
                    event.preventDefault();
                    choose(namedShown[namedActive >= 0 ? namedActive : 0]);
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (areaInput.value) {
                        areaInput.value = "";
                        filterNames();
                    } else {
                        closeTools(true);
                    }
                }
            });
        }
        if (areaMetres) {
            areaMetres.addEventListener("change", function () {
                // (A street or a place searched now gets the new width.)
                var area = currentArea();
                if (area && area.kind === "l") {
                    var text = area.text.replace(/^l\d+/, "l" + metresChosen());
                    if (AREAS.read(text)) {
                        setArea(text, search.aname, true);
                    }
                }
            });
        }
        if (areaMenu) {
            areaMenu.addEventListener("keydown", function (event) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    hideMenu();
                    canvas.focus({preventScroll: true});
                    return;
                }
                // (A menu's keys: up and down, round at the ends; Home, End.)
                var items = Array.prototype.slice.call(
                    areaMenu.querySelectorAll("[role='menuitem']"));
                var at = items.indexOf(document.activeElement);
                var next = event.key === "ArrowDown" ? (at + 1) % items.length
                    : event.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1)
                        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
                if (next >= 0 && items.length) {
                    event.preventDefault();
                    items[next].focus({preventScroll: true});
                }
            });
        }

        /* Following the search */

        // "beach - Type: Photos - Year: 2019": what the search asks for, in words.
        function searchSummary() {
            var parts = [];
            if (interpreted && interpreted.changed) {
                // (Names, places and dates understood, as the search page's chips.)
                if (interpreted.rest) {
                    parts.push("\u201c" + interpreted.rest + "\u201d");
                }
                if (interpreted.others) {
                    // (Field words, phrases, -words and OR, as typed.)
                    parts.push("\u201c" + interpreted.others + "\u201d");
                }
                interpreted.parts.forEach(function (part) {
                    parts.push(part.label);
                });
            } else if (search.q) {
                parts.push("\u201c" + search.q + "\u201d");
            }
            var labels = {};
            SearchCore.FACETS.forEach(function (facet) {
                labels[facet.key] = facet.label;
            });
            Object.keys(search.filters).forEach(function (group) {
                search.filters[group].forEach(function (value) {
                    var label = group === "library" ? value : group === "place"
                        ? SearchCore.placeLabel(value) : SearchCore.facetLabel(group, value);
                    indexLibraries.forEach(function (library) {
                        if (group === "library" && library.id === value) {
                            label = library.name;
                        }
                    });
                    parts.push((labels[group] || group) + ": " + label);
                });
            });
            if (search.from || search.to) {
                parts.push("Taken: " + SearchCore.rangeLabel(search.from, search.to));
            }
            return parts.join(" \u00b7 ");
        }

        function fit() {
            // (A search of an area shows the area.)
            var bounds = search.area ? AREAS.bounds(search.area) : null;
            var spot = fitView(bounds ? [{lat: bounds.south, lon: normalizeLon(bounds.west)},
                                         {lat: bounds.north, lon: normalizeLon(bounds.east)}]
                : locations, view.w, view.h, TILE, MIN_ZOOM, fitLimit(), 48);
            if (spot) {
                setView(spot.lat, spot.lon, spot.zoom);
            } else {
                worldView();
            }
            autoFitted = true;
        }

        /* How far in a fit of the pictures goes: with street maps, as far as
           they have tiles at some of the pictures (at most FIT_ZOOM; until
           their index is in, FIT_ZOOM); else the world image's detail. */
        function fitLimit() {
            if (!streets || !basemap.ready()) {
                return FIT_ZOOM;
            }
            var deepest = -1;
            for (var k = 0; k < locations.length && deepest < FIT_ZOOM; k++) {
                var z = basemap.coveredZoom(locations[k].lat, locations[k].lon);
                if (z !== null && z > deepest) {
                    deepest = z;
                }
            }
            return deepest >= 0 ? Math.max(TILE_ZOOM, Math.min(FIT_ZOOM, deepest)) : TILE_ZOOM;
        }

        // Some picture (a pin, or a clip on a route) has its middle on the screen.
        function pinsInSight() {
            var at = corner();
            return screenPins(cluster(locations, at.w), at.left, at.top, view.w, view.h, at.w)
                .some(function (pin) {
                    return pin.sx >= 0 && pin.sx <= view.w && pin.sy >= 0 && pin.sy <= view.h;
                });
        }

        function applySearch(refit) {
            var library = SHELL.library();
            // (person: in the search, or in a smart album it names, needs the people.)
            var plain = SITE.capabilities.plain !== false;
            peopleSearch.want(search.q + " " + (/(^|\s)-?albums?:/i.test(search.q)
                ? indexAlbums.map(function (album) {
                    return album && album.kind === "smart" ? String(album.query || "") : "";
                }).join(" ") : ""), plain && search.typed !== "*" && !SITE.isStatic);
            interpreted = searchIndex.interpret(search.q, {
                people: peopleSearch.options({}).people, names: indexNames, plain: plain,
                typed: search.typed === "*" ? "*" : search.typed ? search.typed.split(",") : []
            });
            var found = SearchCore.search(searchIndex, interpreted.query, peopleSearch.options({
                library: library || "", libraries: indexLibraries, filters: search.filters,
                hidden: adminOn && search.hidden, sensitive: search.sensitive || undefined,
                junk: search.junk, group: false, sort: search.sort || undefined,
                range: {from: search.from, to: search.to}, seed: SITE.shuffleSeed(),
                albums: indexAlbums, area: search.area || undefined
            }));
            rank = {};
            found.items.forEach(function (id, index) {
                rank[id] = index;
            });
            matchCount = found.total;
            // (Nothing in the area: are the pictures that match anywhere placed at all?)
            areaElsewhere = null;
            if (search.area && !found.total) {
                var everywhere = SearchCore.search(searchIndex, interpreted.query,
                                                   peopleSearch.options({
                    library: library || "", libraries: indexLibraries, filters: search.filters,
                    hidden: adminOn && search.hidden, sensitive: search.sensitive || undefined,
                    junk: search.junk, group: false, range: {from: search.from, to: search.to},
                    albums: indexAlbums}));
                areaElsewhere = {total: everywhere.total,
                                 placed: searchIndex.placedCount(everywhere.items)};
            }
            estimatedIds = {};
            var anyEstimated = false;
            locations = (allLocations || []).filter(function (point) {
                if (point && point.e) {
                    estimatedIds[point.id] = true;
                    anyEstimated = anyEstimated || rank[point.id] !== undefined;
                    if (!showEstimated) {
                        return false;
                    }
                }
                return rank[point.id] !== undefined && validPoint(point);
            });
            if (estimatedBox) {
                estimatedBox.hidden = !anyEstimated;
            }
            applyRoutes();
            locationsVersion += 1;
            closePanel(false);
            var summary = searchSummary();
            document.getElementById("map-search").textContent = summary ? "Showing: " + summary : "";
            // A view from the address that shows none of the pictures (a
            // link made for another search) is no use: fit them instead.
            if (refit || !placed || (viewFromAddress && locations.length && !pinsInSight())) {
                fit();
            }
            // (While the people the search names are still to come, the view
            // from the address is checked again when they are here.)
            if (locations.length || !peopleSearch.options({}).peoplePending) {
                viewFromAddress = false;
            }
            if (startPin) {
                var again = groupAt(groupsNow(), startPin.lat, startPin.lon, width());
                startPin = null;
                if (again) {
                    openPanel(again, false);
                } else {
                    SHELL.setState({pin: null});
                }
            }
            updateLinks();
            renderStatus();
            scheduleDraw();
        }

        // Where the pictures were taken, for an area (SearchCore's setPlaces).
        function placeIndex() {
            if (searchIndex && allLocations) {
                searchIndex.setPlaces(allLocations, routeList || []);
            }
        }

        function load() {
            loadState = "loading";
            renderStatus();
            SITE.loadIndex(function (data) {
                if (!data) {
                    loadState = "failed";
                    renderStatus();
                    return;
                }
                records = data.records;
                indexById = {};
                records.forEach(function (rec) {
                    indexById[rec.i] = rec;
                });
                indexLibraries = data.libraries || [];
                // (album: in the search names one of these.)
                indexAlbums = Array.isArray(data.albums) ? data.albums : [];
                // (An export's published names, for plain-language search.)
                indexNames = Array.isArray(data.names) ? data.names : null;
                searchIndex = SearchCore.prepare(records);
                SITE.loadLocations(function (loaded) {
                    if (!loaded) {
                        loadState = "failed";
                        renderStatus();
                        return;
                    }
                    allLocations = loaded;
                    loadState = "ready";
                    placeIndex();
                    applySearch(false);
                    if (allRoutes === null && SITE.loadRoutes && typeof ROUTES !== "undefined") {
                        SITE.loadRoutes(function (list) {
                            if (list) {
                                allRoutes = ROUTES.prepare(list);
                                routeList = list;
                                placeIndex();
                                // (The list open from the address stays open.)
                                if (selection && selection.point) {
                                    startPin = selection.point;
                                }
                                applySearch(false);
                            }
                        });
                    }
                });
            });
        }

        if (estimatedToggle) {
            estimatedToggle.checked = showEstimated;
            estimatedToggle.addEventListener("change", function () {
                showEstimated = estimatedToggle.checked;
                try {
                    window.sessionStorage.setItem(ESTIMATED_KEY, showEstimated ? "1" : "0");
                } catch (error) {
                    // (No storage: for this page only.)
                }
                if (loadState === "ready") {
                    if (selection && selection.point) {
                        startPin = selection.point;
                    }
                    applySearch(false);
                }
            });
        }

        if (routesToggle) {
            routesToggle.checked = showRoutes;
            routesToggle.addEventListener("change", function () {
                showRoutes = routesToggle.checked;
                try {
                    window.sessionStorage.setItem(ROUTES_KEY, showRoutes ? "1" : "0");
                } catch (error) {
                    // (No storage: for this page only.)
                }
                setHoverRoute(null);
                if (loadState === "ready") {
                    // (Their clips' pins come or go.)
                    if (selection && selection.point) {
                        startPin = selection.point;
                    }
                    applySearch(false);
                }
            });
        }
        canvas.addEventListener("mouseleave", function () {
            setHoverRoute(null);
        });

        function init() {
            resize();
            window.addEventListener("resize", resize);
            if (window.ResizeObserver) {
                new window.ResizeObserver(function () {
                    resize();
                }).observe(canvas);
            }
            if (startView) {
                setView(startView.lat, startView.lon, startView.zoom);
            } else {
                worldView();
                placed = false;
            }
            // A viewer left open by a reload: not reopened.
            if (/(?:^#|&)id=/.test(window.location.hash || "")) {
                window.history.replaceState(null, "", hashWithId(null));
            }
            SHELL.onLibraryChange(function () {
                if (loadState === "ready") {
                    applySearch(true);
                }
            });
            renderAreaChip();
            updateLinks();
            load();
        }

        init();
    }

    if (hasDocument && document.getElementById("map-canvas")) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", startPage);
        } else {
            startPage();
        }
    }

    return {
        CELL: CELL,
        GAP: GAP,
        MAX_LAT: MAX_LAT,
        FIT_STREETS: FIT_STREETS,
        MAX_RADIUS: MAX_RADIUS,
        worldWidth: worldWidth,
        wrapX: wrapX,
        normalizeLon: normalizeLon,
        project: project,
        unproject: unproject,
        nearestCopy: nearestCopy,
        copies: copies,
        pinRadius: pinRadius,
        countLabel: countLabel,
        cluster: cluster,
        screenPins: screenPins,
        hitPin: hitPin,
        WheelZoom: WheelZoom,
        fitView: fitView,
        drawPins: drawPins,
        formatView: formatView,
        parseView: parseView,
        chipState: chipState,
        formatPoint: formatPoint,
        parsePoint: parsePoint,
        groupAt: groupAt
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = MAP;
}
