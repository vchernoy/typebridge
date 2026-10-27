# Russian informal input specification

The `ru-informal` pack is a proposed convenience scheme, not an official romanization standard. The canonical table is `src/core/russian.ts`. It supports alternatives such as `yo`/`jo` → ё, `ya`/`ja` → я, `yu`/`ju` → ю, and `shch`/`shh` → щ. Apostrophe maps to ь and `#` to ъ; literal entry of these signs requires Latin mode.

For the future engine, choose the longest matching lowercase input: `shch` → щ, `sh` → ш, `ch` → ч. A plus between Latin sequences breaks matching and is consumed: `s+h` → сх; outside such a boundary preserve literal `+`. Preserve unmatched characters, existing Cyrillic and punctuation. Case follows the first input letter: `sh`, `Sh`, `SH`, `sH` → ш, Ш, Ш, ш respectively. `privet` → привет. The exact handling of a literal plus between Latin letters needs a future escape mechanism.

Reverse conversion is not specified by this forward-only pack. Aliases and phonetic ambiguity make reversal potentially lossy; do not promise round trips. This PR defines data and validation only, not an engine or editor behavior.
