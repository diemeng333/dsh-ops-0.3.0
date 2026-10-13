# Schema measurement

Manual measurement only; not a tokenizer, CI, or proof of whole-task savings.
Metric: compact UTF-8 JSON `{name,description,parameters}` bytes, tokens ≈ ceil(bytes/4).
Runtime is FastCtx 0.2.6; only plugin publication/presentation changes.

## 0.2.4 component surface

| Enabled components | Tools | Schema bytes | Approximate tokens |
| --- | ---: | ---: | ---: |
| File only | 4 | 6,724 | 1,681 |
| Shell + file (default, full access) | 5 | 7,685 | 1,922 |
| Shell + file + background (full access) | 9 | 9,949 | 2,488 |
| 0.2.3 full surface (historical) | 10 | 10,700 | 2,675 |

Default reduces plugin schema bytes by 28.2% versus 0.2.3. Background contributes
2,264 bytes only when enabled; duplicate ops_run (751 bytes) is no longer published.
The host tool declarations remain additive and are not included in this table.
Restricted sessions have no ops_bash or background command tools.

Prompt sections are component-owned and independently removed: file 498 bytes,
shell 492 bytes, background 269 bytes. These sum when multiple components are on;
`toolingPrompt` in the snapshot is the legacy combined CLI renderer, not the actual
sum of separately registered sections. Minimal's complete persona can exclude them.
No raw server instructions or old host-shell policy segment is published.

## Historical comparison

The unchanged baseline is dee3c57 before description compression: nine FastCtx
schemas 18,889 bytes; four file schemas 12,807. File descriptions remain 6,724 bytes
(47.5% reduction). ops_grep: 3,766 → 2,019; inspect: 4,375 → 1,968. These are plugin
old/new comparisons, NOT official-host versus plugin comparisons.

Reproduce with `node scripts/measure-schemas.mjs docs/schema-current.json`.
It initializes and lists schemas without tool execution. Preserve baseline JSON.
Actual request count, cache pricing, tool output and repeated history can outweigh
fixed schema savings; no percentage here predicts task-total provider tokens.
