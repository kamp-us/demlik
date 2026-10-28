The parser/calendar code is a Rust adaptation of Node v22.21.1's bundled V8,
commit `6ac4ab19ad02803f03b54501193397563e99988e`:

- `deps/v8/src/date/dateparser.h`, `dateparser-inl.h`, `dateparser.cc`: UTF16
  tokenization, ISO-prefix/legacy continuation, composers and numeric fractions.
- `deps/v8/src/date/date.h`, `date.cc`: MakeDay, TimeClip, maxBeforeUTC (30 days),
  Gregorian decomposition and ISO formatting.
- `deps/v8/src/builtins/builtins-date.cc`: parse, local-to-UTC, explicit offset,
  then TimeClip operation order.
- `deps/v8/src/objects/intl-objects.cc`: lazy `TimeZone::createDefault`,
  `BasicTimeZone::getOffsetFromLocal(FORMER, FORMER)`. EquivalentTime belongs to
  the non-ICU DST fallback and is not applied to this ICU path.

The pinned Node build has 32-bit Smis, no pointer compression, V8
12.4.254.21-node.33, ICU77.1 and timezone data2025b. The existing private ICU77.1
release data has the independently read `zoneinfo64/TZVersion`2025a. The owner
returns its actual runtime timezone-data version. The finite UTC/Los Angeles
observations do not establish general timezone-database equivalence.

The timezone bridge owns only factory/ID/offset/version/destruction operations.
ICU errors remain typed data. V8 returns offset0 on native ICU failure; this
checked native failure path is an explicit host qualification, not a claimed
equivalent reflection/error profile. Named ICU unknown IDs retain ICU's
Etc/Unknown zero-offset fallback. The default factory retains ICU's host-default
selection and cache behavior; it does not replace global timezone state.

`V8-DATE-LICENSE` retains the pinned V8 license with one trailing ASCII space
removed from line33; the original bytes and both hashes remain in the proof.
ICU77 distribution licenses remain under `crates/code-graph/licenses/` and the
existing preparation contract.
