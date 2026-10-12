/* The detail page (/detail?id=...): one picture on a page of its own, a
   link that can be shared or opened in a new tab. It uses the viewer's
   picture stage (zoom, or the 360-degree view) and information pane
   (viewer.js). The search the picture was found with travels along in the
   address (q, filters, ...), so "Back to search" and the chips lead back
   to it.
*/
(function () {
    "use strict";

    function byId(id) {
        return document.getElementById(id);
    }

    var params = new URLSearchParams(window.location.search);
    var rawId = params.get("id") || "";
    var wantedId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
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
                    url.pathname === new URL(SITE.homeUrl(), window.location.href).pathname;
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
                reset.hidden = !state.pano && !state.zoomed;
            }
        });
        var tools = byId("detail-tools");
        tools.appendChild(toolButton("viewer-zoom-out", "Zoom out (-)", "\u2212", function () {
            stage.zoomBy(1 / 1.5);
        }));
        tools.appendChild(toolButton("viewer-zoom-in", "Zoom in (+)", "+", function () {
            stage.zoomBy(1.5);
        }));
        var reset = toolButton("viewer-reset", "Reset the view (0)", "\u27f2", function () {
            stage.reset();
        });
        reset.hidden = true;
        tools.appendChild(reset);
        stage.show(rec, {thumb: SITE.thumbUrl(rec), preview: SITE.previewUrl(rec),
                         pano: SITE.panoUrl(rec)});

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
                if (group !== "q") {
                    target.filters[group] = [value];
                }
                target.size = "";
                return SITE.searchUrl(target);
            },
            similar: index ? function (id) {
                return SearchCore.similar(index, id, 8, visibility);
            } : null,
            similarUrl: function (id) {
                return SITE.detailUrl(id, search);
            },
            get: function (id) {
                return lookup[id] || null;
            },
            onHidden: function () {
                render();
            },
            onEdited: function (id, edited) {
                // (The viewer changed rec in place; "More like this" uses it.)
                detail = edited;
                if (data && data.records) {
                    data.index = SearchCore.prepare(data.records);
                    index = data.index;
                }
                document.title = (rec.t || rec.n || "Picture") + " - " +
                    (SITE.title || "Image Search");
            },
            inPage: false
        };
        function render() {
            VIEWER.renderInfo(byId("detail-info"), rec, detail, context);
        }
        render();
        document.title = (rec.t || rec.n || "Picture") + " - " + (SITE.title || "Image Search");
        document.addEventListener("keydown", function (event) {
            var tag = event.target && event.target.tagName;
            if (event.ctrlKey || event.metaKey || event.altKey || tag === "INPUT" ||
                    tag === "TEXTAREA" || tag === "SELECT") {
                return;
            }
            if ((event.key === "e" || event.key === "E") && adminOn) {
                var edit = byId("detail-info").querySelector(".info-edit-button");
                if (edit) {
                    event.preventDefault();
                    edit.click();
                }
            } else if (event.key === "+" || event.key === "=") {
                stage.zoomBy(1.5);
            } else if (event.key === "-" || event.key === "_") {
                stage.zoomBy(1 / 1.5);
            } else if (event.key === "0") {
                stage.reset();
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
