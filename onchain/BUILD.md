# Verifiable build

The auditors asked, correctly, whether the source in this repository is the program running on
mainnet. That question can only be answered by compiling this source and comparing the result
against the deployed bytes — and with `lto = "fat"`, `codegen-units = 1` and `strip = true` in the
release profile, the output depends on the exact compiler. So the compiler is part of the source:
`[toolchain]` in `Anchor.toml` pins it, and changing either version changes the digest below, which
is the point — it should be a deliberate act recorded in a commit.

```
anchor 1.0.2 · solana 3.1.10
anchor build --ignore-keys      # two declare_id!s sit behind a `devnet` feature
shasum -a 256 target/deploy/*.so
```

## Current source digests

These are the digests of **this working tree**, which includes the fixes for the TechSlayers review
of 2026-10-12 and is therefore **not** what is deployed.

| program | sha256 | mainnet |
|---|---|---|
| `rexpad.so` | `ad246854acdeb7a03380874636c40bdb75c4420839f2f96c9e3add29f5a19df1` | `2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E` — **deployed** |
| `rexhook.so` | `062bbf372e038e56425a8b12defebdbe3c254dc3a174594cc263b0739775c7cd` | `9YnrpwYYhzKAqz25PncsafkGptc2CZUJsFZRcN5G1hrB` — **not deployed** |

⛔ A digest is only evidence once it is compared. To check what is actually live:

```
solana program dump 2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E /tmp/live-rexpad.so
shasum -a 256 /tmp/live-rexpad.so
```

A dumped program is padded to its allocated length, so compare the first `len(rexpad.so)` bytes
rather than the whole file, or the digests will differ for a reason that means nothing.
