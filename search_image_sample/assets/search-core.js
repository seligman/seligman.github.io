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
   cm camera, gp has GPS, ci rg co cc km the place (town, region,
   country, country code, km from the town), np nk the named place of
   the street maps where it was taken and its kind ("museum", see
   PLACE_KINDS), pe the place is only
   estimated (is:place-estimated), ps where a place without the
   picture's own position comes from ("c" a copy, "t" the pictures taken
   around the same time, "a" the library's area, "o" the owner), gx the
   GPS check set the position aside (the admin's;
   is:gps-ignored), p "360", mv video (its ty is
   "video"), dr its length in seconds, vc its codec, vt the kind the AI
   model saw in its frames when not a photo, dg duplicate group,
   h hidden, ed edited by the owner, ds described, v4, fav a favorite,
   rt its rating 1-5, al the ids of the albums it is in; dv the drive of a
   clip (the id of its first clip), dx its place in the drive, dh the
   seconds missing before it, dvt dvd dvg the drive's own title,
   description and tags, dvp and dvs their private and sensitive flags,
   on one of its clips: see Drives). Any key may be missing.
   There is no DOM code here:
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
                         "oldest", "name", "quality", "shuffle" (a
                         random order that stays the same for one seed)
                         or "album" (the order of the one album the query
                         names, and the default when it names one and
                         has no words: a manual album's own order, a
                         smart album's sort)
              seed       a number for "shuffle" (the page keeps one per
                         session, so the order holds while scrolling)
              range      {from, to}: only pictures taken from .. to
                         (dates "YYYY", "YYYY-MM" or "YYYY-MM-DD", both
                         included; either may be left out): the timeline's
                         choice. Like the timeline and on:, it only counts
                         a date taken (not a file's time, du)
              timeline   true: work out the timeline of the matches
              today      "YYYY-MM-DD" for on:today (default: the date of
                         this computer)
              filters    facet selections {group: [values]}: the values of
                         one group are alternatives (OR), the groups must
                         all match (AND); every "has" value must match
              group      true: show each duplicate group once, at the place
                         of its best-ranked match, as its cover
              drives     true: show each drive (dv: a run of video clips
                         recorded one after the other) once, like a
                         duplicate group, as the clip result.drives
                         names (shown); a clip of a drive is then in no
                         duplicate group
              wholeDrives true: a drive that matches by its own words
                         only (none of its clips matches by itself) stands
                         for all of its clips in items: they are listed in
                         the drive's order where the drive is (an album
                         made from the search holds the whole drive)
              hidden     true: include hidden pictures (admin)
              sensitive  true or "show": include explicit and graphic
                         pictures; "strict": also leave out suggestive
                         ones; default: leave out explicit and graphic ones
              private    false: leave out pictures showing private
                         information (default: include them)
              junk       true: leave out pictures flagged accidental or
                         blurry
              ids        a list of picture ids: only these can match (the
                         pictures picked on the map)
              area       an area drawn or picked on the map (its text, see
                         "Areas on the map" below, or SearchCore.areas.read's
                         answer): only the pictures taken in it can match --
                         their positions, an estimated place deep enough
                         inside, a drive's clip whose route passes through
                         it (index.setPlaces gives them; until then nothing
                         matches, and the result says areaPending). One that
                         cannot be read is left out, with a warning
              albums     the albums album: can name: [{id, name, kind
                         ("manual" or "smart"), items (manual: picture ids
                         in the album's order), query and options (smart:
                         the saved search, {filters, sort, by, lib, from,
                         to, area, aname})}] (the "albums" of /api/index, or of an
                         export's manifest). A manual album holds the
                         pictures of its items and those whose al names it
                         (the page changes al in place); a smart album the
                         matches of its saved search, worked out here with
                         the visibility options of the search around it
              vectorFor  function (meaning text) -> the meaning vector of
                         a smart album's search, or null while there is
                         none (it is then searched by its words)
              typing     true while the query is still being typed: the
                         last word may be the start of a longer word (see
                         parse)
              vector     the meaning vector of the query (queryVector of
                         /api/embed's answer, made from meaningText(query)),
                         for search by meaning; needs vectors set on the
                         index (index.setVectors) of the same size
              termVectors  the meaning vectors of the query's words on
                         their own (the other texts of meaningTexts(query)):
                         {text: vector} or a function (text) -> vector or
                         null; see "Per-term coverage" below
              names      the names of people an export publishes (its
                         "people_names" option: they are tags of their
                         pictures there): a word of such a name is not
                         seen in a picture by its tag (Per-term coverage:
                         it is name-like, as on the server)
              meaning    "hybrid" (the default: words and meaning, see
                         "Search by meaning" below), "meaning" (by meaning
                         only) or "words" (no meaning, as without a vector)
              lookVector the look vector of an example picture (an
                         Int8Array of /api/looks/query's answer, see
                         queryVector): the pictures that look like it,
                         closest first, as look: does; needs looks set on
                         the index (index.setLooks) of the same size. Any
                         vector of the looks' space ranks the same way
                         (an image model's text query vector would rank
                         pictures by their looks for typed words: not
                         used yet)
     total     how many pictures match (before duplicates are grouped)
     items     the ids of the matches in order (one per stack when grouping;
               when sorted by date a stack sits at its cover's date)
     facets    {group: [{value, count, selected}]} for every group of
               SearchCore.FACETS (labels: SearchCore.facetLabel). Counts
               are over the matches of the query with the selections of
               every other group applied, but not the group's own
               (disjunctive facets). "month" is only filled while a year
               (or month) is selected. Selected values are always listed.
               The values of tags, subjects, animals, food and vehicles
               are grouped by their singular ("dog" and "dogs" are one
               value, shown as the more common of the two; selecting
               either finds both). "place" is a tree (see placeValues):
               the countries, and the regions and towns under a chosen
               one; its entries also have level, label and open.
     groups    when grouping: {shown id: [ids of the stack, shown id first]}
               for every duplicate stack of two or more matches
     drives    {key (dv): {clips, matched, shown, text}} for every drive
               with a match, folded or not: clips the ids of its clips
               that the search may show at all (visibility options, ids,
               dates), in order; matched those that match by themselves,
               best first; shown the clip that stands for the drive (its
               best-ranked clip that matches by itself, else its cover);
               text the id of the clip that carries its own title,
               description and tags when they may be shown, else null.
               See Drives.
     collapsed how many matches are folded into duplicate stacks (not
               counting the clips of drives)
     timeline  only with options.timeline (else null): how many matches
               were taken when: {level ("year", "month" or "day"; null when
               none has a date), bars: [{key, count}] for every year from
               the first to the last, the 12 months of the one year, or the
               days of the one month the matches are in, dated, undated}. A
               record whose date is only its file's time (du) counts as
               undated
     album     {id, name, kind} of the one album the query names (album
               order is then possible), else null
     areaPending  true when the area option (or a smart album's area)
               found nothing because the index has no places yet
     sort      the order used; query: the parse() result as searched (pass
               it to highlights() so the marks agree with the matches);
               warnings: notes about parts of the query that could not be
               understood
     byMeaning the ids of the matches found by meaning only (no word match;
               the page marks them), meaning: {mode ("hybrid", "meaning",
               "similar" or "look"), best (the highest cosine), terms (with
               two or more free words, by words and meaning: [{text, name
               (looked for by its words only), relation (a word such as
               "over"), meaning (it had a vector)}], else [])} when meaning
               (or looks) ranked the results, else null

   SearchCore.parse(query, options) -> {text, clauses, terms, sequence, ...}
     Never throws. Words must all match (AND), "quoted phrases" must match
     in order, -word / -"phrase" / -field:value exclude, OR (upper case, or
     a lower-case "or" between two words) makes alternatives. "no people"
     (or "without people") is people:none. field:value filters: tag:, subject:,
     title:, text: (the text in the picture), description:, scene:,
     setting:, event:, animal:, food:, vehicle:, color:, camera:, folder:,
     file: (words in that field); type: (photo, video, screenshot, document,
     receipt, chat, ...), people: (none, 1, 2, 3-5, 6-10, crowd, any or a
     number), year: (2019 or 2015-2019), before: / after: (YYYY, YYYY-MM or
     YYYY-MM-DD, not including that period), date: (taken then: YYYY,
     YYYY-MM or YYYY-MM-DD, or from..to with both included and either left
     out; only dates taken, as the range option), on: (today: this day in
     earlier years; MM-DD: that day in any year; or YYYY-MM-DD), place:
     (words of the town, region or country, or of the named place on the
     street maps: a park, a museum; record key np), kind: (or placekind:;
     taken at a kind of place: the kind of that named place, nk, by the
     words for it, kind:beach, kind:museums, kind:"golf course", or by
     its own name, kind:place_of_worship; see PLACE_KINDS), lib:
     (library name or id),
     has: (text, gps, people, animals, food, vehicles, description) and
     is: (360, duplicate, hidden, undescribed, described, edited, private,
     sensitive, blurry, dark, overexposed, accidental, junk, v4, favorite,
     rated, unrated, drive (the clips of drives), gps-ignored (positions
     the GPS check set aside: the admin's), place-estimated (pictures
     whose place is only estimated) or a type: is:video finds
     the videos, is:photo the photos), rating: (4: exactly 4 stars; >=3, >3, <=2, <2, 4+ or 3-5;
     comparisons find rated pictures only, rating:0 the unrated ones),
     album: (an album's name, any case, or the start of the only one
     that starts so; "quoted" when it has spaces: album:"Summer 2024";
     album:#12 names the album with id 12, see albumTerm),
     similar: (a picture id: "More like this", the pictures closest in
     meaning to that one, best first, after it and the other pictures of
     its duplicate stack; without meaning vectors, those
     sharing tags, the scene or the time, as similar() finds them) and
     look: (a picture id: "Looks like this", the pictures that look most
     like that one by their look vectors, see "Looks" below).
     Another word before a colon is searched as ordinary text. With
     options.typing (the page sets it only while the box is being typed
     in) the last word, when the text does not end with a space, also
     matches the start of longer words -- but only when it is not a word
     of the records itself ("cat" finds cats, "cate" finds caterpillars),
     and such matches score well below whole words. Small words such as
     "the" and "of", and filler such as "my", "show me" and "pictures of",
     are skipped unless they are all there is.

     Ranking (see "Ranking" below): a few words also find their synonyms
     (SYNONYMS: "kids" finds children, "dog" finds puppies), at a lower
     score; for the names of animals, vehicles and food, the real thing
     (named in the animals, vehicles or food field) ranks above a toy,
     statue, drawing or logo of it; and when one word is searched, a
     picture that has it only in its text (OCR) ranks below pictures
     about it.

   SearchCore.highlights(text, query, field) -> [[start, end], ...]
     Ranges of text (string offsets, end exclusive, sorted, not
     overlapping) that the query matches, for the page to wrap in <mark>
     elements built with DOM calls. field ("t", "d", "o", ... or "title",
     "description", "text") leaves out terms that are limited to another
     field.

   SearchCore.similar(records, id, n, options) -> [ids]
     "More like this": the picture's duplicate group first, then the
     pictures closest in meaning (cosine of the meaning vectors, when the
     index has them and the picture has one), else pictures sharing tags
     and subjects (Jaccard overlap), the same scene or event, or taken
     within two hours (the same day in an export, which has no times);
     one picture per other duplicate group. options: library, hidden,
     sensitive, private, junk as above; by: "look" for "Looks like this"
     (closest by look vector, see "Looks" below; nothing more for a
     picture without one).

   Search by meaning
     index.setVectors(vectors) attaches meaning vectors (decodeVectors of
     /api/vectors' answer or of an export's vectors files: {dims, ids,
     data: Int8Array of the vectors one after the other}); records
     without one are only found by their words. The cosine of a picture
     and the query is the dot product of their signed bytes / 127^2
     (both were unit length times 127), and a cosine is judged by its z:
     how many standard deviations it is above the mean cosine of the whole
     index for that query (see MEANING_MIN_Z). With a query vector and
     words that are not field filters or quoted phrases ("hybrid"), a
     picture's score is its word score divided by the best word score of
     the search (at least WORD_STRONG per free word) plus MEANING_WEIGHT
     times one more than how far its cosine is above the cosine at
     MEANING_FLOOR_Z (1 for the best cosine of the search; below that
     floor it counts against the picture, down to -1: the words are there,
     the meaning is not). Pictures without the words match too when their
     z is at least MEANING_MIN_Z and at most MEANING_MARGIN_Z below the best
     one's (the closest MEANING_EXTRA of them), scored by
     MEANING_WEIGHT times how far their cosine is above the floor alone:
     so they come after every word match whose meaning is at least at the
     floor. When the word matches of a query of one or two words are
     mostly unlike its meaning (their median z below MEANING_WORDS_Z: a
     name, a place, a file name or a year, which the search text of a
     picture leaves out), meaning adds nothing and the words rank as
     without it. Filters, quoted phrases, field words and -words stay
     strict.
     "meaning" ranks by the cosine alone (z at least MEANING_ONLY_Z, at
     most MEANING_ONLY_MARGIN_Z below the best's). In a small set, where
     no z gets far, the closest few (MEANING_FEW) of the pictures without
     the words count when none of them reaches MEANING_MIN_Z and the
     closest is at least the set's few-cut (MEANING_FEW_Z, which grows with
     the number of pictures with a vector until it is the usual cut, faster
     for a query of one free clause: SearchCore.meaningCuts(n)); "meaning"
     takes them too, and the closest few of all pictures when none reaches
     MEANING_MIN_Z. similar: shows the
     pictures at least SIMILAR_MIN_Z close to that picture, or when fewer
     than SIMILAR_FEW are, the closest SIMILAR_FEW if they are close in
     the model's own terms (Index.similarCut; the picture's own duplicate
     stack comes right after it and takes no part). No threshold is a cosine as
     such: models differ in how close their cosines run (one model's
     typical query cosine is 0.28, another's 0.19), so every threshold is
     in standard deviations of the cosines at hand, or of the cosines of
     two pictures taken at random (Index.pairSpread, worked out from the
     index's own vectors).
     SearchCore.meaningText(query) is the text to embed for a query ("" when
     it has no words that meaning could rank: only filters, phrases or a
     similar: or look: term; the words of a clause with person:, place: or
     date: are a name and left out); meaningTexts(query) all the texts to
     embed: that one, then (with two or more free clauses) each free term
     on its own, MEANING_TEXTS in all at most (what /api/embed takes at
     once); decodeVectors(payload), joinVectors([vectors]) and
     queryVector(base64, dims) turn the answers into typed arrays.

   Per-term coverage
     A picture shown for a query of two or more free clauses by words and
     meaning covers every one of them: by its words, or by meaning -- its z
     for the clause's own vector (termVectors) at the term's cut
     (MEANING_TERM_Z; lower for a common word whose z runs low, higher for
     a word whose pictures stand far out) -- unless the term is name-like
     (NAME_SHARE: a person's, a place's or a file's name, a year: nothing a
     description says), which only its words cover -- in an export that
     publishes names (options.names), a published name's tags are no words
     of what a picture shows. A word means more next
     to the others than on its own ("sports" in "red sports car"): a
     picture that lacks one describable clause only also stays when it is
     about as close to the whole query as the pictures with every free
     word are (MEANING_TERM_FULL, MEANING_TERM_MARGIN_Z). Words of position
     ("over", "near": RELATION_WORDS) and words no picture has (a
     misspelling) need no covering. A term without a vector does as
     before (the meaning of the whole query decides). In a small set, where
     no z gets far, a picture close enough to the whole query stays without
     covering each term (MEANING_TERM_RESCUE: a share of the highest z the
     set allows, out of reach from about a thousand pictures), unless it
     lacks a name-like term NAME_SAMPLE or more pictures have (and fewer
     than NAME_SHARE of them in what they show); a name-like term a
     picture shown lacks is then not said to be searched by its words
     only. The ranking of what is shown stays as it was. A single
     free word, phrases, field words and filters are as before.

   SearchCore.interpret(records, query, options), index.interpret(query,
       options) -> {text, query, parts, choices, rest, others, kept,
       changed, dropped}
     Plain language: what a typed query asks for. In its plain words (not
     quoted, no field, not negated, not joined by OR) it finds: dates --
     a year that pictures were taken in ("2019"), "2015-2019" (or "2015 -
     2019"), "between 2015 and 2019", a month or season with a year
     ("November 2024", "the spring of 2016": seasons as north of the
     equator, "winter 2016" is December 2015 to February 2016), "last" or
     "this" year, month, week, month name or season (relative to today,
     options.today: "last November" is the latest November that is over),
     "yesterday", and "since", "after" or "before" any of those -- which
     become date: (dateTerm; a year typed alone "date:2019 OR 2019", so
     a picture with the year in its words, whose date is only its file's,
     is found too); the name of a person (options.people, the people of
     person:, named and not hidden; a run of whole words of the name,
     "anna's" too, one word alone only its first or last, or a longer one
     than three letters that is no NAME_PARTICLES) -- person:"Name" OR the
     typed words (her pictures, and pictures with the word: a folder named
     after her), or in an export (options.names, the names it publishes as
     tags) the words alone, quoted; and the name of a town, region or
     country of the records (or another name of a country, COUNTRY_WORDS;
     a small word such as "us" only in capitals) -- place:name OR the
     words, after an optional "in", "at", "near", ...; and a kind of place
     that pictures were taken at (PLACE_KINDS: "beaches", "museums", "a
     zoo"; a word with another everyday meaning, such as "park" or "bar",
     only with no other plain word right before or after it; of two in a
     row the last, "museum cafe"; not one the query names with kind:
     already) -- kind:key OR each of its words (pictures at a named place
     of that kind, and pictures whose words say it, by words or meaning:
     "kind:cafe OR coffee kind:cafe OR shop"), after an optional "in",
     "at", ... and "the", "a" ("at the airport", "the beach"). A name that
     is both, several people's, a person's that is a month or season, or
     also common words of what the pictures show (COMMON_SHOWN,
     commonWord, commonPlace; a published name's own tags do not count), a
     place after "the" or a word such as "mount" (FEATURE_WORDS), or a
     kind of place that is also a person's or a place's name ("park" and
     Jo Park; but "at the park" is the kind, "in marina" the town), is not
     taken but asked about: choices [{text, key, start, end (in text),
     options: [{kind ("date", "person", "place", "kind" or "words"),
     label, query (what to put in its place; null for the words as
     typed)}]}]; "in" makes it the place, "with" the person. query is
     the text with those parts replaced (the rest of it as typed); parts
     [{kind ("person", "place", "kind" or "date"), label ("Person: Anna",
     "Place: Lisbon", "Kind of place: beaches", "Taken: June - August
     2019"), key (its words, lower case),
     text (as typed), start, end, query (what replaced it), from and to
     (a date's)}]; rest the plain words left (as typed, "" when only small
     words are left); others what is not plain words (field words,
     phrases, -words, OR), as typed; changed: some part was replaced.
     Words about taking the picture or that say nothing of it
     (TAKEN_WORDS: "taken", "shot", "photographed", ...; "something") are
     left out of query when it has such a part, or when "in", "at", "from",
     ... and more words follow them ("taken in Port Ellis", "something at the
     zoo"): dropped lists them. ("something warm to drink" keeps its words.)
     options.typed: keys of parts to leave as typed (kept lists those
     found), or "*" for all; options.plain false: nothing is interpreted.
     The page shows parts as chips and searches query; search() itself
     never interprets (a smart album saves the query as interpreted).
     index.takenSpan() -> {from, to}: the first and last dates taken (or
     null), for the page to say why a date found nothing.

   Looks
     index.setLooks(vectors) attaches look vectors (decodeVectors of
     /api/looks' answer or of an export's looks files): one per picture,
     made by an image model from what the picture looks like (looks.py).
     look:<id> ranks the pictures by the cosine of their look vector to that
     picture's, with the thresholds of similar: (SIMILAR_MIN_Z and the
     closest few of a small set, see Index.similarCut) worked out over the
     look vectors' own cosines: image cosines run on another scale than
     those of descriptions, and nothing here mixes the two. A look cosine
     is the dot product divided by the two vectors' own lengths (rounded
     to whole numbers, they are 127 give or take about 1.5%), as the
     server's duplicate stacks (search_index._look_cosine) work it out.
     Copies of the picture (cosine LOOK_COPY or more: the same picture,
     maybe cropped or edited a little) and the pictures of its duplicate
     stack come right after it but take no part in those thresholds. The
     words and filters of the query still choose which pictures may match.
     The lookVector option does the same for an example picture (whose
     closest copy in the index, if it has one, brings its stack along).

   SearchCore.suggest(records, query, options)
       -> {text, changes: [{from, to}]} | null
     A corrected query for words that match nothing ("did you mean"), from
     the words of the tags first (one edit; two for words of six letters or
     more; the first letter of a short word, and of any word two edits
     away, stays or swaps with the second; when the closest word would
     change it, there is no suggestion). Skipped words are never
     corrected, nor words of the language (SearchCore.isWord(word):
     static/english-words.js, the global ENGLISH_WORDS, when the page
     loads it; SearchCore.setWords(list or filter) sets another, null
     none), and a correction that would find nothing either (with
     options, as for search) is not offered.

   Areas on the map
     index.setPlaces(points, routes) gives the index where its pictures
     were taken (SITE.loadLocations' points and SITE.loadRoutes' routes),
     for the area option. SearchCore.areas: read(text) (the area, or null),
     encode(kind, parts, metres) (its text), has(area, lat, lon, depth),
     label(area, name) ("Main Street, 50 m either side"), name(text) (an
     area's name as an address may give it), bounds(area) ({south, west,
     north, east}), metres(m) ("50 m", "1.2 km"), simplify(points,
     tolerance), worldY(lat), latitudeOf(y), worldScale(lat) and the
     limits MAX_TEXT, MAX_POINTS, MAX_METRES, NAME_LENGTH: see the notes
     at readArea.

   Also: prepare(records) -> index with the same search / similar /
   suggest / interpret methods and get(id); normalize(text);
   tokens(text); fold(word) (the singular a word is searched as);
   forms(word); placeKinds() (the kinds of place of kind:, see
   PLACE_KIND_LIST); kindMatches(query, nk) (a kind: term of the query
   finds the kind nk; an index's kindCounts() and commonKinds(count) say
   which kinds its pictures were taken at); facetLabel(group,
   value); placeLabel(value) ("Albufeira, Algarve, Portugal" for a
   value of the place facet), placeParent(value), placeOf(record) (its
   place as the place facet names it), PLACE_SEPARATOR;
   dateLabel(key) ("May 2019" for "2019-05"); rangeLabel(from, to) (the
   range option in words); timelineChoice(bars, at, extend, anchor) (what
   choosing a bar of the timeline does); FACETS; SORTS; SYNTAX (examples
   for a help popover).

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

    /* ---------- Synonyms --------------------------------------------------- */

    /* Words a query word also finds, at SYNONYM_FACTOR of a direct match.
       "a b c": each of the words finds the others. "a b | x y": a and b
       find each other, and also x and y, which are kinds of them ("dog"
       finds puppies), but x and y do not find a and b (a puppy is a dog;
       most dogs are not puppies). A word with other meanings is only found
       that way too ("fall | autumn": "fall leaves" finds autumn leaves, but
       "autumn" does not find waterfalls or a rock fall). Words are written
       as they are searched: singular, lower case, one word each. Only
       plain words are expanded (and tag: and animal: values), never
       "quoted phrases" or other fields; and a synonym is not looked for in
       the text in a picture (a newspaper that mentions the Huskies is not a
       dog). */
    var SYNONYM_LIST = [
        "kid child | toddler boy girl",
        "baby infant | newborn",
        "mom mother mum mommy",
        "dad father daddy",
        "grandma grandmother granny",
        "grandpa grandfather",
        "dog | puppy doggy retriever labrador poodle terrier beagle bulldog dachshund " +
            "chihuahua spaniel collie corgi pug",
        "cat | kitten kitty tabby",
        "horse | pony foal stallion mare",
        "rabbit bunny",
        "bird | seagull gull pigeon sparrow parrot owl eagle hawk crow robin duck goose " +
            "swan penguin flamingo",
        "fish | clownfish goldfish angelfish butterflyfish lionfish pufferfish",
        "chicken | hen rooster",
        "pig hog | piglet",
        "sheep | lamb",
        "cow cattle",
        "duck | duckling",
        "turtle | tortoise",
        "car automobile | sedan suv hatchback convertible coupe",
        "truck lorry",
        "plane airplane aeroplane aircraft | airliner",
        "bike bicycle",
        "motorbike motorcycle",
        "boat | sailboat yacht canoe kayak ferry ship",
        "tv television",
        "couch sofa",
        "phone smartphone cellphone",
        "computer | laptop",
        "sea ocean",
        "beach seaside",
        "woods | forest",
        "fall | autumn",
        "photo picture photograph",
        "present | gift",
        "christmas xmas",
        "barbecue bbq",
        "birthday bday",
        "party celebration",
        "flower | rose tulip daisy sunflower orchid lily peony blossom",
        "tree | oak pine birch",
        "cake | cupcake cheesecake",
        "shop store",
        "trash garbage rubbish",
        "stroller pram",
        "sweater pullover",
        "trousers pants",
        "sunrise dawn",
        "sunset sundown",
        "doctor physician",
        "police cop",
        "bag | purse handbag backpack"
    ];
    // Half a direct match: a synonym in a title (about 12) stays below the
    // word itself in tags (7), so "mom" shows the pictures tagged "mom"
    // before every "mother duck".
    var SYNONYM_FACTOR = 0.5;

    // word -> [the other words it finds]
    var SYNONYMS = (function () {
        var out = Object.create(null);
        function add(word, others) {
            var list = out[word] || (out[word] = []);
            others.forEach(function (other) {
                if (other !== word && list.indexOf(other) < 0) {
                    list.push(other);
                }
            });
        }
        SYNONYM_LIST.forEach(function (line) {
            var parts = line.split("|");
            var group = parts[0].split(" ").filter(Boolean);
            var kinds = parts.length > 1 ? parts[1].split(" ").filter(Boolean) : [];
            group.forEach(function (word) {
                add(word, group.concat(kinds));
            });
        });
        return out;
    })();

    // The other words a normalized query word finds (an empty list if none).
    function synonymsOf(word) {
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            if (SYNONYMS[forms[k]]) {
                return SYNONYMS[forms[k]];
            }
        }
        return [];
    }

    // True when a term's word may be expanded with its synonyms.
    function expands(term) {
        return term.kind === "word" && !term.quoted &&
            (!term.field || term.field === "tag" || term.field === "animal");
    }

    // The words a term looks for: its own, then its synonyms when it expands.
    function termWords(term) {
        if (term.words.length !== 1 || !expands(term)) {
            return term.words;
        }
        return term.words.concat(synonymsOf(term.words[0]));
    }

    /* ---------- Fields and weights ----------------------------------------- */

    // Every searchable field is a bit of a mask; WEIGHTS[bit] is its score.
    // F_DATE holds the month name of the capture date (weak: "may" and
    // "march" are ordinary words too); F_YEAR its year, which counts about
    // as much as a title word, so "receipt 2019" prefers receipts taken in
    // 2019 over ones that merely mention the year. F_PLACE: the town,
    // region and country of the GPS position, and other names of the
    // country (COUNTRY_WORDS) -- weak, below the description: town names
    // hold everyday words ("Long Beach", "Lake Placid", "Mountain View"),
    // and a picture taken in Long Beach is not a picture of a beach.
    // F_DRIVE: a drive's own title, description and tags, on the record
    // that carries them (see Drives): they are the drive's words, not that
    // clip's, so a plain word searches them apart (term.driveMask), never
    // as part of ALL_FIELDS.
    var F_TITLE = 0, F_TAGS = 1, F_SUBJECTS = 2, F_ANIMALS = 3, F_FOOD = 4, F_VEHICLES = 5,
        F_PEOPLE = 6, F_SCENE = 7, F_EVENT = 8, F_SETTING = 9, F_KIND = 10, F_TEXT = 11,
        F_DESCRIPTION = 12, F_EXTENDED = 13, F_COLORS = 14, F_FLAGS = 15, F_FOLDER = 16,
        F_FILE = 17, F_CAMERA = 18, F_DATE = 19, F_YEAR = 20, F_PLACE = 21, F_DRIVE = 22;
    var WEIGHTS = [10, 7, 6, 6, 6, 6, 6, 4, 4, 4, 4, 4, 3, 3, 2, 2, 1, 1, 1, 1, 8, 2, 3];
    var DRIVE_BIT = 1 << F_DRIVE;
    var ALL_FIELDS = ((1 << WEIGHTS.length) - 1) & ~DRIVE_BIT;
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

    /* Ranking: the real thing over pictures of it. A word names an animal,
       a vehicle or food (a "thing") when it ends items of the animals,
       vehicles or food field ("dog", "brown dog"), in at least THING_SHARE
       of the pictures that have it in their words at all ("light" ends
       "street light" in some vehicle lists, but is mostly something else).
       It is a thing of the fields where it does that at least a third as
       often as in the field where it does it most ("dog" ends "hot dog" in
       a few food lists, but is an animal), and not only after a sweet
       (EDIBLE_WORDS: a "gingerbread house" does not make "house" a food).
       A few words for kinds of things (KIND_WORDS: "animal", "vehicle",
       "flower", "tree", ...) are things of no field.
       For a thing, a picture that names it (or a synonym) in its field, as
       itself, or in its title (not as a depiction: a picture of beer
       bottles is about beer even when its food field is empty), gets
       REAL_BONUS; for a kind word with a field of its own (KIND_FIELDS:
       "animal", "vehicle", "food"), any real item in that field will do,
       and a picture without one is ranked like a depiction ("animal
       tracks"). One that names it as a thing of another field only (a hot
       dog for "dog") gets no bonus, and is ranked like a depiction when
       the word is searched alone. One that is a drawing, screenshot,
       document, meme or diagram (DEPICTION_TYPES: the dog of a cartoon,
       the coffee of a menu), or that shows it as a toy, statue, drawing,
       logo, costume and the like (DEPICTION words next to it in its title,
       subjects, tags, description or those fields: "toy car", "dog
       statue", "a painting of a horse"), keeps DEPICTION_FACTOR of its
       score: below the real ones, but not below every passing mention.
       When the query asks for such things itself ("toy car", "teddy
       bear", "dog statue", "bird art", "car document"), it is the other
       way round: a picture that shows the thing so, or is a drawing,
       document, ... gets REAL_BONUS, and the real thing nothing. The
       describe prompt keeps toys, statues and pictures of animals out of
       the animals field. */
    var THING_FIELDS = (1 << F_ANIMALS) | (1 << F_FOOD) | (1 << F_VEHICLES);
    var THING_SHARE = 0.1;
    // The fields whose words count for THING_SHARE: what a picture shows.
    var CONTENT_FIELDS = (1 << F_TITLE) | (1 << F_TAGS) | (1 << F_SUBJECTS) | THING_FIELDS |
        (1 << F_PEOPLE) | (1 << F_SCENE) | (1 << F_DESCRIPTION) | (1 << F_EXTENDED) |
        (1 << F_COLORS);
    var KIND_THING = 1 << 30;
    // Kind words that have a field of their own: any real item there is one.
    var KIND_FIELDS = dict({animal: 1 << F_ANIMALS, pet: 1 << F_ANIMALS,
                            creature: 1 << F_ANIMALS, vehicle: 1 << F_VEHICLES,
                            food: 1 << F_FOOD});
    var KIND_WORDS = wordSet("animal pet creature vehicle food flower blossom bouquet rose " +
        "tulip daisy sunflower orchid lily peony hibiscus plant tree cactus succulent fern " +
        "palm leaf");
    var DEPICTION_TYPES = wordSet("artwork meme screenshot document diagram");
    // Words for art that, like DEPICTION_TYPES, ask for depictions ("bird art").
    var ART_WORDS = wordSet("art artwork collage craft papercraft");
    var REAL_BONUS = 3;
    var DEPICTION_FACTOR = 0.6;
    var DEPICTION_FIELDS = (1 << F_TITLE) | (1 << F_TAGS) | (1 << F_SUBJECTS) | THING_FIELDS |
        (1 << F_DESCRIPTION) | (1 << F_EXTENDED);
    // Words that make the word after them a depiction ("toy car", "stuffed dog"),
    var DEPICTION_BEFORE = wordSet("toy plush stuffed cartoon inflatable origami lego fake " +
        "artificial model teddy carved sculpted drawn animated statue figurine sculpture " +
        "sticker balloon");
    // materials that do so when the word ends a phrase ("a plastic dinosaur",
    // "paper flowers"; but a "paper coffee cup" is a cup),
    var DEPICTION_MATERIALS = wordSet("plastic paper ceramic porcelain rubber cardboard " +
        "decorative");
    // the word before them ("dog statue", "horse logo", "dinosaur costume"),
    var DEPICTION_AFTER = wordSet("toy figurine figure statue statuette sculpture sticker " +
        "decal magnet ornament plush plushie doll puppet costume mascot logo emblem icon " +
        "emoji drawing painting sketch illustration cartoon print pattern poster mural sign " +
        "symbol livery footprint pawprint balloon shaped replica carving tattoo pillow " +
        "cutout silhouette");
    // or the word after "of" ("a painting of a horse", "statues of two lions").
    var DEPICTION_OF = wordSet("statue statuette figurine sculpture drawing painting " +
        "illustration sketch poster mural model replica cartoon print carving toy sticker " +
        "logo silhouette cutout depiction rendering render");
    // Words that may stand between a depiction word and its thing.
    var SMALL_WORDS = wordSet("a an the two three four some several many few one");
    var EDIBLE_WORDS = wordSet("gingerbread chocolate candy cookie sugar marshmallow jelly " +
                               "gummy marzipan fondant");
    var MARK_BEFORE = 1, MARK_AFTER = 2, MARK_OF = 4, MARK_SMALL = 8, MARK_OF_WORD = 16,
        MARK_MATERIAL = 32;
    // One word searched alone that is found only in the text in a picture
    // (OCR), or only in its place names, keeps this part of its score:
    // pictures about it come first ("beach" in a description before a
    // living room in Long Beach). Not for place: (only places match).
    var TEXT_ONLY_FACTOR = 0.5;
    var WEAK_FIELDS = (1 << F_TEXT) | (1 << F_PLACE);
    // The fields that say what a picture shows (see "Per-term coverage"):
    // not its folder and file names, camera, date, place or the text in it,
    // which hold names.
    var SHOWN_FIELDS = CONTENT_FIELDS | (1 << F_EVENT) | (1 << F_SETTING) | (1 << F_KIND) |
        (1 << F_FLAGS) | DRIVE_BIT;
    // ... for a name an export publishes (search's names option): not the
    // tags, where the export put it (export.add_people_names).
    var NAME_SHOWN_FIELDS = SHOWN_FIELDS & ~(1 << F_TAGS);

    // field: names -> the fields they search.
    var FIELD_MASKS = dict({
        tag: 1 << F_TAGS, subject: 1 << F_SUBJECTS, title: 1 << F_TITLE, text: 1 << F_TEXT,
        description: 1 << F_DESCRIPTION, scene: 1 << F_SCENE, setting: 1 << F_SETTING,
        event: 1 << F_EVENT, animal: 1 << F_ANIMALS, food: 1 << F_FOOD,
        vehicle: 1 << F_VEHICLES, color: 1 << F_COLORS, camera: 1 << F_CAMERA,
        folder: 1 << F_FOLDER, file: 1 << F_FILE, place: 1 << F_PLACE
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
        library: "lib", has: "has", is: "is", place: "place", places: "place", on: "on",
        similar: "similar", like: "similar", look: "look", looks: "look",
        rating: "rating", rated: "rating", stars: "rating", album: "album", albums: "album",
        person: "person", date: "date", taken: "date", kind: "kind", kinds: "kind",
        placekind: "kind"
    });
    // Record keys (and field names) for highlights(text, query, field).
    var HIGHLIGHT_FIELDS = dict({
        t: F_TITLE, title: F_TITLE, g: F_TAGS, tags: F_TAGS, s: F_SUBJECTS,
        subjects: F_SUBJECTS, a: F_ANIMALS, fo: F_FOOD, v: F_VEHICLES, pd: F_PEOPLE,
        sc: F_SCENE, st: F_SETTING, ev: F_EVENT, ty: F_KIND, dt: F_KIND, td: F_KIND,
        o: F_TEXT, text: F_TEXT, d: F_DESCRIPTION, description: F_DESCRIPTION,
        ex: F_EXTENDED, c: F_COLORS, qf: F_FLAGS, f: F_FOLDER, n: F_FILE, cm: F_CAMERA,
        ci: F_PLACE, rg: F_PLACE, co: F_PLACE, np: F_PLACE, place: F_PLACE,
        dvt: F_DRIVE, dvd: F_DRIVE, dvg: F_DRIVE
    });

    // Other names of countries (by ISO code) that find pictures taken
    // there, besides the name the place names give ("usa", "uk").
    var COUNTRY_WORDS = dict({
        US: ["usa", "us", "america", "united states of america"],
        GB: ["uk", "britain", "great britain"], AE: ["uae", "emirates"], NL: ["holland"],
        CZ: ["czech republic"], KR: ["korea"], MK: ["macedonia"], TR: ["turkey", "turkiye"],
        MM: ["burma"], SZ: ["swaziland"], CV: ["cape verde"], DE: ["deutschland"],
        ES: ["espana"], IT: ["italia"], CH: ["schweiz", "suisse"], AT: ["osterreich"]
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
        if (rec.mv) {
            // (Its ty is "video"; also the words people use for one, and the
            // kind the AI model saw in its frames: a screen recording.)
            kind.push("movie clip footage");
            if (isText(rec.vt) && rec.vt !== "other") {
                kind.push(rec.vt);
            }
            if (rec.dv !== undefined && rec.dv !== null) {
                kind.push("drive");
            }
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
        add(F_DRIVE, textList(rec.dvt).concat(textList(rec.dvd), textList(rec.dvg)));
        // (The named place on the street maps, np, is a place too: place:"harbour
        // aquarium" finds the pictures taken there.)
        add(F_PLACE, (isText(rec.co) ? textList(rec.ci).concat(textList(rec.rg), [rec.co],
                                                               COUNTRY_WORDS[rec.cc] || [])
            : []).concat(textList(rec.np)));
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

    /* ---------- Kinds of place (kind:) ------------------------------------ */

    /* The kinds of place where pictures were taken: the kind of a record's
       named place on the street maps (nk: the kind of the point of interest
       or area that carries the name, named_places.py KINDS and SHOWN_SHOPS),
       by the words people use for them. One line per kind of place: "key: label | words
       | kinds" -- key is what kind: writes for it (kind:beach), label what
       the chip of plain-language search says ("Kind of place: beaches"),
       words the words and phrases that name it, singular (a plural finds
       it too: "beaches", "art galleries"), kinds the nk values it finds.
       A word marked "~" has another everyday meaning too ("a car park", "a
       candy bar", "a home theater", "a pillow fort", "Memorial Day"):
       plain-language search takes it as the kind of place only with no
       other plain word right before it (but "in", "at", "near", ... and
       "the" or "a": "at the park") and none right after it (but a date, a
       place or a person: "parks 2024"); kind: always.
       A word finds what it names, no more: a broad word may hold the
       narrower kinds the maps have ("bars" finds pubs, wine bars and
       nightclubs too; "hotels" motels), a narrower word only its own kind
       ("pubs", "motels", "resorts"), and a sort of place the maps have no
       kind for stays a word -- "pizzeria", "diner", "inn", "lodge",
       "arena", "cathedral", "state park", "botanical garden", "flea
       market": most places of the broader kind are something else, and
       they would push the pictures that say it down. (Measured on a
       library of several thousand pictures: "motel" and "lodge" found
       every hotel, "pizzeria" every restaurant, "arena" the baseball
       stadiums, "state parks" a city's forest park.) Only where the maps
       make no difference and the word names most of what the kind holds
       does it find the kind: a church, a temple, a mosque and a synagogue
       are all a place of worship, a wildlife park and a safari park a zoo.
       A narrower word of a phrase stays a word of its own ("petting zoo":
       the pictures with "petting" taken at a zoo or saying it). */
    var PLACE_KIND_LIST = [
        "beach: beaches | beach, ~seaside | beach",
        "museum: museums and galleries | museum | museum gallery",
        "gallery: art galleries | ~gallery, art gallery | gallery",
        "zoo: zoos and wildlife parks | zoo, wildlife park, safari park, animal park | zoo",
        "aquarium: aquariums | aquarium | aquarium",
        "airport: airports | airport, aerodrome, airfield | airport aerodrome",
        "park: parks | ~park | park dog_park recreation_ground village_green",
        "national_park: national parks | national park | national_park",
        "nature_reserve: nature reserves | nature reserve, nature preserve | nature_reserve",
        "protected_area: protected areas | protected area | protected_area",
        "dog_park: dog parks | dog park | dog_park",
        "theme_park: theme parks | theme park, amusement park, funfair, fun fair | theme_park",
        "water_park: water parks | water park, waterpark | water_park",
        "garden: gardens | ~garden | garden",
        "playground: playgrounds | playground | playground",
        "pitch: sports fields | sports field, playing field, ~pitch | pitch",
        "restaurant: restaurants | restaurant, eatery | restaurant fast_food food_court",
        "cafe: cafes | cafe, coffee shop, coffeehouse, coffee house | cafe",
        "bar: bars and pubs | ~bar | bar pub wine_bar biergarten nightclub",
        "pub: pubs | pub, tavern | pub",
        "wine_bar: wine bars | wine bar | wine_bar",
        "biergarten: beer gardens | beer garden, biergarten | biergarten",
        "nightclub: nightclubs | nightclub, night club | nightclub",
        "bakery: bakeries | bakery | bakery",
        "ice_cream: ice cream shops | ice cream shop, ice cream parlor, ice cream parlour, " +
            "gelateria | ice_cream",
        "brewery: breweries | brewery, brewpub, taproom | brewery",
        "winery: wineries | winery, vineyard, wine estate | winery",
        "hotel: hotels and motels | hotel | hotel motel",
        "motel: motels | motel | motel",
        "hostel: hostels | hostel | hostel",
        "resort: resorts | ~resort | resort",
        "alpine_hut: mountain huts | mountain hut, alpine hut | alpine_hut",
        "camp_site: campsites | campsite, camp site, campground, camping ground | camp_site " +
            "caravan_site",
        "caravan_site: caravan parks | caravan park, caravan site, rv park | caravan_site",
        "viewpoint: viewpoints | viewpoint, lookout, overlook, scenic overlook, scenic " +
            "viewpoint, vista point | viewpoint",
        "place_of_worship: places of worship | place of worship, house of worship, church, " +
            "temple, mosque, synagogue | place_of_worship",
        "stadium: stadiums | stadium | stadium",
        "sports_centre: sports centres | sports centre, sports center, sports complex, " +
            "recreation centre, recreation center | sports_centre",
        "ice_rink: ice rinks | ice rink, skating rink | ice_rink",
        "castle: castles | castle | castle",
        "fort: forts | ~fort, fortress, citadel | fort",
        "lighthouse: lighthouses | lighthouse | lighthouse",
        "waterfall: waterfalls | waterfall | waterfall",
        "monument: monuments and memorials | monument | monument memorial",
        "memorial: memorials | ~memorial | memorial",
        "ruins: ruins | ruin | ruins archaeological_site",
        "archaeological_site: archaeological sites | archaeological site | archaeological_site",
        "tower: towers | ~tower | tower",
        "observatory: observatories | observatory | observatory",
        "planetarium: planetariums | planetarium | planetarium",
        "theatre: theatres | ~theater, ~theatre, playhouse | theatre",
        "cinema: cinemas | cinema, movie theater, movie theatre, multiplex | cinema",
        "arts_centre: arts centres | arts centre, arts center, art centre, art center, " +
            "cultural centre, cultural center | arts_centre",
        "library: libraries | ~library | library",
        "casino: casinos | casino | casino",
        "mall: shopping malls | mall, shopping mall, shopping centre, shopping center | mall",
        "department_store: department stores | department store | department_store",
        "market: markets | ~market, marketplace | marketplace",
        "gift: gift shops | gift shop, souvenir shop | gift",
        "books: bookshops | bookshop, bookstore, book shop, book store | books",
        // (Shops named only for a picture that shows one: named_places.py
        // SHOWN_SHOPS, by the words the viewer says them in.)
        "clothes: clothes shops | clothes shop, clothes store, clothing store, ~boutique | " +
            "clothes",
        "shoes: shoe shops | shoe shop, shoe store | shoes",
        "car: car dealers | car dealer, car dealership, car showroom | car",
        "furniture: furniture shops | furniture shop, furniture store | furniture bed",
        "bed: bed shops | bed shop, mattress shop, mattress store | bed",
        "wholesale: warehouse stores | warehouse store, warehouse club | wholesale",
        "supermarket: supermarkets | supermarket, grocery store | supermarket",
        "jewelry: jewellery shops | jewellery shop, jewelry shop, jewellery store, " +
            "jewelry store | jewelry",
        "electronics: electronics shops | electronics shop, electronics store | electronics",
        "mobile_phone: phone shops | phone shop, phone store, mobile phone shop | mobile_phone",
        "toys: toy shops | toy shop, toy store | toys",
        "sports: sports shops | sports shop, sports store, sporting goods store | sports",
        "outdoor: outdoor shops | outdoor shop, outdoor store, outfitter | outdoor",
        "music: music shops | music shop, music store, record shop, record store | music",
        "florist: florists | florist, flower shop | florist",
        "cosmetics: cosmetics shops | cosmetics shop, cosmetics store | cosmetics",
        "doityourself: DIY stores | DIY store, home improvement store | doityourself",
        "hardware: hardware stores | hardware store, hardware shop | hardware",
        "variety_store: variety stores | variety store, dollar store | variety_store",
        "marina: marinas | marina, yacht harbor, yacht harbour | marina",
        "pier: piers | ~pier | pier",
        "ferry_terminal: ferry terminals | ferry terminal, ferry port, ferry dock | " +
            "ferry_terminal",
        "station: train stations | ~station, train station, railway station, railroad station " +
            "| station",
        "bus_station: bus stations | bus station, bus terminal | bus_station",
        "university: universities | university | university",
        "college: colleges | ~college | college",
        "campus: universities and colleges | ~campus | university college",
        "school: schools | ~school | school",
        "hospital: hospitals | hospital | hospital",
        "cemetery: cemeteries | cemetery, graveyard, burial ground | cemetery",
        "golf_course: golf courses | golf course, golf links | golf_course",
        "ski: ski areas | ski area, ski resort, ski slope, ski hill, ski field | ski " +
            "winter_sports",
        "picnic_site: picnic areas | picnic area, picnic site, picnic spot | picnic_site",
        "fountain: fountains | ~fountain | fountain",
        "bridge: bridges | ~bridge | bridge",
        "peak: mountain tops | ~peak, ~summit, mountain top, mountaintop | peak",
        "volcano: volcanoes | volcano | volcano",
        "hot_spring: hot springs | hot spring, thermal spring | hot_spring",
        "geyser: geysers | geyser | geyser",
        "cave: caves | ~cave, cavern | cave_entrance",
        "glacier: glaciers | glacier | glacier",
        "forest: forests | ~forest | forest wood",
        "conference_centre: convention centres | convention center, convention centre, " +
            "conference center, conference centre | conference_centre exhibition_centre",
        "exhibition_centre: exhibition centres | exhibition center, exhibition centre, expo " +
            "center, expo centre | exhibition_centre",
        "events_venue: event venues | event venue, events venue | events_venue",
        "townhall: town halls | town hall, city hall | townhall",
        "amusement_arcade: arcades | ~arcade, amusement arcade, video arcade | amusement_arcade",
        "attraction: tourist attractions | tourist attraction, ~attraction | attraction"
    ];
    // The most words of a phrase of PLACE_KIND_LIST.
    var KIND_WORDS_MAX = 3;

    /* PLACE_KIND_LIST read: {list: [{key, label, words: [phrases], kinds}],
       byKey: {key: entry}, phrases: {first word: [{words, entry, loose}],
       longest first}, kinds: {nk: true} (every kind a line names)}. */
    var PLACE_KINDS = (function () {
        var out = {list: [], byKey: Object.create(null), phrases: Object.create(null),
                   kinds: Object.create(null)};
        PLACE_KIND_LIST.forEach(function (line) {
            var head = line.split(":");
            var parts = line.slice(head[0].length + 1).split("|");
            var entry = {key: head[0], label: parts[0].replace(/^\s+|\s+$/g, ""), words: [],
                         kinds: parts[2].split(" ").filter(Boolean)};
            parts[1].split(",").forEach(function (phrase) {
                var text = phrase.replace(/^\s+|\s+$/g, "");
                var loose = text.charAt(0) === "~";
                var words = tokens(loose ? text.slice(1) : text);
                entry.words.push(words.join(" "));
                var list = out.phrases[words[0]] || (out.phrases[words[0]] = []);
                list.push({words: words, entry: entry, loose: loose});
            });
            entry.kinds.forEach(function (kind) {
                out.kinds[kind] = true;
            });
            out.list.push(entry);
            out.byKey[entry.key] = entry;
        });
        Object.keys(out.phrases).forEach(function (first) {
            out.phrases[first].sort(function (a, b) {
                return b.words.length - a.words.length;
            });
        });
        return out;
    })();

    // True when a normalized typed word is a word of PLACE_KIND_LIST (the
    // same, or its plural: "beaches" for "beach").
    function kindWordIs(typed, word) {
        if (typed === word) {
            return true;
        }
        var forms = wordForms(typed);
        for (var k = 1; k < forms.length; k++) {
            if (forms[k] === word) {
                return true;
            }
        }
        return false;
    }

    /* The phrase of PLACE_KIND_LIST that words (normalized) start with, the
       longest: {words (how many), entry, loose}, or null. whole: only one
       that is all of words. */
    function kindPhrase(words, whole) {
        var found = null;
        (words.length ? wordForms(words[0]) : []).forEach(function (first) {
            (PLACE_KINDS.phrases[first] || []).some(function (phrase) {
                var size = phrase.words.length;
                if (size > words.length || (whole && size !== words.length) ||
                        (found && found.words >= size)) {
                    return false;
                }
                for (var k = 1; k < size; k++) {
                    if (!kindWordIs(words[k], phrase.words[k])) {
                        return false;
                    }
                }
                found = {words: size, entry: phrase.entry, loose: phrase.loose};
                return true;
            });
        });
        return found;
    }

    /* The kinds a kind: value finds: {kind "place_kind", value (what it
       was read as: a key of PLACE_KIND_LIST or an nk), kinds, entry (its
       line, or null)}, or null for a value of no word. A key of a line is
       that line ("kind:museum", "kind:place_of_worship"); else an nk that a
       line names, alone ("kind:aerodrome", "kind:fast_food"); else the line
       its words name ("kind:beaches", "kind:church", kind:"golf course");
       else the value as an nk of its own (named_places.py has more kinds
       than the lines name: "kind:cape"). */
    function placeKindFilter(value) {
        var words = tokens(value);
        if (!words.length) {
            return null;
        }
        var key = words.join("_");
        var entry = PLACE_KINDS.byKey[key];
        if (entry) {
            return {kind: "place_kind", value: key, kinds: entry.kinds, entry: entry};
        }
        if (PLACE_KINDS.kinds[key] === true) {
            return {kind: "place_kind", value: key, kinds: [key], entry: null};
        }
        var phrase = kindPhrase(words, true);
        if (phrase) {
            return {kind: "place_kind", value: phrase.entry.key, kinds: phrase.entry.kinds,
                    entry: phrase.entry};
        }
        return {kind: "place_kind", value: key, kinds: [key], entry: null};
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
    var FILLER_WORDS = wordSet("my our your me i we us show find all");
    // Words of position that a description rarely repeats ("sunset over the
    // ocean"): searched like any word, but by words and meaning a picture
    // need not cover them on its own (see "Per-term coverage").
    // ("Inside" and "outside" say where a picture was taken: not these.)
    var RELATION_WORDS = wordSet("over under above below beneath underneath behind beside " +
        "near between around through across along against toward towards onto upon " +
        "during within beyond among amid via");
    var NOUN_FILLERS = wordSet("picture pic photo photograph image");
    // "no people" and "without people" mean people:none.
    var NO_WORDS = wordSet("no without");
    var PEOPLE_NOUNS = wordSet("people person persons human humans anyone anybody");

    // ("video" is no answer of the AI model: every video's record has it.)
    var PHOTO_TYPES = ["photo", "video", "screenshot", "document", "scan", "artwork", "meme",
                       "diagram", "other"];
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
        panorama: "360", pano: "360", movie: "video", clip: "video", vid: "video"
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
        junk: "junk", v4: "v4", old: "v4", edited: "edited", edit: "edited",
        favorite: "favorite", favourite: "favorite", fav: "favorite", faved: "favorite",
        starred: "favorite", star: "favorite", rated: "rated", unrated: "unrated",
        drive: "drive", dashcam: "drive", "gps-ignored": "gps_ignored",
        gps_ignored: "gps_ignored", "location-ignored": "gps_ignored",
        location_ignored: "gps_ignored", "ignored-gps": "gps_ignored", ignored_gps: "gps_ignored",
        "place-estimated": "place_estimated", place_estimated: "place_estimated",
        "estimated-place": "place_estimated", estimated_place: "place_estimated",
        estimated: "place_estimated", "location-estimated": "place_estimated",
        location_estimated: "place_estimated"
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

    function two(number) {
        return (number < 10 ? "0" : "") + number;
    }

    /* rating:4 (exactly 4 stars), rating:>=3, >3, <=2, <2, 4+ or 3-5
       (comparisons find rated pictures only), rating:0 (or none,
       unrated): pictures without a rating. {kind "rating", min, max}. */
    function ratingFilter(value) {
        var text = value.replace(/\s+/g, "");
        if (/^(0|none|no|unrated|not)$/.test(text)) {
            return {kind: "rating", min: 0, max: 0};
        }
        var range = /^([0-5])(?:-|\.\.|\u2013)([0-5])$/.exec(text);
        if (range) {
            var low = parseInt(range[1], 10);
            var high = parseInt(range[2], 10);
            return {kind: "rating", min: Math.min(low, high), max: Math.max(low, high)};
        }
        var match = /^([<>]=?|=[<>]?)?([0-5])(\+)?$/.exec(text);
        if (!match) {
            return null;
        }
        var stars = parseInt(match[2], 10);
        var op = match[3] ? ">=" : match[1] || "=";
        if (op.length === 2 && op.charAt(0) === "=") {
            op = op.charAt(1) + "=";            // (=> is >=, =< is <=)
        }
        var min = op === ">=" ? stars : op === ">" ? stars + 1 : op === "=" ? stars : 1;
        var max = op === "<=" ? stars : op === "<" ? stars - 1 : op === "=" ? stars : 5;
        if (op !== "=" && min === 0) {
            min = 1;                    // (rating:>=0: every rated picture)
        }
        return min <= max ? {kind: "rating", min: min, max: max} : null;
    }

    /* date:2019, date:2019-05, date:2019-05-14 (taken then), or a range of
       them with ".." (both ends included; either may be left out:
       date:2019-06..2019-08, date:2019.., date:..2018-12): {kind "date",
       from, to} (date keys, "" for an open end), or null. */
    function dateFilter(value) {
        var text = value.replace(/\s+/g, "");
        var parts = text.indexOf("..") >= 0 ? text.split("..") : [text, text];
        if (parts.length !== 2 || (!parts[0] && !parts[1])) {
            return null;
        }
        var from = parts[0] ? dateKey(parts[0]) : "";
        var to = parts[1] ? dateKey(parts[1]) : "";
        if (from === null || to === null) {
            return null;
        }
        if (from && to && from.slice(0, to.length) > to) {
            return null;
        }
        return {kind: "date", from: from, to: to};
    }

    // on:today (this day in earlier years), on:MM-DD (that day of any year)
    // or on:YYYY-MM-DD (that day).
    function onFilter(value) {
        if (value === "today") {
            return {kind: "on", today: true};
        }
        var match = /^(\d{1,2})[-\/.](\d{1,2})$/.exec(value);
        if (match) {
            var month = parseInt(match[1], 10);
            var day = parseInt(match[2], 10);
            if (month < 1 || month > 12 || day < 1 || day > 31) {
                return null;
            }
            return {kind: "on", key: "-" + two(month) + "-" + two(day)};
        }
        var key = dateKey(value);
        return key && key.length === 10 ? {kind: "on", date: key} : null;
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
        } else if (field === "on") {
            filter = onFilter(value);
            hint = "try on:today, or on:05-14 for a month and day";
        } else if (field === "date") {
            filter = dateFilter(value);
            hint = "try date:2019, date:2019-05 or date:2019-06..2019-08";
        } else if (field === "lib") {
            filter = {kind: "lib", value: String(raw).replace(/^\s+|\s+$/g, "")};
        } else if (field === "album") {
            filter = {kind: "album", value: String(raw).replace(/^\s+|\s+$/g, "")};
        } else if (field === "kind") {
            filter = placeKindFilter(value);
            hint = "try kind:beach, kind:museum, kind:park or kind:restaurant";
        } else if (field === "person") {
            filter = {kind: "person", value: String(raw).replace(/^\s+|\s+$/g, "")};
            hint = "try person:\"Name\", person:any or person:none";
            filter = filter.value ? filter : null;
        } else if (field === "rating") {
            filter = ratingFilter(value);
            hint = "try rating:4, rating:>=3 or rating:0 for pictures without one";
        } else if (field === "has") {
            var what = lookupWord(HAS_WORDS, value);
            filter = what ? {kind: "has", what: what} : null;
            hint = "try text, gps, people, animals, food or vehicles";
        } else if (field === "is") {
            var state = lookupWord(IS_WORDS, value);
            filter = state ? {kind: "is", what: state} : typeFilter(value);
            hint = "try 360, duplicate, undescribed, edited, favorite, screenshot or document";
        } else if (field === "similar" || field === "look") {
            var picture = String(raw).replace(/^\s+|\s+$/g, "");
            filter = /^[0-9A-Za-z_-]{1,64}$/.test(picture) ? {kind: field, value: picture}
                : null;
            hint = field + ": takes a picture id; " + (field === "look" ? "Looks like this"
                : "More like this") + " in the viewer writes it";
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
        // ("US" in capitals is the country: "beach US".)
        if (FILLER_WORDS[word] && !(word === "us" && /^U\.?S\.?$/.test(term.value))) {
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
        // (A plain word also searches the drives' own words, apart.)
        term.driveMask = term.field ? 0 : DRIVE_BIT;
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
        // (A kind of place as the alternative to a word, as plain language
        // writes it -- "kind:cafe OR coffee kind:cafe OR shop" -- keeps the
        // words' order counting: "coffee shop" together.)
        var hasOr = clauses.some(function (clause) {
            return clause.terms.filter(function (term) {
                return !(term.filter && term.filter.kind === "place_kind");
            }).length > 1;
        });
        // A kind of place as the alternative to words is no question of its
        // own: it says nothing when no picture has a named place (filterTest).
        clauses.forEach(function (clause) {
            var worded = clause.terms.some(function (term) {
                return term.kind !== "filter" && !term.neg;
            });
            clause.terms.forEach(function (term) {
                if (worded && term.filter && term.filter.kind === "place_kind") {
                    term.filter.alternative = true;
                }
            });
        });
        // The sequence: the plain words in order, without skipped words at
        // either end ("photo of a dog on the beach" -> "dog on the beach"),
        // but for a last "us" ("contact us": the words of a web page).
        var plainTerms = terms.filter(function (term) {
            return !term.field && !term.quoted && !term.neg && term.kind !== "filter";
        });
        while (plainTerms.length && !plainTerms[0].active) {
            plainTerms.shift();
        }
        while (plainTerms.length && !plainTerms[plainTerms.length - 1].active &&
               plainTerms[plainTerms.length - 1].words[0] !== "us") {
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
        {key: "favorite", label: "Favorites"},
        {key: "rating", label: "Rating"},
        {key: "type", label: "Type"},
        {key: "people", label: "People"},
        {key: "setting", label: "Setting"},
        {key: "time", label: "Time of day"},
        {key: "event", label: "Event"},
        {key: "year", label: "Year"},
        {key: "month", label: "Month"},
        {key: "place", label: "Place"},
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
    /* Groups worked out from the records as they are at each search, not
       when they are indexed: "has" (flags), and the owner's favorites and
       ratings, which the page changes in place (see livePass). */
    var LIVE_GROUPS = wordSet("has favorite rating");
    // Groups with values indexed once (all but LIVE_GROUPS).
    var VALUE_KEYS = FACETS.map(function (facet) {
        return facet.key;
    }).filter(function (key) {
        return !LIVE_GROUPS[key];
    });
    // The values of the rating group, best first.
    var RATING_VALUES = ["5", "4", "3", "2", "1"];
    var MULTI_GROUPS = wordSet("type tags subjects animals food vehicles colors place");
    var LOWER_GROUPS = wordSet("tags subjects animals food vehicles colors");
    // Groups whose values are grouped by their singular (see facetKey).
    var FOLDED_GROUPS = wordSet("tags subjects animals food vehicles");
    // Plurals that mean something else than their singular, kept apart.
    var KEEP_PLURALS = wordSet("glasses sunglasses eyeglasses woods clothes shorts pants " +
                               "jeans news series species scissors binoculars goggles " +
                               "stairs");
    // ...except glasses to drink from ("wine glasses" are wine glasses).
    var DRINK_WORDS = wordSet("wine champagne beer shot drinking cocktail martini water " +
                              "pint juice whiskey");
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
        photo: "Photos", video: "Videos", screenshot: "Screenshots", document: "Documents",
        scan: "Scans",
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
        has: dict({text: "Has text", gps: "Has a location",
                   "360": "360\u00b0 photos and videos"}),
        favorite: dict({yes: "Favorites"}),
        rating: dict({"5": "5 stars", "4": "4 stars", "3": "3 stars", "2": "2 stars",
                      "1": "1 star"})
    });

    /* The values of the place group: "Country", "Country|Region" and
       "Country|Region|Town" ("Country||Town" when the town's region is not
       known). A picture has those of its place, so choosing a country
       finds every picture taken there. */
    var PLACE_SEPARATOR = "|";

    function placeName(text) {
        return String(text).split(PLACE_SEPARATOR).join("/");
    }

    function placeValues(rec) {
        if (!isText(rec.co)) {
            return [];
        }
        var country = placeName(rec.co);
        var region = isText(rec.rg) ? placeName(rec.rg) : "";
        var out = [country];
        if (region) {
            out.push(country + PLACE_SEPARATOR + region);
        }
        if (isText(rec.ci)) {
            out.push(country + PLACE_SEPARATOR + region + PLACE_SEPARATOR + placeName(rec.ci));
        }
        return out;
    }

    // The place a place value is in ("" for a country).
    function placeParent(value) {
        var parts = String(value).split(PLACE_SEPARATOR);
        if (parts.length >= 3) {
            return parts[1] ? parts[0] + PLACE_SEPARATOR + parts[1] : parts[0];
        }
        return parts.length === 2 ? parts[0] : "";
    }

    // 0 for a country, 1 a region, 2 a town.
    function placeLevel(value) {
        return Math.min(2, String(value).split(PLACE_SEPARATOR).length - 1);
    }

    // "Albufeira, Algarve, Portugal" for a place value.
    function placeLabel(value) {
        return String(value).split(PLACE_SEPARATOR).filter(Boolean).reverse().join(", ");
    }

    /* A label for a facet value: facetLabel("type", "doc:receipt") is
       "Receipts", facetLabel("month", "2019-05") is "May 2019",
       facetLabel("place", "Portugal|Algarve") is "Algarve". Library
       values are ids; the page shows their names. */
    function facetLabel(group, value) {
        var text = value === null || value === undefined ? "" : String(value);
        if (group === "place") {
            var parts = text.split(PLACE_SEPARATOR).filter(Boolean);
            return parts.length ? parts[parts.length - 1] : text;
        }
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

    /* What a value of a FOLDED_GROUPS group is grouped by: its words, each
       singular ("golden retrievers" and "Golden Retriever" are one). */
    function facetKey(value) {
        var words = tokens(value);
        if (!words.length) {
            return value;
        }
        return words.map(function (word, k) {
            return KEEP_PLURALS[word] && !(k > 0 && DRINK_WORDS[words[k - 1]]) ? word :
                foldWord(word);
        }).join(" ");
    }

    function sameValue(value) {
        return value;
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
        case "place":
            return placeValues(rec);
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

    /* The values of one facet group for every record: one value id per
       record (single) or a list per record (offsets/flat). values[id] is
       what keyOf(value) gives for the values of that id (the value itself,
       or its facetKey in a FOLDED_GROUPS group), labels[id] what it is
       shown as (the value; the most common of a folded group's values). */
    function buildFacet(records, key) {
        var n = records.length;
        var values = [];
        var ids = Object.create(null);
        var folded = FOLDED_GROUPS[key] === true;
        var keyOf = folded ? facetKey : sameValue;
        var keys = Object.create(null);         // value as stored -> its key (folded groups)
        var seen = [];                          // per id: {value: count} (folded groups)
        var multi = MULTI_GROUPS[key] === true;
        var single = multi ? null : new Int32Array(n);
        var offsets = multi ? new Int32Array(n + 1) : null;
        var flat = [];
        function idOf(value) {
            var name = value;
            if (folded) {
                name = keys[value];
                if (name === undefined) {
                    name = keys[value] = facetKey(value);
                }
            }
            var id = ids[name];
            if (id === undefined) {
                id = values.length;
                ids[name] = id;
                values.push(name);
                if (folded) {
                    seen.push(Object.create(null));
                }
            }
            if (folded) {
                seen[id][value] = (seen[id][value] || 0) + 1;
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
        var labels = values;
        if (folded) {
            // The most common way of writing it; of equally common ones the
            // singular, else the first seen.
            labels = seen.map(function (counts, id) {
                var best = null;
                Object.keys(counts).forEach(function (value) {
                    if (best === null || counts[value] > counts[best] ||
                            (counts[value] === counts[best] && value === values[id])) {
                        best = value;
                    }
                });
                return best;
            });
        }
        return {key: key, values: values, labels: labels, keyOf: keyOf, ids: ids,
                single: single, offsets: offsets, flat: multi ? new Int32Array(flat) : null};
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

    /* The place group as a tree: the countries with matches, and under a
       place that is chosen or holds a chosen place (open) its regions and
       towns with matches; chosen places and the places they are in are
       always there. In tree order, most matches first at each level, each
       entry with {value, count, selected, level, label, open}. */
    function placeEntries(data, counts, selected) {
        var chosen = Object.create(null);
        var open = Object.create(null);
        selected.forEach(function (value) {
            chosen[value] = true;
            for (var parent = placeParent(value); parent; parent = placeParent(parent)) {
                open[parent] = true;
            }
        });
        var shown = Object.create(null);
        var children = Object.create(null);
        var roots = [];
        function add(value, count) {
            if (shown[value]) {
                return;
            }
            shown[value] = true;
            var parent = placeParent(value);
            var entry = {value: value, count: count, selected: chosen[value] === true,
                         level: placeLevel(value), label: facetLabel("place", value),
                         open: open[value] === true};
            if (parent) {
                (children[parent] || (children[parent] = [])).push(entry);
            } else {
                roots.push(entry);
            }
        }
        var id;
        for (id = 0; id < data.values.length; id++) {
            var value = data.values[id];
            var parent = placeParent(value);
            if (chosen[value] || open[value] ||
                    (counts[id] > 0 && (!parent || chosen[parent] || open[parent]))) {
                add(value, counts[id]);
            }
        }
        Object.keys(chosen).concat(Object.keys(open)).forEach(function (value) {
            add(value, 0);              // (no picture has it)
        });
        var out = [];
        function walk(list) {
            list.sort(function (a, b) {
                return b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
            });
            list.forEach(function (entry) {
                out.push(entry);
                if (children[entry.value]) {
                    walk(children[entry.value]);
                }
            });
        }
        walk(roots);
        // A place whose parent is not listed (a value of an address made
        // by hand) goes at the end.
        Object.keys(children).forEach(function (parent) {
            if (!shown[parent]) {
                walk(children[parent]);
            }
        });
        return out;
    }

    /* [{value, count, selected}] of one group (data: buildFacet): values
       with matches, plus the selected ones (as they were selected); the
       most frequent `limit` when the group has a limit. */
    function facetEntries(key, data, counts, selected) {
        if (key === "place") {
            return placeEntries(data, counts, selected);
        }
        var chosen = [];                        // value id -> the selected value naming it
        var entries = [];
        selected.forEach(function (value) {
            var id = data.ids[data.keyOf(value)];
            if (id === undefined) {
                entries.push({value: value, count: 0, selected: true});
            } else if (chosen[id] === undefined) {
                chosen[id] = value;
            }
        });
        for (var id = 0; id < data.values.length; id++) {
            if (counts[id] > 0 || chosen[id] !== undefined) {
                entries.push({value: chosen[id] !== undefined ? chosen[id] : data.labels[id],
                              count: counts[id], selected: chosen[id] !== undefined});
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

    var DATE_KEY_RE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;

    // options.range as {from, to} (each a date key or ""), or null.
    function dateRange(value) {
        if (!value || typeof value !== "object") {
            return null;
        }
        var from = isText(value.from) && DATE_KEY_RE.test(value.from) ? value.from : "";
        var to = isText(value.to) && DATE_KEY_RE.test(value.to) ? value.to : "";
        if (!from && !to) {
            return null;
        }
        if (from && to && from.slice(0, to.length) > to) {
            var swap = from;
            from = to;
            to = swap;
        }
        return {from: from, to: to};
    }

    // True when a date taken ("YYYY-MM-DD") is within a dateRange().
    function inRange(day, range) {
        if (!isText(day) || !/^\d{4}-\d{2}-\d{2}/.test(day)) {
            return false;
        }
        return (!range.from || day.slice(0, range.from.length) >= range.from) &&
            (!range.to || day.slice(0, range.to.length) <= range.to);
    }

    // The date of this computer, or of the today option ("YYYY-MM-DD").
    function todayKey(value) {
        if (isText(value) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return value;
        }
        var now = new Date();
        return now.getFullYear() + "-" + two(now.getMonth() + 1) + "-" + two(now.getDate());
    }

    function daysInMonth(year, month) {
        return dayNumber(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) -
            dayNumber(year, month, 1);
    }

    /* A date key in words: "2019", "May 2019", "May 14, 2019" ("" when it
       is not a date key). */
    function dateLabel(key) {
        var text = isText(key) && DATE_KEY_RE.test(key) ? key : "";
        if (text.length < 7) {
            return text;
        }
        var month = MONTH_LABELS[+text.slice(5, 7) - 1];
        return text.length === 7 ? month + " " + text.slice(0, 4)
            : month + " " + +text.slice(8, 10) + ", " + text.slice(0, 4);
    }

    /* A range of dates (see dateRange) in words, with en dashes: "2015 -
       2017", "March - May 2019", "May 3 - 9, 2019", "since May 2019". */
    function rangeLabel(from, to) {
        var range = dateRange({from: from, to: to});
        if (!range) {
            return "";
        }
        from = range.from;
        to = range.to;
        if (!to) {
            return "since " + dateLabel(from);
        }
        if (!from) {
            return "until " + dateLabel(to);
        }
        if (from === to) {
            return dateLabel(from);
        }
        var dash = " \u2013 ";
        if (from.length === to.length && from.slice(0, 4) === to.slice(0, 4)) {
            if (from.length === 7) {
                return MONTH_LABELS[+from.slice(5, 7) - 1] + dash + dateLabel(to);
            }
            if (from.length === 10 && from.slice(0, 7) === to.slice(0, 7)) {
                return MONTH_LABELS[+from.slice(5, 7) - 1] + " " + +from.slice(8, 10) + dash +
                    +to.slice(8, 10) + ", " + to.slice(0, 4);
            }
            if (from.length === 10) {
                return dateLabel(from).replace(/, \d{4}$/, "") + dash + dateLabel(to);
            }
        }
        return dateLabel(from) + dash + dateLabel(to);
    }

    /* What choosing bar at of a timeline (its bars) does, or null when
       nothing happens (a bar without pictures). extend: Shift was held;
       anchor: {anchor, pending}, the bar a range starts from ("": none)
       and whether only that end was chosen so far. The answer is the new
       {anchor, pending}, and the dates to show {from, to} unless pending.
       Shift on a bar when the anchor is another bar shown: the bars from
       one to the other. Shift when the anchor is not among the bars: this
       bar becomes the anchor, pending (nothing is chosen yet). Otherwise
       the bar alone, which becomes the anchor. */
    function timelineChoice(bars, at, extend, anchor) {
        var bar = Array.isArray(bars) ? bars[at] : null;
        if (!bar) {
            return null;
        }
        var key = anchor && isText(anchor.anchor) ? anchor.anchor : "";
        var from = -1;
        for (var k = 0; k < bars.length && key; k++) {
            if (bars[k].key === key) {
                from = k;
            }
        }
        if (extend && from >= 0 && from !== at) {
            var low = Math.min(from, at);
            var high = Math.max(from, at);
            return {anchor: key, pending: false, from: bars[low].key, to: bars[high].key};
        }
        if (!bar.count) {
            return null;
        }
        if (extend && from < 0) {
            return {anchor: bar.key, pending: true};
        }
        return {anchor: bar.key, pending: false, from: bar.key, to: bar.key};
    }

    // The most bars a timeline of years has (the latest ones).
    var TIMELINE_YEARS = 300;

    /* The date a record was taken as one number, YYYYMMDD (0: none). A
       date that is only the file's time (du, the server's records) is no
       date taken: the timeline, on: and the range leave it out. */
    function takenNumber(rec) {
        var match = isText(rec.dk) && !rec.du ? /^(\d{4})-(\d{2})-(\d{2})/.exec(rec.dk) : null;
        if (!match || +match[2] < 1 || +match[2] > 12 || +match[3] < 1 || +match[3] > 31) {
            return 0;
        }
        return +match[1] * 10000 + +match[2] * 100 + +match[3];
    }

    /* How many of some records were taken when (see search: timeline):
       per year from the first to the last; per month when they are all of
       one year; per day when they are all of one month. taken: the
       takenNumber of every record; list: the records counted. */
    function timelineOf(taken, list) {
        var dated = 0;
        var first = 0;
        var last = 0;
        var k;
        var value;
        for (k = 0; k < list.length; k++) {
            value = taken[list[k]];
            if (value) {
                dated += 1;
                if (!first || value < first) {
                    first = value;
                }
                if (value > last) {
                    last = value;
                }
            }
        }
        var out = {level: null, bars: [], dated: dated, undated: list.length - dated};
        if (!dated) {
            return out;
        }
        var firstYear = Math.floor(first / 10000);
        var lastYear = Math.floor(last / 10000);
        var firstMonth = Math.floor(first / 100);
        var start;
        var size;
        var divide;
        var modulo;
        if (firstYear !== lastYear) {
            out.level = "year";
            start = Math.max(firstYear, lastYear - TIMELINE_YEARS + 1);
            size = lastYear - start + 1;
            divide = 10000;
            modulo = 0;
        } else if (firstMonth !== Math.floor(last / 100)) {
            out.level = "month";
            start = 1;
            size = 12;
            divide = 100;
            modulo = 100;
        } else {
            out.level = "day";
            start = 1;
            size = daysInMonth(firstYear, firstMonth % 100);
            divide = 1;
            modulo = 100;
        }
        var counts = new Int32Array(size);
        for (k = 0; k < list.length; k++) {
            value = taken[list[k]];
            if (value) {
                var at = Math.floor(value / divide);
                at = (modulo ? at % modulo : at) - start;
                if (at >= 0 && at < size) {
                    counts[at] += 1;
                }
            }
        }
        var prefix = out.level === "year" ? ""
            : out.level === "month" ? firstYear + "-"
                : firstYear + "-" + two(firstMonth % 100) + "-";
        for (k = 0; k < size; k++) {
            out.bars.push({key: out.level === "year" ? String(start + k) : prefix + two(k + 1),
                           count: counts[k]});
        }
        return out;
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

    function shuffleSeed(seed) {
        return typeof seed === "number" && isFinite(seed) ? seed >>> 0 : 1;
    }

    // Where a picture goes in the shuffled order of a seed: a hash of its
    // id (FNV-1a, then mixed), the same every time for the same seed.
    function shuffleKey(seed, id) {
        var text = String(id);
        var hash = (2166136261 ^ seed) >>> 0;
        for (var k = 0; k < text.length; k++) {
            hash = Math.imul(hash ^ text.charCodeAt(k), 16777619) >>> 0;
        }
        hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
        hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
        return (hash ^ (hash >>> 16)) >>> 0;
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

    /* ---------- Areas on the map ------------------------------------------- */

    /* An area drawn or picked on the map (map.js) limits a search to the
       pictures taken in it: the area option (the address's area=, a smart
       album's options.area). Its text (readArea, encodeArea):

           kind [metres] "." part ["." part ...]

       kind "b": a rectangle, one part of two points (its south-west and
       north-east corners); "p": polygons, each part a ring of three points
       or more (a place is in the area when it is inside any of them); "l":
       lines with metres (1 to AREA_MAX_METRES) either side, each part a
       line of one point or more (a street; a point of interest is a line of
       one point): a place is in the area when it is at most that far from
       one of them. A part is the latitude and longitude of its points in
       1/100000 degree, the first as it is and each next one as the change
       from the one before (so a longitude may run past 180: a shape across
       the date line), each number zig-zag coded (0, -1, 1, -2, ... are 0,
       1, 2, 3, ...) and written five bits a character, lowest first, in
       AREA_DIGITS, the character's 32 bit saying that more of the number
       follows. Only letters, digits, "-", "_" and ".": nothing of it is
       escaped in an address. At most AREA_MAX_TEXT characters,
       AREA_MAX_PARTS parts and AREA_MAX_POINTS points (map_areas.py reads
       the same text).

       The edges of a shape are straight on the map (Web Mercator, as they
       were drawn), and distances are measured on the map at the place's
       latitude (where it is true to scale). A place counts when it is that
       deep inside: 0 m for the pictures' own positions and the places the
       owner set, half the radius of an estimated place (as named_places.py
       asks of an area), so that a vague estimate is not "on" a street.
       Where the pictures were taken comes from index.setPlaces. */
    var AREA_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
    var AREA_SCALE = 100000;
    var AREA_MAX_TEXT = 6000;
    var AREA_MAX_PARTS = 200;
    var AREA_MAX_POINTS = 2000;
    var AREA_MAX_METRES = 5000;
    var AREA_NAME_LENGTH = 100;
    var AREA_RE = /^([bpl])([1-9]\d{0,3})?((?:\.[0-9A-Za-z_-]+)+)$/;
    // The map's north and south edges (Web Mercator leaves the poles out), and
    // the length of the equator: the map's world is that many metres wide there.
    var AREA_MAX_LAT = 85.0511287798;
    var EARTH_METRES = 40075016.686;
    // Areas read lately (readArea), by their text.
    var AREA_KEPT = 16;
    var areasRead = Object.create(null);
    var areasOrder = [];

    var AREA_VALUES = (function () {
        var out = Object.create(null);
        for (var k = 0; k < AREA_DIGITS.length; k++) {
            out[AREA_DIGITS.charAt(k)] = k;
        }
        return out;
    })();

    function areaNumber(value) {
        var left = value < 0 ? -2 * value - 1 : 2 * value;
        var out = "";
        while (left >= 32) {
            out += AREA_DIGITS.charAt(32 + left % 32);
            left = Math.floor(left / 32);
        }
        return out + AREA_DIGITS.charAt(left);
    }

    // The numbers of a part's text, or null when it is none.
    function areaNumbers(text) {
        var out = [];
        var value = 0;
        var scale = 1;
        for (var k = 0; k < text.length; k++) {
            var digit = AREA_VALUES[text.charAt(k)];
            if (digit === undefined || scale > 1e12) {
                return null;
            }
            value += (digit % 32) * scale;
            if (digit < 32) {
                out.push(value % 2 ? -(value + 1) / 2 : value / 2);
                value = 0;
                scale = 1;
            } else {
                scale *= 32;
            }
        }
        return scale === 1 ? out : null;
    }

    // 0 at the map's north edge to 1 at its south edge (Web Mercator).
    function worldY(lat) {
        var clamped = Math.max(-AREA_MAX_LAT, Math.min(AREA_MAX_LAT, lat));
        var r = clamped * Math.PI / 180;
        return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
    }

    function latitudeOf(y) {
        var v = Math.PI * (1 - 2 * y);
        return Math.atan((Math.exp(v) - Math.exp(-v)) / 2) * 180 / Math.PI;
    }

    // Metres per world unit (the world's width) at a latitude.
    function worldScale(lat) {
        return EARTH_METRES * Math.cos(Math.max(-AREA_MAX_LAT, Math.min(AREA_MAX_LAT, lat)) *
                                       Math.PI / 180);
    }

    /* The text of an area (see above): kind "b", "p" or "l"; parts: a list
       of [lat, lon, lat, lon, ...] (degrees; a rectangle's one part [south,
       west, north, east], east > west, east past 180 across the date line);
       metres for "l". "" when that makes no area (readArea reads it). */
    function encodeArea(kind, parts, metres) {
        if (["b", "p", "l"].indexOf(kind) < 0 || !Array.isArray(parts) || !parts.length) {
            return "";
        }
        var text = kind + (kind === "l" ? String(Math.round(Number(metres) || 0)) : "");
        for (var p = 0; p < parts.length; p++) {
            var part = parts[p];
            if (!part || !(part.length >= 2) || part.length % 2) {
                return "";
            }
            var shift = 0;
            var lastLat = 0;
            var lastLon = 0;
            var piece = "";
            for (var k = 0; k < part.length; k += 2) {
                var lat = Math.round(Number(part[k]) * AREA_SCALE);
                var lon = Math.round(Number(part[k + 1]) * AREA_SCALE);
                if (!isFinite(lat) || !isFinite(lon)) {
                    return "";
                }
                if (k === 0) {
                    // (The first longitude within [-180, 180]; the others follow it.)
                    shift = Math.round(lon / (360 * AREA_SCALE)) * 360 * AREA_SCALE;
                }
                lon -= shift;
                piece += areaNumber(lat - lastLat) + areaNumber(lon - lastLon);
                lastLat = lat;
                lastLon = lon;
            }
            text += "." + piece;
        }
        return readArea(text) ? text : "";
    }

    /* The area of a text (see above): {text, kind, metres, parts (as
       encodeArea's, a rectangle as its four corners), shapes (the parts in
       world units -- x 0 at the date line to 1 once round the world east, y
       as worldY -- [x, y, x, y, ...] each), box {x0, y0, x1, y1} (of the
       shapes), cx (its middle x)}, or null when the text is none. An area
       read already is given back as it is. */
    function readArea(text) {
        if (text && typeof text === "object" && isText(text.text) && text.shapes) {
            return text;
        }
        if (!isText(text) || !text || text.length > AREA_MAX_TEXT) {
            return null;
        }
        if (areasRead[text] !== undefined) {
            return areasRead[text];
        }
        var area = parseArea(text);
        areasRead[text] = area;
        areasOrder.push(text);
        if (areasOrder.length > AREA_KEPT) {
            delete areasRead[areasOrder.shift()];
        }
        return area;
    }

    function parseArea(text) {
        var match = AREA_RE.exec(text);
        if (!match) {
            return null;
        }
        var kind = match[1];
        var metres = match[2] ? Number(match[2]) : 0;
        if ((kind === "l") !== Boolean(match[2]) || metres > AREA_MAX_METRES) {
            return null;
        }
        var texts = match[3].slice(1).split(".");
        if (texts.length > AREA_MAX_PARTS || (kind === "b" && texts.length !== 1)) {
            return null;
        }
        var parts = [];
        var count = 0;
        var half = 180 * AREA_SCALE;
        for (var p = 0; p < texts.length; p++) {
            var numbers = areaNumbers(texts[p]);
            if (!numbers || !numbers.length || numbers.length % 2) {
                return null;
            }
            count += numbers.length / 2;
            if (count > AREA_MAX_POINTS) {
                return null;
            }
            var lat = 0;
            var lon = 0;
            var points = [];
            for (var k = 0; k < numbers.length; k += 2) {
                lat += numbers[k];
                lon += numbers[k + 1];
                if (lat < -half / 2 || lat > half / 2 || lon < -3 * half || lon > 3 * half ||
                        (k === 0 && (lon < -half || lon > half))) {
                    return null;
                }
                points.push(lat / AREA_SCALE, lon / AREA_SCALE);
            }
            if (kind === "p" && points.length < 6) {
                return null;
            }
            if (kind === "b") {
                if (points.length !== 4 || !(points[2] > points[0]) || !(points[3] > points[1]) ||
                        points[3] - points[1] >= 360) {
                    return null;
                }
                // (Its four corners, as a ring.)
                points = [points[0], points[1], points[2], points[1], points[2], points[3],
                          points[0], points[3]];
            }
            parts.push(points);
        }
        var shapes = [];
        var box = {x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity};
        parts.forEach(function (points) {
            var shape = new Float64Array(points.length);
            for (var k = 0; k < points.length; k += 2) {
                var x = (points[k + 1] + 180) / 360;
                var y = worldY(points[k]);
                shape[k] = x;
                shape[k + 1] = y;
                box.x0 = Math.min(box.x0, x);
                box.x1 = Math.max(box.x1, x);
                box.y0 = Math.min(box.y0, y);
                box.y1 = Math.max(box.y1, y);
            }
            shapes.push(shape);
        });
        if (box.x1 - box.x0 >= 1) {
            return null;            // (once round the world or more)
        }
        return {text: text, kind: kind, metres: metres, parts: parts, shapes: shapes, box: box,
                cx: (box.x0 + box.x1) / 2};
    }

    // True when (x, y) is inside a ring of world units (even-odd).
    function inRing(ring, x, y) {
        var inside = false;
        var count = ring.length;
        for (var k = 0, j = count - 2; k < count; j = k, k += 2) {
            var yk = ring[k + 1];
            var yj = ring[j + 1];
            if ((yk > y) !== (yj > y) &&
                    x < (ring[j] - ring[k]) * (y - yk) / (yj - yk) + ring[k]) {
                inside = !inside;
            }
        }
        return inside;
    }

    /* The distance (world units) from (x, y) to the nearest edge of a shape:
       of a ring (closed) or of a line (a line of one point: to that point). */
    function shapeDistance(shape, x, y, closed) {
        var count = shape.length;
        if (count === 2) {
            return Math.sqrt((shape[0] - x) * (shape[0] - x) + (shape[1] - y) * (shape[1] - y));
        }
        var best = Infinity;
        for (var k = closed ? 0 : 2; k < count; k += 2) {
            var j = k === 0 ? count - 2 : k - 2;
            var ax = shape[j];
            var ay = shape[j + 1];
            var dx = shape[k] - ax;
            var dy = shape[k + 1] - ay;
            var length = dx * dx + dy * dy;
            var t = length > 0 ? ((x - ax) * dx + (y - ay) * dy) / length : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            var ex = ax + t * dx - x;
            var ey = ay + t * dy - y;
            var distance = ex * ex + ey * ey;
            if (distance < best) {
                best = distance;
            }
        }
        return Math.sqrt(best);
    }

    /* True when the place at world units (x, y), where a world unit is
       scale metres (worldScale), is in the area at least depth metres deep. */
    function areaHasAt(area, x, y, scale, depth) {
        if (!(scale > 0)) {
            return false;
        }
        x += Math.round(area.cx - x);       // (the copy of the world nearest the area)
        depth = depth > 0 ? depth : 0;
        var reach = area.kind === "l" ? (area.metres - depth) / scale : 0;
        var box = area.box;
        if (reach < 0 || x < box.x0 - reach || x > box.x1 + reach || y < box.y0 - reach ||
                y > box.y1 + reach) {
            return false;
        }
        var shapes = area.shapes;
        for (var s = 0; s < shapes.length; s++) {
            if (area.kind === "l") {
                if (shapeDistance(shapes[s], x, y, false) <= reach) {
                    return true;
                }
            } else if (inRing(shapes[s], x, y) &&
                       (!depth || shapeDistance(shapes[s], x, y, true) * scale >= depth)) {
                return true;
            }
        }
        return false;
    }

    // True when a place (degrees) is in an area (or its text) at least depth metres deep.
    function areaHas(value, lat, lon, depth) {
        var area = readArea(value);
        if (!area || typeof lat !== "number" || typeof lon !== "number" || !isFinite(lat) ||
                !isFinite(lon) || lat < -90 || lat > 90) {
            return false;
        }
        return areaHasAt(area, (lon + 180) / 360, worldY(lat), worldScale(lat), depth);
    }

    function metresLabel(metres) {
        return metres >= 1000 ? String(Number((metres / 1000).toFixed(1))) + " km"
            : Math.round(metres) + " m";
    }

    // The name of an area as given (an address's aname): one line, at most
    // AREA_NAME_LENGTH characters ("" for none).
    function areaName(value) {
        return isText(value) ? value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/^\s+|\s+$/g, "")
            .slice(0, AREA_NAME_LENGTH) : "";
    }

    /* An area in words, after "Area: ": "drawn on the map" ("a rectangle on
       the map"), its name ("City Park"), "Main Street, 50 m either side",
       "within 100 m of City Museum" ("" when the text is no area). */
    function areaLabel(value, name) {
        var area = readArea(value);
        if (!area) {
            return "";
        }
        name = areaName(name);
        if (area.kind === "l") {
            var point = area.parts.length === 1 && area.parts[0].length === 2;
            return point ? "within " + metresLabel(area.metres) + " of " + (name || "a point")
                : (name || "along a line") + ", " + metresLabel(area.metres) + " either side";
        }
        return name || (area.kind === "b" ? "a rectangle on the map" : "drawn on the map");
    }

    /* The area's bounds in degrees, {south, west, north, east} (with a
       line's metres around it; east may be past 180, or west before -180,
       for an area across the date line), or null. */
    function areaBounds(value) {
        var area = readArea(value);
        if (!area) {
            return null;
        }
        var box = area.box;
        var north = latitudeOf(box.y0);
        var south = latitudeOf(box.y1);
        var west = box.x0 * 360 - 180;
        var east = box.x1 * 360 - 180;
        if (area.kind === "l") {
            var latStep = area.metres / (EARTH_METRES / 360);
            var lonStep = latStep / Math.max(0.01, Math.cos(Math.min(AREA_MAX_LAT, Math.max(
                Math.abs(north), Math.abs(south))) * Math.PI / 180));
            north = Math.min(90, north + latStep);
            south = Math.max(-90, south - latStep);
            west -= lonStep;
            east += lonStep;
        }
        return {south: south, west: west, north: north, east: east};
    }

    /* A line or ring ([x, y, x, y, ...]) with fewer points: those within
       tolerance of the line the others make are left out (Douglas and
       Peucker). The first and last points stay. */
    function simplifyLine(points, tolerance) {
        var count = Math.floor((points || []).length / 2);
        if (count <= 2 || !(tolerance > 0)) {
            return Array.prototype.slice.call(points || [], 0, count * 2);
        }
        var keep = new Uint8Array(count);
        keep[0] = 1;
        keep[count - 1] = 1;
        var stack = [[0, count - 1]];
        var limit = tolerance * tolerance;
        while (stack.length) {
            var span = stack.pop();
            var a = span[0];
            var b = span[1];
            var ax = points[2 * a];
            var ay = points[2 * a + 1];
            var dx = points[2 * b] - ax;
            var dy = points[2 * b + 1] - ay;
            var length = dx * dx + dy * dy;
            var far = -1;
            var farthest = limit;
            for (var k = a + 1; k < b; k++) {
                var px = points[2 * k] - ax;
                var py = points[2 * k + 1] - ay;
                var t = length > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
                var ex = px - t * dx;
                var ey = py - t * dy;
                var distance = ex * ex + ey * ey;
                if (distance > farthest) {
                    farthest = distance;
                    far = k;
                }
            }
            if (far >= 0) {
                keep[far] = 1;
                stack.push([a, far], [far, b]);
            }
        }
        var out = [];
        for (var n = 0; n < count; n++) {
            if (keep[n]) {
                out.push(points[2 * n], points[2 * n + 1]);
            }
        }
        return out;
    }

    /* The positions ([lat, lon, lat, lon, ...]) of a clip's GPS track as the
       routes have it (tracks.encode: [[tenths of seconds, lat, lon (1/100000
       degree), speed]], each row but the first the change from the one
       before; see routes.js), [] when the text is none. */
    function trackPositions(text) {
        var rows;
        try {
            rows = JSON.parse(text || "[]");
        } catch (error) {
            return [];
        }
        var out = [];
        var lat = 0;
        var lon = 0;
        for (var k = 0; Array.isArray(rows) && k < rows.length; k++) {
            var row = rows[k];
            if (!Array.isArray(row) || row.length !== 4 || typeof row[1] !== "number" ||
                    typeof row[2] !== "number") {
                return [];
            }
            lat += row[1];
            lon += row[2];
            out.push(lat / 1e5, lon / 1e5);
        }
        return out;
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
        this.taken = new Int32Array(n);     // the date taken as YYYYMMDD, see takenNumber
        this.flags = new Uint8Array(n);
        this.scratchExact = new Int32Array(n);
        this.scratchPartial = new Int32Array(n);
        this.orders = Object.create(null);
        this.similarData = null;
        this.vectors = null;                // meaning vectors (setVectors)
        this.looks = null;                  // a view of the index with look vectors (setLooks)
        this.vecRows = null;
        this.vecCount = 0;
        this.cosCache = [];
        this.tagWords = null;
        this.marks = null;
        this.located = null;                // where the pictures were taken (setPlaces)
        this.things = Object.create(null);  // word -> the THING_FIELDS it is a thing of
        this.wordStart = new Int32Array(n + 1);
        // Only while building: per record its (form id, fields) pairs; per
        // word how often it ended an item of each of THING_FIELDS.
        this.build = {pairs: new IntBuffer(n * 64), pairStart: new Int32Array(n + 1),
                      words: new IntBuffer(n * 64), lastRecord: [], lastPair: [],
                      heads: Object.create(null)};
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
            this.taken[r] = takenNumber(rec);
            this.flags[r] = (isText(rec.o) ? 1 : 0) | (rec.gp ? 2 : 0) | (rec.p === "360" ? 4 : 0);
        }
        this.build.pairStart[n] = this.build.pairs.length >> 1;
        this.wordStart[n] = this.build.words.length;
        this.words = this.build.words.done();
        this.invert();
        this.findThings();
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
        this.findDrives();
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

    /* Counts the last word of an item (its words) of a THING_FIELDS field
       of record r: per field [items, items not after a sweet], and the
       records (records, the last record counted). */
    Index.prototype.noteThing = function (field, parts, r) {
        var head = foldWord(parts[parts.length - 1]);
        var counts = this.build.heads[head] ||
            (this.build.heads[head] = {fields: {}, records: 0, last: -1});
        var count = counts.fields[field] || (counts.fields[field] = [0, 0]);
        count[0] += 1;
        if (parts.length < 2 || !EDIBLE_WORDS[parts[parts.length - 2]]) {
            count[1] += 1;
        }
        if (counts.last !== r) {
            counts.last = r;
            counts.records += 1;
        }
    };

    /* things: the fields each counted word is a thing of (see Ranking).
       Run after invert(), as it counts the records with the word. */
    Index.prototype.findThings = function () {
        var heads = this.build.heads;
        Object.keys(heads).forEach(function (head) {
            var counts = heads[head];
            var id = this.vocab[head];
            var seen = 0;
            if (id !== undefined) {
                for (var p = this.postStart[id]; p < this.postStart[id + 1]; p++) {
                    if (this.postMasks[p] & CONTENT_FIELDS) {
                        seen += 1;
                    }
                }
            }
            if (counts.records < THING_SHARE * seen) {
                return;
            }
            var fields = Object.keys(counts.fields);
            var most = 0;
            fields.forEach(function (field) {
                most = Math.max(most, counts.fields[field][0]);
            });
            var mask = 0;
            fields.forEach(function (field) {
                var count = counts.fields[field];
                if (count[0] * 3 >= most && count[1] > 0) {
                    mask |= 1 << Number(field);
                }
            });
            this.things[head] = mask;
        }, this);
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
                if (parts.length && (THING_FIELDS & bit)) {
                    this.noteThing(field, parts, r);
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

    /* ---------- Drives ---------------------------------------------------- */

    /* A drive (record key dv: a run of video clips recorded one after the
       other, see drives.py) is a unit of its own here. Its own title,
       description and tags (dvt, dvd, dvg, on one of its clips, with its
       flags dvp and dvs) are the drive's words, searched apart from any
       clip's (F_DRIVE): they never make the clip that carries them a match
       by its own words. When they match a part of the query, the drive's
       cover passes that part: the middle one of its clips that the search
       may show at all (after the visibility options, ids and dates, and
       within the one album the query names: the drive of an album is made
       of the album's clips, as in an export of the album), which
       also stands for the drive when no clip of it matches by itself; so
       does a clip of it that matches another part by its own words
       (driveClauses). A clip "matches by itself" when its own words (or
       its own meaning) do;
       the carrier's meaning vector holds the drive's description too, so a
       match of the carrier found by meaning alone counts as the drive's.
       The drive's own words are only searched and shown when its flags
       pass the options (sensitive, private), as a picture's would.
       Numbers the drives: driveOf[record] (-1: none), driveKeys[drive] (its
       dv), driveRecords[drive] (its record indexes in order, dx) and
       driveText[drive] (the record index of the clip that carries its own
       words, -1: none). */
    Index.prototype.findDrives = function () {
        var keys = Object.create(null);
        var records = this.records;
        this.driveOf = new Int32Array(this.n);
        this.driveKeys = [];
        this.driveRecords = [];
        this.driveNumber = keys;
        var text = [];
        for (var r = 0; r < this.n; r++) {
            var rec = records[r];
            this.driveOf[r] = -1;
            if (!rec || typeof rec !== "object" || rec.dv === undefined || rec.dv === null) {
                continue;
            }
            var key = String(rec.dv);
            var drive = keys[key];
            if (drive === undefined) {
                drive = this.driveKeys.length;
                keys[key] = drive;
                this.driveKeys.push(rec.dv);
                this.driveRecords.push([]);
                text.push(-1);
            }
            this.driveOf[r] = drive;
            this.driveRecords[drive].push(r);
            if (text[drive] < 0 && (isText(rec.dvt) || isText(rec.dvd) ||
                                    textList(rec.dvg).length)) {
                text[drive] = r;
            }
        }
        this.driveText = new Int32Array(text);
        this.driveRecords.forEach(function (list) {
            list.sort(function (a, b) {
                return ((records[a].dx || 0) - (records[b].dx || 0)) || a - b;
            });
        });
    };

    // May a drive's own words (flags dvs, dvp of rec, the clip that carries
    // them) be searched and shown with these options? As visibility() says.
    function driveTextShown(rec, options) {
        var sensitive = options.sensitive;
        var level = sensitive === true || sensitive === "show" ? 0 : sensitive === "strict" ? 2 : 1;
        if (level && isText(rec.dvs) && (rec.dvs === "explicit" || rec.dvs === "graphic" ||
                                         (level === 2 && rec.dvs === "suggestive"))) {
            return false;
        }
        return !(options["private"] === false && rec.dvp);
    }

    /* The ids of a drive's clips (key: their dv), in order ([] for none);
       with options, only those visibility(options) shows. */
    Index.prototype.driveClips = function (key, options) {
        var drive = this.driveNumber[String(key)];
        if (drive === undefined) {
            return [];
        }
        var records = this.records;
        var shown = options && typeof options === "object" ? this.visibility(options) : null;
        return this.driveRecords[drive].filter(function (r) {
            return !shown || shown[r] === 1;
        }).map(function (r) {
            return records[r].i;
        });
    };

    /* What a search needs of the drives, or null when there are none:
       members[drive] (its record indexes that alive allows, in order; with
       within, an album's rank per record, only those in the album),
       cover[drive] (the middle one; -1: none), text[drive] (1 when its own
       words may be searched and shown), and per record own (1: it matched a
       part of the query by its own words) and via (1: it passed a part by
       its drive's words), see driveClauses. */
    Index.prototype.drivePlan = function (alive, options, within) {
        var count = this.driveKeys.length;
        if (!count) {
            return null;
        }
        var members = [];
        var cover = new Int32Array(count);
        var text = new Uint8Array(count);
        function shown(r) {
            return alive[r] === 1 && (!within || within[r] >= 0);
        }
        for (var d = 0; d < count; d++) {
            var list = this.driveRecords[d].filter(shown);
            members.push(list);
            cover[d] = list.length ? list[(list.length - 1) >> 1] : -1;
            var carrier = this.driveText[d];
            text[d] = carrier >= 0 && driveTextShown(this.records[carrier], options) ? 1 : 0;
        }
        return {members: members, cover: cover, text: text, own: new Uint8Array(this.n),
                via: new Uint8Array(this.n)};
    };

    /* The scores of the query's clauses with the drives' own words: null
       when no clause searches them, else per clause its scores (null for a
       clause to work out as usual). A drive whose words match a clause
       passes it at its cover, and at each clip of it that matches another
       part of the query by its own words ("leaving lighthouse": the clip of
       leaving, on a drive past a lighthouse), when the clip does not pass
       it by its own words. plan.own marks the clips that matched a part by
       their own words, plan.via those that passed a part by their drive's. */
    Index.prototype.driveClauses = function (parsed, context, plan) {
        if (!plan) {
            return null;
        }
        var self = this;
        var own = [];
        var best = [];
        var any = false;
        parsed.clauses.forEach(function (clause) {
            var terms = clause.terms.filter(function (term) {
                return term.driveMask && !term.neg && term.kind !== "filter";
            });
            any = any || terms.length > 0;
            own.push(terms.length ? self.clauseScores(clause, context) : null);
            best.push(terms.length ? self.driveWords(terms, context, plan) : null);
        });
        if (!any) {
            return null;
        }
        var c;
        var d;
        var k;
        var r;
        for (c = 0; c < own.length; c++) {
            for (d = 0; own[c] && d < plan.members.length; d++) {
                for (k = 0; k < plan.members[d].length; k++) {
                    r = plan.members[d][k];
                    if (own[c][r] >= 0) {
                        plan.own[r] = 1;
                    }
                }
            }
        }
        for (c = 0; c < own.length; c++) {
            for (d = 0; own[c] && d < plan.members.length; d++) {
                if (best[c][d] < 0) {
                    continue;
                }
                for (k = 0; k < plan.members[d].length; k++) {
                    r = plan.members[d][k];
                    if (own[c][r] < 0 && (r === plan.cover[d] || plan.own[r] === 1)) {
                        own[c][r] = best[c][d];
                        plan.via[r] = 1;
                    }
                }
            }
        }
        return own;
    };

    // Per drive, the best score of its own words for the terms (alternatives;
    // -1: they do not match, or its words may not be searched).
    Index.prototype.driveWords = function (terms, context, plan) {
        var count = this.driveKeys.length;
        var best = filled(count, -1);
        for (var t = 0; t < terms.length; t++) {
            var term = {};
            for (var name in terms[t]) {
                if (Object.prototype.hasOwnProperty.call(terms[t], name)) {
                    term[name] = terms[t][name];
                }
            }
            term.mask = term.driveMask;
            var found = this.termScores(term, context);
            for (var d = 0; d < count; d++) {
                var carrier = this.driveText[d];
                if (carrier >= 0 && plan.text[d] && found[carrier] > best[d]) {
                    best[d] = found[carrier];
                }
            }
        }
        return best;
    };

    // Did the record match the query by its own words (not by its drive's only)?
    function ownMatch(plan, r) {
        return plan.via[r] !== 1 || plan.own[r] === 1;
    }

    /* After the query's words: a cover that matches only with its drive's
       words is left out when another clip of the drive matches by its own
       words (that clip stands for the drive; the cover would only be noise
       in a list of clips). */
    Index.prototype.driveCovers = function (plan, alive, missed) {
        for (var d = 0; d < plan.cover.length; d++) {
            var cover = plan.cover[d];
            if (cover < 0 || !alive[cover] || ownMatch(plan, cover)) {
                continue;
            }
            var members = plan.members[d];
            for (var k = 0; k < members.length; k++) {
                var r = members[k];
                if (r !== cover && alive[r] && ownMatch(plan, r) && !(missed && missed[r])) {
                    alive[cover] = 0;
                    break;
                }
            }
        }
    };

    /* The drives among the matches (ordered, in their order): {drives: {key
       (dv): {clips (the ids of its clips the search may show, in order),
       matched (the ids of those that match by themselves, best first),
       shown (the id of the clip that stands for it: when ranked, its
       best-ranked clip that matches by itself, else its cover; unranked,
       the middle one of its matches), text (the id of the clip that carries
       its own words when they may be shown, else null)}}, shown: per drive
       the record index of shown (-1: none of its clips matches, or it has
       fewer than two to show)}. Only drives with a match are listed.
       meaning: true when every match was found by meaning; missed (or
       null): per record, 1 when it was found by meaning without the free
       words (see search). */
    Index.prototype.driveResults = function (ordered, plan, ranked, meaning, missed) {
        var count = this.driveKeys.length;
        var records = this.records;
        var driveOf = this.driveOf;
        var shown = new Int32Array(count);
        var first = new Int32Array(count);
        var matched = [];
        var included = new Uint8Array(this.n);
        var d;
        shown.fill(-1);
        first.fill(-1);
        for (d = 0; d < count; d++) {
            matched.push([]);
        }
        for (var k = 0; k < ordered.length; k++) {
            var r = ordered[k];
            d = driveOf[r];
            if (d < 0 || plan.members[d].length < 2) {
                continue;
            }
            included[r] = 1;
            shown[d] = r;
            // (The carrier's vector holds the drive's description too.)
            var byDrive = !ownMatch(plan, r) ||
                (r === this.driveText[d] && (meaning || Boolean(missed && missed[r] === 1)));
            if (!ranked || !byDrive) {
                matched[d].push(records[r].i);
                if (first[d] < 0) {
                    first[d] = r;
                }
            }
        }
        var out = {};
        function hit(r) {
            return included[r] === 1;
        }
        function id(r) {
            return records[r].i;
        }
        for (d = 0; d < count; d++) {
            if (shown[d] < 0) {
                continue;
            }
            var members = plan.members[d];
            if (!ranked) {
                var hits = members.filter(hit);
                shown[d] = hits[(hits.length - 1) >> 1];
            } else {
                shown[d] = first[d] >= 0 ? first[d] : plan.cover[d];
            }
            out[String(this.driveKeys[d])] = {
                clips: members.map(id), matched: matched[d], shown: records[shown[d]].i,
                text: plan.text[d] === 1 ? records[this.driveText[d]].i : null};
        }
        return {drives: out, shown: shown};
    };

    /* items with each drive that matches by its own words only (none of
       its clips by itself: drives[key].matched is empty) standing for all
       of its clips, in the drive's order, where the first of them is (see
       options.wholeDrives). */
    Index.prototype.wholeDrives = function (items, drives) {
        var self = this;
        var out = [];
        var done = Object.create(null);
        items.forEach(function (id) {
            var rec = self.get(id);
            var key = rec && rec.dv !== undefined && rec.dv !== null ? String(rec.dv) : null;
            var drive = key !== null ? drives[key] : null;
            if (!drive || drive.matched.length) {
                out.push(id);
                return;
            }
            if (!done[key]) {
                done[key] = true;
                drive.clips.forEach(function (clip) {
                    out.push(clip);
                });
            }
        });
        return out;
    };

    Index.prototype.get = function (id) {
        var r = this.position[String(id)];
        return r === undefined ? null : this.records[r];
    };

    // All record indexes in one of the SORTS orders (worked out once; for
    // "shuffle", once per seed).
    Index.prototype.order = function (mode, seed) {
        var key = mode === "shuffle" ? "shuffle:" + shuffleSeed(seed) : mode;
        if (this.orders[key]) {
            return this.orders[key];
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
        } else if (mode === "shuffle") {
            var mix = shuffleSeed(seed);
            var keys = all.map(function (r) {
                return shuffleKey(mix, id(r));
            });
            compare = function (a, b) {
                return keys[a] - keys[b] || compareIds(id(a), id(b));
            };
            // (Only the order of one seed is kept.)
            Object.keys(this.orders).forEach(function (name) {
                if (name.lastIndexOf("shuffle:", 0) === 0) {
                    delete this.orders[name];
                }
            }, this);
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
        this.orders[key] = all;
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
       with the score of the match and the fields it matched in:
       {records: [index], scores: [score], masks: [fields]}.
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
        var fields = new Array(touched.length);
        for (var k = 0; k < touched.length; k++) {
            r = touched[k];
            scores[k] = maskScore(exact[r], partial[r] & ~exact[r]);
            fields[k] = exact[r] | partial[r];
            exact[r] = 0;
            partial[r] = 0;
        }
        return {records: touched, scores: scores, masks: fields};
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

    /* The fields of THING_FIELDS in which some of words is a thing, and
       KIND_THING for a word of KIND_WORDS (see Ranking); 0: no thing. */
    Index.prototype.thingFields = function (words) {
        var mask = 0;
        for (var w = 0; w < words.length; w++) {
            var forms = wordForms(words[w]);
            for (var k = 0; k < forms.length; k++) {
                mask |= (this.things[forms[k]] || 0) | (KIND_WORDS[forms[k]] ? KIND_THING : 0);
            }
        }
        return mask;
    };

    // The fields of KIND_FIELDS of the kind words among words (0: none).
    function kindFields(words) {
        var mask = 0;
        for (var w = 0; w < words.length; w++) {
            var forms = wordForms(words[w]);
            for (var k = 0; k < forms.length; k++) {
                mask |= KIND_FIELDS[forms[k]] || 0;
            }
        }
        return mask;
    }

    // Per word id of the records: what kind of word it is for the
    // depiction tests (MARK_* bits; worked out once).
    Index.prototype.markKinds = function () {
        if (!this.marks) {
            var marks = new Uint8Array(this.terms.length);
            for (var id = 0; id < this.terms.length; id++) {
                var word = this.terms[id];
                var folded = foldWord(word);
                marks[id] = (DEPICTION_BEFORE[word] || DEPICTION_BEFORE[folded] ? MARK_BEFORE : 0) |
                    (DEPICTION_MATERIALS[word] ? MARK_MATERIAL : 0) |
                    (DEPICTION_AFTER[word] || DEPICTION_AFTER[folded] ? MARK_AFTER : 0) |
                    (DEPICTION_OF[word] || DEPICTION_OF[folded] ? MARK_OF : 0) |
                    (SMALL_WORDS[word] || STOP_WORDS[word] ? MARK_SMALL : 0) |
                    (word === "of" ? MARK_OF_WORD : 0);
            }
            this.marks = marks;
        }
        return this.marks;
    };

    function anyMatch(matchers, id) {
        for (var k = 0; k < matchers.length; k++) {
            if (matchers[k].test(id)) {
                return true;
            }
        }
        return false;
    }

    /* True when the word at p (of words[from..to), one field of a record)
       is shown as a depiction: a depiction word right before it (or two
       before, over one word that is not a small word; a material only when
       the word ends a phrase), right after it, or "<depiction> of" up to
       three words before it. */
    function depicted(words, from, to, p, marks) {
        var before = p - 1;
        var next = p + 1 < to ? words[p + 1] : -1;
        var wanted = MARK_BEFORE;
        if (next < 0 || (marks[next] & (MARK_SMALL | MARK_AFTER))) {
            wanted |= MARK_MATERIAL;
        }
        if (before >= from && words[before] >= 0) {
            if (marks[words[before]] & wanted) {
                return true;
            }
            if (before - 1 >= from && words[before - 1] >= 0 &&
                    !(marks[words[before]] & MARK_SMALL) &&
                    (marks[words[before - 1]] & wanted)) {
                return true;
            }
        }
        if (p + 1 < to && words[p + 1] >= 0 && (marks[words[p + 1]] & MARK_AFTER)) {
            return true;
        }
        for (var k = p - 1; k > from && k >= p - 3 && words[k] >= 0; k--) {
            if (marks[words[k]] & MARK_OF_WORD) {
                return words[k - 1] >= 0 && (marks[words[k - 1]] & MARK_OF) !== 0;
            }
        }
        return false;
    }

    /* True when record r names a thing (one of matchers; null: anything)
       as itself in one of the fields of mask: the last word of an item
       there, with no depiction word in that item. */
    Index.prototype.isReal = function (r, matchers, mask) {
        var words = this.words;
        var marks = this.markKinds();
        var at = this.wordStart[r];
        var end = this.wordStart[r + 1];
        while (at < end) {
            var bit = 1 << words[at];
            var from = at + 2;
            var to = from + words[at + 1];
            at = to;
            if (!(mask & bit)) {
                continue;
            }
            var start = from;
            for (var p = from; p <= to; p++) {
                if (p < to && words[p] >= 0) {
                    continue;
                }
                // An item: words[start..p).
                if (p > start && (!matchers || anyMatch(matchers, words[p - 1]))) {
                    var plain = true;
                    for (var q = start; q < p && plain; q++) {
                        plain = !(marks[words[q]] & (MARK_BEFORE | MARK_MATERIAL | MARK_AFTER));
                    }
                    if (plain) {
                        return true;
                    }
                }
                start = p + 1;
            }
        }
        return false;
    };

    // True when record r shows a thing (one of matchers) as a depiction.
    Index.prototype.depicts = function (r, matchers) {
        var words = this.words;
        var marks = this.markKinds();
        var at = this.wordStart[r];
        var end = this.wordStart[r + 1];
        while (at < end) {
            var bit = 1 << words[at];
            var from = at + 2;
            var to = from + words[at + 1];
            at = to;
            if (!(DEPICTION_FIELDS & bit)) {
                continue;
            }
            for (var p = from; p < to; p++) {
                if (words[p] >= 0 && anyMatch(matchers, words[p]) &&
                        depicted(words, from, to, p, marks)) {
                    return true;
                }
            }
        }
        return false;
    };

    /* Scores of a one-word term per record (-1: no match), with its
       synonyms (SYNONYM_FACTOR) and the Ranking rules. context: oneWord
       (the query looks for this word alone), depictions (the query asks
       for toys, statues, ... itself). */
    Index.prototype.wordScores = function (term, context) {
        var out = filled(this.n, -1);
        var words = termWords(term);
        var fields = this.scratchFields || (this.scratchFields = new Int32Array(this.n));
        var touched = [];
        var k;
        var r;
        for (var w = 0; w < words.length; w++) {
            var hits = this.wordHits(words[w], term.prefix && w === 0,
                                     w === 0 ? term.mask : term.mask & ~(1 << F_TEXT));
            var factor = w === 0 ? 1 : SYNONYM_FACTOR;
            for (k = 0; k < hits.records.length; k++) {
                r = hits.records[k];
                var score = hits.scores[k] * factor;
                if (out[r] < 0) {
                    touched.push(r);
                }
                if (score > out[r]) {
                    out[r] = score;
                }
                fields[r] |= hits.masks[k];
            }
        }
        // (Only the matches of a negated term count, not their ranking.)
        var ranked = expands(term) && !term.neg;
        var things = ranked ? this.thingFields(words) : 0;
        var kinds = things ? kindFields(words) : 0;
        var matchers = [];
        if (things) {
            for (k = 0; k < words.length; k++) {
                matchers.push(new Matcher(this, words[k], false));
            }
        }
        for (k = 0; k < touched.length; k++) {
            r = touched[k];
            var matched = fields[r];
            fields[r] = 0;
            if (things) {
                var rec = this.records[r];
                if (context.depictions) {
                    if (DEPICTION_TYPES[rec.ty] === true || this.depicts(r, matchers)) {
                        out[r] += REAL_BONUS;
                    }
                } else if (DEPICTION_TYPES[rec.ty] === true) {
                    out[r] *= DEPICTION_FACTOR;
                } else if (kinds) {
                    // "animal": any real one first; stuffed animals, animal
                    // tracks and the like after.
                    if (!this.depicts(r, matchers) && this.isReal(r, null, kinds)) {
                        out[r] += REAL_BONUS;
                    } else {
                        out[r] *= DEPICTION_FACTOR;
                    }
                } else if (this.isReal(r, matchers, things)) {
                    out[r] += REAL_BONUS;
                } else {
                    // A thing of another field: "dog" in a hot dog.
                    var other = this.isReal(r, matchers, THING_FIELDS & ~things);
                    if (this.depicts(r, matchers) || (other && context.oneWord)) {
                        out[r] *= DEPICTION_FACTOR;
                    } else if (!other && (matched & (1 << F_TITLE))) {
                        // In the title: the picture is about it.
                        out[r] += REAL_BONUS;
                    }
                }
            }
            if (context.oneWord && !term.neg &&
                    !(matched & ~(term.field === "place" ? 1 << F_TEXT : WEAK_FIELDS))) {
                out[r] *= TEXT_ONLY_FACTOR;
            }
        }
        return out;
    };

    // Scores of a word or phrase term per record (-1: no match).
    Index.prototype.textScores = function (term, context) {
        var words = term.words;
        var count = words.length;
        if (count === 1) {
            return this.wordScores(term, context || {});
        }
        var out = filled(this.n, -1);
        var hits = this.wordHits(words[0], false, term.mask);
        var k;
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

    // A record's rating (0: none) and whether it is a favorite.
    function ratingOf(rec) {
        var value = rec.rt;
        return typeof value === "number" && value >= 1 && value <= 5 ? Math.round(value) : 0;
    }

    function isFavorite(rec) {
        return Boolean(rec.fav);
    }

    // The ids of the albums of a record (al).
    function inAlbum(rec, id) {
        var list = rec.al;
        if (!Array.isArray(list)) {
            return false;
        }
        for (var k = 0; k < list.length; k++) {
            if (list[k] === id || String(list[k]) === String(id)) {
                return true;
            }
        }
        return false;
    }

    // An album name as album: compares it: normalized, without quotes (a
    // quoted value cannot hold them), single spaces.
    var QUOTE_CHARS = new RegExp("[" + QUOTES + "]", "g");
    var QUOTE_TEST = new RegExp("[" + QUOTES + "]");

    function albumKey(text) {
        return normalize(text).replace(QUOTE_CHARS, "").replace(/\s+/g, " ")
            .replace(/^\s+|\s+$/g, "");
    }

    function albumName(album) {
        return albumKey(album.name);
    }

    /* The album that value names among albums: #<id> the one with that id
       (only); else the one with that name (any case, accents too), else
       with that id, else the only one whose name starts so; or null.
       {album, ambiguous} with details: ambiguous is true when more than one
       name starts so. */
    function findAlbum(albums, value, details) {
        var list = (Array.isArray(albums) ? albums : []).filter(function (album) {
            return album && typeof album === "object" && album.id !== undefined &&
                album.id !== null && isText(album.name);
        });
        var answer = function (album, ambiguous) {
            return details ? {album: album, ambiguous: Boolean(ambiguous)} : album;
        };
        var text = String(value === null || value === undefined ? "" : value)
            .replace(/^\s+|\s+$/g, "");
        var k;
        var byId = /^#(\d{1,18})$/.exec(text);
        if (byId) {
            for (k = 0; k < list.length; k++) {
                if (String(list[k].id) === byId[1]) {
                    return answer(list[k]);
                }
            }
            return answer(null);
        }
        var wanted = albumKey(text);
        if (!wanted) {
            return answer(null);
        }
        for (k = 0; k < list.length; k++) {
            if (albumName(list[k]) === wanted) {
                return answer(list[k]);
            }
        }
        for (k = 0; k < list.length; k++) {
            if (String(list[k].id) === text) {
                return answer(list[k]);
            }
        }
        var starts = list.filter(function (album) {
            return startsWith(albumName(album), wanted);
        });
        return answer(starts.length === 1 ? starts[0] : null, starts.length > 1);
    }

    /* The album: term that names album (one of albums) and no other: its
       name (quoted when it has spaces), or album:#<id> when the name cannot
       say it (it has quotes, or names another album first). */
    function albumTerm(albums, album) {
        var name = String(album.name);
        if (QUOTE_TEST.test(name) || findAlbum(albums, name) !== album) {
            return "album:#" + album.id;
        }
        return "album:" + (/\s/.test(name) ? "\"" + name + "\"" : name);
    }

    /* ---------- People (person:) ------------------------------------------ */

    /* The person that value names among people (the "people" of the server's
       /api/people: [{id, name, label, ids, hidden}]): #<id> the one with that
       id; else the one called so (its name, or "Person 12" while it has none:
       any case, accents too), else the only one not hidden whose name starts
       so; or null. {person, ambiguous} with details. */
    function findPerson(people, value, details) {
        var list = (Array.isArray(people) ? people : []).filter(function (person) {
            return person && typeof person === "object" && person.id !== undefined &&
                person.id !== null && isText(person.label);
        });
        var answer = function (person, ambiguous) {
            return details ? {person: person, ambiguous: Boolean(ambiguous)} : person;
        };
        var text = String(value === null || value === undefined ? "" : value)
            .replace(/^\s+|\s+$/g, "");
        var k;
        var byId = /^#(\d{1,18})$/.exec(text);
        if (byId) {
            for (k = 0; k < list.length; k++) {
                if (String(list[k].id) === byId[1]) {
                    return answer(list[k]);
                }
            }
            return answer(null);
        }
        var wanted = albumKey(text);
        if (!wanted) {
            return answer(null);
        }
        for (k = 0; k < list.length; k++) {
            if (albumKey(list[k].label) === wanted) {
                return answer(list[k]);
            }
        }
        var starts = list.filter(function (person) {
            return !person.hidden && isText(person.name) &&
                startsWith(albumKey(person.name), wanted);
        });
        return answer(starts.length === 1 ? starts[0] : null, starts.length > 1);
    }

    // Words person: takes besides names: anybody, or nobody.
    var PERSON_WORDS = {any: "any", anyone: "any", anybody: "any", none: "none",
                        nobody: "none", noone: "none"};

    /* The person: term that names person (one of people) and no other: its
       name (quoted when it has spaces), or person:#<id> when the name cannot
       say it (quotes, another person's name first, or a word of its own). */
    function personTerm(people, person) {
        var name = String(person.label);
        if (QUOTE_TEST.test(name) || findPerson(people, name) !== person ||
                PERSON_WORDS[albumKey(name)]) {
            return "person:#" + person.id;
        }
        return "person:" + (/\s/.test(name) ? "\"" + name + "\"" : name);
    }

    /* The pictures of the person a person: term names: {ids: {picture id:
       true}, none (true for person:none: the pictures with nobody)}, or null
       (with a warning) when it names nobody. Worked out once per search. */
    function personSet(context, value) {
        var sets = context.personSets || (context.personSets = Object.create(null));
        if (sets[value] !== undefined) {
            return sets[value];
        }
        var people = context.people;
        var found = null;
        if (!Array.isArray(people)) {
            if (!context.peoplePending) {
                context.warn("person: finds nobody here: the names of people are not " +
                             "available on this page.");
            }
        } else {
            var word = PERSON_WORDS[albumKey(value)];
            // (Anybody: the people that are not hidden, strangers left out.)
            var chosen = word ? people.filter(function (person) {
                return person && !person.hidden;
            }) : [];
            if (!word) {
                var match = findPerson(people, value, true);
                if (match.person) {
                    chosen = [match.person];
                } else {
                    context.warn(match.ambiguous ? "More than one name starts with \"" + value +
                                 "\": type more of it." : "There is nobody called \"" +
                                 value + "\" (see People).");
                }
            }
            if (word || chosen.length) {
                found = {ids: Object.create(null), none: word === "none"};
                chosen.forEach(function (person) {
                    (Array.isArray(person.ids) ? person.ids : []).forEach(function (id) {
                        found.ids[id] = true;
                    });
                });
            }
        }
        sets[value] = found;
        return found;
    }

    /* ---------- Plain language (interpret) -------------------------------- */

    var MONTH_NUMBERS = dict({january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
                              april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
                              august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10,
                              oct: 10, november: 11, nov: 11, december: 12, dec: 12});
    // The first month of each season (as north of the equator).
    var SEASON_STARTS = dict({spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12});
    // Words that may lead to a date ("in 2019", "during the summer of 2016"),
    var DATE_LEADS = wordSet("in during from");
    // to a place ("in Lisbon", "near Coimbra") or to a person ("with Anna").
    var PLACE_LEADS = wordSet("in at near around from to");
    var PERSON_LEADS = wordSet("with");
    // Words between such a word and a kind of place ("at the zoo", "in a park").
    var KIND_ARTICLES = wordSet("the a an");
    // Words about taking the picture, and words that say nothing of what it
    // shows: no description has them ("taken in Italy", "pictures shot at
    // the zoo", "something in Lisbon"). Left out of a query that names a
    // place, a date or a person, or before one of FILLER_LEADS and more words
    // ("taken in Port Ellis": a place known only by its pictures' words).
    var TAKEN_WORDS = wordSet("taken shot photographed filmed snapped captured something " +
                              "anything");
    var FILLER_LEADS = wordSet("in at near around from during on");
    // Words before a name that make it a mountain, a lake, ... rather than
    // the town of that name ("mount Fuji", "lake Como"): asked about.
    var FEATURE_WORDS = wordSet("mount mt mountain lake river cape fort bay island isle " +
                                "glacier peak valley canyon");
    // Small parts of names ("Ana de la Cruz", "Pieter van Dijk"): never a
    // name on their own.
    var NAME_PARTICLES = wordSet("de del della der den di da do dos das du la le les lo van " +
                                 "von y e bin ibn al el st");
    // The longest name (in words) looked for.
    var NAME_WORDS = 4;
    // A person's or place's name that this many pictures (at least) have in
    // what they show, and this share of the pictures with it (for a place:
    // of the pictures taken there), is also a common word (someone called
    // Rose, a town called Atlantic): it is asked about, not taken. So is a
    // place of several words that are each such a word on their own ("Red
    // Hill", "Green Bay").
    var COMMON_SHOWN = 5;
    var COMMON_SHARE = 0.5;

    function pad(number, size) {
        var text = String(number);
        while (text.length < size) {
            text = "0" + text;
        }
        return text;
    }

    // The date key of a day number (dayNumber's inverse), "YYYY-MM-DD".
    function dayKey(days) {
        var z = days + 719468;
        var era = Math.floor(z / 146097);
        var doe = z - era * 146097;
        var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) -
                              Math.floor(doe / 146096)) / 365);
        var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
        var mp = Math.floor((5 * doy + 2) / 153);
        var day = doy - Math.floor((153 * mp + 2) / 5) + 1;
        var month = mp + (mp < 10 ? 3 : -9);
        var year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        return pad(year, 4) + "-" + two(month) + "-" + two(day);
    }

    function monthKey(year, month) {
        while (month < 1) {
            month += 12;
            year -= 1;
        }
        while (month > 12) {
            month -= 12;
            year += 1;
        }
        return pad(year, 4) + "-" + two(month);
    }

    // The year, month or day after (step 1) or before (step -1) a date key
    // of that size.
    function stepKey(key, step) {
        if (key.length === 4) {
            return String(+key + step);
        }
        if (key.length === 7) {
            return monthKey(+key.slice(0, 4), +key.slice(5, 7) + step);
        }
        return dayKey(parseDay(key) + step);
    }

    // The months of a season: {from, to} ("winter 2016" is December 2015 to
    // February 2016: the winter that ends in that year).
    function seasonRange(start, year) {
        return start === 12 ? {from: monthKey(year - 1, 12), to: monthKey(year, 2)}
            : {from: monthKey(year, start), to: monthKey(year, start + 2)};
    }

    /* The plain items of a typed query as units for interpret: {item, words,
       raw, start, end}, null where something else stands (a field term, a
       quoted phrase, a -word, an OR and the terms it joins). */
    function plainUnits(text) {
        var items = parseText(text);
        function joined(k) {
            var before = items[k - 1];
            var after = items[k + 1];
            return before === "OR" || after === "OR" ||
                (bareWord(before) === "or" && typeof items[k - 2] === "object") ||
                (bareWord(after) === "or" && typeof items[k + 2] === "object");
        }
        return items.map(function (item, k) {
            if (typeof item !== "object" || !plainItem(item) || joined(k)) {
                return null;
            }
            var words = tokens(item.value);
            return words.length ? {item: item, words: words, raw: item.value, start: item.start,
                                   end: item.end} : null;
        });
    }

    // The one word of a unit ("" for none or several).
    function unitWord(unit) {
        return unit && unit.words.length === 1 ? unit.words[0] : "";
    }

    /* The date a typed phrase names at units[at] (after a leading "in",
       "during", ...): {end (the unit after it), from, to (date keys, "" for
       an open end), year (true: a year alone), month (the unit of a month
       or season word that starts it, else -1)} or null. today:
       "YYYY-MM-DD"; years: per year, how many pictures were taken in it (a
       year alone names a date only then); text: the query (for "2015 -
       2019"). */
    function dateAt(units, at, today, years, text) {
        var thisYear = +today.slice(0, 4);
        var thisMonth = +today.slice(5, 7);
        function word(k) {
            return unitWord(units[k]);
        }
        function yearOf(k) {
            var value = word(k);
            var year = /^\d{4}$/.test(value) ? +value : 0;
            return year >= 1826 && year <= thisYear + 1 ? year : 0;
        }
        // MONTH [of] YEAR, SEASON [of] YEAR or YEAR at k: {end, from, to, month}.
        function period(k) {
            var month = MONTH_NUMBERS[word(k)];
            var season = SEASON_STARTS[word(k)];
            if (month || season) {
                var next = word(k + 1) === "of" ? k + 2 : k + 1;
                var year = yearOf(next);
                if (!year) {
                    return null;
                }
                var range = month ? {from: monthKey(year, month), to: monthKey(year, month)}
                    : seasonRange(season, year);
                return {end: next + 1, from: range.from, to: range.to, month: k};
            }
            var alone = yearOf(k);
            return alone ? {end: k + 1, from: String(alone), to: String(alone), month: -1}
                : null;
        }
        // "yesterday", or "last" or "this" year, month, week, month name or
        // season (after an optional "the") at k: {end, from, to}.
        function relative(k) {
            if (word(k) === "yesterday") {
                var day = dayKey(parseDay(today) - 1);
                return {end: k + 1, from: day, to: day, month: -1};
            }
            var start = word(k) === "the" ? k + 1 : k;
            var lead = word(start);
            if (lead !== "last" && lead !== "this") {
                return null;
            }
            var what = word(start + 1);
            var last = lead === "last";
            var range = null;
            if (what === "year") {
                range = {from: String(thisYear - (last ? 1 : 0))};
                range.to = range.from;
            } else if (what === "month") {
                range = {from: monthKey(thisYear, thisMonth - (last ? 1 : 0))};
                range.to = range.from;
            } else if (what === "week") {
                // (Weeks from Monday; this week: up to today.)
                var number = parseDay(today);
                var monday = number - ((number + 3) % 7 + 7) % 7;
                range = last ? {from: dayKey(monday - 7), to: dayKey(monday - 1)}
                    : {from: dayKey(monday), to: today};
            } else if (MONTH_NUMBERS[what]) {
                var month = MONTH_NUMBERS[what];
                // (The last November: the latest one that is over.)
                var year = last && month >= thisMonth ? thisYear - 1 : thisYear;
                range = {from: monthKey(year, month), to: monthKey(year, month)};
            } else if (SEASON_STARTS[what]) {
                var season = SEASON_STARTS[what];
                var ends = season === 12 ? 2 : season + 2;
                // (Last summer: the latest one that is over; this winter: the
                // one that ends this year, or in December the one starting.)
                var which = last ? (thisMonth > ends ? thisYear : thisYear - 1)
                    : (season === 12 && thisMonth === 12 ? thisYear + 1 : thisYear);
                range = seasonRange(season, which);
            }
            return range ? {end: start + 2, from: range.from, to: range.to, month: -1} : null;
        }
        function done(found) {
            found.year = found.from === found.to && found.from.length === 4;
            return found;
        }
        var first = word(at);
        var found;
        if (first === "since" || first === "after" || first === "before") {
            // (Any of the others: "since 2019", "after last summer".)
            found = period(at + 1) || relative(at + 1);
            if (!found) {
                return null;
            }
            if (first === "since") {
                return done({end: found.end, from: found.from, to: "", month: -1});
            }
            if (first === "after") {
                return done({end: found.end, from: stepKey(found.to, 1), to: "", month: -1});
            }
            return done({end: found.end, from: "", to: stepKey(found.from, -1), month: -1});
        }
        if (first === "between" || first === "from") {
            var low = yearOf(at + 1);
            var joint = word(at + 2);
            var high = yearOf(at + 3);
            if (low && high && ((first === "between" && joint === "and") ||
                                (first === "from" && /^(to|until|till|through)$/.test(joint)))) {
                return done({end: at + 4, from: String(Math.min(low, high)),
                             to: String(Math.max(low, high)), month: -1});
            }
        }
        var start = DATE_LEADS[first] === true ? at + 1 : at;
        found = relative(start);
        if (found) {
            return done(found);
        }
        if (word(start) === "the") {
            start += 1;
        }
        // 2015-2019 (one word typed with a dash), 2015 - 2019 and 2015 to 2019.
        var unit = units[start];
        if (unit && unit.words.length === 2 && /^\d{4}\s*[-\u2013]\s*\d{4}$/.test(unit.raw)) {
            var a = +unit.words[0];
            var b = +unit.words[1];
            if (a >= 1826 && b >= 1826 && a <= thisYear + 1 && b <= thisYear + 1) {
                return done({end: start + 1, from: String(Math.min(a, b)),
                             to: String(Math.max(a, b)), month: -1});
            }
        }
        var dash = yearOf(start) && yearOf(start + 1) &&
            /^\s*[-\u2013\u2014]+\s*$/.test(text.slice(units[start].end, units[start + 1].start));
        if (dash || (yearOf(start) && /^(to|until|till|through)$/.test(word(start + 1)) &&
                     yearOf(start + 2))) {
            var other = dash ? start + 1 : start + 2;
            return done({end: other + 1, from: String(Math.min(yearOf(start), yearOf(other))),
                         to: String(Math.max(yearOf(start), yearOf(other))), month: -1});
        }
        found = period(start);
        if (!found) {
            return null;
        }
        // (A year alone, only when pictures were taken in it: "1984" may be a
        // book's title.)
        if (found.from.length === 4 && found.from === found.to && !years[found.from]) {
            return null;
        }
        return done(found);
    }

    /* The search for a date range (date:2019, date:2019-06..2019-08,
       date:2019..). A year typed alone (year true) is "date:2019 OR 2019":
       taken then, or with the year in its words (a scan in the folder "2019
       Taxes", whose date is only the file's time). */
    function dateTerm(from, to, year) {
        var term = "date:" + (from === to ? from : from + ".." + to);
        return year && from === to && /^\d{4}$/.test(from) ? term + " OR " + from : term;
    }

    // A chip's words for a range: "2019", "June - August 2019", "since 2019".
    function dateChip(from, to) {
        return rangeLabel(from, to) || (from ? "since " + dateLabel(from) : "until " +
                                         dateLabel(to));
    }

    /* The people plain language may name, as a lookup of their names:
       {normalized words: [people]} for every run of whole words of each
       name ("anna", "lopez", "anna lopez"; one word alone only the first
       or the last, or another one of more than three letters, never "de"
       or "van": NAME_PARTICLES), named people only (not hidden; no "Person
       12"). people: the people option, or names: a list of names (an
       export that publishes them). */
    function nameLookup(people, names) {
        var out = Object.create(null);
        function add(words, person) {
            for (var from = 0; from < words.length; from++) {
                for (var to = from + 1; to <= words.length && to - from <= NAME_WORDS; to++) {
                    var run = words.slice(from, to);
                    if (run.length === 1 && (run[0].length < 2 || STOP_WORDS[run[0]] ||
                                             /^\d+$/.test(run[0]) || NAME_PARTICLES[run[0]] ||
                                             (from > 0 && from < words.length - 1 &&
                                              run[0].length <= 3))) {
                        continue;
                    }
                    var key = run.join(" ");
                    var list = out[key] || (out[key] = []);
                    if (list.indexOf(person) < 0) {
                        list.push(person);
                    }
                }
            }
        }
        (Array.isArray(people) ? people : []).forEach(function (person) {
            if (person && typeof person === "object" && isText(person.name) && !person.hidden &&
                    person.id !== undefined && person.id !== null) {
                add(tokens(person.name), person);
            }
        });
        (Array.isArray(names) ? names : []).forEach(function (name) {
            if (isText(name)) {
                add(tokens(name), {name: name, label: name, names: true});
            }
        });
        return out;
    }

    /* The places of the records as a lookup: {normalized words of a town,
       region or country name (or another name of a country,
       COUNTRY_WORDS): {label (as most pictures write it), count, small (a
       small word too, such as "us": only typed in capitals)}}. */
    Index.prototype.placeLookup = function () {
        if (this.places) {
            return this.places;
        }
        var counts = Object.create(null);
        // (label: what the chip says: "usa" is the United States.)
        function add(name, label) {
            var key = tokens(name).join(" ");
            if (key.length < 2) {
                return;
            }
            var entry = counts[key] || (counts[key] = {labels: Object.create(null), count: 0});
            entry.count += 1;
            entry.labels[label] = (entry.labels[label] || 0) + 1;
        }
        this.records.forEach(function (rec) {
            if (!rec || typeof rec !== "object") {
                return;
            }
            // (A named place on the street maps too: "at the harbour aquarium".)
            textList(rec.np).forEach(function (name) {
                add(name, name);
            });
            if (!isText(rec.co)) {
                return;
            }
            textList(rec.ci).concat(textList(rec.rg), [rec.co]).forEach(function (name) {
                add(name, name);
            });
            (COUNTRY_WORDS[rec.cc] || []).forEach(function (name) {
                add(name, rec.co);
            });
        });
        var out = Object.create(null);
        Object.keys(counts).forEach(function (key) {
            var labels = counts[key].labels;
            var best = Object.keys(labels).sort(function (a, b) {
                return labels[b] - labels[a] || (a < b ? -1 : 1);
            })[0];
            out[key] = {label: best, count: counts[key].count,
                        small: STOP_WORDS[key] === true || FILLER_WORDS[key] === true};
        });
        this.places = out;
        return out;
    };

    /* How many pictures were taken at a named place of each kind: {total,
       kinds: {nk: count}} (kept per index: a record's nk does not change in
       place). */
    Index.prototype.kindCounts = function () {
        if (!this.kindCache) {
            var kinds = Object.create(null);
            var total = 0;
            this.records.forEach(function (rec) {
                if (rec && typeof rec === "object" && isText(rec.nk)) {
                    kinds[rec.nk] = (kinds[rec.nk] || 0) + 1;
                    total += 1;
                }
            });
            this.kindCache = {total: total, kinds: kinds};
        }
        return this.kindCache;
    };

    /* The kinds of place (lines of PLACE_KIND_LIST) the most pictures were
       taken at, most first, at most count: [{key, label, count}] -- a line
       whose kinds a line before it holds left out ("pubs" after "bars and
       pubs"). */
    Index.prototype.commonKinds = function (count) {
        var counts = this.kindCounts().kinds;
        var lines = PLACE_KINDS.list.map(function (entry, order) {
            var sum = 0;
            entry.kinds.forEach(function (kind) {
                sum += counts[kind] || 0;
            });
            return {entry: entry, count: sum, order: order};
        }).filter(function (line) {
            return line.count > 0;
        }).sort(function (a, b) {
            return b.count - a.count || a.order - b.order;
        });
        var out = [];
        var held = Object.create(null);
        lines.forEach(function (line) {
            if (out.length >= count || line.entry.kinds.every(function (kind) {
                return held[kind] === true;
            })) {
                return;
            }
            line.entry.kinds.forEach(function (kind) {
                held[kind] = true;
            });
            out.push({key: line.entry.key, label: line.entry.label, count: line.count});
        });
        return out;
    };

    /* What to say of a kind: term that finds nothing (filter: placeKindFilter's), or
       "": no picture has a named place at all; or none was taken at a kind
       the search knows; or the value is a kind of picture (type:) or the
       name of a place (place:) rather than a kind of place; or no
       kind is called so -- with the kinds the pictures were taken at most. */
    function placeKindProblem(filter, index) {
        var counts = index.kindCounts();
        if (!counts.total) {
            return "kind: finds nothing here: no picture has a named place of the street maps.";
        }
        if (filter.kinds.some(function (kind) {
            return counts.kinds[kind] > 0;
        })) {
            return "";
        }
        var words = filter.value.replace(/_/g, " ");
        var tries = index.commonKinds(4).map(function (line) {
            return "kind:" + line.key;
        });
        var hint = tries.length ? " (try " + tries.join(", ") + ")" : "";
        if (filter.entry || PLACE_KINDS.kinds[filter.value] === true) {
            return "No picture was taken at " + (filter.entry ? filter.entry.label
                : "a place of the kind \u201c" + words + "\u201d") + hint + ".";
        }
        if (typeFilter(words)) {
            return "kind: is the kind of place a picture was taken at; for a kind of picture " +
                "try type:" + filter.value + ".";
        }
        var place = index.placeLookup()[tokens(words).join(" ")];
        if (place) {
            return "\u201c" + place.label + "\u201d is the name of a place, not a kind of place: " +
                "try place:" + (/\s/.test(words) ? "\"" + words + "\"" : words) + ".";
        }
        return "No picture was taken at a kind of place called \u201c" + words + "\u201d" + hint +
            ".";
    }

    // Per year ("YYYY"), how many pictures were taken in it (dates taken only).
    Index.prototype.yearCounts = function () {
        if (!this.years) {
            var years = Object.create(null);
            for (var r = 0; r < this.n; r++) {
                if (this.taken[r]) {
                    var year = String(Math.floor(this.taken[r] / 10000));
                    years[year] = (years[year] || 0) + 1;
                }
            }
            this.years = years;
        }
        return this.years;
    };

    // The date key of a day taken (index.taken: YYYYMMDD).
    function takenKey(value) {
        return pad(Math.floor(value / 10000), 4) + "-" + two(Math.floor(value / 100) % 100) + "-" +
            two(value % 100);
    }

    /* The first and last dates pictures were taken on: {from, to} (date
       keys), or null when none has a date taken. */
    Index.prototype.takenSpan = function () {
        if (this.span === undefined) {
            var low = 0;
            var high = 0;
            for (var r = 0; r < this.n; r++) {
                var day = this.taken[r];
                if (day && (!low || day < low)) {
                    low = day;
                }
                if (day > high) {
                    high = day;
                }
            }
            this.span = low ? {from: takenKey(low), to: takenKey(high)} : null;
        }
        return this.span;
    };

    // How many pictures have these words together in what they show
    // (fields: SHOWN_FIELDS, or some of them; kept per index: the words of
    // the pictures do not change).
    Index.prototype.shownCount = function (words, fields) {
        var mask = fields === undefined ? SHOWN_FIELDS : fields;
        var cache = this.shownCache || (this.shownCache = Object.create(null));
        var key = mask + ":" + words.join(" ");
        if (cache[key] !== undefined) {
            return cache[key];
        }
        var hits = this.wordHits(words[0], false, mask).records;
        var count = hits.length;
        if (words.length > 1) {
            var matchers = this.matchers(words, false);
            count = 0;
            for (var k = 0; k < hits.length; k++) {
                if (this.phraseFields(hits[k], matchers, mask) !== 0) {
                    count += 1;
                }
            }
        }
        cache[key] = count;
        return count;
    };

    /* True when a person's name is also a common word of what the pictures
       show (COMMON_SHOWN, COMMON_SHARE): a name of that spelling is asked
       about. published: it is a name an export publishes (options.names),
       which is a tag of its pictures there: those tags are not what the
       pictures show (the other fields still are: "rose" in the titles and
       descriptions of roses). */
    Index.prototype.commonWord = function (words, published) {
        if (words.length !== 1) {
            return false;
        }
        var all = this.wordHits(words[0], false, ALL_FIELDS | DRIVE_BIT).records.length;
        var shown = this.shownCount(words, published ? NAME_SHOWN_FIELDS : SHOWN_FIELDS);
        return shown >= COMMON_SHOWN && shown >= COMMON_SHARE * all;
    };

    /* The words of the names an export publishes (options.names) as a
       lookup ({normalized words: true}, as nameLookup finds them), kept
       while the names are the same; null without names. */
    Index.prototype.publishedNames = function (names) {
        if (!Array.isArray(names) || !names.length) {
            return null;
        }
        var key = names.join("\n");
        if (!this.publishedCache || this.publishedCache.key !== key) {
            var found = nameLookup(null, names);
            var lookup = Object.create(null);
            Object.keys(found).forEach(function (words) {
                lookup[words] = true;
            });
            this.publishedCache = {key: key, lookup: lookup};
        }
        return this.publishedCache.lookup;
    };

    /* True when a place's name is also common words of what the pictures
       show (COMMON_SHOWN, COMMON_SHARE): about as many pictures say it as
       were taken there ("atlantic": the ocean), or each of its words is
       such a word ("red hill"). */
    Index.prototype.commonPlace = function (words, place) {
        var shown = this.shownCount(words);
        if (shown >= COMMON_SHOWN && shown >= COMMON_SHARE * place.count) {
            return true;
        }
        var self = this;
        var own = words.filter(function (word) {
            return STOP_WORDS[word] !== true;
        });
        return own.length > 1 && own.every(function (word) {
            return self.shownCount([word]) >= COMMON_SHOWN;
        });
    };

    /* What a query typed in plain language asks for (see interpret at the
       top): options people (the people option of search: person:), names
       (an export's published names), today ("YYYY-MM-DD", default the date
       of this computer), typed (keys to leave as typed words, or "*" for
       all of them), plain (false: nothing is interpreted). */
    Index.prototype.interpret = function (query, options) {
        var opts = options && typeof options === "object" ? options : {};
        var text = query === null || query === undefined ? "" : String(query);
        if (text.length > MAX_QUERY_LENGTH) {
            text = text.slice(0, MAX_QUERY_LENGTH);
        }
        var out = {text: text, query: text, parts: [], choices: [], rest: "", others: "",
                   kept: [], changed: false, dropped: []};
        var typed = opts.typed === "*" ? "*" : Array.isArray(opts.typed) ? opts.typed : [];
        if (opts.plain === false || typed === "*" || !/\S/.test(text)) {
            return out;
        }
        var units;
        try {
            units = plainUnits(text);
        } catch (error) {
            return out;
        }
        var today = todayKey(opts.today);
        var years = this.yearCounts();
        var people = Array.isArray(opts.people) ? opts.people : null;
        var lookupKey = [people, Array.isArray(opts.names) ? opts.names.join("\n") : ""];
        if (!this.nameCache || this.nameCache.people !== lookupKey[0] ||
                this.nameCache.names !== lookupKey[1]) {
            this.nameCache = {people: lookupKey[0], names: lookupKey[1],
                              lookup: nameLookup(people, opts.names)};
        }
        var names = this.nameCache.lookup;
        var places = this.placeLookup();
        var kinds = this.kindCounts();
        var self = this;
        var used = [];              // per unit: consumed
        var spans = [];             // {from, to (units), start, end, replace}

        function wordsOf(from, to) {
            var words = [];
            for (var k = from; k < to; k++) {
                if (!units[k]) {
                    return null;
                }
                words = words.concat(units[k].words);
            }
            return words;
        }
        function rawOf(from, to) {
            return text.slice(units[from].start, units[to - 1].end);
        }
        // The words a typed name is searched as, besides the name: one
        // word as it is, several as a quoted phrase.
        function asWords(words) {
            return words.length === 1 ? words[0] : "\"" + words.join(" ") + "\"";
        }
        function keep(key) {
            if (typed.indexOf(key) >= 0) {
                if (out.kept.indexOf(key) < 0) {
                    out.kept.push(key);
                }
                return true;
            }
            return false;
        }
        // (An export has no person: -- its names are tags -- but a name is
        // still looked for by its words only, never by meaning.)
        function personQuery(person, words) {
            return person.names ? "\"" + words.join(" ") + "\""
                : personTerm(people, person) + " OR " + asWords(words);
        }
        function placeQuery(words) {
            return "place:" + asWords(words) + " OR " + asWords(words);
        }
        function personLabel(person) {
            return "Person: " + (person.label || person.name);
        }
        function wordsOption(raw, count) {
            return {kind: "words", label: "the word" + (count > 1 ? "s" : "") + " \u201c" + raw +
                    "\u201d", query: null};
        }
        // The longest name at k: {end, key, words, people, place}.
        function nameAt(k) {
            for (var length = NAME_WORDS; length >= 1; length--) {
                var words = wordsOf(k, k + length);
                if (!words) {
                    continue;
                }
                var key = words.join(" ");
                var found = names[key] || null;
                var last = units[k + length - 1];
                if (!found && /['\u2019\u02bc]s$/i.test(last.raw) &&
                        /s$/.test(words[words.length - 1])) {
                    // (Anna's: the person Anna.)
                    var bare = words.slice(0, -1).concat([words[words.length - 1].slice(0, -1)]);
                    if (names[bare.join(" ")]) {
                        found = names[bare.join(" ")];
                        words = bare;
                        key = bare.join(" ");
                    }
                }
                var place = places[key] || null;
                // ("us" is a small word; "US" the country.)
                if (place && place.small && !/^[A-Z]{2,}$/.test(rawOf(k, k + length))) {
                    place = null;
                }
                if (found || place) {
                    return {end: k + length, key: key, words: words, people: found || [],
                            place: place};
                }
            }
            return null;
        }
        // A month or season word that is also someone's name ("June", "May").
        function calendarName(word) {
            return MONTH_NUMBERS[word] !== undefined || SEASON_STARTS[word] !== undefined;
        }
        // A plain word that says something of its own next to a kind of
        // place ("car" in "car park", "bench" in "park bench"): not a small
        // word, nor one that leads to a place, a date or a person.
        function ownWord(u) {
            var word = unitWord(units[u]);
            if (!units[u] || (word && (PLACE_LEADS[word] === true || DATE_LEADS[word] === true ||
                                        PERSON_LEADS[word] === true ||
                                        TAKEN_WORDS[word] === true))) {
                return false;
            }
            return skipLevel({kind: "word", words: units[u].words, value: units[u].raw}) === 0;
        }
        // The phrase of a kind of place that the plain units at u make
        // (whole units): {end, phrase (kindPhrase's)} or null.
        function kindWords(u) {
            var ends = [];
            var words = [];
            for (var v = u; v < units.length && units[v] && words.length < KIND_WORDS_MAX; v++) {
                words = words.concat(units[v].words);
                ends.push({end: v + 1, words: words});
            }
            for (var e = ends.length - 1; e >= 0; e--) {
                var phrase = kindPhrase(ends[e].words, true);
                if (phrase) {
                    return {end: ends[e].end, phrase: phrase};
                }
            }
            return null;
        }
        // The kinds the query's own kind: terms name ("kind:viewpoint
        // lookout": "lookout" stays a word there).
        var asked = Object.create(null);
        parse(text).terms.forEach(function (term) {
            if (term.kind === "filter" && term.filter && term.filter.kind === "place_kind") {
                term.filter.kinds.forEach(function (kind) {
                    asked[kind] = true;
                });
            }
        });
        /* The kind of place at k (after an optional "in", "at", ... and
           "the", "a"): {from (its first unit, the "at" or "the" too), at
           (its words' first), end, entry, words, rival (a name of the same
           words to ask about, or null)}, or null -- also when no picture
           was taken at one, or the query names it with kind: already; for
           the first of two kinds of place ("hotel bar", "museum cafe": the
           last says what it is; "parks, zoos" are two); when a longer name
           starts there ("Fort Example", "Museum of Tin Toys"), or a place of the
           same words after "in", "near", ... ("in marina": the town); or
           for a word with another everyday meaning (PLACE_KIND_LIST's "~")
           that another plain word stands right before (without "at", ...
           or "the") or after ("car park", "park bench"; a date, place or
           person after it is fine: "parks 2024"). A person's or place's
           name of the same words is asked about ("park": a kind of place,
           Jo Park or the word?), but after "at the", "the", ... it is the
           kind ("at the park"). */
        function kindAt(k) {
            var led = PLACE_LEADS[unitWord(units[k])] === true && Boolean(units[k + 1]);
            var start = led ? k + 1 : k;
            var articled = KIND_ARTICLES[unitWord(units[start])] === true &&
                Boolean(units[start + 1]);
            var at = articled ? start + 1 : start;
            var found = kindWords(at);
            if (!found) {
                return null;
            }
            var entry = found.phrase.entry;
            if (!entry.kinds.some(function (kind) {
                return kinds.kinds[kind] > 0;
            }) || entry.kinds.some(function (kind) {
                return asked[kind] === true;
            })) {
                return null;
            }
            var after = found.end;
            if (kindWords(after) && !/[,;]$/.test(units[after - 1].raw)) {
                return null;
            }
            if (found.phrase.loose) {
                var shielded = led || articled || at === 0 || !ownWord(at - 1) ||
                    spans.some(function (span) {
                        return span.to === at;
                    });
                if (!shielded || (ownWord(after) && !dateAt(units, after, today, years, text) &&
                                  !nameAt(after) && !kindWords(after))) {
                    return null;
                }
            }
            var rival = nameAt(at);
            if (rival && (rival.end > found.end || (rival.end === found.end && led && !articled &&
                                                    rival.place))) {
                return null;
            }
            return {from: led ? k : articled ? start : at, at: at, end: found.end, entry: entry,
                    words: wordsOf(at, found.end),
                    rival: rival && rival.end === found.end && !articled ? rival : null};
        }
        /* What a kind of place (kindAt) is searched as: kind:key OR each of
           its words, its small words as they are ("kind:cafe OR coffee
           kind:cafe OR shop", "kind:place_of_worship OR house of
           kind:place_of_worship OR worship"): the pictures taken at one, and
           those with the words -- each found by its words or by meaning, as
           without the kind (a phrase in quotes would be neither). */
        function kindQuery(kind) {
            var parts = [];
            for (var u = kind.at; u < kind.end; u++) {
                var unit = units[u];
                var word = unit.words.length === 1 ? unit.words[0] : unit.raw;
                parts.push(skipLevel({kind: "word", words: unit.words, value: unit.raw}) === 0
                    ? "kind:" + kind.entry.key + " OR " + word : word);
            }
            return parts.join(" ");
        }
        for (var k = 0; k < units.length; k++) {
            if (!units[k]) {
                continue;
            }
            var date = dateAt(units, k, today, years, text);
            if (date) {
                var dateKeyText = wordsOf(k, date.end).join(" ");
                var dateQuery = dateTerm(date.from, date.to,
                                         unitWord(units[date.end - 1]) === date.from);
                var dateText = "Taken: " + dateChip(date.from, date.to);
                var month = date.month >= 0 ? unitWord(units[date.month]) : "";
                var named = month ? names[month] || [] : [];
                // (Kept as typed: the whole phrase, not a part of it after all.)
                if (keep(dateKeyText)) {
                    k = date.end - 1;
                    continue;
                }
                if (named.length) {
                    // "june 2019" with someone called June: asked about.
                    var dateRaw = rawOf(k, date.end);
                    var year = unitWord(units[date.end - 1]);
                    var dateOptions = [{kind: "date", label: dateText, query: dateQuery}];
                    named.forEach(function (person) {
                        dateOptions.push({kind: "person", label: personLabel(person) + " (" +
                                          year + ")", query: personQuery(person, [month]) + " " +
                                          dateTerm(year, year, true)});
                    });
                    out.choices.push({text: dateRaw, key: dateKeyText, start: units[k].start,
                                      end: units[date.end - 1].end,
                                      options: dateOptions.concat([wordsOption(dateRaw, 2)])});
                    k = date.end - 1;
                    continue;
                }
                spans.push({from: k, to: date.end, replace: dateQuery,
                            part: {kind: "date", label: dateText, key: dateKeyText,
                                   from: date.from, to: date.to}});
                k = date.end - 1;
                continue;
            }
            // A kind of place: "beaches", "at the zoo".
            var kind = kindAt(k);
            if (kind) {
                var kindKey = kind.words.join(" ");
                var kindLabel = "Kind of place: " + kind.entry.label;
                if (keep(kindKey)) {
                    k = kind.end - 1;
                    continue;
                }
                if (kind.rival) {
                    // "park" with Jo Park in People, "marina" a town too: asked.
                    var kindRaw = rawOf(kind.at, kind.end);
                    var kindOptions = [{kind: "kind", label: kindLabel, query: kindQuery(kind)}];
                    kind.rival.people.forEach(function (person) {
                        kindOptions.push({kind: "person", label: personLabel(person),
                                          query: personQuery(person, kind.rival.words)});
                    });
                    if (kind.rival.place) {
                        kindOptions.push({kind: "place", label: "Place: " + kind.rival.place.label,
                                          query: placeQuery(kind.rival.words)});
                    }
                    out.choices.push({text: kindRaw, key: kindKey, start: units[kind.at].start,
                                      end: units[kind.end - 1].end,
                                      options: kindOptions.concat([
                                          wordsOption(kindRaw, kind.words.length)])});
                } else {
                    // (Its "at the" stays in the query, for meaning to read as typed.)
                    spans.push({from: kind.at, to: kind.end, lead: kind.from,
                                replace: kindQuery(kind),
                                part: {kind: "kind", label: kindLabel, key: kindKey,
                                       value: kind.entry.key}});
                }
                k = kind.end - 1;
                continue;
            }
            var lead = unitWord(units[k]);
            var start = (PLACE_LEADS[lead] || PERSON_LEADS[lead]) && units[k + 1] ? k + 1 : k;
            var name = nameAt(start);
            if (!name && start !== k) {
                name = nameAt(k);
                start = k;
                lead = "";
            }
            if (!name) {
                continue;
            }
            if (start === k) {
                lead = "";
            }
            if (keep(name.key)) {
                k = name.end - 1;
                continue;
            }
            var raw = rawOf(start, name.end);
            var options = [];
            name.people.forEach(function (person) {
                options.push({kind: "person", label: personLabel(person),
                              query: personQuery(person, name.words)});
            });
            if (name.place) {
                options.push({kind: "place", label: "Place: " + name.place.label,
                              query: placeQuery(name.words)});
            }
            // A name that may well be meant as words: "rose", "over the
            // atlantic", "mount fuji", "red hill", "june".
            var before = start > 0 ? unitWord(units[start - 1]) : "";
            // (An export's published names are tags of their pictures: not
            // counted as what the pictures show.)
            var published = name.people.length > 0 && name.people.every(function (person) {
                return person.names === true;
            });
            var common = name.people.length ? self.commonWord(name.words, published) ||
                (name.words.length === 1 && calendarName(name.words[0]))
                : self.commonPlace(name.words, name.place) || before === "the" ||
                    FEATURE_WORDS[before] === true;
            var chosen = null;
            if (options.length === 1 && !common) {
                chosen = options[0];
            } else if (name.place && PLACE_LEADS[lead] && name.people.length < 2) {
                chosen = options[options.length - 1];   // ("in Paris": the place)
            } else if (name.people.length === 1 && PERSON_LEADS[lead]) {
                chosen = options[0];                    // ("with Paris": the person)
            }
            if (chosen) {
                spans.push({from: lead ? start - 1 : start, to: name.end, replace: chosen.query,
                            part: {kind: chosen.kind, label: chosen.label, key: name.key}});
            } else {
                out.choices.push({text: raw, key: name.key, start: units[start].start,
                                  end: units[name.end - 1].end,
                                  options: options.concat([wordsOption(raw, name.words.length)])});
            }
            k = name.end - 1;
        }
        spans.forEach(function (span) {
            var first = span.lead === undefined ? span.from : span.lead;
            for (var u = first; u < span.to; u++) {
                used[u] = true;
            }
            span.start = units[span.from].start;
            span.end = units[span.to - 1].end;
            span.part.text = text.slice(units[first].start, span.end);
            span.part.start = units[first].start;
            span.part.end = span.end;
            span.part.query = span.replace;
            out.parts.push(span.part);
        });
        // Words about taking the picture (TAKEN_WORDS): left out.
        var edits = spans.slice();
        units.forEach(function (unit, u) {
            if (!unit || used[u] || TAKEN_WORDS[unitWord(unit)] !== true) {
                return;
            }
            var next = unitWord(units[u + 1]);
            if (spans.length || (FILLER_LEADS[next] === true && units[u + 2])) {
                used[u] = true;
                out.dropped.push(unit.raw);
                // (With the space after it; at the end, the space before it.)
                var from = unit.start;
                var to = unit.end;
                while (to < text.length && SPACE.test(text.charAt(to))) {
                    to += 1;
                }
                while (to === text.length && from > 0 && SPACE.test(text.charAt(from - 1))) {
                    from -= 1;
                }
                edits.push({start: from, end: to, replace: ""});
            }
        });
        var rewritten = text;
        edits.sort(function (a, b) {
            return b.start - a.start;
        }).forEach(function (span) {
            rewritten = rewritten.slice(0, span.start) + span.replace + rewritten.slice(span.end);
        });
        out.query = rewritten;
        out.changed = spans.length > 0;
        // The words left to search (as typed), when there are any that count.
        var rest = [];
        var counts = false;
        var others = text;
        units.forEach(function (unit, u) {
            if (unit && !used[u]) {
                rest.push(unit.raw);
                var level = skipLevel({kind: "word", words: unit.words, value: unit.raw});
                counts = counts || level === 0;
            }
        });
        out.rest = counts ? rest.join(" ") : "";
        // What is not plain words (field words, phrases, -words, OR), as typed.
        units.slice().reverse().forEach(function (unit) {
            if (unit) {
                others = others.slice(0, unit.start) + " " + others.slice(unit.end);
            }
        });
        out.others = others.split(/\s+/).filter(function (piece) {
            return piece && AND_WORDS[piece] !== true && !/^[-\u2013\u2014]+$/.test(piece);
        }).join(" ");
        return out;
    };

    // Albums inside smart albums inside ... are worked out this deep at most.
    var ALBUM_DEPTH = 4;

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
        case "date":
            // (Like the timeline and on:, only dates taken.)
            var dates = {from: filter.from, to: filter.to};
            return function (rec) {
                return isText(rec.dk) && !rec.du && inRange(rec.dk, dates);
            };
        case "on":
            // (Only dates taken: a file's time (du) says nothing about the
            // day a picture was taken.)
            if (filter.date) {
                return function (rec) {
                    return isText(rec.dk) && !rec.du && rec.dk.slice(0, 10) === filter.date;
                };
            }
            // on:today: this month and day, in an earlier year.
            var monthDay = filter.today ? context.today.slice(4, 10) : filter.key;
            var year = filter.today ? context.today.slice(0, 4) : "";
            return function (rec) {
                return isText(rec.dk) && !rec.du && rec.dk.slice(4, 10) === monthDay &&
                    (!year || rec.dk.slice(0, 4) < year);
            };
        case "rating":
            return function (rec) {
                var stars = ratingOf(rec);
                return stars >= filter.min && stars <= filter.max;
            };
        case "album":
            var found = context.albumSets ? context.albumSets[filter.value] : null;
            if (!found) {
                return null;
            }
            return function (rec) {
                var at = index.position[String(rec.i)];
                return at !== undefined && found.rank[at] >= 0;
            };
        case "place_kind":
            // (Nothing is said of the alternative to words that plain
            // language writes, "kind:zoo OR zoos": the words still count.)
            var problem = filter.alternative ? "" : placeKindProblem(filter, index);
            if (problem) {
                context.warn(problem);
            }
            var wanted = Object.create(null);
            filter.kinds.forEach(function (kind) {
                wanted[kind] = true;
            });
            return function (rec) {
                return isText(rec.nk) && wanted[rec.nk] === true;
            };
        case "person":
            var person = personSet(context, filter.value);
            if (!person) {
                return null;
            }
            return function (rec) {
                return person.none ? !person.ids[rec.i] : person.ids[rec.i] === true;
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
            case "drive":
                return function (rec) {
                    return rec.dv !== undefined && rec.dv !== null;
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
            case "edited":
                return function (rec) {
                    return Boolean(rec.ed);
                };
            case "gps_ignored":
                return function (rec) {
                    return Boolean(rec.gx);
                };
            case "place_estimated":
                return function (rec) {
                    return Boolean(rec.pe);
                };
            case "favorite":
                return isFavorite;
            case "rated":
                return function (rec) {
                    return ratingOf(rec) > 0;
                };
            case "unrated":
                return function (rec) {
                    return ratingOf(rec) === 0;
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
        case "similar":
        case "look":
            // (Which pictures are like it is decided by the ranking, see
            // meaningPlan; only "-similar:" and "-look:" use this.)
            return function (rec) {
                return String(rec.i) === filter.value;
            };
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
        return term.kind === "filter" ? this.filterScores(term, context)
            : this.textScores(term, context);
    };

    // Among alternatives, a picture of the person a person: term names
    // scores above any one word ("person:Anna OR anna": her pictures before
    // those that only have the name in a folder name, a file name or a
    // title -- a mug with "Anna" on it).
    var PERSON_SCORE = 20;

    // Among alternatives, a picture taken at a named place of the kind a
    // kind: term names scores this much more than its words do ("kind:zoo
    // OR zoo", as plain-language search writes "zoos"; per word of a kind
    // of several, "kind:cafe OR coffee kind:cafe OR shop"): a little more
    // than the word in its title, so in a search by words the pictures
    // taken at a zoo come first -- those that say it too before those that
    // do not -- then those that only say it; by words and meaning, how
    // close a picture is to what was asked counts as for any word (and the
    // pictures taken at one that do not say it are not what tells whether
    // the words found what the query means: kindOnly, wordsUnlikeQuery).
    var KIND_SCORE = 12;

    function kindTerm(term) {
        return term.kind === "filter" && !term.neg && Boolean(term.filter) &&
            term.filter.kind === "place_kind";
    }

    // Scores of a clause of alternatives (a negated one matches where its
    // term does not). With a kind of place among them, the scores carry
    // kindOnly: per record 1 when only the kind matched (no other term).
    Index.prototype.clauseScores = function (clause, context) {
        if (clause.terms.length === 1 && !clause.terms[0].neg) {
            return this.termScores(clause.terms[0], context);
        }
        var out = filled(this.n, -1);
        var at = null;
        var r;
        for (var t = 0; t < clause.terms.length; t++) {
            var term = clause.terms[t];
            var scores = this.termScores(term, context);
            if (kindTerm(term)) {
                at = at || new Uint8Array(this.n);
                for (r = 0; r < this.n; r++) {
                    if (scores[r] >= 0) {
                        at[r] = 1;
                    }
                }
                continue;
            }
            var person = term.kind === "filter" && Boolean(term.filter) &&
                term.filter.kind === "person" ? PERSON_SCORE : 0;
            for (r = 0; r < this.n; r++) {
                var score = term.neg ? (scores[r] < 0 ? 0 : -1)
                    : person && scores[r] >= 0 ? person : scores[r];
                if (score > out[r]) {
                    out[r] = score;
                }
            }
        }
        if (at) {
            out.kindOnly = new Uint8Array(this.n);
            for (r = 0; r < this.n; r++) {
                if (at[r] === 1) {
                    out.kindOnly[r] = out[r] < 0 ? 1 : 0;
                    out[r] = Math.max(out[r], 0) + KIND_SCORE;
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

    function facetPasses(test, r, flags, records) {
        if (test.live) {
            return test.live(records[r]);
        }
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
                    var id = data.ids[data.keyOf(value)];
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
        // Favorites and ratings, read from the records as they are now.
        if (selected.favorite.indexOf("yes") >= 0) {
            tests.push({live: isFavorite, group: -1});
        }
        var ratingMark = [0, 0, 0, 0, 0, 0];
        selected.rating.forEach(function (value) {
            if (RATING_VALUES.indexOf(value) >= 0) {
                ratingMark[Number(value)] = 1;
            }
        });
        if (selected.rating.length) {
            tests.push({live: function (rec) {
                return ratingMark[ratingOf(rec)] === 1;
            }, group: -2});
        }
        var records = this.records;
        var favoriteCount = 0;
        var ratingCounts = [0, 0, 0, 0, 0, 0];
        var hasCounts = [0, 0, 0];
        var final = [];
        for (var r = 0; r < this.n; r++) {
            if (!alive[r]) {
                continue;
            }
            var failed = null;
            var failures = 0;
            for (var t = 0; t < tests.length; t++) {
                if (!facetPasses(tests[t], r, flags, records)) {
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
                if (isFavorite(records[r])) {
                    favoriteCount += 1;
                }
                ratingCounts[ratingOf(records[r])] += 1;
            } else if (failures === 1 && failed.group >= 0) {
                // (A record failing a "has" value has not got it: nothing to count.)
                countFacet(failed.data, counts[failed.group], r);
            } else if (failures === 1 && failed.group === -2) {
                // (Its rating would match if that rating were chosen too.)
                ratingCounts[ratingOf(records[r])] += 1;
            }
        }
        var facets = {};
        VALUE_KEYS.forEach(function (key) {
            facets[key] = [];
        });
        groups.forEach(function (data, index) {
            facets[data.key] = facetEntries(data.key, data, counts[index], selected[data.key]);
        });
        facets.has = [];
        HAS_VALUES.forEach(function (value, index) {
            var isSelected = selected.has.indexOf(value) >= 0;
            if (hasCounts[index] > 0 || isSelected) {
                facets.has.push({value: value, count: hasCounts[index], selected: isSelected});
            }
        });
        facets.favorite = [];
        if (favoriteCount > 0 || selected.favorite.indexOf("yes") >= 0) {
            facets.favorite.push({value: "yes", count: favoriteCount,
                                  selected: selected.favorite.indexOf("yes") >= 0});
        }
        facets.rating = [];
        RATING_VALUES.forEach(function (value) {
            var isSelected = selected.rating.indexOf(value) >= 0;
            var count = ratingCounts[Number(value)];
            if (count > 0 || isSelected) {
                facets.rating.push({value: value, count: count, selected: isSelected});
            }
        });
        return {final: final, facets: facets};
    };

    var SORTS = ["relevance", "newest", "oldest", "name", "quality", "shuffle", "album"];

    /* The album filter of the one clause that names an album (album:, not
       negated, alone in its clause), when the query has exactly one. */
    function soleAlbum(parsed) {
        var found = [];
        parsed.clauses.forEach(function (clause) {
            var term = clause.terms[0];
            if (clause.terms.length === 1 && !term.neg && term.kind === "filter" &&
                    term.filter && term.filter.kind === "album") {
                found.push(term.filter);
            }
        });
        return found.length === 1 ? found[0] : null;
    }

    /* The search a smart album saved, as options of a search of its own:
       its filters, sort, words/meaning mode, library and dates, with the
       visibility of the search around it (opts). */
    function smartOptions(album, opts, stack) {
        var saved = album.options && typeof album.options === "object" ? album.options : {};
        var out = {
            libraries: opts.libraries,
            library: isText(saved.lib) ? saved.lib : "",
            hidden: opts.hidden,
            sensitive: opts.sensitive,
            "private": opts["private"],
            junk: opts.junk,
            today: opts.today,
            seed: opts.seed,
            filters: saved.filters && typeof saved.filters === "object" ? saved.filters : {},
            sort: isText(saved.sort) ? saved.sort : undefined,
            meaning: saved.by === "words" || saved.by === "meaning" ? saved.by : "hybrid",
            albums: opts.albums,
            people: opts.people,
            peoplePending: opts.peoplePending,
            names: opts.names,
            vectorFor: opts.vectorFor,
            albumStack: stack.concat([album.id]),
            group: false,
            // (A drive found by its own words is in the album whole.)
            wholeDrives: true
        };
        if (isText(saved.from) || isText(saved.to)) {
            out.range = {from: saved.from || "", to: saved.to || ""};
        }
        if (isText(saved.area) && saved.area) {
            out.area = saved.area;
        }
        if (out.meaning !== "words" && typeof opts.vectorFor === "function") {
            // (With the vectors of its words too, or by its words alone until
            // they have all come: Per-term coverage.)
            var texts = meaningTexts(album.query || "");
            var found = texts.map(function (text) {
                return opts.vectorFor(text) || null;
            });
            out.vector = found.length && found.every(Boolean) ? found[0] : null;
            var terms = {};
            texts.slice(1).forEach(function (text, k) {
                terms[text] = found[k + 1];
            });
            out.termVectors = terms;
        }
        return out;
    }

    /* The pictures of an album the query names: {album, rank (per record:
       its place in the album, -1 when it is not in it), count}, or null
       when there is no such album (with a warning). */
    Index.prototype.albumSet = function (value, opts, context) {
        var found = findAlbum(opts.albums, value, true);
        var album = found.album;
        if (!album) {
            context.warn(found.ambiguous ? "More than one album starts with \"" + value +
                         "\": type more of its name." : "There is no album called \"" +
                         value + "\".");
            return null;
        }
        var rank = new Int32Array(this.n);
        rank.fill(-1);
        var count = 0;
        var r;
        if (album.kind === "smart") {
            var stack = Array.isArray(opts.albumStack) ? opts.albumStack : [];
            if (stack.indexOf(album.id) >= 0 || stack.length >= ALBUM_DEPTH) {
                context.warn("The smart album \"" + album.name + "\" names itself (or albums " +
                             "within albums too deeply), so it finds nothing here.");
                return {album: album, rank: rank, count: 0};
            }
            var found = this.search(album.query || "", smartOptions(album, opts, stack));
            // (What its search could not understand is said here too.)
            found.warnings.forEach(context.warn);
            context.areaPending = context.areaPending || found.areaPending;
            for (var k = 0; k < found.items.length; k++) {
                r = this.position[String(found.items[k])];
                if (r !== undefined && rank[r] < 0) {
                    rank[r] = count;
                    count += 1;
                }
            }
            return {album: album, rank: rank, count: count};
        }
        var items = Array.isArray(album.items) ? album.items : [];
        for (var i = 0; i < items.length; i++) {
            r = this.position[String(items[i])];
            if (r !== undefined && rank[r] < 0 && (!this.records[r].al ||
                                                   inAlbum(this.records[r], album.id))) {
                rank[r] = count;
                count += 1;
            }
        }
        // (Pictures put in it on this page since the albums were loaded.)
        for (r = 0; r < this.n; r++) {
            var rec = this.records[r];
            if (rank[r] < 0 && rec && typeof rec === "object" && inAlbum(rec, album.id)) {
                rank[r] = count;
                count += 1;
            }
        }
        return {album: album, rank: rank, count: count};
    };

    // The albums the query names, worked out before anything else (a
    // smart album runs a search of its own): {filter value: albumSet()}.
    Index.prototype.albumSets = function (parsed, opts, context) {
        var sets = Object.create(null);
        var self = this;
        parsed.terms.forEach(function (term) {
            if (term.kind === "filter" && term.filter && term.filter.kind === "album" &&
                    sets[term.filter.value] === undefined) {
                sets[term.filter.value] = self.albumSet(term.filter.value, opts, context);
            }
        });
        return sets;
    };

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
            today: todayKey(opts.today),
            warn: function (message) {
                if (warnings.indexOf(message) < 0) {
                    warnings.push(message);
                }
            }
        };
        // For the Ranking rules: one plain word searched alone, and a query
        // that asks for toys, statues, drawings, art, documents, ... itself.
        var looked = parsed.terms.filter(function (term) {
            return term.active && !term.neg && term.kind !== "filter";
        });
        context.oneWord = looked.length === 1 && looked[0].kind === "word";
        context.depictions = looked.some(function (term) {
            return term.words.some(function (word) {
                var folded = foldWord(word);
                return Boolean(DEPICTION_BEFORE[word] || DEPICTION_AFTER[word] ||
                               DEPICTION_OF[word] || DEPICTION_MATERIALS[word] ||
                               DEPICTION_TYPES[word] || ART_WORDS[word] ||
                               DEPICTION_BEFORE[folded] || DEPICTION_AFTER[folded] ||
                               DEPICTION_OF[folded] || DEPICTION_TYPES[folded] ||
                               ART_WORDS[folded]);
            });
        });
        context.people = opts.people;
        context.peoplePending = Boolean(opts.peoplePending);
        // (An export's published names: Per-term coverage, nameLike.)
        context.published = this.publishedNames(opts.names);
        context.albumSets = this.albumSets(parsed, opts, context);
        var alive = this.visibility(opts, parsed.wantsHidden);
        var score = new Float64Array(n);
        var r;
        if (Array.isArray(opts.ids)) {
            var picked = new Uint8Array(n);
            for (var p = 0; p < opts.ids.length; p++) {
                var at = this.position[String(opts.ids[p])];
                if (at !== undefined) {
                    picked[at] = 1;
                }
            }
            for (r = 0; r < n; r++) {
                alive[r] &= picked[r];
            }
        }
        var range = dateRange(opts.range);
        if (range) {
            for (r = 0; r < n; r++) {
                if (alive[r] && (!this.taken[r] || !inRange(records[r].dk, range))) {
                    alive[r] = 0;
                }
            }
        }
        // (Only the pictures taken in the area: none until the places are in.)
        var area = opts.area ? readArea(opts.area) : null;
        var areaPending = false;
        if (opts.area && !area) {
            context.warn("The area on the map could not be read, so it was left out.");
        } else if (area) {
            var inside = this.inArea(area);
            areaPending = !inside;
            for (r = 0; r < n; r++) {
                if (alive[r] && !(inside && inside[r])) {
                    alive[r] = 0;
                }
            }
        }
        // (Within the one album the query names, its drives are made of
        // its clips only.)
        var soleSet = soleAlbum(parsed);
        soleSet = soleSet ? context.albumSets[soleSet.value] : null;
        var drivePlan = this.drivePlan(alive, opts, soleSet ? soleSet.rank : null);
        var driveScores = this.driveClauses(parsed, context, drivePlan);
        var plan = this.meaningPlan(parsed, opts, context);
        // Pictures without the free words (when meaning may find them).
        var missed = plan && plan.free ? new Uint8Array(n) : null;
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
            if (plan && plan.similar && clause.terms.length === 1 &&
                    clause.terms[0] === plan.similar) {
                continue;
            }
            scores = driveScores && driveScores[c] ? driveScores[c]
                : this.clauseScores(clause, context);
            var relaxed = missed !== null && plan.free[c] === true;
            if (relaxed && scores.kindOnly) {
                // (Taken at the kind of place, without its words: kindOnly.)
                plan.byKind = plan.byKind || new Uint8Array(n);
                for (r = 0; r < n; r++) {
                    plan.byKind[r] |= scores.kindOnly[r];
                }
            }
            // (Per free clause, the pictures without its words: Per-term coverage.)
            var lacking = relaxed && plan.lacking ? (plan.lacking[c] = new Uint8Array(n)) : null;
            for (r = 0; r < n; r++) {
                if (alive[r]) {
                    if (scores[r] < 0) {
                        if (relaxed) {
                            missed[r] = 1;
                            if (lacking) {
                                lacking[r] = 1;
                            }
                        } else {
                            alive[r] = 0;
                        }
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
                if (alive[r] && !(missed && missed[r])) {
                    var where = this.phraseFields(r, matchers, PHRASE_FIELDS);
                    if (where) {
                        score[r] += where & (1 << F_TITLE) ? SEQUENCE_TITLE_BONUS
                            : SEQUENCE_TEXT_BONUS;
                    }
                }
            }
        }
        if (drivePlan) {
            this.driveCovers(drivePlan, alive, missed);
        }
        var meaning = plan ? this.applyMeaning(plan, alive, score, missed, context) : null;
        var ranked = parsed.hasText || meaning !== null;
        var pass = this.facetPass(alive, opts);
        var final = pass.final;
        if (meaning && meaning.rescued && meaning.rescued.length) {
            // (A name a picture without it is shown for is not searched by
            // its words only: termCoverage.)
            var shown = new Uint8Array(n);
            final.forEach(function (row) {
                shown[row] = 1;
            });
            meaning.rescued.forEach(function (clause) {
                if (clause.rows.some(function (row) {
                    return shown[row] === 1;
                })) {
                    clause.items.forEach(function (item) {
                        item.name = false;
                    });
                }
            });
        }
        var sort = SORTS.indexOf(opts.sort) >= 0 ? opts.sort
            : ranked ? "relevance" : "newest";
        // The order of the one album the query names: when asked for, and
        // by default when there are no words to rank by.
        var sole = soleAlbum(parsed);
        var albumSet = sole ? context.albumSets[sole.value] : null;
        if (albumSet && (sort === "album" || (SORTS.indexOf(opts.sort) < 0 && !ranked))) {
            sort = "album";
        } else if (sort === "album") {
            sort = ranked ? "relevance" : "newest";
        }
        var ordered;
        if (sort === "album") {
            var albumRank = albumSet.rank;
            ordered = final.slice().sort(function (a, b) {
                return albumRank[a] - albumRank[b] || a - b;
            });
        } else if (sort === "relevance" && ranked) {
            ordered = this.byScore(final, score);
        } else {
            var inFinal = new Uint8Array(n);
            for (var k = 0; k < final.length; k++) {
                inFinal[final[k]] = 1;
            }
            ordered = this.order(sort === "relevance" ? "newest" : sort,
                                 opts.seed).filter(function (index) {
                return inFinal[index] === 1;
            });
        }
        var drives = drivePlan ? this.driveResults(ordered, drivePlan, ranked,
                                                   Boolean(meaning && meaning.mode === "meaning"),
                                                   missed) : null;
        var grouped = opts.group || (opts.drives && drives)
            ? this.groupResults(ordered, sort, Boolean(opts.group),
                                opts.drives && drives ? drives.shown : null) : null;
        var items = grouped ? grouped.items : ordered.map(function (index) {
            return records[index].i;
        });
        if (opts.wholeDrives === true && drives) {
            items = this.wholeDrives(items, drives.drives);
        }
        return {
            total: final.length,
            items: items,
            facets: pass.facets,
            timeline: opts.timeline === true ? timelineOf(this.taken, final) : null,
            groups: grouped ? grouped.groups : {},
            drives: drives ? drives.drives : {},
            collapsed: grouped ? grouped.collapsed : 0,
            album: albumSet ? {id: albumSet.album.id, name: albumSet.album.name,
                               kind: albumSet.album.kind === "smart" ? "smart" : "manual"}
                : null,
            sort: sort,
            query: parsed,
            warnings: warnings,
            areaPending: areaPending || Boolean(context.areaPending),
            byMeaning: meaning ? meaning.only : [],
            meaning: meaning ? {mode: meaning.mode, best: meaning.best,
                                terms: meaning.terms || []} : null
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
       dupes: duplicate groups; drives (driveResults' shown, or null): each
       drive once too, as its shown clip (in a date order where that is, or
       where its first match is when it is not a match), none of its clips
       in a duplicate group. */
    Index.prototype.groupResults = function (ordered, sort, dupes, drives) {
        var records = this.records;
        var groupOf = this.groupOf;
        var driveOf = this.driveOf;
        var first = this.groupCover.length;     // drive d is group first + d
        var count = first + (drives ? drives.length : 0);
        var dated = sort === "newest" || sort === "oldest";
        var included = new Uint8Array(this.n);
        var shownFor = new Int32Array(count);
        var placed = new Uint8Array(count);
        var stacks = [];
        var items = [];
        var k;
        dupes = dupes !== false;
        drives = drives || null;
        function folded(r) {
            return drives !== null && driveOf[r] >= 0 && drives[driveOf[r]] >= 0;
        }
        for (k = 0; k < ordered.length; k++) {
            included[ordered[k]] = 1;
        }
        shownFor.fill(-1);
        for (k = 0; k < ordered.length; k++) {
            var r = ordered[k];
            var group = folded(r) ? first + driveOf[r] : dupes ? groupOf[r] : -1;
            if (group < 0) {
                items.push(records[r].i);
                continue;
            }
            var shown = shownFor[group];
            if (shown < 0) {
                if (group >= first) {
                    shown = drives[group - first];
                } else {
                    // (A cover that is a clip of a folded drive is in its drive.)
                    var cover = this.groupCover[group];
                    shown = cover >= 0 && included[cover] && !folded(cover) ? cover : r;
                }
                shownFor[group] = shown;
                stacks[group] = [records[shown].i];
            }
            if (!placed[group] && (!dated || r === shown || !included[shown])) {
                placed[group] = 1;
                items.push(records[shown].i);
            }
            if (r !== shown) {
                stacks[group].push(records[r].i);
            }
        }
        var groups = {};
        var collapsed = 0;
        for (k = 0; k < first; k++) {
            if (stacks[k] && stacks[k].length > 1) {
                groups[String(stacks[k][0])] = stacks[k];
                collapsed += stacks[k].length - 1;
            }
        }
        return {items: items, groups: groups, collapsed: collapsed};
    };

    /* ---------- Search by meaning ------------------------------------------ */

    // Signed-byte vectors are unit length times 127: a dot product over
    // this is the cosine (of meaning vectors; look vectors are divided by
    // their own lengths, Index.norms, as their cut-offs are finer).
    var VECTOR_SCALE2 = 127 * 127;
    /* How close is close depends on the query: with an embedding model
       every description is somewhat like every query, and some queries
       are like everything a little more than others. So a cosine is judged
       against the cosines of the whole index for the same query: z is how
       many standard deviations it is above their mean. Calibrated on a
       library of several thousand described photos and documents with
       two small embedding models at 256 dimensions (Qwen3-Embedding-0.6B,
       mdbr-leaf-ir): the cosines of a query average about 0.1 to 0.4
       (deviation 0.04 to 0.1), pictures that show what was asked come out
       at z 3.5 to 5 with either, and below about z 3 they drift to what
       merely shares a theme. */
    // Hybrid: the meaning part of a word match's score, from 0 to twice
    // this (the word part is at most 1) ...
    var MEANING_WEIGHT = 0.6;
    // ... and what one word found in a title (10) or in the tags and the
    // description scores: word scores are divided by the best one, but by
    // at least this per free word, so weak matches stay weak.
    var WORD_STRONG = 10;
    // ... growing from 0 at this z to the full weight at the best cosine.
    var MEANING_FLOOR_Z = 1.5;
    // Hybrid: a picture without the words is found by meaning when its z
    // is at least this, and at most MEANING_MARGIN_Z below the best one's;
    // at most MEANING_EXTRA of them (the closest), so a query nothing
    // matches shows a short list of the nearest pictures, not the top of
    // the whole index.
    var MEANING_MIN_Z = 3.0;
    var MEANING_MARGIN_Z = 1.8;
    var MEANING_EXTRA = 40;
    // Hybrid, for a query of at most MEANING_NAME_WORDS words (a longer one
    // describes something, which is what meaning is for): when the median
    // z of the word matches is below MEANING_WORDS_Z, the words found
    // pictures whose meaning is not what the model makes of the query (a
    // name, a place, a file name, a word in a picture's text): the word
    // matches are then ranked by their words alone and none are added.
    var MEANING_WORDS_Z = 1.0;
    var MEANING_NAME_WORDS = 2;
    /* Per-term coverage (hybrid, two or more free clauses): a picture
       without the words of a free clause covers it by meaning when its z
       for the clause's own words (their own vector, termVectors) reaches
       the word's cut: MEANING_TERM_Z; for a word whose word matches are not
       that close to it themselves (a common word such as "tree" or "red",
       whose z runs low as so many pictures have it) the median z of its
       word matches, but at least MEANING_TERM_LOW; for a word whose word
       matches stand far out ("puppy", "kitten", "dancing": a median z of 5
       or 6) at most MEANING_TERM_SPAN below that median (with
       MEANING_TERM_SAMPLE word matches with a vector). Measured on a
       library of several thousand described pictures: the pictures meaning
       wrongly added to "dog playing in snow" (snowmen, dogs indoors),
       "helicopter over a volcano" (helicopters), "puppy in the snow"
       (puppies on a couch) or "people dancing at a wedding" (a wedding
       walk) were at z 2 or less for the word they lacked, or more than 2.5
       below its median; pictures that showed it were mostly above.
       A word's own vector does not say what it means next to the others,
       though ("sports car", "waves crashing", "chips on a table", a
       craft's "artist": a red coupe, waves on rocks, casino chips and a
       craftsman at work came out at z 0.5 to 2 for "sports", "crashing",
       "table" and "artist"). So a picture without the words of one
       describable clause only also stays when at least MEANING_TERM_FULL
       pictures (with a vector) have every free word and the picture is
       about as close to the whole query as they are: its z at most
       MEANING_TERM_MARGIN_Z below their median. (Without such pictures --
       nothing has all the words, and everything shown is found by meaning
       -- each part must be seen on its own.) */
    var MEANING_TERM_Z = 2.0;
    var MEANING_TERM_LOW = 1.0;
    var MEANING_TERM_SPAN = 2.5;
    var MEANING_TERM_SAMPLE = 5;
    var MEANING_TERM_FULL = 3;
    var MEANING_TERM_MARGIN_Z = 1.0;
    /* A free word is name-like (a person's, a place's, a year, a word of
       folder or file names or of the text in pictures: nothing the
       describing model can see) when fewer than NAME_SHARE of the pictures
       with it have it in what they show (SHOWN_FIELDS) and its word matches
       are not close to its own meaning (their median z below
       MEANING_TERM_Z, or fewer than NAME_SAMPLE of them with a vector); or
       fewer than NAME_SHARE_Z do and that median is below MEANING_WORDS_Z.
       Matches by the place words alone do not count ("atlantic" is a town
       and an ocean). A name-like word is covered by its words only, never
       by meaning. (Measured: first names had 0 to 25% of their matches in
       what pictures show and a median z of 0.4 to 1.1; towns 1 to 17%,
       years 0 to 2%; describable words such as "turtle", "beach",
       "receipt" or "sunset" 38 to 97%; a word mostly in folder names but
       easily seen, such as a hobby named by the folder of its pictures, 8
       to 14% at a median z of 2.9 to 3.3.) A free word that no picture has by its words (a
       misspelling, or a word no description uses) is not checked: the
       meaning of the whole query decides, as before. */
    var NAME_SHARE = 0.2;
    var NAME_SHARE_Z = 0.5;
    var NAME_SAMPLE = 3;
    // "Meaning" only: a wider net.
    var MEANING_ONLY_Z = 2.5;
    var MEANING_ONLY_MARGIN_Z = 3.0;
    /* A small set (an export of a small library, say) has few pictures that
       stand out: with n pictures no z can be above the square root of n - 1,
       and the few that are like a query share the top. When none of its
       pictures without the words reaches MEANING_MIN_Z, the closest one
       still counts when its z is at least the few-cut of the set
       (meaningCuts), with the next ones up to MEANING_FEW in all that are
       at most MEANING_FEW_MARGIN_Z below it ("meaning" only, a wider net,
       does the same, and also of all pictures when none reaches
       MEANING_MIN_Z). The few-cut is MEANING_FEW_Z in a set of up to
       MEANING_FEW_SET pictures with a vector and MEANING_FEW_GROWTH more
       each time the set is e (2.72) times as large: 2.26 in a set of 63,
       2.37 of 100, 2.55 of 200, 2.95 of 1,000; it is MEANING_MIN_Z at
       about 1,230 pictures, where the rule ends without a step. A search
       of one free clause, which per-term coverage cannot check, has the
       one-clause cut instead, growing MEANING_FEW_GROWTH_ONE: 2.35 of 63,
       2.65 of 100, 2.91 of 150, MEANING_MIN_Z at about 170.
       Measured on seeded random sets of a library of several thousand
       pictures: the closest picture a query does not mean came out at a
       median z of 2.0 (19 pictures), 2.2 (30), 2.5 (63), 2.6 (100), 2.9
       (200), 3.2 (500) and 3.4 (1,000), at the 90th percentile 2.7, 2.9,
       3.1, 3.4, 3.6, 3.8 and 4.0; the closest of three pictures that mean
       it at a median z of 2.3 (19), 2.75 (30), 3.4 (63), 3.7 (100) and 4.0
       (200). For 25 searches of several words with three right pictures
       put in each set (6 sets per size), the right pictures found went
       from 115 to 244 of 411 in sets of 63, 133 to 236 of 412 of 100, 138
       to 226 of 420 of 150, 149 to 212 of 444 of 200 and 217 to 220 of
       629 of 500 (the same from 1,000 on), and from 221-259 to 230-269 of
       about 410 in sets of 35 to 49; the pictures shown that are not what
       was asked for from 1 to 27 (63), 6 to 30 (100), 2 to 25 (150), 4 to
       7 (200). Such near misses are this rule's price: in the same sets
       without planted answers, 64 (63), 41 (100), 24 (150) and 19 (200)
       pictures not asked for came up in 100 searches, against 3, 6, 1 and
       5 before (and 46 to 69 in sets of 35 to 49, 38 to 56 before); in an
       export of 63 pictures, 10 of 16 searches with no answer among them
       show 1 to 3 of the closest pictures. For 24 searches of one word that
       descriptions seldom use ("lodging", "canine", a misspelled animal),
       the few-cut of several words found 22, 28, 25 and 15 more of the
       right pictures in sets of 63, 100, 150 and 200, for 70, 62, 62 and
       56 more not asked for (96 searches each); the one-clause cut 19, 18,
       8 and none more for 52, 32, 5 and none, about as many near misses as
       sets of 49 had before. The margin: in the set of 63 the coffee cups
       "something warm to drink" means came out 0.64 below a fox drinking
       from a pond; over random sets of 19, 30 and 63, 0.7 found a tenth
       more of the right pictures than 0.5 (256 of 529, against 233), for
       one more wrong one in about fifty searches (in the bundled sample of
       19 the cups now come with a bowl of fruit salad 0.7 below them).
       A word no picture has gets the closest few too, even a name
       ("Maplebrook" in a set without it, which then shows near misses):
       offline such a name cannot be told from a word that descriptions
       seldom use, many of which the words of the language "did you mean"
       knows lack ("feline", "cutlery", "footwear"). Leaving the words
       outside that list out of the closest few lost 6 to 27 of the right
       pictures of those 24 one-word searches in sets of 19 to 150 (up to
       18% of them), though in the same sets without planted answers it
       also left out 40% to 56% of the pictures not asked for in sets of 19
       to 49 (30% in 63, 22% in 100), for 2 to 9 of the right ones. A fuller
       offline word list, with such words in it, would make it worth doing. */
    var MEANING_FEW_Z = 2.2;
    var MEANING_FEW_SET = 50;
    var MEANING_FEW_GROWTH = 0.25;
    var MEANING_FEW_GROWTH_ONE = 0.65;
    var MEANING_FEW_MARGIN_Z = 0.7;
    var MEANING_FEW = 4;
    /* Nor does per-term coverage (see MEANING_TERM_Z) fit a small set: a
       word's own z is held down as the query's is, and a word on its own
       often means something else than next to the others ("warm" of
       "something warm to drink", "old" of "an old highway", "standing" of "a
       bird standing on a branch"). So a picture it would leave out still
       stays when its z for the whole query is at least MEANING_TERM_RESCUE
       times the highest z the set allows (the square root of n - 1): 1.06 in
       a set of 19 pictures with a vector, 1.97 of 63, 2.49 of 100, 3.53 of
       200, 5.58 of 500, 7.9 of 1,000 -- higher than any picture comes (in a
       library of several thousand, the closest picture to each of 174 queries
       came out at z 7.04 at most), so a large library is searched as by
       per-term coverage alone. Never when it lacks a name-like word that
       NAME_SAMPLE or more pictures have, fewer than NAME_SHARE of them in
       what they show (a folder's, a file's, a person's or a place's name):
       such a name is covered by its words only at every size (so "anna
       turtle" is no turtle of anyone else's). A word too rare to tell is let
       go, and so is one that descriptions use too (in a set of 63, "made",
       which one description and the text in two pictures have: a bridge "made
       of steel" lacks it). Measured on random sets of a library of several
       thousand, of the pictures per-term coverage left out at z 2 or more for
       the whole query: in sets of 30 and 63, nine in ten showed what was
       asked for; in sets of 200, seven of eight above z 3.5 and two in three
       below; in sets of 500 to 2,000, all but one in seventy above z 4, while
       the snowmen and snowy streets of "dog playing in snow" came out at z 3
       to 3.8. For 8 searches of a name-like word and a thing, the pictures
       shown without the name were 13, 4, 7 and 6 in 32 searches in sets of
       63, 100, 150 and 200 (30, 16, 14 and 9 when names were let go too; 8,
       3, 2 and 5 keeping every name of three pictures or more, which left the
       steel bridges out). (Per-term coverage used to start at 50 pictures: a
       set of 63 found nothing for most searches of several words.) */
    var MEANING_TERM_RESCUE = 0.25;

    /* {few, one, rescue}: the few-cut of a set of count pictures with a
       meaning vector (MEANING_FEW_Z), the one-clause cut, and the z of the
       whole query that keeps a picture per-term coverage would leave out
       (MEANING_TERM_RESCUE). */
    function meaningCuts(count) {
        var n = Math.max(1, count || 0);
        var growth = Math.log(Math.max(1, n / MEANING_FEW_SET));
        return {few: MEANING_FEW_Z + MEANING_FEW_GROWTH * growth,
                one: MEANING_FEW_Z + MEANING_FEW_GROWTH_ONE * growth,
                rescue: MEANING_TERM_RESCUE * Math.sqrt(n - 1)};
    }
    // similar: and the "More like this" strip: pictures at least this z
    // (over the cosines of the other pictures to the picture), and at least
    // SIMILAR_MIN_SD standard deviations above the cosine of two pictures
    // taken at random (Index.pairSpread) ...
    var SIMILAR_MIN_Z = 3.0;
    var SIMILAR_MIN_SD = 1.0;
    // ... and when fewer than SIMILAR_FEW pictures are that close, the
    // closest ones up to SIMILAR_FEW in all, if they are at least
    // SIMILAR_NEAR_SD standard deviations above that cosine and at most
    // SIMILAR_MARGIN_SD of them below the closest one. (A small set, such as
    // an export of one library, or one of a single theme, has few pictures
    // that stand out: with n other pictures no z can be above the square
    // root of n - 1, so z 3 needs ten of them at the very least. The margin
    // keeps what merely shares a theme out when one picture is much closer.)
    var SIMILAR_FEW = 4;
    var SIMILAR_NEAR_SD = 2.0;
    var SIMILAR_MARGIN_SD = 1.0;
    // Index.pairSpread: pairs of pictures looked at, at most; and what a
    // set too small to say (fewer than SPREAD_MIN_PAIRS pairs) goes by. It
    // is also the most the spread is taken to be: a set of one theme (one
    // library, or only documents) has pictures that are all rather alike,
    // and judged by its own spread, few would stand out as close. (These
    // are the cosines the thresholds were first set as, on a varied library.)
    var SPREAD_PAIRS = 2000;
    var SPREAD_MIN_PAIRS = 45;
    var DEFAULT_SPREAD = {mean: 0.4, std: 0.1};
    // The same for look vectors (setLooks), whose cosines run higher and
    // closer together: two pictures taken at random from a varied library
    // came out at 0.64 (deviation 0.065) with EmbeddingGemma 2 at 256
    // dimensions, against 0.37 (0.125) for their descriptions.
    var LOOK_SPREAD = {mean: 0.65, std: 0.07};
    // Two look vectors at least this close are the same picture (a copy, or
    // the same picture cropped, scaled or edited a little: such pairs came
    // out at 0.97 to 1, different pictures of one scene below). Copies of
    // the picture looked for are shown first but are not what "close" is
    // judged by (Index.similarCut): one of them would leave room for
    // nothing else.
    var LOOK_COPY = 0.97;
    // Without vectors, similar: shows at most this many pictures.
    var SIMILAR_FALLBACK = 200;

    function decodeBase64(text) {
        if (typeof atob === "function") {
            var binary = atob(text);
            var out = new Uint8Array(binary.length);
            for (var k = 0; k < binary.length; k++) {
                out[k] = binary.charCodeAt(k);
            }
            return out;
        }
        /* global Buffer */
        if (typeof Buffer !== "undefined") {
            return new Uint8Array(Buffer.from(text, "base64"));
        }
        return null;
    }

    function asBytes(data) {
        if (typeof data === "string") {
            try {
                return decodeBase64(data);
            } catch (error) {
                return null;
            }
        }
        if (data instanceof Int8Array || data instanceof Uint8Array) {
            return data;
        }
        return null;
    }

    /* The vectors of an answer ({model, dims, query, ids, data: base64 or
       bytes}) as {model, dims, query, ids, data: Int8Array}, or null when
       it holds none (or is damaged). */
    function decodeVectors(payload) {
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.ids)) {
            return null;
        }
        var dims = payload.dims;
        if (typeof dims !== "number" || !(dims > 0) || Math.floor(dims) !== dims) {
            return null;
        }
        var bytes = asBytes(payload.data);
        if (!bytes || bytes.length !== payload.ids.length * dims || !payload.ids.length) {
            return null;
        }
        return {model: typeof payload.model === "string" ? payload.model : "", dims: dims,
                query: payload.query === true, ids: payload.ids,
                data: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)};
    }

    // Several decodeVectors() answers (an export's files) as one; parts of
    // another size than the first are left out.
    function joinVectors(parts) {
        var list = (Array.isArray(parts) ? parts : []).filter(Boolean);
        if (!list.length) {
            return null;
        }
        var dims = list[0].dims;
        list = list.filter(function (part) {
            return part.dims === dims;
        });
        if (list.length === 1) {
            return list[0];
        }
        var total = 0;
        list.forEach(function (part) {
            total += part.ids.length;
        });
        var data = new Int8Array(total * dims);
        var ids = [];
        var at = 0;
        list.forEach(function (part) {
            data.set(part.data, at);
            at += part.data.length;
            ids = ids.concat(part.ids);
        });
        return {model: list[0].model, dims: dims, query: list[0].query, ids: ids, data: data};
    }

    // A query's vector from /api/embed (base64 of dims signed bytes), or null.
    function queryVector(text, dims) {
        var bytes = asBytes(text);
        if (!bytes || (dims && bytes.length !== dims) || !bytes.length) {
            return null;
        }
        return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    }

    // A term meaning may stand in for: a plain word (or words) of no field.
    function freeTerm(term) {
        return term.kind !== "filter" && !term.field && !term.quoted && !term.neg;
    }

    /* A clause meaning may stand in for: free terms, or free terms with a
       kind of place as their alternative ("kind:zoo OR zoo": the words say
       what pictures show, which meaning can find; the kind adds the
       pictures taken at one, see KIND_SCORE). */
    function freeClause(clause) {
        return clause.terms.some(freeTerm) && clause.terms.every(function (term) {
            return freeTerm(term) || kindTerm(term);
        });
    }

    function similarTerm(term) {
        return term.kind === "filter" && !term.neg && Boolean(term.filter) &&
            term.filter.kind === "similar";
    }

    function lookTerm(term) {
        return term.kind === "filter" && !term.neg && Boolean(term.filter) &&
            term.filter.kind === "look";
    }

    /* A clause that names someone, somewhere or a time: it has a person:,
       place: or date: term (plain-language search writes "person:Anna OR
       anna", "date:2019 OR 2019"): its words are a name, which meaning
       would only blur. */
    function nameClause(clause) {
        return clause.terms.some(function (term) {
            return !term.neg && (term.field === "place" || (term.kind === "filter" &&
                Boolean(term.filter) && (term.filter.kind === "person" ||
                                         term.filter.kind === "date")));
        });
    }

    /* The text whose meaning a query looks for: its plain words and quoted
       phrases (small words too: they carry meaning), without filters,
       field words, -words and the words of a clause that names someone or
       somewhere (nameClause). "" when there is nothing meaning could rank. */
    function meaningText(query) {
        var parsed = asQuery(query);
        if (parsed.terms.some(similarTerm) || parsed.terms.some(lookTerm) ||
                !parsed.terms.some(freeTerm)) {
            return "";
        }
        var named = [];
        parsed.clauses.forEach(function (clause) {
            if (nameClause(clause)) {
                named = named.concat(clause.terms);
            }
        });
        return parsed.terms.filter(function (term) {
            return term.kind !== "filter" && !term.field && !term.neg && named.indexOf(term) < 0;
        }).map(function (term) {
            return term.value;
        }).join(" ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    }

    // What is embedded for one term on its own (Per-term coverage).
    function termText(term) {
        return String(term.value).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    }

    // The most texts meaningTexts gives (the whole query and MEANING_TEXTS
    // - 1 words): what /api/embed takes in one request (embeddings.py's
    // QUERY_TEXTS). A word past them goes without a vector of its own.
    var MEANING_TEXTS = 9;

    /* The texts to embed for a query, the whole query's first: [meaningText
       (query)], and when it has two or more free clauses (a search by words
       and meaning then checks that a picture covers each, see
       MEANING_TERM_Z) also each of their terms on its own (not the words of
       RELATION_WORDS), MEANING_TEXTS in all at most. [] when meaning has
       nothing to rank. The search takes the first as its vector option and
       the others as termVectors. */
    function meaningTexts(query) {
        var parsed = asQuery(query);
        var whole = meaningText(parsed);
        if (!whole) {
            return [];
        }
        var out = [whole];
        var free = parsed.clauses.filter(freeClause);
        if (free.length < 2) {
            return out;
        }
        free.forEach(function (clause) {
            clause.terms.filter(freeTerm).forEach(function (term) {
                var text = termText(term);
                if (text && out.indexOf(text) < 0 && out.length < MEANING_TEXTS &&
                        !(term.kind === "word" && term.words.length === 1 &&
                          RELATION_WORDS[term.words[0]] === true)) {
                    out.push(text);
                }
            });
        });
        return out;
    }

    /* Attach meaning vectors (decodeVectors) to the index; returns how many
       of its records have one. null takes them away. */
    Index.prototype.setVectors = function (vectors) {
        this.vectors = null;
        this.vecRows = null;
        this.norms = null;
        this.vecCount = 0;
        this.cosCache = [];
        this.termCache = null;
        if (!vectors || !(vectors.dims > 0) || !vectors.data || !Array.isArray(vectors.ids)) {
            return 0;
        }
        var rows = new Int32Array(this.n);
        rows.fill(-1);
        var count = 0;
        for (var k = 0; k < vectors.ids.length; k++) {
            var r = this.position[String(vectors.ids[k])];
            if (r !== undefined && rows[r] < 0) {
                rows[r] = k;
                count += 1;
            }
        }
        this.vectors = vectors;
        this.vecRows = rows;
        this.vecCount = count;
        this.spreadCache = null;
        return count;
    };

    /* Attach look vectors (decodeVectors of /api/looks or an export's looks
       files) to the index; returns how many of its records have one. null
       takes them away. They live on a view of the index (lookView) that
       holds them where the meaning vectors are, so the cosine, spread and
       similarCut code serves both with the vectors' own statistics. */
    Index.prototype.setLooks = function (vectors) {
        var view = Object.create(this);
        view.looks = null;
        view.vectors = null;
        view.vecRows = null;
        view.vecCount = 0;
        view.cosCache = [];
        view.spreadCache = null;
        view.spreadDefault = LOOK_SPREAD;
        view.copyCosine = LOOK_COPY;
        this.looks = view;
        var count = Index.prototype.setVectors.call(view, vectors);
        view.norms = vectorNorms(view.vectors);
        return count;
    };

    /* Where the pictures were taken, for the area option: points, the
       located pictures of SITE.loadLocations ([{id, lat, lon}], with "e": 1
       for an estimated place or "o": 1 for the owner's, and "r": its radius
       in km when known: such a place is in an area only at least half its
       radius deep), and routes, the
       drives' routes of SITE.loadRoutes ([{c: [{i: clip id, p: its GPS
       track}]}]: a clip is in an area its route passes through). Returns
       how many records have a place; null takes them away (an area then
       finds nothing: result.areaPending). */
    Index.prototype.setPlaces = function (points, routes) {
        this.located = null;
        if (!Array.isArray(points) && !Array.isArray(routes)) {
            return 0;
        }
        var n = this.n;
        var lists = new Array(n);
        var position = this.position;
        var total = 0;
        function add(id, lat, lon, depth) {
            var r = position[String(id)];
            if (r === undefined || typeof lat !== "number" || typeof lon !== "number" ||
                    !isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90) {
                return;
            }
            (lists[r] = lists[r] || []).push(lat, lon, depth);
            total += 1;
        }
        (Array.isArray(points) ? points : []).forEach(function (point) {
            if (point && typeof point === "object") {
                var radius = (point.e || point.o) && typeof point.r === "number" &&
                    point.r > 0 ? point.r : 0;
                add(point.id, point.lat, point.lon, radius * 1000 / 2);
            }
        });
        (Array.isArray(routes) ? routes : []).forEach(function (route) {
            (route && Array.isArray(route.c) ? route.c : []).forEach(function (clip) {
                var track = clip && typeof clip.p === "string" ? trackPositions(clip.p) : [];
                for (var k = 0; k < track.length; k += 2) {
                    add(clip.i, track[k], track[k + 1], 0);
                }
            });
        });
        var start = new Int32Array(n + 1);
        var xs = new Float64Array(total);
        var ys = new Float64Array(total);
        var scales = new Float64Array(total);
        var depths = new Float64Array(total);
        var at = 0;
        var placed = 0;
        for (var r = 0; r < n; r++) {
            start[r] = at;
            var list = lists[r];
            if (!list) {
                continue;
            }
            placed += 1;
            for (var k = 0; k < list.length; k += 3) {
                var x = (list[k + 1] + 180) / 360;
                xs[at] = x - Math.floor(x);
                ys[at] = worldY(list[k]);
                scales[at] = worldScale(list[k]);
                depths[at] = list[k + 2];
                at += 1;
            }
        }
        start[n] = at;
        // (found: the areas worked out with these places, by their text.)
        this.located = {start: start, x: xs, y: ys, scale: scales, depth: depths, count: placed,
                        found: Object.create(null), kept: []};
        return placed;
    };

    /* How many of these picture ids have a place to be in an area by
       (setPlaces: a position, an estimated or the owner's place with one, a
       route); null while the index has no places. (A place named without a
       position -- the one a file names, an estimate of a region -- is in no
       area.) */
    Index.prototype.placedCount = function (ids) {
        var places = this.located;
        if (!places) {
            return null;
        }
        var count = 0;
        var position = this.position;
        (ids || []).forEach(function (id) {
            var r = position[String(id)];
            if (r !== undefined && places.start[r + 1] > places.start[r]) {
                count += 1;
            }
        });
        return count;
    };

    /* Per record 1 when it was taken in the area (readArea's), else 0; null
       while the index has no places (setPlaces). */
    Index.prototype.inArea = function (area) {
        var places = this.located;
        if (!places || !area) {
            return null;
        }
        var found = places.found[area.text];
        if (found) {
            return found;
        }
        found = new Uint8Array(this.n);
        var start = places.start;
        for (var r = 0; r < this.n; r++) {
            for (var k = start[r]; k < start[r + 1]; k++) {
                if (areaHasAt(area, places.x[k], places.y[k], places.scale[k], places.depth[k])) {
                    found[r] = 1;
                    break;
                }
            }
        }
        places.found[area.text] = found;
        places.kept.push(area.text);
        if (places.kept.length > AREA_KEPT) {
            delete places.found[places.kept.shift()];
        }
        return found;
    };

    // 1 / the length of a vector (0 for one of length 0).
    function inverseLength(vector) {
        var sum = 0;
        for (var d = 0; d < vector.length; d++) {
            sum += vector[d] * vector[d];
        }
        return sum > 0 ? 1 / Math.sqrt(sum) : 0;
    }

    // inverseLength of every vector of vectors (decodeVectors), or null.
    function vectorNorms(vectors) {
        if (!vectors) {
            return null;
        }
        var dims = vectors.dims;
        var count = Math.floor(vectors.data.length / dims);
        var norms = new Float64Array(count);
        for (var k = 0; k < count; k++) {
            norms[k] = inverseLength(vectors.data.subarray(k * dims, (k + 1) * dims));
        }
        return norms;
    }

    // The view of the index that holds the look vectors (none: no vectors).
    Index.prototype.lookView = function () {
        if (!this.looks) {
            this.setLooks(null);
        }
        return this.looks;
    };

    // True when record id has a meaning vector (they are loaded).
    Index.prototype.hasVector = function (id) {
        var r = this.position[String(id)];
        return Boolean(this.vectors && r !== undefined && this.vectorAt(r));
    };

    // True when record id has a look vector.
    Index.prototype.hasLook = function (id) {
        var r = this.position[String(id)];
        return Boolean(this.looks && r !== undefined && this.looks.vectorAt(r));
    };

    /* {mean, std}: the cosine of two pictures taken at random, and its
       standard deviation, over up to SPREAD_PAIRS pairs of the index's own
       vectors (always the same pairs), each at most DEFAULT_SPREAD's
       (LOOK_SPREAD's for look vectors: this.spreadDefault) (also
       what a set too small to say goes by). */
    Index.prototype.pairSpread = function () {
        if (this.spreadCache) {
            return this.spreadCache;
        }
        var cap = this.spreadDefault || DEFAULT_SPREAD;
        var result = cap;
        if (this.vectors) {
            var rows = [];
            for (var r = 0; r < this.n; r++) {
                if (this.vecRows[r] >= 0) {
                    rows.push(r);
                }
            }
            var pairs = Math.min(SPREAD_PAIRS, rows.length * (rows.length - 1) / 2);
            if (pairs >= SPREAD_MIN_PAIRS) {
                var seed = 12345;       // (Park-Miller: the same pairs every time)
                var total = 0;
                var squares = 0;
                var count = 0;
                for (var k = 0; k < pairs; k++) {
                    seed = seed * 48271 % 2147483647;
                    var a = seed % rows.length;
                    seed = seed * 48271 % 2147483647;
                    var b = seed % rows.length;
                    if (a === b) {
                        continue;
                    }
                    var first = this.vectorAt(rows[a]);
                    var second = this.vectorAt(rows[b]);
                    var dot = 0;
                    for (var d = 0; d < first.length; d++) {
                        dot += first[d] * second[d];
                    }
                    if (this.norms) {
                        dot *= this.norms[this.vecRows[rows[a]]] *
                            this.norms[this.vecRows[rows[b]]];
                    } else {
                        dot /= VECTOR_SCALE2;
                    }
                    total += dot;
                    squares += dot * dot;
                    count += 1;
                }
                var mean = total / count;
                var spread = Math.sqrt(Math.max(0, squares / count - mean * mean));
                if (spread > 0) {
                    result = {mean: Math.min(mean, cap.mean), std: Math.min(spread, cap.std)};
                }
            }
        }
        this.spreadCache = result;
        return result;
    };

    // The vector of record r (a view of the attached data), or null.
    Index.prototype.vectorAt = function (r) {
        if (!this.vectors || r === undefined || r < 0 || this.vecRows[r] < 0) {
            return null;
        }
        var dims = this.vectors.dims;
        var start = this.vecRows[r] * dims;
        return this.vectors.data.subarray(start, start + dims);
    };

    /* The cosine of every record with a vector (-2 for records without
       one): {values, mean, std, count, total, squares} (mean and standard
       deviation of the values of the records with a vector, how many there
       are, and the sums of the values and of their squares). The last few
       answers are kept (by key, default: the vector itself), as facets and
       sorting search again with the same one. */
    Index.prototype.cosineStats = function (vector, key) {
        key = key || vector;
        var cache = this.cosCache || (this.cosCache = []);
        for (var c = 0; c < cache.length; c++) {
            if (cache[c].key === key) {
                var hit = cache[c];
                if (c > 0) {
                    // (The latest used first: the one used longest ago goes.)
                    cache.splice(c, 1);
                    cache.unshift(hit);
                }
                return hit;
            }
        }
        var n = this.n;
        var out = new Float32Array(n);
        var rows = this.vecRows;
        var data = this.vectors ? this.vectors.data : null;
        var dims = this.vectors ? this.vectors.dims : 0;
        var norms = this.norms;
        var scale = norms ? inverseLength(vector) : 1 / VECTOR_SCALE2;
        var total = 0;
        var squares = 0;
        var count = 0;
        for (var r = 0; r < n; r++) {
            var row = rows ? rows[r] : -1;
            if (row < 0 || vector.length !== dims) {
                out[r] = -2;
                continue;
            }
            var at = row * dims;
            var sum = 0;
            for (var d = 0; d < dims; d++) {
                sum += vector[d] * data[at + d];
            }
            sum *= norms ? scale * norms[row] : scale;
            out[r] = sum;
            total += sum;
            squares += sum * sum;
            count += 1;
        }
        var mean = count ? total / count : 0;
        var spread = count ? Math.sqrt(Math.max(0, squares / count - mean * mean)) : 0;
        var entry = {key: key, values: out, mean: mean, std: spread || 1, count: count,
                     total: total, squares: squares};
        cache.unshift(entry);
        // (A search by words and meaning may use a vector per word too, and
        // the albums page one per smart album and its words.)
        if (cache.length > 24) {
            cache.pop();
        }
        return entry;
    };

    /* The cosine a picture needs to count as like record origin, for
       similar: and the "More like this" strip: z SIMILAR_MIN_Z over the
       cosines of the other pictures (stats: cosineStats of its vector; its
       own cosine of 1 is left out, as it would raise their mean and
       deviation in a small set), and SIMILAR_MIN_SD above two pictures taken
       at random (pairSpread); when fewer than SIMILAR_FEW of the pictures
       wanted(r) allows are that close, the cosine of the SIMILAR_FEW-th
       closest of them, but at least SIMILAR_NEAR_SD above two pictures
       taken at random, and SIMILAR_MARGIN_SD below the closest one. With
       look vectors (copyCosine, LOOK_COPY), the copies of the picture are
       left out of all of this, as its own cosine is, and always pass the
       cut. (origin is -1 for an example picture.) */
    Index.prototype.similarCut = function (origin, stats, wanted) {
        var cos = stats.values;
        var copy = this.copyCosine || Infinity;
        var own = cos[origin] > -2 ? cos[origin] : 0;
        var count = stats.count - (cos[origin] > -2 ? 1 : 0);
        var total = stats.total - own;
        var squares = stats.squares - own * own;
        var r;
        if (copy < Infinity) {
            for (r = 0; r < this.n; r++) {
                if (r !== origin && cos[r] >= copy) {
                    total -= cos[r];
                    squares -= cos[r] * cos[r];
                    count -= 1;
                }
            }
        }
        var mean = count > 0 ? total / count : 0;
        var spread = count > 0 ? Math.sqrt(Math.max(0, squares / count - mean * mean)) : 0;
        var typical = this.pairSpread();
        var close = Math.min(copy, Math.max(typical.mean + SIMILAR_MIN_SD * typical.std,
                                            mean + SIMILAR_MIN_Z * spread));
        var closest = [];           // the SIMILAR_FEW best cosines, best first
        var near = 0;
        for (r = 0; r < this.n; r++) {
            var value = cos[r];
            if (r === origin || value <= -2 || value >= copy || !wanted(r)) {
                continue;
            }
            if (value >= close) {
                near += 1;
            }
            if (closest.length < SIMILAR_FEW || value > closest[closest.length - 1]) {
                var at = closest.length;
                while (at > 0 && closest[at - 1] < value) {
                    at -= 1;
                }
                closest.splice(at, 0, value);
                if (closest.length > SIMILAR_FEW) {
                    closest.pop();
                }
            }
        }
        if (near >= SIMILAR_FEW || !closest.length) {
            return close;
        }
        return Math.min(close, Math.max(typical.mean + SIMILAR_NEAR_SD * typical.std,
                                        closest[closest.length - 1],
                                        closest[0] - SIMILAR_MARGIN_SD * typical.std));
    };

    /* How meaning takes part in a search, or null (words only): {mode,
       vector, free (per clause: may be missed), similar (the similar:
       term), origin (its record), fallback (ids, when the picture has no
       vector)}. */
    Index.prototype.meaningPlan = function (parsed, opts, context) {
        var look = parsed.terms.filter(function (term) {
            return lookTerm(term) && term.active !== false;
        })[0];
        if (look || opts.lookVector) {
            return this.lookPlan(look, opts.lookVector, context);
        }
        var similar = parsed.terms.filter(function (term) {
            return similarTerm(term) && term.active !== false;
        })[0];
        if (similar) {
            var origin = this.position[similar.filter.value];
            var plan = {mode: "similar", similar: similar, origin: origin === undefined ? -1 : origin,
                        free: null, vector: null, fallback: null};
            if (origin === undefined) {
                context.warn("There is no picture " + similar.filter.value + " to find others " +
                             "like.");
                return plan;
            }
            plan.vector = this.vectorAt(origin);
            if (!plan.vector) {
                plan.fallback = this.similar(this.records[origin].i, SIMILAR_FALLBACK, opts);
            }
            return plan;
        }
        var mode = opts.meaning === "meaning" ? "meaning" : opts.meaning === "words" ? "words"
            : "hybrid";
        var vector = opts.vector;
        if (mode === "words" || !vector || !this.vecCount || vector.length !== this.vectors.dims) {
            return null;
        }
        var free = [];
        var count = 0;
        parsed.clauses.forEach(function (clause, c) {
            free[c] = freeClause(clause);
            count += free[c] ? 1 : 0;
        });
        if (!count) {
            return null;
        }
        var plan = {mode: mode, vector: vector, free: free, similar: null, lacking: null,
                    clauses: parsed.clauses, termVector: null, byKind: null};
        // (Per-term coverage: see MEANING_TERM_Z, and MEANING_TERM_RESCUE for
        // a small set.)
        if (mode === "hybrid" && count >= 2) {
            plan.lacking = [];
            var dims = this.vectors.dims;
            var given = opts.termVectors;
            plan.termVector = function (text) {
                var found = typeof given === "function" ? given(text)
                    : given && typeof given === "object" && hasOwn.call(given, text) ? given[text]
                        : null;
                return found && found.length === dims ? found : null;
            };
        }
        return plan;
    };

    /* What a free term of a search by words and meaning is (Per-term
       coverage): {text (what is embedded for it, see meaningTexts),
       relation (a word of RELATION_WORDS), name (name-like), unknown (no
       picture has its words), cut (the z its vector needs; Infinity for a
       name), stats (cosineStats of its vector, or null without one),
       matches (how many pictures have its words)}. Name-likeness is worked
       out from the words of the whole index (kept per term), not the
       matches of this search. */
    Index.prototype.termInfo = function (term, plan, context) {
        var text = termText(term);
        var vector = plan.termVector ? plan.termVector(text) : null;
        var info = {text: text, relation: term.kind === "word" && term.words.length === 1 &&
                    RELATION_WORDS[term.words[0]] === true, name: false, unknown: false,
                    cut: MEANING_TERM_Z, stats: vector ? this.cosineStats(vector, "t:" + text) : null};
        if (info.relation) {
            return info;
        }
        var cache = this.termCache || (this.termCache = Object.create(null));
        var published = Boolean(context && context.published &&
                                context.published[term.words.join(" ")]);
        var key = (vector ? "v" : "-") + (term.prefix ? "p" : "w") + (published ? "n" : "") +
            term.mask + ":" + term.words.join(" ");
        var known = cache[key];
        if (!known) {
            known = this.nameLike(term, info.stats, context);
            if (this.termCacheSize >= 500) {
                cache = this.termCache = Object.create(null);
                this.termCacheSize = 0;
            }
            cache[key] = known;
            this.termCacheSize = (this.termCacheSize || 0) + 1;
        }
        info.name = known.name;
        info.unknown = known.unknown;
        info.cut = known.name ? Infinity : known.cut;
        info.share = known.share;
        info.median = known.median;
        info.matches = known.matches;
        return info;
    };

    /* {name, unknown, cut, share, median, matches (how many pictures have
       its words)} of a free term (see NAME_SHARE
       and MEANING_TERM_Z): from the pictures its words match (not by the
       place words alone), how many have them in what they show (a name an
       export publishes, context.published, not by its tags: they are
       there because the person is in the picture, which its description
       does not know), and (with stats, its vector's cosineStats) how close
       its word matches are to its own meaning. unknown: no picture has its
       words. */
    Index.prototype.nameLike = function (term, stats, context) {
        var scores = this.termScores(term, context);
        var showing = context && context.published && context.published[term.words.join(" ")]
            ? NAME_SHOWN_FIELDS : SHOWN_FIELDS;
        var shown = new Uint8Array(this.n);
        // (Pictures with the words in more than the place words.)
        var beyond = new Uint8Array(this.n);
        var words = termWords(term);
        var unplaced = ALL_FIELDS & ~(1 << F_PLACE);
        var r;
        var k;
        if (term.words.length === 1) {
            for (var w = 0; w < words.length; w++) {
                var mask = w === 0 ? term.mask : term.mask & ~(1 << F_TEXT);
                var hits = this.wordHits(words[w], term.prefix && w === 0,
                                         (mask & showing) | (term.driveMask & showing));
                for (k = 0; k < hits.records.length; k++) {
                    shown[hits.records[k]] = 1;
                }
                hits = this.wordHits(words[w], term.prefix && w === 0,
                                     (mask & unplaced) | term.driveMask);
                for (k = 0; k < hits.records.length; k++) {
                    beyond[hits.records[k]] = 1;
                }
            }
        }
        var matchers = term.words.length > 1 ? this.matchers(term.words, term.prefix) : null;
        var matched = 0;
        var anywhere = 0;
        var seen = 0;
        var zs = [];
        for (r = 0; r < this.n; r++) {
            if (scores[r] < 0) {
                continue;
            }
            anywhere += 1;
            if (matchers ? this.phraseFields(r, matchers, unplaced & term.mask) === 0
                    : beyond[r] !== 1) {
                continue;
            }
            matched += 1;
            if (matchers ? this.phraseFields(r, matchers, showing & term.mask) !== 0
                    : shown[r] === 1) {
                seen += 1;
            }
            if (stats && stats.values[r] > -2) {
                zs.push((stats.values[r] - stats.mean) / stats.std);
            }
        }
        var out = {name: false, unknown: anywhere === 0, cut: MEANING_TERM_Z, matches: anywhere,
                   share: matched ? seen / matched : anywhere ? 0 : 1, median: null};
        if (zs.length) {
            zs.sort(function (a, b) {
                return a - b;
            });
            out.median = zs[Math.floor(zs.length / 2)];
            if (zs.length >= MEANING_TERM_SAMPLE) {
                out.cut = out.median < MEANING_TERM_Z
                    ? Math.max(MEANING_TERM_LOW, out.median)
                    : Math.max(MEANING_TERM_Z, out.median - MEANING_TERM_SPAN);
            }
        }
        var close = zs.length >= NAME_SAMPLE && out.median >= MEANING_TERM_Z;
        out.name = anywhere > 0 && ((out.share < NAME_SHARE && !close) ||
                                    (out.share < NAME_SHARE_Z && zs.length >= NAME_SAMPLE &&
                                     out.median < MEANING_WORDS_Z));
        return out;
    };

    /* Per-term coverage (see MEANING_TERM_Z): of the pictures without the
       words of some free clauses (missed; plan.lacking per clause), only
       those that cover each such clause by meaning stay -- by one of its
       terms that is not name-like, with a vector, at its cut; or, lacking
       one describable clause only, by the meaning of the whole query (z,
       stats: its cosineStats) when the pictures with every free word say
       how close that is (MEANING_TERM_FULL, MEANING_TERM_MARGIN_Z). A term
       without a vector (none was given) or with words no picture has does
       as before: the meaning of the whole query decides. A clause of
       relation words needs no covering. In a small set a picture close
       enough to the whole query stays without covering its clauses
       (MEANING_TERM_RESCUE), unless it lacks a name NAME_SAMPLE or more
       pictures have (and fewer than NAME_SHARE of them in what they
       show); rescued gets {rows, items} for each clause such
       pictures lack (the items of terms flip to name false when one of
       its rows is shown: see Index.search). Returns [{text, name,
       relation, meaning, unknown}] for the free terms (meaning: it has a
       vector). */
    Index.prototype.termCoverage = function (plan, alive, missed, context, stats, rescued) {
        var self = this;
        var entries = [];
        var listed = [];
        var r;
        plan.clauses.forEach(function (clause, c) {
            if (!plan.free[c] || !plan.lacking[c]) {
                return;
            }
            var infos = clause.terms.filter(freeTerm).map(function (term) {
                return self.termInfo(term, plan, context);
            });
            var entry = {lacking: plan.lacking[c], infos: infos, listed: [], rows: [],
                         exempt: infos.some(function (info) {
                             return info.relation || (!info.name && (info.unknown ||
                                                                     !info.stats));
                         })};
            // (Names only, each on NAME_SAMPLE or more pictures and in what
            // fewer than NAME_SHARE of them show: never rescued, see
            // MEANING_TERM_RESCUE.)
            entry.strict = !entry.exempt && infos.length > 0 && infos.every(function (info) {
                return info.name && info.matches >= NAME_SAMPLE && info.share < NAME_SHARE;
            });
            entries.push(entry);
            infos.forEach(function (info) {
                var item = {text: info.text, name: info.name, relation: info.relation,
                            meaning: info.stats !== null, unknown: info.unknown};
                listed.push(item);
                entry.listed.push(item);
            });
        });
        function zOf(r) {
            var cos = stats.values[r];
            return cos > -2 ? (cos - stats.mean) / stats.std : -Infinity;
        }
        // How close to the whole query the pictures with every free word are
        // (not those taken at a kind of place without its words: byKind).
        var full = [];
        for (r = 0; r < this.n; r++) {
            if (alive[r] && !missed[r] && !(plan.byKind && plan.byKind[r]) &&
                    stats.values[r] > -2) {
                full.push(zOf(r));
            }
        }
        full.sort(function (a, b) {
            return a - b;
        });
        var near = full.length >= MEANING_TERM_FULL
            ? full[Math.floor(full.length / 2)] - MEANING_TERM_MARGIN_Z : Infinity;
        // 2: covered; 1: describable, but not by its own meaning; 0: a name.
        function covers(entry, r) {
            if (entry.exempt) {
                return 2;
            }
            var found = 0;
            for (var k = 0; k < entry.infos.length; k++) {
                var info = entry.infos[k];
                if (info.name) {
                    continue;
                }
                var cos = info.stats.values[r];
                if (cos > -2 && (cos - info.stats.mean) / info.stats.std >= info.cut) {
                    return 2;
                }
                found = 1;
            }
            return found;
        }
        // (A small set: close enough to the whole query, see MEANING_TERM_RESCUE.)
        var rescue = meaningCuts(stats.count).rescue;
        var e;
        function rescues(r) {
            if (zOf(r) < rescue) {
                return false;
            }
            for (var k = 0; k < entries.length; k++) {
                if (entries[k].lacking[r] === 1 && entries[k].strict) {
                    return false;
                }
            }
            return true;
        }
        for (r = 0; r < this.n; r++) {
            if (!alive[r] || !missed[r]) {
                continue;
            }
            if (rescues(r)) {
                for (e = 0; e < entries.length; e++) {
                    if (entries[e].lacking[r] === 1 && !entries[e].exempt) {
                        entries[e].rows.push(r);
                    }
                }
                continue;
            }
            var lacks = 0;
            var maybe = false;
            for (e = 0; e < entries.length && alive[r]; e++) {
                if (entries[e].lacking[r] === 1 && !entries[e].exempt) {
                    lacks += 1;
                    var level = covers(entries[e], r);
                    if (level === 0) {
                        alive[r] = 0;
                    } else if (level === 1) {
                        maybe = true;
                    }
                }
            }
            // (By the whole query: when one describable clause is all it lacks.)
            if (alive[r] && maybe && (lacks > 1 || zOf(r) < near)) {
                alive[r] = 0;
            }
        }
        entries.forEach(function (entry) {
            if (entry.rows.length && rescued) {
                rescued.push({rows: entry.rows, items: entry.listed});
            }
        });
        return listed;
    };

    /* The plan of a look: term (look:<id>), or of an example picture's look
       vector: {mode "look", similar (the term, if any), origin (its record,
       or -1), view (lookView), vector (null when there is none to go by)}. */
    Index.prototype.lookPlan = function (term, example, context) {
        var view = this.lookView();
        var plan = {mode: "look", similar: term || null, origin: -1, free: null, vector: null,
                    fallback: null, view: view};
        if (term) {
            var origin = this.position[term.filter.value];
            if (origin === undefined) {
                context.warn("There is no picture " + term.filter.value + " to find others " +
                             "like.");
                return plan;
            }
            plan.origin = origin;
            plan.vector = view.vectorAt(origin);
            if (!plan.vector && view.vectors) {
                // (Nothing is said while no look vectors are attached: a page
                // that is still loading them searches again once they come.)
                context.warn("This picture has no look vector yet, so no others are found " +
                             "by its looks.");
            }
            return plan;
        }
        if (view.vectors && example && example.length === view.vectors.dims) {
            plan.vector = example;
        } else if (view.vectors) {
            context.warn("The example picture cannot be compared with these pictures' looks.");
        }
        return plan;
    };

    /* True when the median z of the word matches (those with a vector) is
       below MEANING_WORDS_Z: what the words found is not what the model
       makes of the query, so meaning has nothing to add (see there). The
       pictures taken at a kind of place the query names that lack its
       words (byKind) are not what the words found: the many pictures
       taken at hotels that show the view or the breakfast would hold
       "hotels" down. */
    Index.prototype.wordsUnlikeQuery = function (alive, missed, stats, byKind) {
        var cos = stats.values;
        var zs = [];
        for (var r = 0; r < this.n; r++) {
            if (alive[r] && !missed[r] && !(byKind && byKind[r]) && cos[r] > -2) {
                zs.push((cos[r] - stats.mean) / stats.std);
            }
        }
        if (!zs.length) {
            return false;
        }
        zs.sort(function (a, b) {
            return a - b;
        });
        return zs[Math.floor(zs.length / 2)] < MEANING_WORDS_Z;
    };

    /* Meaning's part of a search (see the notes at the top): changes alive
       and score in place; returns {mode, best, only (ids found by meaning
       alone, closest first)}, or null when meaning had nothing to add (the
       word matches as without it, see MEANING_WORDS_Z). missed marks the
       pictures without the free words. With two or more free clauses, the
       answer's terms say how each free term was searched, and its rescued
       which pictures were kept without covering each term (termCoverage). */
    Index.prototype.applyMeaning = function (plan, alive, score, missed, context) {
        var n = this.n;
        var r;
        var only = [];
        if (plan.mode === "look") {
            return this.applyLook(plan, alive, score);
        }
        if (plan.mode === "similar" && !plan.vector) {
            var place = Object.create(null);
            (plan.fallback || []).forEach(function (id, k) {
                place[String(id)] = k;
            });
            var count = (plan.fallback || []).length;
            for (r = 0; r < n; r++) {
                if (!alive[r]) {
                    continue;
                }
                var at = place[String(this.records[r].i)];
                if (r === plan.origin) {
                    score[r] = count + 1;
                } else if (at !== undefined) {
                    score[r] = count - at;
                } else {
                    alive[r] = 0;
                }
            }
            return {mode: "similar", best: null, only: only};
        }
        var stats = this.cosineStats(plan.vector,
                                     plan.mode === "similar" ? "r" + plan.origin : null);
        var cos = stats.values;
        // The cosine that is z standard deviations above the mean.
        function atZ(z) {
            return stats.mean + z * stats.std;
        }
        var best = -1;
        var wordBest = 0;
        for (r = 0; r < n; r++) {
            if (alive[r]) {
                if (cos[r] > best) {
                    best = cos[r];
                }
                if (missed && !missed[r] && score[r] > wordBest) {
                    wordBest = score[r];
                }
            }
        }
        if (plan.mode === "similar") {
            // The picture first, then the other pictures of its duplicate
            // stack, which take no part in judging what is close (as in
            // similar()'s strip): a near twin would set "closest" and its
            // margin would leave out everything else.
            var groupOf = this.groupOf;
            var stack = plan.origin >= 0 ? groupOf[plan.origin] : -1;
            var close = this.similarCut(plan.origin, stats, function (row) {
                return alive[row] && (stack < 0 || groupOf[row] !== stack);
            });
            for (r = 0; r < n; r++) {
                if (alive[r]) {
                    if (r === plan.origin) {
                        score[r] = 4;
                    } else if (stack >= 0 && groupOf[r] === stack) {
                        score[r] = 2 + Math.max(cos[r], 0);
                    } else if (cos[r] > -2 && cos[r] >= close) {
                        score[r] = cos[r];
                    } else {
                        alive[r] = 0;
                    }
                }
            }
            return {mode: "similar", best: best, only: only};
        }
        // A small set: the closest few when nothing else is close (see
        // MEANING_FEW_Z), of the pictures wanted(r) allows; else Infinity
        // (always once the few-cut is as high as the usual cut). A search
        // of one free clause has the one-clause cut (MEANING_FEW_GROWTH_ONE).
        var cuts = meaningCuts(stats.count);
        var clauses = plan.free.filter(Boolean).length;
        var least = clauses >= 2 ? cuts.few : cuts.one;
        function fewCut(wanted) {
            if (least >= MEANING_MIN_Z) {
                return Infinity;
            }
            var closest = [];
            for (var row = 0; row < n; row++) {
                if (wanted(row) && cos[row] > -2) {
                    closest.push(cos[row]);
                }
            }
            closest.sort(function (a, b) {
                return b - a;
            });
            if (!closest.length || closest[0] < atZ(least)) {
                return Infinity;
            }
            return Math.max(closest[0] - MEANING_FEW_MARGIN_Z * stats.std,
                            closest[Math.min(closest.length, MEANING_FEW) - 1]);
        }
        if (plan.mode === "meaning") {
            var lowest = Math.max(best - MEANING_ONLY_MARGIN_Z * stats.std,
                                  atZ(MEANING_ONLY_Z));
            // The closest few when nothing reaches MEANING_MIN_Z; and, as by
            // words and meaning, of the pictures without the words when none
            // of them does: this wider net never shows less.
            var reach = atZ(MEANING_MIN_Z);
            if (best < reach) {
                lowest = Math.min(lowest, fewCut(function (row) {
                    return alive[row];
                }));
            }
            var without = false;
            for (r = 0; r < n && missed && !without; r++) {
                without = Boolean(alive[r] && missed[r] && cos[r] >= reach);
            }
            if (missed && !without) {
                lowest = Math.min(lowest, fewCut(function (row) {
                    return alive[row] && missed[row];
                }));
            }
            for (r = 0; r < n; r++) {
                if (alive[r]) {
                    if (cos[r] >= lowest) {
                        score[r] = cos[r];
                    } else {
                        alive[r] = 0;
                    }
                }
            }
            return {mode: "meaning", best: best, only: only};
        }
        var free = 0;
        plan.free.forEach(function (isFree) {
            free += isFree ? 1 : 0;
        });
        if (free <= MEANING_NAME_WORDS && this.wordsUnlikeQuery(alive, missed, stats,
                                                                plan.byKind)) {
            for (r = 0; r < n; r++) {
                if (alive[r] && missed[r]) {
                    alive[r] = 0;
                }
            }
            return null;
        }
        // (After best: the ranking of the word matches stays as it was.)
        var rescued = [];
        var terms = plan.lacking ? this.termCoverage(plan, alive, missed, context || {}, stats,
                                                     rescued)
            : [];
        var floor = atZ(MEANING_FLOOR_Z);
        var span = best - floor;
        var enough = Math.max(best - MEANING_MARGIN_Z * stats.std, atZ(MEANING_MIN_Z));
        var reached = false;
        for (r = 0; r < n && !reached; r++) {
            reached = Boolean(alive[r] && missed[r] && cos[r] >= enough);
        }
        if (!reached) {
            enough = Math.max(best - MEANING_MARGIN_Z * stats.std, fewCut(function (row) {
                return alive[row] && missed[row];
            }));
        }
        // Word scores are divided by the best one, or by what strong matches
        // of every free word would score when even the best is weak.
        var wordScale = Math.max(wordBest, WORD_STRONG * free);
        var extra = [];
        for (r = 0; r < n; r++) {
            if (!alive[r]) {
                continue;
            }
            // How far the cosine is above the floor (1 at the best); below
            // it, as far as -1, it counts against a word match (the words
            // are there, but the picture is about something else). Pictures
            // without a vector are neither helped nor harmed.
            var rel = span > 0 && cos[r] > -2 ? Math.max(-1, Math.min(1, (cos[r] - floor) / span))
                : 0;
            if (!missed[r]) {
                // (Shifted by one weight: sorting needs scores of 0 or more.)
                score[r] = score[r] / wordScale + MEANING_WEIGHT * (1 + rel);
            } else if (cos[r] >= enough) {
                // At most one weight: below every word match whose meaning
                // is at least at the floor.
                score[r] = MEANING_WEIGHT * rel;
                extra.push(r);
            } else {
                alive[r] = 0;
            }
        }
        // Only the closest MEANING_EXTRA of the pictures found by meaning alone.
        extra.sort(function (a, b) {
            return cos[b] - cos[a] || a - b;
        });
        for (var k = 0; k < extra.length; k++) {
            if (k < MEANING_EXTRA) {
                only.push(this.records[extra[k]].i);
            } else {
                alive[extra[k]] = 0;
            }
        }
        return {mode: "hybrid", best: best, only: only, terms: terms, rescued: rescued};
    };

    /* Looks' part of a search (lookPlan): only the pictures that look like the
       origin (or the example) stay, scored by their cosine: the origin first,
       then its copies (LOOK_COPY) and the other pictures of its duplicate
       stack (for an example picture: of the stack of its closest copy in
       the index, if it has one), none of which count when judging what is
       close (similarCut), then the others. */
    Index.prototype.applyLook = function (plan, alive, score) {
        var n = this.n;
        var r;
        if (!plan.vector) {
            for (r = 0; r < n; r++) {
                if (alive[r]) {
                    if (r === plan.origin) {
                        score[r] = 4;
                    } else {
                        alive[r] = 0;
                    }
                }
            }
            return {mode: "look", best: null, only: []};
        }
        var view = plan.view;
        var stats = view.cosineStats(plan.vector, plan.origin >= 0 ? "r" + plan.origin : null);
        var cos = stats.values;
        var best = -1;
        var bestRow = -1;
        for (r = 0; r < n; r++) {
            if (alive[r] && r !== plan.origin && cos[r] > best) {
                best = cos[r];
                bestRow = r;
            }
        }
        var groupOf = this.groupOf;
        var stack = plan.origin >= 0 ? groupOf[plan.origin]
            : bestRow >= 0 && best >= LOOK_COPY ? groupOf[bestRow] : -1;
        var close = view.similarCut(plan.origin, stats, function (row) {
            return alive[row] && (stack < 0 || groupOf[row] !== stack);
        });
        for (r = 0; r < n; r++) {
            if (alive[r]) {
                if (r === plan.origin) {
                    score[r] = 4;
                } else if (cos[r] >= LOOK_COPY || (stack >= 0 && groupOf[r] === stack)) {
                    score[r] = 2 + Math.max(cos[r], 0);
                } else if (cos[r] > -2 && cos[r] >= close) {
                    score[r] = cos[r];
                } else {
                    alive[r] = 0;
                }
            }
        }
        return {mode: "look", best: best, only: []};
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
        var scores = new Float64Array(this.n);
        var candidates = [];
        var byLook = opts.by === "look";
        var source = byLook ? this.lookView() : this;
        var vector = source.vectorAt(origin);
        if (vector) {
            // By meaning (or by look): the cosine of the two pictures' vectors.
            var stats = source.cosineStats(vector, "r" + origin);
            var cosines = stats.values;
            var close = source.similarCut(origin, stats, function (row) {
                return !taken[row] && visible[row];
            });
            for (r = 0; r < this.n; r++) {
                if (!taken[r] && visible[r] && cosines[r] >= close) {
                    scores[r] = cosines[r];
                    candidates.push(r);
                }
            }
        } else if (!byLook) {
            var shared = new Int32Array(this.n);
            var own = data.sets[origin];
            for (var k = 0; k < own.length; k++) {
                var posting = data.postings[own[k]];
                for (var p = 0; p < posting.length; p++) {
                    shared[posting[p]] += 1;
                }
            }
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

    /* Did you mean: a word that is itself a word of the language is meant
       as typed, and never corrected to another one ("cold" is not "old",
       "words" not "woods"). The words of the language are a Bloom filter
       ({size, hashes, data}: static/english-words.js, ENGLISH_WORDS, made
       by english_words.py from about 21,000 words of everyday English and
       common names; any page that loads it has it), or a list given to
       SearchCore.setWords. A correction is one edit (two for a word of
       SUGGEST_TWO letters or more), and never changes, adds or drops the
       first letter of a word of SUGGEST_SHORT letters or fewer, nor of any
       word in two edits ("Maplebrook" is not "Tablebrook"), except to swap
       it with the second ("ogld" is "gold"). When the closest word would
       change it, there is no suggestion: the next closest that keeps it was
       right for under a third of the typos that came to it ("ome" is "home"
       misspelled, not "one"). Measured on a library of thousands of
       pictures and on a published one of 63: of 30 misspellings each, as
       many were put right as before (29); of 30 real words each that no
       picture has, 4 and none got a suggestion, against 20 and 19 before;
       of 10 names of places, 4 and none, against 5 and 5; of every one-edit
       typo of their most used tag words, 3.5% and 1.4% got a wrong word,
       against 4.5% and 2.2% before. The price: 2.5 and 5 points fewer of
       those typos got the right word (93.0% and 92.7%, against 95.5% and
       97.7%) -- they got none instead.
       The list has names and abbreviations too, so "blu" or "san" gets no
       suggestion either; checking only words of four letters or more would
       correct them, but also 23 more of 100 real short words the set of 63
       lacks ("bat" to "boat", "pie" to "pine"). */
    var SUGGEST_SHORT = 4;
    var SUGGEST_TWO = 6;
    var WORDS_ALPHABET = "0123456789bcdfghjklmnpqrstvwxz-_";
    var languageWords;              // undefined: ENGLISH_WORDS, if a page loaded it
    var languageSet = null;         // a list's words as a set, made when first needed

    function setWords(words) {
        languageWords = words === undefined ? null : words;
        languageSet = null;
    }

    // FNV-1a of a word of letters a to z, from seed (english_words.py's _fnv).
    function wordHash(word, seed) {
        var value = seed;
        for (var k = 0; k < word.length; k++) {
            value = Math.imul(value ^ word.charCodeAt(k), 16777619) >>> 0;
        }
        return value;
    }

    // True when a word passes a Bloom filter (english_words.py's contains).
    function inWordFilter(filter, word) {
        if (!/^[a-z]+$/.test(word)) {
            return false;
        }
        var first = wordHash(word, 2166136261);
        var step = (wordHash(word, 1540483477) | 1) >>> 0;
        for (var k = 0; k < filter.hashes; k++) {
            var bit = (first + k * step) % filter.size;
            var value = WORDS_ALPHABET.indexOf(filter.data.charAt(Math.floor(bit / 5)));
            if (value < 0 || !((value >> (bit % 5)) & 1)) {
                return false;
            }
        }
        return true;
    }

    // The words of the language as given (setWords, else ENGLISH_WORDS), or null.
    function languageList() {
        if (languageWords === undefined) {
            languageWords = typeof ENGLISH_WORDS !== "undefined" ? ENGLISH_WORDS : null;
        }
        return languageWords || null;
    }

    // True when a normalized word (or its singular) is a word of the language.
    function languageWord(word) {
        var words = languageList();
        if (!words) {
            return false;
        }
        var filter = typeof words === "object" && !Array.isArray(words) &&
            words.size > 0 && words.hashes > 0 && typeof words.data === "string";
        if (!filter && languageSet === null) {
            languageSet = Object.create(null);
            (Array.isArray(words) ? words : String(words).split(/\s+/)).forEach(function (entry) {
                if (entry) {
                    languageSet[String(entry).toLowerCase()] = true;
                }
            });
        }
        var forms = wordForms(word);
        for (var k = 0; k < forms.length; k++) {
            if (filter ? inWordFilter(words, forms[k]) : languageSet[forms[k]] === true) {
                return true;
            }
        }
        return false;
    }

    // The most likely word meant by a word that matches nothing, or null.
    Index.prototype.closestWord = function (word) {
        var limit = word.length >= SUGGEST_TWO ? 2 : 1;
        var keepFirst = word.length <= SUGGEST_SHORT;
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
        // The closest word decides. When it would change the first letter
        // of a short word, or of a word two edits away, nothing is offered:
        // the next closest one that keeps it is seldom what was meant.
        // (A swap of the first two letters keeps it: "ogld" is "gold".)
        if (best && (keepFirst || bestDistance > 1) && best.charAt(0) !== word.charAt(0) &&
                !(best.charAt(0) === word.charAt(1) && best.charAt(1) === word.charAt(0))) {
            return null;
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
            if (word.length < 3 || /\d/.test(word) || self.knowsWord(word, term.prefix) ||
                    languageWord(word)) {
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
        // By the words alone: the meaning vector is the typed query's, so
        // meaning would find its pictures whatever the corrected words are.
        check.meaning = "words";
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
                    (fieldBit && !((term.mask | term.driveMask) & fieldBit))) {
                return;
            }
            if (term.words.length === 1) {
                // One word: also its synonyms, each on its own.
                termWords(term).forEach(function (word, index) {
                    lists.push([new TextMatcher(word, term.prefix && index === 0)]);
                });
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
        {example: "anna in lisbon last summer", plain: true,
         meaning: "plain language: the " +
            "names of people and places, kinds of place (beaches, museums), years, months and " +
            "seasons become filters (shown as chips over the results; \u00d7 searches that " +
            "part as typed)"},
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
        {example: "date:2019-06..2019-08", meaning: "taken in these months (date:2019-05, " +
            "date:2019.. from 2019 on, date:..2018 until 2018)"},
        {example: "before:2019-06", meaning: "taken before June 2019 (after: too; " +
            "YYYY, YYYY-MM or YYYY-MM-DD)"},
        {example: "on:today", meaning: "taken on this day in earlier years (on:05-14: " +
            "that day in any year)"},
        {example: "place:portugal", meaning: "taken in a town, region or country, or at a " +
            "named place of the street maps (place:\"city zoo\"; pictures with a GPS " +
            "position, or an estimated place: is:place-estimated)"},
        {example: "kind:beach", meaning: "taken at a kind of place: the kind of its named " +
            "place on the street maps (kind:museums, kind:zoo, kind:airport, kind:\"golf " +
            "course\")"},
        {example: "has:text", meaning: "with text, a location (has:gps), people, animals, ..."},
        {example: "is:360", meaning: "360\u00b0 photos and videos; also is:video, is:drive, " +
            "is:duplicate, is:undescribed, is:edited, is:hidden, is:gps-ignored"},
        {example: "is:favorite", meaning: "the favorites (the pictures marked with a star)"},
        {example: "rating:>=4", meaning: "rated 4 or 5 stars (rating:5 exactly; rating:0 " +
            "not rated)"},
        {example: "album:\"Summer\"", meaning: "the pictures of an album (see Albums)"},
        {example: "person:\"Anna\"", meaning: "the pictures of a person (see People; " +
            "person:any, person:none)"},
        {example: "lib:name", meaning: "only pictures of one library"}
    ];

    return {
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
        setWords: setWords,
        isWord: function (word) {
            return languageWord(normalize(word));
        },
        interpret: function (records, query, options) {
            return indexOf(records).interpret(query, options);
        },
        highlights: highlights,
        facetLabel: facetLabel,
        placeLabel: placeLabel,
        placeParent: placeParent,
        placeOf: function (rec) {
            var values = rec && typeof rec === "object" ? placeValues(rec) : [];
            return values.length ? values[values.length - 1] : "";
        },
        // The kinds of place kind: knows (PLACE_KIND_LIST): [{key, label,
        // words, kinds}], copies.
        placeKinds: function () {
            return PLACE_KINDS.list.map(function (entry) {
                return {key: entry.key, label: entry.label, words: entry.words.slice(),
                        kinds: entry.kinds.slice()};
            });
        },
        // True when a query (text or parsed) finds pictures taken at a named
        // place of kind nk by a kind: term (not a -kind: one): what the
        // viewer marks as a match.
        kindMatches: function (query, nk) {
            if (!isText(nk)) {
                return false;
            }
            return asQuery(query).terms.some(function (term) {
                return kindTerm(term) && term.active !== false &&
                    term.filter.kinds.indexOf(nk) >= 0;
            });
        },
        // The search for the pictures taken at a named place (a record's np):
        // place:"its words".
        namedPlaceQuery: function (name) {
            var words = tokens(name);
            return words.length ? "place:\"" + words.join(" ") + "\"" : "";
        },
        dateLabel: dateLabel,
        rangeLabel: rangeLabel,
        findAlbum: findAlbum,
        albumTerm: albumTerm,
        findPerson: findPerson,
        personTerm: personTerm,
        timelineChoice: timelineChoice,
        PLACE_SEPARATOR: PLACE_SEPARATOR,
        meaningText: meaningText,
        meaningTexts: meaningTexts,
        MEANING_TEXTS: MEANING_TEXTS,
        meaningCuts: meaningCuts,
        decodeVectors: decodeVectors,
        joinVectors: joinVectors,
        queryVector: queryVector,
        areas: {
            read: readArea,
            encode: encodeArea,
            has: areaHas,
            label: areaLabel,
            name: areaName,
            bounds: areaBounds,
            metres: metresLabel,
            simplify: simplifyLine,
            trackPositions: trackPositions,
            worldY: worldY,
            latitudeOf: latitudeOf,
            worldScale: worldScale,
            MAX_TEXT: AREA_MAX_TEXT,
            MAX_POINTS: AREA_MAX_POINTS,
            MAX_METRES: AREA_MAX_METRES,
            NAME_LENGTH: AREA_NAME_LENGTH
        }
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = SearchCore;
}
