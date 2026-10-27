# Russian informal input specification

Reviewed 2026-10-27 against [translit.ru's Russian page and FAQ](https://translit.ru/). The page documents mappings and a `+` boundary; its default rules favor typing convenience and are customizable. This comparison uses published page text; exact live editing, capitalization and custom configurations were not independently tested. TypeBridge is inspired by, not a complete clone of, translit.ru.

The canonical TypeBridge table is `src/core/russian.ts`. Notable decisions:

| Input | TypeBridge | translit.ru published default | Decision |
|---|---|---|---|
| e / je | е / э | е / э | Same; `j+e` is йе. |
| sh / shh / shch / sch / w | ш / щ / щ / щ / щ | sh → ш; shh and w → щ | Keep common `shch` and `sch` as additional aliases; not claimed as translit.ru defaults. |
| q / x | я / х | я / х | Follow published defaults; `h` and `kh` also mean х. |
| yo / jo | ё | ё | Same. |
| ' / # | ь / ъ | ь / ъ | Same basic signs; use Latin mode for literal punctuation. |
| ts / kh | ц / х | c / h,x | Additional TypeBridge aliases. |

Unlike the previous draft, `w` now means щ, matching translit.ru; use `v` for в. `sch` is interpreted as щ by longest matching even though `s+ch` means сч. `s+h` → сх and `j+o` → йо; `sh` → ш and `jo` → ё. The separator is consumed only between mapped input sequences; elsewhere preserve it. A literal plus between mapped sequences requires an escape mechanism or Latin mode. Other unmatched characters, existing Cyrillic and punctuation are preserved; all lowercase ASCII letters have a mapping, while unsupported Unicode characters pass through unchanged. Multi-character input is matched longest first.

Case policy for a future engine: the first input letter determines case (`sh` → ш, `Sh`/`SH` → Ш, `sH` → ш). Uppercase ь/ъ and punctuation escaping remain implementation decisions and should be tested. Reverse conversion is unspecified and cannot guarantee round trips. This document describes a contract, not an implemented engine.
