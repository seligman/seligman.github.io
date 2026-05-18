/* Shared helpers for the search and detail pages.

   SITE hides the difference between the Flask server (data comes from the
   /api routes) and the packaged static site (data comes from JSON shards).
*/
var SITE = (function () {
    "use strict";

    var cfg = window.APP_CONFIG || {};
    var staticRecords = null;

    function loadStaticRecords(callback) {
        if (staticRecords) {
            callback(staticRecords);
            return;
        }
        fetch(cfg.data + "manifest.json").then(function (response) {
            return response.json();
        }).then(function (manifest) {
            return Promise.all(manifest.shards.map(function (name) {
                return fetch(cfg.data + name).then(function (response) {
                    return response.json();
                });
            }));
        }).then(function (parts) {
            staticRecords = [];
            parts.forEach(function (part) {
                staticRecords = staticRecords.concat(part);
            });
            callback(staticRecords);
        }).catch(function () {
            callback(null);
        });
    }

    return {
        mode: cfg.mode,
        libraries: cfg.libraries || [],

        homeUrl: function () {
            return cfg.mode === "static" ? "index.html" : "/";
        },

        detailUrl: function (id) {
            var base = cfg.mode === "static" ? "detail.html" : "/detail";
            return base + "?id=" + encodeURIComponent(id);
        },

        thumbUrl: function (rec) {
            return cfg.mode === "static" ? rec.thumb : "/thumb/" + rec.id;
        },

        imageUrl: function (rec) {
            return cfg.mode === "static" ? rec.image : "/image/" + rec.id;
        },

        loadIndex: function (callback) {
            if (cfg.mode === "static") {
                loadStaticRecords(callback);
            } else {
                fetch(cfg.api + "/index").then(function (response) {
                    return response.json();
                }).then(callback).catch(function () {
                    callback(null);
                });
            }
        },

        loadRecord: function (id, callback) {
            if (cfg.mode === "static") {
                loadStaticRecords(function (records) {
                    var found = null;
                    (records || []).forEach(function (rec) {
                        if (String(rec.id) === String(id)) {
                            found = rec;
                        }
                    });
                    callback(found);
                });
            } else {
                fetch(cfg.api + "/image/" + encodeURIComponent(id))
                    .then(function (response) {
                        return response.ok ? response.json() : null;
                    }).then(callback).catch(function () {
                        callback(null);
                    });
            }
        }
    };
})();
