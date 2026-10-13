/* The shell shared by every page: the header (navigation, library switcher,
   job indicator), the URL-state helper, the admin request helper, and small
   DOM, dialog and formatting helpers the Manage and Settings pages use.

   SHELL.getState() / SHELL.setState({key: value}) read and change the query
   string (history.replaceState; null or "" removes a key).

   SHELL.library() is the id of the library picked in the header ("" = all
   libraries), SHELL.libraryName() its display name. A page that filters by
   library calls SHELL.onLibraryChange(fn); on other pages picking a library
   opens the search page for it. The choice is kept in ?lib= and in
   localStorage.

   SHELL.field(label, control, options), SHELL.notice(kind, content,
   actions) and SHELL.warningList(warnings) build the forms and notices of
   the Manage and Settings pages; SHELL.format.money(dollars) writes a
   cost, and SHELL.TEST_COST_KEY + endpoint name is where the Settings
   page's last Test keeps its cost per picture (the Manage page reads it).

   SHELL.admin(path, body, options) calls /api/admin<path> with the
   X-Search-Images header: GET without a body, POST with a JSON body (and
   the last config token seen, so a change made elsewhere is noticed). It
   resolves with the reply's JSON and rejects when the server says no,
   after showing the message (unless options.quiet); the error carries
   .status, .data and .fields.

   Pages are built with DOM calls and textContent only, never innerHTML.
   This file also runs in the static export (from file://), where there is
   no admin API.
*/
var SHELL = (function () {
    "use strict";

    var site = window.SITE || {};
    var capabilities = site.capabilities || {};
    var page = site.page || "";
    var adminOn = Boolean(capabilities.admin) && !capabilities.static;
    var LIBRARY_KEY = "searchImages.library";
    // Pages whose content follows the library switcher (others navigate).
    var LIBRARY_PAGES = ["search", "map", "detail", "duplicates"];
    var JOB_POLL_ACTIVE = 5000;
    var JOB_POLL_IDLE = 10000;

    var configToken = null;
    var libraryHandlers = [];
    var currentLibrary = "";
    var jobTimer = null;
    var jobIndicator = null;
    var reloadShown = false;

    var TEST_COST_KEY = "searchImages.testCost.";

    /* ---------- DOM helpers ---------------------------------------------- */

    // el("button", {className: "button", text: "Save", on: {click: fn},
    //    attrs: {"aria-label": "..."}}, [children]). Other keys are set as
    // properties (type, value, href, disabled, hidden, title, ...).
    // Children are nodes or strings (added as text).
    function el(tag, props, children) {
        var node = document.createElement(tag);
        Object.keys(props || {}).forEach(function (key) {
            var value = props[key];
            if (value === undefined || value === null) {
                return;
            }
            if (key === "text") {
                node.textContent = String(value);
            } else if (key === "on") {
                Object.keys(value).forEach(function (name) {
                    node.addEventListener(name, value[name]);
                });
            } else if (key === "attrs") {
                Object.keys(value).forEach(function (name) {
                    if (value[name] !== null && value[name] !== undefined && value[name] !== false) {
                        node.setAttribute(name, value[name] === true ? "" : String(value[name]));
                    }
                });
            } else {
                node[key] = value;
            }
        });
        append(node, children);
        return node;
    }

    function append(node, children) {
        if (children === undefined || children === null || children === false) {
            return node;
        }
        if (!Array.isArray(children)) {
            children = [children];
        }
        children.forEach(function (child) {
            if (child === undefined || child === null || child === false) {
                return;
            }
            if (Array.isArray(child)) {
                append(node, child);
            } else if (typeof child === "string" || typeof child === "number") {
                node.appendChild(document.createTextNode(String(child)));
            } else {
                node.appendChild(child);
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

    /* ---------- Forms and notices (Manage and Settings) ------------------ */

    var fieldCount = 0;

    // A labelled field. The label (and the hint) are tied to the control
    // by id, also when the field holds more than the control (options.div).
    function field(label, control, options) {
        options = options || {};
        fieldCount += 1;
        var labelId = "shell-field-" + fieldCount;
        var error = el("span", {className: "field-error", hidden: true,
                                attrs: {"aria-live": "polite"}});
        var labelNode = el("span", {className: "field-label", id: labelId}, [label]);
        if (options.optional) {
            labelNode.appendChild(el("span", {className: "optional", text: " (optional)"}));
        }
        var hint = options.hint ? el("span", {className: "field-hint", id: labelId + "-hint"},
                                     options.hint) : null;
        var node = el(options.div ? "div" : "label", {className: "field"}, [
            labelNode, control, hint, options.after || null, error
        ]);
        var target = options.control || control;
        target.setAttribute("aria-labelledby", labelId);
        if (hint) {
            target.setAttribute("aria-describedby", labelId + "-hint");
        }
        return {node: node, error: error, control: target};
    }

    // A notice box ("ok", "warn", "error" or "") holding text or nodes, and
    // action buttons (empty ones are left out).
    function notice(kind, content, actions) {
        var box = el("div", {className: "notice " + (kind || "")});
        box.appendChild(append(el("div", {className: "notice-text"}), content));
        (actions || []).forEach(function (action) {
            if (action) {
                box.appendChild(action);
            }
        });
        return box;
    }

    // One warning as text, several as a list.
    function warningList(warnings) {
        if (warnings.length === 1) {
            return warnings[0];
        }
        return el("ul", {className: "warning-list"}, warnings.map(function (text) {
            return el("li", {text: text});
        }));
    }

    /* ---------- Storage (may be unavailable, e.g. some file:// pages) ---- */

    function storageGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            if (value === null || value === undefined || value === "") {
                window.localStorage.removeItem(key);
            } else {
                window.localStorage.setItem(key, String(value));
            }
        } catch (error) {
            // Not remembered; the URL still carries the choice.
        }
    }

    /* ---------- URL state ------------------------------------------------ */

    function getState() {
        var state = {};
        new URLSearchParams(window.location.search).forEach(function (value, key) {
            state[key] = value;
        });
        return state;
    }

    function setState(changes) {
        var params = new URLSearchParams(window.location.search);
        Object.keys(changes || {}).forEach(function (key) {
            var value = changes[key];
            if (value === null || value === undefined || value === "") {
                params.delete(key);
            } else {
                params.set(key, String(value));
            }
        });
        var query = params.toString();
        window.history.replaceState(null, "", window.location.pathname +
            (query ? "?" + query : "") + window.location.hash);
    }

    /* ---------- Formatting ----------------------------------------------- */

    function number(value) {
        var n = Number(value);
        if (!isFinite(n)) {
            return "0";
        }
        return n.toLocaleString();
    }

    // plural(3, "picture") -> "3 pictures"; plural(1, "entry", "entries").
    function plural(count, singular, pluralForm) {
        return number(count) + " " + (Number(count) === 1 ? singular : (pluralForm || singular + "s"));
    }

    function duration(seconds) {
        seconds = Math.max(0, Math.round(Number(seconds) || 0));
        if (seconds < 60) {
            return seconds + " s";
        }
        var minutes = Math.round(seconds / 60);
        if (minutes < 60) {
            return minutes + " min";
        }
        var hours = Math.floor(minutes / 60);
        minutes = minutes % 60;
        if (hours < 48) {
            return hours + " h" + (minutes ? " " + minutes + " min" : "");
        }
        return Math.floor(hours / 24) + " days " + (hours % 24) + " h";
    }

    // "just now", "5 minutes ago", "yesterday", or a date (seconds since 1970).
    function relative(when) {
        if (!when) {
            return "";
        }
        var diff = Date.now() / 1000 - Number(when);
        if (diff < 45) {
            return "just now";
        }
        if (diff < 90) {
            return "a minute ago";
        }
        if (diff < 3600) {
            return Math.round(diff / 60) + " minutes ago";
        }
        if (diff < 5400) {
            return "an hour ago";
        }
        if (diff < 86400) {
            return Math.round(diff / 3600) + " hours ago";
        }
        if (diff < 2 * 86400) {
            return "yesterday";
        }
        if (diff < 7 * 86400) {
            return Math.round(diff / 86400) + " days ago";
        }
        return new Date(Number(when) * 1000).toLocaleDateString();
    }

    function clock(when) {
        var date = new Date(Number(when) * 1000);
        function two(n) {
            return (n < 10 ? "0" : "") + n;
        }
        return two(date.getHours()) + ":" + two(date.getMinutes()) + ":" + two(date.getSeconds());
    }

    // "512 bytes", "4.2 KB", "162 MB", "1.3 GB".
    // A cost in dollars. Small ones keep their first digits ("$0.00040"),
    // so the cost per picture of a cheap cloud model never reads as nothing.
    function money(value) {
        if (value === 0) {
            return "$0";
        }
        return "$" + value.toFixed(value < 0.01 ? 5 : value < 1 ? 3 : 2);
    }

    function bytes(value) {
        var n = Number(value);
        if (!isFinite(n) || n < 0) {
            return "";
        }
        var units = ["bytes", "KB", "MB", "GB", "TB"];
        var unit = 0;
        while (n >= 1024 && unit < units.length - 1) {
            n /= 1024;
            unit += 1;
        }
        return (unit === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0)) + " " +
            units[unit];
    }

    function percent(part, whole) {
        if (!whole) {
            return 0;
        }
        var value = Math.floor(100 * part / whole);
        if (part > 0 && value === 0) {
            return 1;
        }
        return Math.min(100, value);
    }

    /* ---------- Jobs: how they are described to people --------------------- */

    var KIND_LABELS = {
        scan: "Scan",
        describe: "Describe",
        refine: "Refine documents",
        embed: "Update meaning search",
        image_embed: "Update looks",
        process: "Scan + describe",
        previews: "Build previews",
        delete_library: "Delete indexed data",
        export: "Export",
        places: "Add place names",
        proxies: "Make playable copies",
        drive_previews: "Make sped-up drives"
    };
    var STATE_LABELS = {
        queued: "Waiting",
        running: "Running",
        paused: "Paused",
        cancelling: "Stopping",
        done: "Done",
        failed: "Failed",
        cancelled: "Cancelled",
        interrupted: "Interrupted"
    };
    var STAGE_LABELS = {
        scan: "Looking for new and changed pictures",
        previews: "Building previews",
        describe: "Describing pictures",
        refine: "Describing documents and screenshots again",
        embed: "Updating search by meaning",
        delete: "Deleting indexed data",
        export: "Exporting pictures",
        zip: "Writing the zip file",
        download: "Downloading place names",
        "build places": "Building the place index",
        places: "Adding place names",
        proxies: "Making playable copies of videos",
        looks: "Making the looks of pictures",
        "opening views": "Finding where 360 photos open",
        drives: "Describing drives",
        drive_previews: "Making sped-up previews of drives"
    };
    var STAGE_VERBS = {
        scan: "Scanning",
        previews: "Building previews for",
        describe: "Describing",
        refine: "Refining the documents of",
        embed: "Updating search by meaning for",
        delete: "Deleting the data of",
        export: "Exporting",
        zip: "Zipping the export of",
        looks: "Making the looks of"
    };
    var WAITING_STAGE = "waiting for another scan to finish";

    function jobKind(job) {
        var params = job.params || {};
        if (job.kind === "places" && params.download) {
            return "Download place names";
        }
        if (job.kind === "describe" && params.retry_failed) {
            return "Retry failed";
        }
        if (job.kind === "describe" && params.redescribe_stale) {
            return "Re-describe out of date";
        }
        if (job.kind === "image_embed" && params.rebuild) {
            return "Rebuild looks";
        }
        if (job.kind === "process" && !job.library_id) {
            return "Process all libraries";
        }
        return KIND_LABELS[job.kind] || job.kind;
    }

    function jobLibrary(job) {
        if (!job.library_id) {
            return "all libraries";
        }
        return job.library || job.library_id;
    }

    // "Scan + describe: Family", "Process all libraries".
    function jobTitle(job) {
        var kind = jobKind(job);
        if ((job.kind === "process" || job.kind === "places") && !job.library_id) {
            return kind;
        }
        return kind + ": " + jobLibrary(job);
    }

    function stageLabel(stage, job) {
        if (!stage) {
            return job && job.state === "queued" ? "Waiting to start" : "Starting";
        }
        if (stage === WAITING_STAGE) {
            return "Waiting for another scan to finish";
        }
        if (stage === "scan" && job && !job.total) {
            return "Listing the files in the folder";
        }
        return STAGE_LABELS[stage] || stage.charAt(0).toUpperCase() + stage.slice(1);
    }

    // "1,204 of 2,219 - 6.2 per minute - about 2 h 44 min left". The rate
    // and time left only while the job is actually moving.
    function progressText(job) {
        var parts = [];
        var moving = job.state === "running" && !job.waiting;
        if (job.total) {
            parts.push(number(job.done) + " of " + number(job.total));
        } else if (job.done) {
            parts.push(number(job.done) + " so far");
        }
        if (moving && job.rate) {
            parts.push(number(job.rate) + " per minute");
        }
        if (moving && job.eta) {
            parts.push("about " + duration(job.eta) + " left");
        }
        return parts.join(" \u00b7 ");
    }

    // Who holds the job lock when it is not this server: a sentence.
    function otherHolderText(lock) {
        if (lock && lock.kind === "server") {
            return "Another server that uses the same data folder is running a job";
        }
        return "A run started from the command line (scan.py) is running";
    }

    function add(totals, key, value) {
        if (typeof value === "number" && isFinite(value)) {
            totals[key] = (totals[key] || 0) + value;
        }
    }

    // One line about what a finished job did, from its stored summary.
    function summaryText(job) {
        var summary = job.summary || {};
        var totals = {};
        var parts = [];
        (summary.libraries || []).forEach(function (item) {
            add(totals, "added", item.added);
            add(totals, "changed", item.changed);
            add(totals, "updated", item.updated);
            add(totals, "missing", item.missing);
            add(totals, "failed_read", item.failed);
            add(totals, "files", item.files);
            add(totals, "videos_skipped", item.videos_skipped);
            if (item.previews) {
                add(totals, "previews", item.previews.filled);
            }
            add(totals, "previews", item.filled);
        });
        var described = summary.describe ||
            (job.kind === "describe" || job.kind === "refine" ? summary : null);
        if (job.kind === "delete_library") {
            add(totals, "deleted", summary.deleted);
        }
        if (totals.files !== undefined && (job.kind === "scan" || job.kind === "process")) {
            parts.push(plural(totals.files, "picture") + " checked");
        }
        if (totals.added) {
            parts.push(number(totals.added) + " new");
        }
        if (totals.changed || totals.updated) {
            parts.push(number((totals.changed || 0) + (totals.updated || 0)) + " changed");
        }
        if (totals.missing) {
            parts.push(number(totals.missing) + " missing");
        }
        if (totals.failed_read) {
            parts.push(plural(totals.failed_read, "unreadable file"));
        }
        if (totals.videos_skipped) {
            parts.push(plural(totals.videos_skipped, "video") + " not read (no ffmpeg)");
        }
        if (totals.previews) {
            parts.push(plural(totals.previews, "preview") + " built");
        }
        if (described) {
            if (typeof described.described === "number") {
                parts.push(number(described.described) +
                           (job.kind === "refine" ? " refined" : " described"));
            }
            if (described.skipped_hidden) {
                parts.push(number(described.skipped_hidden) + " hidden not sent");
            }
            if (described.failed) {
                parts.push(number(described.failed) + " failed");
            }
            if (typeof described.cost === "number" && described.cost > 0) {
                parts.push("about $" + described.cost.toFixed(described.cost < 1 ? 4 : 2));
            }
        }
        var embedded = job.kind === "embed" ? summary : summary.embed ||
            (described && described.embed);
        if (embedded && typeof embedded.embedded === "number" &&
                (embedded.embedded || embedded.failed || job.kind === "embed")) {
            parts.push(plural(embedded.embedded, "picture") + " updated for search by meaning");
            if (embedded.failed) {
                parts.push(number(embedded.failed) + " could not be");
            }
            if (embedded.cut) {
                // (Texts too long for the model, embedded in part.)
                parts.push(number(embedded.cut) + " cut to fit the model");
            }
        }
        if (job.kind === "image_embed" && typeof summary.embedded === "number") {
            // (looks.update: embedded, failed, offline, rebuilt.)
            parts.push(plural(summary.embedded, "picture") + " given looks");
            if (summary.failed) {
                parts.push(number(summary.failed) + " could not be");
            }
            if (summary.offline) {
                parts.push(number(summary.offline) + " wait for their folder");
            }
            // (Where 360 photos open, see opening_views.py.)
            if (summary.views) {
                parts.push(plural(summary.views, "360 photo") + " given an opening view" +
                           (summary.views_turned ? " (" + number(summary.views_turned) +
                            " facing their subject)" : ""));
            }
            if (summary.views_dropped) {
                parts.push(plural(summary.views_dropped, "360 photo") + " back at the front");
            }
        }
        if ((job.kind === "scan" || job.kind === "process") && summary.looks_pending) {
            // (Looks are made by the Update looks job only: it needs the image model.)
            parts.push(plural(summary.looks_pending, "picture") + " without looks yet");
        }
        if ((job.kind === "scan" || job.kind === "process") && summary.views_pending) {
            // (... and so are the opening views of 360 photos.)
            parts.push(plural(summary.views_pending, "360 photo") +
                       " waiting for an opening view");
        }
        if (totals.deleted !== undefined) {
            parts.push(plural(totals.deleted, "picture") + " deleted");
        }
        if (job.kind === "export" && typeof summary.count === "number") {
            parts.push(plural(summary.count, "picture") + " exported");
            if (summary.bytes) {
                parts.push(bytes(summary.bytes));
            }
            if (summary.failed) {
                parts.push(number(summary.failed) + " could not be read");
            }
        }
        if (job.kind === "proxies") {
            // (videos.make_proxies: made, kept, failed, removed.)
            if (typeof summary.made === "number") {
                parts.push(plural(summary.made, "playable copy", "playable copies") + " made");
            }
            if (summary.failed) {
                parts.push(number(summary.failed) + " failed");
            }
            if (summary.removed) {
                parts.push(plural(summary.removed, "old copy", "old copies") + " removed");
            }
        }
        if (job.kind === "drive_previews") {
            // (drives.make_previews: made, kept, failed, removed.)
            if (typeof summary.made === "number") {
                parts.push(plural(summary.made, "sped-up drive") + " made");
            }
            if (summary.failed) {
                parts.push(number(summary.failed) + " failed");
            }
            if (summary.removed) {
                parts.push(plural(summary.removed, "old one") + " removed");
            }
        }
        if (summary.drives && typeof summary.drives.described === "number" &&
                (summary.drives.described || summary.drives.failed)) {
            // (A describe run's drives: drives.describe_drives.)
            parts.push(plural(summary.drives.described, "drive") + " described" +
                       (summary.drives.failed ? " (" + number(summary.drives.failed) +
                        " failed)" : ""));
        }
        if (job.kind === "places") {
            if (summary.index && typeof summary.index.cities === "number") {
                parts.push(plural(summary.index.cities, "town") + " known");
            }
            if (summary.places && typeof summary.places.checked === "number") {
                parts.push(plural(summary.places.checked, "picture") + " given a place");
            }
        }
        if (summary.offline && summary.offline.length) {
            parts.push("offline: " + summary.offline.join(", "));
        }
        return parts.join(" \u00b7 ");
    }

    /* ---------- Messages ------------------------------------------------- */

    function toastRegion() {
        var region = document.getElementById("shell-toasts");
        if (!region) {
            region = el("div", {id: "shell-toasts", attrs: {"aria-live": "polite"}});
            document.body.appendChild(region);
        }
        return region;
    }

    // kind: "error" (default), "warn", "ok" or "info".
    function toast(message, kind, seconds) {
        kind = kind || "error";
        var region = toastRegion();
        var box = el("div", {className: "toast toast-" + kind,
                             attrs: {role: kind === "error" ? "alert" : "status"}});
        var close = el("button", {type: "button", className: "toast-close", text: "\u00d7",
                                  attrs: {"aria-label": "Dismiss"}});
        box.appendChild(el("span", {className: "toast-text", text: message}));
        box.appendChild(close);
        function remove() {
            if (box.parentNode) {
                box.parentNode.removeChild(box);
            }
        }
        close.addEventListener("click", remove);
        region.appendChild(box);
        while (region.children.length > 4) {
            region.removeChild(region.firstChild);
        }
        window.setTimeout(remove, (seconds || (kind === "error" ? 12 : 6)) * 1000);
        return box;
    }

    function showReload(message) {
        if (reloadShown) {
            return;
        }
        reloadShown = true;
        confirmDialog({
            title: "Settings changed elsewhere",
            message: message + " Changes made on this page since then were not saved.",
            confirmText: "Reload the page",
            cancelText: "Not now"
        }).then(function (yes) {
            reloadShown = false;
            if (yes) {
                window.location.reload();
            }
        });
    }

    /* ---------- Admin requests ------------------------------------------- */

    function requestError(message, status, data) {
        var error = new Error(message);
        error.status = status;
        error.data = data || {};
        error.fields = (data && data.fields) || {};
        return error;
    }

    function admin(path, body, options) {
        options = options || {};
        var init = {
            method: body === undefined ? "GET" : "POST",
            credentials: "same-origin",
            headers: {"X-Search-Images": "1", "Accept": "application/json"}
        };
        if (body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            if (configToken) {
                init.headers["X-Config-Token"] = configToken;
            }
            init.body = JSON.stringify(body);
        }
        return fetch((site.adminApi || "/api/admin") + path, init).then(function (response) {
            return response.json().catch(function () {
                return {};
            }).then(function (data) {
                if (data && typeof data.config_token === "string") {
                    configToken = data.config_token;
                }
                if (!response.ok) {
                    var error = requestError(data.error ||
                        ("The server answered with an error (" + response.status + ")."),
                        response.status, data);
                    if (response.status === 409 && data.reload) {
                        showReload(error.message);
                    } else if (!options.quiet) {
                        toast(error.message, "error");
                    }
                    throw error;
                }
                return data;
            });
        }, function () {
            var error = requestError("The server cannot be reached. Is it still running?", 0, {});
            if (!options.quiet) {
                toast(error.message, "error");
            }
            throw error;
        });
    }

    /* ---------- Dialogs -------------------------------------------------- */

    // A modal dialog: {title, wide, onClose}. Returns {dialog, body, footer,
    // close(), button(text, className, onClick), submitOnEnter(fn)}. The
    // dialog is removed from the page when it closes (Esc, the x button, or
    // close()). submitOnEnter(fn) makes Enter in a one-line field call fn
    // (the dialog's main action), unless the field handles Enter itself.
    function modal(options) {
        options = options || {};
        var titleId = "dialog-title-" + Math.random().toString(36).slice(2);
        var dialog = el("dialog", {className: "modal" + (options.wide ? " modal-wide" : ""),
                                   attrs: {"aria-labelledby": titleId}});
        var head = el("div", {className: "modal-head"}, [
            el("h2", {id: titleId, text: options.title || ""})
        ]);
        var x = el("button", {type: "button", className: "modal-x", text: "\u00d7",
                              attrs: {"aria-label": "Close"}});
        head.appendChild(x);
        var body = el("div", {className: "modal-body"});
        var footer = el("div", {className: "modal-foot"});
        dialog.appendChild(head);
        dialog.appendChild(body);
        dialog.appendChild(footer);
        var closed = false;
        var handle = {
            dialog: dialog,
            body: body,
            footer: footer,
            setTitle: function (text) {
                head.firstChild.textContent = text;
            },
            close: function () {
                if (!closed && dialog.open) {
                    dialog.close();
                } else {
                    finish();
                }
            },
            button: function (text, className, onClick) {
                var button = el("button", {type: "button", className: "button " + (className || ""),
                                           text: text});
                if (onClick) {
                    button.addEventListener("click", onClick);
                }
                footer.appendChild(button);
                return button;
            },
            submitOnEnter: function (onEnter) {
                body.addEventListener("keydown", function (event) {
                    var target = event.target;
                    if (event.key !== "Enter" || event.defaultPrevented || event.isComposing ||
                            event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
                        return;
                    }
                    var tag = target.tagName;
                    if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" ||
                            tag === "SUMMARY" ||
                            (tag === "INPUT" && /^(button|submit|reset|file)$/.test(target.type))) {
                        return;
                    }
                    event.preventDefault();
                    onEnter();
                });
            }
        };
        function finish() {
            if (closed) {
                return;
            }
            closed = true;
            if (dialog.parentNode) {
                dialog.parentNode.removeChild(dialog);
            }
            if (options.onClose) {
                options.onClose();
            }
        }
        x.addEventListener("click", handle.close);
        dialog.addEventListener("close", finish);
        document.body.appendChild(dialog);
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
        // Start in the first field rather than on the close button.
        window.setTimeout(function () {
            if (!dialog.contains(document.activeElement) || document.activeElement === x) {
                var first = body.querySelector("input:not([type=hidden]):not([disabled]), " +
                                               "select, textarea");
                (first || footer.querySelector(".primary") || footer.querySelector("button") ||
                 x).focus();
            }
        }, 0);
        return handle;
    }

    // Ask a question: {title, message (text or nodes), confirmText,
    // cancelText, danger, typeName (a name the user must type first)}.
    // Resolves true when confirmed.
    function confirmDialog(options) {
        return new Promise(function (resolve) {
            var answered = false;
            var box = modal({
                title: options.title,
                onClose: function () {
                    if (!answered) {
                        answered = true;
                        resolve(false);
                    }
                }
            });
            var message = options.message;
            if (typeof message === "string") {
                box.body.appendChild(el("p", {text: message}));
            } else {
                append(box.body, message);
            }
            var input = null;
            var cancel = box.button(options.cancelText || "Cancel", "", function () {
                box.close();
            });
            var ok = box.button(options.confirmText || "OK",
                                options.danger ? "danger" : "primary", function () {
                    answered = true;
                    resolve(true);
                    box.close();
                });
            if (options.typeName) {
                input = el("input", {type: "text", className: "input", autocomplete: "off",
                                     spellcheck: false});
                box.body.appendChild(el("label", {className: "field"}, [
                    el("span", {className: "field-label",
                                text: "Type " + options.typeName + " to confirm"}),
                    input
                ]));
                ok.disabled = true;
                input.addEventListener("input", function () {
                    ok.disabled = input.value.trim().toLowerCase() !==
                        String(options.typeName).trim().toLowerCase();
                });
                input.focus();
            } else {
                // Enter must not delete anything by accident.
                (options.danger ? cancel : ok).focus();
            }
        });
    }

    // Copy text to the clipboard; resolves true when it worked.
    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () {
                return true;
            }, function () {
                return false;
            });
        }
        return Promise.resolve(false);
    }

    /* ---------- Library switcher ----------------------------------------- */

    function libraryList() {
        return (site.libraryList || []).map(function (item) {
            return {key: item.id || item.name, name: item.name};
        });
    }

    function findLibrary(key) {
        var found = null;
        libraryList().forEach(function (item) {
            if (item.key === key) {
                found = item;
            }
        });
        return found;
    }

    function initialLibrary() {
        var wanted = getState().lib;
        if (wanted === undefined || wanted === null) {
            wanted = storageGet(LIBRARY_KEY) || "";
        }
        return findLibrary(wanted) ? wanted : "";
    }

    function setLibrary(key, fromSwitcher) {
        currentLibrary = findLibrary(key) ? key : "";
        storageSet(LIBRARY_KEY, currentLibrary);
        if (libraryHandlers.length) {
            setState({lib: currentLibrary});
            libraryHandlers.forEach(function (handler) {
                handler(currentLibrary);
            });
        } else if (fromSwitcher && site.homeUrl) {
            window.location.href = site.homeUrl() +
                (currentLibrary ? "?lib=" + encodeURIComponent(currentLibrary) : "");
        }
    }

    function buildSwitcher() {
        var list = libraryList();
        if (list.length < 2 || LIBRARY_PAGES.indexOf(page) < 0) {
            return null;
        }
        var select = el("select", {id: "shell-library", attrs: {"aria-label": "Library"}});
        select.appendChild(el("option", {value: "", text: "All libraries"}));
        list.forEach(function (item) {
            select.appendChild(el("option", {value: item.key, text: item.name}));
        });
        select.value = currentLibrary;
        select.addEventListener("change", function () {
            setLibrary(select.value, true);
        });
        return el("label", {className: "shell-library"}, [
            el("span", {className: "shell-library-label", text: "Library"}),
            select
        ]);
    }

    /* ---------- Job indicator -------------------------------------------- */

    function indicatorText(snapshot) {
        var job = snapshot && snapshot.current;
        var queued = snapshot && snapshot.queue ? snapshot.queue.length : 0;
        var text = "";
        if (job) {
            if (job.remote) {
                text = jobTitle(job) + " \u00b7 run by another server";
            } else if (job.waiting || job.stage === WAITING_STAGE) {
                text = jobTitle(job) + " \u00b7 waiting for another scan to finish";
            } else {
                var verb = STAGE_VERBS[job.stage];
                text = verb ? verb + " " + (job.library_id ? jobLibrary(job) : "all libraries")
                    : jobTitle(job);
                if (job.total) {
                    text += " " + number(job.done) + "/" + number(job.total);
                }
                if (job.rate && job.state === "running") {
                    text += " \u00b7 " + number(job.rate) + "/min";
                }
                if (job.eta && job.state === "running") {
                    text += " \u00b7 ETA " + duration(job.eta);
                }
                if (job.state === "paused") {
                    text = "Paused: " + text;
                } else if (job.state === "cancelling") {
                    text = "Stopping: " + text;
                }
            }
            if (queued) {
                text += " \u00b7 " + queued + " more waiting";
            }
        } else if (snapshot && snapshot.lock && snapshot.lock.other) {
            text = otherHolderText(snapshot.lock);
        } else if (queued) {
            text = plural(queued, "job") + " waiting";
        }
        return text;
    }

    // Show the state of the jobs in the header (manage.js calls this with
    // the snapshots it polls; other pages poll for themselves).
    function showJobs(snapshot) {
        if (!jobIndicator) {
            return false;
        }
        var text = indicatorText(snapshot);
        jobIndicator.hidden = !text;
        jobIndicator.lastChild.textContent = text;
        jobIndicator.title = text ? text + " (open Manage for details)" : "";
        var job = snapshot && snapshot.current;
        jobIndicator.classList.toggle("is-paused", Boolean(job && job.state === "paused"));
        return Boolean(job || (snapshot && snapshot.queue && snapshot.queue.length));
    }

    function pollJobs() {
        window.clearTimeout(jobTimer);
        if (document.hidden) {
            return;
        }
        admin("/jobs?log=0", undefined, {quiet: true}).then(function (snapshot) {
            var active = showJobs(snapshot);
            jobTimer = window.setTimeout(pollJobs, active ? JOB_POLL_ACTIVE : JOB_POLL_IDLE);
        }, function () {
            jobTimer = window.setTimeout(pollJobs, 3 * JOB_POLL_IDLE);
        });
    }

    /* ---------- Header --------------------------------------------------- */

    function link(text, href, name) {
        return el("a", {text: text, href: href,
                        attrs: {"aria-current": page === name ? "page" : null, "data-page": name}});
    }

    // The header link to another page ("search", "map", ...), or null; the
    // search and map pages point it at the current search.
    function navLink(name) {
        var header = document.getElementById("shell-header");
        return header ? header.querySelector('nav a[data-page="' + name + '"]') : null;
    }

    /* ---------- Colour theme --------------------------------------------- */

    // "" follows the system (prefers-color-scheme); "light" or "dark" is a
    // choice kept in localStorage and set as <html data-theme="...">.
    var THEME_KEY = "searchImages.theme";
    var THEMES = ["", "light", "dark"];
    var THEME_LABELS = {"": "Theme: automatic", light: "Theme: light", dark: "Theme: dark"};

    function currentTheme() {
        var theme = storageGet(THEME_KEY) || "";
        return THEMES.indexOf(theme) >= 0 ? theme : "";
    }

    function applyTheme(theme) {
        if (theme) {
            document.documentElement.setAttribute("data-theme", theme);
        } else {
            document.documentElement.removeAttribute("data-theme");
        }
    }

    function themeButton() {
        var button = el("button", {type: "button", id: "shell-theme", className: "shell-theme"});
        function show() {
            var theme = currentTheme();
            button.setAttribute("data-theme-choice", theme || "auto");
            button.title = THEME_LABELS[theme] + " (click to change)";
            button.setAttribute("aria-label", THEME_LABELS[theme]);
        }
        button.addEventListener("click", function () {
            var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
            storageSet(THEME_KEY, next);
            applyTheme(next);
            show();
        });
        show();
        return button;
    }

    function buildHeader() {
        if (document.getElementById("shell-header")) {
            return;
        }
        var header = el("header", {id: "shell-header"});
        var home = site.homeUrl ? site.homeUrl() : "/";
        header.appendChild(el("a", {className: "shell-title", href: home,
                                    text: site.title || "Image Search"}));
        var nav = el("nav", {attrs: {"aria-label": "Pages"}});
        nav.appendChild(link("Search", home, "search"));
        // Pictures taken on this day in earlier years (on:today).
        if (site.searchUrl) {
            var today = link("", site.searchUrl({q: "on:today"}), "today");
            // (A calendar on a phone, where Manage and Settings leave no room.)
            today.className = "nav-today" + (adminOn ? " is-short" : "");
            today.title = "Pictures taken on this day in earlier years";
            today.appendChild(el("span", {className: "nav-text", text: "On this day"}));
            nav.appendChild(today);
        }
        var mapHref = site.mapUrl ? site.mapUrl() : null;
        if (mapHref) {
            nav.appendChild(link("Map", mapHref, "map"));
        }
        if (!site.isStatic) {
            // (The owner's albums; others may look at them, only the admin
            // changes them.)
            nav.appendChild(link("Albums", "/albums", "albums"));
        }
        if (adminOn) {
            nav.appendChild(link("Duplicates", "/duplicates", "duplicates"));
            nav.appendChild(link("Manage", "/manage", "manage"));
            nav.appendChild(link("Settings", "/settings", "settings"));
        }
        header.appendChild(nav);
        header.appendChild(el("span", {className: "shell-spacer"}));
        if (adminOn) {
            jobIndicator = el("a", {id: "shell-job", href: "/manage", hidden: true}, [
                el("span", {className: "shell-job-dot", attrs: {"aria-hidden": "true"}}),
                el("span", {className: "shell-job-text"})
            ]);
            header.appendChild(jobIndicator);
        }
        var switcher = buildSwitcher();
        if (switcher) {
            header.appendChild(switcher);
        }
        header.appendChild(themeButton());
        document.body.insertBefore(header, document.body.firstChild);
    }

    // As early as possible, so the page is not drawn in the other theme first.
    applyTheme(currentTheme());

    function start() {
        currentLibrary = initialLibrary();
        storageSet(LIBRARY_KEY, currentLibrary);
        if ((page === "search" || page === "map") && getState().lib !== (currentLibrary || undefined)) {
            setState({lib: currentLibrary});
        }
        buildHeader();
        // The Manage page polls the jobs itself, more often, and passes them on.
        if (adminOn && page !== "manage") {
            window.setTimeout(pollJobs, 300);
            document.addEventListener("visibilitychange", function () {
                if (!document.hidden) {
                    pollJobs();
                }
            });
        }
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener("DOMContentLoaded", start);
    }

    return {
        el: el,
        append: append,
        clear: clear,
        getState: getState,
        setState: setState,
        admin: admin,
        toast: toast,
        modal: modal,
        confirm: confirmDialog,
        copyText: copyText,
        showJobs: showJobs,
        storageGet: storageGet,
        storageSet: storageSet,
        library: function () {
            return currentLibrary;
        },
        libraryName: function () {
            var item = findLibrary(currentLibrary);
            return item ? item.name : "";
        },
        onLibraryChange: function (handler) {
            libraryHandlers.push(handler);
        },
        // Pick a library as if the switcher had been used ("" = all).
        setLibrary: function (key) {
            var select = document.getElementById("shell-library");
            if (select) {
                select.value = findLibrary(key) ? key : "";
            }
            setLibrary(key, false);
        },
        navLink: navLink,
        field: field,
        notice: notice,
        warningList: warningList,
        TEST_COST_KEY: TEST_COST_KEY,
        format: {
            number: number,
            plural: plural,
            duration: duration,
            relative: relative,
            clock: clock,
            percent: percent,
            money: money,
            bytes: bytes
        },
        jobs: {
            kind: jobKind,
            title: jobTitle,
            library: jobLibrary,
            stage: stageLabel,
            state: function (state) {
                return STATE_LABELS[state] || state;
            },
            progress: progressText,
            summary: summaryText,
            otherHolder: otherHolderText,
            WAITING_STAGE: WAITING_STAGE
        }
    };
})();
