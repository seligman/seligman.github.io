/* The detail page (/detail?id=...): one picture on a page of its own, a
   link that can be shared or opened in a new tab. It uses the viewer's
   picture stage (zoom, or the 360-degree view) and information pane
   (viewer.js). The search the picture was found with travels along in the
   address (q, filters, ...), so "Back to search" and the chips lead back
   to it. A video starts at at=<seconds> when the address has it (the People
   page's faces of videos), else where a person the search names is seen
   (VIEWER.format.personMoment, the search as the search page understood
   it: VIEWER.format.searchedQuery); the admin's face=<id> (the People page's
   link to a face of a picture) marks that face on it (a wide picture's pan
   view goes there). The admin marks the picture here as in the viewer (F,
   1-5, 0, A), and chooses where a 360 picture opens ("Open here").
*/
(function () {
    "use strict";

    function byId(id) {
        return document.getElementById(id);
    }

    var params = new URLSearchParams(window.location.search);
    var rawId = params.get("id") || "";
    var wantedId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    var rawAt = params.get("at");
    var startAt = rawAt !== null && /^\d{1,7}(\.\d{1,3})?$/.test(rawAt) ? Number(rawAt) : null;
    // (face=<id>: the People page's link to a face of a picture, marked on it.)
    var rawFace = params.get("face");
    var faceId = rawFace !== null && /^[0-9]{1,15}$/.test(rawFace) ? Number(rawFace) : null;
    var search = SITE.searchState.read();
    var adminOn = Boolean(SITE.capabilities.admin) && !SITE.capabilities.static;

    function message(text, kind) {
        var box = byId("detail-message");
        box.textContent = text;
        box.className = "notice" + (kind ? " " + kind : "");
        box.hidden = !text;
    }

    function setupBack() {
        var back = byId("back");
        back.href = SITE.searchUrl(search);
        // Coming from the search page: going back keeps its scroll position.
        back.addEventListener("click", function (event) {
            var from = document.referrer;
            if (!from || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }
            var same = false;
            try {
                var url = new URL(from);
                same = url.origin === window.location.origin &&
                    url.pathname === new URL(SITE.searchUrl({}), window.location.href).pathname;
            } catch (error) {
                same = false;
            }
            if (same && window.history.length > 1) {
                event.preventDefault();
                window.history.back();
            }
        });
    }

    function toolButton(className, label, text, onClick) {
        var button = SHELL.el("button", {type: "button", className: "viewer-button " + className,
                                         title: label, text: text,
                                         attrs: {"aria-label": label}});
        button.addEventListener("click", onClick);
        return button;
    }

    function show(rec, detail, data) {
        var index = data ? data.index : null;
        var lookup = data ? data.byId : {};
        var names = {};
        ((data && data.libraries) || SITE.libraryList || []).forEach(function (library) {
            names[library.id] = library.name;
        });
        // (Part of a page that scrolls: the wheel and a vertical swipe
        // scroll it until the picture is zoomed in.)
        var stage = new VIEWER.Stage(byId("detail-stage"), {
            scrollPage: true,
            onState: function (state) {
                // (Not at a wide picture's pan view: it opens there.)
                reset.hidden = !state.pano && !state.moved;
                // (Not for a 360 video shown unlevelled, see VIEWER.Stage.)
                openHere.hidden = !state.pano || !adminOn || Boolean(state.unlevelled);
                // (A video does not zoom.)
                zoomOut.hidden = zoomIn.hidden = Boolean(state.video);
            }
        });
        var tools = byId("detail-tools");
        var zoomOut = toolButton("viewer-zoom-out", "Zoom out (-)", "\u2212", function () {
            stage.zoomBy(1 / 1.5);
        });
        var zoomIn = toolButton("viewer-zoom-in", "Zoom in (+)", "+", function () {
            stage.zoomBy(1.5);
        });
        tools.appendChild(zoomOut);
        tools.appendChild(zoomIn);
        var reset = toolButton("viewer-reset", "Reset the view (0)", "\u27f2", function () {
            stage.reset();
        });
        reset.hidden = true;
        // (The admin's: a 360 picture opens at the view shown from now on.)
        var openHere = toolButton("viewer-open-here", "Open here (this 360\u00b0 picture opens " +
                                  "at this view from now on, its thumbnail too)", "Open here",
                                  function () {
                                      VIEWER.keepOpeningView(rec, stage, openHere, false,
                                                             opened);
                                  });
        openHere.hidden = true;
        tools.appendChild(openHere);
        tools.appendChild(reset);
        stage.show(rec, VIEWER.stageUrls(rec, detail));
        if (detail) {
            // (A 360 video's level track.)
            stage.videoDetail(detail);
        }
        if (rec.mv) {
            // (A moment of the video: the address's, else a person the search names.)
            var seenNames = detail && detail.people ? detail.people.names : null;
            stage.seekTo(startAt !== null ? startAt : VIEWER.format.personMoment(
                seenNames, VIEWER.format.searchedQuery(search.q, rec, seenNames, {
                    typed: search.typed, plain: (SITE.capabilities || {}).plain !== false})),
                         startAt === null);
        }

        var visibility = {library: search.lib || "", hidden: adminOn && search.hidden,
                          sensitive: search.sensitive || undefined, junk: search.junk};
        var context = {
            query: search.q,
            libraryName: function (id) {
                return Object.keys(names).length > 1 ? names[id] || "" : "";
            },
            chipUrl: function (group, value) {
                var target = SITE.searchState.read();
                target.q = group === "q" ? value : "";
                target.filters = {};
                target.ids = "";
                target.view = "";           // (a new search: the map fits it)
                target.from = "";
                target.to = "";
                target.area = "";
                target.aname = "";
                if (group !== "q") {
                    target.filters[group] = [value];
                }
                target.size = "";
                return SITE.searchUrl(target);
            },
            similar: index ? function (id) {
                return SearchCore.similar(index, id, 8, visibility);
            } : null,
            hasVector: index ? function (id) {
                return index.hasVector(id);
            } : null,
            similarUrl: function (id) {
                return SITE.detailUrl(id, search);
            },
            moreLikeThisUrl: function (id) {
                return SITE.searchUrl({q: "similar:" + id, lib: search.lib,
                                       sensitive: search.sensitive, junk: search.junk,
                                       hidden: search.hidden});
            },
            hasLook: index ? function (id) {
                return index.hasLook(id);
            } : null,
            looksLike: index ? function (id) {
                var options = {by: "look"};
                Object.keys(visibility).forEach(function (key) {
                    options[key] = visibility[key];
                });
                return SearchCore.similar(index, id, 8, options);
            } : null,
            looksLikeUrl: function (id) {
                return SITE.searchUrl({q: "look:" + id, lib: search.lib,
                                       sensitive: search.sensitive, junk: search.junk,
                                       hidden: search.hidden});
            },
            get: function (id) {
                return lookup[id] || null;
            },
            onHidden: function () {
                render();
            },
            albums: function () {
                return data && data.albums ? data.albums : [];
            },
            onMarked: function () {
                render();
            },
            stage: stage,
            face: faceId,
            onOpening: function () {
                stage.reset();
                render();
            },
            onEdited: function (id, edited) {
                // (The viewer changed rec in place; "More like this" uses it.)
                detail = edited;
                if (data && data.records) {
                    data.index = SearchCore.prepare(data.records);
                    index = data.index;
                    SITE.attachVectors(index);
                    SITE.attachLooks(index);
                }
                document.title = (rec.t || rec.n || "Picture") + " - " +
                    (SITE.title || "Image Search");
            },
            inPage: false
        };
        function render() {
            VIEWER.renderInfo(byId("detail-info"), rec, detail, context);
        }
        // A new opening view (rec.ov changed in place): the pane says whose it is.
        function opened(reply) {
            if (detail && reply && reply.opening_view) {
                detail.opening_view = reply.opening_view;
            }
            render();
        }
        render();
        if (index) {
            // "More like this" by meaning, once the vectors are there.
            SITE.attachVectors(index, function (vectors) {
                if (vectors) {
                    render();
                }
            });
            // "Looks like this" too, once the look vectors are there.
            SITE.attachLooks(index, function (looks) {
                if (looks) {
                    render();
                }
            });
        }
        document.title = (rec.t || rec.n || "Picture") + " - " + (SITE.title || "Image Search");
        document.addEventListener("keydown", function (event) {
            var tag = event.target && event.target.tagName;
            // (A slider, such as a 360 video's seek bar, is no place to
            // type: the letters and digits below work there too.)
            var slider = tag === "INPUT" && String(event.target.type).toLowerCase() === "range";
            if (event.ctrlKey || event.metaKey || event.altKey || (tag === "INPUT" && !slider) ||
                    tag === "TEXTAREA" || tag === "SELECT" ||
                    (event.target.closest && event.target.closest("dialog"))) {
                return;         // (a dialog, such as the album picker, has the keys)
            }
            if ((event.key === "e" || event.key === "E") && adminOn) {
                var edit = byId("detail-info").querySelector(".info-edit-button");
                if (edit) {
                    event.preventDefault();
                    edit.click();
                }
            } else if ((event.key === "m" || event.key === "M") &&
                       byId("detail-info").querySelector(".info-like")) {
                event.preventDefault();
                byId("detail-info").querySelector(".info-like").click();
            } else if ((event.key === "l" || event.key === "L") &&
                       byId("detail-info").querySelector(".info-look")) {
                event.preventDefault();
                byId("detail-info").querySelector(".info-look").click();
            } else if (event.key === "+" || event.key === "=") {
                stage.zoomBy(1.5);
            } else if (event.key === "-" || event.key === "_") {
                stage.zoomBy(1 / 1.5);
            } else if (event.key === "0" && (!adminOn || stage.isMoved())) {
                stage.reset();
            } else if (adminOn && /^[fFaA0-5]$/.test(event.key)) {
                // (The marks: favorite, rating, albums; 0 clears the rating
                // once the view is as it was.)
                if (VIEWER.marks.byKey(rec, context, event.key)) {
                    event.preventDefault();
                }
            }
        });
    }

    function start() {
        setupBack();
        if (rawId === "") {
            message("No picture was chosen.", "warn");
            return;
        }
        var pending = 2;
        var data = null;
        var detail = null;
        function done() {
            pending -= 1;
            if (pending) {
                return;
            }
            var rec = data ? data.byId[wantedId] : null;
            if (!rec && detail) {
                rec = SITE.compactRecord(detail);
            }
            if (!rec) {
                message("This picture is not available: it may have been removed, hidden, or " +
                        "its library turned off.", "warn");
                byId("detail-stage-wrap").hidden = true;
                byId("detail-info").hidden = true;
                return;
            }
            if (detail && detail.hidden !== undefined) {
                if (detail.hidden) {
                    rec.h = 1;
                } else {
                    delete rec.h;
                }
            }
            show(rec, detail, data);
        }
        SITE.loadIndex(function (loaded) {
            if (loaded) {
                var lookup = {};
                loaded.records.forEach(function (rec) {
                    lookup[rec.i] = rec;
                });
                data = {byId: lookup, libraries: loaded.libraries || [],
                        albums: Array.isArray(loaded.albums) ? loaded.albums : [],
                        records: loaded.records, index: SearchCore.prepare(loaded.records)};
            }
            done();
        });
        SITE.loadRecord(wantedId, function (record) {
            detail = record;
            done();
        });
    }

    start();
})();
