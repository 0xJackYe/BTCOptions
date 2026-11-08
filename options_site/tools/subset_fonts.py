"""Regenerate the Strategy Desk's self-hosted font subsets.

Development tool only (the site has no runtime dependency on it):

    pip install fonttools brotli
    npm pack @fontsource/noto-serif-sc@5.3.1 @fontsource-variable/inter@5.3.0 @fontsource-variable/jetbrains-mono@5.3.0
    node options_site/tools/serif_characters.mjs        # records what the UI sets in serif
    python options_site/tools/subset_fonts.py --packages <folder with the extracted packages> \
        --serif-characters options_site/strategy/fonts/serif-characters.txt

The serif display face (Noto Serif SC, OFL 1.1) is cut down to exactly the
characters the interface renders in serif (titles, names, figures, seals);
everything else uses the system's CJK sans. tests/fonts.test.mjs fails if a
strategy name, rule label or other display string gains a character the
subset does not cover, prompting a rerun.
"""
import argparse
import re
from pathlib import Path

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "options_site" / "strategy" / "fonts"
UI_SOURCES = [
    ROOT / "options_site" / "strategy.html",
    *sorted((ROOT / "options_site" / "strategy").glob("*.js")),
    ROOT / "options_site" / "lib" / "strategies.mjs",
    ROOT / "options_site" / "lib" / "screener.mjs",
    ROOT / "options_site" / "lib" / "market.mjs",
]
CJK = re.compile(r"[　-〿㐀-䶿一-鿿＀-￯‐-⁯]")
BASIC = "".join(chr(c) for c in range(0x20, 0x7F)) + "−–—·…×÷±≤≥→←↑↓%‰°«»“”‘’"
LATIN = BASIC + "αβγδΔΓΘθσμπ€¥£"


def ui_characters():
    text = "".join(path.read_text(encoding="utf-8") for path in UI_SOURCES)
    return sorted(set(CJK.findall(text)) | set(BASIC))


def subset_chunks(chunks, characters, target):
    """Subset every unicode-range chunk, then merge the non-empty parts."""
    parts = []
    work = target.parent / ".subset-work"
    work.mkdir(exist_ok=True)
    wanted = set(map(ord, characters))
    for index, chunk in enumerate(sorted(chunks)):
        font = TTFont(chunk)
        covered = wanted & set(font.getBestCmap())
        if not covered:
            continue
        options = subset.Options()
        # Only spacing features: vertical/width alternates would pull in
        # hundreds of glyphs the interface never draws.
        options.layout_features = ["kern", "palt"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        options.drop_tables += ["DSIG"]
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=covered)
        subsetter.subset(font)
        part = work / f"part-{index}.ttf"
        font.flavor = None
        font.save(part)
        parts.append(str(part))
    merged = Merger().merge(parts)
    # A final pass over the merged font drops glyphs no chunk still references.
    options = subset.Options()
    options.layout_features = ["kern", "palt"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    final = subset.Subsetter(options)
    final.populate(unicodes=wanted)
    final.subset(merged)
    merged.flavor = "woff2"
    merged.save(target)
    for part in parts:
        Path(part).unlink()
    work.rmdir()


def subset_latin(source, target, text):
    font = TTFont(source)
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt", "tnum", "zero", "ss01", "cv11"]
    options.flavor = "woff2"
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--packages", type=Path, required=True, help="folder holding the extracted npm packages")
    parser.add_argument("--serif-characters", type=Path, help="characters set in serif (from serif_characters.mjs)")
    args = parser.parse_args()
    if args.serif_characters:
        characters = sorted(set(args.serif_characters.read_text(encoding="utf-8").strip()) | set(BASIC))
    else:
        characters = ui_characters()
    noto = args.packages / "x-noto" / "package" / "files"
    subset_chunks(noto.glob("noto-serif-sc-*-600-normal.woff2"), characters, OUT / "noto-serif-sc-600-ui.woff2")
    inter = args.packages / "x-fontsource-variable-inter-5.3.0" / "package" / "files" / "inter-latin-wght-normal.woff2"
    mono = args.packages / "x-fontsource-variable-jetbrains-mono-5.3.0" / "package" / "files" / "jetbrains-mono-latin-wght-normal.woff2"
    subset_latin(inter, OUT / "inter-latin-wght.woff2", LATIN)
    subset_latin(mono, OUT / "jetbrains-mono-latin-wght.woff2", LATIN)
    if not args.serif_characters:
        (OUT / "ui-characters.txt").write_text("".join(c for c in characters if CJK.match(c)), encoding="utf-8")
    for path in sorted(OUT.glob("*.woff2")):
        print(f"{path.name}: {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
