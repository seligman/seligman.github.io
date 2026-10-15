/* Drive routes: the GPS tracks of videos (tracks.py) on the maps.

   SITE.loadRoutes gives the routes: [{d: the id of a route's first clip,
   l: its library, c: [{i: clip id, o: seconds from the route's start to
   the clip's, p: its track's points (tracks.encode)}]}], a drive's clips
   in order (a clip without a track is not there). The map page draws them
   as lines (map.js) and the viewer shows the route of the drive it plays
   in a small map in its information pane, with a dot where the clip that
   plays is (MiniMap). Neither needs anything but the map's tiles
   (SITE.tileUrl, and the street maps, SITE.streets: see streets.js), so
   both work offline and in an export.

   ROUTES.decode(text)          [[at, lat, lon, speed or null]] of a clip's
                                points (at: seconds into the clip; [] when
                                the text is not one)
   ROUTES.prepare(list)         {routes: [{key, library, clips: [{id,
                                offset, points}]}], byClip: {clip id:
                                route}} of SITE.loadRoutes's list
   ROUTES.positionAt(points, at)  {lat, lon, speed} at a moment of a clip
                                (between its points, the first or last
                                outside them), or null
   ROUTES.placeOf(route, clipId, seconds)  the same for a clip of a route,
                                or null more than FIX_SLACK seconds before
                                its first point or after its last (no fix
                                then: a cold start, a garage); a clip an
                                export cut where it left points out (t: 1,
                                a piece each) has a place only within its
                                pieces
   ROUTES.lines(route, shown)   the polylines of a route's clips that
                                shown(id) allows: [[{lat, lon, clip, at,
                                t (seconds from the route's start)}]],
                                broken where a clip is left out or more
                                than GAP_SECONDS pass between two clips'
                                points (clips missing: a hole)
   ROUTES.nearest(lines, x, y, slack)  the place on lines whose points have
                                screen positions (sx, sy; and clip, at)
                                nearest the screen point x, y, within slack
                                pixels: {clip, at (seconds into it),
                                distance, sx, sy}, or null
   ROUTES.strokeLines(ctx, lines, width, colour)  draws lines of screen
                                points ([[{sx, sy}]]) on a canvas, round
                                ended (a line of one point is a dot)
   ROUTES.fitZoom(box, w, h, tile, pad, maxZoom)  the (fractional) zoom
                                that shows a box {south, north, west,
                                east} in w x h pixels with pad around it
                                (Web Mercator, as the map page)
   ROUTES.MiniMap(options)      a small map of one route: .node (append it
                                where it goes), .show(route, clipId),
                                .at(clipId, seconds) -> the speed there
                                (km/h) or null, .hide(). options: {tileUrl
                                (z, x, y), tileSize, tilesMax, streets
                                (SITE.streets())}; the map is the map
                                page's (Web Mercator, STREETS.Basemap: the
                                world image, and the street maps where
                                there are any, credited while they show).

   Pages are built with DOM calls only (never innerHTML). Loads under Node
   for the tests (tests/js/routes_test.js).
*/
var ROUTES = (function () {
    "use strict";

    // Seconds between two clips' points that make a gap in a route's line.
    var GAP_SECONDS = 30;
    // A clip has a place this many seconds before its first point and after
    // its last (a fix a second; tracks.simplify keeps both), and none further.
    var FIX_SLACK = 2;
    // The colours of a route (any theme: drawn on the map's tiles), and of the
    // clip that plays or is under the pointer: a bright line on a dark casing
    // (seen on the dark world image and the light street maps alike).
    var LINE = "rgba(255, 162, 31, 0.98)";
    var HALO = "rgba(20, 16, 10, 0.6)";
    var CURRENT = "#ffd84d";
    var CASING = "rgba(20, 16, 10, 0.85)";
    var SEA = "#1a2c3d";
    var MINI_HEIGHT = 170;
    var MINI_PAD = 14;
    // The mini map zooms in at most this far (about 2 m a pixel); past the
    // tiles' own detail they are stretched, fainter the further (where
    // there are no street maps).
    var MAX_ZOOM = 16;
    var MAX_LAT = 85.0511287798;

    function isNumber(value) {
        return typeof value === "number" && isFinite(value);
    }

    function decode(text) {
        var rows;
        try {
            rows = JSON.parse(text || "[]");
        } catch (error) {
            return [];
        }
        if (!Array.isArray(rows)) {
            return [];
        }
        var result = [];
        var total = null;
        for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            if (!Array.isArray(row) || row.length !== 4 || !row.every(function (value) {
                return isNumber(value) && Math.floor(value) === value;
            })) {
                return [];
            }
            total = total === null ? row.slice(0, 3)
                : [total[0] + row[0], total[1] + row[1], total[2] + row[2]];
            result.push([total[0] / 10, total[1] / 1e5, total[2] / 1e5,
                         row[3] >= 0 ? row[3] : null]);
        }
        return result;
    }

    function prepare(list) {
        var routes = [];
        var byClip = {};
        (Array.isArray(list) ? list : []).forEach(function (item) {
            if (!item || typeof item !== "object" || !Array.isArray(item.c)) {
                return;
            }
            var route = {key: item.d, library: item.l, clips: []};
            item.c.forEach(function (clip) {
                var points = clip && typeof clip.p === "string" ? decode(clip.p) : [];
                if (!points.length) {
                    return;
                }
                route.clips.push({id: clip.i, offset: isNumber(clip.o) ? clip.o : 0,
                                  points: points, cut: clip.t === 1});
            });
            if (!route.clips.length) {
                return;
            }
            routes.push(route);
            route.clips.forEach(function (clip) {
                byClip[clip.id] = route;
            });
        });
        return {routes: routes, byClip: byClip};
    }

    function positionAt(points, at) {
        if (!points || !points.length) {
            return null;
        }
        function place(point) {
            return {lat: point[1], lon: point[2], speed: point[3]};
        }
        if (!(at > points[0][0])) {
            return place(points[0]);
        }
        for (var k = 1; k < points.length; k++) {
            var before = points[k - 1];
            var after = points[k];
            if (at <= after[0]) {
                var span = after[0] - before[0];
                var share = span > 0 ? (at - before[0]) / span : 0;
                var speed = before[3] === null ? after[3] : after[3] === null ? before[3]
                    : before[3] + (after[3] - before[3]) * share;
                return {lat: before[1] + (after[1] - before[1]) * share,
                        lon: before[2] + (after[2] - before[2]) * share, speed: speed};
            }
        }
        return place(points[points.length - 1]);
    }

    /* Where a clip of a route was seconds into it ({lat, lon, speed}), or null:
       by its points (positionAt), or, for a clip an export cut where points
       were left out (cut), only within one of its pieces. */
    function placeOf(route, clipId, seconds) {
        var pieces = (route && route.clips || []).filter(function (clip) {
            return clip.id === clipId;
        });
        if (pieces.length === 1 && !pieces[0].cut) {
            var all = pieces[0].points;
            if (!(seconds >= all[0][0] - FIX_SLACK &&
                  seconds <= all[all.length - 1][0] + FIX_SLACK)) {
                return null;
            }
            return positionAt(all, seconds);
        }
        for (var k = 0; k < pieces.length; k++) {
            var points = pieces[k].points;
            if (seconds >= points[0][0] && seconds <= points[points.length - 1][0]) {
                return positionAt(points, seconds);
            }
        }
        return null;
    }

    function lines(route, shown) {
        var result = [];
        var line = null;
        var lastTime = null;
        var lastId = null;
        (route && route.clips || []).forEach(function (clip) {
            if (shown && !shown(clip.id)) {
                line = null;
                return;
            }
            var first = clip.offset + clip.points[0][0];
            // (A piece of the clip before: points left out between them.)
            if (line && (lastTime === null || first - lastTime > GAP_SECONDS ||
                         clip.id === lastId)) {
                line = null;
            }
            lastId = clip.id;
            if (!line) {
                line = [];
                result.push(line);
            }
            clip.points.forEach(function (point) {
                line.push({lat: point[1], lon: point[2], clip: clip.id, at: point[0],
                           t: clip.offset + point[0]});
            });
            lastTime = clip.offset + clip.points[clip.points.length - 1][0];
        });
        return result;
    }

    // The nearest point to (x, y) on segment a-b: {share, sx, sy, distance}.
    function onSegment(a, b, x, y) {
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var length = dx * dx + dy * dy;
        var share = length > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / length : 0;
        share = share < 0 ? 0 : share > 1 ? 1 : share;
        var sx = a.x + dx * share;
        var sy = a.y + dy * share;
        return {share: share, sx: sx, sy: sy, distance: Math.sqrt((sx - x) * (sx - x) +
                                                                  (sy - y) * (sy - y))};
    }

    function nearest(lineList, x, y, slack) {
        var best = null;
        function consider(found, clip, moment) {
            if (found.distance <= slack && (!best || found.distance < best.distance)) {
                best = {clip: clip, at: moment, distance: found.distance, sx: found.sx,
                        sy: found.sy};
            }
        }
        (lineList || []).forEach(function (line) {
            line.forEach(function (point, index) {
                var at = {x: point.sx, y: point.sy};
                if (index === 0) {
                    consider(onSegment(at, at, x, y), point.clip, point.at);
                    return;
                }
                var from = line[index - 1];
                var found = onSegment({x: from.sx, y: from.sy}, at, x, y);
                if (from.clip === point.clip) {
                    consider(found, point.clip, from.at + (point.at - from.at) * found.share);
                } else if (found.share < 0.5) {
                    // (Between two clips: the moment of the nearer end.)
                    consider(found, from.clip, from.at);
                } else {
                    consider(found, point.clip, point.at);
                }
            });
        });
        return best;
    }

    function strokeLines(ctx, lineList, width, colour) {
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = width;
        ctx.strokeStyle = colour;
        (lineList || []).forEach(function (line) {
            if (!line.length) {
                return;
            }
            ctx.beginPath();
            line.forEach(function (point, index) {
                if (index) {
                    ctx.lineTo(point.sx, point.sy);
                } else {
                    ctx.moveTo(point.sx, point.sy);
                }
            });
            if (line.length === 1) {
                ctx.lineTo(line[0].sx + 0.1, line[0].sy);
            }
            ctx.stroke();
        });
        ctx.restore();
    }

    // 0 at the map's north edge to 1 at its south edge (Web Mercator).
    function mercatorY(lat) {
        var r = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
        return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
    }

    function fitZoom(box, w, h, tile, pad, maxZoom) {
        var lonSpan = Math.max(box.east - box.west, 1e-9);
        var ySpan = Math.max(mercatorY(box.south) - mercatorY(box.north), 1e-12);
        var free = {w: Math.max(1, w - 2 * pad), h: Math.max(1, h - 2 * pad)};
        // World width (and height) at zoom z: tile * 2^(z + 1) for 360 degrees.
        var byWidth = Math.log(free.w * 360 / (lonSpan * tile)) / Math.LN2 - 1;
        var byHeight = Math.log(free.h / (ySpan * tile)) / Math.LN2 - 1;
        return Math.max(0, Math.min(maxZoom, byWidth, byHeight));
    }

    function boxOf(route) {
        var box = null;
        route.clips.forEach(function (clip) {
            clip.points.forEach(function (point) {
                if (!box) {
                    box = {south: point[1], north: point[1], west: point[2], east: point[2]};
                    return;
                }
                box.south = Math.min(box.south, point[1]);
                box.north = Math.max(box.north, point[1]);
                box.west = Math.min(box.west, point[2]);
                box.east = Math.max(box.east, point[2]);
            });
        });
        return box;
    }

    /* ---------- The viewer's small map ------------------------------------- */

    function MiniMap(options) {
        this.options = options || {};
        this.tile = this.options.tileSize || 256;
        this.tilesMax = isNumber(this.options.tilesMax) ? this.options.tilesMax : 3;
        this.basemap = null;
        this.credit = null;
        this.route = null;
        this.clipId = null;
        this.seconds = 0;
        this.pending = false;
        this.node = null;
        this.canvas = null;
        // (No page: under Node, for the tests.)
        if (typeof document !== "undefined" && document !== null) {
            this.canvas = document.createElement("canvas");
            this.canvas.className = "route-map-canvas";
            this.canvas.setAttribute("role", "img");
            this.canvas.setAttribute("aria-label", "Map of the drive's route; the dot is " +
                                     "where the clip that plays is");
            this.node = document.createElement("div");
            this.node.className = "route-map";
            this.node.hidden = true;
            this.node.appendChild(this.canvas);
            var self = this;
            this.credit = STREETS.creditNode("span", "map-streets-credit route-map-credit",
                                             this.options.streets || null);
            this.node.appendChild(this.credit);
            this.basemap = new STREETS.Basemap({tileUrl: this.options.tileUrl,
                                                tileSize: this.tile, tileZoom: this.tilesMax,
                                                ocean: SEA, streets: this.options.streets || null,
                                                onLoad: function () {
                                                    self.schedule();
                                                }});
            // Drawn again whenever its size changes: the pane that holds it
            // opened (it had none while closed), the phone turned.
            if (typeof ResizeObserver === "function") {
                new ResizeObserver(function () {
                    self.schedule();
                }).observe(this.canvas);
            }
        }
    }

    MiniMap.prototype.show = function (route, clipId) {
        if (route !== this.route) {
            this.route = route;
            this.box = route ? boxOf(route) : null;
        }
        this.clipId = clipId;
        this.seconds = 0;
        if (this.node) {
            this.node.hidden = !route;
        }
        this.schedule();
    };

    MiniMap.prototype.hide = function () {
        this.route = null;
        if (this.node) {
            this.node.hidden = true;
        }
    };

    MiniMap.prototype.where = function (clipId, seconds) {
        return placeOf(this.route, clipId, seconds);
    };

    MiniMap.prototype.at = function (clipId, seconds) {
        this.clipId = clipId;
        this.seconds = isNumber(seconds) ? seconds : 0;
        this.schedule();
        var where = this.where(clipId, this.seconds);
        return where && isNumber(where.speed) ? where.speed : null;
    };

    MiniMap.prototype.schedule = function () {
        var self = this;
        if (this.pending || !this.canvas || typeof window === "undefined" ||
                !window.requestAnimationFrame) {
            return;
        }
        this.pending = true;
        window.requestAnimationFrame(function () {
            self.pending = false;
            self.draw();
        });
    };

    MiniMap.prototype.draw = function () {
        var canvas = this.canvas;
        if (!this.route || !this.box || !canvas || !canvas.isConnected) {
            return;
        }
        var w = canvas.clientWidth || 0;
        // (Its height is the page's: lower in a small pane, see style.css.)
        var h = canvas.clientHeight || MINI_HEIGHT;
        if (w < 10) {
            return;
        }
        var ratio = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
            canvas.width = Math.round(w * ratio);
            canvas.height = Math.round(h * ratio);
        }
        var ctx = canvas.getContext("2d");
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        var tile = this.tile;
        var zoom = fitZoom(this.box, w, h, tile, MINI_PAD, MAX_ZOOM);
        var world = tile * Math.pow(2, zoom + 1);
        function project(lat, lon) {
            return {x: (lon + 180) / 360 * world, y: mercatorY(lat) * world};
        }
        var middle = project((this.box.south + this.box.north) / 2,
                             (this.box.west + this.box.east) / 2);
        var left = middle.x - w / 2;
        var top = middle.y - h / 2;
        function toScreen(lat, lon) {
            var at = project(lat, lon);
            return {x: at.x - left, y: at.y - top};
        }
        // The ground: the world image (stretched past its detail) and the
        // street maps where there are any.
        ctx.fillStyle = SEA;
        ctx.fillRect(0, 0, w, h);
        var clear = STREETS.clearOf(this.credit, canvas);
        var drawn = this.basemap.draw(ctx, zoom, left, top, w, h, clear ? [clear] : []);
        if (STREETS.showCredit(this.credit, drawn)) {
            this.schedule();            // (names placed clear of it next time)
        }
        // The route, the clip that plays over it, and where it is.
        var self = this;
        var all = lines(this.route, null);
        function stroke(list, width, colour) {
            ctx.lineWidth = width;
            ctx.strokeStyle = colour;
            list.forEach(function (line) {
                ctx.beginPath();
                line.forEach(function (point, index) {
                    var at = toScreen(point.lat, point.lon);
                    if (index) {
                        ctx.lineTo(at.x, at.y);
                    } else {
                        ctx.moveTo(at.x, at.y);
                    }
                });
                if (line.length === 1) {
                    var only = toScreen(line[0].lat, line[0].lon);
                    ctx.lineTo(only.x + 0.1, only.y);
                }
                ctx.stroke();
            });
        }
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        stroke(all, 5, HALO);
        stroke(all, 2.5, LINE);
        var current = lines(this.route, function (id) {
            return id === self.clipId;
        });
        stroke(current, 7.5, CASING);
        stroke(current, 4, CURRENT);
        var where = this.where(this.clipId, this.seconds);
        if (where) {
            var dot = toScreen(where.lat, where.lon);
            ctx.beginPath();
            ctx.arc(dot.x, dot.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(214, 58, 58, 0.98)";
            ctx.fill();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
        }
    };

    return {
        GAP_SECONDS: GAP_SECONDS,
        FIX_SLACK: FIX_SLACK,
        LINE: LINE,
        HALO: HALO,
        CURRENT: CURRENT,
        CASING: CASING,
        decode: decode,
        prepare: prepare,
        positionAt: positionAt,
        placeOf: placeOf,
        lines: lines,
        nearest: nearest,
        strokeLines: strokeLines,
        fitZoom: fitZoom,
        boxOf: boxOf,
        MiniMap: MiniMap
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = ROUTES;
}
