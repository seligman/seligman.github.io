/* EMBED: the query model of search by meaning in an export (its "meaning"
   option, see browser_model.py), run in the page: data/meaning/model.js
   (SEARCH_EMBED.model) and w-NNN.js (SEARCH_EMBED.part). site.js loads it.

     EMBED.load(meaning, {url, load, progress, wasm}) -> Promise of an engine:
       the parts one at a time (load(url) adds a <script>; each is tried
       again once, after two seconds), decoded straight into its memory and
       checked (the CRC-32 of each, model.sums)
     engine.query(text) -> Int8Array as the server stores vectors;
       engine.document(text) -> Float32Array; engine.check() -> lowest cosine
       of the probe texts with the server's; engine.backend "wasm-simd" | "js"

   llama.cpp's numbers on a CPU: Q8_0 matrices, each product's input in Q8_0
   blocks (exact int8 dot products, then f32 sums), GELU from its half
   precision table, then the Dense head. embed-kernel.js (WebAssembly SIMD)
   or plain JavaScript do the same operations in the same order: the same
   bits either way. Loads under Node too. */
var SEARCH_EMBED = {
    receiver: null,         // (EMBED.load, while it loads)
    model: function (model) {
        if (SEARCH_EMBED.receiver) {
            SEARCH_EMBED.receiver.model(model);
        }
    },
    part: function (number, text) {
        if (SEARCH_EMBED.receiver) {
            SEARCH_EMBED.receiver.part(number, text);
        }
    }
};

