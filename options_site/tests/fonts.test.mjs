import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import {test} from "node:test";
import {serifVocabulary} from "../tools/serif_vocabulary.mjs";

const fonts = new URL("../strategy/fonts/", import.meta.url);

test("the serif display subset covers every strategy name, rule label, seal and toast title", async () => {
  const covered = new Set((await readFile(new URL("serif-characters.txt", fonts), "utf8")).trim());
  const missing = [...await serifVocabulary()].filter(ch => !covered.has(ch));
  assert.deepEqual(missing, [], "rerun tools/serif_characters.mjs and tools/subset_fonts.py for: " + missing.join(""));
});

test("self-hosted fonts stay small and are preloaded", async () => {
  const limits = {"noto-serif-sc-600-ui.woff2": 80, "inter-latin-wght.woff2": 40, "jetbrains-mono-latin-wght.woff2": 40};
  const css = await readFile(new URL("../strategy/desk.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../strategy.html", import.meta.url), "utf8");
  for (const [name, kb] of Object.entries(limits)) {
    const {size} = await stat(new URL(name, fonts));
    assert.ok(size < kb * 1024, `${name} is ${(size / 1024).toFixed(1)} KB (limit ${kb} KB)`);
    assert.ok(css.includes(`url("./fonts/${name}")`), name + " declared in desk.css");
    assert.match(html, new RegExp(`rel="preload" href="\\./strategy/fonts/${name.replace(/\./g, "\\.")}" as="font" type="font/woff2" crossorigin`), name + " preloaded");
  }
  assert.match(await readFile(new URL("LICENSE.txt", fonts), "utf8"), /SIL OPEN FONT LICENSE/i, "OFL licence ships with the fonts");
});
