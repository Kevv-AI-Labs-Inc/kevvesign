# ADR 0001: Azure as the system of record

- Status: Accepted for implementation; production activation awaits Azure and business release gates.
- Date: 2026-08-10

## Decision

Use Azure Container Apps, Azure Functions/Durable Functions, Azure SQL Ledger, private Blob Storage with immutable retention, Service Bus, Key Vault, Communication Services Email, Entra ID, and Application Insights. Do not split the version-one runtime across Cloudflare and Azure.

## Rationale

The core risk is evidence durability rather than edge latency. Azure provides managed WORM retention/legal holds, ledger verification, managed signing keys, identities, and containerized PDF processing under one operational control plane. Cloudflare may remain the DNS provider without holding application records.

## Consequences

- Higher baseline infrastructure cost than an all-Workers design.
- Fewer custom legal-hold, key-custody, PDF, and tamper-evidence mechanisms.
- Environments must use separate identities, stores, keys, domains, and resource boundaries.
- Production Azure geography, disaster-recovery target, and exact service tiers remain release decisions.
