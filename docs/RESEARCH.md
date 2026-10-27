# Landscape research

Reviewed 2026-10-27 using publicly accessible page text. This is a feature inventory, not an exhaustive hands-on audit; dynamic behavior, accessibility, mobile input, data handling, licensing and exact settings are unverified unless explicitly stated. Absence below means not established, not necessarily unsupported. Never copy proprietary code or design assets.

| Site | Observable features | Distinction and limits |
|---|---|---|
| [translit.ru](https://translit.ru/) | Live Latin-to-Cyrillic input; Latin/Cyrillic switching via Esc/F12; conversion both ways; Russian virtual keyboard and layouts; multiple languages, mapping presets, custom rules, character counter, undo, copy and print, external search/dictionaries. `+` separates ambiguous sequences. | Broadest feature set. Its help describes saved personal configuration using a number, and also mentions accounts; current save flow needs hands-on verification. Site says its default Russian scheme favors convenience over formal standard compliance. |
| [rusklaviatura.com](https://rusklaviatura.com/) | Live conversion, output alphabet toggle, helper keyboard, selection conversion in either direction, select all, search; separate Russian keyboard; mapping chart includes alternatives. | Keyboard- and selection-oriented, with Russian learning material; configurable rules and persistence not established. |
| [transliter.ru](https://transliter.ru/) | Live phonetic entry and visible mapping; separate autotranslit, keyboard-switcher and virtual Russian keyboard sections. | Russian-focused; actual behavior and exact boundaries of separate tools need testing. |
| [ruslit.app](https://ruslit.app/) | Separate Latin and Russian panels, instant conversion, swap direction, copy, clear, counts, reference chart; responsive UI; capitalization support. | Site claims conversion is local and text is not saved or transmitted, while stating it uses advertising/analytics cookies. These privacy claims have not been independently audited. |

TypeBridge should combine a focused single editor with an optional source/output workflow, configurable mappings and clear privacy controls. Do not imply a formal standard without an audited mapping and conformance tests. Further research: hands-on selection, editing, paste, mobile IME, undo, storage and network inspection in current browsers.
