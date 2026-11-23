# Third-party notices

## Fonts distributed with the web application

The browser loads the Latin variable fonts from this checkout. The font files identify their authors and versions in their embedded metadata. The corresponding license files reproduce the SIL Open Font License 1.1 and their upstream copyright notices.

| Font file | Embedded copyright | Accompanying notice and license |
| --- | --- | --- |
| [Inter Latin](web/fonts/Inter-latin.woff2), version 4.001 | Copyright 2016 The Inter Project Authors | Copyright 2020 The Inter Project Authors. [Project](https://github.com/rsms/inter) · [Bundled license](web/fonts/Inter-OFL.txt) |
| [Montserrat Latin](web/fonts/Montserrat-latin.woff2), version 9.000 | Copyright 2011 The Montserrat Project Authors | Copyright 2024 The Montserrat.Git Project Authors. [Project](https://github.com/JulietaUla/Montserrat) · [Bundled license](web/fonts/Montserrat-OFL.txt) |

The bundled WOFF2 files match the Google Fonts Latin distributions byte for byte. [Inter v20 WOFF2](https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2) · [Montserrat v31 WOFF2](https://fonts.gstatic.com/s/montserrat/v31/JTUSjIg1_i6t8kCHKm459WlhyyTh89Y.woff2)

Keep the copyright notices and OFL text with redistributions of these fonts. The license describes the conditions for modifying and distributing them. [Official OFL text](https://openfontlicense.org/open-font-license-official-text/)

## Rust dependencies

[Cargo.toml](Cargo.toml) declares the direct dependencies. [Cargo.lock](Cargo.lock) pins the resolved crates. Cargo fetches their sources at build time. After fetching them, use `cargo metadata --locked --offline --format-version 1` to inspect each crate’s version, license declaration and manifest location.

For example, the TWS API client `ibapi` and the Rust SQLite bindings `rusqlite` are MIT-licensed. The build includes the bundled SQLite engine. Some dependencies carry multiple notices, including `matchit` (MIT and BSD-3-Clause) and `unicode-ident` (MIT or Apache-2.0, together with Unicode-3.0). When distributing a compiled application, collect applicable notices and license texts from the resolved dependencies and their embedded data. [ibapi](https://github.com/wboayue/rust-ibapi) · [rusqlite](https://github.com/rusqlite/rusqlite) · [SQLite copyright](https://sqlite.org/copyright.html) · [matchit](https://github.com/ibraheemdev/matchit) · [unicode-ident](https://github.com/dtolnay/unicode-ident)

## Product and data sources

Options Lab is an independent client for Interactive Brokers Trader Workstation and IB Gateway. Users obtain these broker applications separately. IBKR publishes license terms for its official TWS API software. Each user’s subscriptions and agreements govern access to and redistribution of market data. [IBKR TWS API software terms](https://www.interactivebrokers.com/support/faq/content/tws-api-free-download-29091390) · [IBKR TWS protocol](https://www.interactivebrokers.com/docs/tws-api/doc/introduction) · [Market data sources](DATA-SOURCES.md)
