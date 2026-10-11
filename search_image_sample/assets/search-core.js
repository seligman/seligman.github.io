/* The search engine of the search page, shared by the server pages and the
   static export: query parsing, matching and ranking, facets, duplicate
   stacks, match highlights, "did you mean" and "more like this".

   It works on the compact records of /api/index (search_index.py lists
   the keys: i id, l library, n file name, f folder, t title,
   d description, s subjects, g tags, o text in the picture, a animals,
   fo food, v vehicles, pd people descriptors, sc scene, st setting,
   td time of day, ev event, pp people, ty photo type, dt document type,
   c colors, ex extended words, q aesthetic, sh sharpness, qf quality
   flags, se sensitive, pr private, dk date taken, ts date and time taken,
   cm camera, gp has GPS, p "360", dg duplicate group, h hidden,
   ds described, v4). Any key may be missing. There is no DOM code here:
   the same file runs in the browser (also from file:// in an export) and
   under Node for the tests (tests/js/search_core_test.js).

   SearchCore.search(records, query, options)
       -> {total, items, facets, groups, collapsed, sort, query, warnings}
     records  the "records" list of /api/index, or SearchCore.prepare(records).
              The words, facet values, dates and duplicate groups of the
              records are worked out once and kept for that array; call
              prepare() again (or pass a new array) after records were
              added, removed or changed. A changed h (hidden, after Hide
              or Unhide) is seen at once without that.
     query    what was typed in the search box (or a parse() result).
     options  library    a library id or a list of ids ("" or "all": all)
              libraries  [{id, name}] of the index, for lib:<name>
              sort       "relevance" (the default when there are words to
                         look for), "newest" (the default otherwise),
                         "oldest", "name" or "quality"
              filters    facet selections {group: [values]}: the values of
                         one group are alternatives (OR), the groups must
                         all match (AND); every "has" value must match
              group      true: show each duplicate group once, at the place
                         of its best-ranked match, as its cover
              hidden     true: include hidden pictures (admin)
              sensitive  true or "show": include explicit and graphic
                         pictures; "strict": also leave out suggestive
                         ones; default: leave out explicit and graphic ones
              private    false: leave out pictures showing private
                         information (default: include them)
              junk       true: leave out pictures flagged accidental or
                         blurry
              typing     true while the query is still being typed: the
                         last word may be the start of a longer word (see
                         parse)
     total     how many pictures match (before duplicates are grouped)
     items     the ids of the matches in order (one per stack when grouping;
               when sorted by date a stack sits at its cover's date)
     facets    {group: [{value, count, selected}]} for every group of
               SearchCore.FACETS (labels: SearchCore.facetLabel). Counts
               are over the matches of the query with the selections of
               every other group applied, but not the group's own
               (disjunctive facets). "month" is only filled while a year
               (or month) is selected. Selected values are always listed.
     groups    when grouping: {shown id: [ids of the stack, shown id first]}
               for every stack of two or more matches
     collapsed how many matches are folded into stacks
     sort      the order used; query: the parse() result as searched (pass
               it to highlights() so the marks agree with the matches);
               warnings: notes about parts of the query that could not be
               understood

   SearchCore.parse(query, options) -> {text, clauses, terms, sequence, ...}
     Never throws. Words must all match (AND), "quoted phrases" must match
     in order, -word / -"phrase" / -field:value exclude, OR (upper case, or
     a lower-case "or" between two words) makes alternatives. "no people"
     (or "without people") is people:none. field:value filters: tag:, subject:,
     title:, text: (the text in the picture), description:, scene:,
     setting:, event:, animal:, food:, vehicle:, color:, camera:, folder:,
     file: (words in that field); type: (photo, screenshot, document,
     receipt, chat, ...), people: (none, 1, 2, 3-5, 6-10, crowd, any or a
     number), year: (2019 or 2015-2019), before: / after: (YYYY, YYYY-MM or
     YYYY-MM-DD, not including that period), lib: (library name or id),
     has: (text, gps, people, animals, food, vehicles, description) and
     is: (360, duplicate, hidden, undescribed, described, private,
     sensitive, blurry, dark, overexposed, accidental, junk, v4 or a type).
     Another word before a colon is searched as ordinary text. With
     options.typing (the page sets it only while the box is being typed
     in) the last word, when the text does not end with a space, also
     matches the start of longer words -- but only when it is not a word
     of the records itself ("cat" finds cats, "cate" finds caterpillars),
     and such matches score well below whole words. Small words such as
     "the" and "of", and filler such as "my", "show me" and "pictures of",
     are skipped unless they are all there is.

   SearchCore.highlights(text, query, field) -> [[start, end], ...]
     Ranges of text (string offsets, end exclusive, sorted, not
     overlapping) that the query matches, for the page to wrap in <mark>
     elements built with DOM calls. field ("t", "d", "o", ... or "title",
     "description", "text") leaves out terms that are limited to another
     field.

   SearchCore.similar(records, id, n, options) -> [ids]
     "More like this": the picture's duplicate group first, then pictures
     sharing tags and subjects (Jaccard overlap), the same scene or event,
     or taken within two hours (the same day in an export, which has no
     times); one picture per other duplicate group. options: library,
     hidden, sensitive, private, junk as above.

   SearchCore.suggest(records, query, options)
       -> {text, changes: [{from, to}]} | null
     A corrected query for words that match nothing ("did you mean"), from
     the words of the tags first (edit distance up to 2; 1 for short words).
     Skipped words are never corrected, and a correction that would find
     nothing either (with options, as for search) is not offered.

   Also: prepare(records) -> index with the same search / similar /
   suggest methods and get(id); normalize(text); tokens(text); fold(word)
   (the singular a word is searched as); forms(word); facetLabel(group,
   value); FACETS; SORTS; SYNTAX (examples for a help popover).

   Plain ES5 syntax (an IIFE, var, no arrow functions) like the other page
   scripts; no eval, no build step.
*/
var SearchCore = (function () {
    "use strict";

    /* ---------- Small helpers ---------------------------------------------- */

    var hasOwn = Object.prototype.hasOwnProperty;

    // A lookup table without a prototype, so keys like "constructor" are safe.
    function dict(source) {
        var out = Object.create(null);
        var key;
        for (key in source) {
            if (hasOwn.call(source, key)) {
                out[key] = source[key];
            }
        }
        return out;
    }

    function wordSet(words) {
        var out = Object.create(null);
        words.split(" ").forEach(function (word) {
            if (word) {
                out[word] = true;
            }
        });
        return out;
    }

    function isText(value) {
        return typeof value === "string" && value !== "";
    }

    // The non-empty strings of a value that should be a list (or one string).
    function textList(value) {
        if (typeof value === "string") {
            return value ? [value] : [];
        }
        var out = [];
        if (Array.isArray(value)) {
            for (var k = 0; k < value.length; k++) {
                if (isText(value[k])) {
                    out.push(value[k]);
                }
            }
        }
        return out;
    }

    function startsWith(text, prefix) {
        return text.lastIndexOf(prefix, 0) === 0;
    }

    function unicodeRegExp(source, flags, fallback) {
        try {
            return new RegExp(source, flags);
        } catch (error) {
            return fallback;
        }
    }

    function filled(length, value) {
        var out = new Float64Array(length);
        out.fill(value);
        return out;
    }

    /* ---------- Normalisation ---------------------------------------------- */

    var APOSTROPHE_CHARS = "'`\u00b4\u2018\u2019\u201b\u02bc\u2032";
    var APOSTROPHES = new RegExp("[" + APOSTROPHE_CHARS + "]", "g");
    // Combining marks removed after NFKD: accents, kana voicing marks.
    var COMBINING = new RegExp("[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff" +
                               "\ufe20-\ufe2f\u3099\u309a]", "g");
    // Letters NFKD does not take apart.
    var SPECIAL_LETTERS = dict({"\u00df": "ss", "\u00e6": "ae", "\u0153": "oe", "\u00f8": "o",
                                "\u0111": "d", "\u00f0": "d", "\u0142": "l", "\u00fe": "th",
                                "\u0131": "i", "\u0127": "h"});
    var SPECIAL_RE = /[\u00df\u00e6\u0153\u00f8\u0111\u00f0\u0142\u00fe\u0131\u0127]/g;
    var NON_ASCII = /[^\x00-\x7f]/;
    // Chinese and Japanese have no spaces between words: every character is
    // a word of its own, and words typed together must be found together.
    var CJK = "\u3005\u3006\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff";
    var CJK_TEST = new RegExp("[" + CJK + "]");
    var CJK_ALL = new RegExp("[" + CJK + "]", "g");
    // Letters and digits for engines without Unicode property escapes.
    var FALLBACK_LETTERS = "0-9a-zA-Z\u00aa\u00b5\u00ba\u00c0-\u00d6\u00d8-\u00f6" +
        "\u00f8-\u02af\u0300-\u036f\u0370-\u03ff\u0400-\u052f\u0531-\u0587" +
        "\u0591-\u05f2\u0620-\u064a\u0660-\u0669\u066e-\u06d3\u0900-\u0dff" +
        "\u0e00-\u0e7f\u1100-\u11ff\u1e00-\u1fff\u3040-\u30ff\u3400-\u4dbf" +
        "\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff";
    var ASCII_SEPARATORS = /[^a-z0-9]+/;
    var SEPARATORS = unicodeRegExp("[^\\p{L}\\p{N}\\p{M}]+", "u",
                                   new RegExp("[^" + FALLBACK_LETTERS + "]+"));
    // One word of the original text (for highlights): a Chinese or Japanese
    // character, or a run of other letters, digits and apostrophes.
    var WORD_RE = unicodeRegExp(
        "[" + CJK + "]|(?:(?![" + CJK + "])[\\p{L}\\p{N}\\p{M}" + APOSTROPHE_CHARS + "])+", "gu",
        new RegExp("[" + CJK + "]|(?:(?![" + CJK + "])[" + FALLBACK_LETTERS + APOSTROPHE_CHARS +
                   "])+", "g"));

    function specialLetter(letter) {
        return SPECIAL_LETTERS[letter];
    }

    /* Lower case, accents removed (NFKD), apostrophes removed ("don't" is
       "dont"), and a few letters spelled out (a sharp s is "ss"). */
    function normalize(text) {
        if (text === null || text === undefined) {
            return "";
        }
        var value = String(text).toLowerCase();
        if (!NON_ASCII.test(value)) {
            return value.indexOf("'") >= 0 || value.indexOf("`") >= 0
                ? value.replace(APOSTROPHES, "") : value;
        }
        value = value.replace(APOSTROPHES, "");
        if (typeof value.normalize === "function") {
            value = value.normalize("NFKD");
        }
        return value.replace(COMBINING, "").toLowerCase().replace(APOSTROPHES, "")
            .replace(SPECIAL_RE, specialLetter);
    }

    // The words of normalized text.
    function splitWords(value) {
        var parts;
        if (!NON_ASCII.test(value)) {
            parts = value.split(ASCII_SEPARATORS);
        } else {
            if (CJK_TEST.test(value)) {
                value = value.replace(CJK_ALL, " $& ");
            }
            parts = value.split(SEPARATORS);
        }
        var out = [];
        for (var k = 0; k < parts.length; k++) {
            if (parts[k]) {
                out.push(parts[k]);
            }
        }
        return out;
    }

    function tokens(text) {
        return splitWords(normalize(text));
    }

    /* ---------- Plurals ---------------------------------------------------- */

    var IRREGULAR_PLURALS = dict({
        men: "man", women: "woman", children: "child", people: "person", mice: "mouse",
        geese: "goose", feet: "foot", teeth: "tooth", oxen: "ox", cacti: "cactus",
        fungi: "fungus"
    });
    var formsCache = Object.create(null);
    var formsCacheSize = 0;

    /* The forms a normalized word is searched by: the word itself, then
       (for an English plural) the singular, then other possible singulars.
       A word matches another when their forms meet, so "cats" finds "cat",
       "cookie" finds "cookies" and "berries" finds "berry". Words of three
       letters or less, and words ending in "ss", are left alone. */
    function computeForms(word) {
        var forms = [word];
        var irregular = IRREGULAR_PLURALS[word];
        if (irregular) {
            forms.push(irregular);
            return forms;
        }
        var length = word.length;
        if (length <= 3 || word.charAt(length - 1) !== "s") {
            return forms;
        }
        var before = word.charAt(length - 2);
        if (before < "a" || before > "z" || before === "s") {
            return forms;                               // 1990s, glass
        }
        var stem = word.slice(0, -1);
        if (before === "u" || before === "i") {         // cactus, tennis; menus, kiwis
            forms.push(stem);
        } else if (/ies$/.test(word)) {                 // berries, cookies; ties
            if (length > 4) {
                forms.push(word.slice(0, -3) + "y");
            }
            forms.push(stem);
        } else if (/(?:ss|x|z|ch|sh)es$/.test(word)) {  // glasses, boxes, beaches
            forms.push(word.slice(0, -2), stem);
        } else if (/[os]es$/.test(word)) {              // shoes, tomatoes, horses, buses
            forms.push(stem);
            // Not "to" for toes or "go" for goes: such short forms are
            // common words of every description.
            if (length - 2 >= 3) {
                forms.push(word.slice(0, -2));
            }
        } else if (/ves$/.test(word)) {                 // waves, leaves, knives
            forms.push(stem, word.slice(0, -3) + "f", word.slice(0, -3) + "fe");
        } else {
            forms.push(stem);                           // cats, plates
        }
        return forms;
    }

    function wordForms(word) {
        var known = formsCache[word];
        if (known) {
            return known;
        }
        if (formsCacheSize >= 50000) {
            formsCache = Object.create(null);
            formsCacheSize = 0;
        }
        known = computeForms(word);
        formsCache[word] = known;
        formsCacheSize += 1;
        return known;
    }

    // The one singular a normalized word is filed under.
    function foldWord(word) {
        var forms = wordForms(word);
        if (forms.length < 2) {
            return word;
        }
        var before = word.charAt(word.length - 2);
        return !IRREGULAR_PLURALS[word] && (before === "u" || before === "i") ? word : forms[1];
    }

    /* ---------- Fields and weights ----------------------------------------- */

    // Every searchable field is a bit of a mask; WEIGHTS[bit] is its score.
    // F_DATE holds the month name of the capture date (weak: "may" and
    // "march" are ordinary words too); F_YEAR its year, which counts about
    // as much as a title word, so "receipt 2019" prefers receipts taken in
    // 2019 over ones that merely mention the year.
    var F_TITLE = 0, F_TAGS = 1, F_SUBJECTS = 2, F_ANIMALS = 3, F_FOOD = 4, F_VEHICLES = 5,
        F_PEOPLE = 6, F_SCENE = 7, F_EVENT = 8, F_SETTING = 9, F_KIND = 10, F_TEXT = 11,
        F_DESCRIPTION = 12, F_EXTENDED = 13, F_COLORS = 14, F_FLAGS = 15, F_FOLDER = 16,
        F_FILE = 17, F_CAMERA = 18, F_DATE = 19, F_YEAR = 20;
    var WEIGHTS = [10, 7, 6, 6, 6, 6, 6, 4, 4, 4, 4, 4, 3, 3, 2, 2, 1, 1, 1, 1, 8];
    var ALL_FIELDS = (1 << WEIGHTS.length) - 1;
    // A word matched only as the start of a longer word (while typing)
    // scores this much less: even in a title (2.5) it stays below a whole
    // word anywhere but the weakest fields.
    var PREFIX_FACTOR = 0.25;
    // Each further field a word matches in adds this part of its weight.
    var EXTRA_FIELD_FACTOR = 0.2;
    // A "quoted phrase" found word for word in the title, description or text.
    var PHRASE_BONUS = 15;
    var PHRASE_FIELDS = (1 << F_TITLE) | (1 << F_DESCRIPTION) | (1 << F_TEXT);
    // The words of an unquoted query of several words found together, in
    // order: a small push, more in the title than in the description or
    // text, so a picture that is about them still beats one that only
    // mentions them in passing.
    var SEQUENCE_TITLE_BONUS = 6;
    var SEQUENCE_TEXT_BONUS = 3;

    // field: names -> the fields they search.
    var FIELD_MASKS = dict({
        tag: 1 << F_TAGS, subject: 1 << F_SUBJECTS, title: 1 << F_TITLE, text: 1 << F_TEXT,
        description: 1 << F_DESCRIPTION, scene: 1 << F_SCENE, setting: 1 << F_SETTING,
        event: 1 << F_EVENT, animal: 1 << F_ANIMALS, food: 1 << F_FOOD,
        vehicle: 1 << F_VEHICLES, color: 1 << F_COLORS, camera: 1 << F_CAMERA,
        folder: 1 << F_FOLDER, file: 1 << F_FILE
    });
    // Field names (and their other spellings) known to the parser.
    var FIELD_NAMES = dict({
        tag: "tag", tags: "tag", subject: "subject", subjects: "subject", title: "title",
        text: "text", ocr: "text", description: "description", desc: "description",
        scene: "scene", setting: "setting", event: "event", animal: "animal",
        animals: "animal", food: "food", vehicle: "vehicle", vehicles: "vehicle",
        color: "color", colour: "color", colors: "color", colours: "color",
        camera: "camera", folder: "folder", file: "file", filename: "file", type: "type",
        people: "people", year: "year", before: "before", after: "after", lib: "lib",
        library: "lib", has: "has", is: "is"
    });
    // Record keys (and field names) for highlights(text, query, field).
    var HIGHLIGHT_FIELDS = dict({
        t: F_TITLE, title: F_TITLE, g: F_TAGS, tags: F_TAGS, s: F_SUBJECTS,
        subjects: F_SUBJECTS, a: F_ANIMALS, fo: F_FOOD, v: F_VEHICLES, pd: F_PEOPLE,
        sc: F_SCENE, st: F_SETTING, ev: F_EVENT, ty: F_KIND, dt: F_KIND, td: F_KIND,
        o: F_TEXT, text: F_TEXT, d: F_DESCRIPTION, description: F_DESCRIPTION,
        ex: F_EXTENDED, c: F_COLORS, qf: F_FLAGS, f: F_FOLDER, n: F_FILE, cm: F_CAMERA
    });

    var MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
                  "september", "october", "november", "december"];
    var MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July",
                        "August", "September", "October", "November", "December"];

    function enumWords(value) {
        return value.replace(/_or_/g, " ").replace(/_/g, " ");
    }

    // [field, [texts], field, [texts], ...] of a record: what its words are.
    function recordTexts(rec) {
        var out = [];
        function add(field, values) {
            if (values.length) {
                out.push(field, values);
            }
        }
        add(F_TITLE, textList(rec.t));
        add(F_TAGS, textList(rec.g));
        add(F_SUBJECTS, textList(rec.s));
        add(F_ANIMALS, textList(rec.a));
        add(F_FOOD, textList(rec.fo));
        add(F_VEHICLES, textList(rec.v));
        add(F_PEOPLE, textList(rec.pd));
        add(F_SCENE, textList(rec.sc));
        if (isText(rec.ev) && rec.ev !== "none" && rec.ev !== "other") {
            add(F_EVENT, [enumWords(rec.ev)]);
        }
        if (isText(rec.st) && rec.st !== "unknown") {
            add(F_SETTING, [rec.st]);
        }
        var kind = [];
        if (isText(rec.ty) && rec.ty !== "other") {
            kind.push(rec.ty);
        }
        if (isText(rec.dt) && rec.dt !== "none" && rec.dt !== "other") {
            kind.push(enumWords(rec.dt));
        }
        if (isText(rec.td) && rec.td !== "unknown") {
            kind.push(enumWords(rec.td));
        }
        if (rec.p === "360") {
            kind.push("360 panorama");
        }
        // "people" and "person" find every picture with people in it (and
        // -people leaves them out), not only those whose description
        // happens to use the word.
        if (isText(rec.pp) && rec.pp !== "none") {
            kind.push(rec.pp === "crowd" ? "people person crowd" : "people person");
        }
        add(F_KIND, kind);
        add(F_TEXT, textList(rec.o));
        add(F_DESCRIPTION, textList(rec.d));
        add(F_EXTENDED, isText(rec.ex) ? rec.ex.split(/\s*,\s*/) : []);
        add(F_COLORS, textList(rec.c));
        add(F_FLAGS, textList(rec.qf).map(enumWords));
        add(F_FOLDER, textList(rec.f));
        add(F_FILE, textList(rec.n));
        add(F_CAMERA, textList(rec.cm));
        var date = isText(rec.dk) ? /^(\d{4})-(\d{2})/.exec(rec.dk) : null;
        if (date) {
            var month = parseInt(date[2], 10);
            add(F_YEAR, [date[1]]);
            if (month >= 1 && month <= 12) {
                add(F_DATE, [MONTHS[month - 1]]);
            }
        }
        return out;
    }

    // The score of a word matched exactly in the fields of one mask and as
    // the start of a longer word in those of another.
    function maskScore(exact, partial) {
        var best = 0;
        var sum = 0;
        var weight;
        var field;
        for (field = 0; exact >> field; field++) {
            if (exact >> field & 1) {
                weight = WEIGHTS[field];
                sum += weight;
                if (weight > best) {
                    best = weight;
                }
            }
        }
        for (field = 0; partial >> field; field++) {
            if (partial >> field & 1) {
                weight = WEIGHTS[field] * PREFIX_FACTOR;
                sum += weight;
                if (weight > best) {
                    best = weight;
                }
            }
        }
        return best + EXTRA_FIELD_FACTOR * (sum - best);
    }

    /* ---------- Query parsing ---------------------------------------------- */

    var MAX_QUERY_LENGTH = 1000;
    var MAX_TERMS = 40;
    var SPACE = /\s/;
    var FIELD_RE = /^([A-Za-z]{1,12}):/;
    var QUOTES = "\"\u201c\u201d\u201e";
    var OR_WORDS = wordSet("OR | ||");
    var AND_WORDS = wordSet("AND && &");
    // Words skipped when the query has better ones (see skipLevel): the
    // descriptions rarely contain them, so requiring them finds nothing.
    var STOP_WORDS = wordSet("a an and are as at be by for from in into is it its of on or " +
                             "the to with this that these those there was were");
    var FILLER_WORDS = wordSet("my our your me i we show find all");
    var NOUN_FILLERS = wordSet("picture pic photo photograph image");
    // "no people" and "without people" mean people:none.
    var NO_WORDS = wordSet("no without");
    var PEOPLE_NOUNS = wordSet("people person persons human humans anyone anybody");

    var PHOTO_TYPES = ["photo", "screenshot", "document", "scan", "artwork", "meme", "diagram",
                       "other"];
    var DOCUMENT_TYPES = ["receipt", "chat", "web", "app", "whiteboard", "sign", "menu",
                          "letter", "form", "ticket", "card_or_id", "book_page", "handwriting",
                          "slide", "map", "other"];
    var PEOPLE_VALUES = ["none", "1", "2", "3-5", "6-10", "crowd"];
    var SETTINGS = ["indoor", "outdoor", "vehicle"];
    var TIMES = ["day", "sunrise_sunset", "night"];
    var PHOTO_TYPE_SET = wordSet(PHOTO_TYPES.join(" "));
    var DOCUMENT_TYPE_SET = wordSet(DOCUMENT_TYPES.join(" "));

    // Other words for the types (type: and is:).
    var TYPE_WORDS = dict({
        photograph: "photo", picture: "photo", pic: "photo", screen: "screenshot",
        screencap: "screenshot", screengrab: "screenshot", screen_shot: "screenshot",
        doc: "document", paper: "document", scanned: "scan", art: "artwork",
        drawing: "artwork", painting: "artwork", illustration: "artwork", sketch: "artwork",
        chart: "diagram", graph: "diagram", message: "chat", conversation: "chat",
        sms: "chat", text_message: "chat", website: "web", webpage: "web", web_page: "web",
        application: "app", board: "whiteboard", handwritten: "handwriting",
        note: "handwriting", card: "card_or_id", id: "card_or_id", ids: "card_or_id",
        id_card: "card_or_id", card_id: "card_or_id", book: "book_page", page: "book_page",
        presentation: "slide", invoice: "receipt", bill: "receipt", "360": "360",
        panorama: "360", pano: "360"
    });
    var PEOPLE_WORDS = dict({
        none: "none", no: "none", nobody: "none", nobodies: "none", zero: "none",
        one: "1", single: "1", solo: "1", two: "2", couple: "2", pair: "2", few: "3-5",
        group: "3-5", several: "3-5", many: "6-10", crowd: "crowd", lots: "crowd",
        any: "any", some: "any", yes: "any", "3-5": "3-5", "6-10": "6-10"
    });
    var HAS_WORDS = dict({
        text: "text", ocr: "text", word: "text", writing: "text", gps: "gps",
        location: "gps", geo: "gps", position: "gps", coordinate: "gps", place: "gps",
        people: "people", person: "people", animal: "animals", pet: "animals",
        food: "food", vehicle: "vehicles", car: "vehicles", description: "description",
        caption: "description"
    });
    var IS_WORDS = dict({
        "360": "360", panorama: "360", pano: "360", duplicate: "duplicate",
        dup: "duplicate", dupe: "duplicate", hidden: "hidden", undescribed: "undescribed",
        pending: "undescribed", described: "described", private: "private",
        sensitive: "sensitive", blurry: "blurry", blur: "blurry", dark: "dark",
        overexposed: "overexposed", accidental: "accidental", screen_photo: "screen_photo",
        junk: "junk", v4: "v4", old: "v4"
    });
    var QUALITY_FLAGS = wordSet("blurry dark overexposed accidental screen_photo");

    // A value of a word table, tried as typed and as its singular.
    function lookupWord(table, value) {
        var key = value.replace(/[\s_]+/g, "_").replace(/^_+|_+$/g, "");
        if (table[key] !== undefined) {
            return table[key];
        }
        var forms = wordForms(key);
        for (var k = 1; k < forms.length; k++) {
            if (table[forms[k]] !== undefined) {
                return table[forms[k]];
            }
        }
        return undefined;
    }

    function typeFilter(value) {
        var key = value.replace(/[\s-]+/g, "_");
        var forms = wordForms(key);
        for (var k = 0; k < forms.length; k++) {
            var name = forms[k];
            if (TYPE_WORDS[name] !== undefined) {
                name = TYPE_WORDS[name];
            }
            if (name === "360") {
                return {kind: "360"};
            }
            if (name === "other") {
                return {kind: "other_type"};
            }
            if (PHOTO_TYPE_SET[name]) {
                return {kind: "photo_type", value: name};
            }
            if (DOCUMENT_TYPE_SET[name]) {
                return {kind: "document_type", value: name};
            }
        }
        return null;
    }

    function peopleFilter(value) {
        if (/^\d+$/.test(value)) {
            var count = parseInt(value, 10);
            var bucket = count === 0 ? "none" : count <= 2 ? String(count)
                : count <= 5 ? "3-5" : count <= 10 ? "6-10" : "crowd";
            return {kind: "people", value: bucket};
        }
        var found = lookupWord(PEOPLE_WORDS, value);
        if (found === undefined) {
            return null;
        }
        return found === "any" ? {kind: "people_any"} : {kind: "people", value: found};
    }

    function yearFilter(value) {
        var match = /^(\d{4})(?:\s*(-|\.\.|\u2013|to)\s*(\d{4})?)?$/.exec(value);
        if (!match) {
            return null;
        }
        var from = parseInt(match[1], 10);
        var to = match[3] ? parseInt(match[3], 10) : match[2] ? 9999 : from;
        return {kind: "year", from: Math.min(from, to), to: Math.max(from, to)};
    }

    // "2019", "2019-05" or "2019-05-14" (also with / or .) -> the same text
    // with two-digit months and days, or null.
    function dateKey(value) {
        var match = /^(\d{4})(?:[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?)?$/.exec(value);
        if (!match) {
            return null;
        }
        var key = match[1];
        if (match[2]) {
            var month = parseInt(match[2], 10);
            if (month < 1 || month > 12) {
                return null;
            }
            key += "-" + (month < 10 ? "0" : "") + month;
            if (match[3]) {
                var day = parseInt(match[3], 10);
                if (day < 1 || day > 31) {
                    return null;
                }
                key += "-" + (day < 10 ? "0" : "") + day;
            }
        }
        return key;
    }

    // The filter of a field:value term, or null (with a warning) when the
    // value is not understood.
    function parseFilter(field, raw, warnings) {
        var value = normalize(raw).replace(/^\s+|\s+$/g, "");
        var filter = null;
        var hint = "";
        if (field === "type") {
            filter = typeFilter(value);
            hint = "try photo, screenshot, document, receipt, chat or 360";
        } else if (field === "people") {
            filter = peopleFilter(value);
            hint = "try none, 1, 2, 3-5, 6-10, crowd or any";
        } else if (field === "year") {
            filter = yearFilter(value);
            hint = "try 2019 or 2015-2019";
        } else if (field === "before" || field === "after") {
            var key = dateKey(value);
            filter = key ? {kind: field, key: key} : null;
            hint = "try 2019, 2019-05 or 2019-05-14";
        } else if (field === "lib") {
            filter = {kind: "lib", value: String(raw).replace(/^\s+|\s+$/g, "")};
        } else if (field === "has") {
            var what = lookupWord(HAS_WORDS, value);
            filter = what ? {kind: "has", what: what} : null;
            hint = "try text, gps, people, animals, food or vehicles";
        } else if (field === "is") {
            var state = lookupWord(IS_WORDS, value);
            filter = state ? {kind: "is", what: state} : typeFilter(value);
            hint = "try 360, duplicate, undescribed, screenshot or document";
        }
        if (!filter) {
            warnings.push(field + ":" + raw + " is not understood (" + hint + ").");
        }
        return filter;
    }

    function quoteAt(text, index) {
        return QUOTES.indexOf(text.charAt(index)) >= 0;
    }

    // A quoted value starting at text[index]: {value, end, closed}.
    function readQuoted(text, index) {
        var end = index + 1;
        while (end < text.length && !quoteAt(text, end)) {
            end += 1;
        }
        var closed = end < text.length;
        return {value: text.slice(index + 1, end), end: closed ? end + 1 : end, closed: closed,
                start: index + 1, stop: end};
    }

    function readBare(text, index) {
        var end = index;
        while (end < text.length && !SPACE.test(text.charAt(end))) {
            end += 1;
        }
        return {value: text.slice(index, end), end: end, closed: true, start: index, stop: end};
    }

    /* How readily a plain word is skipped: 0 never; 1 "photo", "pictures"
       (skipped when there are other words); 2 "my", "show", "me" (also
       when only words of level 1 are left); 3 "the", "of" (unless they are
       all there is). */
    function skipLevel(term) {
        if (term.field || term.quoted || term.neg || term.kind !== "word") {
            return 0;
        }
        var word = term.words[0];
        if (STOP_WORDS[word]) {
            return 3;
        }
        if (FILLER_WORDS[word]) {
            return 2;
        }
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            if (NOUN_FILLERS[forms[k]]) {
                return 1;
            }
        }
        return 0;
    }

    // Fills in what a term looks for; false when it looks for nothing.
    function analyze(term, warnings) {
        term.prefix = false;
        term.stop = false;
        term.level = 0;
        term.active = true;
        term.filter = null;
        term.invalid = false;
        if (term.field && FIELD_MASKS[term.field] === undefined) {
            term.kind = "filter";
            term.words = [];
            term.mask = 0;
            term.filter = parseFilter(term.field, term.value, warnings);
            term.invalid = !term.filter;
            return true;
        }
        term.words = tokens(term.value);
        if (!term.words.length) {
            return false;
        }
        if (term.words.length > MAX_TERMS) {
            term.words = term.words.slice(0, MAX_TERMS);
        }
        term.kind = term.quoted || term.words.length > 1 ? "phrase" : "word";
        term.mask = term.field ? FIELD_MASKS[term.field] : ALL_FIELDS;
        term.level = skipLevel(term);
        term.stop = term.level > 0;
        return true;
    }

    function emptyQuery(text) {
        return {text: text, clauses: [], terms: [], sequence: null, hasText: false,
                wantsHidden: false, warnings: [], empty: true, typing: false};
    }

    function plainItem(item) {
        return Boolean(item) && typeof item === "object" && !item.field && !item.quoted &&
            !item.neg;
    }

    // The one normalized word of a plain item ("" otherwise).
    function bareWord(item) {
        if (!plainItem(item)) {
            return "";
        }
        var words = tokens(item.value);
        return words.length === 1 ? words[0] : "";
    }

    /* Plain-language parts of the item list: "no people" / "without
       people" become the filter people:none, and a lower-case "or" between
       two terms means OR (upper case is already OR; at the end of the text
       it may be a word being typed). */
    function plainLanguage(items) {
        var out = [];
        for (var k = 0; k < items.length; k++) {
            var item = items[k];
            var next = items[k + 1];
            var word = bareWord(item);
            if (NO_WORDS[word] === true && PEOPLE_NOUNS[bareWord(next)] === true) {
                out.push({field: "people", value: "none", quoted: false, closed: true,
                          neg: false, start: item.start, end: next.end,
                          valueStart: item.valueStart, valueEnd: next.valueEnd});
                k += 1;
                continue;
            }
            if (word === "or" && out.length && typeof out[out.length - 1] === "object" &&
                    next && typeof next === "object") {
                out.push("OR");
                continue;
            }
            out.push(item);
        }
        return out;
    }

    function parseText(text) {
        var items = [];
        var length = text.length;
        var index = 0;
        var pendingNot = false;
        var termCount = 0;
        while (index < length && termCount < MAX_TERMS) {
            var ch = text.charAt(index);
            if (SPACE.test(ch)) {
                index += 1;
                continue;
            }
            var start = index;
            var neg = false;
            if (ch === "-") {
                var after = index;
                while (after < length && text.charAt(after) === "-") {
                    after += 1;
                }
                if (after >= length || SPACE.test(text.charAt(after))) {
                    index = after;                      // a lone minus
                    continue;
                }
                neg = true;
                index = after;
                ch = text.charAt(index);
            }
            var match = FIELD_RE.exec(text.substr(index, 14));
            var field = match ? FIELD_NAMES[match[1].toLowerCase()] : undefined;
            var read;
            var term;
            if (field) {
                index += match[0].length;
                read = quoteAt(text, index) ? readQuoted(text, index) : readBare(text, index);
                index = read.end;
                if (!/\S/.test(read.value)) {
                    pendingNot = false;                 // "tag:" while typing
                    continue;
                }
                term = {field: field, value: read.value, quoted: quoteAt(text, read.start - 1),
                        closed: read.closed};
            } else if (quoteAt(text, index)) {
                read = readQuoted(text, index);
                index = read.end;
                term = {field: null, value: read.value, quoted: true, closed: read.closed};
            } else {
                read = readBare(text, index);
                index = read.end;
                if (!neg && OR_WORDS[read.value]) {
                    items.push("OR");
                    continue;
                }
                if (!neg && AND_WORDS[read.value]) {
                    continue;
                }
                if (!neg && read.value === "NOT") {
                    pendingNot = !pendingNot;
                    continue;
                }
                term = {field: null, value: read.value, quoted: false, closed: true};
            }
            term.neg = neg !== pendingNot;
            pendingNot = false;
            term.start = start;
            term.end = index;
            term.valueStart = read.start;
            term.valueEnd = read.stop;
            items.push(term);
            termCount += 1;
        }
        return items;
    }

    /* The query as {text, clauses, terms, sequence, hasText, wantsHidden,
       warnings, empty, typing}. clauses must all match; a clause is
       {terms: [...]}, its terms alternatives (OR); a clause of one negated
       term excludes. A term: {kind: "word" | "phrase" | "filter", field,
       value, words (normalized), quoted, closed, neg, prefix (the last word
       may be the start of a longer word: only while typing), level and
       stop (a word that may be skipped, see skipLevel), active (false:
       skipped), mask (fields searched), filter, invalid, start, end,
       valueStart, valueEnd (offsets in text)}. sequence: the plain words in
       order, for the bonus when the whole query appears word for word. */
    function parseQuery(query, typing) {
        var text = query === null || query === undefined ? "" : String(query);
        if (text.length > MAX_QUERY_LENGTH) {
            text = text.slice(0, MAX_QUERY_LENGTH);
        }
        var result = emptyQuery(text);
        result.typing = typing === true;
        var warnings = result.warnings;
        var items = plainLanguage(parseText(text));
        var clauses = [];
        var terms = [];
        var joinNext = false;
        var lastItem = null;
        items.forEach(function (item) {
            if (item === "OR") {
                joinNext = clauses.length > 0;
                lastItem = item;
                return;
            }
            if (!analyze(item, warnings)) {
                return;
            }
            terms.push(item);
            lastItem = item;
            if (joinNext) {
                clauses[clauses.length - 1].terms.push(item);
                joinNext = false;
            } else {
                clauses.push({terms: [item]});
            }
        });
        // The last word may be unfinished while it is typed.
        if (typing === true && lastItem && lastItem !== "OR" &&
                !SPACE.test(text.charAt(text.length - 1)) && lastItem.end === text.length &&
                lastItem.kind !== "filter" && !lastItem.neg &&
                (!lastItem.quoted || !lastItem.closed)) {
            lastItem.prefix = true;
        }
        // Small and filler words are skipped when there is anything better
        // to look for: every single-word clause above the lowest level.
        var lowest = 4;
        clauses.forEach(function (clause) {
            var level = clause.terms.length > 1 ? 0 : clause.terms[0].level;
            if (level < lowest) {
                lowest = level;
            }
        });
        clauses = clauses.filter(function (clause) {
            if (clause.terms.length === 1 && clause.terms[0].level > lowest) {
                clause.terms[0].active = false;
                return false;
            }
            return true;
        });
        var hasOr = clauses.some(function (clause) {
            return clause.terms.length > 1;
        });
        // The sequence: the plain words in order, without skipped words at
        // either end ("photo of a dog on the beach" -> "dog on the beach").
        var plainTerms = terms.filter(function (term) {
            return !term.field && !term.quoted && !term.neg && term.kind !== "filter";
        });
        while (plainTerms.length && !plainTerms[0].active) {
            plainTerms.shift();
        }
        while (plainTerms.length && !plainTerms[plainTerms.length - 1].active) {
            plainTerms.pop();
        }
        var sequence = [];
        plainTerms.forEach(function (term) {
            sequence = sequence.concat(term.words);
        });
        terms.forEach(function (term) {
            if (term.active && !term.neg) {
                if (term.kind !== "filter") {
                    result.hasText = true;
                } else if (term.filter && term.filter.kind === "is" &&
                           term.filter.what === "hidden") {
                    result.wantsHidden = true;
                }
            }
        });
        result.clauses = clauses;
        result.terms = terms;
        if (!hasOr && plainTerms.length > 1 && sequence.length > 1) {
            result.sequence = sequence;
        }
        result.empty = clauses.length === 0;
        return result;
    }

    var lastQueryKey = null;
    var lastQuery = null;

    // parse() that never throws: a broken query searches for nothing.
    // options.typing: the text is still being typed (see the notes above).
    function parse(query, options) {
        var text = query === null || query === undefined ? "" : String(query);
        var typing = Boolean(options && typeof options === "object" && options.typing);
        var key = (typing ? "t" : "f") + text;
        if (key === lastQueryKey && lastQuery) {
            return lastQuery;
        }
        var result;
        try {
            result = parseQuery(text, typing);
        } catch (error) {
            result = emptyQuery(text);
        }
        lastQueryKey = key;
        lastQuery = result;
        return result;
    }

    function asQuery(query, options) {
        if (query && typeof query === "object" && Array.isArray(query.clauses)) {
            return query;
        }
        return parse(query, options);
    }

    /* ---------- Facets ----------------------------------------------------- */

    var FACETS = [
        {key: "library", label: "Library"},
        {key: "type", label: "Type"},
        {key: "people", label: "People"},
        {key: "setting", label: "Setting"},
        {key: "time", label: "Time of day"},
        {key: "event", label: "Event"},
        {key: "year", label: "Year"},
        {key: "month", label: "Month"},
        {key: "camera", label: "Camera", limit: 15},
        {key: "has", label: "Has"},
        {key: "tags", label: "Tags", limit: 20},
        {key: "subjects", label: "Subjects", limit: 15},
        {key: "animals", label: "Animals", limit: 15},
        {key: "food", label: "Food", limit: 15},
        {key: "vehicles", label: "Vehicles", limit: 15},
        {key: "colors", label: "Colors", limit: 15}
    ];
    var FACET_LIMITS = dict({});
    FACETS.forEach(function (facet) {
        FACET_LIMITS[facet.key] = facet.limit || 0;
    });
    // Groups with values (all but "has").
    var VALUE_KEYS = FACETS.map(function (facet) {
        return facet.key;
    }).filter(function (key) {
        return key !== "has";
    });
    var MULTI_GROUPS = wordSet("type tags subjects animals food vehicles colors");
    var LOWER_GROUPS = wordSet("tags subjects animals food vehicles colors");
    var HAS_VALUES = ["text", "gps", "360"];
    var HAS_BITS = dict({text: 1, gps: 2, "360": 4});

    function orderOf(list) {
        var out = Object.create(null);
        list.forEach(function (value, index) {
            out[value] = index;
        });
        return out;
    }

    var FACET_ORDERS = dict({
        type: orderOf(PHOTO_TYPES.concat(DOCUMENT_TYPES.map(function (name) {
            return "doc:" + name;
        }))),
        people: orderOf(PEOPLE_VALUES),
        setting: orderOf(SETTINGS),
        time: orderOf(TIMES)
    });

    var TYPE_LABELS = dict({
        photo: "Photos", screenshot: "Screenshots", document: "Documents", scan: "Scans",
        artwork: "Artwork", meme: "Memes", diagram: "Diagrams", other: "Other",
        "doc:receipt": "Receipts", "doc:chat": "Chats", "doc:web": "Web pages",
        "doc:app": "Apps", "doc:whiteboard": "Whiteboards", "doc:sign": "Signs",
        "doc:menu": "Menus", "doc:letter": "Letters", "doc:form": "Forms",
        "doc:ticket": "Tickets", "doc:card_or_id": "Cards and IDs",
        "doc:book_page": "Book pages", "doc:handwriting": "Handwriting",
        "doc:slide": "Slides", "doc:map": "Maps", "doc:other": "Other documents"
    });
    var VALUE_LABELS = dict({
        people: dict({none: "No people", "1": "1 person", "2": "2 people",
                      "3-5": "3-5 people", "6-10": "6-10 people", crowd: "A crowd"}),
        setting: dict({indoor: "Indoors", outdoor: "Outdoors", vehicle: "In a vehicle"}),
        time: dict({day: "Day", sunrise_sunset: "Sunrise or sunset", night: "Night"}),
        has: dict({text: "Has text", gps: "Has a location", "360": "360\u00b0 photos"})
    });

    /* A label for a facet value: facetLabel("type", "doc:receipt") is
       "Receipts", facetLabel("month", "2019-05") is "May 2019". Library
       values are ids; the page shows their names. */
    function facetLabel(group, value) {
        var text = value === null || value === undefined ? "" : String(value);
        if (group === "type") {
            return TYPE_LABELS[text] || enumWords(text.replace(/^doc:/, ""));
        }
        if (group === "month") {
            var match = /^(\d{4})-(\d{2})$/.exec(text);
            var month = match ? parseInt(match[2], 10) : 0;
            return month >= 1 && month <= 12 ? MONTH_LABELS[month - 1] + " " + match[1] : text;
        }
        var labels = VALUE_LABELS[group];
        if (labels && labels[text]) {
            return labels[text];
        }
        if (group === "event") {
            text = enumWords(text);
            return text.charAt(0).toUpperCase() + text.slice(1);
        }
        return text;
    }

    function uniqueLower(values) {
        var out = [];
        var seen = Object.create(null);
        for (var k = 0; k < values.length; k++) {
            var value = values[k].replace(/^\s+|\s+$/g, "").toLowerCase();
            if (value && !seen[value]) {
                seen[value] = true;
                out.push(value);
            }
        }
        return out;
    }

    function facetValues(rec, key) {
        var dk = isText(rec.dk) ? rec.dk : "";
        switch (key) {
        case "library":
            return isText(rec.l) ? [rec.l] : [];
        case "type":
            var types = [];
            if (isText(rec.ty)) {
                types.push(rec.ty);
            }
            if (isText(rec.dt) && rec.dt !== "none") {
                types.push("doc:" + rec.dt);
            }
            return types;
        case "people":
            return isText(rec.pp) ? [rec.pp] : [];
        case "setting":
            return isText(rec.st) && rec.st !== "unknown" ? [rec.st] : [];
        case "time":
            return isText(rec.td) && rec.td !== "unknown" ? [rec.td] : [];
        case "event":
            return isText(rec.ev) && rec.ev !== "none" ? [rec.ev] : [];
        case "year":
            return /^\d{4}/.test(dk) ? [dk.slice(0, 4)] : [];
        case "month":
            return /^\d{4}-\d{2}/.test(dk) ? [dk.slice(0, 7)] : [];
        case "camera":
            return isText(rec.cm) ? [rec.cm] : [];
        case "tags":
            return uniqueLower(textList(rec.g));
        case "subjects":
            return uniqueLower(textList(rec.s));
        case "animals":
            return uniqueLower(textList(rec.a));
        case "food":
            return uniqueLower(textList(rec.fo));
        case "vehicles":
            return uniqueLower(textList(rec.v));
        case "colors":
            return uniqueLower(textList(rec.c));
        }
        return [];
    }

    // The values of one facet group for every record: one value id per
    // record (single) or a list per record (offsets/flat).
    function buildFacet(records, key) {
        var n = records.length;
        var values = [];
        var ids = Object.create(null);
        var multi = MULTI_GROUPS[key] === true;
        var single = multi ? null : new Int32Array(n);
        var offsets = multi ? new Int32Array(n + 1) : null;
        var flat = [];
        function idOf(value) {
            var id = ids[value];
            if (id === undefined) {
                id = values.length;
                ids[value] = id;
                values.push(value);
            }
            return id;
        }
        for (var r = 0; r < n; r++) {
            var rec = records[r];
            var list = rec && typeof rec === "object" ? facetValues(rec, key) : [];
            if (multi) {
                offsets[r] = flat.length;
                for (var k = 0; k < list.length; k++) {
                    flat.push(idOf(list[k]));
                }
            } else {
                single[r] = list.length ? idOf(list[0]) : -1;
            }
        }
        if (multi) {
            offsets[n] = flat.length;
        }
        return {key: key, values: values, ids: ids, single: single, offsets: offsets,
                flat: multi ? new Int32Array(flat) : null};
    }

    function valueList(value) {
        if (value === null || value === undefined || value === false || value === true) {
            return [];
        }
        var list = Array.isArray(value) ? value : [value];
        var out = [];
        for (var k = 0; k < list.length; k++) {
            if (typeof list[k] === "string" || typeof list[k] === "number") {
                var text = String(list[k]);
                if (text && out.indexOf(text) < 0) {
                    out.push(text);
                }
            }
        }
        return out;
    }

    function selections(options) {
        var filters = options.filters && typeof options.filters === "object"
            ? options.filters : {};
        var out = Object.create(null);
        FACETS.forEach(function (facet) {
            var list = hasOwn.call(filters, facet.key) ? valueList(filters[facet.key]) : [];
            if (LOWER_GROUPS[facet.key]) {
                list = uniqueLower(list);
            }
            out[facet.key] = list;
        });
        return out;
    }

    function compareFacetEntries(key) {
        var order = FACET_ORDERS[key];
        if (key === "year") {
            return function (a, b) {
                return a.value < b.value ? 1 : a.value > b.value ? -1 : 0;
            };
        }
        if (key === "month") {
            return function (a, b) {
                return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
            };
        }
        return function (a, b) {
            if (order) {
                var x = order[a.value];
                var y = order[b.value];
                x = x === undefined ? 1e6 : x;
                y = y === undefined ? 1e6 : y;
                if (x !== y) {
                    return x - y;
                }
            }
            if (a.count !== b.count) {
                return b.count - a.count;
            }
            return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
        };
    }

    // [{value, count, selected}] of one group: values with matches, plus the
    // selected ones; the most frequent `limit` when the group has a limit.
    function facetEntries(key, values, counts, ids, selected) {
        var chosen = Object.create(null);
        var entries = [];
        selected.forEach(function (value) {
            chosen[value] = true;
            if (ids[value] === undefined) {
                entries.push({value: value, count: 0, selected: true});
            }
        });
        for (var id = 0; id < values.length; id++) {
            if (counts[id] > 0 || chosen[values[id]]) {
                entries.push({value: values[id], count: counts[id],
                              selected: chosen[values[id]] === true});
            }
        }
        var limit = FACET_LIMITS[key];
        if (limit && entries.length > limit) {
            entries.sort(compareFacetEntries(""));
            var kept = 0;
            entries = entries.filter(function (entry) {
                if (entry.selected) {
                    return true;
                }
                kept += 1;
                return kept <= limit;
            });
        }
        entries.sort(compareFacetEntries(key));
        return entries;
    }

    /* ---------- Dates ------------------------------------------------------ */

    // Days since 1970-01-01 of a date in the proleptic Gregorian calendar.
    function dayNumber(year, month, day) {
        year -= month <= 2 ? 1 : 0;
        var era = Math.floor(year / 400);
        var yearOfEra = year - era * 400;
        var dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
        var dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) -
            Math.floor(yearOfEra / 100) + dayOfYear;
        return era * 146097 + dayOfEra - 719468;
    }

    function parseDay(text) {
        var match = isText(text) ? /^(\d{4})-(\d{2})-(\d{2})/.exec(text) : null;
        return match ? dayNumber(+match[1], +match[2], +match[3]) : -1;
    }

    function parseMinutes(text) {
        var match = isText(text) ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text) : null;
        return match ? dayNumber(+match[1], +match[2], +match[3]) * 1440 + (+match[4]) * 60 +
            (+match[5]) : -1;
    }

    /* ---------- The index -------------------------------------------------- */

    var nameCompare = (function () {
        try {
            if (typeof Intl !== "undefined" && Intl.Collator) {
                return new Intl.Collator(undefined, {numeric: true, sensitivity: "base"}).compare;
            }
        } catch (error) {
            // Fall through to a plain comparison.
        }
        return function (a, b) {
            a = a.toLowerCase();
            b = b.toLowerCase();
            return a < b ? -1 : a > b ? 1 : 0;
        };
    })();

    function compareIds(a, b) {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    // What dates sort by: the date and time taken (ts), else the day
    // (dk) and, in an export, the place in capture order within the day
    // (tn), so the pictures of one day keep the order they were taken in.
    function sortDate(rec) {
        if (isText(rec.ts)) {
            return rec.ts;
        }
        if (!isText(rec.dk)) {
            return "";
        }
        if (typeof rec.tn === "number" && rec.tn > 0 && rec.tn < 1e9) {
            return rec.dk + "#" + String(1e9 + Math.floor(rec.tn)).slice(1);
        }
        return rec.dk;
    }

    // A growing list of 32-bit integers.
    function IntBuffer(size) {
        this.data = new Int32Array(size > 1024 ? size : 1024);
        this.length = 0;
    }

    IntBuffer.prototype.push = function (value) {
        if (this.length === this.data.length) {
            var bigger = new Int32Array(this.data.length * 2);
            bigger.set(this.data);
            this.data = bigger;
        }
        this.data[this.length] = value;
        this.length += 1;
    };

    // The values, in an array of their own size.
    IntBuffer.prototype.done = function () {
        return this.data.slice(0, this.length);
    };

    /* The words of the records, worked out once, in flat typed arrays (a
       few bytes per word, so 50k records stay reasonable):
       - postings: for every form of every word (wordForms), the records it
         is in and in which fields: postRecords / postMasks from
         postStart[word id] to postStart[word id + 1], records increasing;
       - words: per record (wordStart[r] to wordStart[r + 1]) its fields in
         order, each as [field, count, word ids...] with -1 between the
         items of a list, for phrases;
       - facet values, dates, flags and duplicate groups. */
    function Index(records) {
        var list = Array.isArray(records) ? records : [];
        var n = list.length;
        var r;
        this.records = list;
        this.n = n;
        this.vocab = Object.create(null);   // word -> word id
        this.terms = [];                    // word id -> word
        this.forms = [];                    // word id -> its form ids (words seen in records)
        this.position = Object.create(null);    // String(id) -> record index
        this.dates = new Array(n);
        this.flags = new Uint8Array(n);
        this.scratchExact = new Int32Array(n);
        this.scratchPartial = new Int32Array(n);
        this.orders = Object.create(null);
        this.similarData = null;
        this.tagWords = null;
        this.wordStart = new Int32Array(n + 1);
        // Only while building: per record its (form id, fields) pairs.
        this.build = {pairs: new IntBuffer(n * 64), pairStart: new Int32Array(n + 1),
                      words: new IntBuffer(n * 64), lastRecord: [], lastPair: []};
        for (r = 0; r < n; r++) {
            var rec = list[r];
            this.build.pairStart[r] = this.build.pairs.length >> 1;
            this.wordStart[r] = this.build.words.length;
            this.dates[r] = "";
            if (!rec || typeof rec !== "object") {
                continue;
            }
            if (rec.i !== undefined && rec.i !== null) {
                this.position[String(rec.i)] = r;
            }
            this.indexRecord(r, rec);
            this.dates[r] = sortDate(rec);
            this.flags[r] = (isText(rec.o) ? 1 : 0) | (rec.gp ? 2 : 0) | (rec.p === "360" ? 4 : 0);
        }
        this.build.pairStart[n] = this.build.pairs.length >> 1;
        this.wordStart[n] = this.build.words.length;
        this.words = this.build.words.done();
        this.invert();
        this.build = null;
        // The words seen in records, sorted, for prefix searches.
        var seen = [];
        for (var id = 0; id < this.terms.length; id++) {
            if (this.forms[id]) {
                seen.push(this.terms[id]);
            }
        }
        seen.sort();
        this.prefixTerms = seen;
        this.prefixIds = new Int32Array(seen.length);
        for (var k = 0; k < seen.length; k++) {
            this.prefixIds[k] = this.vocab[seen[k]];
        }
        this.facets = Object.create(null);
        for (var g = 0; g < VALUE_KEYS.length; g++) {
            this.facets[VALUE_KEYS[g]] = buildFacet(list, VALUE_KEYS[g]);
        }
        this.findGroups();
        this.newestRank = new Int32Array(n);
        var newest = this.order("newest");
        for (var p = 0; p < newest.length; p++) {
            this.newestRank[newest[p]] = p;
        }
    }

    Index.prototype.intern = function (word) {
        var id = this.vocab[word];
        if (id === undefined) {
            id = this.terms.length;
            this.vocab[word] = id;
            this.terms.push(word);
            this.forms.push(null);
            this.build.lastRecord.push(-1);
            this.build.lastPair.push(-1);
        }
        return id;
    };

    // The id of a word seen in a record (its forms are worked out once).
    Index.prototype.wordId = function (word) {
        var id = this.intern(word);
        if (!this.forms[id]) {
            var forms = wordForms(word);
            var ids = [id];
            for (var k = 1; k < forms.length; k++) {
                ids.push(this.intern(forms[k]));
            }
            this.forms[id] = ids;
        }
        return id;
    };

    Index.prototype.indexRecord = function (r, rec) {
        var build = this.build;
        var pairs = build.pairs;
        var words = build.words;
        var texts = recordTexts(rec);
        for (var k = 0; k < texts.length; k += 2) {
            var field = texts[k];
            var values = texts[k + 1];
            var bit = 1 << field;
            var head = words.length;
            var count = 0;
            words.push(field);
            words.push(0);
            for (var v = 0; v < values.length; v++) {
                var parts = tokens(values[v]);
                if (parts.length && count) {
                    words.push(-1);
                    count += 1;
                }
                for (var w = 0; w < parts.length; w++) {
                    var id = this.wordId(parts[w]);
                    words.push(id);
                    count += 1;
                    var forms = this.forms[id];
                    for (var f = 0; f < forms.length; f++) {
                        var form = forms[f];
                        if (build.lastRecord[form] === r) {
                            pairs.data[2 * build.lastPair[form] + 1] |= bit;
                        } else {
                            build.lastRecord[form] = r;
                            build.lastPair[form] = pairs.length >> 1;
                            pairs.push(form);
                            pairs.push(bit);
                        }
                    }
                }
            }
            if (count) {
                words.data[head + 1] = count;
            } else {
                words.length = head;                // a field without words
            }
        }
    };

    // Turns the per-record pairs into the per-word postings.
    Index.prototype.invert = function () {
        var build = this.build;
        var pairs = build.pairs.data;
        var total = build.pairs.length >> 1;
        var count = this.terms.length;
        var start = new Int32Array(count + 1);
        var p;
        for (p = 0; p < total; p++) {
            start[pairs[2 * p] + 1] += 1;
        }
        for (var t = 0; t < count; t++) {
            start[t + 1] += start[t];
        }
        var next = start.slice(0, count);
        var records = new Int32Array(total);
        var masks = new Int32Array(total);
        for (var r = 0; r < this.n; r++) {
            for (p = build.pairStart[r]; p < build.pairStart[r + 1]; p++) {
                var form = pairs[2 * p];
                var at = next[form];
                next[form] = at + 1;
                records[at] = r;
                masks[at] = pairs[2 * p + 1];
            }
        }
        this.postStart = start;
        this.postRecords = records;
        this.postMasks = masks;
    };

    // Numbers the duplicate groups: groupOf[record] (-1: none) and
    // groupCover[group] (the record index of its cover, -1 if not here).
    Index.prototype.findGroups = function () {
        var keys = Object.create(null);
        var covers = [];
        this.groupOf = new Int32Array(this.n);
        for (var r = 0; r < this.n; r++) {
            var rec = this.records[r];
            this.groupOf[r] = -1;
            if (!rec || typeof rec !== "object" || rec.dg === undefined || rec.dg === null) {
                continue;
            }
            var key = String(rec.dg);
            var group = keys[key];
            if (group === undefined) {
                group = covers.length;
                keys[key] = group;
                covers.push(this.position[key] === undefined ? -1 : this.position[key]);
            }
            this.groupOf[r] = group;
        }
        this.groupCover = new Int32Array(covers);
    };

    Index.prototype.get = function (id) {
        var r = this.position[String(id)];
        return r === undefined ? null : this.records[r];
    };

    // All record indexes in one of the SORTS orders (worked out once).
    Index.prototype.order = function (mode) {
        if (this.orders[mode]) {
            return this.orders[mode];
        }
        var records = this.records;
        var dates = this.dates;
        var all = [];
        for (var r = 0; r < this.n; r++) {
            all.push(r);
        }
        function id(r) {
            var rec = records[r];
            return rec && typeof rec === "object" ? rec.i : undefined;
        }
        var compare;
        if (mode === "oldest" || mode === "newest") {
            var sign = mode === "newest" ? -1 : 1;
            compare = function (a, b) {
                var x = dates[a];
                var y = dates[b];
                if (!x !== !y) {
                    return x ? -1 : 1;              // undated pictures last
                }
                if (x !== y) {
                    return x < y ? -sign : sign;
                }
                return sign * compareIds(id(a), id(b));
            };
        } else if (mode === "name") {
            var names = all.map(function (r) {
                var rec = records[r];
                if (!rec || typeof rec !== "object") {
                    return "";
                }
                return isText(rec.n) ? rec.n : isText(rec.t) ? rec.t : "";
            });
            compare = function (a, b) {
                if (!names[a] !== !names[b]) {
                    return names[a] ? -1 : 1;
                }
                return nameCompare(names[a], names[b]) || compareIds(id(a), id(b));
            };
        } else {                                    // quality
            var rank = this.newestRank;
            var score = all.map(function (r) {
                var rec = records[r];
                if (!rec || typeof rec !== "object") {
                    return 0;
                }
                return (typeof rec.q === "number" ? rec.q : 0) * 10 +
                    (typeof rec.sh === "number" ? rec.sh : 0);
            });
            compare = function (a, b) {
                return score[b] - score[a] || rank[a] - rank[b];
            };
        }
        all.sort(compare);
        this.orders[mode] = all;
        return all;
    };

    // [first, end) of the words seen in records that start with prefix.
    Index.prototype.prefixRange = function (prefix) {
        var list = this.prefixTerms;
        var low = 0;
        var high = list.length;
        while (low < high) {
            var middle = (low + high) >> 1;
            if (list[middle] < prefix) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        var end = low;
        while (end < list.length && startsWith(list[end], prefix)) {
            end += 1;
        }
        return [low, end];
    };

    /* The records in which a word matches, limited to the fields of mask,
       with the score of the match: {records: [index], scores: [score]}.
       prefix: words starting with it count too (PREFIX_FACTOR). */
    Index.prototype.wordHits = function (word, prefix, mask) {
        var exact = this.scratchExact;
        var partial = this.scratchPartial;
        var start = this.postStart;
        var records = this.postRecords;
        var masks = this.postMasks;
        var touched = [];
        var p;
        var m;
        var r;
        var forms = wordForms(word);
        for (var f = 0; f < forms.length; f++) {
            var id = this.vocab[forms[f]];
            if (id === undefined) {
                continue;
            }
            for (p = start[id]; p < start[id + 1]; p++) {
                m = masks[p] & mask;
                if (m) {
                    r = records[p];
                    if (!exact[r] && !partial[r]) {
                        touched.push(r);
                    }
                    exact[r] |= m;
                }
            }
        }
        if (prefix) {
            var range = this.prefixRange(word);
            for (var t = range[0]; t < range[1]; t++) {
                var prefixId = this.prefixIds[t];
                for (p = start[prefixId]; p < start[prefixId + 1]; p++) {
                    m = masks[p] & mask;
                    if (m) {
                        r = records[p];
                        if (!exact[r] && !partial[r]) {
                            touched.push(r);
                        }
                        partial[r] |= m;
                    }
                }
            }
        }
        var scores = new Array(touched.length);
        for (var k = 0; k < touched.length; k++) {
            r = touched[k];
            scores[k] = maskScore(exact[r], partial[r] & ~exact[r]);
            exact[r] = 0;
            partial[r] = 0;
        }
        return {records: touched, scores: scores};
    };

    // Tests whether a word seen in a record (by id) is a given query word.
    function Matcher(index, word, prefix) {
        this.index = index;
        this.word = word;
        this.prefix = prefix;
        this.wanted = Object.create(null);
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            this.wanted[forms[k]] = true;
        }
        this.known = new Int8Array(index.terms.length);     // 1 yes, 2 no
    }

    Matcher.prototype.test = function (id) {
        if (id < 0) {
            return false;
        }
        var known = this.known[id];
        if (known) {
            return known === 1;
        }
        var index = this.index;
        var forms = index.forms[id];
        var found = false;
        for (var k = 0; k < forms.length && !found; k++) {
            found = this.wanted[index.terms[forms[k]]] === true;
        }
        if (!found && this.prefix) {
            found = startsWith(index.terms[id], this.word);
        }
        this.known[id] = found ? 1 : 2;
        return found;
    };

    Index.prototype.matchers = function (words, prefixLast) {
        var out = [];
        for (var k = 0; k < words.length; k++) {
            out.push(new Matcher(this, words[k], prefixLast && k === words.length - 1));
        }
        return out;
    };

    // The fields (of mask) in which the matchers match consecutive words.
    Index.prototype.phraseFields = function (r, matchers, mask) {
        var words = this.words;
        var count = matchers.length;
        var first = matchers[0];
        var found = 0;
        var at = this.wordStart[r];
        var end = this.wordStart[r + 1];
        while (at < end) {
            var bit = 1 << words[at];
            var from = at + 2;
            var to = from + words[at + 1];
            at = to;
            if (!(mask & bit) || to - from < count) {
                continue;
            }
            for (var p = from; p + count <= to; p++) {
                if (!first.test(words[p])) {
                    continue;
                }
                var k = 1;
                while (k < count && matchers[k].test(words[p + k])) {
                    k += 1;
                }
                if (k === count) {
                    found |= bit;
                    break;
                }
            }
        }
        return found;
    };

    // Scores of a word or phrase term per record (-1: no match).
    Index.prototype.textScores = function (term) {
        var out = filled(this.n, -1);
        var words = term.words;
        var count = words.length;
        var hits = this.wordHits(words[0], term.prefix && count === 1, term.mask);
        var k;
        if (count === 1) {
            for (k = 0; k < hits.records.length; k++) {
                out[hits.records[k]] = hits.scores[k];
            }
            return out;
        }
        var candidates = hits.records;
        var sums = hits.scores;
        for (var w = 1; w < count && candidates.length; w++) {
            var next = this.wordHits(words[w], term.prefix && w === count - 1, term.mask);
            for (k = 0; k < next.records.length; k++) {
                out[next.records[k]] = next.scores[k];
            }
            var kept = [];
            var keptSums = [];
            for (k = 0; k < candidates.length; k++) {
                var score = out[candidates[k]];
                if (score >= 0) {
                    kept.push(candidates[k]);
                    keptSums.push(sums[k] + score);
                }
            }
            for (k = 0; k < next.records.length; k++) {
                out[next.records[k]] = -1;
            }
            candidates = kept;
            sums = keptSums;
        }
        var matchers = this.matchers(words, term.prefix);
        for (k = 0; k < candidates.length; k++) {
            var where = this.phraseFields(candidates[k], matchers, term.mask);
            if (where) {
                out[candidates[k]] = sums[k] + (where & PHRASE_FIELDS ? PHRASE_BONUS : 0);
            }
        }
        return out;
    };

    // The libraries a lib: value names: ids, exact names, then name starts.
    function libraryIds(value, index, libraries) {
        var wanted = normalize(value).replace(/\s+/g, " ");
        var out = [];
        var known = Array.isArray(libraries) ? libraries.filter(function (library) {
            return library && typeof library === "object" && isText(library.id);
        }) : [];
        known.forEach(function (library) {
            if (library.id === value) {
                out.push(library.id);
            }
        });
        if (!out.length && index.facets.library.ids[value] !== undefined) {
            out.push(value);
        }
        [function (name) {
            return name === wanted;
        }, function (name) {
            return startsWith(name, wanted);
        }].forEach(function (test) {
            if (out.length) {
                return;
            }
            known.forEach(function (library) {
                if (test(normalize(library.name || "").replace(/\s+/g, " "))) {
                    out.push(library.id);
                }
            });
        });
        return out;
    }

    function hasQualityFlag(rec, flag) {
        return Array.isArray(rec.qf) && rec.qf.indexOf(flag) >= 0;
    }

    function isJunk(rec) {
        return hasQualityFlag(rec, "accidental") || hasQualityFlag(rec, "blurry");
    }

    function nonEmpty(value) {
        return Array.isArray(value) ? value.length > 0 : isText(value);
    }

    // A function telling whether a record passes a filter term, or null.
    function filterTest(filter, index, context) {
        switch (filter.kind) {
        case "photo_type":
            return function (rec) {
                return rec.ty === filter.value;
            };
        case "document_type":
            return function (rec) {
                return rec.dt === filter.value;
            };
        case "other_type":
            return function (rec) {
                return rec.ty === "other" || rec.dt === "other";
            };
        case "360":
            return function (rec) {
                return rec.p === "360";
            };
        case "people":
            return function (rec) {
                return rec.pp === filter.value;
            };
        case "people_any":
            return function (rec) {
                return isText(rec.pp) && rec.pp !== "none";
            };
        case "year":
            return function (rec) {
                var year = isText(rec.dk) ? parseInt(rec.dk.slice(0, 4), 10) : NaN;
                return year >= filter.from && year <= filter.to;
            };
        case "before":
            return function (rec) {
                return isText(rec.dk) && rec.dk < filter.key;
            };
        case "after":
            var after = filter.key + "\uffff";
            return function (rec) {
                return isText(rec.dk) && rec.dk > after;
            };
        case "lib":
            var ids = libraryIds(filter.value, index, context.libraries);
            if (!ids.length) {
                context.warn("There is no library called \"" + filter.value + "\".");
                return null;
            }
            return function (rec) {
                return ids.indexOf(rec.l) >= 0;
            };
        case "has":
            switch (filter.what) {
            case "text":
                return function (rec) {
                    return isText(rec.o);
                };
            case "gps":
                return function (rec) {
                    return Boolean(rec.gp);
                };
            case "people":
                return function (rec) {
                    return isText(rec.pp) && rec.pp !== "none";
                };
            case "animals":
                return function (rec) {
                    return nonEmpty(rec.a);
                };
            case "food":
                return function (rec) {
                    return nonEmpty(rec.fo);
                };
            case "vehicles":
                return function (rec) {
                    return nonEmpty(rec.v);
                };
            case "description":
                return function (rec) {
                    return Boolean(rec.ds);
                };
            }
            return null;
        case "is":
            switch (filter.what) {
            case "360":
                return function (rec) {
                    return rec.p === "360";
                };
            case "duplicate":
                return function (rec) {
                    return rec.dg !== undefined && rec.dg !== null;
                };
            case "hidden":
                return function (rec) {
                    return Boolean(rec.h);
                };
            case "undescribed":
                return function (rec) {
                    return !rec.ds;
                };
            case "described":
                return function (rec) {
                    return Boolean(rec.ds);
                };
            case "private":
                return function (rec) {
                    return Boolean(rec.pr);
                };
            case "sensitive":
                return function (rec) {
                    return isText(rec.se) && rec.se !== "none";
                };
            case "v4":
                return function (rec) {
                    return Boolean(rec.v4);
                };
            case "junk":
                return isJunk;
            }
            if (QUALITY_FLAGS[filter.what]) {
                return function (rec) {
                    return hasQualityFlag(rec, filter.what);
                };
            }
            return null;
        }
        return null;
    }

    // Scores of a filter term per record: 0 when it passes, -1 otherwise.
    Index.prototype.filterScores = function (term, context) {
        var out = filled(this.n, -1);
        var test = term.filter ? filterTest(term.filter, this, context) : null;
        if (!test) {
            return out;
        }
        var records = this.records;
        for (var r = 0; r < this.n; r++) {
            var rec = records[r];
            if (rec && typeof rec === "object" && test(rec)) {
                out[r] = 0;
            }
        }
        return out;
    };

    Index.prototype.termScores = function (term, context) {
        return term.kind === "filter" ? this.filterScores(term, context) : this.textScores(term);
    };

    // Scores of a clause of alternatives (a negated one matches where its
    // term does not).
    Index.prototype.clauseScores = function (clause, context) {
        if (clause.terms.length === 1 && !clause.terms[0].neg) {
            return this.termScores(clause.terms[0], context);
        }
        var out = filled(this.n, -1);
        for (var t = 0; t < clause.terms.length; t++) {
            var term = clause.terms[t];
            var scores = this.termScores(term, context);
            for (var r = 0; r < this.n; r++) {
                var score = term.neg ? (scores[r] < 0 ? 0 : -1) : scores[r];
                if (score > out[r]) {
                    out[r] = score;
                }
            }
        }
        return out;
    };

    // Which records may be shown at all (library, hidden, sensitive,
    // private, junk options).
    Index.prototype.visibility = function (options, wantsHidden) {
        var showHidden = options.hidden === true || wantsHidden === true;
        var sensitive = options.sensitive;
        var level = sensitive === true || sensitive === "show" ? 0 : sensitive === "strict" ? 2 : 1;
        var hidePrivate = options["private"] === false;
        var hideJunk = options.junk === true;
        var libraries = valueList(options.library).filter(function (value) {
            return value !== "all";
        });
        var out = new Uint8Array(this.n);
        var records = this.records;
        for (var r = 0; r < this.n; r++) {
            var rec = records[r];
            if (!rec || typeof rec !== "object") {
                continue;
            }
            if (rec.h && !showHidden) {
                continue;
            }
            if (libraries.length && libraries.indexOf(rec.l) < 0) {
                continue;
            }
            if (level && isText(rec.se) && (rec.se === "explicit" || rec.se === "graphic" ||
                                            (level === 2 && rec.se === "suggestive"))) {
                continue;
            }
            if (hidePrivate && rec.pr) {
                continue;
            }
            if (hideJunk && isJunk(rec)) {
                continue;
            }
            out[r] = 1;
        }
        return out;
    };

    function facetPasses(test, r, flags) {
        if (test.bit) {
            return (flags[r] & test.bit) !== 0;
        }
        var data = test.data;
        if (data.single) {
            var id = data.single[r];
            return id >= 0 && test.mark[id] === 1;
        }
        for (var k = data.offsets[r]; k < data.offsets[r + 1]; k++) {
            if (test.mark[data.flat[k]] === 1) {
                return true;
            }
        }
        return false;
    }

    function countFacet(data, counts, r) {
        if (data.single) {
            var id = data.single[r];
            if (id >= 0) {
                counts[id] += 1;
            }
            return;
        }
        for (var k = data.offsets[r]; k < data.offsets[r + 1]; k++) {
            counts[data.flat[k]] += 1;
        }
    }

    /* Applies the facet selections to the matching records and counts the
       facets: {final: [record indexes], facets}. A record failing exactly
       one group's selection still counts in that group, so its counts show
       what choosing another value there would give. */
    Index.prototype.facetPass = function (alive, options) {
        var selected = selections(options);
        var monthOn = selected.year.length > 0 || selected.month.length > 0;
        var groups = [];
        var counts = [];
        var tests = [];
        var flags = this.flags;
        var g;
        for (g = 0; g < VALUE_KEYS.length; g++) {
            var key = VALUE_KEYS[g];
            if (key === "month" && !monthOn) {
                continue;
            }
            var data = this.facets[key];
            groups.push(data);
            counts.push(new Int32Array(data.values.length));
            if (selected[key].length) {
                var mark = new Uint8Array(data.values.length);
                selected[key].forEach(function (value) {
                    var id = data.ids[value];
                    if (id !== undefined) {
                        mark[id] = 1;
                    }
                });
                tests.push({data: data, mark: mark, bit: 0, group: groups.length - 1});
            }
        }
        selected.has.forEach(function (value) {
            if (HAS_BITS[value]) {
                tests.push({data: null, mark: null, bit: HAS_BITS[value], group: -1});
            }
        });
        var hasCounts = [0, 0, 0];
        var final = [];
        for (var r = 0; r < this.n; r++) {
            if (!alive[r]) {
                continue;
            }
            var failed = null;
            var failures = 0;
            for (var t = 0; t < tests.length; t++) {
                if (!facetPasses(tests[t], r, flags)) {
                    failures += 1;
                    failed = tests[t];
                    if (failures > 1) {
                        break;
                    }
                }
            }
            if (failures === 0) {
                final.push(r);
                for (g = 0; g < groups.length; g++) {
                    countFacet(groups[g], counts[g], r);
                }
                for (var b = 0; b < HAS_VALUES.length; b++) {
                    if (flags[r] & (1 << b)) {
                        hasCounts[b] += 1;
                    }
                }
            } else if (failures === 1 && failed.group >= 0) {
                // (A record failing a "has" value has not got it: nothing to count.)
                countFacet(failed.data, counts[failed.group], r);
            }
        }
        var facets = {};
        VALUE_KEYS.forEach(function (key) {
            facets[key] = [];
        });
        groups.forEach(function (data, index) {
            facets[data.key] = facetEntries(data.key, data.values, counts[index], data.ids,
                                            selected[data.key]);
        });
        facets.has = [];
        HAS_VALUES.forEach(function (value, index) {
            var isSelected = selected.has.indexOf(value) >= 0;
            if (hasCounts[index] > 0 || isSelected) {
                facets.has.push({value: value, count: hasCounts[index], selected: isSelected});
            }
        });
        return {final: final, facets: facets};
    };

    var SORTS = ["relevance", "newest", "oldest", "name", "quality"];

    /* The query as it is searched here: a word being typed that is a word
       of the records already ("car", "cat") is searched as that word only,
       not also as the start of longer ones (carpet, caterpillar). The
       parse() result is shared, so changed terms are copies. */
    Index.prototype.effectiveQuery = function (parsed) {
        var self = this;
        var changed = parsed.terms.filter(function (term) {
            return term.prefix && term.kind !== "filter" &&
                self.knowsWord(term.words[term.words.length - 1], false);
        });
        if (!changed.length) {
            return parsed;
        }
        var copies = changed.map(function (term) {
            var copy = {};
            Object.keys(term).forEach(function (key) {
                copy[key] = term[key];
            });
            copy.prefix = false;
            return copy;
        });
        function swap(term) {
            var at = changed.indexOf(term);
            return at >= 0 ? copies[at] : term;
        }
        var out = {};
        Object.keys(parsed).forEach(function (key) {
            out[key] = parsed[key];
        });
        out.terms = parsed.terms.map(swap);
        out.clauses = parsed.clauses.map(function (clause) {
            return {terms: clause.terms.map(swap)};
        });
        return out;
    };

    Index.prototype.search = function (query, options) {
        var opts = options && typeof options === "object" ? options : {};
        var parsed = this.effectiveQuery(asQuery(query, opts));
        var n = this.n;
        var records = this.records;
        var warnings = parsed.warnings.slice();
        var context = {
            libraries: opts.libraries,
            warn: function (message) {
                if (warnings.indexOf(message) < 0) {
                    warnings.push(message);
                }
            }
        };
        var alive = this.visibility(opts, parsed.wantsHidden);
        var score = new Float64Array(n);
        var r;
        for (var c = 0; c < parsed.clauses.length; c++) {
            var clause = parsed.clauses[c];
            var scores;
            if (clause.terms.length === 1 && clause.terms[0].neg) {
                scores = this.termScores(clause.terms[0], context);
                for (r = 0; r < n; r++) {
                    if (scores[r] >= 0) {
                        alive[r] = 0;
                    }
                }
                continue;
            }
            scores = this.clauseScores(clause, context);
            for (r = 0; r < n; r++) {
                if (alive[r]) {
                    if (scores[r] < 0) {
                        alive[r] = 0;
                    } else {
                        score[r] += scores[r];
                    }
                }
            }
        }
        if (parsed.sequence) {
            // Whole words only: "red car" together is not "red carpet".
            var matchers = this.matchers(parsed.sequence, false);
            for (r = 0; r < n; r++) {
                if (alive[r]) {
                    var where = this.phraseFields(r, matchers, PHRASE_FIELDS);
                    if (where) {
                        score[r] += where & (1 << F_TITLE) ? SEQUENCE_TITLE_BONUS
                            : SEQUENCE_TEXT_BONUS;
                    }
                }
            }
        }
        var pass = this.facetPass(alive, opts);
        var final = pass.final;
        var sort = SORTS.indexOf(opts.sort) >= 0 ? opts.sort
            : parsed.hasText ? "relevance" : "newest";
        var ordered;
        if (sort === "relevance" && parsed.hasText) {
            ordered = this.byScore(final, score);
        } else {
            var inFinal = new Uint8Array(n);
            for (var k = 0; k < final.length; k++) {
                inFinal[final[k]] = 1;
            }
            ordered = this.order(sort === "relevance" ? "newest" : sort).filter(function (index) {
                return inFinal[index] === 1;
            });
        }
        var grouped = opts.group ? this.groupResults(ordered, sort) : null;
        return {
            total: final.length,
            items: grouped ? grouped.items : ordered.map(function (index) {
                return records[index].i;
            }),
            facets: pass.facets,
            groups: grouped ? grouped.groups : {},
            collapsed: grouped ? final.length - grouped.items.length : 0,
            sort: sort,
            query: parsed,
            warnings: warnings
        };
    };

    // Scores are kept to this precision when sorting by them.
    var SCORE_STEPS = 1000;
    // Record ranks are packed below the score in one number (2^20).
    var RANK_SPACE = 1048576;

    /* Record indexes by score (highest first), equal scores newest first.
       Each record's score and date rank are packed into one number, so a
       plain numeric sort does it (much faster than a compare function). */
    Index.prototype.byScore = function (list, score) {
        var rank = this.newestRank;
        var count = list.length;
        var k;
        if (this.n >= RANK_SPACE) {
            return list.slice().sort(function (a, b) {
                return score[b] - score[a] || rank[a] - rank[b];
            });
        }
        var keys = new Float64Array(count);
        for (k = 0; k < count; k++) {
            var r = list[k];
            keys[k] = Math.round(score[r] * SCORE_STEPS) * RANK_SPACE + (RANK_SPACE - 1 - rank[r]);
        }
        keys.sort();
        var newest = this.order("newest");
        var out = new Array(count);
        for (k = 0; k < count; k++) {
            out[k] = newest[RANK_SPACE - 1 - keys[count - 1 - k] % RANK_SPACE];
        }
        return out;
    };

    /* Each duplicate group once, shown as the group's cover when the cover
       is a match too (else as its best-ranked match). The stack sits where
       its best-ranked match is -- but in a date order where the cover is,
       so a stack never puts a picture of one month among another month's.
       */
    Index.prototype.groupResults = function (ordered, sort) {
        var records = this.records;
        var groupOf = this.groupOf;
        var covers = this.groupCover;
        var dated = sort === "newest" || sort === "oldest";
        var included = new Uint8Array(this.n);
        var shownFor = new Int32Array(covers.length);
        var placed = new Uint8Array(covers.length);
        var stacks = [];
        var items = [];
        var k;
        for (k = 0; k < ordered.length; k++) {
            included[ordered[k]] = 1;
        }
        shownFor.fill(-1);
        for (k = 0; k < ordered.length; k++) {
            var r = ordered[k];
            var group = groupOf[r];
            if (group < 0) {
                items.push(records[r].i);
                continue;
            }
            var shown = shownFor[group];
            if (shown < 0) {
                var cover = covers[group];
                shown = cover >= 0 && included[cover] ? cover : r;
                shownFor[group] = shown;
                stacks[group] = [records[shown].i];
            }
            if (!placed[group] && (!dated || r === shown)) {
                placed[group] = 1;
                items.push(records[shown].i);
            }
            if (r !== shown) {
                stacks[group].push(records[r].i);
            }
        }
        var groups = {};
        for (k = 0; k < stacks.length; k++) {
            if (stacks[k] && stacks[k].length > 1) {
                groups[String(stacks[k][0])] = stacks[k];
            }
        }
        return {items: items, groups: groups};
    };

    /* ---------- More like this --------------------------------------------- */

    var SIMILAR_MIN_SCORE = 1.5;

    // What similar() compares: the folded phrases of tags, subjects,
    // animals, food and vehicles (as sorted id lists, with postings), the
    // scene, the capture minute and day, and (an export, which has no
    // times) the place in capture order within the day.
    Index.prototype.similarityData = function () {
        if (this.similarData) {
            return this.similarData;
        }
        var ids = Object.create(null);          // folded phrase -> id
        var byValue = Object.create(null);      // value as stored -> id (-1: no words)
        var postings = [];
        var sets = new Array(this.n);
        var scenes = new Array(this.n);
        var minutes = new Float64Array(this.n);
        var days = new Float64Array(this.n);
        var places = new Float64Array(this.n);
        for (var r = 0; r < this.n; r++) {
            var rec = this.records[r];
            var set = [];
            sets[r] = set;
            scenes[r] = "";
            minutes[r] = -1;
            days[r] = -1;
            places[r] = -1;
            if (!rec || typeof rec !== "object") {
                continue;
            }
            var values = textList(rec.g).concat(textList(rec.s), textList(rec.a),
                                                textList(rec.fo), textList(rec.v));
            for (var k = 0; k < values.length; k++) {
                var id = byValue[values[k]];
                if (id === undefined) {
                    var phrase = tokens(values[k]).map(foldWord).join(" ");
                    id = phrase ? ids[phrase] : -1;
                    if (id === undefined) {
                        id = postings.length;
                        ids[phrase] = id;
                        postings.push([]);
                    }
                    byValue[values[k]] = id;
                }
                if (id >= 0 && set.indexOf(id) < 0) {
                    set.push(id);
                    postings[id].push(r);
                }
            }
            scenes[r] = isText(rec.sc) ? tokens(rec.sc).map(foldWord).join(" ") : "";
            minutes[r] = parseMinutes(rec.ts);
            days[r] = parseDay(rec.dk);
            places[r] = typeof rec.tn === "number" && rec.tn > 0 ? rec.tn : -1;
        }
        this.similarData = {sets: sets, postings: postings, scenes: scenes, minutes: minutes,
                            days: days, places: places};
        return this.similarData;
    };

    Index.prototype.similarity = function (origin, r, shared) {
        var data = this.similarData;
        var x = this.records[origin];
        var y = this.records[r];
        var score = 0;
        if (shared) {
            score += 10 * shared / (data.sets[origin].length + data.sets[r].length - shared);
        }
        if (data.scenes[origin] && data.scenes[origin] === data.scenes[r]) {
            score += 2;
        }
        if (isText(x.ev) && x.ev !== "none" && x.ev === y.ev) {
            score += 1.5;
        }
        var start = data.minutes[origin];
        var other = data.minutes[r];
        if (start >= 0 && other >= 0) {
            var gap = Math.abs(other - start);
            if (gap <= 120) {
                score += 3 + 2 * (1 - gap / 120);
            } else if (data.days[origin] === data.days[r]) {
                score += 1;
            }
        } else if (data.days[origin] >= 0 && data.days[origin] === data.days[r]) {
            score += 2;
            // Taken one after the other that day (an export's tn).
            if (data.places[origin] >= 0 && data.places[r] >= 0 &&
                    Math.abs(data.places[origin] - data.places[r]) <= 2) {
                score += 1;
            }
        }
        if (isText(x.dt) && x.dt !== "none" && x.dt === y.dt) {
            score += 1;
        } else if (isText(x.ty) && x.ty !== "photo" && x.ty === y.ty) {
            score += 0.5;
        }
        return score;
    };

    Index.prototype.similar = function (id, count, options) {
        var limit = typeof count === "number" && count > 0 ? Math.floor(count) : 8;
        var opts = options && typeof options === "object" ? options : {};
        var origin = this.position[String(id)];
        if (origin === undefined) {
            return [];
        }
        var data = this.similarityData();
        var visible = this.visibility(opts, false);
        var records = this.records;
        var rank = this.newestRank;
        var taken = new Uint8Array(this.n);
        var result = [];
        var r;
        taken[origin] = 1;
        var group = this.groupOf[origin];
        if (group >= 0) {
            var cover = this.groupCover[group];
            var members = [];
            for (r = 0; r < this.n; r++) {
                if (r !== origin && visible[r] && this.groupOf[r] === group) {
                    members.push(r);
                }
            }
            members.sort(function (a, b) {
                return (a === cover ? 0 : 1) - (b === cover ? 0 : 1) || rank[a] - rank[b];
            });
            for (var m = 0; m < members.length && result.length < limit; m++) {
                taken[members[m]] = 1;
                result.push(records[members[m]].i);
            }
        }
        if (result.length >= limit) {
            return result;
        }
        var shared = new Int32Array(this.n);
        var own = data.sets[origin];
        for (var k = 0; k < own.length; k++) {
            var posting = data.postings[own[k]];
            for (var p = 0; p < posting.length; p++) {
                shared[posting[p]] += 1;
            }
        }
        var scores = new Float64Array(this.n);
        var candidates = [];
        for (r = 0; r < this.n; r++) {
            if (taken[r] || !visible[r]) {
                continue;
            }
            var score = this.similarity(origin, r, shared[r]);
            if (score >= SIMILAR_MIN_SCORE) {
                scores[r] = score;
                candidates.push(r);
            }
        }
        candidates.sort(function (a, b) {
            return scores[b] - scores[a] || rank[a] - rank[b];
        });
        // One picture per other duplicate group (its cover when the cover
        // is a candidate too), at the place of its best member, so one
        // burst of shots does not fill the strip.
        var usedGroups = new Uint8Array(this.groupCover.length);
        for (var c = 0; c < candidates.length && result.length < limit; c++) {
            var pick = candidates[c];
            var other = this.groupOf[pick];
            if (other >= 0) {
                if (usedGroups[other]) {
                    continue;
                }
                usedGroups[other] = 1;
                var otherCover = this.groupCover[other];
                if (otherCover >= 0 && otherCover !== pick && scores[otherCover] > 0) {
                    pick = otherCover;
                }
            }
            result.push(records[pick].i);
        }
        return result;
    };

    /* ---------- Did you mean ----------------------------------------------- */

    // Edit distance (with swapped neighbours as one edit), or limit + 1
    // once it is certain to be more than limit.
    function editDistance(a, b, limit) {
        if (Math.abs(a.length - b.length) > limit) {
            return limit + 1;
        }
        var previous2 = null;
        var previous = [];
        var j;
        for (j = 0; j <= b.length; j++) {
            previous.push(j);
        }
        for (var i = 1; i <= a.length; i++) {
            var current = [i];
            var best = i;
            for (j = 1; j <= b.length; j++) {
                var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
                var value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
                if (previous2 && i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) &&
                        a.charAt(i - 2) === b.charAt(j - 1)) {
                    value = Math.min(value, previous2[j - 2] + 1);
                }
                current.push(value);
                if (value < best) {
                    best = value;
                }
            }
            if (best > limit) {
                return limit + 1;
            }
            previous2 = previous;
            previous = current;
        }
        return previous[b.length];
    }

    // Marks the ids of words that appear in tags (worked out once).
    Index.prototype.tagWordMarks = function () {
        if (!this.tagWords) {
            var marks = new Uint8Array(this.terms.length);
            var bit = 1 << F_TAGS;
            for (var id = 0; id < this.terms.length; id++) {
                for (var p = this.postStart[id]; p < this.postStart[id + 1]; p++) {
                    if (this.postMasks[p] & bit) {
                        marks[id] = 1;
                        break;
                    }
                }
            }
            this.tagWords = marks;
        }
        return this.tagWords;
    };

    Index.prototype.knowsWord = function (word, prefix) {
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            var id = this.vocab[forms[k]];
            if (id !== undefined && this.postStart[id + 1] > this.postStart[id]) {
                return true;
            }
        }
        if (prefix) {
            var range = this.prefixRange(word);
            return range[1] > range[0];
        }
        return false;
    };

    // The most likely word meant by a word that matches nothing, or null.
    Index.prototype.closestWord = function (word) {
        var limit = word.length <= 4 ? 1 : 2;
        var marks = this.tagWordMarks();
        var best = null;
        var bestTag = false;
        var bestDistance = limit + 1;
        var bestCount = 0;
        for (var k = 0; k < this.prefixTerms.length; k++) {
            var candidate = this.prefixTerms[k];
            if (Math.abs(candidate.length - word.length) > limit || candidate.length < 3 ||
                    /\d/.test(candidate)) {
                continue;
            }
            var distance = editDistance(word, candidate, limit);
            if (distance > limit) {
                continue;
            }
            var id = this.prefixIds[k];
            var tag = marks[id] === 1;
            var count = this.postStart[id + 1] - this.postStart[id];
            if ((tag && !bestTag) || (tag === bestTag && (distance < bestDistance ||
                    (distance === bestDistance && count > bestCount)))) {
                best = candidate;
                bestTag = tag;
                bestDistance = distance;
                bestCount = count;
            }
        }
        return best;
    };

    Index.prototype.suggest = function (query, options) {
        var opts = options && typeof options === "object" ? options : {};
        var parsed = asQuery(query, opts);
        var changes = [];
        var self = this;
        parsed.terms.forEach(function (term) {
            // (Skipped words are never corrected: "our" is not "out".)
            if (!term.active || term.stop || term.neg || term.kind !== "word") {
                return;
            }
            var word = term.words[0];
            if (word.length < 3 || /\d/.test(word) || self.knowsWord(word, term.prefix)) {
                return;
            }
            var better = self.closestWord(word);
            if (better && better !== word) {
                changes.push({term: term, from: word, to: better});
            }
        });
        if (!changes.length) {
            return null;
        }
        var text = parsed.text;
        changes.slice().sort(function (a, b) {
            return b.term.valueStart - a.term.valueStart;
        }).forEach(function (change) {
            text = text.slice(0, change.term.valueStart) + change.to +
                text.slice(change.term.valueEnd);
        });
        // A correction that finds nothing either is no help.
        var check = {};
        Object.keys(opts).forEach(function (key) {
            check[key] = opts[key];
        });
        check.typing = false;
        check.group = false;
        if (!this.search(text, check).total) {
            return null;
        }
        return {text: text, changes: changes.map(function (change) {
            return {from: change.from, to: change.to};
        })};
    };

    /* ---------- Highlights ------------------------------------------------- */

    // Tests whether a word of some text is a given query word (no index).
    function TextMatcher(word, prefix) {
        this.word = word;
        this.prefix = prefix;
        this.wanted = Object.create(null);
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            this.wanted[forms[k]] = true;
        }
    }

    TextMatcher.prototype.test = function (word) {
        if (this.prefix && startsWith(word, this.word)) {
            return true;
        }
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            if (this.wanted[forms[k]] === true) {
                return true;
            }
        }
        return false;
    };

    // The words of text with where they are: [{start, end, word}].
    function wordSpans(text) {
        var spans = [];
        var match;
        WORD_RE.lastIndex = 0;
        while ((match = WORD_RE.exec(text)) !== null) {
            var start = match.index;
            var end = start + match[0].length;
            while (start < end && APOSTROPHE_CHARS.indexOf(text.charAt(start)) >= 0) {
                start += 1;
            }
            while (end > start && APOSTROPHE_CHARS.indexOf(text.charAt(end - 1)) >= 0) {
                end -= 1;
            }
            var words = tokens(match[0]);
            for (var k = 0; k < words.length; k++) {
                spans.push({start: start, end: end, word: words[k]});
            }
        }
        return spans;
    }

    function highlights(text, query, field) {
        if (text === null || text === undefined) {
            return [];
        }
        var source = String(text);
        var parsed = asQuery(query);
        var known = field !== undefined && field !== null &&
            HIGHLIGHT_FIELDS[field] !== undefined;
        var fieldBit = known ? 1 << HIGHLIGHT_FIELDS[field] : 0;
        var lists = [];
        parsed.terms.forEach(function (term) {
            if (!term.active || term.neg || term.kind === "filter" ||
                    (fieldBit && !(term.mask & fieldBit))) {
                return;
            }
            lists.push(term.words.map(function (word, index) {
                return new TextMatcher(word, term.prefix && index === term.words.length - 1);
            }));
        });
        if (!source || !lists.length) {
            return [];
        }
        var spans = wordSpans(source);
        var ranges = [];
        lists.forEach(function (matchers) {
            var count = matchers.length;
            for (var p = 0; p + count <= spans.length; p++) {
                var k = 0;
                while (k < count && matchers[k].test(spans[p + k].word)) {
                    k += 1;
                }
                if (k === count) {
                    ranges.push([spans[p].start, spans[p + count - 1].end]);
                }
            }
        });
        ranges.sort(function (a, b) {
            return a[0] - b[0] || a[1] - b[1];
        });
        var merged = [];
        ranges.forEach(function (range) {
            var last = merged[merged.length - 1];
            if (last && range[0] <= last[1]) {
                if (range[1] > last[1]) {
                    last[1] = range[1];
                }
            } else {
                merged.push([range[0], range[1]]);
            }
        });
        return merged;
    }

    /* ---------- Entry points ----------------------------------------------- */

    var cachedRecords = null;
    var cachedIndex = null;

    function prepare(records) {
        var index = new Index(records);
        cachedRecords = Array.isArray(records) ? records : null;
        cachedIndex = index;
        return index;
    }

    // The index of records (an index is used as it is; an array is indexed
    // once and kept while it is the same array of the same length).
    function indexOf(source) {
        if (source instanceof Index) {
            return source;
        }
        if (source && source === cachedRecords && cachedIndex &&
                cachedIndex.n === source.length) {
            return cachedIndex;
        }
        return prepare(source);
    }

    var SYNTAX = [
        {example: "red car", meaning: "pictures with all the words (cars, Red, ... too)"},
        {example: "\"red car\"", meaning: "the words together, in this order"},
        {example: "beach -dog", meaning: "leave out pictures with a word"},
        {example: "cat OR dog", meaning: "either word (\"cat or dog\" too)"},
        {example: "tag:beach", meaning: "a word in one field: tag, subject, title, text " +
            "(the text in the picture), description, scene, animal, food, vehicle, color, " +
            "camera, folder, file"},
        {example: "type:screenshot", meaning: "a kind of picture: photo, screenshot, " +
            "document, receipt, chat, whiteboard, ..."},
        {example: "people:none", meaning: "how many people: none, 1, 2, 3-5, 6-10, crowd, " +
            "any (\"beach no people\" works too)"},
        {example: "year:2019", meaning: "taken in a year (or year:2015-2019)"},
        {example: "before:2019-06", meaning: "taken before June 2019 (after: too; " +
            "YYYY, YYYY-MM or YYYY-MM-DD)"},
        {example: "has:text", meaning: "with text, a location (has:gps), people, animals, ..."},
        {example: "is:360", meaning: "360\u00b0 photos; also is:duplicate, is:undescribed, " +
            "is:hidden"},
        {example: "lib:name", meaning: "only pictures of one library"}
    ];

    return {
        VERSION: 1,
        FACETS: FACETS,
        SORTS: SORTS,
        SYNTAX: SYNTAX,
        parse: parse,
        normalize: normalize,
        tokens: tokens,
        forms: function (word) {
            return wordForms(normalize(word)).slice();
        },
        fold: function (word) {
            return foldWord(normalize(word));
        },
        prepare: prepare,
        search: function (records, query, options) {
            return indexOf(records).search(query, options);
        },
        similar: function (records, id, count, options) {
            return indexOf(records).similar(id, count, options);
        },
        suggest: function (records, query, options) {
            return indexOf(records).suggest(query, options);
        },
        highlights: highlights,
        facetLabel: facetLabel
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = SearchCore;
}
