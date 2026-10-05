// Kana → romaji (Hepburn, no macrons: とうきょう → toukyou). A reading aid
// for beginners; the voice is the real pronunciation.

const BASE: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n",
  ゔ: "vu",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o", ゎ: "wa",
};

/** Two-kana sounds: きゃ, しょ, ちゅ, and the katakana extensions (ファ, ティ…). */
const PAIRS: Record<string, string> = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyo", ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho", じゃ: "ja", じゅ: "ju", じょ: "jo",
  ちゃ: "cha", ちゅ: "chu", ちょ: "cho", ぢゃ: "ja", ぢゅ: "ju", ぢょ: "jo",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo", ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  びゃ: "bya", びゅ: "byu", びょ: "byo", ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo", りゃ: "rya", りゅ: "ryu", りょ: "ryo",
  しぇ: "she", じぇ: "je", ちぇ: "che", てぃ: "ti", でぃ: "di", とぅ: "tu", どぅ: "du",
  ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo", うぃ: "wi", うぇ: "we", うぉ: "wo",
  ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo", つぁ: "tsa", いぇ: "ye",
};

const PUNCT: Record<string, string> = {
  "。": ". ", "、": ", ", "！": "! ", "？": "? ", "「": "\"", "」": "\"", "・": " ", "　": " ",
  "（": "(", "）": ")", "〜": "~", "…": "...",
};

/** Katakana → hiragana (ー is kept: it lengthens the previous vowel). */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const VOWELS = "aeiou";

/**
 * Converts kana to romaji. `particles` marks the indexes (in `kana`) of は, へ
 * and を used as particles, read wa / e / o and set apart by spaces;
 * `spaces` marks where other words start.
 */
export function kanaToRomaji(
  kana: string,
  particles: ReadonlySet<number> = new Set(),
  /** Indexes before which a word starts: a space goes there. */
  spaces: ReadonlySet<number> = new Set(),
): string {
  const s = toHiragana(kana);
  let out = "";
  let geminate = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (spaces.has(i) && !geminate) out += " ";
    if (particles.has(i) && (c === "は" || c === "へ" || c === "を")) {
      out = out.replace(/\s*$/, "") + ` ${c === "は" ? "wa" : c === "へ" ? "e" : "o"} `;
      continue;
    }
    if (c === "っ") {
      geminate = true;
      continue;
    }
    if (c === "ー") {
      const last = [...out].reverse().find((x) => VOWELS.includes(x));
      if (last) out += last;
      continue;
    }
    let roma = PAIRS[c + (s[i + 1] ?? "")];
    if (roma) i++;
    else roma = BASE[c];
    if (roma === undefined) {
      out += PUNCT[c] ?? c;
      geminate = false;
      continue;
    }
    if (geminate) {
      out += roma.startsWith("ch") ? "t" : roma[0];
      geminate = false;
    }
    // ん before a vowel or y is written n' (kin'en, not kinen).
    if (c === "ん") {
      const next = PAIRS[(s[i + 1] ?? "") + (s[i + 2] ?? "")] ?? BASE[s[i + 1] ?? ""] ?? "";
      out += next && (VOWELS.includes(next[0]) || next[0] === "y") ? "n'" : "n";
      continue;
    }
    out += roma;
  }
  return out.replace(/\s+/g, " ").replace(/ ([,.!?])/g, "$1").trim();
}
