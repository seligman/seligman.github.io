/* Detail page: shows metadata, EXIF, and the AI description for one image. */
(function () {
    "use strict";

    function imageId() {
        var match = /[?&]id=([^&]+)/.exec(window.location.search);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function humanSize(bytes) {
        var units = ["B", "KB", "MB", "GB"];
        var value = bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value = value / 1024;
            unit = unit + 1;
        }
        return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
    }

    function whenText(seconds) {
        if (!seconds) {
            return "";
        }
        return new Date(seconds * 1000).toLocaleString();
    }

    function factsTable(pairs) {
        var table = document.createElement("table");
        table.className = "facts";
        pairs.forEach(function (pair) {
            if (pair[1] === "" || pair[1] === null || pair[1] === undefined) {
                return;
            }
            var tr = document.createElement("tr");
            var key = document.createElement("td");
            key.className = "key";
            key.textContent = pair[0];
            var value = document.createElement("td");
            value.textContent = String(pair[1]);
            tr.appendChild(key);
            tr.appendChild(value);
            table.appendChild(tr);
        });
        return table;
    }

    function section(title, node) {
        var wrap = document.createElement("div");
        wrap.className = "section";
        var heading = document.createElement("h2");
        heading.textContent = title;
        wrap.appendChild(heading);
        wrap.appendChild(node);
        return wrap;
    }

    function chips(values) {
        var box = document.createElement("div");
        box.className = "chips";
        values.forEach(function (value) {
            var chip = document.createElement("span");
            chip.className = "chip";
            chip.textContent = value;
            box.appendChild(chip);
        });
        return box;
    }

    function paragraph(text) {
        var node = document.createElement("p");
        node.textContent = text;
        return node;
    }

    function renderImage(body, rec) {
        var frame = document.createElement("div");
        frame.className = "detail-image";
        var link = document.createElement("a");
        link.href = SITE.imageUrl(rec);
        var img = document.createElement("img");
        img.src = SITE.thumbUrl(rec);
        img.alt = rec.name;
        link.appendChild(img);
        frame.appendChild(link);
        body.appendChild(frame);

        var hint = paragraph("Click the image to view it full size.");
        hint.className = "hint";
        body.appendChild(hint);

        var name = document.createElement("div");
        name.className = "detail-name";
        name.textContent = rec.name;
        body.appendChild(name);
    }

    function renderDescription(body, info) {
        if (!info) {
            var none = paragraph("This image has not been described yet.");
            none.className = "hint";
            body.appendChild(section("Description", none));
            return;
        }
        var block = document.createElement("div");
        block.appendChild(paragraph(info.description || ""));
        if (info.subjects && info.subjects.length) {
            block.appendChild(section("Subjects", chips(info.subjects)));
        }
        if (info.tags && info.tags.length) {
            block.appendChild(section("Tags", chips(info.tags)));
        }
        if (info.colors && info.colors.length) {
            block.appendChild(section("Colors", chips(info.colors)));
        }
        if (info.text) {
            block.appendChild(section("Text in image", paragraph(info.text)));
        }
        body.appendChild(section("Description", block));
    }

    function renderExif(body, exif) {
        var pairs = [];
        var gps = null;
        Object.keys(exif || {}).forEach(function (key) {
            if (key === "GPS") {
                gps = exif[key];
                return;
            }
            var value = exif[key];
            if (Array.isArray(value)) {
                value = value.join(", ");
            }
            pairs.push([key, value]);
        });
        if (pairs.length) {
            body.appendChild(section("EXIF", factsTable(pairs)));
        }
        if (gps) {
            var gpsPairs = Object.keys(gps).map(function (key) {
                var value = gps[key];
                if (Array.isArray(value)) {
                    value = value.join(", ");
                }
                return [key, value];
            });
            body.appendChild(section("GPS", factsTable(gpsPairs)));
        }
    }

    function render(rec) {
        var body = document.getElementById("detail-body");
        body.innerHTML = "";
        renderImage(body, rec);
        body.appendChild(section("File", factsTable([
            ["Library", rec.library],
            ["Path", rec.path],
            ["Dimensions", rec.width + " x " + rec.height + " pixels"],
            ["Size", humanSize(rec.size)],
            ["Modified", whenText(rec.mtime)]
        ])));
        renderDescription(body, rec.info);
        renderExif(body, rec.exif);
    }

    function init() {
        document.getElementById("back").href = SITE.homeUrl();
        var id = imageId();
        var body = document.getElementById("detail-body");
        if (!id) {
            body.textContent = "No image selected.";
            return;
        }
        SITE.loadRecord(id, function (rec) {
            if (!rec) {
                body.textContent = "Image not found.";
                return;
            }
            render(rec);
        });
    }

    document.addEventListener("DOMContentLoaded", init);
})();
