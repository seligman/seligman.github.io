/* Search page: instant client-side filtering over a thumbnail grid. */
(function () {
    "use strict";

    var records = [];

    function el(id) {
        return document.getElementById(id);
    }

    function setupLibraries() {
        var select = el("library");
        if (SITE.libraries.length <= 1) {
            select.style.display = "none";
        }
        var all = document.createElement("option");
        all.value = "__all__";
        all.textContent = "All libraries";
        select.appendChild(all);
        SITE.libraries.forEach(function (name) {
            var option = document.createElement("option");
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    }

    function tile(rec) {
        var link = document.createElement("a");
        link.className = "tile";
        link.href = SITE.detailUrl(rec.id);
        var img = document.createElement("img");
        img.loading = "lazy";
        img.src = SITE.thumbUrl(rec);
        img.alt = rec.name;
        link.appendChild(img);
        return link;
    }

    function message(text) {
        var grid = el("grid");
        grid.innerHTML = "";
        var box = document.createElement("div");
        box.className = "message";
        box.textContent = text;
        grid.appendChild(box);
    }

    function update() {
        var query = el("query").value.trim().toLowerCase();
        var library = el("library").value || "__all__";
        var terms = query.split(/\s+/).filter(Boolean);
        var matches = records.filter(function (rec) {
            if (library !== "__all__" && rec.library !== library) {
                return false;
            }
            var hay = rec.text || "";
            return terms.every(function (term) {
                return hay.indexOf(term) >= 0;
            });
        });
        if (!matches.length) {
            message(records.length ? "No images match." : "No images yet.");
            return;
        }
        var grid = el("grid");
        grid.innerHTML = "";
        matches.slice(0, 500).forEach(function (rec) {
            grid.appendChild(tile(rec));
        });
    }

    function init() {
        setupLibraries();
        el("query").addEventListener("input", update);
        el("library").addEventListener("change", update);
        message("Loading...");
        SITE.loadIndex(function (loaded) {
            if (!loaded) {
                message("Could not load the image index.");
                return;
            }
            records = loaded;
            update();
        });
    }

    document.addEventListener("DOMContentLoaded", init);
})();
