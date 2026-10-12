/* The search page: a search box with filters (facets), a grid of
   thumbnails that grows as you scroll, and the picture viewer.

   The index of every picture comes from SITE.loadIndex (the server's
   /api/index, or the files of a static export) and is searched in the
   browser by SearchCore (search-core.js); viewer.js shows the pictures.
   Everything the page shows (query, filters, sort, grouping, size, the
   open picture) is kept in the address, so a link, a reload or the Back
   button bring the same view back, scrolled to where it was. "Show these
   in the grid" on the map comes here with the pictures of a pin (ids=,
   see SITE.idList) and the map's view (view=), for "Back to the map".

   Above the grid, the timeline counts the results per year (month, day);
   choosing bars there limits the search to those dates (state.from/to,
   the "Taken" chip). "Surprise me" opens a random picture of the results.

   The grid is laid out in rows by this script (columns from the width and
   the size slider; a header row per month when sorted by date) and cut
   into blocks of about 60 pictures. Only the blocks near the screen hold
   their thumbnails (an IntersectionObserver fills and empties them); the
   others keep just their height, so 10,000 results cost no more than 60.

   Pages are built with DOM calls and textContent only (never innerHTML).
*/
(function () {
    "use strict";

    var el = SHELL.el;
    var clear = SHELL.clear;
    var fmt = SHELL.format;

    function byId(id) {
        return document.getElementById(id);
    }

    // Smallest thumbnail width per size (small, medium, large).
    var TILE_SIZES = {s: 112, m: 172, l: 264};
    var DOC_TYPES = {screenshot: true, document: true, scan: true};
    var SIZE_NAMES = ["s", "m", "l"];
    var SIZE_LABELS = {s: "Small", m: "Medium", l: "Large"};
    var HEADER_HEIGHT = 40;
    var PHONE_HEADER_HEIGHT = 32;
    var LABEL_TEXT_HEIGHT = 24;
    // Narrower than this (pixels), a month label is shortened ("Jun 2019").
    var SHORT_LABEL_ROOM = 150;
    var BLOCK_TILES = 60;
    var TYPING_DELAY = 120;
    var FACET_SHOWN = 6;
    var SIZE_KEY = "searchImages.size";
    var GROUP_KEY = "searchImages.group";
    var FACETS_CLOSED_KEY = "searchImages.facetsClosed";
    var SIDEBAR_KEY = "searchImages.sidebar";
    var BANNER_KEY = "searchImages.bannerHidden";
    var TIMELINE_KEY = "searchImages.timelineClosed";
    var NARROW = 860;
    var PHONE = 601;            // (the same as style.css's max-width: 600px)
    var REFRESH_AFTER = 30000;

    var adminOn = Boolean(SITE.capabilities.admin) && !SITE.capabilities.static;
    var serverMode = !SITE.isStatic;

    var input = byId("query");
    var grid = byId("grid");
    var facetList = byId("facet-list");
    var facetsBox = byId("facets");
    var monthLabel = byId("month-label");

    var state = SITE.searchState.read();
    var data = null;            // {records, libraries, names, byId, index}
    var result = null;          // the last SearchCore.search answer
    var display = [];           // [{id, stack: [ids] | null, member: bool}]
    var positions = {};         // id -> place in display
    var coverOf = {};           // stack member id -> the id of its stack's cover
    var expanded = {};          // stack cover id -> true while opened in the grid
    var layout = null;
    var observer = null;
    var focusPos = 0;           // the thumbnail that Tab reaches (roving tabindex)
    var selecting = false;
    var selected = {};          // id -> true
    var selectedCount = 0;
    var anchor = null;          // where a shift-click range starts
    var typingTimer = 0;
    // The query is being typed: its last word may be the start of a longer
    // word. Only typing in the box sets it; Enter, a link, Back, a chip or
    // a suggestion search for whole words.
    var typing = false;
    var loadedAt = 0;
    var viewerPushed = false;   // the open viewer added a history entry
    var backPending = false;
    var afterBack = [];
    var scrollTimer = 0;
    var restored = false;
    // What the history entry held when the page loaded (scroll position,
    // and whether it is the entry the viewer added).
    var initialHistory = window.history.state || {};

    /* ---------- Preferences and state ----------------------------------------- */

    (function initialPreferences() {
        var params = new URLSearchParams(window.location.search);
        if (!state.size) {
            var size = SHELL.storageGet(SIZE_KEY);
            state.size = SIZE_NAMES.indexOf(size) >= 0 ? size : "m";
        }
        if (!params.has("group")) {
            state.group = SHELL.storageGet(GROUP_KEY) !== "0";
        }
        if (!adminOn) {
            state.hidden = false;
        }
    })();

    /* The map's view (state.view, for "Back to the map") belongs to the
       search the map showed: it is dropped once the query, the filters or
       the library change, so the map then fits the new results. (Sorting,
       grouping, the size and leaving out the pictures picked on the map
       keep it: the map shows the same pictures.) */
    function mapSearch() {
        return SITE.searchState.params({q: state.q, lib: SHELL.library(), filters: state.filters,
                                        hidden: state.hidden, junk: state.junk,
                                        sensitive: state.sensitive, from: state.from,
                                        to: state.to});
    }

    var viewSearch = "";        // mapSearch() of the search state.view belongs to

    function keepView() {
        viewSearch = mapSearch();
    }

    function dropStaleView() {
        if (state.view && mapSearch() !== viewSearch) {
            state.view = "";
        }
    }

    // The state as the address keeps it (defaults left out).
    function urlState() {
        return {q: state.q, lib: SHELL.library(), sort: state.sort, filters: state.filters,
                group: state.group, size: state.size === "m" ? "" : state.size,
                hidden: state.hidden, junk: state.junk, sensitive: state.sensitive,
                ids: state.ids, view: state.view, from: state.from, to: state.to};
    }

    // The search state for links to other pages (without the view settings).
    function linkState() {
        var copy = urlState();
        copy.size = "";
        return copy;
    }

    function hashId() {
        var match = /(?:^#|&)id=([^&]+)/.exec(window.location.hash || "");
        if (!match) {
            return null;
        }
        var value;
        try {
            value = decodeURIComponent(match[1]);
        } catch (error) {
            return null;                        // a damaged link (#id=%)
        }
        return /^\d+$/.test(value) ? Number(value) : value;
    }

    function writeUrl(options) {
        options = options || {};
        dropStaleView();
        var query = SITE.searchState.params(urlState());
        var id = options.id !== undefined ? options.id : (VIEWER.isOpen() ? VIEWER.current() : null);
        var url = window.location.pathname + (query ? "?" + query : "") +
            (id !== null && id !== undefined ? "#id=" + encodeURIComponent(id) : "");
        var saved = {scrollY: window.scrollY,
                     viewer: Boolean(window.history.state && window.history.state.viewer)};
        if (options.push) {
            window.history.pushState(saved, "", url);
        } else {
            window.history.replaceState(saved, "", url);
        }
        var mapLink = SHELL.navLink ? SHELL.navLink("map") : null;
        if (mapLink && SITE.mapUrl) {
            mapLink.href = SITE.mapUrl(linkState()) || mapLink.href;
        }
        updateTitle();
    }

    // "<query> - <site>" in the browser's tab and history.
    function updateTitle() {
        var site = SITE.title || "Image Search";
        document.title = state.q ? state.q + " - " + site : site;
        // The header's "On this day" is the page while it shows that search.
        var today = SHELL.navLink ? SHELL.navLink("today") : null;
        var search = SHELL.navLink ? SHELL.navLink("search") : null;
        if (today && search) {
            var isToday = state.q.replace(/^\s+|\s+$/g, "") === "on:today";
            today.removeAttribute("aria-current");
            search.removeAttribute("aria-current");
            (isToday ? today : search).setAttribute("aria-current", "page");
        }
    }

    function rememberScroll() {
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(function () {
            if (!backPending) {
                var saved = window.history.state || {};
                saved = {scrollY: window.scrollY, viewer: saved.viewer};
                window.history.replaceState(saved, "", window.location.href);
            }
        }, 200);
    }

    function activeFilterCount() {
        var count = 0;
        Object.keys(state.filters).forEach(function (key) {
            count += state.filters[key].length;
        });
        return count + (state.junk ? 1 : 0) + (state.sensitive ? 1 : 0) + (state.hidden ? 1 : 0) +
            (state.ids ? 1 : 0) + (state.from || state.to ? 1 : 0);
    }

    /* The pictures picked on the map (state.ids): {ids, stale} once the
       records are there, null for none. A list made for other records (an
       export made again since) is dropped, with a note. */
    var pickedCache = {text: null, records: null, value: null};

    function picked() {
        if (!state.ids || !data) {
            return null;
        }
        if (pickedCache.text !== state.ids || pickedCache.records !== data.records) {
            pickedCache = {text: state.ids, records: data.records,
                           value: SITE.idList.decode(state.ids, data.records)};
        }
        return pickedCache.value;
    }

    var droppedPicks = false;

    // Drops a list of picked pictures that cannot be read (before a search).
    function checkPicked() {
        var value = picked();
        if (state.ids && data && (!value || value.stale)) {
            state.ids = "";
            droppedPicks = true;
        }
    }

    /* ---------- Data ----------------------------------------------------------- */

    function setData(loaded) {
        var names = {};
        (loaded.libraries || []).forEach(function (library) {
            names[library.id] = library.name;
        });
        (SITE.libraryList || []).forEach(function (library) {
            if (library.id && !names[library.id]) {
                names[library.id] = library.name;
            }
        });
        var lookup = {};
        loaded.records.forEach(function (rec) {
            lookup[rec.i] = rec;
        });
        data = {
            records: loaded.records,
            libraries: loaded.libraries || [],
            names: names,
            byId: lookup,
            index: SearchCore.prepare(loaded.records)
        };
        loadedAt = Date.now();
    }

    function record(id) {
        return data ? data.byId[id] || null : null;
    }

    // Records were changed in place (the owner's edits): index them again.
    function recordsEdited() {
        if (data) {
            data.index = SearchCore.prepare(data.records);
            run({keepScroll: true});
        }
    }

    function libraryName(id) {
        if (!data || (data.libraries.length < 2 && (SITE.libraryList || []).length < 2)) {
            return "";
        }
        return data.names[id] || "";
    }

    function visibility() {
        return {library: SHELL.library() || "", hidden: adminOn && state.hidden,
                sensitive: state.sensitive || undefined, junk: state.junk};
    }

    function searchOptions() {
        var options = visibility();
        options.libraries = data.libraries;
        options.sort = state.sort || undefined;
        options.filters = state.filters;
        options.group = state.group;
        options.typing = typing;
        options.seed = SITE.shuffleSeed();
        if (state.from || state.to) {
            options.range = {from: state.from, to: state.to};
        }
        var chosen = picked();
        if (chosen && !chosen.stale) {
            options.ids = chosen.ids;
        }
        return options;
    }

    /* ---------- Searching -------------------------------------------------------- */

    function buildDisplay() {
        display = [];
        positions = {};
        coverOf = {};
        result.items.forEach(function (id) {
            var stack = state.group ? result.groups[String(id)] : null;
            stack = stack && stack.length > 1 ? stack : null;
            display.push({id: id, stack: stack, member: false});
            if (stack && expanded[id]) {
                stack.slice(1).forEach(function (member) {
                    display.push({id: member, stack: null, member: true, cover: id});
                });
            }
        });
        display.forEach(function (entry, index) {
            positions[entry.id] = index;
            if (entry.stack) {
                entry.stack.forEach(function (member) {
                    if (member !== entry.id) {
                        coverOf[member] = entry.id;
                    }
                });
            }
        });
        focusPos = Math.min(focusPos, Math.max(0, display.length - 1));
    }

    /* A picture of the results folded into a stack (a stack member, not
       its cover): its stack is opened in the grid, so the viewer steps
       through the stack and then on through the results. True when the
       picture is (now) in the grid. */
    function reveal(id) {
        if (positions[id] !== undefined) {
            return true;
        }
        var cover = coverOf[id];
        if (cover === undefined || expanded[cover]) {
            return false;
        }
        expanded[cover] = true;
        buildDisplay();
        relayout(true);
        renderHead();
        return positions[id] !== undefined;
    }

    function run(options) {
        options = options || {};
        if (!data) {
            return;
        }
        checkPicked();
        dropStaleView();
        var options = searchOptions();
        options.timeline = true;
        result = SearchCore.search(data.index, state.q, options);
        buildDisplay();
        trimSelection();
        renderControls();
        renderHead();
        renderChips();
        renderFacets();
        renderBanner();
        renderTimeline();
        renderSelectionBar();
        syncBar();
        if (options.keepScroll) {
            relayout(true);
        } else {
            relayout(false);
            if (options.top) {
                scrollToResults();
            }
        }
        if (VIEWER.isOpen()) {
            VIEWER.update(display.map(function (entry) {
                return entry.id;
            }));
        }
    }

    function scrollToResults() {
        var head = byId("results");
        var top = head.getBoundingClientRect().top + window.scrollY - barHeight() - 8;
        if (window.scrollY > top) {
            window.scrollTo(0, Math.max(0, top));
        }
    }

    // options: top (false: keep the scroll position), push (a new history
    // entry, so Back returns to the search before).
    function changed(options) {
        options = options || {};
        expanded = {};
        anchor = null;
        droppedPicks = false;
        run({top: options.top !== false});
        writeUrl({push: options.push === true});
    }

    function setQuery(text) {
        typing = false;
        state.q = text;
        if (input.value !== text) {
            input.value = text;
        }
        changed();
    }

    // a is a place inside place b (SearchCore's place values).
    function placeWithin(a, b) {
        return a.lastIndexOf(b + SearchCore.PLACE_SEPARATOR, 0) === 0;
    }

    /* Places are chosen one level at a time: choosing a place drops the
       places it is in and the places in it (Hawaii instead of the United
       States), and taking a town or region away goes back to the place it
       is in, unless another place there is still chosen. */
    function placeChoice(values, value) {
        var at = values.indexOf(value);
        if (at < 0) {
            return values.filter(function (other) {
                return !placeWithin(value, other) && !placeWithin(other, value);
            }).concat([value]);
        }
        values.splice(at, 1);
        var parent = SearchCore.placeParent(value);
        if (parent && !values.some(function (other) {
            return other === parent || placeWithin(other, parent);
        })) {
            values.push(parent);
        }
        return values;
    }

    function toggleFilter(group, value) {
        var values = (state.filters[group] || []).slice();
        var at = values.indexOf(value);
        if (group === "place") {
            values = placeChoice(values, value);
        } else if (at >= 0) {
            values.splice(at, 1);
        } else {
            values.push(value);
        }
        if (group === "year" && at >= 0) {
            delete state.filters.month;
        }
        if (values.length) {
            state.filters[group] = values;
        } else {
            delete state.filters[group];
        }
        changed();
    }

    // Takes a value out of the filters (a chip's x: a place goes entirely).
    function removeFilter(group, value) {
        if (group !== "place") {
            toggleFilter(group, value);
            return;
        }
        var values = (state.filters.place || []).filter(function (other) {
            return other !== value;
        });
        if (values.length) {
            state.filters.place = values;
        } else {
            delete state.filters.place;
        }
        changed();
    }

    function clearFilters() {
        state.filters = {};
        state.from = "";
        state.to = "";
        state.junk = false;
        state.sensitive = "";
        state.hidden = false;
        state.ids = "";
        changed();
    }

    /* A chip of the viewer or info pane: a search for just that value. It
       gets a history entry of its own: Back returns to the search the
       picture was found with, scrolled to where it was. */
    function applyChip(group, value) {
        var saved = window.history.state || {};
        window.history.replaceState({scrollY: window.scrollY, viewer: Boolean(saved.viewer)}, "",
                                    window.location.href);
        typing = false;
        state.filters = {};
        state.ids = "";
        state.from = "";
        state.to = "";
        state.q = "";
        if (group === "q") {
            state.q = value;
        } else {
            state.filters[group] = [value];
        }
        input.value = state.q;
        changed({push: true});
    }

    // (A new search: without the map's view, see dropStaleView.)
    function chipUrl(group, value) {
        var target = linkState();
        target.q = group === "q" ? value : "";
        target.filters = {};
        target.ids = "";
        target.view = "";
        target.from = "";
        target.to = "";
        if (group !== "q") {
            target.filters[group] = [value];
        }
        return SITE.searchUrl(target);
    }

    /* ---------- Controls --------------------------------------------------------- */

    function renderControls() {
        var sort = byId("sort");
        sort.value = result ? result.sort : state.sort || "newest";
        byId("group").checked = state.group;
        var size = byId("size");
        size.value = String(SIZE_NAMES.indexOf(state.size));
        size.setAttribute("aria-valuetext", SIZE_LABELS[state.size]);
        size.title = "Thumbnail size: " + SIZE_LABELS[state.size];
        var count = activeFilterCount();
        var badge = byId("facets-count");
        badge.textContent = String(count);
        badge.hidden = !count;
        var select = byId("select-button");
        select.hidden = !adminOn || !data || !data.records.length;
        select.setAttribute("aria-pressed", selecting ? "true" : "false");
        select.textContent = selecting ? "Done selecting" : "Select";
        document.body.classList.toggle("select-mode", selecting);
    }

    function setupControls() {
        input.value = state.q;
        input.addEventListener("input", function () {
            window.clearTimeout(typingTimer);
            typingTimer = window.setTimeout(function () {
                if (input.value !== state.q) {
                    typing = true;
                    state.q = input.value;
                    changed();
                }
            }, TYPING_DELAY);
        });
        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                window.clearTimeout(typingTimer);
                // Done typing: the last word is a whole word now.
                if (input.value !== state.q || typing) {
                    typing = false;
                    state.q = input.value;
                    changed();
                }
                if (window.innerWidth < NARROW) {
                    input.blur();
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                if (input.value) {
                    input.value = "";
                    window.clearTimeout(typingTimer);
                    setQuery("");
                } else {
                    input.blur();
                }
            } else if (event.key === "ArrowDown" && display.length) {
                event.preventDefault();
                focusTile(Math.min(focusPos, display.length - 1));
            }
        });
        byId("sort").addEventListener("change", function () {
            state.sort = byId("sort").value;
            if (state.sort === "shuffle") {
                SITE.shuffleSeed(true);         // choosing it shuffles anew
            }
            changed();
        });
        byId("surprise-button").addEventListener("click", surprise);
        byId("group").addEventListener("change", function () {
            state.group = byId("group").checked;
            SHELL.storageSet(GROUP_KEY, state.group ? "" : "0");
            changed({top: false});
        });
        byId("size").addEventListener("input", function () {
            state.size = SIZE_NAMES[Number(byId("size").value)] || "m";
            SHELL.storageSet(SIZE_KEY, state.size === "m" ? "" : state.size);
            renderControls();
            relayout(true);
            writeUrl();
        });
        byId("select-button").addEventListener("click", function () {
            setSelecting(!selecting);
            // (On a phone the button is in the filter drawer: get it out of the way.)
            if (selecting && facetsBox.contains(byId("select-button"))) {
                closeDrawer();
            }
        });
        setupSyntaxHelp();
        setupSidebar();
        if (SITE.isStatic && (SITE.capabilities || {}).file_names !== true) {
            // No file names in this export ("File name" would sort by title).
            var byName = byId("sort").querySelector("option[value='name']");
            if (byName) {
                byName.parentNode.removeChild(byName);
            }
            if (state.sort === "name") {
                state.sort = "";
            }
        }
    }

    /* ---------- Search tips ------------------------------------------------------ */

    // SearchCore.SYNTAX, in an export without what it cannot have: other
    // libraries, hidden and undescribed pictures (never exported),
    // screenshots (left out unless chosen), and folder and file names or
    // GPS when they were not exported. Others than the admin cannot find
    // hidden or edited pictures.
    function syntaxRows() {
        if (!SITE.isStatic) {
            return adminOn ? SearchCore.SYNTAX : SearchCore.SYNTAX.map(function (row) {
                return row.example.split(":")[0] !== "is" ? row : {
                    example: row.example,
                    meaning: "360\u00b0 photos; also is:duplicate, is:undescribed"};
            });
        }
        var caps = SITE.capabilities || {};
        var fields = ["tag", "subject", "title", "text (the text in the picture)", "description",
                      "scene", "animal", "food", "vehicle", "color", "camera"];
        if (caps.folders === true) {
            fields.push("folder");
        }
        if (caps.file_names === true) {
            fields.push("file");
        }
        var rows = [];
        SearchCore.SYNTAX.forEach(function (row) {
            var field = row.example.split(":")[0];
            if (field === "lib" || (field === "place" && caps.places !== true)) {
                return;
            }
            if (field === "tag") {
                row = {example: row.example, meaning: "a word in one field: " +
                       fields.join(", ")};
            } else if (field === "type") {
                row = {example: "type:photo", meaning: "a kind of picture: photo, artwork, " +
                       "diagram, receipt, menu, ..."};
            } else if (field === "has" && caps.map !== true) {
                row = {example: row.example, meaning: "with text, people, animals, ..."};
            } else if (field === "is") {
                row = {example: row.example, meaning: "360\u00b0 photos; also is:duplicate"};
            }
            rows.push(row);
        });
        return rows;
    }

    function setupSyntaxHelp() {
        var button = byId("syntax-button");
        var box = byId("syntax-help");
        box.appendChild(el("h2", {text: "Search tips"}));
        var table = el("table", {className: "syntax-table"});
        syntaxRows().forEach(function (row) {
            var example = el("button", {type: "button", className: "syntax-example", text: row.example,
                                        title: "Search for " + row.example});
            example.addEventListener("click", function () {
                close();
                setQuery(row.example);
                input.focus();
            });
            table.appendChild(el("tr", null, [el("td", null, [example]),
                                             el("td", {text: row.meaning})]));
        });
        box.appendChild(table);
        box.appendChild(el("p", {className: "syntax-foot",
                                 text: "Words also find their plurals; while you type, the last " +
                                       "word also finds longer words that start with it (sunse " +
                                       "finds sunset). Small words like \u201cthe\u201d, " +
                                       "\u201cmy\u201d or \u201cpictures of\u201d are skipped. " +
                                       "Accents and capitals do not matter. Press / to jump to " +
                                       "the search box."}));
        function close() {
            box.hidden = true;
            button.setAttribute("aria-expanded", "false");
        }
        button.addEventListener("click", function () {
            var open = box.hidden;
            box.hidden = !open;
            button.setAttribute("aria-expanded", open ? "true" : "false");
        });
        document.addEventListener("click", function (event) {
            if (!box.hidden && !box.contains(event.target) && event.target !== button) {
                close();
            }
        });
        // Esc closes the tips wherever the focus is (usually still on the
        // "?" button), before anything else hears it (the search box would
        // clear, selection mode would end).
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !box.hidden && !VIEWER.isOpen()) {
                event.preventDefault();
                event.stopPropagation();
                close();
                button.focus();
            }
        }, true);
    }

    /* ---------- Facet sidebar ---------------------------------------------------- */

    var facetMore = {};         // group -> true when all values are shown

    function closedFacets() {
        try {
            return JSON.parse(SHELL.storageGet(FACETS_CLOSED_KEY) || "[]") || [];
        } catch (error) {
            return [];
        }
    }

    function isNarrow() {
        return window.innerWidth < NARROW;
    }

    // Phones: the sort, grouping, size and select tools live in the filter
    // drawer, so the search box comes first and the pictures start high.
    function isPhone() {
        return window.innerWidth < PHONE;
    }

    function drawerOpen() {
        return isNarrow() && facetsBox.classList.contains("is-open");
    }

    // What the open drawer covers: kept from the keyboard and screen readers.
    var COVERED = ["shell-header", "search-bar", "index-banner", "results"];

    // Set by setupSidebar: close the drawer and give the focus back to the
    // Filters button (every way of closing it ends here).
    var closeDrawer = function () {};

    function setupSidebar() {
        var button = byId("facets-button");
        var backdrop = byId("facets-backdrop");
        var tools = byId("search-tools");
        var toolsHome = byId("search-bar");
        var toolsInDrawer = byId("drawer-tools");
        function placeTools() {
            var phone = isPhone();
            if (phone && tools.parentNode !== toolsInDrawer) {
                toolsInDrawer.appendChild(tools);
            } else if (!phone && tools.parentNode !== toolsHome) {
                toolsHome.appendChild(tools);
            }
            toolsInDrawer.hidden = !phone;
        }
        function sync() {
            var open;
            placeTools();
            if (isNarrow()) {
                open = facetsBox.classList.contains("is-open");
                document.body.classList.remove("facets-collapsed");
                backdrop.hidden = !open;
            } else {
                open = SHELL.storageGet(SIDEBAR_KEY) !== "0";
                facetsBox.classList.remove("is-open");
                document.body.classList.toggle("facets-collapsed", !open);
                backdrop.hidden = true;
            }
            var modal = isNarrow() && open;
            if (modal) {
                facetsBox.setAttribute("role", "dialog");
                facetsBox.setAttribute("aria-modal", "true");
            } else {
                facetsBox.removeAttribute("role");
                facetsBox.removeAttribute("aria-modal");
            }
            COVERED.forEach(function (id) {
                var node = byId(id);
                if (node) {
                    node.inert = modal;
                    if (modal) {
                        node.setAttribute("aria-hidden", "true");
                    } else {
                        node.removeAttribute("aria-hidden");
                    }
                }
            });
            document.documentElement.classList.toggle("drawer-open", modal);
            button.setAttribute("aria-expanded", open ? "true" : "false");
        }
        function openDrawer() {
            facetsBox.classList.add("is-open");
            sync();
            byId("facets-close").focus();
        }
        closeDrawer = function () {
            if (facetsBox.classList.contains("is-open")) {
                facetsBox.classList.remove("is-open");
                sync();
                button.focus();
            }
        };
        button.addEventListener("click", function () {
            if (isNarrow()) {
                if (facetsBox.classList.contains("is-open")) {
                    closeDrawer();
                } else {
                    openDrawer();
                }
            } else {
                SHELL.storageSet(SIDEBAR_KEY, document.body.classList.contains("facets-collapsed")
                    ? "" : "0");
                sync();
            }
            relayout(true);
        });
        byId("facets-close").addEventListener("click", function () {
            if (isNarrow()) {
                closeDrawer();
            } else {
                SHELL.storageSet(SIDEBAR_KEY, "0");
                sync();
                relayout(true);
            }
        });
        byId("facets-done").addEventListener("click", closeDrawer);
        backdrop.addEventListener("click", closeDrawer);
        facetsBox.addEventListener("keydown", function (event) {
            if (!drawerOpen()) {
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeDrawer();
            } else if (event.key === "Tab") {
                trapTab(event, facetsBox);
            }
        });
        var lastWidth = window.innerWidth;
        window.addEventListener("resize", function () {
            // (A phone's keyboard changes the height only: leave the drawer.)
            if (window.innerWidth !== lastWidth) {
                lastWidth = window.innerWidth;
                sync();
            }
        });
        sync();
    }

    // Keep Tab and Shift-Tab inside box.
    function trapTab(event, box) {
        var focusable = Array.prototype.filter.call(
            box.querySelectorAll("button, a[href], input, select, textarea, [tabindex]"),
            function (node) {
                return !node.disabled && node.tabIndex >= 0 && node.offsetParent !== null;
            });
        if (!focusable.length) {
            return;
        }
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last ||
                                       !box.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    }

    function facetValueLabel(group, value) {
        if (group === "library") {
            return data.names[value] || value;
        }
        return SearchCore.facetLabel(group, value);
    }

    function cssColor(value) {
        try {
            return window.CSS && CSS.supports && CSS.supports("color", value) ? value : "";
        } catch (error) {
            return "";
        }
    }

    function facetButton(group, entry) {
        var label = facetValueLabel(group, entry.value);
        // (A place holding the chosen one is half chosen: "mixed".)
        var open = group === "place" && entry.open && !entry.selected;
        var button = el("button", {type: "button", className: "facet-value" +
                                   (entry.selected ? " is-selected" : "") +
                                   (open ? " is-open" : "") +
                                   (entry.level ? " facet-level-" + entry.level : ""),
                                   attrs: {"aria-pressed": entry.selected ? "true"
                                               : open ? "mixed" : "false",
                                           "data-key": "value:" + group + ":" + entry.value}});
        if (group === "place") {
            button.title = SearchCore.placeLabel(entry.value);
        }
        button.appendChild(el("span", {className: "facet-check", attrs: {"aria-hidden": "true"}}));
        if (group === "colors" && cssColor(entry.value)) {
            var swatch = el("span", {className: "facet-swatch", attrs: {"aria-hidden": "true"}});
            swatch.style.backgroundColor = cssColor(entry.value);
            button.appendChild(swatch);
        }
        button.appendChild(el("span", {className: "facet-label", text: label}));
        button.appendChild(el("span", {className: "facet-count", text: fmt.number(entry.count)}));
        button.addEventListener("click", function () {
            toggleFilter(group, entry.value);
        });
        return button;
    }

    function optionSwitch(label, checked, onChange, hint) {
        var box = el("input", {type: "checkbox", checked: checked,
                               attrs: {"data-key": "option:" + label}});
        box.addEventListener("change", function () {
            onChange(box.checked);
        });
        return el("label", {className: "facet-option", title: hint || ""}, [box, el("span", {text: label})]);
    }

    // The sidebar is drawn again after every change; a control that had the
    // keyboard focus gets it back (found by its data-key).
    function renderFacets() {
        var focused = facetList.contains(document.activeElement)
            ? document.activeElement.getAttribute("data-key") : null;
        drawFacets();
        if (focused) {
            var again = null;
            Array.prototype.some.call(facetList.querySelectorAll("[data-key]"), function (node) {
                if (node.getAttribute("data-key") === focused) {
                    again = node;
                    return true;
                }
                return false;
            });
            (again || byId("facets-close")).focus({preventScroll: true});
        }
    }

    function libraryList() {
        var list = (SITE.libraryList || []).length ? SITE.libraryList : data.libraries;
        return (list || []).filter(function (library) {
            return library && library.id;
        });
    }

    /* The libraries, as a choice of one (or all): the same choice as the
       header's library menu (SHELL.setLibrary), which phones do not show.
       Counts are known for every library while all are searched. */
    function librarySection(closed) {
        var libraries = libraryList();
        if (libraries.length < 2) {
            return null;
        }
        var current = SHELL.library() || "";
        var counts = {};
        (result.facets.library || []).forEach(function (entry) {
            counts[entry.value] = entry.count;
        });
        var isClosed = closed.indexOf("library") >= 0;
        var section = el("section", {className: "facet facet-library" + (isClosed ? " is-closed" : "")});
        var toggle = el("button", {type: "button", className: "facet-title",
                                   attrs: {"aria-expanded": isClosed ? "false" : "true",
                                           "data-key": "group:library"}},
                        [el("span", {text: "Library"})]);
        toggle.addEventListener("click", function () {
            toggleClosed("library", section, toggle);
        });
        section.appendChild(el("h3", null, [toggle]));
        var list = el("ul", {className: "facet-values", attrs: {"aria-label": "Library"}});
        [{id: "", name: "All libraries"}].concat(libraries).forEach(function (library) {
            var chosen = library.id === current;
            var count = library.id === "" ? (current ? null : result.total)
                : chosen ? result.total : current ? null : counts[library.id] || 0;
            var choice = el("button", {type: "button", className: "facet-value facet-radio" +
                                       (chosen ? " is-selected" : ""),
                                       attrs: {"aria-pressed": chosen ? "true" : "false",
                                               "data-key": "library:" + library.id}});
            choice.appendChild(el("span", {className: "facet-check", attrs: {"aria-hidden": "true"}}));
            choice.appendChild(el("span", {className: "facet-label", text: library.name || library.id}));
            if (count !== null) {
                choice.appendChild(el("span", {className: "facet-count", text: fmt.number(count)}));
            }
            choice.addEventListener("click", function () {
                if (!chosen) {
                    SHELL.setLibrary(library.id);
                }
            });
            list.appendChild(el("li", null, [choice]));
        });
        section.appendChild(list);
        return section;
    }

    function toggleClosed(group, section, toggle) {
        var list = closedFacets().filter(function (key) {
            return key !== group;
        });
        if (!section.classList.contains("is-closed")) {
            list.push(group);
        }
        SHELL.storageSet(FACETS_CLOSED_KEY, list.length ? JSON.stringify(list) : "");
        section.classList.toggle("is-closed");
        toggle.setAttribute("aria-expanded",
                            section.classList.contains("is-closed") ? "false" : "true");
    }

    function drawFacets() {
        clear(facetList);
        var closed = closedFacets();
        var options = el("section", {className: "facet facet-options"});
        options.appendChild(el("h3", {className: "facet-title", text: "Options"}));
        options.appendChild(optionSwitch("Hide blurry and accidental shots", state.junk,
                                         function (on) {
                                             state.junk = on;
                                             changed();
                                         }));
        options.appendChild(optionSwitch("Hide sensitive pictures", state.sensitive !== "show",
                                         function (on) {
                                             state.sensitive = on ? "" : "show";
                                             changed();
                                         }, "Pictures marked explicit or graphic"));
        if (adminOn) {
            options.appendChild(optionSwitch("Show hidden pictures", state.hidden, function (on) {
                state.hidden = on;
                changed();
            }));
        }
        facetList.appendChild(options);
        var libraries = librarySection(closed);
        if (libraries) {
            facetList.appendChild(libraries);
        }
        SearchCore.FACETS.forEach(function (facet) {
            var group = facet.key;
            // (Libraries are the section above; a library= filter from an
            // older link still shows as a chip that can be removed.)
            if (group === "library") {
                return;
            }
            var entries = result.facets[group] || [];
            if (!entries.length) {
                return;
            }
            var isClosed = closed.indexOf(group) >= 0;
            var section = el("section", {className: "facet" + (isClosed ? " is-closed" : "")});
            var chosen = entries.filter(function (entry) {
                return entry.selected;
            }).length;
            var toggle = el("button", {type: "button", className: "facet-title",
                                       attrs: {"aria-expanded": isClosed ? "false" : "true",
                                               "data-key": "group:" + group}}, [
                el("span", {text: facet.label}),
                chosen ? el("span", {className: "count-badge", text: String(chosen)}) : null
            ]);
            toggle.addEventListener("click", function () {
                toggleClosed(group, section, toggle);
            });
            section.appendChild(el("h3", null, [toggle]));
            var list = el("ul", {className: "facet-values"});
            var limit = facetMore[group] ? entries.length : FACET_SHOWN;
            // (Places: the limit counts countries; the regions and towns of
            // a chosen one are all listed under it.)
            var counted = 0;
            entries.forEach(function (entry) {
                var first = !entry.level;
                if (first) {
                    counted += 1;
                }
                if (!first || counted <= limit || entry.selected || entry.open) {
                    list.appendChild(el("li", null, [facetButton(group, entry)]));
                }
            });
            section.appendChild(list);
            if (counted > FACET_SHOWN) {
                var more = el("button", {type: "button", className: "facet-more",
                                         attrs: {"data-key": "more:" + group},
                                         text: facetMore[group] ? "Show fewer"
                                             : "Show " + (counted - FACET_SHOWN) + " more"});
                more.addEventListener("click", function () {
                    facetMore[group] = !facetMore[group];
                    renderFacets();
                });
                section.appendChild(more);
            }
            facetList.appendChild(section);
        });
    }

    /* ---------- Results header, chips, banner ------------------------------------ */

    function located() {
        var count = 0;
        display.forEach(function (entry) {
            (entry.stack && !expanded[entry.id] ? entry.stack : [entry.id]).forEach(function (id) {
                var rec = record(id);
                if (rec && rec.gp) {
                    count += 1;
                }
            });
        });
        return count;
    }

    // The parse() result's on:today filter (this day in earlier years), or null.
    function onThisDay() {
        var terms = result && result.query ? result.query.terms : [];
        for (var k = 0; k < terms.length; k++) {
            var filter = terms[k].filter;
            if (terms[k].active && !terms[k].neg && filter && filter.kind === "on" &&
                    filter.today) {
                return filter;
            }
        }
        return null;
    }

    // "October 11": today's month and day.
    function todayText() {
        var now = new Date();
        return SearchCore.dateLabel("2000-" + ("0" + (now.getMonth() + 1)).slice(-2) + "-" +
                                    ("0" + now.getDate()).slice(-2)).replace(/, \d{4}$/, "");
    }

    function renderHead() {
        byId("result-count").textContent = fmt.plural(result.total, "picture");
        // A note is its text, or [text, a short form for narrow screens].
        var notes = [];
        if (onThisDay() && result.total) {
            var today = todayText();
            notes.push(["taken on " + today + " in earlier years",
                        today.slice(0, 3) + today.slice(today.indexOf(" "))]);
        }
        if (result.collapsed) {
            notes.push(fmt.plural(result.collapsed, "duplicate") + " grouped");
        }
        var noteBox = byId("result-notes");
        clear(noteBox);
        notes.forEach(function (note) {
            noteBox.appendChild(document.createTextNode("\u00b7 "));
            if (typeof note === "string") {
                noteBox.appendChild(document.createTextNode(note + " "));
                return;
            }
            noteBox.appendChild(el("span", {className: "note-long", text: note[0] + " "}));
            noteBox.appendChild(el("span", {className: "note-short", text: note[1] + " ",
                                            title: note[0]}));
        });
        var queryNotes = byId("query-notes");
        var warnings = (result.warnings || []).slice();
        if (droppedPicks) {
            warnings.push("The pictures picked on the map could not be found any more (the " +
                          "pictures have changed since): showing the whole search.");
        }
        queryNotes.textContent = warnings.join(" ");
        queryNotes.hidden = !warnings.length;
        byId("surprise-button").hidden = !display.length;
        var mapLink = byId("map-link");
        var mapUrl = SITE.mapUrl ? SITE.mapUrl(linkState()) : null;
        if (mapUrl && state.ids) {
            // Here with the pictures of a pin: back to the map, as it was.
            mapLink.hidden = false;
            mapLink.href = mapUrl;
            clear(mapLink);
            mapLink.appendChild(el("span", {text: "Back to the map"}));
            return finishHead();
        }
        var count = mapUrl && result.total ? located() : 0;
        mapLink.hidden = !count;
        if (count) {
            mapLink.href = mapUrl;
            clear(mapLink);
            // (The short wording on phones, where it shares the line.)
            mapLink.appendChild(el("span", {className: "wide-only",
                                            text: count === result.total && count > 1
                                                ? "Show them on the map"
                                                : "Show " + fmt.plural(count, "located picture") +
                                                  " on the map"}));
            mapLink.appendChild(el("span", {className: "narrow-only",
                                            text: fmt.number(count) + " on the map"}));
        }
        finishHead();
    }

    function finishHead() {
        byId("facets-done").textContent = result.total
            ? "Show " + fmt.plural(result.total, "picture") : "No pictures match";
    }

    /* "Back to the map" right after coming from it goes back in the
       history: the map is then shown as it was left (its list open). The
       map's "Show these in the grid" leaves this page's address in
       sessionStorage (FROM_MAP_KEY, see map.js): pages opened from disk
       have no referrer. */
    var FROM_MAP_KEY = "searchImages.fromMap";

    function openedFromMap() {
        try {
            var url = window.sessionStorage.getItem(FROM_MAP_KEY);
            if (url === null) {
                return false;
            }
            window.sessionStorage.removeItem(FROM_MAP_KEY);
            return url === window.location.href;
        } catch (error) {
            return false;
        }
    }

    var arrival = {referrer: document.referrer, fromMap: openedFromMap(), query: null};

    function cameFromMap() {
        if (arrival.fromMap) {
            return true;
        }
        if (!arrival.referrer) {
            return false;
        }
        try {
            return new URL(arrival.referrer).pathname ===
                new URL(SITE.mapUrl({}), window.location.href).pathname;
        } catch (error) {
            return false;
        }
    }

    function setupMapLink() {
        byId("map-link").addEventListener("click", function (event) {
            if (!state.ids || event.button !== 0 || event.ctrlKey || event.metaKey ||
                    event.shiftKey || event.altKey ||
                    SITE.searchState.params(urlState()) !== arrival.query ||
                    window.history.length < 2 || !cameFromMap()) {
                return;
            }
            event.preventDefault();
            window.history.back();
        });
    }

    function chipButton(text, onRemove, title) {
        var button = el("button", {type: "button", className: "filter-chip", title: title || "Remove"},
                        [el("span", {text: text}),
                         el("span", {className: "filter-chip-x", text: "\u00d7", attrs: {"aria-hidden": "true"}})]);
        button.setAttribute("aria-label", text + ": remove");
        button.addEventListener("click", onRemove);
        return button;
    }

    function renderChips() {
        var box = byId("active-filters");
        clear(box);
        var chips = [];
        var library = SHELL.library();
        if (library && data.names[library] && (SITE.libraryList || []).length > 1) {
            chips.push(chipButton("Library: " + data.names[library], function () {
                SHELL.setLibrary("");
            }));
        }
        if (state.from || state.to) {
            chips.push(chipButton("Taken: " + SearchCore.rangeLabel(state.from, state.to),
                                  function () {
                                      setRange("", "");
                                  }, "Show every date again"));
        }
        SearchCore.FACETS.forEach(function (facet) {
            (state.filters[facet.key] || []).forEach(function (value) {
                chips.push(chipButton(facet.label + ": " + filterLabel(facet.key, value),
                                      function () {
                                          removeFilter(facet.key, value);
                                      }));
            });
        });
        if (state.junk) {
            chips.push(chipButton("Hiding blurry and accidental shots", function () {
                state.junk = false;
                changed();
            }));
        }
        if (state.sensitive === "show") {
            chips.push(chipButton("Showing sensitive pictures", function () {
                state.sensitive = "";
                changed();
            }));
        } else if (state.sensitive === "strict") {
            chips.push(chipButton("Hiding suggestive pictures too", function () {
                state.sensitive = "";
                changed();
            }));
        }
        if (state.hidden) {
            chips.push(chipButton("Showing hidden pictures", function () {
                state.hidden = false;
                changed();
            }));
        }
        var chosen = picked();
        if (chosen && !chosen.stale) {
            // (The pictures that are still there and shown, as the grid
            // shows them: one removed since the link was made, hidden
            // while hidden pictures are not shown, or in another library
            // than the one picked is not counted.)
            var shown = visibility();
            var pickedCount = chosen.ids.filter(function (id) {
                var rec = record(id);
                return rec !== null && !(rec.h && !shown.hidden) &&
                    !(shown.library && rec.l !== shown.library);
            }).length;
            chips.push(chipButton("Picked on the map: " + fmt.plural(pickedCount, "picture"),
                                  function () {
                                      state.ids = "";
                                      changed();
                                  }, "Show the whole search again"));
        }
        chips.forEach(function (chip) {
            box.appendChild(chip);
        });
        if (chips.length > 1) {
            var all = el("button", {type: "button", className: "button subtle small", text: "Clear all"});
            all.addEventListener("click", function () {
                if (library) {
                    SHELL.setLibrary("");
                }
                clearFilters();
            });
            box.appendChild(all);
        }
        box.hidden = !chips.length;
    }

    function isAre(count) {
        return count === 1 ? "is" : "are";
    }

    function scopeCounts() {
        var options = visibility();
        var library = options.library;
        var total = 0;
        var undescribed = 0;
        data.records.forEach(function (rec) {
            if ((library && rec.l !== library) || (rec.h && !options.hidden)) {
                return;
            }
            total += 1;
            if (!rec.ds) {
                undescribed += 1;
            }
        });
        return {total: total, undescribed: undescribed};
    }

    function renderBanner() {
        var banner = byId("index-banner");
        clear(banner);
        var counts = scopeCounts();
        var dismissed = false;
        try {
            dismissed = window.sessionStorage.getItem(BANNER_KEY) === String(counts.undescribed);
        } catch (error) {
            dismissed = false;
        }
        if (!serverMode || !counts.undescribed || !counts.total || dismissed) {
            banner.hidden = true;
            return;
        }
        var text;
        var short;
        if (counts.undescribed === counts.total) {
            text = (counts.total === 1 ? "The picture is not described yet, so "
                : "None of the " + fmt.plural(counts.total, "picture") + " are described yet, so ") +
                "searches only look at file names, dates and cameras.";
            short = counts.total === 1 ? "Not described yet" : "None described yet";
        } else {
            text = fmt.number(counts.undescribed) + " of " + fmt.plural(counts.total, "picture") +
                " " + isAre(counts.undescribed) + " not described yet; results are incomplete.";
            short = fmt.number(counts.undescribed) + " of " + fmt.number(counts.total) +
                " not described yet";
        }
        // (Phones show the short text: one line.)
        banner.appendChild(el("span", {className: "notice-text"}, [
            el("span", {className: "wide-only", text: text}),
            el("span", {className: "narrow-only", text: short})
        ]));
        if (adminOn) {
            banner.appendChild(el("a", {className: "button", href: "/manage"}, [
                el("span", {className: "wide-only", text: "Describe them on the Manage page"}),
                el("span", {className: "narrow-only", text: "Describe"})
            ]));
        }
        var close = el("button", {type: "button", className: "icon-button", text: "\u00d7",
                                  attrs: {"aria-label": "Hide this note"}});
        close.addEventListener("click", function () {
            try {
                window.sessionStorage.setItem(BANNER_KEY, String(counts.undescribed));
            } catch (error) {
                // Shown again next time.
            }
            banner.hidden = true;
            relayout(true);
        });
        banner.appendChild(close);
        banner.hidden = false;
    }

    /* ---------- Timeline ---------------------------------------------------------- */

    /* How many of the results were taken each year, or each month of the
       one year (each day of the one month) they are in (SearchCore's
       timeline). Each bar is a button: choosing one shows only its year
       (month, day) -- state.from/to, the "Taken" chip -- and the timeline
       then shows its months (days). Dragging across bars chooses them all;
       so does Shift with a click or Enter on two bars: the first marks
       where the range starts (Esc forgets it), the second chooses the bars
       from there (after a choice, from the bar last chosen when it is
       still shown). "Zoom out" widens the dates again; Back goes back.
       The arrow keys, Home and End move between the bars that have
       pictures. */
    var timelineAnchor = "";        // the bar a Shift choice starts from
    var anchorScope = "";           // the search it was chosen in (searchScope)
    var anchorPending = false;      // true: no range from it was chosen yet
    var timelineFocus = "";         // the bar the Tab key reaches
    var timelineDrag = null;        // {pointer, start, end, shift, x} while dragging
    var timelineWidth = -1;         // the width the labels were laid out for

    // What the results depend on but their dates: an anchor chosen in
    // another search is forgotten.
    function searchScope() {
        return JSON.stringify([state.q, SHELL.library() || "", state.filters, state.ids || "",
                               state.hidden, state.junk, state.sensitive]);
    }

    function setAnchor(key, pending) {
        timelineAnchor = key || "";
        anchorScope = searchScope();
        anchorPending = Boolean(key) && pending === true;
    }

    // The anchor of this search ("" when there is none).
    function currentAnchor() {
        return timelineAnchor && anchorScope === searchScope() ? timelineAnchor : "";
    }

    function timelineClosed() {
        return SHELL.storageGet(TIMELINE_KEY) === "1";
    }

    // The dates chosen in words ("in May 2019", "since 2019").
    function rangeText() {
        var text = SearchCore.rangeLabel(state.from, state.to);
        return /^(since|until) /.test(text) ? text : "in " + text;
    }

    // A bar's name: "2019", "May 2019", "May 14, 2019".
    function barName(key) {
        return SearchCore.dateLabel(key);
    }

    // What is written under a bar: "2019", "May", "14".
    function barText(level, key) {
        if (level === "year") {
            return key;
        }
        if (level === "month") {
            return SearchCore.dateLabel(key).slice(0, 3);
        }
        return String(Number(key.slice(8, 10)));
    }

    function timelineSummary(line) {
        var bars = line.bars;
        var text = line.level === "year"
            ? "By year, " + bars[0].key + " to " + bars[bars.length - 1].key
            : line.level === "month" ? "By month, " + bars[0].key.slice(0, 4)
                : "By day, " + SearchCore.dateLabel(bars[0].key.slice(0, 7));
        if (line.undated) {
            text += " \u00b7 " + fmt.number(line.undated) + " without a date";
        }
        return text;
    }

    // The chosen dates one step wider: days -> their months, months ->
    // their years, years -> every date (null).
    function widerRange(from, to) {
        var length = Math.max((from || "").length, (to || "").length);
        if (!from || !to || length <= 4) {
            return null;
        }
        var cut = length === 10 ? 7 : 4;
        return {from: from.slice(0, cut), to: to.slice(0, cut)};
    }

    function setRange(from, to) {
        from = from || "";
        to = to || "";
        anchorPending = false;
        if (!from && !to) {
            setAnchor("");
        }
        if (from === state.from && to === state.to) {
            // (The same dates: no history entry that Back would only repeat.)
            renderTimeline();
            return;
        }
        state.from = from;
        state.to = to;
        // A new history entry: Back shows the dates before.
        changed({push: true});
    }

    // Choose bar at of the timeline; extend: Shift (see SearchCore.timelineChoice).
    function chooseBar(at, extend) {
        var bars = result.timeline.bars;
        var choice = SearchCore.timelineChoice(bars, at, extend,
                                               {anchor: currentAnchor(), pending: anchorPending});
        if (!choice) {
            return;
        }
        timelineFocus = bars[at].key;
        setAnchor(choice.anchor, choice.pending);
        if (choice.pending) {
            renderTimeline();
        } else {
            setRange(choice.from, choice.to);
        }
    }

    // The place of the bar under a point (x on the screen) in the bars.
    // finger: a finger is wider than a day's bar on a phone, so a touch on
    // a bar without pictures takes the nearest one with pictures that the
    // finger also touched (within FINGER pixels).
    var FINGER = 12;
    function barAt(box, x, finger) {
        var nodes = box.children;
        var at = -1;
        var k;
        for (k = 0; k < nodes.length; k++) {
            if (x < nodes[k].getBoundingClientRect().right || k === nodes.length - 1) {
                at = k;
                break;
            }
        }
        if (at < 0 || !finger || nodes[at].getAttribute("aria-disabled") !== "true") {
            return at;
        }
        var best = at;
        var gap = FINGER + 1;
        for (k = Math.max(0, at - 3); k <= Math.min(nodes.length - 1, at + 3); k++) {
            if (nodes[k].getAttribute("aria-disabled") !== "true") {
                var rect = nodes[k].getBoundingClientRect();
                var away = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
                if (away < gap) {
                    gap = away;
                    best = k;
                }
            }
        }
        return best;
    }

    function markDrag(box) {
        var drag = timelineDrag;
        Array.prototype.forEach.call(box.children, function (node, at) {
            node.classList.toggle("is-dragged", Boolean(drag) &&
                                  at >= Math.min(drag.start, drag.end) &&
                                  at <= Math.max(drag.start, drag.end));
        });
    }

    function moveBarFocus(box, from, step) {
        var nodes = box.children;
        for (var at = from + step; at >= 0 && at < nodes.length; at += step) {
            if (nodes[at].getAttribute("aria-disabled") !== "true") {
                Array.prototype.forEach.call(nodes, function (node) {
                    node.tabIndex = -1;
                });
                nodes[at].tabIndex = 0;
                nodes[at].focus();
                timelineFocus = nodes[at].getAttribute("data-key");
                return;
            }
        }
    }

    function timelineBars(line) {
        var max = 1;
        line.bars.forEach(function (bar) {
            max = Math.max(max, bar.count);
        });
        var chosen = state.from || state.to ? {from: state.from, to: state.to} : null;
        var start = anchorPending ? currentAnchor() : "";
        var box = el("div", {id: "timeline-bars", className: "timeline-bars level-" + line.level,
                             attrs: {role: "group",
                                     "aria-label": "Pictures per " + line.level + ". Choose a " +
                                         line.level + " to show only its pictures. To choose " +
                                         "several, drag across them, or hold Shift and choose " +
                                         "the first, then the last."}});
        // Where the Tab key lands: the bar last moved to, else the newest
        // one with pictures.
        var keys = line.bars.filter(function (bar) {
            return bar.count > 0;
        }).map(function (bar) {
            return bar.key;
        });
        var focusKey = keys.indexOf(timelineFocus) >= 0 ? timelineFocus
            : keys[keys.length - 1] || "";
        // Labels under the bars: as many as there is room for (laid out
        // again when the width changes, see the resize handler).
        timelineWidth = byId("results").clientWidth;
        var room = Math.max(1, (timelineWidth || 600) - 24);
        var wide = line.level === "year" ? 40 : line.level === "month" ? 30 : 22;
        var every = Math.max(1, Math.ceil(line.bars.length / Math.max(1, Math.floor(room / wide))));
        if (line.level === "day" && every > 1) {
            every = every <= 2 ? 2 : every <= 5 ? 5 : 10;
        }
        // (Bars are marked as chosen when the dates were chosen at their
        // level: a month chosen among the months, not the year of them all.)
        var level = line.bars.length ? line.bars[0].key.length : 0;
        if (chosen && (chosen.from || chosen.to).length !== level) {
            chosen = null;
        }
        line.bars.forEach(function (bar, index) {
            var inside = chosen !== null && (!chosen.from || bar.key >= chosen.from) &&
                (!chosen.to || bar.key <= chosen.to);
            var name = barName(bar.key) + ": " + fmt.plural(bar.count, "picture");
            var first = bar.key === start;
            var node = el("button", {type: "button", className: "timeline-bar" +
                                     (bar.count ? "" : " is-empty") + (inside ? " is-chosen" : "") +
                                     (first ? " is-anchor" : ""),
                                     title: name, tabIndex: bar.key === focusKey ? 0 : -1,
                                     attrs: {"data-key": bar.key,
                                             "aria-label": first ? name + ". The range starts " +
                                                 "here: hold Shift and choose where it ends."
                                                 : name,
                                             "aria-current": inside ? "true" : null,
                                             "aria-disabled": bar.count ? null : "true"}});
            var fill = el("span", {className: "timeline-fill"});
            fill.style.height = bar.count ? Math.max(8, Math.round(100 * bar.count / max)) + "%"
                : "0";
            node.appendChild(el("span", {className: "timeline-track",
                                         attrs: {"aria-hidden": "true"}}, [fill]));
            var number = line.level === "day" ? index + 1 : index;
            node.appendChild(el("span", {className: "timeline-label", attrs: {"aria-hidden": "true"},
                                         text: (line.level === "day" ? number === 1 ||
                                                number % every === 0 : index % every === 0)
                                             ? barText(line.level, bar.key) : ""}));
            box.appendChild(node);
        });
        box.addEventListener("click", function (event) {
            var node = event.target.closest ? event.target.closest(".timeline-bar") : null;
            // (Pointers choose on pointerup; this is Enter or Space.)
            if (node && event.detail === 0) {
                chooseBar(Array.prototype.indexOf.call(box.children, node), event.shiftKey);
            }
        });
        box.addEventListener("keydown", function (event) {
            var node = event.target.closest ? event.target.closest(".timeline-bar") : null;
            if (!node) {
                return;
            }
            var at = Array.prototype.indexOf.call(box.children, node);
            var moves = {ArrowLeft: [at, -1], ArrowRight: [at, 1], Home: [-1, 1],
                         End: [box.children.length, -1]};
            if (moves[event.key]) {
                event.preventDefault();
                moveBarFocus(box, moves[event.key][0], moves[event.key][1]);
            } else if (event.key === "Enter" && event.shiftKey) {
                // (Shift+Enter does not click a button.)
                event.preventDefault();
                chooseBar(at, true);
            } else if (event.key === "Escape" && anchorPending) {
                // Forget where a range was to start.
                event.preventDefault();
                event.stopPropagation();
                setAnchor("");
                renderTimeline();
            }
        });
        box.addEventListener("pointerdown", function (event) {
            if (event.button !== 0 || !event.isPrimary) {
                return;
            }
            var at = barAt(box, event.clientX, event.pointerType === "touch");
            if (at < 0) {
                return;
            }
            timelineDrag = {pointer: event.pointerId, start: at, end: at, shift: event.shiftKey,
                            x: event.clientX};
            try {
                box.setPointerCapture(event.pointerId);
            } catch (error) {
                // The drag still works while the pointer stays over the bars.
            }
            markDrag(box);
        });
        box.addEventListener("pointermove", function (event) {
            // (A finger that only trembles is no drag.)
            if (timelineDrag && event.pointerId === timelineDrag.pointer &&
                    Math.abs(event.clientX - timelineDrag.x) >= FINGER / 2) {
                var at = barAt(box, event.clientX);
                if (at >= 0 && at !== timelineDrag.end) {
                    timelineDrag.end = at;
                    markDrag(box);
                }
            }
        });
        box.addEventListener("pointerup", function (event) {
            var drag = timelineDrag;
            if (!drag || event.pointerId !== drag.pointer) {
                return;
            }
            timelineDrag = null;
            markDrag(box);
            if (drag.start === drag.end) {
                chooseBar(drag.start, drag.shift || event.shiftKey);
            } else {
                var low = Math.min(drag.start, drag.end);
                var high = Math.max(drag.start, drag.end);
                timelineFocus = line.bars[drag.end].key;
                setAnchor(line.bars[drag.start].key);
                setRange(line.bars[low].key, line.bars[high].key);
            }
        });
        box.addEventListener("pointercancel", function () {
            timelineDrag = null;
            markDrag(box);
        });
        return box;
    }

    function renderTimeline() {
        var box = byId("timeline");
        var line = result && result.timeline;
        // (Drawn again after a choice: the keyboard focus stays in it.)
        var focused = box.contains(document.activeElement)
            ? document.activeElement.className : "";
        clear(box);
        if (!line || !line.level || !result.total) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        var closed = timelineClosed();
        box.classList.toggle("is-closed", closed);
        var head = el("div", {className: "timeline-head"});
        var toggle = el("button", {type: "button", className: "timeline-toggle",
                                   attrs: {"aria-expanded": closed ? "false" : "true",
                                           "aria-controls": closed ? null : "timeline-bars"}},
                        [el("span", {text: "Timeline"})]);
        toggle.addEventListener("click", function () {
            SHELL.storageSet(TIMELINE_KEY, timelineClosed() ? "" : "1");
            renderTimeline();
            relayout(true);
        });
        head.appendChild(toggle);
        head.appendChild(el("span", {className: "timeline-summary", text: timelineSummary(line)}));
        var start = anchorPending && !closed ? currentAnchor() : "";
        if (start) {
            head.appendChild(el("span", {className: "timeline-hint",
                                         text: "From " + barName(start) + ": Shift-choose where " +
                                             "it ends (Esc: cancel)"}));
        }
        if (state.from || state.to) {
            var wider = el("button", {type: "button", className: "button subtle small timeline-out",
                                      text: "Zoom out", title: "Show a longer stretch of time"});
            wider.addEventListener("click", function () {
                var range = widerRange(state.from, state.to);
                setRange(range ? range.from : "", range ? range.to : "");
            });
            head.appendChild(wider);
        }
        box.appendChild(head);
        if (!closed) {
            box.appendChild(timelineBars(line));
        }
        if (focused) {
            var again = /timeline-bar/.test(focused)
                ? box.querySelector(".timeline-bar[tabindex='0']")
                : box.querySelector(/timeline-out/.test(focused) ? ".timeline-out"
                    : ".timeline-toggle");
            (again || toggle).focus({preventScroll: true});
        }
    }

    /* ---------- Surprise me -------------------------------------------------------- */

    // Opens a picture of the results (a stack counts once) chosen at random.
    function surprise() {
        if (!display.length) {
            return;
        }
        var covers = [];
        display.forEach(function (entry, position) {
            if (!entry.member) {
                covers.push(position);
            }
        });
        var position = covers[Math.floor(Math.random() * covers.length)];
        if (VIEWER.isOpen()) {
            VIEWER.show(display[position].id);
            return;
        }
        openViewer(position, true);
    }

    /* ---------- Empty states ----------------------------------------------------- */

    function emptyBox(title, lines, actions) {
        var box = byId("empty");
        clear(box);
        box.appendChild(el("h2", {text: title}));
        (lines || []).forEach(function (line) {
            box.appendChild(typeof line === "string" ? el("p", {text: line}) : line);
        });
        if (actions && actions.length) {
            box.appendChild(el("div", {className: "empty-actions"}, actions));
        }
        box.hidden = false;
    }

    function actionLink(text, href, primary) {
        return el("a", {className: "button" + (primary ? " primary" : ""), href: href, text: text});
    }

    function actionButton(text, onClick, primary) {
        var button = el("button", {type: "button", className: "button" + (primary ? " primary" : ""),
                                   text: text});
        button.addEventListener("click", onClick);
        return button;
    }

    function renderEmpty() {
        var box = byId("empty");
        box.hidden = true;
        document.body.classList.remove("no-pictures");
        if (!data) {
            return;
        }
        if (!(SITE.libraryList || []).length && !SITE.isStatic) {
            document.body.classList.add("no-pictures");
            emptyBox("Add your first library",
                     ["A library is a folder of pictures. Once it has been scanned and described, " +
                      "you can search it by what is in the pictures."],
                     adminOn ? [actionLink("Add a library", "/manage?dialog=add", true)]
                         : ["Libraries are added on the computer that runs the server."]);
            return;
        }
        var counts = scopeCounts();
        if (!counts.total && !activeFilterCount() && !state.q) {
            document.body.classList.add("no-pictures");
        }
        if (!counts.total) {
            var library = SHELL.library();
            if (library) {
                emptyBox("No pictures in " + (data.names[library] || "this library") + " yet",
                         adminOn ? ["Scan it on the Manage page to add its pictures."] : [],
                         [adminOn ? actionLink("Open the Manage page", "/manage", true) : null,
                          actionButton("Search all libraries", function () {
                              SHELL.setLibrary("");
                          })]);
            } else if (SITE.isStatic) {
                emptyBox("This site has no pictures", [], []);
            } else {
                emptyBox("No pictures indexed yet",
                         adminOn ? ["Scan your libraries on the Manage page; pictures show up " +
                                    "here as soon as they are found."]
                             : ["The pictures have not been scanned yet."],
                         adminOn ? [actionLink("Open the Manage page", "/manage", true)] : []);
            }
            return;
        }
        if (result.total) {
            return;
        }
        var lines = [];
        var actions = [];
        // (When no filter or option is what leaves nothing, nothing was
        // taken on this day: say so, not "check the spelling".)
        if (onThisDay() && state.q.replace(/^\s+|\s+$/g, "") === "on:today" &&
                !(activeFilterCount() && emptyReasons().length)) {
            emptyBox("Nothing from this day",
                     ["No picture " + (SHELL.library() ? "in this library " : "") + "was " +
                      "taken on " + todayText() + " in an earlier year."],
                     [actionButton("Show all the pictures", function () {
                         setQuery("");
                     }, true)]);
            return;
        }
        // First say what took the matches away (filters, options, the
        // library); only when nothing matches anywhere suggest spelling.
        var reasons = emptyReasons();
        reasons.forEach(function (reason, index) {
            lines.push(reason.text);
            actions.push(actionButton(reason.label, reason.run, index === 0));
        });
        if (!reasons.length) {
            var suggestion = state.q ? SearchCore.suggest(data.index, state.q, searchOptions())
                : null;
            if (suggestion && suggestion.text && suggestion.text !== state.q) {
                var tryLink = el("a", {href: chipUrl("q", suggestion.text), text: suggestion.text});
                tryLink.addEventListener("click", function (event) {
                    event.preventDefault();
                    setQuery(suggestion.text);
                });
                lines.push(el("p", {className: "did-you-mean"}, ["Did you mean ", tryLink, "?"]));
            }
            if (state.q) {
                lines.push("Check the spelling, or try fewer or more general words.");
            }
            if (activeFilterCount()) {
                actions.push(actionButton("Remove the filters", clearFilters, true));
            }
        }
        if (counts.undescribed && serverMode) {
            lines.push(fmt.plural(counts.undescribed, "picture") + " " + isAre(counts.undescribed) +
                       " not described yet; they can only be found by file name and date for " +
                       "now.");
        }
        emptyBox(state.q ? "No pictures match \u201c" + state.q + "\u201d" : "No pictures match " +
                 "these filters", lines, actions);
    }

    // A chosen value in words: a place with the places it is in.
    function filterLabel(group, value) {
        return group === "place" ? SearchCore.placeLabel(value) : facetValueLabel(group, value);
    }

    // "Year: 2023, Type: Receipts" for the facet selections.
    function filterText() {
        var parts = [];
        SearchCore.FACETS.forEach(function (facet) {
            (state.filters[facet.key] || []).forEach(function (value) {
                parts.push(facet.label + ": " + filterLabel(facet.key, value));
            });
        });
        return parts.join(", ");
    }

    /* Why a search found nothing: [{text, label, run}] for each change of
       one setting (the filters, an option, the library) that would find
       pictures, with a button that makes it. */
    function emptyReasons() {
        var reasons = [];
        var base = searchOptions();
        base.group = false;
        function found(change) {
            var options = {};
            Object.keys(base).forEach(function (key) {
                options[key] = base[key];
            });
            change(options);
            return SearchCore.search(data.index, state.q, options).total;
        }
        function matching(count, extra) {
            var verb = count === 1 ? " matches" : " match";
            return fmt.plural(count, extra ? extra + " picture" : "picture") +
                (state.q ? verb + " \u201c" + state.q + "\u201d" : verb + " the search");
        }
        if (state.ids) {
            var everywhere = found(function (options) {
                delete options.ids;
            });
            if (everywhere) {
                reasons.push({text: matching(everywhere) + " but " + isAre(everywhere) +
                                    " not among the pictures picked on the map.",
                              label: "Show all of them",
                              run: function () {
                                  state.ids = "";
                                  changed();
                              }});
            }
        }
        if (state.from || state.to) {
            var anyDate = found(function (options) {
                delete options.range;
            });
            if (anyDate) {
                reasons.push({text: matching(anyDate) + " but none was taken " +
                                    rangeText() + ".",
                              label: "Show every date",
                              run: function () {
                                  setRange("", "");
                              }});
            }
        }
        var hasFilters = Object.keys(state.filters).some(function (key) {
            return state.filters[key].length;
        });
        if (hasFilters) {
            var unfiltered = found(function (options) {
                options.filters = {};
            });
            if (unfiltered) {
                reasons.push({
                    text: state.q ? matching(unfiltered) + " but not " + filterText() + "."
                        : "No picture has all of these: " + filterText() + ".",
                    label: "Remove the filters",
                    run: function () {
                        state.filters = {};
                        changed();
                    }
                });
            }
        }
        if (state.junk) {
            var junk = found(function (options) {
                options.junk = false;
            });
            if (junk) {
                reasons.push({text: matching(junk) + " but " + isAre(junk) + " left out by " +
                                    "\u201cHide blurry and accidental shots\u201d.",
                              label: "Show blurry shots",
                              run: function () {
                                  state.junk = false;
                                  changed();
                              }});
            }
        }
        if (state.sensitive !== "show") {
            var sensitive = found(function (options) {
                options.sensitive = "show";
            });
            if (sensitive) {
                reasons.push({text: matching(sensitive) + " but " + isAre(sensitive) +
                                    " left out by \u201cHide sensitive pictures\u201d.",
                              label: "Show sensitive pictures",
                              run: function () {
                                  state.sensitive = "show";
                                  changed();
                              }});
            }
        }
        if (adminOn && !state.hidden) {
            var hidden = found(function (options) {
                options.hidden = true;
            });
            if (hidden) {
                reasons.push({text: matching(hidden, "hidden") + ".",
                              label: "Show hidden pictures",
                              run: function () {
                                  state.hidden = true;
                                  changed();
                              }});
            }
        }
        if (SHELL.library()) {
            var elsewhere = found(function (options) {
                options.library = "";
            });
            if (elsewhere) {
                reasons.push({text: matching(elsewhere) + " in other libraries.",
                              label: "Search all libraries",
                              run: function () {
                                  SHELL.setLibrary("");
                              }});
            }
        }
        return reasons;
    }

    /* ---------- Grid layout -------------------------------------------------------- */

    // How much of the search bar stays on screen when the page scrolls: all
    // of it, or (when the tools wrap above the search box) just the search
    // box row: the bar then sticks with the tools above the top of the
    // window. (On phones the tools are in the filter drawer.)
    var stuckOffset = 0;
    var stuckHeight = 0;

    function barHeight() {
        return stuckHeight || byId("search-bar").offsetHeight || 0;
    }

    function syncBar() {
        var bar = byId("search-bar");
        var tools = byId("search-tools");
        var row = byId("search-row");
        var offset = 0;
        var barTop = bar.getBoundingClientRect().top;
        var rowTop = row.getBoundingClientRect().top;
        var toolsBox = tools.getBoundingClientRect();
        if (bar.contains(tools) && rowTop > toolsBox.top + toolsBox.height / 2) {
            offset = Math.max(0, Math.round(rowTop - barTop) - 6);
        }
        var height = Math.max(0, bar.offsetHeight - offset);
        if (offset !== stuckOffset || height !== stuckHeight) {
            stuckOffset = offset;
            stuckHeight = height;
            document.body.style.setProperty("--bar-stick", -offset + "px");
            document.body.style.setProperty("--bar-h", height + "px");
        }
        document.body.classList.toggle("is-scrolled", window.scrollY > 4);
    }

    function monthKey(rec) {
        return rec && /^\d{4}-\d{2}/.test(rec.dk || "") ? rec.dk.slice(0, 7) : "";
    }

    // "May 2019"; on this day (one month and day of every year): "2019 -
    // 7 years ago".
    function groupLabel(key) {
        if (key && onThisDay()) {
            var ago = new Date().getFullYear() - Number(key.slice(0, 4));
            return key.slice(0, 4) + " \u00b7 " + (ago === 1 ? "a year ago" : ago + " years ago");
        }
        return key ? VIEWER.format.monthLabel(key + "-01") : "No date";
    }

    // "Jun 2019": for labels above one or two small pictures.
    function shortGroupLabel(key) {
        if (key && onThisDay()) {
            return key.slice(0, 4);
        }
        var long = groupLabel(key);
        return key ? long.slice(0, 3) + " " + key.slice(0, 4) : long;
    }

    /* The rows of the grid: {kind: "tiles", start, end, labels, group} and,
       when sorted by date, {kind: "head", labels} above a row where months
       start. Months flow like text (as in a phone's photo app): a month
       that fits in what is left of a row goes on in that row, with its
       label above its first picture, so months of one or two pictures do
       not leave whole rows empty. A month that does not fit starts a new
       row. */
    function computeLayout() {
        var width = Math.max(120, grid.clientWidth);
        var gap = width < 600 ? 4 : 8;
        var headHeight = width < 600 ? PHONE_HEADER_HEIGHT : HEADER_HEIGHT;
        var minimum = TILE_SIZES[state.size] || TILE_SIZES.m;
        if (width < 600) {
            minimum = Math.round(minimum * 0.72);
        }
        var cols = Math.max(1, Math.floor((width + gap) / (minimum + gap)));
        var tile = Math.floor((width - gap * (cols - 1)) / cols);
        // Month headers when sorted by date -- unless no picture has a date
        // (then a lone "No date" header would say nothing).
        var dated = (result.sort === "newest" || result.sort === "oldest") &&
            display.some(function (entry) {
                return monthKey(record(entry.id)) !== "";
            });
        var counts = {};            // month -> pictures (a stack counts all of its own)
        var runs = {};              // display index where a month starts -> its tiles
        if (dated) {
            var month = null;
            var starts = [];
            display.forEach(function (entry, index) {
                if (!entry.member) {
                    var key = monthKey(record(entry.id));
                    counts[key] = (counts[key] || 0) + (entry.stack && !expanded[entry.id]
                        ? entry.stack.length : 1);
                    if (key !== month) {
                        month = key;
                        starts.push(index);
                    }
                }
            });
            starts.forEach(function (index, k) {
                runs[index] = (k + 1 < starts.length ? starts[k + 1] : display.length) - index;
            });
        }
        var tileRows = [];
        var current = null;
        display.forEach(function (entry, index) {
            var run = runs[index];
            var used = current ? current.end - current.start : cols;
            if (used >= cols || (run !== undefined && run > cols - used)) {
                current = {kind: "tiles", start: index, end: index, labels: []};
                tileRows.push(current);
            }
            if (run !== undefined) {
                var key = monthKey(record(entry.id));
                current.labels.push({col: index - current.start, label: groupLabel(key),
                                     short: shortGroupLabel(key), count: counts[key] || 0});
            }
            current.end = index + 1;
        });
        var rows = [];
        var lastLabel = "";
        tileRows.forEach(function (row) {
            if (row.labels.length) {
                rows.push({kind: "head", labels: row.labels});
            }
            // The month of the row's first picture (for the floating label).
            row.group = row.labels.length && row.labels[0].col === 0 ? row.labels[0].label
                : lastLabel;
            if (row.labels.length) {
                lastLabel = row.labels[row.labels.length - 1].label;
            }
            rows.push(row);
        });
        var top = 0;
        var rowOf = new Array(display.length);
        rows.forEach(function (row, number) {
            row.height = row.kind === "head" ? headHeight : tile;
            row.top = top;
            top += row.height + gap;
            if (row.kind === "tiles") {
                for (var k = row.start; k < row.end; k++) {
                    rowOf[k] = number;
                }
            }
        });
        var blocks = [];
        var block = null;
        rows.forEach(function (row, number) {
            if (!block || block.tiles >= BLOCK_TILES) {
                block = {first: number, last: number, tiles: 0, top: row.top};
                blocks.push(block);
            }
            block.last = number;
            if (row.kind === "tiles") {
                block.tiles += row.end - row.start;
            }
        });
        blocks.forEach(function (item) {
            var last = rows[item.last];
            item.height = last.top + last.height - item.top;
        });
        return {cols: cols, tile: tile, gap: gap, rows: rows, rowOf: rowOf, blocks: blocks,
                dated: dated, width: width, height: Math.max(0, top - gap)};
    }

    // The first picture at least partly below the top of the screen and how
    // far below the top it is, to keep it in place across a new layout.
    function topAnchor() {
        if (!layout || !layout.rows.length) {
            return null;
        }
        var gridTop = grid.getBoundingClientRect().top + window.scrollY;
        var y = window.scrollY + barHeight() - gridTop;
        if (y <= 0) {
            return null;
        }
        var row = rowAt(y);
        if (!row) {
            return null;
        }
        var index = row.kind === "tiles" ? row.start : null;
        if (index === null) {
            var next = layout.rows[layout.rows.indexOf(row) + 1];
            index = next && next.kind === "tiles" ? next.start : null;
        }
        if (index === null || !display[index]) {
            return null;
        }
        return {id: display[index].id, offset: row.top - y};
    }

    function rowAt(y) {
        var rows = layout.rows;
        var low = 0;
        var high = rows.length - 1;
        if (high < 0) {
            return null;
        }
        while (low < high) {
            var mid = (low + high + 1) >> 1;
            if (rows[mid].top <= y) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return rows[low];
    }

    function relayout(keep) {
        var anchorAt = keep ? topAnchor() : null;
        if (observer) {
            observer.disconnect();
        }
        clear(grid);
        renderEmpty();
        if (!data || !result || !display.length) {
            layout = null;
            grid.style.height = "0px";
            updateMonthBar();
            return;
        }
        layout = computeLayout();
        grid.style.height = layout.height + "px";
        grid.style.setProperty("--tile-size", layout.tile + "px");
        layout.blocks.forEach(function (block, number) {
            var node = el("div", {className: "grid-block"});
            node.style.top = block.top + "px";
            node.style.height = block.height + "px";
            node.setAttribute("data-block", String(number));
            block.node = node;
            block.filled = false;
            grid.appendChild(node);
        });
        if (!observer && "IntersectionObserver" in window) {
            observer = new IntersectionObserver(onIntersect, {rootMargin: "1200px 0px"});
        }
        layout.blocks.forEach(function (block) {
            if (observer) {
                observer.observe(block.node);
            } else {
                fillBlock(block);
            }
        });
        if (anchorAt && positions[anchorAt.id] !== undefined) {
            var row = layout.rows[layout.rowOf[positions[anchorAt.id]]];
            var gridTop = grid.getBoundingClientRect().top + window.scrollY;
            window.scrollTo(0, Math.max(0, gridTop + row.top - barHeight() - anchorAt.offset));
        }
        updateMonthBar();
    }

    function onIntersect(entries) {
        entries.forEach(function (entry) {
            var number = Number(entry.target.getAttribute("data-block"));
            var block = layout && layout.blocks[number];
            if (!block || block.node !== entry.target) {
                return;
            }
            if (entry.isIntersecting) {
                fillBlock(block);
            } else if (block.filled && !block.node.contains(document.activeElement)) {
                clear(block.node);
                block.filled = false;
            }
        });
    }

    function fillBlock(block) {
        if (block.filled) {
            return;
        }
        block.filled = true;
        var node = block.node;
        var heights = [];
        for (var number = block.first; number <= block.last; number++) {
            var row = layout.rows[number];
            heights.push(row.height + "px");
            if (row.kind === "head") {
                node.appendChild(monthStrip(row));
            } else {
                for (var k = row.start; k < row.end; k++) {
                    node.appendChild(tileFor(k));
                }
            }
        }
        node.style.gridTemplateColumns = "repeat(" + layout.cols + ", " + layout.tile + "px)";
        node.style.gridTemplateRows = heights.join(" ");
        node.style.gap = layout.gap + "px";
    }

    // The labels of the months that start in the row below, each above
    // its first picture and no wider than its pictures.
    function monthStrip(row) {
        var strip = el("div", {className: "month-head"});
        var step = layout.tile + layout.gap;
        row.labels.forEach(function (item, k) {
            var next = row.labels[k + 1];
            var room = ((next ? next.col : layout.cols) - item.col) * step - layout.gap;
            var label = el("span", {className: "month-item", title: item.label}, [
                el("span", {className: "month-name",
                            text: room < SHORT_LABEL_ROOM ? item.short : item.label}),
                el("span", {className: "month-count", text: fmt.number(item.count)})
            ]);
            label.style.left = item.col * step + "px";
            label.style.maxWidth = room + "px";
            strip.appendChild(label);
        });
        return strip;
    }

    function tileNode(position) {
        return grid.querySelector('.tile[data-pos="' + position + '"]');
    }

    function ensureTile(position) {
        if (!layout || !display[position]) {
            return null;
        }
        var number = layout.rowOf[position];
        layout.blocks.some(function (block) {
            if (number >= block.first && number <= block.last) {
                fillBlock(block);
                return true;
            }
            return false;
        });
        return tileNode(position);
    }

    /* ---------- Thumbnails ------------------------------------------------------- */

    function isSelected(position) {
        var ids = idsAt(position);
        return ids.length > 0 && ids.every(function (id) {
            return selected[id];
        });
    }

    // The Duplicates page showing the stack that holds picture id (admin).
    function reviewUrl(id) {
        var library = SHELL.library();
        return "/duplicates?stack=" + encodeURIComponent(id) +
            (library ? "&lib=" + encodeURIComponent(library) : "");
    }

    function idsAt(position) {
        var entry = display[position];
        if (!entry) {
            return [];
        }
        return entry.stack && !expanded[entry.id] ? entry.stack : [entry.id];
    }

    function tileLabel(rec, entry) {
        var parts = [VIEWER.altText(rec)];
        var date = VIEWER.format.shortDate(rec.dk);
        if (date) {
            parts.push(date);
        }
        if (entry.stack && !expanded[entry.id]) {
            parts.push(entry.stack.length + " similar pictures");
        }
        if (rec.h) {
            parts.push("hidden");
        }
        return parts.join(", ");
    }

    function tileFor(position) {
        var entry = display[position];
        var rec = record(entry.id) || {i: entry.id};
        var stacked = entry.stack && !expanded[entry.id];
        // Screenshots and documents show their top (a chat's first
        // message, a receipt's shop name), not their middle.
        var page = DOC_TYPES[rec.ty] === true || Boolean(rec.dt);
        var node = el("div", {className: "tile" + (stacked ? " is-stack" : "") +
                              (entry.stack && expanded[entry.id] ? " is-stack-open" : "") +
                              (entry.member ? " is-member" : "") + (rec.h ? " is-hidden" : "") +
                              (page ? " is-page" : "") +
                              (selecting && isSelected(position) ? " is-selected" : "")});
        node.setAttribute("data-pos", String(position));
        var link = el("a", {className: "tile-link", href: SITE.detailUrl(entry.id, linkState()),
                            draggable: false, attrs: {"aria-label": tileLabel(rec, entry)}});
        link.tabIndex = position === focusPos ? 0 : -1;
        var image = el("img", {alt: "", src: SITE.thumbUrl(rec), loading: "lazy", draggable: false});
        image.decoding = "async";
        image.addEventListener("error", function () {
            node.classList.add("no-thumb");
        });
        link.appendChild(image);
        var caption = el("span", {className: "tile-caption", attrs: {"aria-hidden": "true"}});
        var title = rec.t || rec.n || "";
        if (title) {
            caption.appendChild(el("span", {className: "tile-title", text: title}));
        }
        var date = VIEWER.format.shortDate(rec.dk);
        if (date) {
            caption.appendChild(el("span", {className: "tile-date", text: date}));
        }
        link.appendChild(caption);
        var badges = el("span", {className: "tile-badges", attrs: {"aria-hidden": "true"}});
        if (rec.p === "360") {
            badges.appendChild(el("span", {className: "tile-badge", text: "360\u00b0"}));
        }
        if (rec.h) {
            badges.appendChild(el("span", {className: "tile-badge badge-hidden", text: "Hidden"}));
        }
        if (badges.childNodes.length) {
            link.appendChild(badges);
        }
        link.appendChild(el("span", {className: "tile-check", attrs: {"aria-hidden": "true"}}));
        node.appendChild(link);
        if (entry.stack) {
            var open = Boolean(expanded[entry.id]);
            var stackButton = el("button", {type: "button", className: "tile-stack",
                                            text: open ? "Close" : "\u00d7" + entry.stack.length,
                                            title: open ? "Fold the similar pictures back"
                                                : "Show the " + entry.stack.length + " similar pictures",
                                            attrs: {"aria-expanded": open ? "true" : "false",
                                                    "aria-label": open
                                                        ? "Fold the similar pictures back"
                                                        : "Show the " + entry.stack.length +
                                                          " similar pictures"}});
            stackButton.tabIndex = -1;
            node.appendChild(stackButton);
            if (open && adminOn) {
                // The stack on the Duplicates page, to keep the best of it.
                var review = el("a", {className: "tile-review", href: reviewUrl(entry.id),
                                      text: "Review",
                                      title: "Compare these pictures on the Duplicates page"});
                review.tabIndex = -1;
                node.appendChild(review);
            }
        }
        return node;
    }

    function setFocusPos(position) {
        if (position === focusPos) {
            return;
        }
        var old = tileNode(focusPos);
        if (old) {
            old.querySelector(".tile-link").tabIndex = -1;
        }
        focusPos = position;
        var current = tileNode(position);
        if (current) {
            current.querySelector(".tile-link").tabIndex = 0;
        }
    }

    function focusTile(position) {
        position = Math.max(0, Math.min(display.length - 1, position));
        var node = ensureTile(position);
        setFocusPos(position);
        if (node) {
            var link = node.querySelector(".tile-link");
            link.tabIndex = 0;
            link.focus({preventScroll: true});
            scrollIntoViewIfNeeded(node);
        }
    }

    function scrollIntoViewIfNeeded(node) {
        var rect = node.getBoundingClientRect();
        var top = barHeight() + 32;
        if (rect.top < top) {
            window.scrollBy(0, rect.top - top - 4);
        } else if (rect.bottom > window.innerHeight - 8) {
            window.scrollBy(0, rect.bottom - window.innerHeight + 8);
        }
    }

    // The picture straight above or below in the grid.
    function verticalTarget(position, direction) {
        var rowNumber = layout.rowOf[position];
        var row = layout.rows[rowNumber];
        var column = position - row.start;
        var number = rowNumber + direction;
        while (layout.rows[number] && layout.rows[number].kind !== "tiles") {
            number += direction;
        }
        var target = layout.rows[number];
        if (!target) {
            return position;
        }
        return Math.min(target.end - 1, target.start + column);
    }

    function gridKeydown(event) {
        var link = event.target.closest ? event.target.closest(".tile-link") : null;
        if (!link || !layout || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        var position = Number(link.parentNode.getAttribute("data-pos"));
        var target = null;
        var perScreen = Math.max(1, Math.floor(window.innerHeight / (layout.tile + layout.gap))) *
            layout.cols;
        switch (event.key) {
        case "ArrowLeft":
            target = position - 1;
            break;
        case "ArrowRight":
            target = position + 1;
            break;
        case "ArrowUp":
            target = verticalTarget(position, -1);
            if (target === position) {
                event.preventDefault();
                input.focus();
                return;
            }
            break;
        case "ArrowDown":
            target = verticalTarget(position, 1);
            break;
        case "Home":
            target = 0;
            break;
        case "End":
            target = display.length - 1;
            break;
        case "PageUp":
            target = position - perScreen;
            break;
        case "PageDown":
            target = position + perScreen;
            break;
        case " ":
            if (selecting) {
                event.preventDefault();
                toggleSelect(position, event.shiftKey);
            }
            return;
        default:
            return;
        }
        event.preventDefault();
        focusTile(target);
        if (selecting && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            toggleSelect(Math.max(0, Math.min(display.length - 1, target)), true);
        }
    }

    function gridClick(event) {
        var stackButton = event.target.closest ? event.target.closest(".tile-stack") : null;
        if (stackButton) {
            event.preventDefault();
            var position = Number(stackButton.parentNode.getAttribute("data-pos"));
            toggleStack(display[position].id);
            return;
        }
        var link = event.target.closest ? event.target.closest(".tile-link") : null;
        if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey ||
                (event.shiftKey && !selecting)) {
            return;
        }
        event.preventDefault();
        var at = Number(link.parentNode.getAttribute("data-pos"));
        setFocusPos(at);
        if (selecting) {
            toggleSelect(at, event.shiftKey);
        } else {
            openViewer(at, true);
        }
    }

    function toggleStack(id) {
        if (expanded[id]) {
            delete expanded[id];
        } else {
            expanded[id] = true;
        }
        buildDisplay();
        relayout(true);
        renderHead();
        if (positions[id] !== undefined && !VIEWER.isOpen()) {
            focusTile(positions[id]);
        }
        if (VIEWER.isOpen()) {
            VIEWER.update(display.map(function (entry) {
                return entry.id;
            }));
        }
    }

    /* ---------- Month bar (the month at the top of the screen) ------------------- */

    function updateMonthBar() {
        if (!layout || !layout.dated || !layout.rows.length) {
            monthLabel.hidden = true;
            return;
        }
        var gridTop = grid.getBoundingClientRect().top;
        var y = barHeight() - gridTop;
        if (y <= 0) {
            monthLabel.hidden = true;
            return;
        }
        var row = rowAt(y);
        var number = layout.rows.indexOf(row);
        // The real labels (at the foot of their strip) are in view below
        // the bar: no need for the copy.
        if (row.kind === "head" && row.top + row.height - LABEL_TEXT_HEIGHT > y) {
            monthLabel.hidden = true;
            return;
        }
        var tiles = row.kind === "tiles" ? row : layout.rows[number + 1];
        if (!tiles || !tiles.group) {
            monthLabel.hidden = true;
            return;
        }
        monthLabel.textContent = tiles.group;
        monthLabel.hidden = false;
    }

    /* ---------- Selection (admin) -------------------------------------------------- */

    function setSelecting(on) {
        selecting = on;
        if (!on) {
            selected = {};
            selectedCount = 0;
            anchor = null;
        }
        renderControls();
        renderSelectionBar();
        refreshSelectedTiles();
    }

    // A new search keeps only the selected pictures it still shows: the
    // actions must never touch pictures that are off the screen.
    function trimSelection() {
        if (!selectedCount) {
            return;
        }
        var shown = {};
        allResultIds().forEach(function (id) {
            shown[id] = true;
        });
        Object.keys(selected).forEach(function (id) {
            if (!shown[id]) {
                delete selected[id];
                selectedCount -= 1;
            }
        });
        if (!selectedCount) {
            anchor = null;
        }
    }

    function setSelected(id, on) {
        if (on && !selected[id]) {
            selected[id] = true;
            selectedCount += 1;
        } else if (!on && selected[id]) {
            delete selected[id];
            selectedCount -= 1;
        }
    }

    function toggleSelect(position, range) {
        if (range && anchor !== null && display[anchor]) {
            var low = Math.min(anchor, position);
            var high = Math.max(anchor, position);
            for (var k = low; k <= high; k++) {
                idsAt(k).forEach(function (id) {
                    setSelected(id, true);
                });
            }
        } else {
            var on = !isSelected(position);
            idsAt(position).forEach(function (id) {
                setSelected(id, on);
            });
            anchor = position;
        }
        refreshSelectedTiles();
        renderSelectionBar();
    }

    function refreshSelectedTiles() {
        Array.prototype.forEach.call(grid.querySelectorAll(".tile"), function (node) {
            var position = Number(node.getAttribute("data-pos"));
            node.classList.toggle("is-selected", selecting && isSelected(position));
        });
    }

    function allResultIds() {
        var ids = [];
        display.forEach(function (entry) {
            if (!entry.member) {
                (entry.stack || [entry.id]).forEach(function (id) {
                    ids.push(id);
                });
            }
        });
        return ids;
    }

    function selectedIds() {
        return Object.keys(selected).map(function (id) {
            return /^\d+$/.test(id) ? Number(id) : id;
        });
    }

    function chunks(list, size) {
        var out = [];
        for (var k = 0; k < list.length; k += size) {
            out.push(list.slice(k, k + size));
        }
        return out;
    }

    function hideSelected(hidden, button) {
        var ids = selectedIds();
        if (!ids.length) {
            return;
        }
        button.disabled = true;
        var changedCount = 0;
        var parts = chunks(ids, 10000);
        var chain = Promise.resolve();
        parts.forEach(function (part) {
            chain = chain.then(function () {
                return SHELL.admin("/images/hide", {ids: part, hidden: hidden}).then(function (reply) {
                    changedCount += reply.changed || 0;
                    part.forEach(function (id) {
                        var rec = record(id);
                        if (rec) {
                            if (hidden) {
                                rec.h = 1;
                            } else {
                                delete rec.h;
                            }
                        }
                    });
                });
            });
        });
        chain.then(function () {
            SHELL.toast(hidden
                ? fmt.plural(changedCount, "picture") + " hidden: they no longer show in searches " +
                  "or exports."
                : fmt.plural(changedCount, "picture") + " shown in searches again.", "ok");
            selected = {};
            selectedCount = 0;
            run({keepScroll: true});
        }, function () {
            run({keepScroll: true});
        }).then(function () {
            button.disabled = false;
        });
    }

    // The tags of the selected pictures, most common first (at most limit):
    // [{tag, count}].
    function selectedTags(ids, limit) {
        var counts = Object.create(null);
        ids.forEach(function (id) {
            var rec = record(id);
            (rec && Array.isArray(rec.g) ? rec.g : []).forEach(function (tag) {
                counts[tag] = (counts[tag] || 0) + 1;
            });
        });
        return Object.keys(counts).sort(function (a, b) {
            return counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0);
        }).slice(0, limit).map(function (tag) {
            return {tag: tag, count: counts[tag]};
        });
    }

    /* "Add tag..." / "Remove tag...": ask for tags, then change them on
       every selected picture (as the owner's edits, which stay when the
       pictures are described again). */
    function tagSelected(adding, button) {
        var ids = selectedIds();
        if (!ids.length) {
            return;
        }
        var count = fmt.plural(ids.length, "selected picture");
        var box = SHELL.modal({title: adding ? "Add tags to " + count
            : "Remove tags from " + count});
        var input = el("input", {type: "text", className: "input", autocomplete: "off",
                                 spellcheck: false, maxLength: 1000,
                                 placeholder: adding ? "for example: rex, grandma's garden"
                                     : "for example: blurry, document"});
        var field = SHELL.field("Tags (separate them with commas)", input);
        box.body.appendChild(field.node);
        var showError = function (message) {
            field.error.textContent = message;
            field.error.hidden = !message;
        };
        if (!adding) {
            var common = selectedTags(ids, 15);
            if (common.length) {
                var picks = el("div", {className: "info-chips tag-picks"});
                var pickButtons = [];
                // A pick is pressed while its tag is in the box.
                var markPicks = function () {
                    var have = VIEWER.format.splitTags(input.value);
                    pickButtons.forEach(function (pick) {
                        pick.button.setAttribute("aria-pressed",
                                                 String(have.indexOf(pick.tag) >= 0));
                    });
                };
                common.forEach(function (item) {
                    var pick = el("button", {
                        type: "button", className: "info-chip",
                        text: item.tag + " \u00b7 " + item.count,
                        title: "Add " + item.tag + " to the tags to remove (" +
                            fmt.plural(item.count, "selected picture") + " " +
                            (item.count === 1 ? "has" : "have") + " it); click again to " +
                            "take it out",
                        attrs: {"aria-pressed": "false"}
                    });
                    pick.addEventListener("click", function () {
                        var have = VIEWER.format.splitTags(input.value);
                        var at = have.indexOf(item.tag);
                        if (at < 0) {
                            have.push(item.tag);
                        } else {
                            have.splice(at, 1);
                        }
                        input.value = have.join(", ");
                        markPicks();
                        showError("");
                        input.focus();
                    });
                    pickButtons.push({tag: item.tag, button: pick});
                    picks.appendChild(pick);
                });
                input.addEventListener("input", markPicks);
                box.body.appendChild(el("p", {className: "field-hint",
                                              text: "Their most common tags:"}));
                box.body.appendChild(picks);
            }
        }
        box.body.appendChild(el("p", {className: "field-hint", text: adding
            ? "Tags you add are searched like the model's (a pet's name, a place, an event) " +
              "and stay when the pictures are described again."
            : "A tag the model gave stays removed when the pictures are described again."}));
        box.button("Cancel", "", function () {
            box.close();
        });
        var ok = box.button(adding ? "Add" : "Remove", "primary", go);
        box.submitOnEnter(go);
        input.addEventListener("input", function () {
            showError("");
        });
        function go() {
            if (ok.disabled) {
                return;
            }
            var tags = VIEWER.format.splitTags(input.value);
            var problem = !tags.length ? "Type at least one tag." :
                VIEWER.format.tagProblem(tags);
            showError(problem);
            if (problem) {
                input.focus();
                return;
            }
            ok.disabled = true;
            // The dialog stays open (with what was typed) until it worked.
            sendTags(ids, adding ? tags : [], adding ? [] : tags, button).then(function (done) {
                if (done) {
                    box.close();
                } else {
                    ok.disabled = false;
                }
            });
        }
    }

    // Change the tags of ids; resolves to true when every part was changed.
    function sendTags(ids, add, remove, button) {
        button.disabled = true;
        var changedCount = 0;
        var chain = Promise.resolve();
        chunks(ids, 10000).forEach(function (part) {
            chain = chain.then(function () {
                return SHELL.admin("/images/tags", {ids: part, add: add, remove: remove})
                    .then(function (reply) {
                        changedCount += reply.changed || 0;
                        Object.keys(reply.tags || {}).forEach(function (key) {
                            var rec = record(/^\d+$/.test(key) ? Number(key) : key);
                            if (!rec) {
                                return;
                            }
                            if (reply.tags[key].length) {
                                rec.g = reply.tags[key];
                            } else {
                                delete rec.g;
                            }
                            if (reply.edited && reply.edited[key]) {
                                rec.ed = 1;
                            } else {
                                delete rec.ed;
                            }
                        });
                    });
            });
        });
        return chain.then(function () {
            var words = (add.length ? add : remove).join(", ");
            SHELL.toast(changedCount
                ? (add.length ? "Added " + words + " to " : "Removed " + words + " from ") +
                  fmt.plural(changedCount, "picture") + "."
                : "Nothing to change: the pictures " + (add.length ? "already have " +
                  words + "." : "do not have " + words + "."), "ok");
            return true;
        }, function () {
            return false;
        }).then(function (done) {
            button.disabled = false;
            recordsEdited();
            return done;
        });
    }

    function copyPaths(button) {
        var ids = selectedIds();
        if (!ids.length) {
            return;
        }
        button.disabled = true;
        var paths = [];
        var chain = Promise.resolve();
        chunks(ids, 10000).forEach(function (part) {
            chain = chain.then(function () {
                return SHELL.admin("/images/paths", {ids: part}).then(function (reply) {
                    (reply.paths || []).forEach(function (item) {
                        paths.push(item.path);
                    });
                });
            });
        });
        chain.then(function () {
            return SHELL.copyText(paths.join("\n")).then(function (ok) {
                SHELL.toast(ok ? "Copied " + fmt.plural(paths.length, "file path") + "."
                    : "The browser did not allow copying.", ok ? "ok" : "warn");
            });
        }, function () {}).then(function () {
            button.disabled = false;
        });
    }

    function renderSelectionBar() {
        var bar = byId("selection-bar");
        clear(bar);
        if (!selecting || !result) {
            bar.hidden = true;
            return;
        }
        var touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
        bar.appendChild(el("span", {className: "selection-count",
                                    text: selectedCount ? fmt.number(selectedCount) + " selected"
                                        : touch ? "Tap pictures to select them"
                                            : "Click pictures to select them (Shift-click for a range)"}));
        var all = allResultIds();
        var selectAll = el("button", {type: "button", className: "button small",
                                      text: "Select all " + fmt.plural(all.length, "result")});
        selectAll.addEventListener("click", function () {
            all.forEach(function (id) {
                setSelected(id, true);
            });
            refreshSelectedTiles();
            renderSelectionBar();
        });
        bar.appendChild(selectAll);
        var none = el("button", {type: "button", className: "button small subtle",
                                 text: "Clear the selection", disabled: !selectedCount});
        none.addEventListener("click", function () {
            selected = {};
            selectedCount = 0;
            refreshSelectedTiles();
            renderSelectionBar();
        });
        bar.appendChild(none);
        bar.appendChild(el("span", {className: "selection-spacer"}));
        var hide = el("button", {type: "button", className: "button small", text: "Hide",
                                 disabled: !selectedCount,
                                 title: "Hidden pictures leave searches and are never exported"});
        hide.addEventListener("click", function () {
            hideSelected(true, hide);
        });
        var unhide = el("button", {type: "button", className: "button small", text: "Unhide",
                                   disabled: !selectedCount});
        unhide.addEventListener("click", function () {
            hideSelected(false, unhide);
        });
        var addTag = el("button", {type: "button", className: "button small", text: "Add tag\u2026",
                                   disabled: !selectedCount,
                                   title: "Add tags to the selected pictures"});
        addTag.addEventListener("click", function () {
            tagSelected(true, addTag);
        });
        var removeTag = el("button", {type: "button", className: "button small",
                                      text: "Remove tag\u2026", disabled: !selectedCount,
                                      title: "Remove tags from the selected pictures"});
        removeTag.addEventListener("click", function () {
            tagSelected(false, removeTag);
        });
        var copy = el("button", {type: "button", className: "button small", text: "Copy file paths",
                                 disabled: !selectedCount});
        copy.addEventListener("click", function () {
            copyPaths(copy);
        });
        var done = el("button", {type: "button", className: "button small primary", text: "Done"});
        done.addEventListener("click", function () {
            setSelecting(false);
        });
        bar.appendChild(hide);
        bar.appendChild(unhide);
        bar.appendChild(addTag);
        bar.appendChild(removeTag);
        bar.appendChild(copy);
        bar.appendChild(done);
        bar.hidden = false;
    }

    /* ---------- Viewer ------------------------------------------------------------- */

    function whenSettled(action) {
        if (backPending) {
            afterBack.push(action);
        } else {
            action();
        }
    }

    function flushAfterBack() {
        if (!backPending) {
            return;
        }
        backPending = false;
        var actions = afterBack;
        afterBack = [];
        actions.forEach(function (action) {
            action();
        });
    }

    function viewerIds() {
        return display.map(function (entry) {
            return entry.id;
        });
    }

    function openViewer(position, push, id) {
        var ids = viewerIds();
        var first = id !== undefined ? id : ids[position];
        if (push && record(first)) {
            // The viewer's own entry, so that Back closes it; added before
            // the viewer writes #id= into the current entry.
            var query = SITE.searchState.params(urlState());
            window.history.pushState({scrollY: window.scrollY, viewer: true}, "",
                                     window.location.pathname + (query ? "?" + query : "") +
                                     "#id=" + encodeURIComponent(first));
            viewerPushed = true;
        }
        var opened = VIEWER.open({
            ids: ids,
            index: position >= 0 ? position : 0,
            id: id,
            get: record,
            // The query as searched (whole words, or the start of the last
            // one while typing), so the marks agree with the matches.
            query: result && result.query ? result.query : state.q,
            libraryName: libraryName,
            similar: function (other) {
                return SearchCore.similar(data.index, other, 8, visibility());
            },
            chipUrl: chipUrl,
            onChip: function (group, value) {
                whenSettled(function () {
                    applyChip(group, value);
                });
            },
            detailUrl: function (other) {
                return SITE.detailUrl(other, linkState());
            },
            stackOf: function (other) {
                var entry = display[positions[other]];
                return entry && entry.stack && !expanded[other] ? entry.stack : null;
            },
            onExpandStack: function (other) {
                toggleStack(other);
            },
            reviewUrl: adminOn ? reviewUrl : null,
            onShow: function (shown, at) {
                if (at >= 0) {
                    setFocusPos(at);
                }
                writeUrl({id: shown});
            },
            onClose: function (closedId) {
                if (viewerPushed) {
                    viewerPushed = false;
                    backPending = true;
                    window.history.back();
                    window.setTimeout(flushAfterBack, 600);
                } else {
                    writeUrl({id: null});
                }
                var at = positions[closedId];
                if (at !== undefined) {
                    focusTile(at);
                }
            },
            onHidden: function () {
                run({keepScroll: true});
            },
            onEdited: recordsEdited
        });
        return opened;
    }

    function openFromHash() {
        var id = hashId();
        if (id === null) {
            if (VIEWER.isOpen()) {
                viewerPushed = false;
                VIEWER.close();
            }
            return;
        }
        if (!record(id)) {
            writeUrl({id: null});
            return;
        }
        if (reveal(id) && VIEWER.isOpen()) {
            VIEWER.update(viewerIds());
        }
        if (VIEWER.isOpen()) {
            VIEWER.show(id);
            return;
        }
        var at = positions[id];
        openViewer(at === undefined ? -1 : at, false, id);
        viewerPushed = Boolean(window.history.state && window.history.state.viewer);
        if (!restored) {
            viewerPushed = Boolean(initialHistory.viewer);
        }
    }

    /* ---------- Keyboard ----------------------------------------------------------- */

    function typingIn(target) {
        var tag = target && target.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
            (target && target.isContentEditable);
    }

    function globalKeydown(event) {
        if (VIEWER.isOpen() || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (event.key === "/" && !typingIn(event.target)) {
            event.preventDefault();
            input.focus();
            input.select();
        } else if (event.key === "Escape") {
            if (drawerOpen()) {
                closeDrawer();
            } else if (selecting && !typingIn(event.target)) {
                setSelecting(false);
            }
        }
    }

    /* ---------- Start ---------------------------------------------------------------- */

    function loadFailed() {
        emptyBox("The picture index could not be loaded",
                 [SITE.isStatic ? "Some files of this site may be missing."
                     : "Is the server still running?"],
                 [actionButton("Try again", function () {
                     byId("empty").hidden = true;
                     load();
                 }, true)]);
        byId("result-count").textContent = "";
    }

    function restoreScroll() {
        if (restored) {
            return;
        }
        restored = true;
        var saved = initialHistory.scrollY;
        if (typeof saved === "number" && saved > 0) {
            window.scrollTo(0, saved);
            updateMonthBar();
        }
    }

    function load() {
        byId("result-count").textContent = "Loading the pictures\u2026";
        SITE.loadIndex(function (loaded) {
            if (!loaded) {
                loadFailed();
                return;
            }
            setData(loaded);
            run();
            openFromHash();
            writeUrl({id: hashId()});
            restoreScroll();
        });
    }

    // Pick up new descriptions (or hidden pictures) when coming back to the tab.
    function refresh() {
        if (!data || document.hidden || Date.now() - loadedAt < REFRESH_AFTER || VIEWER.isOpen()) {
            return;
        }
        loadedAt = Date.now();
        SITE.refreshIndex(function (loaded) {
            if (loaded && !VIEWER.isOpen()) {
                setData(loaded);
                run({keepScroll: true});
            }
        });
    }

    function start() {
        if ("scrollRestoration" in window.history) {
            window.history.scrollRestoration = "manual";
        }
        keepView();
        setupControls();
        setupMapLink();
        arrival.query = SITE.searchState.params(urlState());
        renderControls();
        grid.addEventListener("click", gridClick);
        grid.addEventListener("keydown", gridKeydown);
        grid.addEventListener("focusin", function (event) {
            var link = event.target.closest ? event.target.closest(".tile-link") : null;
            if (link) {
                setFocusPos(Number(link.parentNode.getAttribute("data-pos")));
            }
        });
        document.addEventListener("keydown", globalKeydown);
        var framed = false;
        window.addEventListener("scroll", function () {
            rememberScroll();
            syncBar();
            if (!framed) {
                framed = true;
                window.requestAnimationFrame(function () {
                    framed = false;
                    updateMonthBar();
                });
            }
        }, {passive: true});
        var lastWidth = window.innerWidth;
        var resizeTimer = 0;
        window.addEventListener("resize", function () {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(function () {
                syncBar();
                if (result && !timelineClosed() && byId("results").clientWidth !== timelineWidth) {
                    renderTimeline();
                }
                if (layout && Math.abs(grid.clientWidth - layout.width) > 1) {
                    relayout(true);
                } else if (window.innerWidth !== lastWidth) {
                    updateMonthBar();
                }
                lastWidth = window.innerWidth;
            }, 80);
        });
        window.addEventListener("popstate", function () {
            if (backPending) {
                flushAfterBack();
                return;
            }
            var wanted = SITE.searchState.read();
            var sameSearch = SITE.searchState.params(wanted) === SITE.searchState.params(urlState());
            if (!sameSearch) {
                state = wanted;
                keepView();
                if (!state.size) {
                    state.size = "m";
                }
                typing = false;
                input.value = state.q;
                updateTitle();
                run();
                // Back to an earlier search: where it was scrolled to.
                var saved = window.history.state;
                if (saved && typeof saved.scrollY === "number") {
                    window.scrollTo(0, saved.scrollY);
                    updateMonthBar();
                }
            }
            openFromHash();
        });
        document.addEventListener("visibilitychange", refresh);
        SHELL.onLibraryChange(function () {
            changed();
        });
        syncBar();
        load();
    }

    start();
})();