var EMBED = (function () {
    "use strict";

    var root = typeof window !== "undefined" ? window : {};
    var fround = Math.fround;
    var exp = Math.exp;
    var sqrt = Math.sqrt;
    var QK = 32;

    /* ---------- Words and tokens (llama.cpp's WordPiece tokenizer) ------- */

    var CONTROL, MARK, PUNCT, SYMBOL;
    var missing = "";
    try {
        // (Here: without them only search by meaning is lost.)
        CONTROL = new RegExp("[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}]", "u");
        MARK = new RegExp("\\p{M}", "u");
        PUNCT = new RegExp("\\p{P}", "u");
        SYMBOL = new RegExp("\\p{S}", "u");
    } catch (error) {
        missing = "this browser cannot tell kinds of characters apart";
    }
    if (!missing && (!String.prototype.normalize || !String.fromCodePoint || !fround ||
                     typeof Int8Array === "undefined" || typeof Promise === "undefined")) {
        missing = "this browser is too old";
    }
    var SPACE = /[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

    function cjk(c) {
        return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
            (c >= 0x20000 && c <= 0x2A6DF) || (c >= 0x2A700 && c <= 0x2B81F) ||
            (c >= 0x2B920 && c <= 0x2CEAF) || (c >= 0xF900 && c <= 0xFAFF) ||
            (c >= 0x2F800 && c <= 0x2FA1F);
    }

    // The words as llama.cpp splits them: accents dropped, lower case, each
    // punctuation mark, ASCII symbol and CJK character apart.
    function words(text, config) {
        var list = [];
        var word = "";
        var strip = config.strip_accents !== false;
        for (var at = 0; at < text.length; at++) {
            var c = text.codePointAt(at);
            if (c > 0xFFFF) {
                at += 1;
            }
            if (strip && c >= 0xC0) {
                c = String.fromCodePoint(c).normalize("NFD").codePointAt(0);
            }
            var ch = String.fromCodePoint(c);
            var space = SPACE.test(ch);
            var alone = PUNCT.test(ch) || (c < 0x7F && SYMBOL.test(ch)) || cjk(c);
            if ((space || alone) && word) {
                list.push(word);
                word = "";
            }
            if (space || c === 0 || c === 0xFFFD || c < 32 || (c >= 0x7F && CONTROL.test(ch)) ||
                    (strip && c >= 0x300 && MARK.test(ch))) {
                continue;
            }
            if (config.lowercase !== false) {
                ch = String.fromCodePoint(ch.toLowerCase().codePointAt(0));
            }
            if (alone) {
                list.push(ch);
            } else {
                word += ch;
            }
        }
        if (word) {
            list.push(word);
        }
        return list;
    }

    // The text split at the special tokens' own texts (model.special,
    // longest first, as llama.cpp's server): [text or token id, ...].
    function partition(text, special) {
        var list = [text];
        special.forEach(function (item) {
            var next = [];
            list.forEach(function (part) {
                if (typeof part !== "string") {
                    next.push(part);
                    return;
                }
                part.split(item[0]).forEach(function (piece, k) {
                    if (k) {
                        next.push(item[1]);
                    }
                    if (piece) {
                        next.push(piece);
                    }
                });
            });
            list = next;
        });
        return list;
    }

    // tokenize(text) -> [CLS] longest pieces [SEP] (max_tokens); a word no
    // pieces make is [UNK]; "[MASK]" and such are their tokens.
    function tokenizer(model) {
        var config = model.config;
        var vocab = Object.create(null);
        var longest = 1;
        model.vocab.forEach(function (piece, id) {
            piece = String(piece);
            vocab[piece] = id;                  // (the last one wins, as in llama.cpp)
            longest = Math.max(longest, Array.from(piece.replace(/^##/, "")).length);
        });
        var special = (model.special || []).filter(function (item) {
            return Array.isArray(item) && typeof item[0] === "string" && item[0] &&
                typeof item[1] === "number";
        });
        var room = (config.max_tokens || 128) - 1;
        return function (text) {
            var ids = [config.cls];
            var list = [];
            partition(String(text || ""), special).forEach(function (part) {
                list.push.apply(list, typeof part === "number" ? [part] : words(part, config));
            });
            for (var w = 0; w < list.length && ids.length < room; w++) {
                if (typeof list[w] === "number") {
                    ids.push(list[w]);
                    continue;
                }
                var chars = Array.from(list[w]);
                var pieces = [];
                for (var start = 0, end; start < chars.length; start = end) {
                    var found;
                    for (end = Math.min(chars.length, start + longest); end > start; end--) {
                        found = vocab[(start ? "##" : "") + chars.slice(start, end).join("")];
                        if (found !== undefined) {
                            break;
                        }
                    }
                    if (end === start) {
                        pieces = [config.unk];
                        break;
                    }
                    pieces.push(found);
                }
                ids.push.apply(ids, pieces);
            }
            ids.length = Math.min(ids.length, room);
            ids.push(config.sep);
            return ids;
        };
    }

    /* ---------- Numbers -------------------------------------------------------- */

    var f32 = new Float32Array(1);
    var u32 = new Uint32Array(f32.buffer);

    function halfToFloat(h) {
        var e = (h >> 10) & 0x1F;
        var m = h & 0x3FF;
        var v = e === 0 ? m * 5.960464477539063e-8 : e === 31 ? (m ? NaN : Infinity)
            : (1 + m / 1024) * Math.pow(2, e - 15);
        return h & 0x8000 ? -v : v;
    }

    // The bits of the half-precision number nearest to v (ties to even).
    function floatToHalf(v) {
        f32[0] = v;
        var x = u32[0];
        var sign = (x >>> 16) & 0x8000;
        var e = ((x >>> 23) & 0xFF) - 112;
        var m = x & 0x7FFFFF;
        if (e >= 31) {
            return sign | 0x7C00 | (e === 143 && m ? 0x200 : 0);
        }
        var shift = 13;
        var base = sign | (e << 10);
        if (e <= 0) {
            if (e < -10) {
                return sign;
            }
            shift = 14 - e;
            m |= 0x800000;
            base = sign;
        }
        var bits = base + (m >>> shift);
        var rest = m - ((m >>> shift) << shift);
        var half = 1 << (shift - 1);
        return bits + (rest > half || (rest === half && (bits & 1)) ? 1 : 0);
    }

    // llama.cpp's GELU (the tanh form), looked up by the half-precision input.
    var geluTable = null;

    function gelu(x, n) {
        if (!geluTable) {
            geluTable = new Float32Array(65536);
            for (var h = 0; h < 65536; h++) {
                var v = halfToFloat(h);
                geluTable[h] = halfToFloat(floatToHalf(fround(0.5 * v * fround(1 + Math.tanh(
                    fround(0.7978845608028654 * v * fround(1 + 0.044715 * v * v)))))));
            }
        }
        for (var i = 0; i < n; i++) {
            var value = x[i];
            x[i] = value <= -10 ? 0 : value >= 10 ? value : geluTable[floatToHalf(value)];
        }
    }

    // Round half to even (Python's round; the CPU's conversions).
    function rint(v) {
        var r = Math.round(v);
        return r - v === 0.5 && (r & 1) ? r - 1 : r;
    }

    function norm(values) {
        var sum = 0;
        for (var k = 0; k < values.length; k++) {
            sum += values[k] * values[k];
        }
        return sqrt(sum);
    }

    // A vector as the server stores it: unit length, times 127, rounded.
    function quantize(values) {
        var length = norm(values);
        var out = new Int8Array(values.length);
        for (var k = 0; k < values.length && length > 0; k++) {
            out[k] = Math.max(-127, Math.min(127, rint(values[k] / length * 127)));
        }
        return out;
    }

    function decodeInto(text, bytes, at) {
        if (bytes.setFromBase64) {
            return bytes.subarray(at).setFromBase64(text).written;
        }
        var binary = atob(text);
        for (var k = 0; k < binary.length; k++) {
            bytes[at + k] = binary.charCodeAt(k);
        }
        return binary.length;
    }

    var crcTable = null;

    // The CRC-32 of some bytes (zlib's): a damaged part of the model tells.
    function crc32(bytes) {
        if (!crcTable) {
            crcTable = new Int32Array(256);
            for (var n = 0; n < 256; n++) {
                var c = n;
                for (var k = 0; k < 8; k++) {
                    c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
                }
                crcTable[n] = c;
            }
        }
        var crc = -1;
        for (var i = 0; i < bytes.length; i++) {
            crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ -1) >>> 0;
    }

    function decode(text) {
        var bytes = new Uint8Array(Math.floor(text.length * 3 / 4) + 3);
        return bytes.subarray(0, decodeInto(text, bytes, 0));
    }

    var kernelModule = null;

    // The kernel, or false (no SIMD, or a Content-Security-Policy).
    function kernel() {
        if (kernelModule === null) {
            kernelModule = false;
            var text = root.EMBED_KERNEL || (typeof EMBED_KERNEL !== "undefined" ? EMBED_KERNEL
                : "");
            try {
                if (typeof WebAssembly === "object" && text) {
                    kernelModule = new WebAssembly.Module(decode(text));
                }
            } catch (error) {
                kernelModule = false;
            }
        }
        return kernelModule;
    }

    /* ---------- The engine ------------------------------------------------------ */

    // Offsets in memory: weights, matrix scales (f32), work buffers.
    function layout(model) {
        var c = model.config;
        var TM = c.max_tokens;
        var wide = Math.max(c.hidden, c.ffn);
        var at = (model.bytes + 15) & ~15;
        var plan = {scales: {}};
        Object.keys(model.tensors).forEach(function (name) {
            var t = model.tensors[name];
            if (t.type === "q8") {
                plan.scales[name] = at;
                at = (at + t.dims[0] * t.dims[1] / QK * 4 + 15) & ~15;
            }
        });
        [["h", c.hidden], ["q", c.hidden], ["k", c.hidden], ["v", c.hidden],
         ["ctx", c.hidden], ["tmp", c.hidden], ["up", c.ffn], ["xs", wide / QK]]
            .forEach(function (entry) {
                plan[entry[0]] = at;
                at += 4 * TM * entry[1];
            });
        plan.xq = at;
        plan.size = (at + TM * wide + 65535) & ~65535;
        return plan;
    }

    function check(model) {
        if (!model || !model.config || !model.tensors || !Array.isArray(model.vocab) ||
                !(model.bytes > 0) || !(model.parts > 0) || model.config.arch !== "bert" ||
                !Array.isArray(model.sums) || model.sums.length !== model.parts) {
            throw new Error("the model file is damaged");
        }
    }

    // A product's input as Q8_0 (llama.cpp's quantize_row_q8_0): bytes, and
    // the half precision scale of each 32 in xs[block * TM + token].
    function quantizeRows(e, x, T, n) {
        var xq = e.xq;
        var xs = e.xs;
        for (var t = 0; t < T; t++) {
            for (var b = 0; b < n / QK; b++) {
                var at = t * n + b * QK;
                var top = 0;
                var i;
                for (i = at; i < at + QK; i++) {
                    top = Math.max(top, x[i] < 0 ? -x[i] : x[i]);
                }
                var inverse = top ? fround(127 / top) : 0;
                xs[b * e.TM + t] = halfToFloat(floatToHalf(fround(top / 127)));
                for (i = at; i < at + QK; i++) {
                    xq[i] = rint(fround(x[i] * inverse));
                }
            }
        }
    }

    // y[t * out + o] = bias[o] + M[o] . x[t]: 2 rows x 4 tokens, as the kernel.
    function matmulJs(e, T4, n, M, bias, y) {
        var out = M.rows;
        var wq = M.q;
        var wd = M.d;
        var xq = e.xq;
        var xs = e.xs;
        var TM = e.TM;
        var blocks = n / QK;
        for (var o = 0; o < out; o += 2) {
            var ra = o * n;
            var rb = ra + n;
            for (var t = 0; t < T4; t += 4) {
                var x0 = t * n, x1 = x0 + n, x2 = x1 + n, x3 = x2 + n;
                var p0 = 0, p1 = 0, p2 = 0, p3 = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0;
                for (var b = 0; b < blocks; b++) {
                    var a0 = 0, a1 = 0, a2 = 0, a3 = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0;
                    for (var i = b * QK, end = i + QK; i < end; i++) {
                        var wa = wq[ra + i], wb = wq[rb + i];
                        var s0 = xq[x0 + i], s1 = xq[x1 + i], s2 = xq[x2 + i], s3 = xq[x3 + i];
                        a0 += wa * s0;
                        a1 += wa * s1;
                        a2 += wa * s2;
                        a3 += wa * s3;
                        c0 += wb * s0;
                        c1 += wb * s1;
                        c2 += wb * s2;
                        c3 += wb * s3;
                    }
                    var sx = b * TM + t;
                    var fa = wd[o * blocks + b], fb = wd[(o + 1) * blocks + b];
                    p0 = fround(p0 + fround(a0 * fround(fa * xs[sx])));
                    p1 = fround(p1 + fround(a1 * fround(fa * xs[sx + 1])));
                    p2 = fround(p2 + fround(a2 * fround(fa * xs[sx + 2])));
                    p3 = fround(p3 + fround(a3 * fround(fa * xs[sx + 3])));
                    r0 = fround(r0 + fround(c0 * fround(fb * xs[sx])));
                    r1 = fround(r1 + fround(c1 * fround(fb * xs[sx + 1])));
                    r2 = fround(r2 + fround(c2 * fround(fb * xs[sx + 2])));
                    r3 = fround(r3 + fround(c3 * fround(fb * xs[sx + 3])));
                }
                var at = t * out + o;
                y[at] = p0 + bias[o];
                y[at + 1] = r0 + bias[o + 1];
                y[at + out] = p1 + bias[o];
                y[at + out + 1] = r1 + bias[o + 1];
                y[at + 2 * out] = p2 + bias[o];
                y[at + 2 * out + 1] = r2 + bias[o + 1];
                y[at + 3 * out] = p3 + bias[o];
                y[at + 3 * out + 1] = r3 + bias[o + 1];
            }
        }
    }

    // y = M x + bias for the T rows quantised last (quantizeRows).
    function product(e, T, n, M, bias, y) {
        var T4 = (T + 3) & ~3;
        if (e.run) {
            e.run(e.plan.xq, e.plan.xs, T4, n, M.q.byteOffset, M.d.byteOffset, bias.byteOffset,
                  M.rows, y.byteOffset, e.TM);
        } else {
            matmulJs(e, T4, n, M, bias, y);
        }
    }

    // y = LayerNorm(y) * weight + bias over each of T rows of n (ggml_norm).
    function layerNorm(y, T, n, weight, bias, eps) {
        for (var t = 0; t < T; t++) {
            var at = t * n;
            var sum = 0;
            var squares = 0;
            var i;
            for (i = at; i < at + n; i++) {
                sum += y[i];
            }
            var mean = fround(sum / n);
            for (i = at; i < at + n; i++) {
                y[i] = fround(y[i] - mean);
                squares += y[i] * y[i];
            }
            var scale = fround(1 / fround(sqrt(fround(fround(squares / n) + eps))));
            for (i = at; i < at + n; i++) {
                y[i] = fround(fround(y[i] * scale) * weight[i - at]) + bias[i - at];
            }
        }
    }

    function attention(e, T) {
        var H = e.c.hidden;
        var HD = H / e.c.heads;
        var q = e.q, k = e.k, v = e.v;
        var scale = 1 / sqrt(HD);
        var scores = new Float64Array(T);
        for (var ho = 0; ho < H; ho += HD) {
            for (var a = 0; a < T; a++) {
                var top = -Infinity;
                var total = 0;
                var j, d;
                for (j = 0; j < T; j++) {
                    var s = 0;
                    for (d = 0; d < HD; d++) {
                        s += q[a * H + ho + d] * k[j * H + ho + d];
                    }
                    scores[j] = s * scale;
                    top = Math.max(top, scores[j]);
                }
                for (j = 0; j < T; j++) {
                    scores[j] = exp(scores[j] - top);
                    total += scores[j];
                }
                for (d = 0; d < HD; d++) {
                    var acc = 0;
                    for (j = 0; j < T; j++) {
                        acc += scores[j] * v[j * H + ho + d];
                    }
                    e.ctx[a * H + ho + d] = acc / total;
                }
            }
        }
    }

    // The model's vector of some token ids, cut to dims (not normalised).
    function forward(e, ids) {
        var c = e.c;
        var W = e.W;
        var H = c.hidden;
        var h = e.h;
        var T = ids.length;
        var t, i;
        var emb = W["token_embd.weight"];
        var pos = W["position_embd.weight"];
        var type0 = W["token_types.weight"];
        for (t = 0; t < T; t++) {
            for (i = 0; i < H; i++) {
                var at = ids[t] * H + i;
                h[t * H + i] = fround(fround(emb.q[at] * emb.d[at / QK | 0]) +
                                      (type0 ? type0[i] : 0)) + pos[t * H + i];
            }
        }
        layerNorm(h, T, H, W["token_embd_norm.weight"], W["token_embd_norm.bias"], c.eps);
        for (var l = 0; l < c.layers; l++) {
            var p = "blk." + l + ".";
            quantizeRows(e, h, T, H);
            product(e, T, H, W[p + "attn_q.weight"], W[p + "attn_q.bias"], e.q);
            product(e, T, H, W[p + "attn_k.weight"], W[p + "attn_k.bias"], e.k);
            product(e, T, H, W[p + "attn_v.weight"], W[p + "attn_v.bias"], e.v);
            attention(e, T);
            quantizeRows(e, e.ctx, T, H);
            product(e, T, H, W[p + "attn_output.weight"], W[p + "attn_output.bias"], e.tmp);
            for (i = 0; i < T * H; i++) {
                h[i] = e.tmp[i] + h[i];
            }
            layerNorm(h, T, H, W[p + "attn_output_norm.weight"], W[p + "attn_output_norm.bias"],
                      c.eps);
            quantizeRows(e, h, T, H);
            product(e, T, H, W[p + "ffn_up.weight"], W[p + "ffn_up.bias"], e.up);
            gelu(e.up, T * c.ffn);
            quantizeRows(e, e.up, T, c.ffn);
            product(e, T, c.ffn, W[p + "ffn_down.weight"], W[p + "ffn_down.bias"], e.tmp);
            for (i = 0; i < T * H; i++) {
                h[i] = e.tmp[i] + h[i];
            }
            layerNorm(h, T, H, W[p + "layer_output_norm.weight"],
                      W[p + "layer_output_norm.bias"], c.eps);
        }
        var pooled = new Float64Array(H);
        for (i = 0; i < H; i++) {
            if (c.pooling === "cls") {
                pooled[i] = h[i];
                continue;
            }
            var sum = 0;
            for (t = 0; t < T; t++) {
                sum += h[t * H + i];
            }
            pooled[i] = fround(sum / T);
        }
        var dense = e.dense;
        if (!dense) {
            return pooled.subarray(0, e.model.dims || H);
        }
        // The Dense head, in double precision as on the server.
        var result = new Float64Array(dense.rows);
        for (var r = 0; r < dense.rows; r++) {
            var acc = 0;
            for (i = 0; i < H; i++) {
                acc += dense.w[r * H + i] * pooled[i];
            }
            result[r] = acc + dense.b[r];
        }
        return result;
    }

    // An engine for a model whose weights are in memory.
    function build(model, memory, instance, plan) {
        var c = model.config;
        var buffer = memory.buffer || memory;
        var TM = c.max_tokens;
        var e = {model: model, c: c, plan: plan, TM: TM, W: {}, dense: null,
                 run: instance ? instance.exports.matmul : null};
        Object.keys(model.tensors).forEach(function (name) {
            var t = model.tensors[name];
            var count = t.dims.reduce(function (a, b) {
                return a * b;
            }, 1);
            if (t.type !== "q8") {
                e.W[name] = new Float32Array(buffer, t.off, count);
                return;
            }
            var halves = new Uint16Array(buffer.slice(t.soff, t.soff + 2 * count / QK));
            var scales = new Float32Array(buffer, plan.scales[name], count / QK);
            for (var b = 0; b < scales.length; b++) {
                scales[b] = halfToFloat(halves[b]);
            }
            e.W[name] = {q: new Int8Array(buffer, t.off, count), d: scales, cols: t.dims[0],
                         rows: t.dims[1]};
        });
        if (model.dense) {
            e.dense = {rows: model.dense.rows,
                       w: new Float32Array(buffer, model.dense.offset,
                                           model.dense.rows * model.dense.cols),
                       b: new Float32Array(buffer, model.dense.bias, model.dense.rows)};
        }
        ["h", "q", "k", "v", "ctx", "tmp"].forEach(function (name) {
            e[name] = new Float32Array(buffer, plan[name], TM * c.hidden);
        });
        e.up = new Float32Array(buffer, plan.up, TM * c.ffn);
        e.xs = new Float32Array(buffer, plan.xs, TM * Math.max(c.hidden, c.ffn) / QK);
        e.xq = new Int8Array(buffer, plan.xq, TM * Math.max(c.hidden, c.ffn));
        var tokenize = tokenizer(model);

        function unit(values) {
            var length = norm(values) || 1;
            return Float32Array.from(values, function (value) {
                return value / length;
            });
        }

        var engine = {
            model: model,
            backend: e.run ? "wasm-simd" : "js",
            tokenize: tokenize,
            query: function (text) {
                return quantize(forward(e, tokenize((model.query_prefix || "") + text)));
            },
            document: function (text) {
                return unit(forward(e, tokenize(text)));
            },
            check: function () {
                var lowest = (model.probe || []).length ? 1 : -1;
                (model.probe || []).forEach(function (item) {
                    var stored = new Int8Array(decode(String(item.vec)));
                    var made = engine.document(item.text);
                    var dot = 0;
                    for (var i = 0; i < stored.length; i++) {
                        dot += stored[i] * made[i];
                    }
                    lowest = Math.min(lowest, stored.length === made.length && norm(stored)
                        ? dot / norm(stored) : -1);
                });
                return lowest;
            }
        };
        return engine;
    }

    // The kernel's memory (grown), or a plain buffer.
    function memoryFor(model, options) {
        var plan = layout(model);
        var module = options && options.wasm === false ? false : kernel();
        if (module) {
            try {
                var instance = new WebAssembly.Instance(module, {});
                var memory = instance.exports.mem;
                memory.grow(plan.size / 65536 - memory.buffer.byteLength / 65536);
                return {plan: plan, instance: instance, memory: memory};
            } catch (error) {
                // (Not enough memory for WebAssembly: plain JavaScript.)
            }
        }
        return {plan: plan, instance: null, memory: new ArrayBuffer(plan.size)};
    }

    function create(model, bytes, options) {
        if (missing) {
            throw new Error(missing);
        }
        check(model);
        var place = memoryFor(model, options);
        new Uint8Array(place.memory.buffer || place.memory).set(bytes.subarray(0, model.bytes));
        return build(model, place.memory, place.instance, place.plan);
    }

    // One model loads at a time (the model files call the one SEARCH_EMBED).
    var loading = Promise.resolve();

    function load(meaning, options) {
        var run = loading.then(function () {
            return loadNow(meaning, options || {});
        });
        // (Not the engine itself: a page that drops it frees its memory.)
        loading = run.then(function () {
            return null;
        }, function () {
            return null;
        });
        return run;
    }

    function loadNow(meaning, options) {
        var url = options.url || String;
        var add = options.load;     // (site.js: a <script> tag a promise)
        var delay = typeof options.retryDelay === "number" ? options.retryDelay : 2000;
        var progress = options.progress || function () {};
        if (missing || !meaning || typeof meaning.model !== "string" ||
                !Array.isArray(meaning.parts)) {
            return Promise.reject(new Error(missing || "the export has no model"));
        }
        var model = null;
        var place = null;
        var target = null;
        var got = {};

        function retried(name) {
            return add(url(name)).catch(function () {
                return new Promise(function (resolve) {
                    setTimeout(resolve, delay);
                }).then(function () {
                    return add(url(name));
                });
            });
        }

        SEARCH_EMBED.receiver = {
            model: function (value) {
                model = value;
            },
            part: function (number, text) {
                if (!target || got[number] !== undefined || typeof text !== "string") {
                    return;
                }
                var start = number * model.part_bytes;
                var size = Math.min(model.part_bytes, model.bytes - start);
                try {
                    got[number] = size > 0 && text.length <= size * 4 / 3 + 4 &&
                        decodeInto(text, target, start) === size &&
                        crc32(target.subarray(start, start + size)) === model.sums[number];
                } catch (error) {
                    got[number] = false;    // (not base64)
                }
            }
        };
        return retried(meaning.model).then(function () {
            check(model);
            if (model.id !== meaning.id || model.parts !== meaning.parts.length) {
                throw new Error("the model file is not this export's");
            }
            place = memoryFor(model, options);
            target = new Uint8Array(place.memory.buffer || place.memory, 0, model.bytes);
            progress(0, model.bytes);
            // (One at a time: each text can go before the next comes.)
            return meaning.parts.reduce(function (chain, name, number) {
                return chain.then(function () {
                    return retried(name);
                }).then(function () {
                    if (got[number] !== true) {
                        throw new Error("a part of the model is damaged");
                    }
                    progress(Math.min(model.bytes, (number + 1) * model.part_bytes), model.bytes);
                });
            }, Promise.resolve());
        }).then(function () {
            SEARCH_EMBED.receiver = null;
            return build(model, place.memory, place.instance, place.plan);
        }, function (error) {
            SEARCH_EMBED.receiver = null;
            throw error;
        });
    }

    return {
        load: load,
        create: create,
        tokenizer: tokenizer,
        words: words,
        quantize: quantize,
        floatToHalf: floatToHalf,
        halfToFloat: halfToFloat,
        kernel: kernel,
        crc32: crc32,
        unsupported: function () {
            return missing;
        }
    };
})();

if (typeof module === "object" && module && module.exports) {
    module.exports = {EMBED: EMBED, SEARCH_EMBED: SEARCH_EMBED};
}
