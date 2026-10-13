/* The picture viewer: a lightbox over the search results, and the same
   picture stage and information pane on the detail page.

   VIEWER.open(options)      shows the lightbox. options:
       ids        the ids to step through with the arrow keys (result order)
       index      where in ids to start
       get(id)    the compact search record of an id (see search_index.py)
       query      what was searched for (its words are highlighted)
       libraryName(id), similar(id) -> [ids], chipUrl(group, value),
       onChip(group, value)      a chip was clicked (in-page search)
       moreLikeThis(id)          "More like this" (or M): search similar:<id>
                                 in the page (without it, the button is a
                                 link to the search page)
       hasLook(id), looksLike(id) -> [ids], onLooksLike(id)  "Looks like
                                 this" (or L): the button shows for a
                                 picture with a look vector and searches
                                 look:<id> (in the page with onLooksLike),
                                 and a strip of the pictures that look most
                                 like it
       onShow(id, position)      a picture is shown (the page keeps #id=)
       onClose(id)               the lightbox closed on picture id
       onHidden(ids, hidden)     pictures were hidden or shown again (admin)
       albums()                  the albums (SITE.loadIndex's list; a new
                                 album is added to it), for the picture's
                                 albums and the album picker
       onMarked(ids)             pictures were made favorites, rated, or put
                                 in (or taken out of) an album (admin): the
                                 records were changed in place
       detailUrl(id)             the detail page of a picture
       stackOf(id), onExpandStack(id)  a folded stack of similar pictures,
                                 and opening it in the grid
       driveOf(id)               the drive of a video clip (a run of clips
                                 recorded one after the other): {key,
                                 clips (ids in order), matched ({id:
                                 true}: the clips that match the search by
                                 themselves), text (the id of the clip with
                                 the drive's own title and description, or
                                 null), folded (it is one tile in the
                                 grid)}, or null; the viewer then plays the
                                 whole drive (Stage.showDrive), and the
                                 information pane follows the clip that
                                 plays
       onExpandDrive(id)         open the folded drive of a clip in the grid
       reviewUrl(id)             the Duplicates page for that stack (admin)
   VIEWER.close(), VIEWER.isOpen(), VIEWER.update(ids) (the result list
   changed while open), VIEWER.refreshInfo() (draw the information pane
   again: what similar(id) gives has changed), VIEWER.current() (the id
   shown).

   VIEWER.Stage(box, options)  a zoomable picture (wheel, pinch,
       double-click, drag) or, for 360-degree photos, an interactive
       panorama (WebGL; the flat picture when WebGL is not available).
       options: onSwipe(direction) (a sideways swipe changes picture),
       onState(state), scrollPage (the stage is part of a page that
       scrolls: the wheel scrolls it unless Ctrl is held or the picture
       is zoomed in). stage.show(rec, {thumb, preview, pano}): pano is
       the large panorama of a 360-degree photo (SITE.panoUrl); the view
       starts with the preview, then loads the panorama and swaps it in
       once it has arrived (the preview stays if it cannot be loaded).
       A video (rec.mv) plays in a <video> with its poster (the preview)
       when VIEWER.stageUrls gives a video address and the browser can
       play it (format.canPlayVideo; HEVC often not): otherwise the poster
       stays with a note, and stage.videoDetail(detail) starts the player
       when the full record says there is a playable copy. A drive
       (urls.drive) plays clip after clip with a strip across the whole
       drive (see showDrive). A 360 video (rec.mv and rec.p "360") starts
       as a 360 photo, with its poster; its video (both lenses side by
       side) then plays on the sphere, each frame stitched by a shader
       with its lens geometry (rec.fx), under controls of the stage's own
       (flat, the front lens only, without WebGL).
   VIEWER.stageUrls(rec, detail) the addresses stage.show wants.
   VIEWER.renderInfo(box, record, detail, context)  the information pane:
       title, date, place, camera, description and text with the search words
       marked, clickable chips, quality, admin actions, "More like this" (a
       button that searches similar:<id>, M, and a strip of the closest
       pictures) and "Looks like this" (look:<id>, L, and its strip).
       The admin can edit the title, description and tags there ("Edit",
       or E; Ctrl+Enter saves, Esc cancels): the record is changed in
       place and context.onEdited(id, detail) is told. The admin also sees
       why the GPS check set a picture's position aside (detail.
       location_check), with "Use this location anyway" -- and "Ignore
       location" among the admin actions -- which change the record's place
       in place and tell context.onEdited too. Under the title:
       the favorite star (F), the rating (1-5; 0 clears it, or first
       resets a view that was zoomed or turned) and the albums of the
       picture with "Add to album..." (A) -- the admin's to change
       (context.onMarked(ids) is told), shown to others when set.
   VIEWER.marks: favorite(ids, on, get), rate(ids, stars, get) (each
       resolves when the server has them; the records are changed in
       place), picker({ids, get, albums, mode ("add" or "remove"),
       onChange}): the album picker (find an album, or make a new one;
       Enter only ever adds -- or, with "remove", takes out -- and makes
       a new album only when no album matches what was typed),
       byKey(rec, context, key) (the keys F, 1-5, 0 and A for a picture)
       and stars(count).

   Pages are built with DOM calls and textContent only (never innerHTML).
   VIEWER.format holds the pure helpers (also used by the tests under Node).
*/
var VIEWER = (function () {
    "use strict";

    var hasDocument = typeof document !== "undefined" && document !== null;

    /* ---------- Pure helpers ----------------------------------------------- */

    var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
                  "September", "October", "November", "December"];
    var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    function clamp(value, low, high) {
        return value < low ? low : value > high ? high : value;
    }

    function two(n) {
        return (n < 10 ? "0" : "") + n;
    }

    // "2019-05-14" (or "2019-05-14T10:12:00") -> {year, month, day, hour, minute} or null.
    function parseDate(text) {
        var match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text || "");
        if (!match) {
            return null;
        }
        var month = Number(match[2]);
        var day = Number(match[3]);
        if (month < 1 || month > 12 || day < 1 || day > 31) {
            return null;
        }
        return {year: Number(match[1]), month: month, day: day,
                hour: match[4] === undefined ? null : Number(match[4]),
                minute: match[5] === undefined ? null : Number(match[5])};
    }

    // "May 2019" for "2019-05-..."; "" when there is no date.
    function monthLabel(text) {
        var date = parseDate(text);
        return date ? MONTHS[date.month - 1] + " " + date.year : "";
    }

    // "May 14, 2019".
    function shortDate(text) {
        var date = parseDate(text);
        return date ? MONTHS[date.month - 1].slice(0, 3) + " " + date.day + ", " + date.year : "";
    }

    // "Tuesday, May 14, 2019 at 10:12" (the time when known).
    function longDate(text) {
        var date = parseDate(text);
        if (!date) {
            return "";
        }
        var weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
        var out = DAYS[weekday] + ", " + MONTHS[date.month - 1] + " " + date.day + ", " + date.year;
        if (date.hour !== null) {
            out += " at " + two(date.hour) + ":" + two(date.minute);
        }
        return out;
    }

    function number(value) {
        return typeof value === "number" && isFinite(value) ? value : null;
    }

    function trimNumber(value, digits) {
        return String(Number(value.toFixed(digits)));
    }

    // Camera settings in words: ["1/125 s", "f/2.8", "ISO 100", "26 mm"].
    function exposureParts(exif) {
        exif = exif && typeof exif === "object" ? exif : {};
        var parts = [];
        var time = number(exif.ExposureTime);
        if (time !== null && time > 0) {
            parts.push(time >= 1 ? trimNumber(time, 1) + " s" : "1/" + Math.round(1 / time) + " s");
        }
        var aperture = number(exif.FNumber);
        if (aperture !== null && aperture > 0) {
            parts.push("f/" + trimNumber(aperture, 1));
        }
        var iso = number(exif.ISOSpeedRatings);
        if (iso === null) {
            iso = number(exif.PhotographicSensitivity);
        }
        if (iso === null && Array.isArray(exif.ISOSpeedRatings)) {
            iso = number(exif.ISOSpeedRatings[0]);
        }
        if (iso !== null && iso > 0) {
            parts.push("ISO " + Math.round(iso));
        }
        var focal = number(exif.FocalLength);
        if (focal !== null && focal > 0) {
            var text = trimNumber(focal, 1) + " mm";
            var full = number(exif.FocalLengthIn35mmFilm);
            if (full !== null && full > 0 && Math.round(full) !== Math.round(focal)) {
                text += " (" + Math.round(full) + " mm full frame)";
            }
            parts.push(text);
        }
        return parts;
    }

    function fileSize(bytes) {
        bytes = number(bytes);
        if (bytes === null || bytes < 0) {
            return "";
        }
        var units = ["bytes", "KB", "MB", "GB"];
        var unit = 0;
        while (bytes >= 1024 && unit < units.length - 1) {
            bytes /= 1024;
            unit += 1;
        }
        return (unit === 0 ? String(bytes) : bytes.toFixed(bytes < 10 ? 1 : 0)) + " " + units[unit];
    }

    // The length of a video: "0:24", "12:05", "1:02:03" ("" when unknown):
    // whole seconds rounded down, as players show it, but at least "0:01".
    function durationText(seconds) {
        seconds = number(seconds);
        if (seconds === null || seconds < 0) {
            return "";
        }
        var total = Math.floor(seconds);
        if (seconds > 0 && total < 1) {
            total = 1;
        }
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        var rest = total % 60;
        return (hours ? hours + ":" + two(minutes) : String(minutes)) + ":" + two(rest);
    }

    // Codec names as people know them.
    var CODEC_NAMES = {h264: "H.264", hevc: "HEVC", h265: "HEVC", vp8: "VP8", vp9: "VP9",
                       av1: "AV1", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", mjpeg: "Motion JPEG",
                       wmv3: "WMV", vc1: "VC-1", aac: "AAC", mp3: "MP3", opus: "Opus",
                       pcm_s16le: "PCM", ac3: "AC-3"};

    function codecName(codec) {
        codec = String(codec || "");
        return CODEC_NAMES[codec] || codec.toUpperCase();
    }

    /* Can this browser play a video record (rec.mv)? probe(type) is
       HTMLMediaElement.canPlayType. H.264 (and an unknown codec: the
       player says when it cannot) is tried; HEVC only when the browser
       says it can decode it; VP8, VP9 and AV1 as WebM; other codecs
       (MPEG-4 Part 2, WMV, ...) not. */
    function canPlayVideo(rec, probe) {
        var codec = rec && rec.vc ? String(rec.vc) : "";
        var ask = function (type) {
            try {
                return Boolean(probe && probe(type));
            } catch (error) {
                return false;
            }
        };
        if (!codec || codec === "h264") {
            return true;
        }
        if (codec === "hevc" || codec === "h265") {
            return ask("video/mp4; codecs=\"hvc1.1.6.L93.B0\"") ||
                ask("video/mp4; codecs=\"hev1.1.6.L93.B0\"");
        }
        if (codec === "vp8" || codec === "vp9" || codec === "av1") {
            return ask("video/webm; codecs=\"" + codec + "\"") ||
                (codec === "av1" && ask("video/mp4; codecs=\"av01.0.05M.08\""));
        }
        return false;
    }

    // "0:24, HEVC, 30 fps, AAC sound" (joined by middle dots) for the information pane.
    function videoFacts(rec, detail) {
        var facts = detail && detail.video && typeof detail.video === "object" ? detail.video
            : {};
        var parts = [];
        var length = durationText(detail && typeof detail.duration === "number" ? detail.duration
            : rec && rec.dr);
        if (length) {
            parts.push(length);
        }
        var codec = facts.codec || (rec && rec.vc);
        if (codec) {
            parts.push(codecName(codec) + (facts.hdr ? " HDR" : ""));
        }
        var fps = number(facts.fps);
        if (fps !== null && fps > 0) {
            parts.push((Math.round(fps * 100) / 100) + " fps");
        }
        if (facts.audio_codec) {
            parts.push(codecName(facts.audio_codec) + " sound");
        } else if (detail && detail.video) {
            parts.push("no sound");
        }
        return parts.join(" \u00b7 ");
    }

    /* A drive's clips on one time line: {starts (seconds from the drive's
       start where each clip begins), lengths, total}. A clip whose length is
       not known counts DRIVE_CLIP seconds. */
    var DRIVE_CLIP = 60;

    function driveTimeline(durations) {
        var starts = [];
        var lengths = [];
        var total = 0;
        (durations || []).forEach(function (seconds) {
            var length = number(seconds);
            length = length !== null && length > 0 ? length : DRIVE_CLIP;
            starts.push(total);
            lengths.push(length);
            total += length;
        });
        return {starts: starts, lengths: lengths, total: total};
    }

    // Where a moment (seconds into a drive) is: {index (its clip), offset (seconds into it)}.
    function drivePlace(timeline, seconds) {
        var starts = timeline.starts;
        if (!starts.length) {
            return {index: 0, offset: 0};
        }
        seconds = clamp(number(seconds) || 0, 0, timeline.total);
        var low = 0;
        var high = starts.length - 1;
        while (low < high) {
            var middle = (low + high + 1) >> 1;
            if (starts[middle] <= seconds) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return {index: low, offset: Math.min(timeline.lengths[low], seconds - starts[low])};
    }

    /* Split text at highlight ranges ([[start, end], ...], sorted, not
       overlapping): [{text, mark}]. Bad ranges are ignored. */
    function segments(text, ranges) {
        text = String(text || "");
        var out = [];
        var at = 0;
        (Array.isArray(ranges) ? ranges : []).forEach(function (range) {
            var start = Math.max(at, Math.floor(Number(range && range[0])));
            var end = Math.min(text.length, Math.floor(Number(range && range[1])));
            if (!isFinite(start) || !isFinite(end) || end <= start) {
                return;
            }
            if (start > at) {
                out.push({text: text.slice(at, start), mark: false});
            }
            out.push({text: text.slice(start, end), mark: true});
            at = end;
        });
        if (at < text.length || !out.length) {
            out.push({text: text.slice(at), mark: false});
        }
        return out;
    }

    /* The panorama view after dragging by (dx, dy) pixels on a view of
       size (width, height): {yaw, pitch, fov} in radians (fov: the field
       of view across the longer side). */
    var MIN_FOV = 30 * Math.PI / 180;
    var MAX_FOV = 100 * Math.PI / 180;
    var DEFAULT_FOV = 75 * Math.PI / 180;
    var MAX_PITCH = Math.PI / 2 - 0.01;

    function panoDrag(view, dx, dy, width, height) {
        var rate = view.fov / Math.max(1, Math.max(width, height));
        var yaw = view.yaw + dx * rate;
        yaw = ((yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        return {yaw: yaw, pitch: clamp(view.pitch + dy * rate, -MAX_PITCH, MAX_PITCH),
                fov: view.fov};
    }

    function panoZoom(view, factor) {
        return {yaw: view.yaw, pitch: view.pitch, fov: clamp(view.fov * factor, MIN_FOV, MAX_FOV)};
    }

    // The tangents of the half fields of view across and up the view.
    function panoTangents(fov, width, height) {
        var aspect = Math.max(1, width) / Math.max(1, height);
        var half = Math.tan(fov / 2);
        return aspect >= 1 ? {x: half, y: half / aspect} : {x: half * aspect, y: half};
    }

    /* Where a view direction lands on an equirectangular picture: the
       same sums as the panorama shader, for the tests. (u, v) in 0..1,
       u = 0.5 straight ahead, v = 0 the top. */
    function panoLookup(yaw, pitch, x, y, tangents) {
        var dx = x * tangents.x;
        var dy = y * tangents.y;
        var dz = -1;
        var length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= length;
        dy /= length;
        dz /= length;
        var cp = Math.cos(pitch);
        var sp = Math.sin(pitch);
        var y2 = dy * cp - dz * sp;
        var z2 = dy * sp + dz * cp;
        var cy = Math.cos(yaw);
        var sy = Math.sin(yaw);
        var x3 = dx * cy + z2 * sy;
        var z3 = -dx * sy + z2 * cy;
        var lon = Math.atan2(x3, -z3);
        var lat = Math.asin(clamp(y2, -1, 1));
        var u = lon / (2 * Math.PI) + 0.5;
        return {u: u - Math.floor(u), v: 0.5 - lat / Math.PI};
    }

    /* The uniforms of the 360 video shader for a record's lens geometry
       (rec.fx, see search_index.py: the lens circles as fractions of the
       frame, degrees for the rest) and a frame of width x height pixels:
       {front, back: [x, y, r] of each lens's circle, frontTurn, backTurn
       (radians), aspect (height / width), scale (1 / half the field of
       view, radians), mirror, blend (radians, at most what the lenses see
       past 180 degrees), frontGain, backGain, fill ([nadir, zenith],
       radians)}; null when fx is not usable. */
    function fisheyeParams(fx, width, height) {
        if (!fx || typeof fx !== "object" || !Array.isArray(fx.lens) || fx.lens.length !== 2 ||
                !(fx.fov > 90 && fx.fov < 360) || !width || !height) {
            return null;
        }
        var front = fx.front === 0 ? 0 : 1;
        var radians = Math.PI / 180;
        var turn = Array.isArray(fx.turn) ? fx.turn : [0, 0];
        var gain = Array.isArray(fx.gain) && fx.gain.length === 2 ? fx.gain
            : [[1, 1, 1], [1, 1, 1]];
        var fill = Array.isArray(fx.fill) ? fx.fill : [0, 0];
        var halfFov = fx.fov / 2 * radians;
        var blend = Math.min(Math.max(0, Number(fx.blend) || 0), Math.max(0, fx.fov / 2 - 90));
        return {
            front: fx.lens[front].slice(0, 3), back: fx.lens[1 - front].slice(0, 3),
            frontTurn: (Number(turn[front]) || 0) * radians,
            backTurn: (Number(turn[1 - front]) || 0) * radians,
            aspect: height / width, scale: 1 / halfFov, mirror: fx.mirror === true,
            blend: blend * radians, frontGain: gain[0].slice(0, 3), backGain: gain[1].slice(0, 3),
            fill: [Math.max(0, Number(fill[0]) || 0) * radians,
                   Math.max(0, Number(fill[1]) || 0) * radians]
        };
    }

    // A 360 video's frame holds its two lens circles side by side: every
    // pixel is stitched as images.py's dual_fisheye_to_equirect stitches a
    // frame (the same lens model, seam blend, lens gains and pole fill; see
    // fisheyeParams for the uniforms). Directions here are x right, y up,
    // z ahead (the front lens's axis). lens, frontPoint, backPoint,
    // frontWeight and gained are the sums of images.py's _fisheye_point,
    // _seam_mask and _gain_table: the tests run this text's own functions
    // against them (tests/js/glsl.js), so keep them to plain float sums.
    var FISHEYE_SHADER = [
        "#ifdef GL_FRAGMENT_PRECISION_HIGH",
        "precision highp float;",
        "#else",
        "precision mediump float;",
        "#endif",
        "varying vec2 v_pos;",
        "uniform sampler2D u_image;",
        "uniform vec2 u_tan;",
        "uniform float u_yaw;",
        "uniform float u_pitch;",
        "uniform vec3 u_front;",            // the front lens's circle: x (of the width), y, r
        "uniform vec3 u_back;",
        "uniform vec2 u_turn;",             // the front and the back lens's turn (radians)
        "uniform float u_aspect;",          // the frame's height / width
        "uniform float u_scale;",           // 1 / half the field of view (radians)
        "uniform float u_mirror;",
        "uniform float u_blend;",           // radians either side of the seams (0: hard)
        "uniform vec3 u_frontGain;",
        "uniform vec3 u_backGain;",
        "uniform vec2 u_fill;",             // nadir and zenith fill (radians; 0: none)
        "const float PI = 3.14159265358979;",
        "const float FEATHER = 0.0523599;", // images.POLE_FEATHER_DEG
        // Where a lens's circle shows direction d (its axis is +z): an
        // equidistant fisheye, turned and maybe mirrored.
        "vec2 lens(vec3 d, vec3 circle, float turn) {",
        "    float theta = acos(clamp(d.z, -1.0, 1.0));",
        "    float angle = theta < 0.00001 ? 0.0 : atan(d.y, d.x);",
        "    if (u_mirror > 0.5) {",
        "        angle = PI - angle;",
        "    }",
        "    angle += turn;",
        "    float distance = circle.z * theta * u_scale;",
        "    return vec2(circle.x + distance * cos(angle) * u_aspect,",
        "                circle.y - distance * sin(angle));",
        "}",
        "vec2 frontPoint(vec3 d) {",
        "    return lens(d, u_front, u_turn.x);",
        "}",
        // (The back lens looks the other way.)
        "vec2 backPoint(vec3 d) {",
        "    return lens(vec3(-d.x, d.y, -d.z), u_back, u_turn.y);",
        "}",
        // The front lens's share: a smooth ramp across the seams.
        "float frontWeight(vec3 d) {",
        "    float side = asin(clamp(d.z, -1.0, 1.0));",
        "    if (u_blend > 0.0) {",
        "        float t = clamp(0.5 + 0.5 * side / u_blend, 0.0, 1.0);",
        "        return t * t * (3.0 - 2.0 * t);",
        "    }",
        "    return side >= 0.0 ? 1.0 : 0.0;",
        "}",
        // A lens's gain, fading out towards white (no new clipping).
        "vec3 gained(vec3 c, vec3 g) {",
        "    return clamp(c * pow(g, vec3(1.0) - c * c * c * c), 0.0, 1.0);",
        "}",
        "vec3 stitched(vec3 d) {",
        "    float w = frontWeight(d);",
        // (Only the lens or lenses that count: away from the seams one.)
        "    vec3 colour = vec3(0.0);",
        "    if (w > 0.0) {",
        "        colour += w * gained(texture2D(u_image, frontPoint(d)).rgb, u_frontGain);",
        "    }",
        "    if (w < 1.0) {",
        "        colour += (1.0 - w) * gained(texture2D(u_image, backPoint(d)).rgb, u_backGain);",
        "    }",
        "    return colour;",
        "}",
        // The soft fill over a pole (images._fill_pole): within fill of it
        // the colours of the ring just outside are spread over the disc as
        // heat spreads (the Poisson kernel of a disc over 24 fixed points of
        // the ring, each the mean of two: smooth, no spokes), fading in over
        // FEATHER. pole: -1.0 the nadir, 1.0 the zenith.
        // (Compiled only when there is a fill: it costs much where the
        // shader runs on the processor.)
        "#ifdef POLE_FILL",
        "vec3 poleFill(vec3 d, vec3 colour, float fill, float pole) {",
        "    float reach = fill + FEATHER;",
        "    float away = PI / 2.0 - pole * asin(clamp(d.y, -1.0, 1.0));",
        "    if (away >= reach) {",
        "        return colour;",
        "    }",
        "    float lon = atan(d.x, d.z);",
        "    float ring = pole * (PI / 2.0 - reach);",
        "    float rho = 0.75 * away / reach;",
        "    vec3 sum = vec3(0.0);",
        "    float total = 0.0;",
        "    for (int k = 0; k < 24; k++) {",
        "        float at = float(k) * PI / 12.0;",
        "        float weight = (1.0 - rho * rho) / (1.0 - 2.0 * rho * cos(lon - at) + rho * rho);",
        "        float c = cos(ring);",
        "        vec3 node = stitched(vec3(c * sin(at - 0.05), sin(ring), c * cos(at - 0.05))) +",
        "            stitched(vec3(c * sin(at + 0.05), sin(ring), c * cos(at + 0.05)));",
        "        sum += weight * node;",
        "        total += 2.0 * weight;",
        "    }",
        "    float t = clamp((reach - away) / FEATHER, 0.0, 1.0);",
        "    return mix(colour, sum / total, t * t * (3.0 - 2.0 * t));",
        "}",
        "#endif",
        "void main() {",
        "    vec3 d = normalize(vec3(v_pos.x * u_tan.x, v_pos.y * u_tan.y, -1.0));",
        "    float cp = cos(u_pitch);",
        "    float sp = sin(u_pitch);",
        "    d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);",
        "    float cy = cos(u_yaw);",
        "    float sy = sin(u_yaw);",
        "    d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);",
        "    vec3 s = vec3(d.x, d.y, -d.z);",
        "    vec3 colour = stitched(s);",
        "#ifdef POLE_FILL",
        "    if (u_fill.x > 0.0) {",
        "        colour = poleFill(s, colour, u_fill.x, -1.0);",
        "    }",
        "    if (u_fill.y > 0.0) {",
        "        colour = poleFill(s, colour, u_fill.y, 1.0);",
        "    }",
        "#endif",
        "    gl_FragColor = vec4(colour, 1.0);",
        "}"
    ].join("\n");

    var FISHEYE_UNIFORMS = ["u_front", "u_back", "u_turn", "u_aspect", "u_scale", "u_mirror",
                            "u_blend", "u_frontGain", "u_backGain", "u_fill"];

    /* ---------- Edits (pure helpers) ---------------------------------------- */

    // What two tags are compared by: lower case, single spaces.
    function tagKey(tag) {
        return String(tag === null || tag === undefined ? "" : tag).replace(/\s+/g, " ")
            .replace(/^ | $/g, "").toLowerCase();
    }

    // The tags typed into one box: split at commas and semicolons, lower
    // case, no repeats.
    function splitTags(text) {
        var out = [];
        String(text || "").split(/[,;]/).forEach(function (part) {
            var tag = tagKey(part);
            if (tag && out.indexOf(tag) < 0) {
                out.push(tag);
            }
        });
        return out;
    }

    /* The tags shown while editing: [{tag, added}], the owner's first, then
       the model's (modelTags) that were not removed. */
    function editedTags(modelTags, added, removed) {
        var out = [];
        var seen = Object.create(null);
        var gone = Object.create(null);
        (removed || []).forEach(function (tag) {
            gone[tagKey(tag)] = true;
        });
        (added || []).forEach(function (tag) {
            var key = tagKey(tag);
            if (key && !seen[key]) {
                seen[key] = true;
                out.push({tag: key, added: true});
            }
        });
        (modelTags || []).forEach(function (tag) {
            var key = tagKey(tag);
            if (key && !seen[key] && !gone[key]) {
                seen[key] = true;
                out.push({tag: key, added: false});
            }
        });
        return out;
    }

    // The longest tag the server keeps (prompts.ITEM_LENGTH).
    var TAG_LENGTH = 60;

    // A message about tags that cannot be saved (too long), or "".
    function tagProblem(tags) {
        var long = (tags || []).filter(function (tag) {
            return String(tag).length > TAG_LENGTH;
        });
        if (!long.length) {
            return "";
        }
        var shown = long[0].length > 24 ? long[0].slice(0, 24) + "\u2026" : long[0];
        return "\u201c" + shown + "\u201d is too long: a tag can have at most " + TAG_LENGTH +
            " characters.";
    }

    /* The body of a save (POST /images/<id>/edits) from what the form
       holds: a title or description equal to the model's (or empty) is
       sent as null, so the model's text is used. */
    function editBody(model, values) {
        model = model && typeof model === "object" ? model : {};
        function text(name) {
            var value = String(values[name] || "").replace(/^\s+|\s+$/g, "");
            var own = typeof model[name] === "string" ? model[name].replace(/^\s+|\s+$/g, "") : "";
            return value && value !== own ? value : null;
        }
        return {title: text("title"), description: text("description"),
                tags_add: (values.added || []).slice(),
                tags_remove: (values.removed || []).slice()};
    }

    /* "Kahului, Hawaii, United States (3 km)": the place of a record (its
       town, when one is near, with how far it is), or "". A place only
       estimated from the pictures taken around the same time (pe: the
       picture's own position was set aside) says so. */
    function placeText(rec) {
        if (!rec || typeof rec.co !== "string" || !rec.co) {
            return "";
        }
        var text = [rec.ci, rec.rg, rec.co].filter(function (part) {
            return typeof part === "string" && part;
        }).join(", ");
        if (rec.pe) {
            return text + " " + ESTIMATED_PLACE;
        }
        if (rec.ci && typeof rec.km === "number" && isFinite(rec.km)) {
            text += rec.km < 1 ? " (under 1 km)" : " (" + Math.round(rec.km) + " km)";
        }
        return text;
    }

    var ESTIMATED_PLACE = "(estimated from pictures taken around the same time)";

    var format = {
        tagKey: tagKey,
        placeText: placeText,
        splitTags: splitTags,
        tagProblem: tagProblem,
        editedTags: editedTags,
        editBody: editBody,
        parseDate: parseDate,
        monthLabel: monthLabel,
        shortDate: shortDate,
        longDate: longDate,
        exposureParts: exposureParts,
        fileSize: fileSize,
        durationText: durationText,
        codecName: codecName,
        canPlayVideo: canPlayVideo,
        videoFacts: videoFacts,
        driveTimeline: driveTimeline,
        drivePlace: drivePlace,
        segments: segments,
        panoDrag: panoDrag,
        panoZoom: panoZoom,
        panoTangents: panoTangents,
        panoLookup: panoLookup,
        fisheyeParams: fisheyeParams,
        fisheyeShader: FISHEYE_SHADER,
        MIN_FOV: MIN_FOV,
        MAX_FOV: MAX_FOV
    };

    if (!hasDocument) {
        return {format: format};
    }

    /* ---------- DOM helpers ------------------------------------------------ */

    function el(tag, props, children) {
        if (window.SHELL && SHELL.el) {
            return SHELL.el(tag, props, children);
        }
        var node = document.createElement(tag);
        Object.keys(props || {}).forEach(function (key) {
            if (key === "text") {
                node.textContent = String(props[key]);
            } else if (key === "attrs") {
                Object.keys(props.attrs).forEach(function (name) {
                    if (props.attrs[name] !== null && props.attrs[name] !== undefined) {
                        node.setAttribute(name, String(props.attrs[name]));
                    }
                });
            } else if (key === "on") {
                Object.keys(props.on).forEach(function (name) {
                    node.addEventListener(name, props.on[name]);
                });
            } else if (props[key] !== undefined && props[key] !== null) {
                node[key] = props[key];
            }
        });
        (Array.isArray(children) ? children : children ? [children] : []).forEach(function (child) {
            if (child) {
                node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
            }
        });
        return node;
    }

    function clear(node) {
        while (node && node.firstChild) {
            node.removeChild(node.firstChild);
        }
        return node;
    }

    function toast(message, kind) {
        if (window.SHELL && SHELL.toast) {
            SHELL.toast(message, kind);
        }
    }

    function admin() {
        return Boolean(window.SITE && SITE.capabilities && SITE.capabilities.admin &&
                       !SITE.capabilities.static && window.SHELL && SHELL.admin);
    }

    function plural(count, word, words) {
        if (window.SHELL && SHELL.format) {
            return SHELL.format.plural(count, word, words);
        }
        return count + " " + (count === 1 ? word : words || word + "s");
    }

    // Text with the query's matches wrapped in <mark> (DOM nodes only).
    function highlighted(textValue, query, field) {
        var span = el("span", {className: "hl-text"});
        var ranges = [];
        if (query && window.SearchCore && SearchCore.highlights) {
            try {
                ranges = SearchCore.highlights(textValue, query, field);
            } catch (error) {
                ranges = [];
            }
        }
        segments(textValue, ranges).forEach(function (part) {
            span.appendChild(part.mark ? el("mark", {text: part.text})
                : document.createTextNode(part.text));
        });
        return span;
    }

    /* ---------- Panorama (WebGL) ------------------------------------------- */

    var VERTEX_SHADER = [
        "attribute vec2 a_pos;",
        "varying vec2 v_pos;",
        "void main() {",
        "    v_pos = a_pos;",
        "    gl_Position = vec4(a_pos, 0.0, 1.0);",
        "}"
    ].join("\n");

    // For every pixel: the direction it looks in, turned by pitch and yaw,
    // as longitude and latitude on the equirectangular picture.
    var FRAGMENT_SHADER = [
        "#ifdef GL_FRAGMENT_PRECISION_HIGH",
        "precision highp float;",
        "#else",
        "precision mediump float;",
        "#endif",
        "varying vec2 v_pos;",
        "uniform sampler2D u_image;",
        "uniform vec2 u_tan;",
        "uniform float u_yaw;",
        "uniform float u_pitch;",
        "const float PI = 3.14159265358979;",
        "void main() {",
        "    vec3 d = normalize(vec3(v_pos.x * u_tan.x, v_pos.y * u_tan.y, -1.0));",
        "    float cp = cos(u_pitch);",
        "    float sp = sin(u_pitch);",
        "    d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);",
        "    float cy = cos(u_yaw);",
        "    float sy = sin(u_yaw);",
        "    d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);",
        "    float lon = atan(d.x, -d.z);",
        "    float lat = asin(clamp(d.y, -1.0, 1.0));",
        "    vec2 uv = vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 - lat / PI);",
        "    gl_FragColor = texture2D(u_image, uv);",
        "}"
    ].join("\n");

    function compile(gl, type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    // A WebGL panorama on canvas; .ok is false when WebGL is not available.
    function Panorama(canvas) {
        this.canvas = canvas;
        this.ok = false;
        this.gl = null;
        this.textureWidth = 0;              // the picture shown (see setImage)
        this.textureLimit = 0;              // the widest this browser takes
        var gl = null;
        try {
            gl = canvas.getContext("webgl", {antialias: false, depth: false}) ||
                canvas.getContext("experimental-webgl");
        } catch (error) {
            gl = null;
        }
        if (!gl) {
            return;
        }
        this.gl = gl;
        var buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
                      gl.STATIC_DRAW);
        this.buffer = buffer;
        // The equirectangular picture's program; a 360 video's frames use
        // FISHEYE_SHADER (useFisheye).
        this.equirect = this.program(FRAGMENT_SHADER, []);
        this.fisheye = null;
        this.current = null;
        if (!this.equirect) {
            this.gl = null;
            return;
        }
        this.use(this.equirect);
        this.texture = gl.createTexture();
        this.ok = true;
    }

    // A linked program with fragment shader source: {program, position,
    // uniforms (tan, yaw, pitch, image and the names asked for)}, or null.
    Panorama.prototype.program = function (source, names) {
        var gl = this.gl;
        var vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
        var fragment = compile(gl, gl.FRAGMENT_SHADER, source);
        if (!vertex || !fragment) {
            return null;
        }
        var program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            return null;
        }
        var uniforms = {
            tan: gl.getUniformLocation(program, "u_tan"),
            yaw: gl.getUniformLocation(program, "u_yaw"),
            pitch: gl.getUniformLocation(program, "u_pitch"),
            image: gl.getUniformLocation(program, "u_image")
        };
        names.forEach(function (name) {
            uniforms[name] = gl.getUniformLocation(program, name);
        });
        return {program: program, position: gl.getAttribLocation(program, "a_pos"),
                uniforms: uniforms};
    };

    Panorama.prototype.use = function (info) {
        var gl = this.gl;
        gl.useProgram(info.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(info.position);
        gl.vertexAttribPointer(info.position, 2, gl.FLOAT, false, 0, 0);
        this.current = info;
        this.uniforms = info.uniforms;
    };

    /* Draw a 360 video's frames from now on: fx is the record's lens
       geometry, width x height the frame's size (see fisheyeParams). False
       when that cannot be done (no such shader here, or fx unusable). */
    Panorama.prototype.useFisheye = function (fx, width, height) {
        var gl = this.gl;
        var p = this.ok ? fisheyeParams(fx, width, height) : null;
        if (!p) {
            return false;
        }
        // Two programs: with the pole fill, and (much cheaper) without.
        var key = p.fill[0] > 0 || p.fill[1] > 0 ? "fill" : "plain";
        this.fisheyes = this.fisheyes || {};
        if (!(key in this.fisheyes)) {
            this.fisheyes[key] = this.program((key === "fill" ? "#define POLE_FILL\n" : "") +
                                              FISHEYE_SHADER, FISHEYE_UNIFORMS) || false;
        }
        this.fisheye = this.fisheyes[key];
        if (!this.fisheye) {
            return false;
        }
        if (this.current !== this.fisheye) {
            this.use(this.fisheye);
        }
        var u = this.uniforms;
        gl.uniform3f(u.u_front, p.front[0], p.front[1], p.front[2]);
        gl.uniform3f(u.u_back, p.back[0], p.back[1], p.back[2]);
        gl.uniform2f(u.u_turn, p.frontTurn, p.backTurn);
        gl.uniform1f(u.u_aspect, p.aspect);
        gl.uniform1f(u.u_scale, p.scale);
        gl.uniform1f(u.u_mirror, p.mirror ? 1 : 0);
        gl.uniform1f(u.u_blend, p.blend);
        gl.uniform3f(u.u_frontGain, p.frontGain[0], p.frontGain[1], p.frontGain[2]);
        gl.uniform3f(u.u_backGain, p.backGain[0], p.backGain[1], p.backGain[2]);
        gl.uniform2f(u.u_fill, p.fill[0], p.fill[1]);
        // (What the uniforms were set for: setVideo sets them again for others.)
        this.fisheyeFor = {fx: fx, size: width + "x" + height};
        return true;
    };

    /* Upload the video's current frame (its lenses side by side) and draw
       it stitched from now on (fx: see useFisheye). true when there is no
       frame yet (the picture stays); false when it cannot be done: no
       shader, or the browser refuses the frame (a video from another
       origin, an export opened from disk). */
    Panorama.prototype.setVideo = function (video, fx) {
        var gl = this.gl;
        if (!this.ok) {
            return false;
        }
        var width = video.videoWidth;
        var height = video.videoHeight;
        if (!width || !height || video.readyState < 2) {
            return true;
        }
        var set = this.fisheyeFor;
        if ((this.current !== this.fisheye || !set || set.fx !== fx ||
             set.size !== width + "x" + height) &&
                !this.useFisheye(fx, width, height)) {
            return false;
        }
        try {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        } catch (error) {
            return false;
        }
        if (gl.getError() !== gl.NO_ERROR) {
            return false;
        }
        this.textureWidth = width;
        return true;
    };

    // The widest texture used. A pano is at most 4096 px wide (images.py
    // PANO_EDGE), but an export may name a larger picture; 8192 x 4096 is
    // already about 23 pixels per degree, sharp on any screen.
    var MAX_PANO_TEXTURE = 8192;

    // Upload the picture; false when the browser refuses (a picture from
    // another origin, e.g. an export opened from disk).
    Panorama.prototype.setImage = function (image) {
        var gl = this.gl;
        if (!this.ok) {
            return false;
        }
        var source = image;
        var limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, MAX_PANO_TEXTURE);
        var width = image.naturalWidth || image.width;
        var height = image.naturalHeight || image.height;
        if (!width || !height) {
            return false;
        }
        if (width > limit || height > limit) {
            var scale = limit / Math.max(width, height);
            source = document.createElement("canvas");
            source.width = Math.max(1, Math.floor(width * scale));
            source.height = Math.max(1, Math.floor(height * scale));
            source.getContext("2d").drawImage(image, 0, 0, source.width, source.height);
        }
        if (this.current !== this.equirect) {
            this.use(this.equirect);
        }
        try {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
        } catch (error) {
            return false;
        }
        if (gl.getError() !== gl.NO_ERROR) {
            return false;
        }
        this.textureWidth = source.width || source.naturalWidth || 0;
        this.textureLimit = limit;
        return true;
    };

    // Whether a wider picture than the one shown would be shown sharper.
    Panorama.prototype.canShowWider = function () {
        return this.ok && this.textureWidth < this.textureLimit;
    };

    Panorama.prototype.draw = function (view) {
        var gl = this.gl;
        if (!this.ok || gl.isContextLost()) {
            return;
        }
        var canvas = this.canvas;
        var ratio = Math.min(2, window.devicePixelRatio || 1);
        var width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        var height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        var tangents = panoTangents(view.fov, width, height);
        gl.uniform2f(this.uniforms.tan, tangents.x, tangents.y);
        gl.uniform1f(this.uniforms.yaw, view.yaw);
        gl.uniform1f(this.uniforms.pitch, view.pitch);
        gl.uniform1i(this.uniforms.image, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    Panorama.prototype.destroy = function () {
        if (this.gl) {
            var lose = this.gl.getExtension("WEBGL_lose_context");
            this.gl.deleteTexture(this.texture);
            if (lose) {
                lose.loseContext();
            }
        }
        this.ok = false;
        this.gl = null;
    };

    /* ---------- Stage: one picture, zoomable, or a panorama ------------------ */

    var SWIPE_DISTANCE = 60;
    var DOUBLE_TAP_MS = 300;

    /* Load a large picture (url) for WebGL and call done(picture) once:
       with an ImageBitmap or a loaded image, or null when there is none.
       Where the browser can, it is fetched and decoded away from the
       page's thread (createImageBitmap), so handing it to WebGL does not
       stall a drag; otherwise (an export opened from disk, an older
       browser) it is loaded as an image. Returns a function that cancels
       the load (done is then not called). */
    function loadLarge(url, done) {
        var cancelled = false;
        var image = null;
        var controller = typeof AbortController === "function" ? new AbortController() : null;

        function finish(picture) {
            if (cancelled) {
                release(picture);
            } else {
                done(picture);
            }
        }

        function asImage() {
            if (cancelled) {
                return;
            }
            image = new Image();
            image.decoding = "async";
            image.onload = function () {
                finish(image);
            };
            image.onerror = function () {
                finish(null);
            };
            image.src = url;
        }

        if (typeof window.fetch === "function" && typeof window.createImageBitmap === "function"
                && !(window.location && window.location.protocol === "file:")) {
            window.fetch(url, controller ? {signal: controller.signal} : {})
                .then(function (response) {
                    if (!response.ok) {
                        return null;
                    }
                    return response.blob().then(function (blob) {
                        return window.createImageBitmap(blob);
                    });
                })
                .then(finish, asImage);
        } else {
            asImage();
        }
        return function () {
            cancelled = true;
            if (controller) {
                controller.abort();
            }
            if (image) {
                image.onload = null;
                image.onerror = null;
                image.removeAttribute("src");      // stops the download
            }
        };
    }

    // Free the memory of an ImageBitmap (an image needs nothing).
    function release(picture) {
        if (picture && typeof picture.close === "function") {
            picture.close();
        }
    }

    function Stage(box, options) {
        var self = this;
        this.box = box;
        this.options = options || {};
        box.classList.add("stage");
        this.img = el("img", {className: "stage-img", alt: "", draggable: false});
        this.img.decoding = "async";
        // Until the picture's size is known, fit it once it has loaded.
        this.img.addEventListener("load", function () {
            if (!self.natural.w && self.mode === "image") {
                self.layout();
            }
        });
        this.canvas = null;
        this.pano = null;
        this.drive = null;                  // the drive shown (showDrive)
        this.video = null;                  // the <video> of a video record
        this.pendingVideo = null;           // urls of a video waiting for a playable copy
        this.copyToken = 0;                 // the show the full record said has a copy
        this.controls = null;               // a 360 video's own controls (videoControls)
        this.fisheyeBox = null;             // a 360 video shown flat (flat360Video)
        this.note = el("div", {className: "stage-note", hidden: true});
        this.busy = el("div", {className: "stage-busy", hidden: true, attrs: {"aria-hidden": "true"}});
        box.appendChild(this.img);
        box.appendChild(this.busy);
        box.appendChild(this.note);
        this.rec = null;
        this.token = 0;
        this.cancelSharp = null;            // stops loading the large panorama (sharpen)
        this.mode = "image";                // "image", "pano" or "video"
        this.view = {yaw: 0, pitch: 0, fov: DEFAULT_FOV};
        this.zoom = 1;
        this.tx = 0;
        this.ty = 0;
        this.base = {w: 1, h: 1};           // the picture's size at zoom 1
        this.natural = {w: 0, h: 0};        // pixels of the picture shown
        this.pointers = {};
        this.gesture = null;
        this.lastTap = null;
        this.frame = 0;
        this.handlers = {
            down: function (event) {
                self.pointerDown(event);
            },
            move: function (event) {
                self.pointerMove(event);
            },
            up: function (event) {
                self.pointerUp(event);
            },
            wheel: function (event) {
                self.wheel(event);
            },
            dblclick: function (event) {
                self.doubleClick(event);
            },
            resize: function () {
                self.layout();
            }
        };
        box.addEventListener("pointerdown", this.handlers.down);
        box.addEventListener("pointermove", this.handlers.move);
        box.addEventListener("pointerup", this.handlers.up);
        box.addEventListener("pointercancel", this.handlers.up);
        box.addEventListener("wheel", this.handlers.wheel, {passive: false});
        box.addEventListener("dblclick", this.handlers.dblclick);
        window.addEventListener("resize", this.handlers.resize);
    }

    Stage.prototype.destroy = function () {
        var box = this.box;
        box.removeEventListener("pointerdown", this.handlers.down);
        box.removeEventListener("pointermove", this.handlers.move);
        box.removeEventListener("pointerup", this.handlers.up);
        box.removeEventListener("pointercancel", this.handlers.up);
        box.removeEventListener("wheel", this.handlers.wheel);
        box.removeEventListener("dblclick", this.handlers.dblclick);
        window.removeEventListener("resize", this.handlers.resize);
        this.dropSharp();
        this.dropPano();
        this.dropVideo();
        this.dropDrive();
        this.token += 1;
    };

    // Stop a video and take its player away (its download stops too).
    Stage.prototype.dropVideo = function () {
        var video = this.video;
        this.video = null;
        this.pendingVideo = null;
        this.box.classList.remove("is-video");
        this.box.classList.remove("has-controls");
        [this.controls, this.fisheyeBox].forEach(function (node) {
            if (node && node.parentNode) {
                node.parentNode.removeChild(node);
            }
        });
        this.controls = null;
        this.fisheyeBox = null;
        if (!video) {
            return;
        }
        try {
            video.pause();
            video.removeAttribute("src");
            video.load();
        } catch (error) {
            // (Already gone.)
        }
        if (video.parentNode) {
            video.parentNode.removeChild(video);
        }
    };

    // Seek a video by seconds (the arrow keys while the player has the
    // focus; across the clips of a drive); false when no video is shown.
    Stage.prototype.seekBy = function (seconds) {
        if (this.drive) {
            this.driveSeekTo(this.drive.position + seconds);
            return true;
        }
        var video = this.video;
        if (!video) {
            return false;
        }
        var end = isFinite(video.duration) ? video.duration : Infinity;
        try {
            video.currentTime = Math.max(0, Math.min(end, (video.currentTime || 0) + seconds));
        } catch (error) {
            // (Not seekable yet.)
        }
        return true;
    };

    // Is a video playing (for Space)? Toggles play and pause; false when no video.
    Stage.prototype.togglePlay = function () {
        var video = this.video;
        if (!video) {
            return false;
        }
        if (video.paused || video.ended) {
            var playing = video.play();
            if (playing && typeof playing.catch === "function") {
                playing.catch(function () {});
            }
        } else {
            video.pause();
        }
        return true;
    };

    /* A video record (rec.mv): the poster (the preview) at once, then the
       player when there is something this browser can play (urls.video,
       format.canPlayVideo, or urls.playableCopy: the server sends an H.264
       copy). Otherwise the poster stays with a note saying why; urls.original
       (the admin's download of the original) is offered there. */
    Stage.prototype.showVideo = function (rec, urls) {
        if (urls.drive && rec.p !== "360") {
            this.showDrive(rec, urls);
            return;
        }
        this.mode = "video";
        this.box.classList.add("is-video");
        this.natural = {w: rec.w || 0, h: rec.hgt || 0};
        this.img.hidden = false;
        this.img.alt = altText(rec);
        this.img.src = urls.preview || urls.thumb || "";
        this.layout();
        this.busy.hidden = true;
        var probe = function (type) {
            return document.createElement("video").canPlayType(type);
        };
        if (!urls.video) {
            this.setNote(urls.videoNote || "Only a still frame of this video is shown here.");
        } else if (urls.playableCopy || canPlayVideo(rec, probe)) {
            this.startVideo(rec, urls);
        } else {
            this.pendingVideo = urls;
            this.cannotPlay(rec, urls);
        }
        this.state();
    };

    Stage.prototype.cannotPlay = function (rec, urls) {
        var codec = rec && rec.vc ? " (" + codecName(rec.vc) + ")" : "";
        // (A download: a tab that cannot decode it would play only its sound.)
        this.setNote("This browser can't play this video" + codec + ".", urls.original ? {
            href: urls.original, text: "Download the original", download: true} : null);
    };

    Stage.prototype.startVideo = function (rec, urls) {
        var self = this;
        var token = this.token;
        this.pendingVideo = null;
        var video = el("video", {className: "stage-video",
                                 attrs: {"aria-label": "Video: " + altText(rec)}});
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        if (urls.preview || urls.thumb) {
            video.poster = urls.preview || urls.thumb;
        }
        function failed() {
            if (token !== self.token || self.video !== video) {
                return;
            }
            self.dropVideo();
            self.mode = "video";
            self.box.classList.add("is-video");
            self.img.hidden = false;
            self.cannotPlay(rec, urls);
        }
        video.addEventListener("error", failed);
        // A browser without the video's decoder may still "play" its sound,
        // with no picture and no error.
        video.addEventListener("loadedmetadata", function () {
            if (!video.videoWidth) {
                failed();
            }
        });
        video.src = urls.video;
        this.box.insertBefore(video, this.note);
        this.video = video;
        this.img.hidden = true;
        this.setNote("");
    };

    // The full record of the video shown has arrived: a playable copy may
    // now let it play (a drive: see driveDetail; a 360 video whose poster
    // is still loading: once it is there, see show360Video).
    Stage.prototype.videoDetail = function (detail) {
        if (this.drive) {
            this.driveDetail(detail);
            return;
        }
        if (!detail || !detail.playable_copy || !this.rec || detail.id !== this.rec.i) {
            return;
        }
        var urls = this.pendingVideo;
        if (!urls) {
            this.copyToken = this.token;
        } else if (this.rec.p === "360") {
            this.start360Video(this.rec, urls);
        } else {
            this.startVideo(this.rec, urls);
        }
    };

    /* A 360 video (rec.mv, rec.p "360"): its poster (the preview: a
       stitched panorama) in the 360 view at once, as a 360 photo's; then
       the player when there is something to play (urls.video: its LRV, a
       playable copy -- both lenses side by side -- or an original that
       holds both in one stream) and its lens geometry (rec.fx). Its frames
       are stitched as they play (start360Video). A record without vc has
       nothing a browser plays but a playable copy (urls.playableCopy, or
       the full record's playable_copy later: videoDetail). */
    Stage.prototype.show360Video = function (rec, urls, token) {
        var self = this;
        this.natural = {w: rec.w || 0, h: rec.hgt || 0};
        this.img.alt = altText(rec);
        this.img.src = urls.thumb || urls.preview || "";
        this.layout();
        var probe = function (type) {
            return document.createElement("video").canPlayType(type);
        };
        var geometry = rec.fx && typeof rec.fx === "object" ? rec.fx : null;
        function player() {
            var copy = urls.playableCopy || self.copyToken === token;
            if (urls.video && geometry && (copy || (rec.vc && canPlayVideo(rec, probe)))) {
                self.start360Video(rec, urls);
            } else if (!urls.video) {
                self.setNote(urls.videoNote || "Only a still frame of this video is shown here.");
            } else if (!geometry) {
                self.setNote("This 360\u00b0 video can't be played here.");
            } else {
                self.pendingVideo = urls;
                self.cannotPlay360(rec, urls, false);
            }
            self.state();
        }
        if (!urls.preview) {
            player();
            return;
        }
        this.busy.hidden = false;
        var loader = new Image();
        loader.decoding = "async";
        loader.onload = function () {
            if (token !== self.token) {
                return;
            }
            self.busy.hidden = true;
            self.natural = {w: loader.naturalWidth, h: loader.naturalHeight};
            if (!self.startPano(loader, loader.src)) {
                self.img.src = loader.src;
                self.layout();
            }
            player();
        };
        loader.onerror = function () {
            if (token !== self.token) {
                return;
            }
            self.busy.hidden = true;
            player();
        };
        loader.src = urls.preview;
        this.state();
    };

    /* Why a 360 video does not play. failed: the player tried and failed
       (when the browser plays its codec: the file could not be loaded). A
       record without vc has no LRV (see search_index.add_video): only a
       playable copy (the proxies job) plays it. Else the browser cannot
       play its codec (cannotPlay). */
    Stage.prototype.cannotPlay360 = function (rec, urls, failed) {
        var probe = function (type) {
            return document.createElement("video").canPlayType(type);
        };
        if (rec && rec.vc && !(failed && canPlayVideo(rec, probe))) {
            this.cannotPlay(rec, urls);
        } else if (failed) {
            this.setNote("This 360\u00b0 video could not be loaded.");
        } else if (admin()) {
            this.setNote("This 360\u00b0 video has no low-resolution copy (.lrv) to play. " +
                         "Make playable copies on the Manage page to play it.");
        } else {
            this.setNote("Only a still frame of this video is shown here.");
        }
    };

    /* Play a 360 video on the sphere: a <video> that is never shown plays
       urls.video, and each of its frames is uploaded to the 360 view and
       stitched there (Panorama.setVideo: the fisheye shader with rec.fx)
       as the frames come (requestVideoFrameCallback, else every animation
       frame while it plays). The stage gets controls of its own
       (videoControls); Space works as for a video. Without WebGL, or when
       the browser does not let the view read the frames (an export opened
       from disk), it plays flat (flat360Video). */
    Stage.prototype.start360Video = function (rec, urls) {
        var self = this;
        var token = this.token;
        this.pendingVideo = null;
        if (!this.pano && !this.startPano(null, null)) {
            this.flat360Video(rec, urls, 0, false);
            return;
        }
        var video = document.createElement("video");
        video.preload = "metadata";
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        var running = false;
        function live() {
            return token === self.token && self.video === video;
        }
        function failed() {
            if (!live()) {
                return;
            }
            self.dropVideo();
            self.cannotPlay360(rec, urls, true);
            self.state();
        }
        function frame() {
            if (!live()) {
                return false;
            }
            if (!self.pano || !self.pano.setVideo(video, rec.fx)) {
                // The 360 view cannot show the frames (or it stopped): flat.
                var at = video.currentTime || 0;
                var playing = !video.paused && !video.ended;
                self.dropVideo();
                self.dropPano();
                self.flat360Video(rec, urls, at, playing);
                return false;
            }
            self.redraw();
            return true;
        }
        function tick() {
            running = false;
            if (frame() && !video.paused && !video.ended) {
                running = true;
                if (typeof video.requestVideoFrameCallback === "function") {
                    video.requestVideoFrameCallback(tick);
                } else {
                    window.requestAnimationFrame(tick);
                }
            }
        }
        video.addEventListener("error", failed);
        video.addEventListener("loadedmetadata", function () {
            if (!video.videoWidth) {
                failed();
            }
        });
        video.addEventListener("play", function () {
            if (!running) {
                tick();
            }
        });
        // (Moved while paused: the frame there.)
        video.addEventListener("seeked", frame);
        video.src = urls.video;
        this.video = video;
        this.controls = this.videoControls(video);
        this.box.insertBefore(this.controls, this.note);
        this.box.classList.add("has-controls");
        this.setNote("");
    };

    /* A 360 video played flat: its front lens's circle (the middle of the
       panorama) fills a square, upright (a lens laid sideways in the frame
       is turned, and then plays under the stage's own controls: the
       browser's would turn with it), from at seconds (and playing when it
       was). */
    Stage.prototype.flat360Video = function (rec, urls, at, playing) {
        var self = this;
        var token = this.token;
        var geometry = rec.fx && typeof rec.fx === "object" ? rec.fx : {};
        var front = geometry.front === 0 ? 0 : 1;
        var turn = Array.isArray(geometry.turn) ? Number(geometry.turn[front]) || 0 : 0;
        // (Whole quarter turns: a small one does not matter here.)
        var quarter = ((Math.round(turn / 90) % 4) + 4) % 4 * 90;
        this.mode = "video";
        this.box.classList.add("is-video");
        this.box.classList.remove("is-pano");
        var video = el("video", {className: "stage-video stage-fisheye-video",
                                 attrs: {"aria-label": "Video: " + altText(rec)}});
        video.controls = !quarter;
        video.preload = "metadata";
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.style.objectPosition = (front === 0 ? "0%" : "100%") + " 50%";
        if (quarter) {
            video.style.transform = "rotate(" + quarter + "deg)";
        }
        video.addEventListener("error", function () {
            if (token === self.token && self.video === video) {
                self.dropVideo();
                self.mode = "video";
                self.box.classList.add("is-video");
                self.img.hidden = false;
                self.layout();
                self.cannotPlay360(rec, urls, true);
            }
        });
        if (at || playing) {
            video.addEventListener("loadedmetadata", function () {
                try {
                    video.currentTime = at || 0;
                } catch (error) {
                    // (Not seekable: from the start.)
                }
                if (playing) {
                    var started = video.play();
                    if (started && typeof started.catch === "function") {
                        started.catch(function () {});
                    }
                }
            });
        }
        video.src = urls.video;
        var box = el("div", {className: "stage-fisheye"}, [video]);
        this.box.insertBefore(box, this.note);
        this.fisheyeBox = box;
        this.video = video;
        if (quarter) {
            this.controls = this.videoControls(video);
            this.box.insertBefore(this.controls, this.note);
            this.box.classList.add("has-controls");
        }
        this.img.hidden = true;
        this.layout();
        this.setNote(window.location && window.location.protocol === "file:"
            ? "The 360\u00b0 view needs the site to be opened from a web server; this is " +
              "the front lens."
            : "This browser cannot show the 360\u00b0 view here; this is the front lens.");
        this.state();
    };

    /* The controls of a 360 video played on the sphere (its <video> is
       not shown): play and pause, where it is, a bar to move in it, and
       the sound on or off. */
    Stage.prototype.videoControls = function (video) {
        var self = this;
        var play = el("button", {className: "stage-control stage-play", text: "\u25b6",
                                 attrs: {type: "button", "aria-label": "Play"}});
        var time = el("span", {className: "stage-time", text: "0:00"});
        var seek = el("input", {className: "stage-seek",
                                attrs: {type: "range", min: "0", max: "1000", step: "1",
                                        value: "0", "aria-label": "Where in the video"}});
        var sound = el("button", {className: "stage-control stage-sound", text: "Sound",
                                  attrs: {type: "button", "aria-pressed": "true",
                                          title: "Sound on or off"}});
        var dragging = false;
        function update() {
            var length = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
            var playing = !video.paused && !video.ended;
            play.textContent = playing ? "\u275a\u275a" : "\u25b6";
            play.setAttribute("aria-label", playing ? "Pause" : "Play");
            time.textContent = durationText(video.currentTime || 0) +
                (length ? " / " + durationText(length) : "");
            if (!dragging && length) {
                seek.value = String(Math.round(1000 * (video.currentTime || 0) / length));
            }
            sound.textContent = video.muted ? "Muted" : "Sound";
            sound.setAttribute("aria-pressed", video.muted ? "false" : "true");
        }
        play.addEventListener("click", function () {
            self.togglePlay();
        });
        seek.addEventListener("input", function () {
            dragging = true;
            if (isFinite(video.duration) && video.duration > 0) {
                try {
                    video.currentTime = Number(seek.value) / 1000 * video.duration;
                } catch (error) {
                    // (Not seekable yet.)
                }
            }
        });
        seek.addEventListener("change", function () {
            dragging = false;
            update();
        });
        sound.addEventListener("click", function () {
            video.muted = !video.muted;
            update();
        });
        ["play", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata",
         "volumechange", "seeked"].forEach(function (name) {
            video.addEventListener(name, update);
        });
        update();
        return el("div", {className: "stage-controls",
                          attrs: {role: "group", "aria-label": "360\u00b0 video"}},
                  [play, time, seek, sound]);
    };

    Stage.prototype.dropPano = function () {
        if (this.pano) {
            this.pano.destroy();
            this.pano = null;
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
    };

    // A note over the picture; link ({href, text, download}) adds a link after it.
    Stage.prototype.setNote = function (text, link) {
        this.note.textContent = text || "";
        this.note.classList.toggle("has-link", Boolean(link));
        if (link) {
            this.note.appendChild(document.createTextNode(" "));
            this.note.appendChild(el("a", {href: link.href, text: link.text,
                                           attrs: link.download ? {download: ""}
                                               : {target: "_blank", rel: "noopener"}}));
        }
        this.note.hidden = !text;
    };

    Stage.prototype.state = function () {
        if (this.options.onState) {
            this.options.onState({zoomed: this.zoom > 1.01, pano: this.mode === "pano",
                                  zoom: this.zoom, video: this.mode === "video"});
        }
    };

    /* Show a record: urls {thumb, preview, pano}. The thumbnail shows at
       once, the preview replaces it when it has loaded. A 360-degree photo
       then becomes the interactive view, and only then is its large
       panorama (urls.pano) loaded, to be swapped in when it has arrived
       (see sharpen): so it does not slow the preview down, and a browser
       that cannot show the view (or nothing wider than the preview) never
       asks for it. A video record plays (see showVideo): urls.video,
       urls.playableCopy, urls.original, urls.videoNote (VIEWER.stageUrls). */
    Stage.prototype.show = function (rec, urls) {
        var self = this;
        var token = ++this.token;
        this.rec = rec;
        this.dropSharp();
        this.dropPano();
        this.dropVideo();
        this.dropDrive();
        if (!rec) {
            this.img.removeAttribute("src");
            this.busy.hidden = true;
            this.setNote("");
            return;
        }
        this.mode = "image";
        this.view = {yaw: 0, pitch: 0, fov: DEFAULT_FOV};
        this.zoom = 1;
        this.img.hidden = false;
        this.box.classList.remove("is-pano");
        this.box.removeAttribute("data-texture-width");
        this.setNote("");
        if (rec.mv && rec.p === "360") {
            this.show360Video(rec, urls || {}, token);
            return;
        }
        if (rec.mv) {
            this.showVideo(rec, urls || {});
            return;
        }
        this.natural = {w: rec && rec.w ? rec.w : 0, h: rec && rec.hgt ? rec.hgt : 0};
        this.img.alt = altText(rec);
        this.img.src = urls.thumb || urls.preview || "";
        this.layout();
        var wantPano = rec && rec.p === "360";
        var panoUrl = wantPano ? urls.pano || null : null;
        if (!urls.preview) {
            if (panoUrl) {
                // The large panorama starts the view itself.
                this.busy.hidden = false;
                this.sharpen(panoUrl, true);
            } else if (wantPano) {
                this.setNote("360\u00b0 photo (shown flat)");
            }
            this.state();
            return;
        }
        this.busy.hidden = false;
        var loader = new Image();
        loader.decoding = "async";
        loader.onload = function () {
            if (token !== self.token) {
                return;
            }
            self.busy.hidden = true;
            self.natural = {w: loader.naturalWidth, h: loader.naturalHeight};
            if (wantPano && self.startPano(loader, loader.src)) {
                if (self.pano.canShowWider()) {
                    self.sharpen(panoUrl, false);
                }
                return;
            }
            self.img.src = loader.src;
            self.layout();
            if (wantPano) {
                self.setNote(flatPanoramaNote());
            }
            self.state();
        };
        loader.onerror = function () {
            if (token !== self.token) {
                return;
            }
            if (panoUrl) {
                // The large panorama may still be there, and start the view.
                self.sharpen(panoUrl, true);
                return;
            }
            self.busy.hidden = true;
            self.setNote("Showing a small version: the full picture cannot be read right now.");
            self.state();
        };
        loader.src = urls.preview;
        this.state();
    };

    /* Start the 360-degree view with a picture (an image or ImageBitmap;
       null: a 360 video's frames will come); flatUrl is that picture's
       address, shown flat if the view stops. False when this browser
       cannot show the view. */
    Stage.prototype.startPano = function (picture, flatUrl) {
        var self = this;
        var canvas = el("canvas", {className: "stage-pano",
                                   attrs: {"aria-label": "360\u00b0 view: drag to look around"}});
        this.box.insertBefore(canvas, this.note);
        var pano = new Panorama(canvas);
        if (!pano.ok || (picture && !pano.setImage(picture))) {
            pano.destroy();
            if (canvas.parentNode) {
                canvas.parentNode.removeChild(canvas);
            }
            return false;
        }
        canvas.addEventListener("webglcontextlost", function (event) {
            event.preventDefault();
            if (self.pano === pano) {
                self.dropPano();
                self.mode = "image";
                self.img.hidden = false;
                if (flatUrl) {
                    self.img.src = flatUrl;
                }
                self.box.classList.remove("is-pano");
                self.layout();
                self.setNote("The 360\u00b0 view stopped; this is the flat panorama.");
                self.state();
            }
        });
        this.canvas = canvas;
        this.pano = pano;
        this.mode = "pano";
        this.img.hidden = true;
        this.box.classList.add("is-pano");
        this.box.setAttribute("data-texture-width", String(pano.textureWidth || ""));
        this.redraw();
        this.state();
        return true;
    };

    /* The 2048 px preview is soft as a 360-degree view (about 6 pixels per
       degree, stretched across the screen): load the large panorama (url,
       SITE.panoUrl; see loadLarge). When the view runs on the preview, the
       panorama is swapped in once it has arrived; until then, and if it
       cannot be loaded, the preview stays. alone: there is no preview, so
       the panorama starts the view itself. */
    Stage.prototype.sharpen = function (url, alone) {
        var self = this;
        var token = this.token;
        this.dropSharp();
        if (!url) {
            return;
        }
        this.cancelSharp = loadLarge(url, function (picture) {
            if (token !== self.token) {
                release(picture);
                return;
            }
            self.cancelSharp = null;
            if (alone) {
                self.busy.hidden = true;
                if (picture) {
                    self.showSharpAlone(picture, url);
                } else {
                    self.setNote("Showing a small version: the full picture cannot be " +
                                 "read right now.");
                    self.state();
                }
            } else if (picture) {
                self.useSharp(picture);
            }
            release(picture);
        });
    };

    // Stop loading the large panorama.
    Stage.prototype.dropSharp = function () {
        var cancel = this.cancelSharp;
        this.cancelSharp = null;
        if (cancel) {
            cancel();
        }
    };

    // The preview could not be loaded but the large panorama (at url) could.
    // Why a 360-degree photo is shown flat. Opened from disk (an export's
    // index.html), browsers do not let the 360 view read the picture.
    function flatPanoramaNote() {
        if (window.location && window.location.protocol === "file:") {
            return "The 360\u00b0 view needs the site to be opened from a web server; " +
                "this is the flat panorama.";
        }
        return "This browser cannot show the 360\u00b0 view here; this is the flat panorama.";
    }

    Stage.prototype.showSharpAlone = function (picture, url) {
        this.setNote("");
        this.natural = {w: picture.naturalWidth || picture.width,
                        h: picture.naturalHeight || picture.height};
        if (!this.startPano(picture, url)) {
            this.img.src = url;
            this.layout();
            this.setNote(flatPanoramaNote());
            this.state();
        }
    };

    // The large panorama has arrived: it replaces the preview in the view.
    Stage.prototype.useSharp = function (picture) {
        if (this.mode === "pano" && this.pano && this.pano.setImage(picture)) {
            this.box.setAttribute("data-texture-width", String(this.pano.textureWidth || ""));
            this.redraw();
        }
    };

    Stage.prototype.redraw = function () {
        var self = this;
        if (this.mode !== "pano" || this.frame) {
            return;
        }
        this.frame = window.requestAnimationFrame(function () {
            self.frame = 0;
            if (self.pano) {
                self.pano.draw(self.view);
            }
        });
    };

    Stage.prototype.size = function () {
        return {w: this.box.clientWidth || 1, h: this.box.clientHeight || 1};
    };

    // Fit the picture into the stage (never larger than the original).
    Stage.prototype.layout = function () {
        if (this.mode === "pano") {
            this.redraw();
            return;
        }
        var size = this.size();
        if (this.fisheyeBox) {
            // (A square: one lens's circle.)
            var edge = Math.max(1, Math.min(size.w, size.h));
            this.fisheyeBox.style.width = edge + "px";
            this.fisheyeBox.style.height = edge + "px";
        }
        var w = this.natural.w || this.img.naturalWidth || size.w;
        var h = this.natural.h || this.img.naturalHeight || size.h;
        var original = this.rec && this.rec.w ? this.rec.w : w;
        var scale = Math.min(size.w / w, size.h / h);
        // Small pictures stay small (but a preview standing in for a larger
        // original fills the stage).
        scale = Math.min(scale, Math.max(1, original / w) * 1);
        this.base = {w: Math.max(1, w * scale), h: Math.max(1, h * scale)};
        this.img.style.width = this.base.w + "px";
        this.img.style.height = this.base.h + "px";
        this.place();
    };

    Stage.prototype.maxZoom = function () {
        var pixels = Math.max(this.natural.w || 0, this.img.naturalWidth || 0);
        var shown = this.base.w || 1;
        return clamp(2 * pixels / shown, 2, 8);
    };

    // Keep the picture centred when smaller than the stage, else covering it.
    Stage.prototype.place = function () {
        var size = this.size();
        var w = this.base.w * this.zoom;
        var h = this.base.h * this.zoom;
        this.tx = w <= size.w ? (size.w - w) / 2 : clamp(this.tx, size.w - w, 0);
        this.ty = h <= size.h ? (size.h - h) / 2 : clamp(this.ty, size.h - h, 0);
        this.img.style.transform = "translate(" + this.tx + "px, " + this.ty + "px) scale(" +
            this.zoom + ")";
        this.box.classList.toggle("is-zoomed", this.zoom > 1.01);
    };

    // Zoom to `zoom` keeping the stage point (x, y) where it is.
    Stage.prototype.zoomTo = function (zoom, x, y) {
        if (this.mode === "pano" || this.mode === "video") {
            return;
        }
        var size = this.size();
        x = x === undefined ? size.w / 2 : x;
        y = y === undefined ? size.h / 2 : y;
        zoom = clamp(zoom, 1, this.maxZoom());
        var u = (x - this.tx) / this.zoom;
        var v = (y - this.ty) / this.zoom;
        this.zoom = zoom;
        this.tx = x - u * zoom;
        this.ty = y - v * zoom;
        this.place();
        this.state();
    };

    Stage.prototype.zoomBy = function (factor, x, y) {
        if (this.mode === "pano") {
            this.view = panoZoom(this.view, 1 / factor);
            this.redraw();
            return;
        }
        this.zoomTo(this.zoom * factor, x, y);
    };

    Stage.prototype.reset = function () {
        if (this.mode === "pano") {
            this.view = {yaw: 0, pitch: 0, fov: DEFAULT_FOV};
            this.redraw();
            return;
        }
        this.zoom = 1;
        this.place();
        this.state();
    };

    Stage.prototype.isZoomed = function () {
        return this.mode === "image" && this.zoom > 1.01;
    };

    // True when the view is not as it was shown: zoomed in, or a 360-degree
    // view turned or zoomed (0 then resets it).
    Stage.prototype.isMoved = function () {
        if (this.mode === "pano") {
            var view = this.view || {};
            return Math.abs(view.yaw || 0) > 1e-3 || Math.abs(view.pitch || 0) > 1e-3 ||
                Math.abs((view.fov || DEFAULT_FOV) - DEFAULT_FOV) > 1e-3;
        }
        return this.zoom > 1.01;
    };

    Stage.prototype.point = function (event) {
        var rect = this.box.getBoundingClientRect();
        return {x: event.clientX - rect.left, y: event.clientY - rect.top};
    };

    Stage.prototype.pointerDown = function (event) {
        if (event.button !== undefined && event.button !== 0 && event.pointerType === "mouse") {
            return;
        }
        // (A video's player takes its own clicks and drags.)
        if (event.target.closest && event.target.closest("button, a, video, .stage-controls")) {
            return;
        }
        try {
            this.box.setPointerCapture(event.pointerId);
        } catch (error) {
            // Capture is a nicety (drags that leave the stage).
        }
        var p = this.point(event);
        this.pointers[event.pointerId] = p;
        var ids = Object.keys(this.pointers);
        if (ids.length === 1) {
            this.gesture = {kind: "drag", startX: p.x, startY: p.y, lastX: p.x, lastY: p.y,
                            moved: false, touch: event.pointerType !== "mouse", time: Date.now()};
        } else if (ids.length === 2) {
            var a = this.pointers[ids[0]];
            var b = this.pointers[ids[1]];
            this.gesture = {kind: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                            zoom: this.zoom, fov: this.view.fov,
                            midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, moved: true};
        }
        if (event.pointerType === "mouse") {
            event.preventDefault();
        }
    };

    Stage.prototype.pointerMove = function (event) {
        if (!this.pointers[event.pointerId] || !this.gesture) {
            return;
        }
        var p = this.point(event);
        this.pointers[event.pointerId] = p;
        var g = this.gesture;
        if (g.kind === "pinch") {
            var ids = Object.keys(this.pointers);
            if (ids.length < 2) {
                return;
            }
            var a = this.pointers[ids[0]];
            var b = this.pointers[ids[1]];
            var ratio = Math.hypot(a.x - b.x, a.y - b.y) / g.distance;
            var midX = (a.x + b.x) / 2;
            var midY = (a.y + b.y) / 2;
            if (this.mode === "pano") {
                this.view = {yaw: this.view.yaw, pitch: this.view.pitch,
                             fov: clamp(g.fov / Math.max(0.1, ratio), MIN_FOV, MAX_FOV)};
                this.redraw();
            } else {
                this.tx += midX - g.midX;
                this.ty += midY - g.midY;
                this.zoomTo(g.zoom * ratio, midX, midY);
            }
            g.midX = midX;
            g.midY = midY;
            return;
        }
        var dx = p.x - g.lastX;
        var dy = p.y - g.lastY;
        if (Math.abs(p.x - g.startX) + Math.abs(p.y - g.startY) > 6) {
            g.moved = true;
        }
        g.lastX = p.x;
        g.lastY = p.y;
        if (!g.moved) {
            return;
        }
        if (this.mode === "pano") {
            var size = this.size();
            this.view = panoDrag(this.view, dx, dy, size.w, size.h);
            this.redraw();
        } else if (this.zoom > 1.01) {
            this.tx += dx;
            this.ty += dy;
            this.place();
        } else if (g.touch && this.options.onSwipe) {
            // Follow the finger a little, as a hint that a swipe changes picture.
            this.img.style.transform = "translate(" + (this.tx + (p.x - g.startX) * 0.5) + "px, " +
                this.ty + "px)";
        }
    };

    Stage.prototype.pointerUp = function (event) {
        if (!this.pointers[event.pointerId]) {
            return;
        }
        delete this.pointers[event.pointerId];
        var g = this.gesture;
        var left = Object.keys(this.pointers).length;
        if (g && g.kind === "pinch") {
            // The finger still down starts a new drag from where it is.
            var ids = Object.keys(this.pointers);
            this.gesture = left ? {kind: "drag", startX: this.pointers[ids[0]].x,
                                   startY: this.pointers[ids[0]].y,
                                   lastX: this.pointers[ids[0]].x, lastY: this.pointers[ids[0]].y,
                                   moved: true, touch: true, time: Date.now()} : null;
            return;
        }
        this.gesture = null;
        if (!g || g.kind !== "drag") {
            return;
        }
        var p = this.point(event);
        var dx = p.x - g.startX;
        var dy = p.y - g.startY;
        if (g.touch && (this.mode === "image" || (this.mode === "video" && !this.video)) &&
                this.zoom <= 1.01) {
            this.place();
            if (g.moved && Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dx) > 1.5 * Math.abs(dy) &&
                    this.options.onSwipe) {
                this.options.onSwipe(dx < 0 ? 1 : -1);
                return;
            }
        }
        if (!g.moved && g.touch) {
            var now = Date.now();
            if (this.lastTap && now - this.lastTap.time < DOUBLE_TAP_MS &&
                    Math.abs(this.lastTap.x - p.x) < 30 && Math.abs(this.lastTap.y - p.y) < 30) {
                this.lastTap = null;
                // Some browsers also send a dblclick for the two taps.
                this.tappedTwice = now;
                this.toggleZoom(p.x, p.y);
            } else {
                this.lastTap = {time: now, x: p.x, y: p.y};
            }
        }
    };

    Stage.prototype.toggleZoom = function (x, y) {
        if (this.mode === "pano") {
            this.reset();
            return;
        }
        if (this.zoom > 1.01) {
            this.zoomTo(1, x, y);
        } else {
            this.zoomTo(Math.min(this.maxZoom(), 2.5), x, y);
        }
    };

    Stage.prototype.doubleClick = function (event) {
        if (this.mode === "video" ||
                (event.target.closest && event.target.closest("button, a"))) {
            return;
        }
        if (this.tappedTwice && Date.now() - this.tappedTwice < 800) {
            event.preventDefault();
            return;
        }
        event.preventDefault();
        var p = this.point(event);
        this.toggleZoom(p.x, p.y);
    };

    Stage.prototype.wheel = function (event) {
        // A stage in a page: the wheel scrolls the page, unless Ctrl is
        // held (a touchpad pinch too) or the picture is zoomed in. A video
        // does not zoom.
        if ((this.options.scrollPage && !event.ctrlKey && !this.isZoomed()) ||
                this.mode === "video") {
            return;
        }
        event.preventDefault();
        var delta = event.deltaY;
        if (event.deltaMode === 1) {
            delta *= 16;
        } else if (event.deltaMode === 2) {
            delta *= 400;
        }
        var factor = Math.exp(-clamp(delta, -300, 300) * 0.0025);
        var p = this.point(event);
        this.zoomBy(factor, p.x, p.y);
    };

    /* ---------- Information pane -------------------------------------------- */

    /* ---------- Drives ------------------------------------------------------ */

    // Seconds before the end of a drive's clip when the next one starts loading.
    var DRIVE_PRELOAD = 12;
    // How long (ms) a clip that cannot be played here shows its still when
    // the drive plays on through it.
    var DRIVE_STILL = 3000;
    // While the sped-up preview plays, the information pane follows the clip
    // only once the preview stays on one this long (ms), or is paused.
    var DRIVE_PANE_DELAY = 1500;

    /* A drive (urls.drive: a run of video clips recorded one after the
       other, see drives.py and VIEWER.open's driveOf): its clips play one
       after the other, the next one loading while the one before it plays
       (DRIVE_PRELOAD), and a strip under the stage shows the whole drive:
       its clips (those that match the search by themselves marked), its
       holes (clips the camera made that are not here), how far it has
       played; a click on it, or the arrow keys while it has the focus (10
       s; Page Up and Page Down a clip; Home and End), go there. Space plays
       and pauses as for any video.
       Whether a clip plays is decided clip by clip (driveCanPlay): one
       without a video (an export publishes some only), one this browser
       cannot decode that has no playable copy (the full record's
       drive.copies lists those that have one), or one that failed to load
       (never loaded again) shows its still with a note saying why --
       for DRIVE_STILL when the drive plays on through it.
       With a sped-up preview (the full record's drive.preview, see
       driveDetail) a button switches between it and the clips at the same
       place in the drive; it is shown instead of a clip that cannot play.
       urls.drive: {clips: [{id, rec, video, poster, original, duration,
       hole, playable (this browser decodes its codec)}], start (the clip to
       begin with), matched ({id: true}), onClip(index) (a clip is shown)}. */
    Stage.prototype.showDrive = function (rec, urls) {
        var spec = urls.drive;
        this.mode = "video";
        this.box.classList.add("is-video");
        this.natural = {w: rec.w || 0, h: rec.hgt || 0};
        this.img.hidden = false;
        this.img.alt = altText(rec);
        this.img.src = urls.preview || urls.thumb || "";
        this.busy.hidden = true;
        var timeline = driveTimeline(spec.clips.map(function (clip) {
            return clip.duration;
        }));
        var copies = {};
        if (urls.playableCopy) {
            copies[rec.i] = true;
        }
        this.drive = {spec: spec, urls: urls, timeline: timeline, index: spec.start, active: 0,
                      players: [null, null], loaded: [-1, -1], seek: [null, null],
                      preloading: false, mode: "clips", previewUrl: null, speed: 0,
                      position: timeline.starts[spec.start] || 0, failed: {}, copies: copies,
                      still: null, paneTimer: null, wantPlay: false, strip: null};
        this.buildDriveStrip();
        this.layout();
        this.driveClip(spec.start, 0, false);
        this.state();
    };

    // Can the clip at index be played here (as far as is known)?
    Stage.prototype.driveCanPlay = function (index) {
        var drive = this.drive;
        var clip = drive.spec.clips[index];
        return Boolean(clip && clip.video && !drive.failed[index] &&
                       (clip.playable || drive.copies[clip.id]));
    };

    // The <video> of a slot (0 or 1: one plays, the other loads the next clip).
    Stage.prototype.driveVideo = function (slot) {
        var self = this;
        var drive = this.drive;
        if (drive.players[slot]) {
            return drive.players[slot];
        }
        var video = el("video", {className: "stage-video drive-video",
                                 attrs: {"aria-label": "Drive: " + altText(this.rec)}});
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.hidden = true;
        function mine() {
            return self.drive === drive;
        }
        function active() {
            return mine() && drive.players[drive.active] === video;
        }
        video.addEventListener("timeupdate", function () {
            if (active()) {
                self.driveTick();
            }
        });
        video.addEventListener("ended", function () {
            if (active()) {
                self.driveEnded();
            }
        });
        video.addEventListener("pause", function () {
            if (active() && drive.mode === "preview") {
                self.drivePane();
            }
        });
        video.addEventListener("error", function () {
            if (mine()) {
                self.driveFailed(slot);
            }
        });
        video.addEventListener("loadedmetadata", function () {
            if (!mine()) {
                return;
            }
            if (!video.videoWidth) {
                self.driveFailed(slot);
                return;
            }
            if (drive.seek[slot] !== null) {
                try {
                    video.currentTime = drive.seek[slot];
                } catch (error) {
                    // (Not seekable.)
                }
                drive.seek[slot] = null;
            }
        });
        drive.players[slot] = video;
        this.box.insertBefore(video, this.note);
        return video;
    };

    // The still of a clip stops waiting (timer: the next wait, or null).
    Stage.prototype.driveWait = function (timer) {
        var drive = this.drive;
        if (drive.still !== null) {
            window.clearTimeout(drive.still);
        }
        drive.still = timer;
    };

    // Show the clip at index, offset seconds into it (playing when play is set).
    Stage.prototype.driveClip = function (index, offset, play) {
        var drive = this.drive;
        var clip = drive.spec.clips[index];
        if (!clip) {
            return;
        }
        this.driveWait(null);
        drive.wantPlay = Boolean(play);
        if (!this.driveCanPlay(index)) {
            this.driveStill(index, offset, play);
            return;
        }
        var slot = drive.loaded[1 - drive.active] === index ? 1 - drive.active : drive.active;
        var video = this.driveVideo(slot);
        var other = drive.players[1 - slot];
        if (drive.loaded[slot] !== index) {
            drive.seek[slot] = null;
            video.poster = clip.poster || "";
            video.src = clip.video;
            drive.loaded[slot] = index;
        }
        drive.mode = "clips";
        drive.active = slot;
        drive.index = index;
        drive.preloading = false;
        if (offset > 0) {
            if (video.readyState >= 1) {
                try {
                    video.currentTime = offset;
                } catch (error) {
                    drive.seek[slot] = offset;
                }
            } else {
                drive.seek[slot] = offset;
            }
        } else if (video.readyState >= 1 && video.currentTime) {
            try {
                video.currentTime = 0;
            } catch (error) {
                // (Not seekable yet.)
            }
        }
        if (other) {
            other.pause();
            other.hidden = true;
        }
        video.hidden = false;
        this.video = video;
        this.img.hidden = true;
        this.setNote("");
        if (play) {
            var playing = video.play();
            if (playing && typeof playing.catch === "function") {
                playing.catch(function () {});
            }
        }
        drive.position = drive.timeline.starts[index] + (offset || 0);
        this.driveDraw();
        this.driveShown(index);
    };

    /* The clip at index cannot be played here: its still, with a note
       saying why (its own codec, and the admin's download of its original);
       when play is set the drive goes on to the next clip after
       DRIVE_STILL. */
    Stage.prototype.driveStill = function (index, offset, play) {
        var self = this;
        var drive = this.drive;
        var clip = drive.spec.clips[index];
        if (!clip) {
            return;
        }
        drive.players.forEach(function (video) {
            if (video) {
                video.pause();
                video.hidden = true;
            }
        });
        this.video = null;
        drive.mode = "clips";
        drive.index = index;
        drive.preloading = false;
        drive.position = drive.timeline.starts[index] +
            clamp(offset || 0, 0, drive.timeline.lengths[index]);
        this.img.hidden = false;
        if (clip.poster && this.img.getAttribute("src") !== clip.poster) {
            this.img.src = clip.poster;
        }
        if (!clip.video) {
            this.setNote("Only a still frame of this clip is published here.");
        } else {
            this.cannotPlay(clip.rec, {original: clip.original || null});
        }
        this.driveDraw();
        this.driveShown(index);
        if (play && index + 1 < drive.spec.clips.length) {
            this.driveWait(window.setTimeout(function () {
                if (self.drive === drive && drive.index === index && drive.mode === "clips") {
                    drive.still = null;
                    self.driveClip(index + 1, 0, true);
                }
            }, DRIVE_STILL));
        }
    };

    // The sped-up preview, from the moment seconds into the drive.
    Stage.prototype.drivePreview = function (seconds, play) {
        var drive = this.drive;
        if (!drive.previewUrl) {
            return;
        }
        this.driveWait(null);
        var slot = drive.active;
        var video = this.driveVideo(slot);
        var other = drive.players[1 - slot];
        var at = Math.max(0, seconds) / drive.speed;
        drive.mode = "preview";
        drive.preloading = false;
        if (drive.loaded[slot] !== -2) {
            video.removeAttribute("poster");
            video.src = drive.previewUrl;
            drive.loaded[slot] = -2;
            drive.seek[slot] = at;
        } else {
            try {
                video.currentTime = at;
            } catch (error) {
                drive.seek[slot] = at;
            }
        }
        if (other) {
            other.pause();
            other.hidden = true;
        }
        video.hidden = false;
        this.video = video;
        this.img.hidden = true;
        this.setNote("");
        if (play) {
            var playing = video.play();
            if (playing && typeof playing.catch === "function") {
                playing.catch(function () {});
            }
        }
        drive.position = seconds;
        this.driveDraw();
    };

    /* A clip is shown: the information pane follows -- while the sped-up
       preview is shown, only once it stays on one clip (DRIVE_PANE_DELAY)
       or is paused (drivePane), so it does not flicker past a clip a
       second. */
    Stage.prototype.driveShown = function (index) {
        var self = this;
        var drive = this.drive;
        if (drive.paneTimer !== null) {
            window.clearTimeout(drive.paneTimer);
            drive.paneTimer = null;
        }
        if (!drive.spec.onClip) {
            return;
        }
        if (drive.mode !== "preview") {
            drive.spec.onClip(index);
            return;
        }
        drive.paneTimer = window.setTimeout(function () {
            drive.paneTimer = null;
            if (self.drive === drive) {
                drive.spec.onClip(drive.index);
            }
        }, DRIVE_PANE_DELAY);
    };

    // The sped-up preview was paused: the information pane follows now.
    Stage.prototype.drivePane = function () {
        var drive = this.drive;
        if (drive.paneTimer !== null) {
            window.clearTimeout(drive.paneTimer);
            drive.paneTimer = null;
        }
        if (drive.spec.onClip) {
            drive.spec.onClip(drive.index);
        }
    };

    // The playing clip (or preview) moved on: the strip follows, and the
    // next clip starts loading near the end of this one.
    Stage.prototype.driveTick = function () {
        var drive = this.drive;
        var video = drive.players[drive.active];
        if (!video) {
            return;
        }
        var time = video.currentTime || 0;
        if (drive.mode === "preview") {
            drive.position = Math.min(drive.timeline.total, time * drive.speed);
            var place = drivePlace(drive.timeline, drive.position);
            if (place.index !== drive.index) {
                drive.index = place.index;
                this.driveShown(place.index);
            }
        } else {
            drive.position = drive.timeline.starts[drive.index] + time;
            var next = drive.index + 1;
            // (A clip that failed once is not asked for again.)
            if (!drive.preloading && this.driveCanPlay(next) && isFinite(video.duration) &&
                    video.duration - time < DRIVE_PRELOAD) {
                drive.preloading = true;
                var spare = this.driveVideo(1 - drive.active);
                if (drive.loaded[1 - drive.active] !== next) {
                    var clip = drive.spec.clips[next];
                    spare.preload = "auto";
                    spare.poster = clip.poster || "";
                    spare.src = clip.video;
                    drive.loaded[1 - drive.active] = next;
                    drive.seek[1 - drive.active] = null;
                }
            }
        }
        this.driveDraw();
    };

    Stage.prototype.driveEnded = function () {
        var drive = this.drive;
        if (drive.mode === "clips" && drive.index + 1 < drive.spec.clips.length) {
            this.driveClip(drive.index + 1, 0, true);
        }
    };

    /* A slot's clip (or the preview) could not be loaded or decoded here.
       The clip is remembered (driveCanPlay: never loaded again); the one
       shown gives way to its still (or, the preview, to the clips). */
    Stage.prototype.driveFailed = function (slot) {
        var drive = this.drive;
        var index = drive.loaded[slot];
        if (index >= 0) {
            drive.failed[index] = true;
        }
        drive.loaded[slot] = -1;
        if (slot !== drive.active) {
            // (The next clip, loading: its still shows when its turn comes.)
            drive.preloading = false;
            return;
        }
        var video = drive.players[slot];
        if (video) {
            video.pause();
            video.hidden = true;
        }
        this.video = null;
        if (index === -2) {
            drive.previewUrl = null;
            drive.strip.toggle.hidden = true;
            var place = drivePlace(drive.timeline, drive.position);
            this.driveClip(place.index, place.offset, false);
            return;
        }
        var at = index >= 0 ? index : drive.index;
        this.driveStill(at, drive.position - drive.timeline.starts[at], drive.wantPlay);
    };

    // Go to the moment seconds into the drive (keeps playing if it was).
    Stage.prototype.driveSeekTo = function (seconds) {
        var drive = this.drive;
        seconds = clamp(seconds, 0, Math.max(0, drive.timeline.total - 0.05));
        var video = drive.players[drive.active];
        var playing = drive.still !== null ||
            Boolean(video && !video.paused && !video.ended && !video.hidden);
        if (drive.mode === "preview") {
            this.drivePreview(seconds, playing);
            return;
        }
        var place = drivePlace(drive.timeline, seconds);
        if (place.index === drive.index && video && !video.hidden &&
                drive.loaded[drive.active] === place.index) {
            try {
                video.currentTime = place.offset;
            } catch (error) {
                drive.seek[drive.active] = place.offset;
            }
            drive.position = seconds;
            this.driveDraw();
            return;
        }
        this.driveClip(place.index, place.offset, playing);
    };

    // The keys of the strip: arrows 10 s, Page Up / Page Down a clip, Home, End.
    Stage.prototype.driveKey = function (key) {
        var drive = this.drive;
        if (!drive) {
            return false;
        }
        var starts = drive.timeline.starts;
        if (key === "ArrowLeft" || key === "ArrowRight") {
            this.driveSeekTo(drive.position + (key === "ArrowLeft" ? -10 : 10));
        } else if (key === "PageUp") {
            var back = drive.position - starts[drive.index] > 3 ? drive.index : drive.index - 1;
            this.driveSeekTo(starts[Math.max(0, back)]);
        } else if (key === "PageDown") {
            if (drive.index + 1 < starts.length) {
                this.driveSeekTo(starts[drive.index + 1]);
            }
        } else if (key === "Home") {
            this.driveSeekTo(0);
        } else if (key === "End") {
            this.driveSeekTo(starts[starts.length - 1]);
        } else {
            return false;
        }
        return true;
    };

    // Switch between the clips and the sped-up preview at the same place.
    Stage.prototype.driveToggle = function () {
        var drive = this.drive;
        var video = drive.players[drive.active];
        var playing = drive.still !== null ||
            Boolean(video && !video.paused && !video.ended && !video.hidden);
        if (drive.mode === "preview") {
            var place = drivePlace(drive.timeline, drive.position);
            this.driveClip(place.index, place.offset, playing);
        } else {
            this.drivePreview(drive.position, playing || !this.driveCanPlay(drive.index));
        }
        this.driveDraw();
    };

    // Can any clip of the drive be played here?
    Stage.prototype.drivePlayable = function () {
        for (var index = 0; index < this.drive.spec.clips.length; index++) {
            if (this.driveCanPlay(index)) {
                return true;
            }
        }
        return false;
    };

    /* The full record of the clip the viewer opened has arrived: which of
       the drive's clips have a playable copy (playable_copy, drive.copies:
       a still of one now plays), and the sped-up preview (drive.preview,
       speed), shown at once instead of a clip that cannot play. */
    Stage.prototype.driveDetail = function (detail) {
        var drive = this.drive;
        if (!detail || !this.rec || detail.id !== this.rec.i) {
            return;
        }
        var about = detail.drive && typeof detail.drive === "object" ? detail.drive : null;
        if (detail.playable_copy) {
            drive.copies[detail.id] = true;
        }
        (about && Array.isArray(about.copies) ? about.copies : []).forEach(function (id) {
            drive.copies[id] = true;
        });
        var still = drive.mode === "clips" && !this.video;
        if (still && this.driveCanPlay(drive.index)) {
            this.driveClip(drive.index, drive.position - drive.timeline.starts[drive.index],
                           drive.still !== null);
            still = false;
        }
        var url = about && about.preview && window.SITE && SITE.drivePreviewUrl
            ? SITE.drivePreviewUrl(this.rec) : null;
        if (url && !drive.previewUrl) {
            drive.previewUrl = url;
            drive.speed = number(about.speed) || 60;
            if (still && drive.still === null) {
                this.drivePreview(drive.position, false);
            }
        }
        this.driveDraw();
    };

    Stage.prototype.buildDriveStrip = function () {
        var self = this;
        var drive = this.drive;
        var spec = drive.spec;
        var total = drive.timeline.total || 1;
        var strip = el("div", {className: "drive-strip"});
        var label = el("span", {className: "drive-label"});
        var track = el("div", {className: "drive-track",
                               attrs: {role: "slider", "aria-label": "Where in the drive",
                                       "aria-valuemin": "0",
                                       "aria-valuemax": String(Math.round(total))}});
        track.tabIndex = 0;
        track.title = "Click to go there (arrow keys: 10 seconds; Page Up, Page Down: a clip)";
        var pieces = [];
        spec.clips.forEach(function (clip, index) {
            var piece = el("span", {className: "drive-piece" +
                                    (spec.matched[clip.id] ? " is-match" : "") +
                                    (clip.hole > 0 && index ? " after-hole" : "")});
            piece.style.left = (100 * drive.timeline.starts[index] / total) + "%";
            piece.style.width = (100 * drive.timeline.lengths[index] / total) + "%";
            track.appendChild(piece);
            pieces.push(piece);
        });
        var played = el("span", {className: "drive-played"});
        var cursor = el("span", {className: "drive-cursor"});
        track.appendChild(played);
        track.appendChild(cursor);
        var toggle = el("button", {type: "button", className: "drive-mode", hidden: true});
        toggle.addEventListener("click", function () {
            self.driveToggle();
        });
        track.addEventListener("click", function (event) {
            var rect = track.getBoundingClientRect();
            if (rect.width > 0) {
                self.driveSeekTo(clamp((event.clientX - rect.left) / rect.width, 0, 1) * total);
            }
        });
        strip.appendChild(label);
        strip.appendChild(track);
        strip.appendChild(toggle);
        if (this.box.parentNode) {
            this.box.parentNode.insertBefore(strip, this.box.nextSibling);
        }
        drive.strip = {root: strip, label: label, track: track, pieces: pieces, played: played,
                       cursor: cursor, toggle: toggle, current: -1};
    };

    Stage.prototype.driveDraw = function () {
        var drive = this.drive;
        var strip = drive.strip;
        if (!strip) {
            return;
        }
        var total = drive.timeline.total || 1;
        var count = drive.spec.clips.length;
        var fraction = clamp(drive.position / total, 0, 1);
        strip.played.style.width = (100 * fraction) + "%";
        strip.cursor.style.left = (100 * fraction) + "%";
        if (strip.current !== drive.index) {
            if (strip.pieces[strip.current]) {
                strip.pieces[strip.current].classList.remove("is-current");
            }
            if (strip.pieces[drive.index]) {
                strip.pieces[drive.index].classList.add("is-current");
            }
            strip.current = drive.index;
        }
        var where = "Clip " + (drive.index + 1) + " of " + count + " \u00b7 " +
            durationText(drive.position) + " / " + durationText(drive.timeline.total);
        strip.label.textContent = (drive.mode === "preview" ? "\u00d7" + drive.speed + " \u00b7 "
            : "") + where;
        strip.track.setAttribute("aria-valuenow", String(Math.round(drive.position)));
        strip.track.setAttribute("aria-valuetext", where);
        if (drive.previewUrl) {
            strip.toggle.hidden = drive.mode === "preview" && !this.drivePlayable();
            strip.toggle.textContent = drive.mode === "preview" ? "Full speed"
                : "Sped up \u00d7" + drive.speed;
            strip.toggle.title = drive.mode === "preview" ? "Play the clips themselves"
                : "Play the whole drive " + drive.speed + " times faster";
            strip.toggle.setAttribute("aria-pressed", drive.mode === "preview" ? "true" : "false");
        }
    };

    // Take the drive's players, timers and strip away.
    Stage.prototype.dropDrive = function () {
        var drive = this.drive;
        if (!drive) {
            return;
        }
        this.driveWait(null);
        if (drive.paneTimer !== null) {
            window.clearTimeout(drive.paneTimer);
            drive.paneTimer = null;
        }
        this.drive = null;
        drive.players.forEach(function (video) {
            if (!video) {
                return;
            }
            try {
                video.pause();
                video.removeAttribute("src");
                video.load();
            } catch (error) {
                // (Already gone.)
            }
            if (video.parentNode) {
                video.parentNode.removeChild(video);
            }
        });
        if (drive.strip && drive.strip.root.parentNode) {
            drive.strip.root.parentNode.removeChild(drive.strip.root);
        }
    };

    function altText(rec) {
        if (!rec) {
            return "";
        }
        if (rec.t) {
            return rec.t;
        }
        if (rec.d) {
            var sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(rec.d);
            return (sentence ? sentence[0] : rec.d).slice(0, 140);
        }
        return rec.n || "Picture";
    }

    function words(value) {
        return String(value || "").replace(/_/g, " ");
    }

    function capital(text) {
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    }

    function facetLabel(group, value) {
        if (window.SearchCore && SearchCore.facetLabel) {
            return SearchCore.facetLabel(group, value);
        }
        return capital(words(value));
    }

    var SENSITIVE = {suggestive: "Suggestive", explicit: "Explicit", graphic: "Graphic"};
    var FLAGS = {blurry: "Blurry", dark: "Dark", overexposed: "Overexposed",
                 accidental: "Accidental", screen_photo: "Photo of a screen"};
    var SOURCES = {filename: "from the file name", mtime: "the file's date; no capture date",
                   video: "from the video"};

    /* The addresses Stage.show wants for a record (detail: its full record,
       when it is known): thumb, preview, pano, and for a video video (the
       player's source, or null), playableCopy (the server sends an H.264
       copy), original (the admin's download of the original) and videoNote
       (why only the poster shows). */
    function stageUrls(rec, detail) {
        var urls = {thumb: SITE.thumbUrl(rec), preview: SITE.previewUrl(rec),
                    pano: SITE.panoUrl(rec)};
        if (rec && rec.mv) {
            urls.video = SITE.videoUrl ? SITE.videoUrl(rec) : null;
            urls.playableCopy = Boolean(detail && detail.playable_copy);
            urls.original = admin() ? SITE.imageUrl(rec) : null;
            if (!urls.video) {
                urls.videoNote = "Only a still frame of this video is published here.";
            }
        }
        return urls;
    }

    /* The drive a clip belongs to, for the information pane: its own title
       and description (when it was described), and where the clip is in it.
       drive: {cover (the record of its first clip), index, count, start,
       length} (seconds). */
    function driveSection(drive, context) {
        var cover = drive.cover || {};
        var body = el("div", {className: "info-drive-body"});
        var facts = "Clip " + (drive.index + 1) + " of " + drive.count + " \u00b7 " +
            durationText(drive.start) + " into a drive of " + durationText(drive.length);
        if (cover.dvt) {
            body.appendChild(el("p", {className: "info-drive-title"},
                                [highlighted(cover.dvt, context.query, "dvt")]));
        }
        if (cover.dvd) {
            body.appendChild(el("p", {className: "info-description"},
                                [highlighted(cover.dvd, context.query, "dvd")]));
        }
        body.appendChild(el("p", {className: "info-small", text: facts}));
        return section("Drive", body, "info-drive");
    }

    function section(title, body, className) {
        return el("section", {className: "info-section" + (className ? " " + className : "")}, [
            title ? el("h3", {text: title}) : null,
            body
        ]);
    }

    function chip(label, group, value, context, title) {
        var href = context.chipUrl ? context.chipUrl(group, value) : null;
        var node = el(href ? "a" : "span", {className: "info-chip", text: label,
                                            title: title || ""});
        if (href) {
            node.href = href;
            node.addEventListener("click", function (event) {
                if (!context.onChip || event.button !== 0 || event.ctrlKey || event.metaKey ||
                        event.shiftKey || event.altKey) {
                    return;
                }
                event.preventDefault();
                context.onChip(group, value);
            });
        }
        return node;
    }

    function matches(textValue, query, field) {
        if (!query || !window.SearchCore || !SearchCore.highlights) {
            return false;
        }
        try {
            return SearchCore.highlights(textValue, query, field).length > 0;
        } catch (error) {
            return false;
        }
    }

    function chipRow(values, group, context, field, titleOf) {
        if (!values || !values.length) {
            return null;
        }
        return el("div", {className: "info-chips"}, values.map(function (value) {
            var node = chip(value, group, value, context, titleOf ? titleOf(value) : "");
            if (field && matches(value, context.query, field)) {
                node.classList.add("is-match");
            }
            return node;
        }));
    }

    function quote(text) {
        return /\s/.test(text) ? "\"" + text.replace(/"/g, "") + "\"" : text;
    }

    // [label, value] pairs as a definition list (empty values left out).
    function facts(pairs) {
        var list = el("dl", {className: "info-facts"});
        pairs.forEach(function (pair) {
            if (pair && pair[1] !== "" && pair[1] !== null && pair[1] !== undefined) {
                list.appendChild(el("dt", {text: pair[0]}));
                var value = el("dd");
                if (typeof pair[1] === "string" || typeof pair[1] === "number") {
                    value.textContent = String(pair[1]);
                } else {
                    value.appendChild(pair[1]);
                }
                list.appendChild(value);
            }
        });
        return list.childNodes.length ? list : null;
    }

    function badge(text, kind) {
        return el("span", {className: "info-badge" + (kind ? " " + kind : ""), text: text});
    }

    var TEXT_PREVIEW = 360;

    function longText(textValue, context, field) {
        var box = el("div", {className: "info-text"});
        var long = textValue.length > TEXT_PREVIEW + 80;
        var expanded = !long || context.expandedText;
        var body = el("div", {className: "info-text-body" + (expanded ? "" : " is-clipped")});
        body.appendChild(highlighted(textValue, context.query, field));
        box.appendChild(body);
        if (long) {
            var more = el("button", {type: "button", className: "button subtle small",
                                     text: expanded ? "Show less" : "Show all the text"});
            more.addEventListener("click", function () {
                context.expandedText = !body.classList.contains("is-clipped") ? false : true;
                body.classList.toggle("is-clipped", !context.expandedText);
                more.textContent = context.expandedText ? "Show less" : "Show all the text";
            });
            box.appendChild(more);
        }
        return box;
    }

    function dateText(rec, detail) {
        var taken = detail && detail.taken_at ? detail.taken_at : rec.ts || rec.dk || "";
        var text = longDate(taken);
        if (!text) {
            return "";
        }
        var source = detail && detail.taken_source;
        var notes = [];
        if (detail && detail.tz_offset) {
            notes.push("UTC" + detail.tz_offset);
        }
        if (source && SOURCES[source]) {
            notes.push(SOURCES[source]);
        }
        return text + (notes.length ? " (" + notes.join("; ") + ")" : "");
    }

    // The place of a picture, as a chip that finds the pictures taken there.
    function placeFact(rec, context) {
        var text = placeText(rec);
        var value = text && window.SearchCore && SearchCore.placeOf ? SearchCore.placeOf(rec) : "";
        if (!value) {
            return text;
        }
        var near = rec.ci || rec.rg || rec.co;
        return chip(text, "place", value, context, rec.ci
            ? "The town nearest to where it was taken. Show all pictures from " + near
            : "Show all pictures from " + near);
    }

    function describedBy(detail) {
        var provenance = detail && detail.provenance;
        var model = provenance && provenance.model;
        if (!model && detail && detail.info) {
            model = detail.info._model_name;
        }
        if (!model) {
            return "";
        }
        var text = "Described by " + model;
        if (provenance && provenance.endpoint) {
            text += " via " + provenance.endpoint;
        }
        if (provenance && typeof provenance.at === "number") {
            text += ", " + shortDate(new Date(provenance.at * 1000).toISOString());
        }
        return text;
    }

    function actionButton(text, onClick, className) {
        var button = el("button", {type: "button", className: "button small " + (className || ""),
                                   text: text});
        button.addEventListener("click", function () {
            onClick(button);
        });
        return button;
    }

    function busy(button, promise) {
        button.disabled = true;
        return promise.then(function (value) {
            button.disabled = false;
            return value;
        }, function (error) {
            button.disabled = false;
            throw error;
        });
    }

    /* ---------- The GPS check (the admin's; see gps_check.py) ----------------

       detail.location_check (/api/image, the admin's): {ignored, reason
       (words), choice ("use", "ignore" or ""), place (of the position set
       aside), estimated}, or null for a picture without a position. */

    // The record keys a position changes (gps_check.RECORD_KEYS).
    var LOCATION_KEYS = ["gp", "ci", "rg", "co", "cc", "km", "pe", "gx"];

    /* Use (true) or ignore (false) the picture's GPS position. The server
       keeps the choice (for every copy of the shot) and checks the positions
       again; the place keys of the record -- and of the other records whose
       position the check changed (answer.others, found with context.get) --
       change in place, the pane is drawn again (unless it shows another
       picture by now) and context.onEdited(id, detail) is told (the search
       sees the change). */
    function chooseLocation(box, rec, detail, context, use, button) {
        function patch(target, keys) {
            LOCATION_KEYS.forEach(function (key) {
                var value = keys ? keys[key] : undefined;
                if (value === undefined) {
                    delete target[key];
                } else {
                    target[key] = value;
                }
            });
        }
        return busy(button, SHELL.admin("/images/" + encodeURIComponent(rec.i) + "/location",
                                        {use: use}))
            .then(function (answer) {
                patch(rec, answer ? answer.record : null);
                var others = answer && answer.others && typeof answer.others === "object"
                    ? answer.others : {};
                var changed = 0;
                Object.keys(others).forEach(function (id) {
                    var other = context.get ? context.get(Number(id)) : null;
                    if (other && other !== rec) {
                        patch(other, others[id]);
                    }
                    changed += 1;
                });
                var shown = {};
                Object.keys(detail || {}).forEach(function (key) {
                    shown[key] = detail[key];
                });
                shown.location_check = answer ? answer.location_check || null : null;
                var ignored = Boolean(shown.location_check && shown.location_check.ignored);
                var copies = answer && answer.copies > 0 ? answer.copies : 0;
                var more = changed - copies + (answer && answer.more > 0 ? answer.more : 0);
                var said = ignored ? "The picture's position is ignored: it has no place, " +
                    "is not on the map and is not found by place."
                    : "The picture's position is used: its place shows again.";
                if (copies) {
                    said += " The same goes for " + plural(copies, "copy", "copies") + " of it.";
                }
                if (more > 0) {
                    said += " The check changed " + plural(more, "other picture") + " too.";
                }
                toast(said, "ok");
                // (A button pressed and then disabled while the request ran
                // has dropped the focus to the page.)
                var focused = document.activeElement;
                var hadFocus = !focused || focused === document.body || box.contains(focused);
                if (box.infoId === rec.i) {
                    renderInfo(box, rec, shown, context);
                    var next = box.querySelector(ignored ? ".info-location-use"
                                                         : ".info-location-ignore") ||
                        box.querySelector(".info-title");
                    if (hadFocus && next) {
                        if (next.tabIndex === undefined || next.tabIndex < 0) {
                            next.tabIndex = -1;
                        }
                        next.focus({preventScroll: true});
                    }
                }
                if (context.onEdited) {
                    context.onEdited(rec.i, shown);
                }
            }, function () {});
    }

    // Why the position was set aside (or kept against the check), for the admin.
    function locationNote(box, rec, detail, context) {
        var check = admin() && detail ? detail.location_check : null;
        if (!check || typeof check !== "object" || (!check.ignored && !check.reason)) {
            return null;
        }
        var note = el("div", {className: "info-location-check" +
                                          (check.ignored ? " is-ignored" : "")});
        if (!check.ignored) {
            note.appendChild(el("p", {className: "info-location-why",
                                      text: "Location used as you chose; the GPS check would " +
                                            "ignore it: " + check.reason + "."}));
            return note;
        }
        note.appendChild(el("p", {className: "info-location-why",
                                  text: "Location ignored: " + check.reason + "."}));
        if (check.place) {
            note.appendChild(el("p", {className: "info-small",
                                      text: "Ignored place: " + check.place}));
        }
        var use = actionButton(check.choice === "ignore" ? "Use this location"
            : "Use this location anyway", function (button) {
            chooseLocation(box, rec, detail, context, true, button);
        }, "info-location-use");
        use.title = "Show the picture at the position its file gives (kept across scans)";
        note.appendChild(use);
        return note;
    }

    function adminActions(rec, context, box, detail) {
        var id = rec.i;
        var row = el("div", {className: "info-actions info-admin"});
        row.appendChild(actionButton("Copy path", function (button) {
            busy(button, SHELL.admin("/images/paths", {ids: [id]})).then(function (data) {
                var found = data.paths && data.paths[0];
                if (!found) {
                    toast("This picture's file is not in a configured library.", "warn");
                    return;
                }
                SHELL.copyText(found.path).then(function (ok) {
                    toast(ok ? "Copied the path: " + found.path
                        : "The path is " + found.path + " (copying was not allowed).", ok ? "ok" : "info");
                });
            }, function () {});
        }));
        row.appendChild(actionButton("Open folder", function (button) {
            busy(button, SHELL.admin("/images/" + encodeURIComponent(id) + "/open-folder", {}))
                .then(function () {
                    toast("Opened the picture's folder on this computer.", "ok");
                }, function () {});
        }));
        var hidden = Boolean(rec.h);
        row.appendChild(actionButton(hidden ? "Unhide" : "Hide", function (button) {
            busy(button, SHELL.admin("/images/hide", {ids: [id], hidden: !hidden}))
                .then(function () {
                    if (hidden) {
                        delete rec.h;
                    } else {
                        rec.h = 1;
                    }
                    toast(hidden ? "The picture shows in searches again."
                        : "Hidden: the picture no longer shows in searches or exports.", "ok");
                    if (context.onHidden) {
                        context.onHidden([id], !hidden);
                    }
                }, function () {});
        }, hidden ? "" : "danger-text subtle-danger"));
        row.appendChild(actionButton(rec.ds ? "Describe again" : "Describe now", function (button) {
            var params = {ids: [id]};
            if (rec.ds) {
                params.force = true;
            }
            busy(button, SHELL.admin("/jobs", {kind: "describe", library_id: rec.l || null,
                                               params: params}))
                .then(function (data) {
                    toast(data && data.added === false
                        ? "This picture is already waiting to be described."
                        : "Describing this picture is queued; the new description shows after " +
                          "the job is done and the page is reloaded.", "ok");
                }, function () {});
        }));
        var check = detail ? detail.location_check : null;
        if (check && typeof check === "object" && !check.ignored) {
            var ignore = actionButton("Ignore location", function (button) {
                chooseLocation(box, rec, detail, context, false, button);
            }, "info-location-ignore");
            ignore.title = "The GPS position is wrong: no place, not on the map (kept across " +
                "scans)";
            row.appendChild(ignore);
        }
        return row;
    }

    /* ---------- Marks: favorites, ratings and albums ------------------------ */

    var STAR = "\u2605";
    var HOLLOW_STAR = "\u2606";
    // Pictures one request names at most (albums.MARK_LIMIT).
    var MARK_CHUNK = 10000;

    function chunked(list, size) {
        var out = [];
        for (var k = 0; k < list.length; k += size) {
            out.push(list.slice(k, k + size));
        }
        return out;
    }

    function numeric(a, b) {
        return a - b;
    }

    function idOf(key) {
        return /^\d+$/.test(key) ? Number(key) : key;
    }

    function stars(count) {
        var text = "";
        for (var k = 1; k <= 5; k++) {
            text += k <= count ? STAR : HOLLOW_STAR;
        }
        return text;
    }

    // The albums (of the page's list) a record is in, in the list's order.
    function albumsOfRecord(rec, albums) {
        var ids = rec && Array.isArray(rec.al) ? rec.al : [];
        return (albums || []).filter(function (album) {
            return album && album.kind !== "smart" && ids.indexOf(album.id) >= 0;
        });
    }

    // A record (or id, when the page has no record of it) put in an album
    // or taken out: its al and the album's items change in place.
    function placeInAlbum(id, rec, album, on) {
        if (rec) {
            var list = Array.isArray(rec.al) ? rec.al.slice() : [];
            var at = list.indexOf(album.id);
            if (on && at < 0) {
                list.push(album.id);
                list.sort(numeric);
            } else if (!on && at >= 0) {
                list.splice(at, 1);
            }
            if (list.length) {
                rec.al = list;
            } else {
                delete rec.al;
            }
        }
        if (!Array.isArray(album.items)) {
            album.items = [];
        }
        var place = album.items.indexOf(id);
        if (on && place < 0) {
            album.items.push(id);
        } else if (!on && place >= 0) {
            album.items.splice(place, 1);
        }
    }

    /* Make pictures favorites (or not), or rate them: change is {favorite}
       or {rating} (0: none). The records (get(id)) change in place;
       resolves to how many changed (rejects after a message). */
    function sendMarks(ids, change, get) {
        var changed = 0;
        var chain = Promise.resolve();
        chunked(ids, MARK_CHUNK).forEach(function (part) {
            chain = chain.then(function () {
                var body = {ids: part};
                Object.keys(change).forEach(function (key) {
                    body[key] = change[key];
                });
                return SHELL.admin("/marks", body).then(function (reply) {
                    changed += reply.changed || 0;
                    Object.keys(reply.marks || {}).forEach(function (key) {
                        var rec = get ? get(idOf(key)) : null;
                        var mark = reply.marks[key] || {};
                        if (!rec) {
                            return;
                        }
                        if (mark.favorite) {
                            rec.fav = 1;
                        } else {
                            delete rec.fav;
                        }
                        if (mark.rating) {
                            rec.rt = mark.rating;
                        } else {
                            delete rec.rt;
                        }
                    });
                });
            });
        });
        return chain.then(function () {
            return changed;
        });
    }

    // Put pictures in a manual album (at its end) and take others out;
    // resolves to {added, removed}.
    function sendAlbumItems(album, add, remove, get) {
        var parts = [];
        chunked(add || [], MARK_CHUNK).forEach(function (part) {
            parts.push({add: part});
        });
        chunked(remove || [], MARK_CHUNK).forEach(function (part) {
            parts.push({remove: part});
        });
        var done = {added: 0, removed: 0};
        var chain = Promise.resolve();
        parts.forEach(function (body) {
            chain = chain.then(function () {
                return SHELL.admin("/albums/" + encodeURIComponent(album.id) + "/items", body)
                    .then(function (reply) {
                        done.added += reply.added || 0;
                        done.removed += reply.removed || 0;
                        (body.add || []).forEach(function (id) {
                            placeInAlbum(id, get ? get(id) : null, album, true);
                        });
                        (body.remove || []).forEach(function (id) {
                            placeInAlbum(id, get ? get(id) : null, album, false);
                        });
                    });
            });
        });
        return chain.then(function () {
            return done;
        });
    }

    // A new manual album with the pictures ids; resolves to it (added to albums).
    function createAlbum(name, ids, get, albums) {
        var first = ids.slice(0, MARK_CHUNK);
        return SHELL.admin("/albums", {name: name, kind: "manual", ids: first})
            .then(function (reply) {
                var album = {id: reply.album.id, name: reply.album.name, kind: "manual",
                             cover: null, items: []};
                albums.push(album);
                albums.sort(function (a, b) {
                    var x = String(a.name).toLowerCase();
                    var y = String(b.name).toLowerCase();
                    return x < y ? -1 : x > y ? 1 : a.id - b.id;
                });
                first.forEach(function (id) {
                    placeInAlbum(id, get ? get(id) : null, album, true);
                });
                var rest = ids.slice(MARK_CHUNK);
                return (rest.length ? sendAlbumItems(album, rest, [], get) : Promise.resolve())
                    .then(function () {
                        return album;
                    });
            });
    }

    /* The album picker (admin): a dialog to put pictures in an album (or,
       with mode "remove", take them out of one). options: {ids, get,
       albums (the page's list), mode, onChange (called after each change),
       onClose}. Typing finds an album. Enter only ever adds (with mode
       "remove": takes out) -- to the album of that name, or the only one
       listed -- and makes a new album only when no album matches what
       was typed; the New album button makes one whatever is listed.
       Clicking an album that holds the pictures already takes them out. */
    function albumPicker(options) {
        var ids = (options.ids || []).slice();
        var albums = options.albums || [];
        var get = options.get || function () {
            return null;
        };
        var removing = options.mode === "remove";
        var count = plural(ids.length, "picture");
        var box = SHELL.modal({
            title: removing ? "Take " + count + " out of an album"
                : ids.length === 1 ? "Add to album" : "Add " + count + " to an album",
            onClose: options.onClose
        });
        var input = el("input", {type: "text", className: "input album-picker-find",
                                 autocomplete: "off", spellcheck: false, maxLength: 100,
                                 placeholder: removing ? "Find an album"
                                     : "Find an album, or type a new name",
                                 attrs: {"aria-label": "Album name"}});
        var create = el("button", {type: "button", className: "button small album-picker-new",
                                   hidden: true});
        var list = el("ul", {className: "album-picker-list", attrs: {"aria-label": "Albums"}});
        var note = el("p", {className: "field-hint album-picker-note"});
        box.body.appendChild(input);
        box.body.appendChild(create);
        box.body.appendChild(list);
        box.body.appendChild(note);
        var working = false;
        var hint = "";              // what Enter did not do, until the next key
        var refocus = null;         // after a change: an album id, or "input"

        function inside(album) {
            var count = 0;
            ids.forEach(function (id) {
                var rec = get(id);
                if (rec ? Array.isArray(rec.al) && rec.al.indexOf(album.id) >= 0
                    : Array.isArray(album.items) && album.items.indexOf(id) >= 0) {
                    count += 1;
                }
            });
            return count;
        }

        function wanted() {
            return String(input.value || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        }

        function exact() {
            var name = wanted().toLowerCase();
            return albums.filter(function (album) {
                return album.kind !== "smart" && String(album.name).toLowerCase() === name;
            })[0] || null;
        }

        // The albums listed for what was typed.
        function listed() {
            var lower = wanted().toLowerCase();
            return albums.filter(function (album) {
                return album.kind !== "smart" && (!removing || inside(album) > 0) &&
                    (!lower || String(album.name).toLowerCase().indexOf(lower) >= 0);
            });
        }

        function focusAgain() {
            var target = null;
            if (refocus !== null && refocus !== "input") {
                target = list.querySelector('[data-album="' + String(refocus) + '"]');
            }
            refocus = null;
            (target && !target.disabled ? target : input).focus();
        }

        function finish(promise, message) {
            working = true;
            draw();
            promise.then(function (text) {
                working = false;
                SHELL.toast(text || message, "ok");
                if (options.onChange) {
                    options.onChange();
                }
                draw();
                focusAgain();
            }, function () {
                working = false;
                draw();
                focusAgain();
            });
        }

        // Put the pictures in album (take: take them out of it).
        function change(album, take, focusAfter) {
            var have = inside(album);
            var chosen = take ? ids.filter(function (id) {
                var rec = get(id);
                return !rec || (Array.isArray(rec.al) && rec.al.indexOf(album.id) >= 0);
            }) : ids;
            refocus = focusAfter;
            hint = "";
            finish(sendAlbumItems(album, take ? [] : chosen, take ? chosen : [], get)
                .then(function (done) {
                    return take ? plural(done.removed, "picture") + " taken out of " +
                        album.name + "." : plural(done.added, "picture") + " added to " +
                        album.name + "." + (have ? " " + have + " " +
                                            (have === 1 ? "was" : "were") + " in it already." : "");
                }));
        }

        // An album row was clicked: add; take out when it holds them all already.
        function rowClicked(album) {
            if (!working) {
                change(album, removing || inside(album) === ids.length, album.id);
            }
        }

        // Enter in the box: adds (or takes out), never the other way round.
        function enter() {
            if (working) {
                return;
            }
            var rows = listed();
            var found = exact() || (rows.length === 1 ? rows[0] : null);
            if (found && removing && !inside(found)) {
                hint = "None of them is in " + found.name + ".";
            } else if (found && !removing && inside(found) === ids.length) {
                hint = (ids.length === 1 ? "It is" : "They are all") + " in " + found.name +
                    " already (click the album to take " + (ids.length === 1 ? "it" : "them") +
                    " out).";
            } else if (found) {
                change(found, removing, "input");
                return;
            } else if (!removing && wanted() && !rows.length) {
                make();
                return;
            } else if (rows.length > 1) {
                hint = rows.length + " albums match: choose one" + (removing ? "."
                    : ", or press the New album button for a new one.");
            } else {
                return;
            }
            draw();
        }

        function make() {
            var name = wanted();
            if (!name || exact() || working) {
                return;
            }
            refocus = "input";
            hint = "";
            finish(createAlbum(name, ids, get, albums).then(function (album) {
                input.value = "";
                return "Made the album " + album.name + " with " + count + ".";
            }));
        }

        function draw() {
            clear(list);
            var name = wanted();
            var shown = 0;
            listed().forEach(function (album) {
                var have = inside(album);
                shown += 1;
                var full = have === ids.length;
                var state = full ? "true" : have ? "mixed" : "false";
                var button = el("button", {type: "button", className: "album-picker-item",
                                           disabled: working,
                                           attrs: {"aria-pressed": removing ? null : state,
                                                   "data-album": String(album.id)}}, [
                    el("span", {className: "album-picker-check", attrs: {"aria-hidden": "true"},
                                text: removing ? "\u2212" : full ? "\u2713" : have ? "\u2013" : "+"}),
                    el("span", {className: "album-picker-name", text: album.name}),
                    el("span", {className: "album-picker-count",
                                text: have ? (ids.length > 1 ? have + " of " + ids.length + " in it"
                                    : "in it") : ""})
                ]);
                button.title = removing ? "Take them out of " + album.name
                    : full ? "In " + album.name + " (click to take " +
                      (ids.length === 1 ? "it" : "them") + " out)" : "Add to " + album.name;
                button.addEventListener("click", function () {
                    rowClicked(album);
                });
                list.appendChild(el("li", null, [button]));
            });
            var canMake = !removing && name && !exact();
            create.hidden = !canMake;
            create.disabled = working;
            create.textContent = canMake ? "New album \u201c" + name + "\u201d with " + count : "";
            note.textContent = hint || (shown ? "" : removing
                ? "None of the albums holds these pictures."
                : albums.some(function (album) {
                    return album.kind !== "smart";
                }) ? (name ? "No album has that name yet: Enter makes it." : "") :
                    "There are no albums yet: type a name for the first one.");
        }

        input.addEventListener("input", function () {
            hint = "";
            draw();
        });
        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault();
                enter();
            }
        });
        create.addEventListener("click", make);
        box.button("Done", "primary", function () {
            box.close();
        });
        draw();
        window.setTimeout(function () {
            input.focus();
        }, 0);
        return box;
    }

    /* The marks row of the information pane: the favorite star and the
       rating (buttons for the admin, else shown when set), and the
       picture's albums as chips (with "Add to album..." for the admin). */
    function marksRow(rec, context) {
        var editable = admin();
        var albums = context.albums ? context.albums() || [] : [];
        var inAlbums = albumsOfRecord(rec, albums);
        var rating = typeof rec.rt === "number" ? rec.rt : 0;
        if (!editable && !rec.fav && !rating && !inAlbums.length) {
            return null;
        }
        var row = el("div", {className: "info-marks"});
        if (editable) {
            var favorite = el("button", {
                type: "button", className: "info-mark-favorite" + (rec.fav ? " is-on" : ""),
                text: (rec.fav ? STAR : HOLLOW_STAR) + " Favorite",
                title: rec.fav ? "A favorite (F takes the star away)" : "Make it a favorite (F)",
                attrs: {"aria-pressed": rec.fav ? "true" : "false"}
            });
            favorite.addEventListener("click", function () {
                markPicture(rec, context, {favorite: !rec.fav}, favorite);
            });
            row.appendChild(favorite);
            var group = el("span", {className: "info-rating", attrs: {role: "group",
                                                                   "aria-label": "Rating"}});
            for (var n = 1; n <= 5; n++) {
                (function (value) {
                    var star = el("button", {
                        type: "button", className: "info-mark-star" + (value <= rating ? " is-on" : ""),
                        text: value <= rating ? STAR : HOLLOW_STAR,
                        title: value === rating ? "Rated " + plural(value, "star") +
                            " (click again, or 0, to clear)" : "Rate " + plural(value, "star") +
                            " (" + value + ")",
                        attrs: {"aria-label": "Rate " + plural(value, "star"),
                                "aria-pressed": value === rating ? "true" : "false",
                                "data-stars": String(value)}
                    });
                    star.addEventListener("click", function () {
                        markPicture(rec, context, {rating: value === rating ? 0 : value}, star);
                    });
                    group.appendChild(star);
                })(n);
            }
            var clearButton = el("button", {type: "button", className: "info-mark-clear",
                                            hidden: !rating, text: "\u00d7",
                                            title: "Clear the rating (0)",
                                            attrs: {"aria-label": "Clear the rating"}});
            clearButton.addEventListener("click", function () {
                markPicture(rec, context, {rating: 0}, clearButton);
            });
            group.appendChild(clearButton);
            row.appendChild(group);
        } else {
            if (rec.fav) {
                row.appendChild(badge(STAR + " Favorite", "is-favorite"));
            }
            if (rating) {
                row.appendChild(el("span", {className: "info-rating-text", text: stars(rating),
                                            title: "Rated " + plural(rating, "star"),
                                            attrs: {"aria-label": "Rated " +
                                                    plural(rating, "star")}}));
            }
        }
        if (inAlbums.length || editable) {
            var chips = el("div", {className: "info-chips info-albums"});
            inAlbums.forEach(function (album) {
                // (By its id when its name could name another album.)
                var term = window.SearchCore && SearchCore.albumTerm
                    ? SearchCore.albumTerm(albums, album) : "album:" + quote(album.name);
                chips.appendChild(chip(album.name, "q", term, context,
                                       "Show the album " + album.name));
            });
            if (editable) {
                var add = el("button", {type: "button", className: "button small info-album-add",
                                        text: "Add to album\u2026",
                                        title: "Put this picture in an album (A)"});
                add.addEventListener("click", function () {
                    openPicker(rec, context);
                });
                chips.appendChild(add);
            }
            row.appendChild(chips);
        }
        return row;
    }

    /* The marks control that has the focus ({name: its class, stars}), so
       that it gets it back once the controls are drawn again; or null. */
    var MARK_CONTROLS = ["info-mark-favorite", "info-mark-star", "info-mark-clear",
                         "info-album-add", "viewer-star", "viewer-rate"];

    function markFocus() {
        var node = document.activeElement;
        if (!node || !node.classList) {
            return null;
        }
        for (var k = 0; k < MARK_CONTROLS.length; k++) {
            if (node.classList.contains(MARK_CONTROLS[k])) {
                return {name: MARK_CONTROLS[k], stars: node.getAttribute("data-stars")};
            }
        }
        return null;
    }

    function restoreMarkFocus(saved) {
        if (!saved) {
            return;
        }
        var target = document.querySelector("." + saved.name + (saved.stars
            ? '[data-stars="' + saved.stars + '"]' : ""));
        if (target && target.hidden) {
            // (The clear button goes with the rating: its first star then.)
            target = document.querySelector(saved.name === "info-mark-clear"
                ? ".info-mark-star" : ".viewer-rate");
        }
        if (target && !target.hidden) {
            target.focus({preventScroll: true});
        }
    }

    // Change the marks of the picture shown (change: {favorite} or {rating}).
    function markPicture(rec, context, change, button) {
        var focused = markFocus();
        if (button) {
            button.disabled = true;
        }
        var get = function (id) {
            return id === rec.i ? rec : context.get ? context.get(id) : null;
        };
        sendMarks([rec.i], change, get).then(function () {
            if (change.favorite !== undefined) {
                toast(change.favorite ? STAR + " A favorite now." : "No longer a favorite.", "ok");
            } else {
                toast(change.rating ? "Rated " + plural(change.rating, "star") + "."
                    : "The rating was cleared.", "ok");
            }
            if (context.onMarked) {
                context.onMarked([rec.i]);
            }
            restoreMarkFocus(focused);
        }, function () {
            if (button) {
                button.disabled = false;
            }
            restoreMarkFocus(focused);
        });
    }

    /* A key of the marks (admin) for the picture rec: F, 1-5, 0 (clear)
       and A (the album picker), by its marks rather than by buttons (so
       they work while the pane shows the edit form). True when it was one. */
    function markByKey(rec, context, key) {
        var rating = typeof rec.rt === "number" ? rec.rt : 0;
        if (key === "f" || key === "F") {
            markPicture(rec, context, {favorite: !rec.fav}, null);
        } else if (/^[1-5]$/.test(key)) {
            if (Number(key) !== rating) {           // (a key never clears it)
                markPicture(rec, context, {rating: Number(key)}, null);
            }
        } else if (key === "0") {
            if (rating) {
                markPicture(rec, context, {rating: 0}, null);
            }
        } else if (key === "a" || key === "A") {
            openPicker(rec, context);
        } else {
            return false;
        }
        return true;
    }

    // "Add to album..." for the picture rec.
    function openPicker(rec, context) {
        var albums = context.albums ? context.albums() || [] : [];
        albumPicker({ids: [rec.i], get: context.get, albums: albums, mode: "add",
                     onChange: function () {
                         if (context.onMarked) {
                             context.onMarked([rec.i]);
                         }
                     }});
    }

    /* ---------- Editing (admin) --------------------------------------------- */

    // The edit open in an information pane: {id, box, detail, context,
    // cancel} or null.
    var editing = null;

    function isEditing(box) {
        return Boolean(editing && (!box || editing.box === box));
    }

    // True (with a note) when an edit open in box has changes not saved yet.
    function unsavedEdit(box) {
        if (!isEditing(box) || !editing.form || !editing.form.isDirty()) {
            return false;
        }
        toast("Your changes are not saved: Save or Cancel them first.", "warn");
        if (!box.contains(document.activeElement)) {
            editing.form.focusFirst();
        }
        return true;
    }

    // Close an open edit without saving (the pane shows the picture again).
    function cancelEdit() {
        if (editing) {
            editing.cancel();
        }
    }

    function fieldBox(label, control, extra) {
        return el("div", {className: "edit-field"}, [
            el("label", {className: "edit-label", text: label, htmlFor: control.id}),
            control
        ].concat(extra || []));
    }

    /* The edit form of rec in box, from the answer of GET
       /images/<id>/edits (data). finish(answer) after a save (the answer
       of the POST), finish(null) to cancel. */
    function editForm(rec, data, finish) {
        var model = data.model_info && typeof data.model_info === "object" ? data.model_info : {};
        var edits = data.edits || {};
        var modelTitle = typeof model.title === "string" ? model.title : "";
        var modelDescription = typeof model.description === "string" ? model.description : "";
        var modelTags = Array.isArray(model.tags) ? model.tags.filter(function (tag) {
            return typeof tag === "string";
        }) : [];
        var added = (edits.tags_add || []).map(tagKey);
        var removed = (edits.tags_remove || []).map(tagKey);
        var prefix = "edit-" + rec.i + "-";
        var form = el("form", {className: "info-edit", attrs: {"aria-label": "Edit the picture"}});
        form.appendChild(el("h2", {className: "info-title", text: "Edit"}));

        // A button that puts the model's text back in a field.
        function modelButton(control, original, what) {
            var button = el("button", {type: "button", className: "button subtle small",
                                       text: "Use the model's " + what});
            function sync() {
                button.hidden = control.value.replace(/^\s+|\s+$/g, "") ===
                    original.replace(/^\s+|\s+$/g, "");
            }
            button.addEventListener("click", function () {
                control.value = original;
                sync();
                control.focus();
            });
            control.addEventListener("input", sync);
            sync();
            return button;
        }

        var title = el("input", {type: "text", className: "input", id: prefix + "title",
                                 value: edits.title || modelTitle, maxLength: 200,
                                 placeholder: modelTitle || "A title of your own"});
        title.addEventListener("keydown", function (event) {
            // Enter goes on to the description (Ctrl+Enter saves).
            if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                description.focus();
            }
        });
        form.appendChild(fieldBox("Title", title, [modelButton(title, modelTitle, "title")]));
        var description = el("textarea", {className: "input", id: prefix + "description",
                                          rows: 5, maxLength: 4000,
                                          placeholder: modelDescription ||
                                              "A description of your own"});
        description.value = edits.description || modelDescription;
        form.appendChild(fieldBox("Description", description,
                                  [modelButton(description, modelDescription, "description")]));

        var modelKeys = Object.create(null);
        modelTags.forEach(function (tag) {
            modelKeys[tagKey(tag)] = true;
        });
        var chips = el("div", {className: "info-chips edit-chips", attrs: {"aria-live": "polite"}});
        var tagInput = el("input", {type: "text", className: "input", id: prefix + "tag",
                                    placeholder: "Add a tag (a name, a place, ...)",
                                    maxLength: 200, autocomplete: "off",
                                    attrs: {"aria-describedby": prefix + "tag-error"}});
        var tagError = el("p", {className: "edit-error", id: prefix + "tag-error", hidden: true});
        var addButton = el("button", {type: "button", className: "button small", text: "Add"});
        var resetTags = el("button", {type: "button", className: "button subtle small",
                                      text: "Use the model's tags"});
        function chipButton(text, label, onClick) {
            var button = el("button", {type: "button", className: "edit-chip-x", text: text,
                                       title: label, attrs: {"aria-label": label}});
            button.addEventListener("click", function () {
                onClick();
                drawTags();
                tagInput.focus();
            });
            return button;
        }
        function drawTags() {
            clear(chips);
            editedTags(modelTags, added, removed).forEach(function (item) {
                var x = chipButton("\u00d7", "Remove the tag " + item.tag, function () {
                    if (item.added) {
                        added = added.filter(function (tag) {
                            return tag !== item.tag;
                        });
                    }
                    if (modelKeys[item.tag] && removed.indexOf(item.tag) < 0) {
                        removed.push(item.tag);
                    }
                });
                chips.appendChild(el("span", {
                    className: "info-chip edit-chip" + (item.added ? " is-added" : ""),
                    title: item.added ? "Added by you" : ""
                }, [item.tag, x]));
            });
            if (!chips.childNodes.length) {
                chips.appendChild(el("span", {className: "muted", text: "No tags."}));
            }
            // The model's tags taken away, to put back with a click.
            removed.forEach(function (tag) {
                if (!modelKeys[tag]) {
                    return;
                }
                var back = chipButton("+", "Put back the tag " + tag, function () {
                    removed = removed.filter(function (other) {
                        return other !== tag;
                    });
                });
                chips.appendChild(el("span", {className: "info-chip edit-chip is-removed",
                                              title: "The model's tag, removed"},
                                     [el("span", {className: "edit-chip-text", text: tag}), back]));
            });
            resetTags.hidden = !added.length && !removed.length;
        }
        // Add what the tag box holds; false (and a message) when it cannot be.
        function addTags() {
            var tags = splitTags(tagInput.value);
            var problem = tagProblem(tags);
            tagError.textContent = problem;
            tagError.hidden = !problem;
            tagInput.classList.toggle("is-invalid", Boolean(problem));
            if (problem) {
                return false;
            }
            tags.forEach(function (tag) {
                var at = removed.indexOf(tag);
                if (at >= 0) {
                    removed.splice(at, 1);      // the model's tag, back again
                } else if (!modelKeys[tag] && added.indexOf(tag) < 0) {
                    added.push(tag);            // (one the model gave is there already)
                }
            });
            tagInput.value = "";
            drawTags();
            return true;
        }
        addButton.addEventListener("click", function () {
            addTags();
            tagInput.focus();
        });
        tagInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                addTags();
            }
        });
        resetTags.addEventListener("click", function () {
            added = [];
            removed = [];
            drawTags();
            tagInput.focus();               // (this button hides itself)
        });
        drawTags();
        form.appendChild(fieldBox("Tags", el("div", {className: "edit-tag-add"},
                                             [tagInput, addButton]),
                                  [tagError, chips, resetTags,
                                   el("p", {className: "info-small muted",
                                            text: "Tags you add are searched like the " +
                                                  "model's, and stay when the picture is " +
                                                  "described again."})]));
        // (The tag box's own id is the label's target.)
        form.lastChild.firstChild.htmlFor = tagInput.id;

        var save = el("button", {type: "submit", className: "button primary small", text: "Save"});
        var cancel = el("button", {type: "button", className: "button small", text: "Cancel"});
        cancel.addEventListener("click", function () {
            finish(null);
        });
        form.appendChild(el("div", {className: "info-actions edit-actions"}, [
            save, cancel,
            el("span", {className: "info-small muted", text: "Ctrl+Enter saves, Esc cancels"})
        ]));
        var busy = false;
        function submit() {
            if (busy) {
                return;
            }
            if (tagInput.value.replace(/\s+/g, "") && !addTags()) {
                tagInput.focus();
                return;
            }
            busy = true;
            save.disabled = true;
            var body = editBody(model, {title: title.value, description: description.value,
                                        added: added, removed: removed});
            SHELL.admin("/images/" + encodeURIComponent(rec.i) + "/edits", body)
                .then(function (answer) {
                    finish(answer);
                }, function () {
                    busy = false;
                    save.disabled = false;
                });
        }
        form.addEventListener("submit", function (event) {
            event.preventDefault();
            submit();
        });
        form.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
            }
        });
        form.focusFirst = function () {
            title.focus();
        };
        function current() {
            return JSON.stringify(editBody(model, {title: title.value,
                                                   description: description.value,
                                                   added: added, removed: removed}));
        }
        var initial = current();
        // True when the form holds changes that are not saved.
        form.isDirty = function () {
            return Boolean(tagInput.value.replace(/\s+/g, "")) || current() !== initial;
        };
        return form;
    }

    /* Open the edit form of rec in box (admin): the pane shows it until it
       is saved or cancelled, then the picture again (with detail, updated
       by a save). */
    function startEdit(box, rec, detail, context) {
        if (!admin() || !rec) {
            return;
        }
        if (isEditing(box) && editing.id === rec.i) {
            return;
        }
        cancelEdit();
        var token = {id: rec.i, box: box, detail: detail, context: context};
        editing = token;
        function done(answer) {
            if (editing !== token) {
                return;
            }
            editing = null;
            var shown = token.detail;
            if (answer) {
                ["t", "d", "g", "ed"].forEach(function (key) {
                    var value = answer.record ? answer.record[key] : undefined;
                    if (value === undefined) {
                        delete rec[key];
                    } else {
                        rec[key] = value;
                    }
                });
                shown = {};
                Object.keys(token.detail || {}).forEach(function (key) {
                    shown[key] = token.detail[key];
                });
                shown.info = answer.info;
                shown.model_info = answer.model_info;
                shown.edits = answer.edits;
                shown.edited = answer.edited;
                toast(answer.edited ? "Saved. Your words are searched now."
                    : "Saved: the model's text is used again.", "ok");
            }
            // (A Save button that was pressed and then disabled while the
            // request ran has dropped the focus to the page.)
            var focused = document.activeElement;
            var hadFocus = !focused || focused === document.body || box.contains(focused);
            renderInfo(box, rec, shown, token.context);
            if (answer && token.context.onEdited) {
                token.context.onEdited(rec.i, shown);
            }
            // Back at the top, where the new title and the badge are.
            box.scrollTop = 0;
            var heading = box.querySelector(".info-title");
            if (heading) {
                heading.tabIndex = -1;
                if (hadFocus) {
                    heading.focus({preventScroll: true});
                }
                if (heading.scrollIntoView && box.scrollHeight <= box.clientHeight) {
                    heading.scrollIntoView({block: "nearest"});
                }
            }
        }
        token.cancel = function () {
            done(null);
        };
        clear(box);
        box.appendChild(el("p", {className: "muted", text: "Loading\u2026"}));
        SHELL.admin("/images/" + encodeURIComponent(rec.i) + "/edits").then(function (data) {
            if (editing !== token) {
                return;
            }
            clear(box);
            var form = editForm(rec, data, done);
            token.form = form;
            box.appendChild(form);
            box.scrollTop = 0;
            form.focusFirst();
        }, function () {
            done(null);
        });
    }

    /* Fill box with the information about rec (a compact record); detail
       is the full record when it has arrived (server: /api/image), else
       null. context: query, libraryName(id), chipUrl, onChip, similar(id),
       similarUrl(id), onSimilar(id), moreLikeThisUrl(id), onMoreLikeThis(id),
       hasLook(id), looksLike(id), looksLikeUrl(id), onLooksLike(id), onLook(id) (a
       picture of the Looks like this strip opens),
       onHidden, detailUrl(id), inPage (true in the lightbox), expandedText. */
    function renderInfo(box, rec, detail, context) {
        context = context || {};
        if (isEditing(box)) {
            if (rec && editing.id === rec.i) {
                // Keep the open form; the picture is drawn again after it.
                editing.detail = detail || editing.detail;
                editing.context = context;
                return;
            }
            editing = null;                 // another picture: the edit is dropped
        }
        clear(box);
        box.infoId = rec ? rec.i : null;    // (whose information the box shows)
        if (!rec) {
            box.appendChild(el("p", {className: "muted", text: "This picture is not available."}));
            return;
        }
        var head = el("div", {className: "info-head"});
        head.appendChild(el("h2", {className: "info-title"},
                            [highlighted(rec.t || rec.n || "Untitled picture", context.query, "t")]));
        var badges = el("div", {className: "info-badges"});
        if (rec.p === "360") {
            badges.appendChild(badge(rec.mv ? "360\u00b0" : "360\u00b0 photo", "is-360"));
        }
        if (rec.mv) {
            var length = durationText(rec.dr);
            badges.appendChild(badge("Video" + (length ? " \u00b7 " + length : ""), "is-video"));
        }
        if (rec.h) {
            badges.appendChild(badge("Hidden", "is-hidden"));
        }
        if (rec.se && SENSITIVE[rec.se]) {
            badges.appendChild(badge("Sensitive: " + SENSITIVE[rec.se], "is-warn"));
        }
        if (rec.pr) {
            badges.appendChild(badge("Private information", "is-warn"));
        }
        if (rec.ed && admin()) {
            badges.appendChild(badge("Edited", "is-edited"));
        }
        if (badges.childNodes.length) {
            head.appendChild(badges);
        }
        box.appendChild(head);
        var marks = marksRow(rec, context);
        if (marks) {
            box.appendChild(marks);
        }
        if (context.drive) {
            box.appendChild(driveSection(context.drive, context));
        }

        var size = "";
        if (rec.w && rec.hgt) {
            size = rec.w + " \u00d7 " + rec.hgt;
            if (detail && detail.size) {
                size += " \u00b7 " + fileSize(detail.size);
            }
        }
        var exposure = exposureParts(detail && detail.exif).join(" \u00b7 ");
        var lens = detail && detail.exif && typeof detail.exif.LensModel === "string"
            ? detail.exif.LensModel : "";
        var libraryName = context.libraryName ? context.libraryName(rec.l) : "";
        var fileName = rec.n || "";
        var folder = rec.f || "";
        var factList = facts([
            ["Taken", dateText(rec, detail)],
            ["Place", placeFact(rec, context)],
            ["Camera", rec.cm ? chip(rec.cm, "camera", rec.cm, context, "More from this camera") : ""],
            ["Settings", exposure + (lens ? (exposure ? " \u00b7 " : "") + lens : "")],
            ["Video", rec.mv ? videoFacts(rec, detail) : ""],
            ["Library", libraryName],
            ["File", fileName],
            ["Folder", folder],
            ["Size", size]
        ]);
        if (factList) {
            box.appendChild(factList);
        }
        var located = locationNote(box, rec, detail, context);
        if (located) {
            box.appendChild(located);
        }

        if (rec.d) {
            box.appendChild(section("", el("p", {className: "info-description"},
                                            [highlighted(rec.d, context.query, "d")])));
        }
        if (!rec.ds) {
            // Not described: what can be searched is the file name, date and
            // camera -- and the owner's words, when there are some.
            var own = rec.t || rec.d || (rec.g && rec.g.length);
            var what = rec.mv ? "video" : "picture";
            box.appendChild(el("p", {className: "info-note", text: !own
                ? "This " + what + " has not been described yet, so only its file name, " +
                  "date and camera can be searched."
                : "The AI model has not described this " + what + " yet; " +
                  (admin() ? "your" : "its") + " title, description and tags are searched " +
                  "with its file name, date and camera."}));
        }
        var edits = admin() && detail && detail.edits ? detail.edits : null;
        var model = detail && detail.model_info && typeof detail.model_info === "object"
            ? detail.model_info : null;
        var takenAway = edits && Array.isArray(edits.tags_remove) ? edits.tags_remove : [];
        if (edits && model && detail.described !== false &&
                (edits.title || edits.description || takenAway.length)) {
            // The model's own words under the owner's (collapsed).
            var original = el("details", {className: "info-model-text"}, [
                el("summary", {text: "Model's text"})
            ]);
            if (edits.title) {
                original.appendChild(el("p", {className: "info-small",
                                              text: "Title: " + (model.title || "(none)")}));
            }
            if (edits.description) {
                original.appendChild(el("p", {className: "info-small",
                                              text: model.description || "(no description)"}));
            }
            if (takenAway.length) {
                original.appendChild(el("p", {className: "info-small",
                                              text: "Tags you removed: " + takenAway.join(", ")}));
            }
            box.appendChild(original);
        }
        if (rec.o) {
            box.appendChild(section("Text in the picture", longText(rec.o, context, "o")));
        }

        var about = [];
        if (rec.ty) {
            about.push(chip(facetLabel("type", rec.ty), "type", rec.ty, context));
        }
        if (rec.dt) {
            about.push(chip(facetLabel("type", "doc:" + rec.dt), "type", "doc:" + rec.dt, context));
        }
        if (rec.st) {
            about.push(chip(facetLabel("setting", rec.st), "setting", rec.st, context));
        }
        if (rec.sc) {
            about.push(chip(capital(rec.sc), "q", "scene:" + quote(rec.sc), context));
        }
        if (rec.td) {
            about.push(chip(facetLabel("time", rec.td), "time", rec.td, context));
        }
        if (rec.ev) {
            about.push(chip(facetLabel("event", rec.ev), "event", rec.ev, context));
        }
        if (rec.pp) {
            about.push(chip(facetLabel("people", rec.pp), "people", rec.pp, context));
        }
        if (about.length) {
            box.appendChild(section("About", el("div", {className: "info-chips"}, about)));
        }
        [["Tags", "g", "tags"], ["Subjects", "s", "subjects"], ["Animals", "a", "animals"],
         ["Food", "fo", "food"], ["Vehicles", "v", "vehicles"], ["Colors", "c", "colors"]]
            .forEach(function (entry) {
                var values = Array.isArray(rec[entry[1]]) ? rec[entry[1]] : [];
                var row = chipRow(values, entry[2], context, entry[1], function (value) {
                    return "Show all pictures with " + value;
                });
                if (row && entry[1] === "g" && edits && edits.tags_add) {
                    // The tags the owner added.
                    var own = edits.tags_add.map(tagKey);
                    Array.prototype.forEach.call(row.childNodes, function (node) {
                        if (own.indexOf(tagKey(node.textContent)) >= 0) {
                            node.classList.add("is-added");
                            node.title = "Added by you. " + node.title;
                        }
                    });
                }
                if (row) {
                    box.appendChild(section(entry[0], row));
                }
            });
        if (Array.isArray(rec.pd) && rec.pd.length) {
            box.appendChild(section("People", chipRow(rec.pd.map(quote), "q", context, "pd")));
        }
        if (rec.ex) {
            box.appendChild(section("Also seen", el("p", {className: "info-small"},
                                                      [highlighted(rec.ex, context.query, "ex")])));
        }

        var quality = [];
        if (rec.q) {
            quality.push(["Looks", rec.q + "/5"]);
        }
        if (rec.sh) {
            quality.push(["Sharpness", rec.sh + "/5"]);
        }
        var flags = Array.isArray(rec.qf) ? rec.qf : [];
        if (flags.length) {
            quality.push(["Flags", el("div", {className: "info-chips"}, flags.map(function (flag) {
                return chip(FLAGS[flag] || capital(words(flag)), "q", "is:" + flag, context);
            }))]);
        }
        var qualityFacts = facts(quality);
        if (qualityFacts) {
            box.appendChild(section("Quality", qualityFacts));
        }

        var credit = describedBy(detail);
        if (credit || rec.v4) {
            box.appendChild(el("p", {className: "info-credit",
                                     text: (credit ? credit + "." : "") +
                                           (rec.v4 ? (credit ? " " : "") +
                                            "Described with an older prompt (fewer details)." : "")}));
        }

        var actions = el("div", {className: "info-actions"});
        var original = window.SITE ? SITE.imageUrl(rec) : null;
        if (original && rec.mv && !SITE.isStatic) {
            // A video's original is a download (the server sends it as one):
            // a tab that cannot decode it would play only its sound.
            actions.appendChild(el("a", {className: "button small", href: original,
                                         text: "Download the original",
                                         attrs: {download: ""}}));
        } else if (original) {
            actions.appendChild(el("a", {className: "button small", href: original, target: "_blank",
                                         rel: "noopener",
                                         text: SITE.originalLabel || "Open the original"}));
        }
        if (context.inPage && context.detailUrl) {
            actions.appendChild(el("a", {className: "button small", href: context.detailUrl(rec.i),
                                         text: "Details page"}));
        }
        var likeUrl = context.moreLikeThisUrl && (rec.ds || rec.t)
            ? context.moreLikeThisUrl(rec.i) : null;
        if (likeUrl) {
            var like = el("a", {className: "button small info-like", href: likeUrl,
                                text: "More like this",
                                title: "Search for pictures like this one (M)"});
            like.addEventListener("click", function (event) {
                if (!context.onMoreLikeThis || event.button !== 0 || event.ctrlKey ||
                        event.metaKey || event.shiftKey) {
                    return;
                }
                event.preventDefault();
                context.onMoreLikeThis(rec.i);
            });
            actions.appendChild(like);
        }
        var lookUrl = context.looksLikeUrl && context.hasLook && context.hasLook(rec.i)
            ? context.looksLikeUrl(rec.i) : null;
        if (lookUrl) {
            var look = el("a", {className: "button small info-look", href: lookUrl,
                                text: "Looks like this",
                                title: "Search for pictures that look like this one (L)"});
            look.addEventListener("click", function (event) {
                if (!context.onLooksLike || event.button !== 0 || event.ctrlKey ||
                        event.metaKey || event.shiftKey) {
                    return;
                }
                event.preventDefault();
                context.onLooksLike(rec.i);
            });
            actions.appendChild(look);
        }
        if (actions.childNodes.length) {
            box.appendChild(actions);
        }
        if (admin()) {
            var adminRow = adminActions(rec, context, box, detail);
            adminRow.insertBefore(actionButton("Edit", function () {
                startEdit(box, rec, detail, context);
            }, "info-edit-button"), adminRow.firstChild);
            adminRow.firstChild.title = "Edit the title, description and tags (E)";
            box.appendChild(adminRow);
        }

        var similar = context.similar ? context.similar(rec.i) : [];
        if (similar && similar.length) {
            var strip = el("div", {className: "info-similar"});
            similar.forEach(function (id) {
                var other = context.get ? context.get(id) : null;
                var link = el("a", {className: "similar-item",
                                    href: context.similarUrl ? context.similarUrl(id) : "#",
                                    title: other ? altText(other) : ""});
                link.appendChild(el("img", {src: SITE.thumbUrl(other || id), alt: other ? altText(other) : "",
                                            loading: "lazy"}));
                link.addEventListener("click", function (event) {
                    if (!context.onSimilar || event.button !== 0 || event.ctrlKey ||
                            event.metaKey || event.shiftKey) {
                        return;
                    }
                    event.preventDefault();
                    context.onSimilar(id);
                });
                strip.appendChild(link);
            });
            box.appendChild(section("More like this", strip, "info-similar-section"));
        }
        var alike = context.looksLike ? context.looksLike(rec.i) : [];
        if (alike && alike.length) {
            box.appendChild(section("Looks like this", lookStrip(alike, context),
                                    "info-similar-section info-looks-section"));
        }
    }

    // The "Looks like this" strip: thumbnails of pictures (ids) that open in the viewer
    // (context.onLook; without it, the links go to their pages).
    function lookStrip(ids, context) {
        var strip = el("div", {className: "info-similar"});
        ids.forEach(function (id) {
            var other = context.get ? context.get(id) : null;
            var link = el("a", {className: "similar-item",
                                href: context.similarUrl ? context.similarUrl(id) : "#",
                                title: other ? altText(other) : ""});
            link.appendChild(el("img", {src: SITE.thumbUrl(other || id),
                                        alt: other ? altText(other) : "", loading: "lazy"}));
            link.addEventListener("click", function (event) {
                if (!context.onLook || event.button !== 0 || event.ctrlKey ||
                        event.metaKey || event.shiftKey) {
                    return;
                }
                event.preventDefault();
                context.onLook(id);
            });
            strip.appendChild(link);
        });
        return strip;
    }

    /* ---------- Lightbox ----------------------------------------------------- */

    var INFO_KEY = "searchImages.info";
    var lightbox = null;

    function storage(key, value) {
        try {
            if (value === undefined) {
                return window.localStorage.getItem(key);
            }
            window.localStorage.setItem(key, value);
        } catch (error) {
            return null;
        }
        return null;
    }

    function infoWanted() {
        var saved = storage(INFO_KEY);
        if (saved === "1" || saved === "0") {
            return saved === "1";
        }
        return window.innerWidth >= 1100;
    }

    function iconButton(className, label, text) {
        return el("button", {type: "button", className: "viewer-button " + className,
                             title: label, text: text, attrs: {"aria-label": label}});
    }

    function buildLightbox() {
        var root = el("div", {className: "viewer", hidden: true,
                              attrs: {role: "dialog", "aria-modal": "true",
                                      "aria-label": "Picture viewer"}});
        // Focus can rest on the viewer itself (after the pane is redrawn).
        root.tabIndex = -1;
        var main = el("div", {className: "viewer-main"});
        var bar = el("div", {className: "viewer-bar"});
        var close = iconButton("viewer-close", "Close (Esc)", "\u00d7");
        var counter = el("span", {className: "viewer-counter", attrs: {"aria-live": "polite"}});
        var title = el("span", {className: "viewer-title"});
        var zoomOut = iconButton("viewer-zoom-out", "Zoom out (-)", "\u2212");
        var zoomIn = iconButton("viewer-zoom-in", "Zoom in (+)", "+");
        var reset = iconButton("viewer-reset", "Reset the view (0)", "\u27f2");
        var info = iconButton("viewer-info-toggle", "Information (i)", "i");
        // The favorite star and the rating: buttons for the admin (they
        // press those of the information pane), else shown when set.
        var marks = el("span", {className: "viewer-marks"});
        bar.appendChild(close);
        bar.appendChild(counter);
        bar.appendChild(title);
        bar.appendChild(el("span", {className: "viewer-spacer"}));
        bar.appendChild(marks);
        bar.appendChild(zoomOut);
        bar.appendChild(zoomIn);
        bar.appendChild(reset);
        bar.appendChild(info);
        var stageBox = el("div", {className: "viewer-stage"});
        var prev = iconButton("viewer-prev", "Previous picture (\u2190)", "\u2039");
        var next = iconButton("viewer-next", "Next picture (\u2192)", "\u203a");
        var stack = el("div", {className: "viewer-stack", hidden: true});
        main.appendChild(bar);
        main.appendChild(stageBox);
        main.appendChild(prev);
        main.appendChild(next);
        main.appendChild(stack);
        var pane = el("aside", {className: "viewer-info", attrs: {"aria-label": "Information"}});
        root.appendChild(main);
        root.appendChild(pane);
        document.body.appendChild(root);

        var box = {
            root: root, close: close, counter: counter, title: title, zoomIn: zoomIn,
            zoomOut: zoomOut, reset: reset, info: info, prev: prev, next: next, pane: pane,
            stack: stack, stageBox: stageBox, options: null, ids: [], index: 0, id: null,
            detailToken: 0, returnFocus: null, marks: marks, driveSpec: null,
            driveIndex: 0, paneId: null, clipToken: 0, shownDetail: null
        };
        box.stage = new Stage(stageBox, {
            onSwipe: function (direction) {
                step(direction);
            },
            onState: function (state) {
                root.classList.toggle("is-pano", state.pano);
                reset.hidden = !state.pano && !state.zoomed;
                // (A video does not zoom.)
                zoomIn.hidden = zoomOut.hidden = Boolean(state.video);
            }
        });
        close.addEventListener("click", function () {
            if (!unsavedEdit(pane)) {
                closeLightbox();
            }
        });
        prev.addEventListener("click", function () {
            step(-1);
        });
        next.addEventListener("click", function () {
            step(1);
        });
        zoomIn.addEventListener("click", function () {
            box.stage.zoomBy(1.5);
        });
        zoomOut.addEventListener("click", function () {
            box.stage.zoomBy(1 / 1.5);
        });
        reset.addEventListener("click", function () {
            box.stage.reset();
        });
        info.addEventListener("click", function () {
            setInfo(!root.classList.contains("info-open"), true);
        });
        // While open, the viewer has the keyboard: it listens first (capture)
        // and keeps the keys it uses from the page behind it.
        document.addEventListener("keydown", keydown, true);
        return box;
    }

    // The bar's favorite star and rating for the picture shown (rec).
    function showBarMarks(rec) {
        var box = lightbox.marks;
        clear(box);
        if (!rec) {
            return;
        }
        var rating = typeof rec.rt === "number" ? rec.rt : 0;
        if (!admin()) {
            if (rec.fav || rating) {
                box.appendChild(el("span", {
                    className: "viewer-marks-text",
                    text: (rec.fav ? STAR : "") + (rating ? (rec.fav ? " " : "") + rating +
                                                   "/5" : ""),
                    title: (rec.fav ? "A favorite" : "") + (rec.fav && rating ? "; " : "") +
                        (rating ? "rated " + plural(rating, "star") : "")}));
            }
            return;
        }
        var star = iconButton("viewer-star" + (rec.fav ? " is-on" : ""),
                              rec.fav ? "A favorite (F)" : "Make it a favorite (F)",
                              rec.fav ? STAR : HOLLOW_STAR);
        star.setAttribute("aria-pressed", rec.fav ? "true" : "false");
        star.addEventListener("click", function () {
            markPicture(rec, infoContext(rec), {favorite: !rec.fav}, star);
        });
        box.appendChild(star);
        var group = el("span", {className: "viewer-rating", attrs: {role: "group",
                                                                 "aria-label": "Rating"}});
        for (var n = 1; n <= 5; n++) {
            (function (value) {
                var button = el("button", {type: "button", className: "viewer-rate" +
                                           (value <= rating ? " is-on" : ""),
                                           text: value <= rating ? STAR : HOLLOW_STAR,
                                           title: "Rate " + plural(value, "star") + " (" + value +
                                               ")",
                                           attrs: {"aria-label": "Rate " + plural(value, "star"),
                                                   "aria-pressed": value === rating ? "true"
                                                       : "false",
                                                   "data-stars": String(value)}});
                button.addEventListener("click", function () {
                    // (Again on the rating it has: no rating.)
                    markPicture(rec, infoContext(rec), {rating: value === rating ? 0 : value},
                                button);
                });
                group.appendChild(button);
            })(n);
        }
        box.appendChild(group);
    }

    function setInfo(open, remember) {
        lightbox.root.classList.toggle("info-open", open);
        lightbox.info.setAttribute("aria-pressed", open ? "true" : "false");
        if (remember) {
            storage(INFO_KEY, open ? "1" : "0");
        }
        window.setTimeout(function () {
            lightbox.stage.layout();
        }, 0);
    }

    // A slider (such as a 360 video's seek bar) is no place to type: the
    // viewer's letters, digits and Space work there (see sliderKey).
    function typing(target) {
        var tag = target && target.tagName;
        return (tag === "INPUT" && !isSlider(target)) || tag === "TEXTAREA" ||
            tag === "SELECT" || Boolean(target && target.isContentEditable);
    }

    function isSlider(target) {
        return Boolean(target && target.tagName === "INPUT" &&
                       String(target.type).toLowerCase() === "range");
    }

    // The keys a focused slider uses itself (it moves with them).
    function sliderKey(target, key) {
        return isSlider(target) &&
            /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(key);
    }

    /* The record of the picture the viewer's marks are for: the one in the
       information pane, which in a drive is the clip on show (it follows
       the clip that plays), else the picture shown. */
    function paneRecord() {
        return record(lightbox.paneId || lightbox.id);
    }

    /* Does Space play and pause the video shown, with the focus on target?
       On the viewer itself and its own buttons (close, zoom, information,
       previous, next: the viewer opens with the focus on Close); not on
       the buttons and links of the information pane, which Space presses. */
    function viewerSpace(target) {
        if (!target || target === lightbox.root || target === document.body) {
            return true;
        }
        var own = [lightbox.close, lightbox.zoomIn, lightbox.zoomOut, lightbox.reset,
                   lightbox.info, lightbox.prev, lightbox.next];
        if (lightbox.marks.contains(target)) {
            return true;
        }
        return own.indexOf(target) >= 0 ||
            !/^(BUTTON|A|SUMMARY)$/.test(target.tagName || "");
    }

    function keydown(event) {
        if (!lightbox || lightbox.root.hidden || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (event.target && event.target.closest && event.target.closest("dialog")) {
            return;         // (a dialog over the viewer, such as the album picker, has them)
        }
        var key = event.key;
        var handled = true;
        if (key === "Escape" && isEditing(lightbox.pane)) {
            event.preventDefault();
            cancelEdit();
        } else if (key === "Escape") {
            event.preventDefault();
            closeLightbox();
        } else if (key === "Tab") {
            trapFocus(event);
            return;
        } else if (typing(event.target) || isEditing(lightbox.pane) ||
                   sliderKey(event.target, key)) {
            // (While the edit form is open the keys work in it: an arrow on
            // its Save button never leaves the picture. A slider keeps its
            // arrows, Home and End.)
            return;
        } else if (event.target && /(^| )drive-track( |$)/.test(event.target.className || "") &&
                   lightbox.stage.driveKey(key)) {
            // The strip of a drive has the focus: the arrows, Page Up, Page
            // Down, Home and End move in the drive.
            event.preventDefault();
        } else if (event.target && event.target.tagName === "VIDEO" &&
                   (key === "ArrowLeft" || key === "ArrowRight")) {
            // The player has the keyboard focus: the arrows seek (5 s).
            event.preventDefault();
            lightbox.stage.seekBy(key === "ArrowLeft" ? -5 : 5);
        } else if (event.target && event.target.tagName === "VIDEO" &&
                   !/^[iIeEmMlLfFaA0-5]$/.test(key)) {
            // (Space, Home, End and the rest: the player's own; I, E, M, L
            // and the marks' keys are the viewer's, as the players use none
            // of them.)
            return;
        } else if (key === " " && lightbox.stage.video && viewerSpace(event.target)) {
            event.preventDefault();
            lightbox.stage.togglePlay();
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
            event.preventDefault();
            step(key === "ArrowLeft" ? -1 : 1);
        } else if (key === "Home" || key === "End") {
            event.preventDefault();
            go(key === "Home" ? 0 : lightbox.ids.length - 1);
        } else if (key === "i" || key === "I") {
            setInfo(!lightbox.root.classList.contains("info-open"), true);
        } else if ((key === "e" || key === "E") && admin()) {
            event.preventDefault();
            setInfo(true, false);
            var edit = lightbox.pane.querySelector(".info-edit-button");
            if (edit) {
                edit.click();
            }
        } else if ((key === "m" || key === "M") && lightbox.pane.querySelector(".info-like")) {
            event.preventDefault();
            lightbox.pane.querySelector(".info-like").click();
        } else if ((key === "l" || key === "L") && lightbox.pane.querySelector(".info-look")) {
            event.preventDefault();
            lightbox.pane.querySelector(".info-look").click();
        } else if (key === "+" || key === "=") {
            lightbox.stage.zoomBy(1.5);
        } else if (key === "-" || key === "_") {
            lightbox.stage.zoomBy(1 / 1.5);
        } else if (key === "0" && (!admin() || lightbox.stage.isMoved())) {
            // (The admin's 0 clears the rating, once the view is as it was.)
            lightbox.stage.reset();
        } else if (/^[fFaA0-5]$/.test(key) && admin() && paneRecord()) {
            // (In a drive: the clip on show, as the pane and the bar's marks.)
            event.preventDefault();
            markByKey(paneRecord(), infoContext(paneRecord()), key);
        } else {
            handled = false;
        }
        if (handled) {
            event.stopPropagation();
        }
    }

    // Keep the keyboard focus inside the viewer (a redrawn pane drops it).
    function keepFocus() {
        if (lightbox && !lightbox.root.hidden && !lightbox.root.contains(document.activeElement)) {
            lightbox.root.focus({preventScroll: true});
        }
    }

    function trapFocus(event) {
        var focusable = Array.prototype.filter.call(
            lightbox.root.querySelectorAll("button, a[href], input, select, textarea, [tabindex]"),
            function (node) {
                return !node.disabled && !node.hidden && node.offsetParent !== null &&
                    node.tabIndex >= 0;
            });
        if (!focusable.length) {
            return;
        }
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        } else if (!lightbox.root.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        }
    }

    function record(id) {
        var options = lightbox.options;
        return options.get ? options.get(id) : null;
    }

    var preloaded = [];

    /* What Stage.showDrive wants for a drive (options.driveOf), starting at
       the clip id: its clips' records and addresses, and onClip, which makes
       the information pane follow the clip that plays. */
    function driveUrls(drive, id) {
        var clips = [];
        var start = 0;
        var tester = document.createElement("video");
        var probe = function (type) {
            return tester.canPlayType(type);
        };
        var place = null;
        (drive.clips || []).forEach(function (clipId) {
            var rec = record(clipId);
            if (!rec) {
                return;
            }
            if (clipId === id) {
                start = clips.length;
            }
            // A hole: seconds missing (dh), or clips of the drive that are
            // not here (its place, dx, skips some: an album's clips).
            var at = typeof rec.dx === "number" ? rec.dx : 0;
            var hole = rec.dh || (place !== null && at > place + 1 ? 1 : 0);
            place = at;
            clips.push({id: clipId, rec: rec, video: SITE.videoUrl ? SITE.videoUrl(rec) : null,
                        poster: SITE.previewUrl(rec) || SITE.thumbUrl(rec),
                        original: admin() ? SITE.imageUrl(rec) : null,
                        playable: canPlayVideo(rec, probe),
                        duration: rec.dr > 0 ? rec.dr : null, hole: hole});
        });
        var shownId = id;
        // cover: the record with the drive's own title and description.
        var spec = {clips: clips, start: start, matched: drive.matched || {},
                    cover: drive.text !== null && drive.text !== undefined
                        ? record(drive.text) : null};
        spec.onClip = function (index) {
            if (!lightbox || lightbox.id !== shownId || !spec.clips[index]) {
                return;
            }
            lightbox.driveIndex = index;
            var clip = spec.clips[index];
            if (lightbox.paneId === clip.id || isEditing(lightbox.pane)) {
                return;
            }
            lightbox.paneId = clip.id;
            renderPane(clip.rec, null);
            // (The bar's star and rating, and the mark keys, go with it.)
            showBarMarks(clip.rec);
            var token = ++lightbox.clipToken;
            if (clip.id !== shownId && window.SITE && SITE.loadRecord) {
                SITE.loadRecord(clip.id, function (detail) {
                    if (lightbox && token === lightbox.clipToken && detail &&
                            lightbox.paneId === clip.id) {
                        renderPane(clip.rec, detail);
                    }
                });
            } else if (lightbox.shownDetail) {
                renderPane(clip.rec, lightbox.shownDetail);
            }
        };
        return spec;
    }

    function preload(id) {
        var rec = record(id);
        var url = rec ? SITE.previewUrl(rec) : null;
        if (!url) {
            return;
        }
        var image = new Image();
        image.decoding = "async";
        image.src = url;
        preloaded.push(image);
        if (preloaded.length > 6) {
            preloaded.shift();
        }
    }

    function infoContext(rec) {
        var options = lightbox.options;
        var context = {
            query: options.query,
            libraryName: options.libraryName,
            chipUrl: options.chipUrl,
            onChip: options.onChip ? function (group, value) {
                closeLightbox();
                options.onChip(group, value);
            } : null,
            similar: options.similar,
            similarUrl: function (id) {
                return options.detailUrl ? options.detailUrl(id) : "#";
            },
            onSimilar: function (id) {
                show(id, "More like this");
            },
            onLook: function (id) {
                show(id, "Looks like this");
            },
            moreLikeThisUrl: function (id) {
                return window.SITE ? SITE.searchUrl({q: "similar:" + id}) : null;
            },
            onMoreLikeThis: options.moreLikeThis ? function (id) {
                closeLightbox();
                options.moreLikeThis(id);
            } : null,
            hasLook: options.hasLook,
            looksLike: options.looksLike,
            looksLikeUrl: function (id) {
                return window.SITE ? SITE.searchUrl({q: "look:" + id}) : null;
            },
            onLooksLike: options.onLooksLike ? function (id) {
                closeLightbox();
                options.onLooksLike(id);
            } : null,
            onHidden: function (ids, hidden) {
                if (options.onHidden) {
                    options.onHidden(ids, hidden);
                }
                // (lightbox.detail is that of the picture in the pane.)
                if ((lightbox.paneId || lightbox.id) === rec.i) {
                    renderPane(rec, lightbox.detail);
                }
            },
            onEdited: function (id, detail) {
                // (The pane may show another picture by now: an answer that
                // came late keeps its detail to itself.)
                if (lightbox.paneId === id) {
                    lightbox.detail = detail;
                }
                if (lightbox.id === id) {
                    lightbox.title.textContent = titleOf(rec);
                }
                if (options.onEdited) {
                    options.onEdited(id);
                }
            },
            albums: options.albums,
            onMarked: function (ids) {
                // The picture in the pane (in a drive: the clip on show),
                // drawn again with its own details (lightbox.detail).
                if ((lightbox.paneId || lightbox.id) === rec.i) {
                    renderPane(rec, lightbox.detail);
                    showBarMarks(rec);
                }
                if (options.onMarked) {
                    options.onMarked(ids);
                }
            },
            get: options.get,
            detailUrl: options.detailUrl,
            inPage: true
        };
        var drive = lightbox.driveSpec;
        if (drive && rec) {
            var at = -1;
            drive.clips.forEach(function (clip, index) {
                if (clip.id === rec.i) {
                    at = index;
                }
            });
            if (at >= 0) {
                var timeline = driveTimeline(drive.clips.map(function (clip) {
                    return clip.duration;
                }));
                context.drive = {cover: drive.cover, index: at, count: drive.clips.length,
                                 start: timeline.starts[at], length: timeline.total};
            }
        }
        return context;
    }

    // The title bar: a drive's own title while a drive is shown.
    function titleOf(rec) {
        var cover = lightbox.driveSpec ? lightbox.driveSpec.cover : null;
        return (cover && cover.dvt) || rec.t || rec.n || "";
    }

    function renderPane(rec, detail) {
        var hadFocus = lightbox.pane.contains(document.activeElement);
        lightbox.detail = detail;
        renderInfo(lightbox.pane, rec, detail, infoContext(rec));
        if (hadFocus) {
            keepFocus();
        }
    }

    /* The note under the stage of a folded stack (or drive): how many
       pictures (clips) it holds, and a button that opens it in the grid. */
    function showStackNote(rec) {
        var options = lightbox.options;
        var members = options.stackOf ? options.stackOf(rec.i) : null;
        var note = lightbox.stack;
        clear(note);
        var drive = !members && rec.mv && options.driveOf ? options.driveOf(rec.i) : null;
        if (drive && drive.folded && options.onExpandDrive && drive.clips.length > 1) {
            note.appendChild(document.createTextNode("A drive of " + plural(drive.clips.length,
                                                                            "clip") + " "));
            var open = el("button", {type: "button", className: "button small",
                                     text: "Show its clips in the grid"});
            open.addEventListener("click", function () {
                options.onExpandDrive(rec.i);
            });
            note.appendChild(open);
            note.hidden = false;
            return;
        }
        if (!members || members.length < 2) {
            note.hidden = true;
            return;
        }
        note.appendChild(document.createTextNode(plural(members.length - 1, "similar picture") +
                                                 " in this stack "));
        var expand = el("button", {type: "button", className: "button small",
                                   text: "Show them all"});
        expand.addEventListener("click", function () {
            if (options.onExpandStack) {
                options.onExpandStack(rec.i);
            }
        });
        note.appendChild(expand);
        if (options.reviewUrl) {
            note.appendChild(document.createTextNode(" "));
            note.appendChild(el("a", {className: "button small", href: options.reviewUrl(rec.i),
                                      text: "Review duplicates"}));
        }
        note.hidden = false;
    }

    // detour: what the counter says when id is not one of the results.
    function show(id, detour) {
        var rec = record(id);
        if (!rec) {
            return;
        }
        var position = lightbox.ids.indexOf(id);
        if (position >= 0) {
            lightbox.index = position;
        }
        lightbox.id = id;
        lightbox.removedAt = -1;
        var inList = position >= 0;
        lightbox.counter.textContent = inList
            ? (lightbox.index + 1).toLocaleString() + " of " + lightbox.ids.length.toLocaleString()
            : detour || "Not in these results";
        lightbox.prev.disabled = inList ? lightbox.index <= 0 : false;
        lightbox.next.disabled = inList ? lightbox.index >= lightbox.ids.length - 1 : false;
        var urls = stageUrls(rec, null);
        var drive = rec.mv && lightbox.options.driveOf ? lightbox.options.driveOf(id) : null;
        lightbox.driveSpec = drive ? driveUrls(drive, id) : null;
        lightbox.shownDetail = null;
        lightbox.paneId = id;
        lightbox.clipToken += 1;
        if (lightbox.driveSpec && lightbox.driveSpec.clips.length > 1) {
            urls.drive = lightbox.driveSpec;
        } else {
            lightbox.driveSpec = null;
        }
        lightbox.title.textContent = titleOf(rec);
        renderPane(rec, null);
        lightbox.stage.show(rec, urls);
        showBarMarks(rec);
        showStackNote(rec);
        var token = ++lightbox.detailToken;
        if (window.SITE && SITE.loadRecord) {
            SITE.loadRecord(id, function (detail) {
                if (lightbox && token === lightbox.detailToken && detail) {
                    lightbox.shownDetail = detail;
                    if (lightbox.paneId === id) {
                        renderPane(rec, detail);
                    }
                    // (A video may have a playable copy; a drive a sped-up preview.)
                    lightbox.stage.videoDetail(detail);
                }
            });
        }
        var at = lightbox.index;
        if (lightbox.ids[at + 1] !== undefined) {
            preload(lightbox.ids[at + 1]);
        }
        if (lightbox.ids[at - 1] !== undefined) {
            preload(lightbox.ids[at - 1]);
        }
        if (lightbox.options.onShow) {
            lightbox.options.onShow(id, inList ? lightbox.index : -1);
        }
    }

    function go(index) {
        if (!lightbox.ids.length || unsavedEdit(lightbox.pane)) {
            return;
        }
        index = clamp(index, 0, lightbox.ids.length - 1);
        show(lightbox.ids[index]);
    }

    function step(direction) {
        if (unsavedEdit(lightbox.pane)) {
            return;
        }
        var inList = lightbox.ids.indexOf(lightbox.id) >= 0;
        var target;
        if (inList) {
            target = lightbox.index + direction;
        } else if (lightbox.removedAt >= 0) {
            // The picture shown left the results (hidden): its place now
            // holds the next one.
            target = direction > 0 ? lightbox.removedAt : lightbox.removedAt - 1;
        } else {
            // Back from a "More like this" picture to where the list was.
            go(lightbox.index + (direction > 0 ? 1 : 0));
            return;
        }
        if (target < 0 || target >= lightbox.ids.length) {
            lightbox.stage.box.classList.add("is-end");
            window.setTimeout(function () {
                lightbox.stage.box.classList.remove("is-end");
            }, 250);
            return;
        }
        go(target);
    }

    function open(options) {
        options = options || {};
        var wanted = options.id !== undefined ? options.id : (options.ids || [])[options.index || 0];
        if (wanted === undefined || !options.get || !options.get(wanted)) {
            return false;
        }
        if (!lightbox) {
            lightbox = buildLightbox();
        }
        lightbox.options = options;
        lightbox.ids = (options.ids || []).slice();
        lightbox.index = clamp(options.index || 0, 0, Math.max(0, lightbox.ids.length - 1));
        if (lightbox.root.hidden) {
            lightbox.returnFocus = document.activeElement;
            lightbox.root.hidden = false;
            document.documentElement.classList.add("viewer-open");
            setInfo(infoWanted(), false);
        }
        show(wanted);
        lightbox.close.focus();
        return true;
    }

    function closeLightbox() {
        if (!lightbox || lightbox.root.hidden) {
            return;
        }
        if (isEditing(lightbox.pane)) {
            editing = null;                 // (not saved)
        }
        var id = lightbox.id;
        lightbox.root.hidden = true;
        lightbox.detailToken += 1;
        lightbox.stage.show(null, {});
        lightbox.stage.dropPano();
        document.documentElement.classList.remove("viewer-open");
        var options = lightbox.options || {};
        if (options.onClose) {
            options.onClose(id);
        } else if (lightbox.returnFocus && lightbox.returnFocus.focus) {
            lightbox.returnFocus.focus();
        }
    }

    function update(ids) {
        if (!lightbox || lightbox.root.hidden) {
            return;
        }
        var wasInList = lightbox.ids.indexOf(lightbox.id) >= 0;
        lightbox.ids = (ids || []).slice();
        var position = lightbox.ids.indexOf(lightbox.id);
        if (position >= 0) {
            lightbox.index = position;
            lightbox.removedAt = -1;
        } else {
            if (wasInList) {
                // Hidden (or otherwise gone) while shown: the next picture
                // has moved up into its place.
                lightbox.removedAt = Math.min(lightbox.index, lightbox.ids.length);
            }
            lightbox.index = clamp(lightbox.index, 0, Math.max(0, lightbox.ids.length - 1));
        }
        var inList = position >= 0;
        lightbox.counter.textContent = inList
            ? (lightbox.index + 1).toLocaleString() + " of " + lightbox.ids.length.toLocaleString()
            : "Not in these results";
        if (inList) {
            lightbox.prev.disabled = lightbox.index <= 0;
            lightbox.next.disabled = lightbox.index >= lightbox.ids.length - 1;
        } else if (lightbox.removedAt >= 0) {
            lightbox.prev.disabled = lightbox.removedAt <= 0;
            lightbox.next.disabled = lightbox.removedAt >= lightbox.ids.length;
        } else {
            lightbox.prev.disabled = false;
            lightbox.next.disabled = false;
        }
        var rec = record(lightbox.id);
        if (rec) {
            showStackNote(rec);
        }
        keepFocus();
    }

    // The information pane of the picture shown (of a drive: the clip it
    // follows), drawn again (not while an edit is open in it).
    function refreshInfo() {
        if (!lightbox || lightbox.root.hidden || isEditing(lightbox.pane)) {
            return;
        }
        var rec = record(lightbox.paneId || lightbox.id);
        if (rec) {
            renderPane(rec, lightbox.detail);
            showBarMarks(rec);
        }
    }

    return {
        format: format,
        marks: {
            favorite: function (ids, on, get) {
                return sendMarks(ids, {favorite: Boolean(on)}, get);
            },
            rate: function (ids, value, get) {
                return sendMarks(ids, {rating: value}, get);
            },
            picker: albumPicker,
            byKey: markByKey,
            stars: stars
        },
        Stage: Stage,
        stageUrls: stageUrls,
        renderInfo: renderInfo,
        altText: altText,
        open: open,
        close: closeLightbox,
        update: update,
        refreshInfo: refreshInfo,
        isOpen: function () {
            return Boolean(lightbox && !lightbox.root.hidden);
        },
        current: function () {
            return lightbox && !lightbox.root.hidden ? lightbox.id : null;
        },
        show: function (id) {
            if (lightbox && !lightbox.root.hidden) {
                show(id);
            }
        }
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = VIEWER;
}
