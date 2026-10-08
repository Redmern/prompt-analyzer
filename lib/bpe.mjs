// A pure-JS port of the BPE that @anthropic-ai/tokenizer runs through tiktoken's
// WASM build. The /pm pane uses it to split what you type on every keystroke:
// hooks modules can't load WASM or node:fs, so the caller reads claude.json and
// passes it in. No imports, so both node and a hooks module can load this file.

const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));

// Bytes are kept as "binary strings", one char per byte, which slice and key a
// Map cheaply.
function fromBase64(text) {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const c of text) {
    if (c === "=") break;
    value = ((value << 6) | B64.get(c)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

const toBytes = (text) => unescape(encodeURIComponent(text.replace(/\p{Surrogate}/gu, "�")));

// Undefined while the bytes stop partway through a character.
function fromBytes(bytes) {
  try {
    return decodeURIComponent(escape(bytes));
  } catch {
    return undefined;
  }
}

// tiktoken's merge loop: join the adjacent pair with the lowest rank until no
// pair is in the vocabulary.
function merge(piece, ranks) {
  const starts = [...piece].map((_, i) => i);
  starts.push(piece.length);
  for (;;) {
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < starts.length - 2; i++) {
      const rank = ranks.get(piece.slice(starts[i], starts[i + 2]));
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        best = i;
      }
    }
    if (best === -1) break;
    starts.splice(best + 1, 1);
  }
  const tokens = [];
  for (let i = 0; i < starts.length - 1; i++) tokens.push(piece.slice(starts[i], starts[i + 1]));
  return tokens;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `claude` is the parsed claude.json: { bpe_ranks, special_tokens, pat_str }.
export function createTokenizer(claude) {
  const ranks = new Map();
  for (const line of claude.bpe_ranks.split("\n")) {
    if (!line) continue;
    const [, offset, ...tokens] = line.split(" ");
    tokens.forEach((token, i) => ranks.set(fromBase64(token), Number(offset) + i));
  }
  const specials = Object.keys(claude.special_tokens ?? {});
  const special = specials.length ? new RegExp(specials.map(escapeRegExp).join("|"), "g") : null;

  // Every token of the text, as bytes, the way encode(text, "all") cuts it.
  function encode(text) {
    const out = [];
    const ordinary = (part) => {
      for (const [match] of part.matchAll(new RegExp(claude.pat_str, "gu"))) {
        const bytes = toBytes(match);
        if (ranks.has(bytes)) out.push(bytes);
        else out.push(...merge(bytes, ranks));
      }
    };
    let from = 0;
    for (const m of special ? text.matchAll(special) : []) {
      ordinary(text.slice(from, m.index));
      out.push(toBytes(m[0]));
      from = m.index + m[0].length;
    }
    ordinary(text.slice(from));
    return out;
  }

  // Returns [{ text, tokens }], as lib/tokens.mjs splitTokens does: one entry
  // per token, except that a character split over several byte tokens (emoji,
  // accents) is one entry with tokens > 1.
  function split(text = "") {
    const pieces = [];
    let pending = "";
    let count = 0;
    for (const bytes of encode(text.normalize("NFKC"))) {
      pending += bytes;
      count++;
      const decoded = fromBytes(pending);
      if (decoded === undefined) continue;
      pieces.push({ text: decoded, tokens: count });
      pending = "";
      count = 0;
    }
    if (count) pieces.push({ text: "�", tokens: count });
    return pieces;
  }

  return { split, count: (text = "") => (text ? encode(text.normalize("NFKC")).length : 0) };
}
